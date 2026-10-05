import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { junitCounts, runResyncShadow } from './resync-shadow.js';

// The default runner isolates PR tests in `unshare --user --net` (Linux user namespaces); macOS has no unshare, so the
// production path fails closed there ('test sandbox unavailable' → error, outside the ratio) and these tests cannot run.
const hasSandbox = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'true'], { encoding: 'utf8' }).status === 0;
const sandboxTest = test.skipIf(!hasSandbox);

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(failingTest = false, testFile = 'value.test.ts', remoteWriteProbe = false, secondTest?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resync-shadow-fixture-')));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  git(root, 'init', '--bare', '-q', remote);
  mkdirSync(work);
  git(work, 'init', '-q');
  git(work, 'checkout', '-qb', 'main');
  git(work, 'config', 'user.email', 'test@example.test');
  git(work, 'config', 'user.name', 'Shadow Test');
  writeFileSync(join(work, 'value.ts'), "export const value = 'base';\n");
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'base');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-qb', 'self-impl/conflicted');
  writeFileSync(join(work, 'value.ts'), "export const value = 'branch';\n");
  writeFileSync(join(work, testFile), remoteWriteProbe
    ? `import { test, expect } from 'bun:test';\nimport { spawnSync } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\ntest('remote write denied', () => { const r = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/self-impl/conflicted']); expect(r.status).not.toBe(0); expect(r.stderr.toString()).toMatch(/Permission denied|Operation not permitted/); expect(() => writeFileSync(join(${JSON.stringify(remote)}, 'refs/heads/injected'), 'tamper')).toThrow(); });\n`
    : `import { test, expect } from 'bun:test';\nimport { value } from './value';\ntest('merged value', () => expect(value).toBe(${JSON.stringify(failingTest ? 'never' : 'combined')}));\n`);
  if (secondTest && secondTest !== 'deleted.test.ts') writeFileSync(join(work, secondTest), secondTest === 'empty.test.ts'
    ? 'export const noTests = true;\n'
    : secondTest === 'spoof.test.ts'
      // Prints the runner's success text and exits before any test is registered (review round 3 ①).
      ? "console.log('1 pass');\nconsole.log('Ran 1 tests across 1 files.');\nprocess.exit(0);\n"
      : "import { test, expect } from 'bun:test';\ntest('another file runs', () => expect(true).toBe(true));\n");
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'branch and test');
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/self-impl/conflicted');
  const headBefore = git(work, 'ls-remote', 'origin', 'refs/heads/self-impl/conflicted').split('\t')[0];
  git(work, 'checkout', '-q', 'main');
  writeFileSync(join(work, 'value.ts'), "export const value = 'main';\n");
  git(work, 'commit', '-qam', 'main change');
  git(work, 'push', '-q', 'origin', 'main');
  const candidate = { number: 12, headRefName: 'self-impl/conflicted', mergeable: 'CONFLICTING', isDraft: true, labels: [] };
  const calls: string[][] = [];
  const runGh = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([
      { ...candidate, number: 99, headRefName: 'self-impl/mergeable', mergeable: 'MERGEABLE' },
      { ...candidate, number: 13, headRefName: 'self-impl/stalled', labels: [{ name: 'elanous:stalled' }] },
      candidate,
    ]);
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '12') return JSON.stringify({ files: [{ path: 'value.ts' }, { path: testFile }, ...(secondTest ? [{ path: secondTest }] : [])] });
    throw new Error(`unexpected gh: ${args.join(' ')}`);
  };
  const state = join(root, 'state');
  const ledger = join(state, 'orchestrator', 'resync-shadow.jsonl');
  const remoteHead = () => git(work, 'ls-remote', 'origin', 'refs/heads/self-impl/conflicted').split('\t')[0];
  const worktrees = () => git(work, 'worktree', 'list', '--porcelain');
  return { work, runGh, calls, state, ledger, remoteHead, headBefore, worktrees };
}

