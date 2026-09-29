import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGateRunner, graphGateResult, judgeGate, type GateRunner } from './gate-node';

const CUT = 'a'.repeat(40), BASE = 'b'.repeat(40);
const A = 'src/a.test.ts > A', B = 'src/b.test.ts > B', C = 'src/c.test.ts > C', D = 'src/d.test.ts > D';
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gate-node-unit-'));
  scratch.push(root);
  const instanceRoot = join(root, 'instance');
  mkdirSync(join(instanceRoot, 'release/1.0.0'), { recursive: true });
  writeFileSync(join(instanceRoot, 'release/1.0.0/release.json'), JSON.stringify({ sourceCommit: BASE }));
  return { root, instanceRoot };
}
function runOutput(ids: string[]): string {
  return ids.map((id) => {
    const divider = id.indexOf(' > ');
    return `${id.slice(0, divider)}:\n(fail) ${id.slice(divider + 3)} [1.00ms]\n`;
  }).join('') + `\n${ids.length} fail\nRan ${Math.max(1, ids.length)} tests across ${Math.max(1, ids.length)} files.\n`;
}
function fake(cut = [A, B, C], baseline = [A, D], cached = true) {
  const { root, instanceRoot } = fixture();
  if (cached) writeFileSync(join(instanceRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: BASE, failures: baseline }));
  const calls: string[] = [];
  const runner: GateRunner = {
    async command(cmd, args, cwd) {
      calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
      if (cmd === 'bun' && args[0] === 'run') {
        const file = args[2];
        const ids = cwd.endsWith('/cut') ? (file === 'src/c.test.ts' ? [] : file === 'src/b.test.ts' ? [B] : [A])
          : file === 'src/b.test.ts' ? [] : [A];
        return { rc: ids.length ? 1 : 0, output: runOutput(ids) };
      }
      return { rc: 0, output: '' };
    },
    async sweep(tree) {
      calls.push(`sweep @${tree}`);
      const ids = tree.endsWith('/cut') ? cut : baseline;
      return { rc: ids.length ? 1 : 0, output: runOutput(ids) };
    },
    async add(tree, sha) { calls.push(`add ${sha} @${tree}`); },
    async remove(tree) { calls.push(`remove @${tree}`); },
    async snapshot(tree, sha) { calls.push(`snapshot ${sha} @${tree}`); },
    async removeSnapshot(tree) { calls.push(`removeSnapshot @${tree}`); },
  };
  return { root, instanceRoot, runner, calls };
}
const options = (instanceRoot: string) => ({ commit: CUT, version: '1.0.1', baselineVersion: '1.0.0', instanceRoot });

test('cut A/B/C versus baseline A/D reruns B and C; only reproduced B is introduced', async () => {
  const { root, instanceRoot, runner, calls } = fake();
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'regression', commit: CUT, introduced: [B], fixed: 1, preexisting: 1 });
  expect(calls.filter((c) => c.startsWith(`add ${BASE}`))).toHaveLength(0);
  expect(calls.filter((c) => c.startsWith('git '))).toHaveLength(0);
  expect(calls.filter((c) => c.startsWith(`snapshot ${BASE}`))).toHaveLength(1);
  expect(calls.some((c) => c.includes('src/b.test.ts @') && c.includes('/cut'))).toBe(true);
  expect(calls.some((c) => c.includes('src/c.test.ts @') && c.includes('/baseline'))).toBe(false);
  expect(calls.filter((c) => c.startsWith('sweep '))).toHaveLength(1);
  expect(calls.filter((c) => c.startsWith('bun install '))).toHaveLength(4);
  const path = join(instanceRoot, 'release/1.0.1/gate-failures.json');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ commit: CUT, failures: [A, B, C] });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(existsSync(join(root, 'release/1.0.1/gate-failures.json'))).toBe(false);
  expect(calls.filter((c) => c.startsWith('remove '))).toHaveLength(1);
  expect(calls.filter((c) => c.startsWith('removeSnapshot '))).toHaveLength(1);
});

