// `pr land --cwd <tree>` measures typecheck and mock-module restore against that tree, not process.cwd().
import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTscScript, runGate } from '../../scripts/ci-typecheck-changed.js';
import { runMockModuleRestoreGate } from '../../scripts/ci-mock-module-restore-gate.js';
import { runPrLand, runPrLandTypecheckGate, runPrLandTypecheckWithReceipt, shouldRefusePrLandLocalHeavySteps } from './pr-cli.js';

setDefaultTimeout(60_000);

test('pr land refuses local test-suite and PWA gates on HQ unless the heavy gate already ran remotely', () => {
  const seat = '/Users/user/elanous-hq/seats/OP';
  expect(shouldRefusePrLandLocalHeavySteps({}, 'MacBookProM5', seat, false)).toBe(true);
  expect(shouldRefusePrLandLocalHeavySteps({}, 'MacStudioB1', seat, false)).toBe(true);
  expect(shouldRefusePrLandLocalHeavySteps({}, 'MacBookProM5', seat, true)).toBe(false);
  expect(shouldRefusePrLandLocalHeavySteps({ CI: '1' }, 'MacBookProM5', seat, false)).toBe(true);
  expect(shouldRefusePrLandLocalHeavySteps({}, 'node-b', '/tmp/worktree', false)).toBe(false);
});

