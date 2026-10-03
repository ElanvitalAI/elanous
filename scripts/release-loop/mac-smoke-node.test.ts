import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runMacSmoke as runMacSmokeNode, testFailures } from './mac-smoke-node.js';
import type { CommandResult, CommandRunner, GraphContext } from './node-verdict.js';

const cut = 'a'.repeat(40);
const base = 'b'.repeat(40);
const context = (host?: string): GraphContext => ({ input: { version: '0.2.10', previousVersion: '0.2.9', commit: cut, ...(host === undefined ? {} : { macSmokeHost: host }) }, outputs: { gate: { outcome: 'ok' } } });
const success = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });
const files = ['test/one.test.ts', 'test/two.test.ts', 'test/three.test.ts'];

// The node proves collection from bun's junit report, read back with `cat`. Fakes below keep speaking
// «header lines + summary» stdout; this adapter strips the reporter flags / `./` prefixes before the fake sees
// `bun test`, and serves the junit file the fake's headers imply (a `(fail)` line marks that file failing).
function withJunit(inner: CommandRunner): CommandRunner {
  const reports = new Map<string, string>();
  const xmlFrom = (stdout: string) => {
    const seen: string[] = [];
    const failing = new Set<string>();
    let current: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const header = /^((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):$/.exec(line.trim());
      if (header) { current = header[1]!; seen.push(current); continue; }
      if (current && line.startsWith('(fail)')) failing.add(current);
    }
    return seen.map((file) => `<testsuite name="${file}" file="${file}"><testcase name="case"${failing.has(file) ? '><failure/></testcase>' : '/>'}</testsuite>`).join('');
  };
  return (cmd, args, cwd, timeoutMs) => {
    if (cmd === 'bun' && args[0] === 'test') {
      const out = args.find((arg) => arg.startsWith('--reporter-outfile='))?.slice('--reporter-outfile='.length);
      const paths = args.slice(1).filter((arg) => !arg.startsWith('--reporter')).map((arg) => arg.replace(/^\.\//, ''));
      const result = inner(cmd, ['test', ...paths], cwd, timeoutMs);
      if (out) reports.set(out, xmlFrom(result.stdout));
      return result;
    }
    if (cmd === 'ssh' && args[1]?.includes("'bun' 'test'")) {
      const out = /'--reporter-outfile=([^']+)'/.exec(args[1])?.[1];
      const result = inner(cmd, args, cwd, timeoutMs);
      if (out) reports.set(out, xmlFrom(result.stdout));
      return result;
    }
    const catTarget = cmd === 'cat' ? args[0] : cmd === 'ssh' ? /'cat' '([^']+)'/.exec(args[1] ?? '')?.[1] : undefined;
    if (catTarget !== undefined) {
      const xml = reports.get(catTarget);
      return xml === undefined ? { status: 1, stdout: '', stderr: 'no such file' } : success(xml);
    }
    return inner(cmd, args, cwd, timeoutMs);
  };
}
const runMacSmoke: typeof runMacSmokeNode = (run, deps) => runMacSmokeNode(run ? withJunit(run) : run, deps);

function fake(failCut: boolean, failBase: boolean) {
  const calls: Array<[string, string[], string | undefined]> = [];
  const run: CommandRunner = (cmd, args, cwd, timeoutMs) => {
    calls.push([cmd, args, cwd]);
    if (cmd === 'bun' && args[0] === 'test') expect(timeoutMs).toBe(1_200_000);
    if (cmd === 'uname' || (cmd === 'ssh' && args[1] === 'uname -s')) return success('Darwin\n');
    if (cmd === 'git' && args[0] === 'ls-tree') return success(`${files.join('\0')}\0`);
    if (cmd === 'bun' && args[0] === 'test') {
      const failing = cwd?.endsWith('/base') ? failBase : failCut;
      const paths = args.slice(1);
      return { status: failing ? 1 : 0, stdout: `${paths.map((path) => `${path}:\n${failing && path === 'test/one.test.ts' ? '(fail) case\n' : ''}`).join('')}3 pass\n${failing ? '1 fail' : '0 fail'}\nRan ${paths.length + 1} tests across ${paths.length} files\n`, stderr: '' };
    }
    return success();
  };
  return { calls, run };
}

function options(repo: string, extra: Record<string, unknown> = {}) {
  return { repo, baseline: () => base, changedFiles: () => files, findImporters: () => [], ...extra };
}

function inTemp(check: (repo: string) => void) {
  const repo = mkdtempSync(join(tmpdir(), 'mac-smoke-case-'));
  try { check(repo); } finally { rmSync(repo, { recursive: true, force: true }); }
}