test('cached baseline avoids a baseline sweep even when an isolated comparison is necessary', async () => {
  const { instanceRoot, runner, calls } = fake();
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'regression', introduced: [B] });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(1);
  expect(calls.filter((call) => call.startsWith(`add ${BASE}`))).toHaveLength(0);
  expect(calls.filter((call) => call.startsWith(`snapshot ${BASE}`))).toHaveLength(1);
});

test('cached baseline avoids baseline worktree entirely when cut has no new failures', async () => {
  const { instanceRoot, runner, calls } = fake([A], [A, D]);
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'ok', introduced: [], fixed: 1, preexisting: 1 });
  expect(calls.filter((c) => c.startsWith('add '))).toHaveLength(1);
  expect(calls.filter((c) => c.startsWith('sweep '))).toHaveLength(1);
});

test('remote gate keeps the cut and cached baseline on the same host and cleans both', async () => {
  const { instanceRoot, runner, calls } = fake();
  const command = runner.command;
  runner.command = async (cmd, args, cwd) => cmd === 'mktemp'
    ? { rc: 0, output: '/tmp/release-gate-remote123\n' }
    : command(cmd, args, cwd);
  expect(await judgeGate({ ...options(instanceRoot), remote: 'test-host' }, runner)).toMatchObject({ outcome: 'regression', introduced: [B] });
  expect(calls.filter((call) => call.startsWith(`add ${BASE}`))).toHaveLength(0);
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(1);
  expect(calls.some((call) => call.startsWith(`snapshot ${BASE} @/tmp/release-gate-remote123/baseline`))).toBe(true);
  expect(calls.some((call) => call.startsWith('removeSnapshot @/tmp/release-gate-remote123/baseline'))).toBe(true);
  expect(calls.some((call) => call.startsWith('rmdir /tmp/release-gate-remote123 '))).toBe(true);
});

test('an invalid remote host fails closed before creating a remote directory', async () => {
  const { instanceRoot, runner, calls } = fake();
  expect(await judgeGate({ ...options(instanceRoot), remote: 'host;unsafe' }, runner)).toMatchObject({ outcome: 'error', error: 'invalid ssh host' });
  expect(calls).toHaveLength(0);
});

test('uncached baseline runs once and is cleaned up', async () => {
  const { instanceRoot, runner, calls } = fake([A], [A, D], false);
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', fixed: 1 });
  expect(calls.filter((c) => c.startsWith('sweep '))).toHaveLength(2);
  expect(calls.filter((c) => c.startsWith('remove '))).toHaveLength(2);
});

test('baseline isolated failure reclassifies the candidate as preexisting', async () => {
  const { instanceRoot, runner } = fake([B], []);
  const old = runner.command;
  runner.command = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[2] === 'src/b.test.ts' && cwd.endsWith('/baseline')) return { rc: 1, output: runOutput([B]) };
    return old(cmd, args, cwd);
  };
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', introduced: [], preexisting: 1 });
});

test('new test file missing from baseline is introduced only after cut isolation reproduces it', async () => {
  const { instanceRoot, runner, calls } = fake([B], []);
  const command = runner.command;
  runner.command = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[2] === 'src/b.test.ts' && cwd.endsWith('/baseline')) {
      return { rc: 1, output: 'No tests found\n' };
    }
    if (cmd === 'git' && args[0] === 'ls-tree') return { rc: 0, output: '' };
    return command(cmd, args, cwd);
  };
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'regression', introduced: [B] });
  expect(calls.filter((call) => call.startsWith(`add ${BASE}`))).toHaveLength(0);
});

test('an incomplete sweep is an error, not a clean release', async () => {
  const { instanceRoot, runner } = fake();
  runner.sweep = async () => ({ rc: 0, output: '0 fail\nRan 0 tests across 0 files.\n' });
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: expect.stringContaining('cut sweep incomplete') });
});

test('missing failure summary is an error even if the runner exited zero', async () => {
  const { instanceRoot, runner } = fake();
  runner.sweep = async () => ({ rc: 0, output: 'Ran 1 test across 1 file.\n' });
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: expect.stringContaining('failure attribution incomplete') });
});

