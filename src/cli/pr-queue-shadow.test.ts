import { afterEach, expect, test } from 'bun:test';
import { LogStore } from '../mss/logging/log-store.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerPrCommands } from './pr-cli.js';
import { runL8ShadowQueue, type L8ShadowQueueDeps, type L8ShadowVerdict } from '../self-implement/l8-merge-queue.js';

const roots: string[] = [];
const originalCwd = process.cwd();
afterEach(() => { process.chdir(originalCwd); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const fork = 'c'.repeat(40);

function fixture(outcome: 'pass' | 'conflict' | 'fail', selectedFiles = 1) {
  const root = mkdtempSync(join(tmpdir(), 'shadow-queue-test-'));
  roots.push(root);
  process.chdir(root);
  const calls: string[] = [];
  const observed: L8ShadowVerdict[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  let testRuns = 0;
  let fetchedMain = base;
  const deps: L8ShadowQueueDeps = {
    acquire: async () => () => {},
    observe: (verdict) => { observed.push(verdict); },
    command: (bin, args, cwd) => {
      calls.push(`${bin} ${args.join(' ')}`);
      const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      if (bin === 'gh') return ok(JSON.stringify({ headRefOid: args[2] === '8' ? 'd'.repeat(40) : head, baseRefName: 'main', state: 'OPEN', isDraft: false, isCrossRepository: false }));
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return ok(root);
      if (args[0] === 'fetch') { fetchedMain = args.includes('refs/pull/7/head') ? head : base; return ok(); }
      if (args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') return ok(fetchedMain);
      if (args[0] === 'rev-parse') return ok(base);
      if (args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(join(args[3]!, 'src'), { recursive: true });
        writeFileSync(join(args[3]!, 'src', 'changed.test.ts'), 'test("ok", () => {});\n');
        if (selectedFiles > 1) writeFileSync(join(args[3]!, 'src', 'another.test.ts'), 'test("ok", () => {});\n');
        return ok();
      }
      if (args[0] === 'merge-base') return ok(fork);
      if (args[0] === 'diff' && args.includes('-z')) return ok(`${selectedFiles > 1 ? 'src/another.test.ts\0' : ''}src/changed.test.ts\0src/other.ts\0`);
      if (args[0] === 'diff') return ok('src/changed.test.ts\n');
      if (args.includes('merge')) return outcome === 'conflict' ? { status: 1, stdout: '', stderr: 'merge conflict' } : ok();
      if (bin === 'bun' && args[0] === 'install') return ok();
      if (bin === 'bun' && args[0] === 'run') {
        testRuns++;
        return outcome === 'fail'
          ? { status: 1, stdout: '0 pass\n1 fail\nRan 1 test across 1 file', stderr: 'test failed' }
          : ok('1 pass\n0 fail\nRan 1 test across 1 file');
      }
      if (args[0] === 'worktree' && args[1] === 'remove') return ok();
      throw new Error(`unexpected command: ${bin} ${args.join(' ')} ${cwd}`);
    },
  };
  const makeProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerPrCommands(program, { out: { log: (text) => output.push(text), error: (text) => errors.push(text) } }, deps);
    return program;
  };
  const cli = async (...args: string[]) => makeProgram().parseAsync(['node', 'elanous', 'pr', 'queue', ...args]);
  return { root, calls, observed, output, errors, cli, deps, get testRuns() { return testRuns; } };
}

for (const outcome of ['pass', 'conflict', 'fail'] as const) {
  test(`enqueue → run --shadow records ${outcome} without landing a PR`, async () => {
    const f = fixture(outcome);
    await f.cli('enqueue', '7');
    expect(JSON.parse(f.output.at(-1)!).pending).toEqual([{ number: 7, head }]);
    await f.cli('status');
    expect(JSON.parse(f.output.at(-1)!).pending).toHaveLength(1);
    await f.cli('run', '--shadow');
    const verdict = JSON.parse(f.output.at(-1)!) as L8ShadowVerdict;
    expect(verdict).toMatchObject({ number: 7, head, base, verdict: outcome, tests: ['src/changed.test.ts'] });
    expect(f.observed).toEqual([verdict]);
    expect(JSON.parse(readFileSync(join(f.root, 'elanous-l8-shadow-queue.json'), 'utf8'))).toMatchObject({ pending: [], verdicts: [verdict] });
    expect(f.calls.some((call) => /git push|gh pr merge|git update-ref/.test(call))).toBe(false);
    expect(f.calls.some((call) => call.startsWith('git worktree remove --force '))).toBe(true);
    expect(f.calls).toContain(`git fetch origin refs/heads/main`);
    expect(f.calls.some((call) => call.startsWith('git worktree add --detach ') && call.endsWith(` ${base}`))).toBe(true);
    expect(f.calls.filter((call) => call.startsWith('bun run'))).toEqual(outcome === 'conflict' ? [] : ['bun run test:deterministic src/changed.test.ts']);
    expect(f.testRuns).toBe(outcome === 'conflict' ? 0 : 1);
    expect(f.errors).toEqual([]);
    await f.cli('status');
    expect(JSON.parse(f.output.at(-1)!).verdicts).toEqual([verdict]);
  });
}

test('run evaluates only the pinned front PR and leaves later PRs pending', async () => {
  const f = fixture('pass');
  await f.cli('enqueue', '7');
  await f.cli('enqueue', '8');
  await f.cli('run', '--shadow');
  await f.cli('status');
  const state = JSON.parse(f.output.at(-1)!);
  expect(state.pending).toEqual([{ number: 8, head: 'd'.repeat(40) }]);
  expect(state.verdicts).toMatchObject([{ number: 7, verdict: 'pass' }]);
  expect(f.observed).toHaveLength(1);
  expect(f.calls.some((call) => /git push|gh pr merge|git update-ref/.test(call))).toBe(false);
});

test('an injected observer persists merge-queue/shadow-verdict in a real store', async () => {
  const f = fixture('pass');
  await f.cli('enqueue', '7');
  const store = new LogStore(join(f.root, 'observations.db'), { instance: 'test' });
  const verdict = await runL8ShadowQueue(f.root, {
    command: f.deps.command, acquire: f.deps.acquire,
    observe: (entry) => store.insertBatch([{ rec: { ts: entry.at, category: 'merge-queue', event: 'shadow-verdict', data: entry }, surface: 'merge-queue' }]),
  });
  expect(verdict?.verdict).toBe('pass');
  expect(store.query({ categories: ['merge-queue'], limit: 10 })).toMatchObject([{ category: 'merge-queue', event: 'shadow-verdict' }]);
  store.close();
});

test('a failing observation remains pending and is retried before completing the ledger', async () => {
  const f = fixture('pass');
  await f.cli('enqueue', '7');
  await expect(runL8ShadowQueue(f.root, { ...f.deps, observe: () => { throw new Error('sink unavailable'); } })).rejects.toThrow('sink unavailable');
  expect(JSON.parse(readFileSync(join(f.root, 'elanous-l8-shadow-queue.json'), 'utf8'))).toMatchObject({ pending: [{ number: 7, head }], verdicts: [] });
  const verdict = await runL8ShadowQueue(f.root, f.deps);
  expect(verdict?.verdict).toBe('pass');
  expect(f.observed).toEqual([verdict!]);
  expect(JSON.parse(readFileSync(join(f.root, 'elanous-l8-shadow-queue.json'), 'utf8'))).toMatchObject({ pending: [], verdicts: [verdict] });
  expect(f.calls.some((call) => /git push|gh pr merge|git update-ref/.test(call))).toBe(false);
});

for (const failedCommand of ['gh pr view', 'git fetch'] as const) {
  test(`${failedCommand} infrastructure outage retains the front PR without a false failure verdict`, async () => {
    const f = fixture('pass');
    await f.cli('enqueue', '7');
    const realCommand = f.deps.command!;
    const blocked = { ...f.deps, command: (bin: string, args: readonly string[], cwd: string) =>
      `${bin} ${args.join(' ')}`.startsWith(failedCommand)
        ? { status: 1, stdout: '', stderr: 'infrastructure unavailable' }
        : realCommand(bin, args, cwd) };
    await expect(runL8ShadowQueue(f.root, blocked)).rejects.toThrow('infrastructure unavailable');
    expect(JSON.parse(readFileSync(join(f.root, 'elanous-l8-shadow-queue.json'), 'utf8'))).toMatchObject({ pending: [{ number: 7, head }], verdicts: [] });
    expect(f.observed).toEqual([]);
    expect((await runL8ShadowQueue(f.root, f.deps))?.verdict).toBe('pass');
    expect(f.calls.some((call) => /git push|gh pr merge|git update-ref/.test(call))).toBe(false);
  });
}

test('an unmeasured test runner does not record a failing test verdict', async () => {
  const f = fixture('pass');
  await f.cli('enqueue', '7');
  const realCommand = f.deps.command!;
  await expect(runL8ShadowQueue(f.root, { ...f.deps, command: (bin, args, cwd) =>
    bin === 'bun' && args[0] === 'run'
      ? { status: 1, stdout: '0 pass\n0 fail\nRan 0 tests across 1 file', stderr: 'runner unavailable' }
      : realCommand(bin, args, cwd) })).rejects.toThrow('changed tests unmeasured');
  expect(JSON.parse(readFileSync(join(f.root, 'elanous-l8-shadow-queue.json'), 'utf8'))).toMatchObject({ pending: [{ number: 7, head }], verdicts: [] });
  expect(f.observed).toEqual([]);
  expect((await runL8ShadowQueue(f.root, f.deps))?.verdict).toBe('pass');
});

test('partial test-file coverage retains the queued PR without a pass verdict', async () => {
  const f = fixture('pass', 2);
  await f.cli('enqueue', '7');
  await expect(runL8ShadowQueue(f.root, f.deps)).rejects.toThrow('changed tests unmeasured');
  expect(f.calls).toContain('bun run test:deterministic src/another.test.ts src/changed.test.ts');
  expect(f.observed).toEqual([]);
  expect(JSON.parse(readFileSync(join(f.root, 'elanous-l8-shadow-queue.json'), 'utf8'))).toMatchObject({ pending: [{ number: 7, head }], verdicts: [] });
  expect(f.calls.some((call) => /git push|gh pr merge|git update-ref/.test(call))).toBe(false);
});

test('all selected test files measured permits the shadow pass verdict', async () => {
  const f = fixture('pass', 2);
  await f.cli('enqueue', '7');
  const command = f.deps.command!;
  const verdict = await runL8ShadowQueue(f.root, { ...f.deps, command: (bin, args, cwd) =>
    bin === 'bun' && args[0] === 'run'
      ? { status: 0, stdout: '2 pass\n0 fail\nRan 2 tests across 2 files', stderr: '' }
      : command(bin, args, cwd) });
  expect(verdict).toMatchObject({ verdict: 'pass', tests: ['src/another.test.ts', 'src/changed.test.ts'] });
  expect(f.observed).toEqual([verdict!]);
  expect(f.calls.some((call) => /git push|gh pr merge|git update-ref/.test(call))).toBe(false);
});

test('async observation rejection leaves the verdict incomplete until retry', async () => {
  const f = fixture('conflict');
  await f.cli('enqueue', '7');
  await expect(runL8ShadowQueue(f.root, { ...f.deps, observe: async () => { throw new Error('delivery rejected'); } })).rejects.toThrow('delivery rejected');
  expect(JSON.parse(readFileSync(join(f.root, 'elanous-l8-shadow-queue.json'), 'utf8'))).toMatchObject({ pending: [{ number: 7, head }], verdicts: [] });
  expect((await runL8ShadowQueue(f.root, f.deps))?.verdict).toBe('conflict');
  expect(f.observed).toHaveLength(1);
});

test('observation store unavailable retains the queued PR for retry', async () => {
  const f = fixture('pass');
  await f.cli('enqueue', '7');
  await expect(runL8ShadowQueue(f.root, { command: f.deps.command, acquire: f.deps.acquire })).rejects.toThrow('merge-queue observation store unavailable');
  expect(JSON.parse(readFileSync(join(f.root, 'elanous-l8-shadow-queue.json'), 'utf8'))).toMatchObject({ pending: [{ number: 7, head }], verdicts: [] });
  expect((await runL8ShadowQueue(f.root, f.deps))?.verdict).toBe('pass');
});

test('queue run requires --shadow and never falls through to the live merge executor', async () => {
  const f = fixture('pass');
  await f.cli('enqueue', '#7');
  await expect(f.cli('run')).rejects.toThrow();
  expect(f.calls.some((call) => call.includes('worktree add') || /git push|gh pr merge|git update-ref/.test(call))).toBe(false);
});