for (const scenario of [
  { name: 'clean resolution saves the PR', resolved: true, failingTest: false, verdict: 'saved', status: 'llm-resolved' },
  { name: 'marker left by resolver stays unresolved', resolved: false, failingTest: false, verdict: 'unresolved', status: 'conflict-unresolved' },
  { name: 'failing changed test blocks saving', resolved: true, failingTest: true, verdict: 'merge-ok-tests-failed', status: 'llm-resolved' },
] as const) {
  (scenario.resolved ? sandboxTest : test)(scenario.name, async () => {
    const f = fixture(scenario.failingTest);
    let resolves = 0;
    const logs: Array<{ event: string; data: unknown }> = [];
    const originalLog = debug.log;
    debug.log = ((category: string, event: string, data: unknown) => {
      if (category === 'loop.orchestrator') logs.push({ event, data });
    }) as typeof debug.log;
    try {
      const summary = await runResyncShadow(3, {
        repoRoot: f.work, instanceRoot: f.state, runGh: f.runGh,
        resolve: async (_path, conflict) => { resolves++; return scenario.resolved ? "export const value = 'combined';\n" : conflict; },
      });
      expect(summary).toEqual({ candidates: 1, tried: 1, saved: scenario.verdict === 'saved' ? 1 : 0,
        savedRatio: scenario.verdict === 'saved' ? 1 : 0 });
      expect(resolves).toBe(1);
      const rows = readFileSync(f.ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pr: 12, head: 'self-impl/conflicted', verdict: scenario.verdict,
        status: scenario.status, testFiles: ['value.test.ts'], resolvedFiles: scenario.resolved ? ['value.ts'] : [] });
      expect(Number.isFinite(Date.parse(rows[0].at))).toBe(true);
      if (scenario.verdict === 'merge-ok-tests-failed') expect(rows[0].failedTests[0]).toStartWith('merged value');
      expect(f.calls.filter(args => args[1] === 'view')).toHaveLength(1);
      expect(f.remoteHead()).toBe(f.headBefore);
      expect(f.worktrees()).toBe(`worktree ${f.work}\nHEAD ${git(f.work, 'rev-parse', 'HEAD')}\nbranch refs/heads/main`);
      expect(logs).toContainEqual({ event: 'resync-shadow', data: { pr: 12, verdict: scenario.verdict, status: scenario.status } });
      expect(logs).toContainEqual({ event: 'resync-shadow-summary', data: { candidates: 1, tried: 1, saved: summary.saved } });
    } finally { debug.log = originalLog; }
  }, 30_000);
}

sandboxTest('a changed test beginning with a dash is executed instead of counted as no-tests', async () => {
  const f = fixture(false, '-foo.test.ts');
  const summary = await runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state, runGh: f.runGh,
    resolve: async () => "export const value = 'combined';\n" });
  expect(summary).toEqual({ candidates: 1, tried: 1, saved: 1, savedRatio: 1 });
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ verdict: 'saved', testFiles: ['-foo.test.ts'] });
  expect(f.remoteHead()).toBe(f.headBefore);
  expect(f.worktrees()).toBe(`worktree ${f.work}\nHEAD ${git(f.work, 'rev-parse', 'HEAD')}\nbranch refs/heads/main`);
});

sandboxTest('each changed test file must execute tests before the PR can be saved', async () => {
  const f = fixture(false, 'value.test.ts', false, 'empty.test.ts');
  const summary = await runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state, runGh: f.runGh,
    resolve: async () => "export const value = 'combined';\n" });
  // A changed file with zero runner-recorded cases is a measured «not saved», not a measurement error.
  expect(summary).toEqual({ candidates: 1, tried: 1, saved: 0, savedRatio: 0 });
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ verdict: 'merge-ok-tests-failed', status: 'llm-resolved',
    testFiles: ['value.test.ts', 'empty.test.ts'], failedTests: [expect.stringContaining('empty.test.ts: no test cases recorded')] });
  expect(f.remoteHead()).toBe(f.headBefore);
  expect(f.worktrees()).toBe(`worktree ${f.work}\nHEAD ${git(f.work, 'rev-parse', 'HEAD')}\nbranch refs/heads/main`);
}, 30_000);

sandboxTest('all changed test files run before a successful save', async () => {
  const f = fixture(false, 'value.test.ts', false, 'second.test.ts');
  const summary = await runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state, runGh: f.runGh,
    resolve: async () => "export const value = 'combined';\n" });
  expect(summary).toEqual({ candidates: 1, tried: 1, saved: 1, savedRatio: 1 });
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ verdict: 'saved',
    testFiles: ['value.test.ts', 'second.test.ts'] });
  expect(f.remoteHead()).toBe(f.headBefore);
  expect(f.worktrees()).toBe(`worktree ${f.work}\nHEAD ${git(f.work, 'rev-parse', 'HEAD')}\nbranch refs/heads/main`);
}, 30_000);