test('a zero-exit sweep reporting failures cannot be called healthy', async () => {
  const { instanceRoot, runner } = fake();
  runner.sweep = async () => ({ rc: 0, output: runOutput([A]) });
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: expect.stringContaining('failure attribution incomplete') });
});

test('a cached baseline for another commit is rejected instead of silently reused', async () => {
  const { instanceRoot, runner } = fake();
  expect(await judgeGate({ ...options(instanceRoot), baselineCommit: 'c'.repeat(40) }, runner)).toMatchObject({
    outcome: 'error', error: expect.stringContaining('cached baseline commit does not match'),
  });
});

test('cached failures are rejected when release metadata names a different source commit', async () => {
  const { instanceRoot, runner, calls } = fake([B], [A]);
  writeFileSync(join(instanceRoot, 'release/1.0.0/release.json'), JSON.stringify({ sourceCommit: 'c'.repeat(40) }));
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [B], fixed: 1 });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(2);
  expect(calls.filter((call) => call.startsWith('add '))).toHaveLength(2);
  expect(calls.filter((call) => call.startsWith('snapshot '))).toHaveLength(0);
});

test('an invalid cached test identity is rejected before any isolation can execute it', async () => {
  const { instanceRoot, runner, calls } = fake();
  writeFileSync(join(instanceRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: BASE, failures: ['src/b.test.ts'] }));
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: expect.stringContaining('unsafe test path') });
  expect(calls.filter((call) => call.includes('test:deterministic src/b.test.ts'))).toHaveLength(0);
});

test('implicit baseline ignores a stale cached commit and sweeps the release manifest source instead', async () => {
  const { instanceRoot, runner, calls } = fake([B], [A]);
  writeFileSync(join(instanceRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: 'c'.repeat(40), failures: [B] }));
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result).toMatchObject({ outcome: 'regression', introduced: [B], fixed: 1 });
  expect(calls.filter((call) => call.startsWith('sweep '))).toHaveLength(2);
  expect(calls.filter((call) => call.startsWith(`add ${BASE}`))).toHaveLength(1);
  expect(calls.filter((call) => call.startsWith('snapshot '))).toHaveLength(0);
});

test('missing release manifest cannot silently trust a cached baseline without an explicit commit', async () => {
  const { instanceRoot, runner, calls } = fake();
  rmSync(join(instanceRoot, 'release/1.0.0/release.json'));
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', introduced: [] });
  expect(calls.filter((call) => call.startsWith('snapshot '))).toHaveLength(0);
  expect(calls.filter((call) => call.startsWith(`add ${BASE}`))).toHaveLength(0);
});

test('baseline single-file preexistence is checked once per file, including multiple failures', async () => {
  const B2 = 'src/b.test.ts > B2';
  const { instanceRoot, runner, calls } = fake([B, B2], []);
  const old = runner.command;
  runner.command = async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[2] === 'src/b.test.ts') {
      calls.push(`${cmd} ${args.join(' ')} @${cwd}`);
      return { rc: 1, output: runOutput(cwd.endsWith('/cut') ? [B, B2] : [B]) };
    }
    return old(cmd, args, cwd);
  };
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'regression', introduced: [B2], preexisting: 1 });
  expect(calls.filter((call) => call.includes('src/b.test.ts @'))).toHaveLength(2);
});