test('pr land routes its in-process typecheck from an HQ symlink to the canonical checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'prland-typecheck-alias-'));
  const hqCheckout = join(root, 'elanous-hq', 'seats', 'OP', 'repo');
  const alias = join(root, 'checkout-alias');
  mkdirSync(hqCheckout, { recursive: true });
  symlinkSync(hqCheckout, alias, 'dir');
  const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const lines: string[] = [];
  try {
    const passed = runPrLandTypecheckGate({ log: (line) => lines.push(line), error: (line) => lines.push(line) }, alias, {
      env: { ELANOUS_TYPECHECK_REMOTE: 'gcp2' },
      host: 'MacStudioB1',
      baseRef: 'a'.repeat(40),
      runRemote: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd, env: options.env });
        return { status: 0, stdout: '[tsc-gate] PASS\n', stderr: '' };
      },
    });
    expect(passed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: process.execPath,
      args: [join(realpathSync(hqCheckout), 'scripts/ci-typecheck-changed.ts'), '--remote', 'gcp2'],
      cwd: realpathSync(hqCheckout),
      env: { ELANOUS_TYPECHECK_REMOTE: 'gcp2', TSC_BASE_REF: 'a'.repeat(40) },
    });
    expect(lines).toEqual(['[tsc-gate] PASS']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pr land reuses only the same PR, head, base and changed-tsc input receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'prland-typecheck-receipt-'));
  const receiptDir = join(root, 'receipts');
  const input = { pr: 36874, head: 'a'.repeat(40), base: 'b'.repeat(40), cwd: root,
    changedPaths: ['src/cli/pr-cli.ts'], host: 'minim5', receiptDir, env: { TSC_GATE_ROOTS: 'affected' } };
  let runs = 0;
  const pass = () => { runs++; return true; };
  try {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'dependency.d.ts'), 'export type Value = string;\n');
    expect(runPrLandTypecheckWithReceipt(input, pass)).toEqual({ ok: true, source: 'gate' });
    expect(runPrLandTypecheckWithReceipt(input, pass)).toEqual({ ok: true, source: 'receipt' });
    expect(runs).toBe(1); // Source: PRLAND-REUSE-EXACT-HEAD-CHECKS same exact input needs one measurement.
    expect(runPrLandTypecheckWithReceipt({ ...input, base: 'c'.repeat(40) }, pass).source).toBe('gate');
    expect(runPrLandTypecheckWithReceipt({ ...input, head: 'd'.repeat(40) }, pass).source).toBe('gate');
    expect(runPrLandTypecheckWithReceipt({ ...input, pr: 36875 }, pass).source).toBe('gate');
    expect(runPrLandTypecheckWithReceipt({ ...input, changedPaths: ['src/other.ts'] }, pass).source).toBe('gate');
    expect(runPrLandTypecheckWithReceipt({ ...input, env: { TSC_GATE_ROOTS: 'full' } }, pass).source).toBe('gate');
    expect(runs).toBe(6); // Source: PRLAND-REUSE-EXACT-HEAD-CHECKS five changed identities remeasure after the first pass.
    expect(runPrLandTypecheckWithReceipt(input, pass).source).toBe('gate');
    expect(runPrLandTypecheckWithReceipt(input, pass).source).toBe('receipt');
    writeFileSync(join(root, 'node_modules', 'dependency.d.ts'), 'export type Value = number;\n');
    expect(runPrLandTypecheckWithReceipt(input, pass).source).toBe('gate');
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    expect(runPrLandTypecheckWithReceipt(input, pass).source).toBe('gate');
    expect(runs).toBe(9); // Source: PRLAND-REUSE-EXACT-HEAD-CHECKS changed or missing installed types force a fresh gate.
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pr land never reuses a failed or unreadable typecheck receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'prland-typecheck-failure-'));
  const receiptDir = join(root, 'receipts');
  const input = { pr: 36874, head: 'a'.repeat(40), base: 'b'.repeat(40), cwd: root,
    changedPaths: ['src/cli/pr-cli.ts'], host: 'minim5', receiptDir };
  let runs = 0;
  try {
    mkdirSync(join(root, 'node_modules'));
    expect(runPrLandTypecheckWithReceipt(input, () => { runs++; return false; })).toEqual({ ok: false, source: 'gate' });
    expect(runPrLandTypecheckWithReceipt(input, () => { runs++; return true; })).toEqual({ ok: true, source: 'gate' });
    writeFileSync(join(receiptDir, `${input.pr}.json`), '{broken');
    expect(runPrLandTypecheckWithReceipt(input, () => { runs++; return true; })).toEqual({ ok: true, source: 'gate' });
    expect(runs).toBe(3); // Source: PRLAND-REUSE-EXACT-HEAD-CHECKS failed and unreadable evidence never proves a pass.
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pr land refuses receipt reuse when installed types link outside the checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'prland-external-types-'));
  const external = mkdtempSync(join(tmpdir(), 'prland-external-package-'));
  const input = { pr: 36874, head: 'a'.repeat(40), base: 'b'.repeat(40), cwd: root,
    changedPaths: ['src/cli/pr-cli.ts'], host: 'minim5', receiptDir: join(root, 'receipts') };
  let runs = 0;
  const gate = () => { runs++; return true; };
  try {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(external, 'index.d.ts'), 'export type Value = string;\n');
    symlinkSync(external, join(root, 'node_modules', 'external'), 'dir');
    expect(runPrLandTypecheckWithReceipt(input, gate).source).toBe('gate');
    writeFileSync(join(external, 'index.d.ts'), 'export type Value = number;\n');
    expect(runPrLandTypecheckWithReceipt(input, gate).source).toBe('gate');
    rmSync(external, { recursive: true, force: true });
    expect(runPrLandTypecheckWithReceipt(input, gate).source).toBe('gate');
    expect(runs).toBe(3); // Source: PRLAND-REUSE-EXACT-HEAD-CHECKS outside and missing symlink targets never prove installed types unchanged.
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

/** A repo whose only change since the root commit is a markdown file — zero .ts. */
function docsOnlyTree(parent = tmpdir()): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(parent, 'prland-cwd-'));
  // Injected compiler results still require target declarations unless the
  // production runner measures a completely dependency-free checkout.
  mkdirSync(join(dir, 'node_modules', 'bun-types'), { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'prland-cwd@example.com']);
  git(dir, ['config', 'user.name', 'prland-cwd']);
  writeFileSync(join(dir, 'README.md'), '# root\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'root']);
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  // The gate's default base is merge-base(origin/main). A bare temp repo has no remote, so publish main locally.
  git(dir, ['update-ref', 'refs/remotes/origin/main', base]);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'note.md'), '# note\n');
  writeFileSync(join(dir, 'docs', 'other.md'), '# other\n');
  git(dir, ['add', 'docs']);
  git(dir, ['commit', '-q', '-m', 'docs only']);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  return { dir, base, head };
}