sandboxTest('a PR test cannot push to its remote even with the local bare origin configured', async () => {
  const f = fixture(false, 'value.test.ts', true);
  const summary = await runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state, runGh: f.runGh,
    resolve: async () => "export const value = 'combined';\n" });
  expect(summary).toEqual({ candidates: 1, tried: 1, saved: 1, savedRatio: 1 });
  expect(f.remoteHead()).toBe(f.headBefore);
  expect(f.worktrees()).toBe(`worktree ${f.work}\nHEAD ${git(f.work, 'rev-parse', 'HEAD')}\nbranch refs/heads/main`);
});

test('provider guard blocks a save without running tests, and the temporary worktree is removed', async () => {
  const f = fixture();
  const summary = await runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state, runGh: f.runGh,
    resolve: async () => '[LLM PROVIDER BLOCKED] unavailable\n',
    runTests: () => { throw new Error('must not test a rejected merge'); } });
  expect(summary).toEqual({ candidates: 1, tried: 1, saved: 0, savedRatio: 0 });
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ verdict: 'guard-tripped', status: 'conflict-unresolved' });
  expect(f.remoteHead()).toBe(f.headBefore);
  expect(f.worktrees()).toBe(`worktree ${f.work}\nHEAD ${git(f.work, 'rev-parse', 'HEAD')}\nbranch refs/heads/main`);
});

test('successful merge without changed test files is not counted as saved', async () => {
  const f = fixture();
  const runGh = (args: string[]) => args[1] === 'view' ? JSON.stringify({ files: [{ path: 'value.ts' }] }) : f.runGh(args);
  const summary = await runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state, runGh,
    resolve: async () => "export const value = 'combined';\n",
    runTests: () => { throw new Error('no declared tests to run'); } });
  expect(summary).toEqual({ candidates: 1, tried: 1, saved: 0, savedRatio: 0 });
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ verdict: 'merge-ok-no-tests', status: 'llm-resolved', testFiles: [] });
  expect(f.remoteHead()).toBe(f.headBefore);
  expect(f.worktrees()).toBe(`worktree ${f.work}\nHEAD ${git(f.work, 'rev-parse', 'HEAD')}\nbranch refs/heads/main`);
});

sandboxTest('candidates are tried in ascending PR number and --max limits attempts', async () => {
  const f = fixture();
  const runGh = (args: string[]) => args[1] === 'list'
    ? JSON.stringify([12, 10].map(number => ({ number, headRefName: 'self-impl/conflicted', mergeable: 'CONFLICTING', isDraft: true, labels: [] })))
    : args[1] === 'view' && args[2] === '10'
      ? JSON.stringify({ files: [{ path: 'value.test.ts' }] }) : f.runGh(args);
  const summary = await runResyncShadow(1, { repoRoot: f.work, instanceRoot: f.state, runGh,
    resolve: async () => "export const value = 'combined';\n" });
  expect(summary).toEqual({ candidates: 1, tried: 1, saved: 1, savedRatio: 1 });
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ pr: 10, verdict: 'saved' });
  expect(f.remoteHead()).toBe(f.headBefore);
  expect(f.worktrees()).toBe(`worktree ${f.work}\nHEAD ${git(f.work, 'rev-parse', 'HEAD')}\nbranch refs/heads/main`);
});

test('fetch failure is recorded but not counted as a measured failure', async () => {
  const f = fixture();
  const remote = git(f.work, 'remote', 'get-url', 'origin');
  git(f.work, 'remote', 'set-url', 'origin', join(f.work, 'missing-remote.git'));
  const summary = await runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state, runGh: f.runGh,
    resolve: async () => { throw new Error('must not resolve after failed fetch'); } });
  expect(summary).toEqual({ candidates: 1, tried: 0, saved: 0, savedRatio: null });
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ verdict: 'error', status: 'error', pr: 12 });
  git(f.work, 'remote', 'set-url', 'origin', remote);
  expect(f.remoteHead()).toBe(f.headBefore);
  expect(f.worktrees()).toBe(`worktree ${f.work}\nHEAD ${git(f.work, 'rev-parse', 'HEAD')}\nbranch refs/heads/main`);
});

test('per-PR file lookup failure is recorded without entering the denominator', async () => {
  const f = fixture();
  const summary = await runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state,
    runGh: args => {
      if (args[1] === 'view') throw new Error('PR files unavailable');
      return f.runGh(args);
    },
    resolve: async () => { throw new Error('must not resolve without PR files'); } });
  expect(summary).toEqual({ candidates: 1, tried: 0, saved: 0, savedRatio: null });
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ verdict: 'error', status: 'error',
    failedTests: ['PR files unavailable'] });
  expect(f.remoteHead()).toBe(f.headBefore);
  expect(f.worktrees()).toBe(`worktree ${f.work}\nHEAD ${git(f.work, 'rev-parse', 'HEAD')}\nbranch refs/heads/main`);
});