test('four shard sweep combines file failures and passes explicit CDP ignores', async () => {
  const { root } = fixture();
  const paths = ['src/cli/a.test.ts', 'src/agent/b.test.ts', 'test/c.test.ts', 'scripts/d.test.ts'];
  const init = spawnSync('git', ['init', '-q'], { cwd: root });
  expect(init.status).toBe(0);
  for (const path of paths) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), path === 'scripts/d.test.ts' ? 'requireCdpBase' : 'test');
  }
  expect(spawnSync('git', ['add', ...paths], { cwd: root }).status).toBe(0);
  const original = createGateRunner(root).command;
  const seen: string[][] = [];
  const runner = createGateRunner(root, undefined, async (cmd, args, cwd) => {
    if (cmd === 'bun' && args[0] === 'run') {
      seen.push(args);
      const path = args.at(-1)!;
      const ids = path === 'src/cli' ? ['src/cli/a.test.ts > A'] : path === 'src/agent' ? ['src/agent/b.test.ts > B'] : [];
      return { rc: ids.length ? 1 : 0, output: `0 pass\n${runOutput(ids)}` };
    }
    return original(cmd, args, cwd);
  });
  const logDir = join(root, 'logs');
  const sweep = await runner.sweep(root, logDir);
  expect(sweep.rc).toBe(1);
  expect(sweep.output).toContain('2 fail\n0 errors\nRan 4 tests across 4 files.');
  expect(sweep.output).toContain('src/cli/a.test.ts:');
  expect(sweep.output).toContain('src/agent/b.test.ts:');
  expect(seen.map((args) => args.at(-1))).toEqual(['src/cli', 'src/agent', 'test', 'scripts']);
  expect(seen[3]).toContain('--path-ignore-patterns');
  for (const args of seen.slice(0, 3)) expect(args).not.toContain('--path-ignore-patterns');
  for (const name of ['src-cli', 'src-rest', 'test', 'other']) expect(existsSync(join(logDir, `${name}.log`))).toBe(true);
});

test('a shard with no Ran summary reports its name, rc and last output', async () => {
  const { root } = fixture();
  mkdirSync(join(root, 'src/cli'), { recursive: true });
  writeFileSync(join(root, 'src/cli/a.test.ts'), 'test');
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', 'src/cli/a.test.ts'], { cwd: root });
  const real = createGateRunner(root).command;
  const runner = createGateRunner(root, undefined, async (cmd, args, cwd) => cmd === 'bun' ? { rc: 1, output: 'stalled\nlast diagnostic' } : real(cmd, args, cwd));
  await expect(runner.sweep(root, join(root, 'logs'))).rejects.toThrow(/src-cli shard: .*rc=1; Ran=missing; errors=missing.*last diagnostic/s);
});

test('file-level errors compare against the baseline and only reproduced new errors regress', async () => {
  const { instanceRoot, runner } = fake([], []);
  const errorOutput = (file: string) => `${file}:\n# Unhandled error between tests\n0 fail\n1 errors\nRan 1 test across 1 file.\n`;
  const old = runner.command;
  runner.sweep = async (tree) => ({ rc: 1, output: errorOutput(tree.endsWith('/cut') ? 'src/b.test.ts' : 'src/a.test.ts') });
  runner.command = async (cmd, args, cwd) => cmd === 'bun' && args[0] === 'run' && args[2] === 'src/b.test.ts'
    ? { rc: cwd.endsWith('/cut') ? 1 : 0, output: cwd.endsWith('/cut') ? errorOutput('src/b.test.ts') : runOutput([]) }
    : old(cmd, args, cwd);
  const cached = join(instanceRoot, 'release/1.0.0/gate-failures.json');
  writeFileSync(cached, JSON.stringify({ commit: BASE, failures: [], errors: ['src/a.test.ts > [error]'] }));
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'regression', introduced: ['src/b.test.ts > [error]'] });
  writeFileSync(cached, JSON.stringify({ commit: BASE, failures: [], errors: ['src/b.test.ts > [error]'] }));
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'ok', introduced: [] });
});

test('graph gateRemote input is validated by the existing ssh host guard', () => {
  const { root } = fixture();
  const context = join(root, 'context.json');
  writeFileSync(context, JSON.stringify({ input: { commit: CUT, version: '1.0.1', previousVersion: '1.0.0', gateRemote: 'bad;host' }, outputs: {} }));
  const result = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts'), '--json'], {
    encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context },
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ outcome: 'error', error: 'invalid ssh host' });
});