function capture(run: (log: (message: string) => void, error: (message: string) => void, exit: (code: number) => never) => void): { lines: string[]; code: number } {
  const lines: string[] = [];
  let code = 0;
  const exit = ((next: number): never => {
    code = next;
    throw new Error(`exit ${next}`);
  });
  try {
    run((message) => lines.push(message), (message) => lines.push(message), exit);
  } catch (error) {
    if (code === 0) throw error;
  }
  return { lines, code };
}

test('runPrLand refuses HQ local heavy gates before invoking the test suite or PWA gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prland-hq-heavy-'));
  const seat = join(root, 'elanous-hq', 'seats', 'OP');
  mkdirSync(seat, { recursive: true });
  const { dir } = docsOnlyTree(seat);
  const alias = join(root, 'checkout-alias');
  symlinkSync(dir, alias, 'dir');
  const lines: string[] = [];
  let typecheckCalls = 0;
  let testSuiteCalls = 0;
  let pwaCalls = 0;
  try {
    const code = await runPrLand({ cwd: alias }, {
      hostName: () => 'MacStudioB1',
      currentBranch: () => 'feature',
      resolveBase: () => 'origin/main',
      run: (command, args) => {
        if (command === 'git' && args[0] === 'remote') return { ok: true, out: args[1] === 'get-url' ? 'https://github.com/example/repo.git' : 'origin' };
        return { ok: true, out: '' };
      },
      listUnfinishedRuns: () => [],
      queryRunningRuns: () => { throw new Error('observation unavailable'); },
      runTypecheckGate: () => { typecheckCalls++; return true; },
      runTestInterferenceGate: async () => { testSuiteCalls++; return 0; },
      runPwaGate: () => { pwaCalls++; return true; },
      out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    });
    expect(code).toBe(1);
    expect(typecheckCalls).toBe(1);
    expect(lines.join('\\n')).toContain('HQ-HEAVY-LOCAL-GUARD');
    expect(testSuiteCalls).toBe(0);
    expect(pwaCalls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('tsc gate reads both docs-only and TypeScript changes from --cwd', () => {
  const { dir, base, head } = docsOnlyTree();
  expect(base).not.toBe(head);
  const { lines, code } = capture((log, error, exit) => {
    runGate({ cwd: dir, log, warn: error, error, exit });
  });
  const summary = lines.find((line) => line.startsWith('[tsc-gate] base='));
  expect(summary).toBeDefined();
  expect(summary).toContain(`base=${base}`);
  expect(summary).toContain(`head=${head}`);
  expect(summary).toContain('변경 .ts 0개');
  expect(lines.some((line) => line.startsWith('[tsc-gate] PASS'))).toBe(true);
  expect(code).toBe(0);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/model.ts'), 'export const targetOnly = 1;\n');
  git(dir, ['add', 'src/model.ts']);
  git(dir, ['commit', '-q', '-m', 'target TypeScript']);
  let tscRuns = 0;
  const changed = capture((log, error, exit) => runGate({
    cwd: dir, log, warn: error, error, exit,
    runTscCmd: () => { tscRuns++; return { ran: true, out: '' }; },
  }));
  expect(changed.code).toBe(0);
  expect(tscRuns).toBeGreaterThan(0);
  expect(changed.lines.join('\n')).toContain('변경 .ts 1개 관측');
  expect(changed.lines.some((line) => line.startsWith('[tsc-gate] PASS'))).toBe(true);
});

test('a dependency-free --cwd tree runs the installed compiler and judges only its changed diagnostic', () => {
  const { dir } = docsOnlyTree();
  try {
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    writeFileSync(join(dir, 'tsconfig.gate.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true }, include: ['src/**/*.ts'] }));
    writeFileSync(join(dir, 'tsconfig.pwa-env.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true }, include: ['src/**/*.ts'] }));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/model.test.ts'), 'const target: number = "wrong";\n');
    git(dir, ['add', 'src/model.test.ts']);
    git(dir, ['commit', '-q', '-m', 'target test TypeScript']);
    const broken = capture((log, error, exit) => runGate({ cwd: dir, log, warn: error, error, exit, allowMissingCheckoutDependencies: true }));
    expect(broken.code).toBe(1);
    expect(broken.lines.join('\n')).toContain('src/model.test.ts(1,7): error TS2322');
    expect(broken.lines.join('\n')).toContain('변경 .ts 1개 관측');
    expect(broken.lines.join('\n')).not.toContain('대상 트리 타입 의존성 없음');
    writeFileSync(join(dir, 'src/model.test.ts'), 'const target: number = 1;\n');
    const fixed = capture((log, error, exit) => runGate({ cwd: dir, log, warn: error, error, exit, allowMissingCheckoutDependencies: true }));
    expect(fixed.code, fixed.lines.join('\n')).toBe(0);
    expect(fixed.lines.at(-1)).toBe('[tsc-gate] PASS — 변경 파일에 신규 타입 에러 없음.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('standalone CI gate refuses a dependency-free checkout even when installed tsc exists', () => {
  const { dir } = docsOnlyTree();
  try {
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/model.test.ts'), 'export const targetOnly = 1;\n');
    git(dir, ['add', 'src/model.test.ts']);
    git(dir, ['commit', '-q', '-m', 'target TypeScript']);
    const { lines, code } = capture((log, error, exit) => runGate({ cwd: dir, log, warn: error, error, exit }));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('대상 트리 타입 의존성 없음: node_modules, bun-types');
    expect(lines.join('\n')).not.toContain('[tsc-gate] PASS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a dependency-free worktree keeps the real target tsconfig and fails on missing bun-types using installed top-level tsc', () => {
  const { dir } = docsOnlyTree();
  const installed = mkdtempSync(join(tmpdir(), 'prland-installed-cli-'));
  try {
    copyFileSync(join(import.meta.dir, '../../tsconfig.json'), join(dir, 'tsconfig.json'));
    copyFileSync(join(import.meta.dir, '../../tsconfig.gate.json'), join(dir, 'tsconfig.gate.json'));
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/model.test.ts'), 'export const targetOnly = 1;\n');
    git(dir, ['add', 'src/model.test.ts']);
    git(dir, ['commit', '-q', '-m', 'target TypeScript']);
    const scriptsDir = join(installed, 'node_modules/elanous/scripts');
    const topLevelTsc = join(installed, 'node_modules/typescript/bin/tsc');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(join(installed, 'node_modules/typescript/bin'), { recursive: true });
    symlinkSync(join(import.meta.dir, '../../node_modules/typescript/bin/tsc'), topLevelTsc);
    expect(resolveTscScript(dir, scriptsDir)).toBe(topLevelTsc);
    const { lines, code } = capture((log, error, exit) => runGate({
      cwd: dir, log, warn: error, error, exit,
      resolveTscScript: (cwd) => resolveTscScript(cwd, scriptsDir), allowMissingCheckoutDependencies: true,
    }));
    expect(code).toBe(1);
    const configDiagnostic = lines.find((line) => line.includes('error TS2688:'));
    expect(configDiagnostic).toContain("bun-types");
    console.log(`[pr-land-cwd-gates] installed top-level tsc: ${configDiagnostic?.split('\n')[0]}; gate exit=${code}`);
    expect(lines.join('\n')).not.toContain('[tsc-gate] PASS');
    expect(lines.at(-1)).toContain('FAIL');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(installed, { recursive: true, force: true }); }
});

test('pr land --cwd runs installed tsc for a PWA change in a dependency-free target worktree', async () => {
  const { dir } = docsOnlyTree();
  const target = mkdtempSync(join(tmpdir(), 'prland-pwa-worktree-'));
  const lines: string[] = [];
  let mutations = 0;
  try {
    git(dir, ['worktree', 'add', '--detach', target, 'HEAD']);
    rmSync(join(target, 'node_modules'), { recursive: true, force: true });
    expect(resolveTscScript(target)).toBe(join(import.meta.dir, '../../node_modules/typescript/bin/tsc'));
    copyFileSync(join(import.meta.dir, '../../tsconfig.json'), join(target, 'tsconfig.json'));
    copyFileSync(join(import.meta.dir, '../../tsconfig.gate.json'), join(target, 'tsconfig.gate.json'));
    mkdirSync(join(target, 'apps/pwa/src'), { recursive: true });
    copyFileSync(join(import.meta.dir, '../../apps/pwa/tsconfig.json'), join(target, 'apps/pwa/tsconfig.json'));
    writeFileSync(join(target, 'apps/pwa/src/Target.tsx'), 'export const targetOnly: number = "wrong";\n');
    git(target, ['add', 'apps/pwa/src/Target.tsx']);
    git(target, ['commit', '-q', '-m', 'broken target PWA']);
    mkdirSync(join(dir, 'apps/pwa/src'), { recursive: true });
    writeFileSync(join(dir, 'apps/pwa/src/Launcher.tsx'), 'export const launcherOnly: number = "wrong";\n');
    const code = await runPrLand({ cwd: target }, {
      currentBranch: () => 'feature', resolveBase: () => 'origin/main',
      run: (command, args) => {
        if (command === 'git' && args[0] === 'remote') return { ok: true, out: args[1] === 'get-url' ? 'https://github.com/example/repo.git' : 'origin' };
        return { ok: true, out: '' };
      },
      listUnfinishedRuns: () => [], queryRunningRuns: () => { throw new Error('observation unavailable'); },
      out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
      manager: { upsertPr: () => { mutations++; throw new Error('must not create PR'); } } as never,
    });
    const text = lines.join('\n');
    expect(code).toBe(1);
    expect(text).toContain('변경 .ts 1개 관측');
    expect(text).toContain('PWA 변경 1개 관측 — apps/pwa/tsconfig.json 검사.');
    expect(text).toContain('apps/pwa/src/Target.tsx(1,14): error TS2322');
    expect(text).not.toContain('대상 트리 타입 의존성 없음');
    expect(text).not.toContain('Launcher.tsx');
    expect(text).not.toContain('[tsc-gate] PASS');
    expect(text).toContain('✗ typecheck: scripts/ci-typecheck-changed.ts blocked pr land.');
    expect(mutations).toBe(0);
    console.log(`[pr-land-cwd-gates] PWA installed tsc: ${lines.filter((line) => line.includes('error TS')).map((line) => line.split('\n')[0]).join(' | ')}; gate exit=${code}`);
  } finally {
    git(dir, ['worktree', 'remove', '--force', target]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI pr land --cwd reports only the target diagnostic before any PR mutation', () => {
  const { dir } = docsOnlyTree();
  const target = mkdtempSync(join(tmpdir(), 'prland-cli-target-'));
  const state = mkdtempSync(join(tmpdir(), 'prland-cli-state-'));
  try {
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const gitShimDir = join(state, 'bin');
    mkdirSync(gitShimDir, { recursive: true });
    const baseTip = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const gitShim = join(gitShimDir, 'git');
    writeFileSync(gitShim, `#!/bin/sh\nif [ "$1" = ls-remote ]; then printf '%s\\trefs/heads/main\\n' '${baseTip}'; exit 0; fi\nexec '${realGit}' "$@"\n`);
    chmodSync(gitShim, 0o755);
    git(dir, ['remote', 'add', 'origin', 'https://github.com/example/prland-cwd-gates.git']);
    git(dir, ['worktree', 'add', '-b', 'feature', target, 'HEAD']);
    rmSync(join(target, 'node_modules'), { recursive: true, force: true });
    writeFileSync(join(target, 'tsconfig.gate.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true }, include: ['src/**/*.ts'] }));
    writeFileSync(join(target, 'tsconfig.pwa-env.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true }, include: ['src/**/*.ts'] }));
    mkdirSync(join(target, 'src'), { recursive: true });
    writeFileSync(join(target, 'src/model.test.ts'), 'const targetOnly: number = "wrong";\n');
    git(target, ['add', 'tsconfig.gate.json', 'tsconfig.pwa-env.json', 'src/model.test.ts']);
    git(target, ['commit', '-q', '-m', 'broken target TypeScript']);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/launcher.test.ts'), 'const launcherOnly: number = "wrong";\n');
    const beforeHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).stdout.trim();
    const beforeStatus = spawnSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' }).stdout;
    const result = spawnSync(process.execPath, [join(import.meta.dir, '../../bin/elanous.mjs'), 'pr', 'land', '--cwd', target], {
      cwd: dir, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, PATH: `${gitShimDir}:${process.env.PATH ?? ''}`, ELANOUS_STATE_DIR: state },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(1);
    expect(output).toContain('src/model.test.ts(1,7): error TS2322');
    expect(output).not.toContain('launcher.test.ts');
    expect(output).toContain('✗ typecheck: scripts/ci-typecheck-changed.ts blocked pr land.');
    expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).stdout.trim()).toBe(beforeHead);
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' }).stdout).toBe(beforeStatus);
    console.log(`[pr-land-cwd-gates] CLI --cwd exit=${result.status}; target HEAD/status unchanged\n${output}`);
  } finally {
    git(dir, ['worktree', 'remove', '--force', target]);
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('literal reference scan stays inside --cwd and reports the target tree consumer', () => {
  const { dir } = docsOnlyTree();
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/producer.ts'), "export type Outcome = 'observed' | 'plan-staged';\n");
  writeFileSync(join(dir, 'src/consumer.ts'), "const outcome = 'plan-staged';\n");
  git(dir, ['add', 'src']);
  git(dir, ['commit', '-q', '-m', 'baseline TypeScript']);
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  writeFileSync(join(dir, 'src/producer.ts'), "export type Outcome = 'observed';\n");
  git(dir, ['add', 'src/producer.ts']);
  git(dir, ['commit', '-q', '-m', 'remove literal']);
  const { lines, code } = capture((log, error, exit) => runGate({
    cwd: dir, log, warn: error, error, exit,
    runTscCmd: () => ({ ran: true, out: '' }),
  }));
  expect(code).toBe(0);
  expect(lines.join('\n')).toContain("src/consumer.ts:1: Outcome -= 'plan-staged'");
});

test('tsc gate fails explicitly when no target or installed compiler exists', () => {
  const { dir } = docsOnlyTree();
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/model.ts'), 'export const targetOnly = 1;\n');
  git(dir, ['add', 'src/model.ts']);
  git(dir, ['commit', '-q', '-m', 'target TypeScript']);
  let tscRuns = 0;
  const { lines, code } = capture((log, error, exit) => runGate({
    cwd: dir, log, warn: error, error, exit,
    resolveTscScript: (cwd) => resolveTscScript(cwd, join(dir, 'fake-cli/scripts')),
    runTscCmd: () => { tscRuns++; return { ran: true, out: '' }; },
  }));
  expect(code).toBe(1);
  expect(tscRuns).toBe(0);
  expect(lines.join('\n')).toContain('bun install --frozen-lockfile');
  expect(lines.at(-1)).toContain('FAIL');
});

test('a missing compiler candidate or vanished compiler reports the install instruction', () => {
  const { dir } = docsOnlyTree();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/model.test.ts'), 'export const targetOnly = 1;\n');
    git(dir, ['add', 'src/model.test.ts']);
    git(dir, ['commit', '-q', '-m', 'target TypeScript']);
    const missingCompiler = join(dir, 'node_modules/typescript/bin/tsc');
    const { lines, code } = capture((log, error, exit) => runGate({
      cwd: dir, log, warn: error, error, exit,
      resolveTscScript: () => missingCompiler,
    }));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Module not found');
    expect(lines.join('\n')).toContain('bun install --frozen-lockfile');
    expect(lines.join('\n')).not.toContain('[tsc-gate] PASS');
    expect(lines.at(-1)).toContain('못 쟀다');
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    const absent = capture((log, error, exit) => runGate({
      cwd: dir, log, warn: error, error, exit,
      allowMissingCheckoutDependencies: true,
      resolveTscScript: (cwd) => resolveTscScript(cwd, join(dir, 'absent-cli/scripts')),
    }));
    expect(absent.code).toBe(1);
    expect(absent.lines.join('\n')).toContain('TypeScript 실행 파일 없음');
    expect(absent.lines.join('\n')).toContain('bun install --frozen-lockfile');
    expect(absent.lines.at(-1)).toContain('FAIL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dropping cwd makes the same docs-only tree fail as base==HEAD (could not count)', () => {
  // History the 10-06 cut had: HEAD is an ancestor of origin/main, so the pinned base
  // (merge-base of that main) resolves to HEAD itself and the docs diff cannot be counted.
  const dir = mkdtempSync(join(tmpdir(), 'prland-cwd-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'prland-cwd@example.com']);
  git(dir, ['config', 'user.name', 'prland-cwd']);
  writeFileSync(join(dir, 'README.md'), '# root\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'root']);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'note.md'), '# note\n');
  git(dir, ['add', 'docs']);
  git(dir, ['commit', '-q', '-m', 'docs']);
  const docs = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const ahead = spawnSync('git', ['commit-tree', `${docs}^{tree}`, '-p', docs, '-m', 'cut moved on'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  git(dir, ['update-ref', 'refs/remotes/origin/main', ahead]);
  git(dir, ['checkout', '-q', '--detach', docs]);
  const saved = process.cwd();
  process.chdir(dir);
  let lines: string[] = [];
  let code = 0;
  try {
    ({ lines, code } = capture((log, error, exit) => {
      runGate({ baseRef: docs, log, warn: error, error, exit });
    }));
  } finally {
    process.chdir(saved);
  }
  const text = lines.join('\n');
  expect(code).toBe(1);
  expect(text).toContain(`base 가 HEAD(${docs})`);
  expect(text).toContain('못 셌음');
});

test('mock-module restore gate scans the landing tree, not the tree the process was launched from', () => {
  const clean = docsOnlyTree().dir;
  mkdirSync(join(clean, 'scripts'), { recursive: true });
  writeFileSync(join(clean, 'scripts', 'mock-module-restore-baseline.txt'), '# one grandfathered row keeps an empty scan measurable\n1\tsrc/kept.test.ts\n');
  expect(runMockModuleRestoreGate({ args: [], cwd: clean, log: () => {}, error: () => {} })).toBe(0);

  const dirty = docsOnlyTree().dir;
  mkdirSync(join(dirty, 'scripts'), { recursive: true });
  writeFileSync(join(dirty, 'scripts', 'mock-module-restore-baseline.txt'), '# measured\n');
  mkdirSync(join(dirty, 'src'), { recursive: true });
  writeFileSync(join(dirty, 'src', 'new.test.ts'), "import { mock } from 'bun:test';\nmock.module('node:fs', () => ({ readFileSync: () => '' }));\n");
  expect(runMockModuleRestoreGate({ args: [], cwd: dirty, log: () => {}, error: () => {} })).toBe(1);
});