test('test sandbox failure is recorded but excluded from the savings ratio', async () => {
  const f = fixture();
  const summary = await runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state, runGh: f.runGh,
    resolve: async () => "export const value = 'combined';\n",
    runTests: () => { throw new Error('test sandbox unavailable'); } });
  expect(summary).toEqual({ candidates: 1, tried: 0, saved: 0, savedRatio: null });
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ verdict: 'error', status: 'llm-resolved',
    failedTests: ['test sandbox unavailable'] });
  expect(f.remoteHead()).toBe(f.headBefore);
  expect(f.worktrees()).toBe(`worktree ${f.work}\nHEAD ${git(f.work, 'rev-parse', 'HEAD')}\nbranch refs/heads/main`);
});

sandboxTest('measurement errors do not dilute a completed save', async () => {
  const f = fixture();
  const runGh = (args: string[]) => args[1] === 'list'
    ? JSON.stringify([11, 12].map(number => ({ number, headRefName: number === 11 ? 'self-impl/missing' : 'self-impl/conflicted',
      mergeable: 'CONFLICTING', isDraft: true, labels: [] }))) : f.runGh(args);
  const summary = await runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state, runGh,
    resolve: async () => "export const value = 'combined';\n" });
  expect(summary).toEqual({ candidates: 2, tried: 1, saved: 1, savedRatio: 1 });
  expect(readFileSync(f.ledger, 'utf8').trim().split('\n').map(row => JSON.parse(row).verdict)).toEqual(['error', 'saved']);
  expect(f.remoteHead()).toBe(f.headBefore);
  expect(f.worktrees()).toBe(`worktree ${f.work}\nHEAD ${git(f.work, 'rev-parse', 'HEAD')}\nbranch refs/heads/main`);
});

test('PR observation failure aborts the ratio instead of reporting zero', async () => {
  const f = fixture();
  await expect(runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state,
    runGh: () => { throw new Error('gh unavailable'); } })).rejects.toThrow('gh unavailable');
  expect(f.remoteHead()).toBe(f.headBefore);
});

test('zero candidates never invokes the resolver and reports null ratio', async () => {
  const f = fixture();
  const summary = await runResyncShadow(0, { repoRoot: f.work, instanceRoot: f.state, runGh: f.runGh,
    resolve: async () => { throw new Error('should not resolve'); } });
  expect(summary).toEqual({ candidates: 0, tried: 0, saved: 0, savedRatio: null });
  expect(f.remoteHead()).toBe(f.headBefore);
});

sandboxTest('a changed test that prints the success text and exits cannot be counted as saved (review round 3 ①)', async () => {
  const f = fixture(false, 'value.test.ts', false, 'spoof.test.ts');
  const summary = await runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state, runGh: f.runGh,
    resolve: async () => "export const value = 'combined';\n" });
  expect(summary.saved).toBe(0);
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ verdict: 'merge-ok-tests-failed',
    failedTests: [expect.stringContaining('spoof.test.ts: no test cases recorded')] });
  expect(f.remoteHead()).toBe(f.headBefore);
}, 30_000);

sandboxTest('a test file the PR deleted is skipped, and only-deleted tests count as no-tests (review round 3 ②)', async () => {
  const f = fixture(false, 'value.test.ts', false, 'deleted.test.ts');
  const summary = await runResyncShadow(3, { repoRoot: f.work, instanceRoot: f.state, runGh: f.runGh,
    resolve: async () => "export const value = 'combined';\n" });
  expect(summary).toEqual({ candidates: 1, tried: 1, saved: 1, savedRatio: 1 });
  expect(JSON.parse(readFileSync(f.ledger, 'utf8'))).toMatchObject({ verdict: 'saved', testFiles: ['value.test.ts', 'deleted.test.ts'] });
}, 30_000);

test('junitCounts reads the runner report and returns null without one', () => {
  expect(junitCounts('<testsuites name="bun test" tests="2" assertions="2" failures="1" skipped="0"><testsuite><testcase name="a" /><testcase name="b"><failure message="x"/></testcase></testsuite></testsuites>'))
    .toEqual({ tests: 2, failures: 1, failed: ['b'] });
  expect(junitCounts('1 pass\nRan 1 tests across 1 files.')).toBeNull();
});