test('no configured macOS host skips without executing a command', () => {
  const { calls, run } = fake(false, false);
  expect(runMacSmoke(run, { context: context(), configHost: () => undefined })).toMatchObject({ outcome: 'ok', verdict: 'pass', summary: 'macOS 대상 없음 — 건너뜀' });
  expect(calls).toHaveLength(0);
});

test('changed three tests pass on local temporary cut with read-only smokes', () => inTemp((repo) => {
  const { calls, run } = fake(false, false);
  const result = runMacSmoke(run, { context: context('local'), ...options(repo) });
  expect(result).toMatchObject({ outcome: 'ok', files: 3, newFailures: 0, smoke: 'pass' });
  expect(calls.some(([cmd, args]) => cmd === 'bun' && args[0] === 'test' && args.slice(1).length === 3)).toBe(true);
  expect(calls.filter(([cmd, args]) => cmd === 'bun' && args[0] === 'bin/elanous.mjs').map(([, args]) => args.slice(1))).toEqual([['--test', '--version'], ['--test', 'release', 'schedule', 'list', '--json']]);
  expect(calls.some(([cmd, args]) => cmd === 'git' && args.slice(0, 2).join(' ') === 'worktree remove')).toBe(true);
}));

test('a macOS cut with one selected test not collected cannot be ok in result JSON', () => inTemp((repo) => {
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  mkdirSync(join(repo, 'test'));
  for (const file of files) writeFileSync(join(repo, file), 'test("ok", () => {});\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const first = git('rev-parse', 'HEAD');
  for (const file of files) writeFileSync(join(repo, file), 'test("changed", () => {});\n');
  git('add', '.'); git('commit', '-qm', 'cut');
  const second = git('rev-parse', 'HEAD');
  const { run } = fake(false, false);
  let cutTests = 0;
  const runner: CommandRunner = (cmd, args, cwd, timeoutMs) => {
    if (cmd === 'git' && ['diff', 'ls-tree', 'grep', 'show'].includes(args[0]!)) {
      const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }
    if (cmd === 'bun' && args[0] === 'test') {
      cutTests++;
      const paths = args.slice(1);
      expect(paths).toEqual([...files].sort());
      return success(`${paths.slice(0, 2).map((file) => `${file}:\n`).join('')}3 pass\n0 fail\nRan 3 tests across 3 files\n`);
    }
    return run(cmd, args, cwd, timeoutMs);
  };
  const result = runMacSmoke(runner, { repo, context: { input: { version: '0.2.10', previousVersion: '0.2.9', commit: second, macSmokeHost: 'local' }, outputs: {} }, baseline: () => first });
  expect(cutTests).toBe(1);
  expect(JSON.parse(JSON.stringify(result))).toMatchObject({ outcome: 'error', verdict: 'fail', files: 3 });
  expect(result.summary).toContain('측정 불가');
}));

test('a failed cleanup cannot report a measured pass', () => inTemp((repo) => {
  const { run } = fake(false, false);
  const result = runMacSmoke((cmd, args, cwd, timeoutMs) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove'
    ? { status: 1, stdout: '', stderr: 'cleanup failed' } : run(cmd, args, cwd, timeoutMs), { context: context('local'), ...options(repo) });
  expect(result).toMatchObject({ outcome: 'error', verdict: 'fail' });
}));

test('same named failure on cut and previous release is preexisting', () => inTemp((repo) => {
  const { run } = fake(true, true);
  expect(runMacSmoke(run, { context: context('local'), ...options(repo) })).toMatchObject({ outcome: 'ok', preexisting: 1, newFailures: 0 });
}));

test('failure only in cut blocks publication and names the test file', () => inTemp((repo) => {
  const { run } = fake(true, false);
  const result = runMacSmoke(run, { context: context('local'), ...options(repo) });
  expect(result).toMatchObject({ outcome: 'fail', newFailures: 1 });
  expect(result.summary).toContain('test/one.test.ts');
}));

test('no test summary or timed out runner is unmeasured, not a pass', () => inTemp((repo) => {
  const { run } = fake(false, false);
  for (const status of [0, null]) {
    const result = runMacSmoke((cmd, args, cwd, timeoutMs) => cmd === 'bun' && args[0] === 'test'
      ? { status, stdout: '', stderr: 'timed out' } : run(cmd, args, cwd, timeoutMs), { context: context('local'), ...options(repo) });
    expect(result).toMatchObject({ outcome: 'error', verdict: 'fail' });
  }
}));

test('remote macOS uses temporary worktrees and forwards the 1200-second test limit through ssh', () => inTemp((repo) => {
  const { run, calls } = fake(false, false);
  const remotePath = '/tmp/release-mac-smoke-fixture';
  const result = runMacSmoke((cmd, args, cwd, timeoutMs) => {
    if (cmd === 'ssh' && args[1] === 'mktemp -d /tmp/release-mac-smoke-XXXXXXXX') return success(`${remotePath}\n`);
    if (cmd === 'ssh' && args[1]?.includes("'bun' 'test'")) {
      expect(timeoutMs).toBe(1_200_000);
      return success(`${files.map((path) => `${path}:\n`).join('')}3 pass\n0 fail\nRan 3 tests across 3 files\n`);
    }
    return run(cmd, args, cwd, timeoutMs);
  }, { context: context('macmini'), ...options(repo) });
  expect(result).toMatchObject({ outcome: 'ok', files: 3 });
  expect(calls.some(([cmd, args]) => cmd === 'ssh' && args[1]?.includes("'worktree' 'add'"))).toBe(true);
  expect(calls.some(([cmd, args]) => cmd === 'ssh' && args[1]?.includes(`rm -rf -- '${remotePath}'`))).toBe(true);
}));

test('remote connection failure is error and not a pass', () => inTemp((repo) => {
  const { run } = fake(false, false);
  const result = runMacSmoke((cmd, args, cwd, timeoutMs) => cmd === 'ssh' ? { status: 255, stdout: '', stderr: 'connection refused' } : run(cmd, args, cwd, timeoutMs), { context: context('macmini'), ...options(repo) });
  expect(result).toMatchObject({ outcome: 'error', verdict: 'fail' });
  expect(result.summary).toContain('측정 불가');
}));

test('local non-macOS host cannot report success or run any tests', () => inTemp((repo) => {
  const { run, calls } = fake(false, false);
  const result = runMacSmoke((cmd, args, cwd, timeoutMs) => cmd === 'uname' ? success('Linux\n') : run(cmd, args, cwd, timeoutMs), { context: context('local'), ...options(repo) });
  expect(result).toMatchObject({ outcome: 'error', verdict: 'fail' });
  expect(result.summary).toContain('측정 불가');
  expect(calls.some(([cmd, args]) => cmd === 'bun' && args[0] === 'test')).toBe(false);
}));

test('remote non-macOS host cannot report success or run any tests', () => inTemp((repo) => {
  const { run, calls } = fake(false, false);
  const result = runMacSmoke((cmd, args, cwd, timeoutMs) => cmd === 'ssh' && args[1] === 'uname -s' ? success('Linux\n') : run(cmd, args, cwd, timeoutMs), { context: context('macmini'), ...options(repo) });
  expect(result).toMatchObject({ outcome: 'error', verdict: 'fail' });
  expect(result.summary).toContain('측정 불가');
  expect(calls.some(([cmd, args]) => cmd === 'bun' && args[0] === 'test')).toBe(false);
}));

test('release graph version-release commit is used when input.commit is absent', () => inTemp((repo) => {
  const ctx = context('local');
  delete ctx.input.commit;
  ctx.outputs['version-release'] = { commit: cut };
  const { run } = fake(false, false);
  expect(runMacSmoke(run, { context: ctx, ...options(repo) })).toMatchObject({ outcome: 'ok', files: 3 });
}));

test('missing commit and installation failure cannot be mistaken for a pass', () => inTemp((repo) => {
  const missing = context('local');
  delete missing.input.commit;
  expect(runMacSmoke(() => { throw new Error('must not run'); }, { context: missing, ...options(repo) }).outcome).toBe('error');
  const { run } = fake(false, false);
  expect(runMacSmoke((cmd, args, cwd, timeoutMs) => cmd === 'bun' && args[0] === 'install' ? { status: 1, stdout: '', stderr: '' } : run(cmd, args, cwd, timeoutMs), { context: context('local'), ...options(repo) }).outcome).toBe('error');
}));

test('read-only smoke rc nonzero fails even when tests pass', () => inTemp((repo) => {
  const { run } = fake(false, false);
  expect(runMacSmoke((cmd, args, cwd, timeoutMs) => cmd === 'bun' && args[0] === 'bin/elanous.mjs' && args[2] === '--version' ? { status: 1, stdout: '', stderr: '' } : run(cmd, args, cwd, timeoutMs), { context: context('local'), ...options(repo) })).toMatchObject({ outcome: 'fail', smoke: 'fail' });
}));

test('more than 200 changed tests are bounded and truncation is reported', () => inTemp((repo) => {
  const paths = Array.from({ length: 201 }, (_, i) => `test/case${i}.test.ts`);
  const { run } = fake(false, false);
  const result = runMacSmoke((cmd, args, cwd, timeoutMs) => {
    if (cmd === 'git' && args[0] === 'ls-tree') return success(`${paths.join('\0')}\0`);
    if (cmd === 'bun' && args[0] === 'test') {
      const batch = args.slice(1);
      return success(`${batch.map((path) => `${path}:\n`).join('')}${batch.length} pass\n0 fail\nRan ${batch.length} tests across ${batch.length} files\n`);
    }
    return run(cmd, args, cwd, timeoutMs);
  }, { context: context('local'), ...options(repo, { changedFiles: () => paths }) });
  expect(result).toMatchObject({ outcome: 'ok', files: 200 });
  expect(result.summary).toContain('잘림 1');
}));

test('changed source relative importers are selected with a temporary git repository', () => inTemp((repo) => {
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'thing.ts'), 'export const thing = 1;\n');
  writeFileSync(join(repo, 'src', 'thing.test.ts'), "import { thing } from './thing';\n");
  writeFileSync(join(repo, 'src', 'path.test.ts'), "const target = 'src/thing.ts';\n");
  git('add', '.'); git('commit', '-qm', 'base');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src', 'thing.ts'), 'export const thing = 2;\n');
  git('add', '.'); git('commit', '-qm', 'cut');
  const second = git('rev-parse', 'HEAD');
  // The checked-out cut still imports thing, while the working tree does not.
  writeFileSync(join(repo, 'src', 'thing.test.ts'), 'test("unrelated", () => {});\n');
  const captured: string[][] = [];
  const runner: CommandRunner = (cmd, args, cwd) => {
    if (cmd === 'uname') return success('Darwin\n');
    if (cmd === 'bun' && args[0] === 'test') {
      const paths = args.slice(1);
      captured.push(paths);
      return success(`${paths.map((path) => `${path}:\n`).join('')}${paths.length} pass\n0 fail\nRan ${paths.length} tests across ${paths.length} files\n`);
    }
    if (cmd === 'git' && ['diff', 'ls-tree', 'grep', 'show'].includes(args[0]!)) {
      const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }
    return success();
  };
  expect(runMacSmoke(runner, { repo, context: { input: { version: '0.2.10', previousVersion: '0.2.9', commit: second, macSmokeHost: 'local' }, outputs: {} }, baseline: () => first })).toMatchObject({ outcome: 'ok', files: 2 });
  expect(captured).toEqual([['src/path.test.ts', 'src/thing.test.ts']]);
}));