test('local command runner executes in the requested checkout, not its parent repo', async () => {
  const { root } = fixture();
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  const output = await createGateRunner(root).command('bun', ['-e', 'console.log(process.cwd())'], checkout);
  expect(output.rc).toBe(0);
  // macOS 의 /var 는 /private/var 링크 — 경로를 실제 경로로 맞춰 비교한다(Pod·Linux 만 초록이던 시험).
  expect(realpathSync(output.output.trim())).toBe(realpathSync(checkout));
});

test('real baseline snapshot extracts a commit without registering a worktree and removes it', async () => {
  const { root } = fixture();
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  expect(git('init', '-q').status).toBe(0);
  writeFileSync(join(repo, 'tracked.txt'), 'original');
  expect(git('add', 'tracked.txt').status).toBe(0);
  expect(git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline').status).toBe(0);
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(repo, 'tracked.txt'), 'working copy');
  const runner = createGateRunner(repo);
  const snapshot = join(root, 'snapshot');
  await runner.snapshot(snapshot, sha);
  expect(readFileSync(join(snapshot, 'tracked.txt'), 'utf8')).toBe('original');
  expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: snapshot, encoding: 'utf8' }).stdout.trim()).toBe(sha);
  expect(git('worktree', 'list', '--porcelain').stdout).not.toContain(snapshot);
  await runner.removeSnapshot(snapshot);
  expect(existsSync(snapshot)).toBe(false);
  await expect(runner.snapshot(snapshot, 'c'.repeat(40))).rejects.toThrow('baseline snapshot checkout failed');
  await runner.removeSnapshot(snapshot);
});

test('runner failure is error and does not persist a false baseline', async () => {
  const { instanceRoot, runner, calls } = fake();
  runner.sweep = async () => { throw new Error('suite incomplete'); };
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: 'suite incomplete' });
  expect(existsSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'))).toBe(false);
  expect(calls.filter((c) => c.startsWith('remove '))).toHaveLength(1);
});

test('cleanup failure does not publish a false next-release baseline', async () => {
  const { instanceRoot, runner } = fake();
  runner.removeSnapshot = async () => { throw new Error('snapshot cleanup failed'); };
  expect(await judgeGate(options(instanceRoot), runner)).toMatchObject({ outcome: 'error', error: expect.stringContaining('cleanup:') });
  expect(existsSync(join(instanceRoot, 'release/1.0.1/gate-failures.json'))).toBe(false);
});

test('graph gate regression maps to fail while preserving measured counts', async () => {
  const { instanceRoot, runner } = fake();
  const result = await judgeGate(options(instanceRoot), runner);
  expect(result.outcome).toBe('regression');
  expect(graphGateResult(result, true)).toMatchObject({ outcome: 'fail', verdict: 'fail', introduced: [B], preexisting: 1, fixed: 1 });
  expect(graphGateResult(result, false)).toMatchObject({ outcome: 'regression', introduced: [B], preexisting: 1, fixed: 1 });
});

test('graph context supplies input values and an un-runnable gate emits JSON error with rc 2', () => {
  const { root } = fixture();
  const context = join(root, 'graph-context.json');
  writeFileSync(context, JSON.stringify({ input: { commit: 'invalid', version: '1.0.1', previousVersion: '1.0.0' }, outputs: {} }));
  const result = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts'), '--json'], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context },
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({ outcome: 'error', commit: 'invalid', introduced: [], error: 'invalid commit or version' });
});

test('explicit CLI arguments do not read an ambient graph context file', () => {
  const result = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts'), '--commit', 'invalid', '--version', '1.0.1', '--json'], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, ELANOUS_GRAPH_CONTEXT: '/nonexistent/context.json' },
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({ commit: 'invalid', outcome: 'error', error: 'invalid commit or version' });
});

test('--help prints options and exits 0 without invoking a gate', () => {
  const result = spawnSync('bun', [resolve(import.meta.dir, 'gate-node.ts'), '--help'], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, ELANOUS_GRAPH_CONTEXT: '/nonexistent/context.json' },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--baseline-version');
  expect(result.stdout).toContain('--remote');
  expect(result.stdout).toContain('--json');
});