test('changed directory index.ts and index.tsx select cut tests importing their directory', () => {
  for (const extension of ['ts', 'tsx']) inTemp((repo) => {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      expect(result.status).toBe(0);
      return result.stdout.trim();
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'src', `index.${extension}`), 'export const value = 1;\n');
    writeFileSync(join(repo, 'test', 'index-import.test.ts'), "import { value } from '../src';\n");
    git('add', '.'); git('commit', '-qm', 'base');
    const first = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', `index.${extension}`), 'export const value = 2;\n');
    git('add', '.'); git('commit', '-qm', 'cut');
    const second = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'test', 'index-import.test.ts'), 'test("unrelated", () => {});\n');
    const captured: string[][] = [];
    const runner: CommandRunner = (cmd, args, cwd, timeoutMs) => {
      if (cmd === 'uname') return success('Darwin\n');
      if (cmd === 'bun' && args[0] === 'test') {
        expect(timeoutMs).toBe(1_200_000);
        captured.push(args.slice(1));
        return success('test/index-import.test.ts:\n1 pass\n0 fail\nRan 1 test across 1 file\n');
      }
      if (cmd === 'git' && ['diff', 'ls-tree', 'grep', 'show'].includes(args[0]!)) {
        const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      }
      return success();
    };
    const result = runMacSmoke(runner, { repo, context: { input: { version: '0.2.10', previousVersion: '0.2.9', commit: second, macSmokeHost: 'local' }, outputs: {} }, baseline: () => first });
    expect(result).toMatchObject({ outcome: 'ok', files: 1 });
    expect(captured).toEqual([['test/index-import.test.ts']]);
  });
});

test('real bun prints no per-file header when every test passes — the junit report alone proves collection', () => {
  const junit = (names: string[]) => names.map((file) => `<testsuite name="${file}" file="${file}" tests="1"><testcase name="t"/></testsuite>`).join('');
  const quiet: CommandResult = { status: 0, stdout: 'bun test v1.4.2\n', stderr: '\n 2 pass\n 0 fail\nRan 2 tests across 2 files. [9.00ms]\n' };
  expect(testFailures(quiet, junit(['test/a.test.ts', 'test/b.test.ts']), ['test/a.test.ts', 'test/b.test.ts'])).toEqual([]);
  // One selected file missing from the report, or no report at all, is unmeasured — never a pass.
  expect(() => testFailures(quiet, junit(['test/a.test.ts', 'test/x.test.ts']), ['test/a.test.ts', 'test/b.test.ts'])).toThrow('측정 불가');
  expect(() => testFailures(quiet, null, ['test/a.test.ts', 'test/b.test.ts'])).toThrow('측정 불가');
});
