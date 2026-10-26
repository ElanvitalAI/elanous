import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { runSelfGateCli, selectGateTestFiles, type SelfGateCliOptions, type SelfGateCliResult } from '../self-implement/gate-cli.js';
import { GATE_CALLER_TEST_LIMIT } from '../self-implement/gate-scope.js';
import { GATE_REMOTE_DEFAULTS, type DispatchDeps, type DispatchOptions, type GateRemoteRunner } from '../self-implement/gate-remote.js';
import { registerReleaseCommands } from '../cli/release-cli.js';
import { LIGHT_RC_ALWAYS_FILE, LIGHT_RC_UNKNOWN_HOST, formatLightRc, parseAlwaysIncludeList, resolveMeasuredCommit, runLightRc, type LightRcDeps } from './light-rc.js';

const REPO = resolve(import.meta.dir, '../..');
const dirs: string[] = [];
function tempRepo(files: Record<string, string> = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), 'elanous-light-rc-'));
  dirs.push(cwd);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(cwd, path), content);
  return cwd;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

/** Gate deps that never touch git, the network or a real gate: nothing changed, every side gate passes. */
function quietGateDeps(runTests: (files: readonly string[]) => { status: number; stdout: string; stderr: string }) {
  const ran: string[][] = [];
  return {
    ran,
    deps: {
      changedFiles: () => ({ files: [], baseRef: 'base-sha' }),
      runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
      runTests: (_cwd: string, files: readonly string[]) => { ran.push([...files]); return runTests(files); },
      runBaseline: () => ({ status: 'pass' as const, output: 'a.test.ts:\n(pass) works\n1 pass\n', log: 'baseline' }),
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
      runIsolationGate: () => 0, runMockModuleRestoreGate: () => 0, runModelHardcodeGate: () => 0, runDaemonPortGate: () => 0,
    },
  };
}

describe('self gate alwaysInclude (LIGHT-RC ⑴)', () => {
  test('① zero changed files ⊕ an existing always-include path runs it; a missing one is reported, not dropped', () => {
    const cwd = tempRepo({ 'a.test.ts': 'test("x", () => {});\n' });
    const { ran, deps } = quietGateDeps(() => ({ status: 0, stdout: '1 pass\n', stderr: '' }));
    const options = { base: 'base-sha', alwaysInclude: ['a.test.ts', 'b.test.ts', './a.test.ts'] };
    const preflight = selectGateTestFiles(cwd, options, deps);
    const result = runSelfGateCli(cwd, options, deps);
    expect(ran).toEqual([['a.test.ts']]);
    expect(result.testFiles).toEqual(['a.test.ts']);
    expect(result.alwaysIncludeMissing).toEqual(['b.test.ts']);
    expect(preflight.testFiles).toEqual(result.testFiles);
    expect(preflight.alwaysIncludeMissing).toEqual([...result.alwaysIncludeMissing]);
    expect(preflight.skipTestStep).toBe(false);
    expect(result.baseline).toEqual({ introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0 });
    expect(result.lines.some((line) => line.startsWith('always include: 1/2 (added 1 · missing: b.test.ts)'))).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test('① an always-include failure goes through the same baseline split (new at HEAD ⇒ introduced)', () => {
    const cwd = tempRepo({ 'a.test.ts': 'test("x", () => {});\n' });
    const { deps } = quietGateDeps(() => ({ status: 1, stdout: 'a.test.ts:\n(fail) works\n1 fail\n', stderr: '' }));
    const result = runSelfGateCli(cwd, { base: 'base-sha', alwaysInclude: ['a.test.ts'] }, deps);
    expect(result.baseline?.introduced).toBe(1);
    expect(result.exitCode).toBe(1);
  });

  test('① the default 4-shard path also runs the always-include paths, and an unmeasured shard run leaves no baseline', () => {
    const cwd = tempRepo({ 'a.test.ts': 'test("x", () => {});\n' });
    const { deps } = quietGateDeps(() => { throw new Error('unsharded runner must not run'); });
    const seen: Array<{ files: string[]; count: number }> = [];
    const result = runSelfGateCli(cwd, { base: 'base-sha', shards: 4, alwaysInclude: ['a.test.ts'] }, {
      ...deps,
      runShards: (_cwd, files, _ref, count) => {
        seen.push({ files: [...files], count: count ?? 0 });
        return { shards: [], attempts: [], aggregate: { status: 'unmeasured', retryShardIds: ['shard-1'] } };
      },
    });
    expect(seen).toEqual([{ files: ['a.test.ts'], count: 4 }]);
    expect(result.testFiles).toEqual(['a.test.ts']);
    expect(result.baseline).toBeUndefined();
  });

  test('② without alwaysInclude the test list and output are what they were (no step, no extra line)', () => {
    const cwd = tempRepo({ 'a.test.ts': 'test("x", () => {});\n' });
    const { ran, deps } = quietGateDeps(() => ({ status: 0, stdout: '', stderr: '' }));
    const result = runSelfGateCli(cwd, { base: 'base-sha' }, deps);
    expect(ran).toEqual([]);
    expect(result.testFiles).toEqual([]);
    expect(result.alwaysIncludeMissing).toEqual([]);
    expect(result.lines.some((line) => line.startsWith('always include'))).toBe(false);
  });
});

describe('release/light-rc-always.txt (LIGHT-RC ⑵)', () => {
  test('parses one path per line with # comments', () => {
    expect(parseAlwaysIncludeList('# head\na.test.ts\n\n  b.test.ts  # why\na.test.ts\n')).toEqual(['a.test.ts', 'b.test.ts']);
  });
});

function gateResult(over: Partial<SelfGateCliResult> = {}): SelfGateCliResult {
  return {
    exitCode: 0, lines: ['[self gate] fake'], changedFiles: [], testFiles: [], unverified: [], documentPaths: [],
    documentsWithoutDerivedTests: [], alwaysIncludeMissing: [], baseline: { introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0 }, ...over,
  };
}

const MAIN_SHA = 'c'.repeat(40);
/** Fake git: rev-parse (HEAD and origin/main alike) answers MAIN_SHA — the tree is at the measured commit. */
const fakeGit = (args: string[]) => ({ rc: 0, stdout: args[0] === 'rev-parse' ? `${MAIN_SHA}\n` : 'abc123\n' });

function localDeps(over: Partial<LightRcDeps> = {}, gate: SelfGateCliResult = gateResult()) {
  const calls: SelfGateCliOptions[] = [];
  const dispatched: DispatchOptions[] = [];
  const deps: LightRcDeps = {
    cwd: REPO,
    git: fakeGit,
    previousVersion: () => '0.2.18',
    runGate: (_cwd, options) => { calls.push(options); return gate; },
    dispatch: async (opts: DispatchOptions) => { dispatched.push(opts); return opts.runLocal(); },
    ...over,
  };
  return { calls, dispatched, deps };
}

describe('runLightRc (LIGHT-RC ⑶)', () => {
  test('rehearsal opt-in invokes screen check on measured commit and blocks failed or unmeasured screens', async () => {
    const seen: string[] = [];
    const { deps } = localDeps({ tuiCheck: async (commit) => { seen.push(commit); return { outcome: 'fail', detail: 'help-closes failed' }; } });
    const normal = await runLightRc('0.2.19', { base: 'abc123', head: MAIN_SHA, log: () => {} }, deps);
    expect(normal.ok).toBe(true);
    expect(seen).toEqual([]);
    const rehearsal = await runLightRc('0.2.19', { base: 'abc123', head: MAIN_SHA, rehearsalTui: true, log: () => {} }, deps);
    expect(seen).toEqual([MAIN_SHA]);
    expect(rehearsal).toMatchObject({ ok: false, rehearsalTui: { outcome: 'fail' }, unmeasured: null });
    expect(formatLightRc(rehearsal)).toContain('  TUI screens: fail (help-closes failed)');
  });

  test('rehearsal TUI runs in the measured checkout before cleanup', async () => {
    const seen: string[] = [];
    const { deps } = localDeps({
      git: (args) => ({ rc: 0, stdout: args.includes('HEAD') ? 'b'.repeat(40) + '\n' : MAIN_SHA + '\n' }),
      checkout: () => ({ dir: '/measured/tree', cleanup: () => { seen.push('cleanup'); } }),
      readFile: () => 'src/cli/a.test.ts\n',
      tuiCheck: async (_commit, tree) => {
        seen.push(tree);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        seen.push('checked');
        return { outcome: 'ok', detail: '6 screens' };
      },
    });
    const result = await runLightRc('0.2.25', { base: 'abc123', head: MAIN_SHA, rehearsalTui: true, local: true, log: () => {} }, deps);
    expect(seen).toEqual(['/measured/tree', 'checked', 'cleanup']);
    expect(result.rehearsalTui?.outcome).toBe('ok');
  });

  test('--fixed-shard-distribution is forwarded to self gate and the remote child only when opted in', async () => {
    const plain = localDeps();
    await runLightRc('0.2.19', { base: 'abc123', head: MAIN_SHA, shards: 16, log: () => {} }, plain.deps);
    expect(plain.calls[0]).not.toHaveProperty('fixedShardDistribution');
    expect(plain.calls[0]).toMatchObject({ base: 'abc123', shards: 16 });
    const plainArgv = (plain.dispatched[0]!.remoteArgv as (sha: (ref: string) => string) => string[])((sha) => sha);
    expect(plainArgv).not.toContain('--fixed-shard-distribution');
    const fixed = localDeps();
    await runLightRc('0.2.19', { base: 'abc123', head: MAIN_SHA, shards: 16, fixedShardDistribution: true, log: () => {} }, fixed.deps);
    expect(fixed.calls[0]).toMatchObject({ base: 'abc123', shards: 16, fixedShardDistribution: true });
    const fixedArgv = (fixed.dispatched[0]!.remoteArgv as (sha: (ref: string) => string) => string[])((sha) => sha);
    expect(fixedArgv.slice(fixedArgv.indexOf('--shards'), fixedArgv.indexOf('--shards') + 3)).toEqual(['--shards', '16', '--fixed-shard-distribution']);
  });

  test('shard concurrency is bounded and forwarded to local and remote gate', async () => {
    const setup = localDeps();
    await runLightRc('0.2.19', { base: 'abc123', head: MAIN_SHA, shards: 4, shardConcurrency: 2, log: () => {} }, setup.deps);
    expect(setup.calls[0]).toMatchObject({ shards: 4, shardConcurrency: 2 });
    const argv = (setup.dispatched[0]!.remoteArgv as (sha: (ref: string) => string) => string[])((sha) => sha);
    expect(argv.slice(argv.indexOf('--shard-concurrency'), argv.indexOf('--shard-concurrency') + 2))
      .toEqual(['--shard-concurrency', '2']);
    await expect(runLightRc('0.2.19', { base: 'abc123', head: MAIN_SHA, shardConcurrency: 5, log: () => {} }, setup.deps))
      .rejects.toThrow('invalid --shard-concurrency');
  });

  test('remote rehearsal carries opt-in to child and refuses a missing screen result', async () => {
    let remoteArgv: string[] = [];
    const { deps } = localDeps({ dispatch: async (opts, channels) => {
      remoteArgv = typeof opts.remoteArgv === 'function' ? opts.remoteArgv((sha: string) => sha) : opts.remoteArgv;
      channels?.write?.out(Buffer.from(JSON.stringify({ introduced: 0, unclassified: 0, gateExitCode: 0 }) + '\n'));
      return 0;
    } });
    const result = await runLightRc('0.2.19', { base: 'abc123', head: MAIN_SHA, rehearsalTui: true, log: () => {} }, deps);
    expect(remoteArgv).toContain('--rehearsal-tui');
    expect(result).toMatchObject({ ok: false, rehearsalTui: { outcome: 'unmeasured' } });
    const { deps: invalidDeps } = localDeps({ dispatch: async (_opts, channels) => {
      channels?.write?.out(Buffer.from(JSON.stringify({ introduced: 0, unclassified: 0, gateExitCode: 0, rehearsalTui: { outcome: 'ok' } }) + '\n'));
      return 0;
    } });
    expect(await runLightRc('0.2.19', { base: 'abc123', head: MAIN_SHA, rehearsalTui: true, log: () => {} }, invalidDeps)).toMatchObject({
      ok: false, rehearsalTui: { outcome: 'unmeasured', detail: 'remote TUI screen result missing' },
    });
  });
  test('remote rehearsal never turns an unmeasured shard green when screens pass', async () => {
    const { deps } = localDeps({ dispatch: async (_opts, channels) => {
      channels?.write?.out(Buffer.from(JSON.stringify({
        introduced: 0, unclassified: 0, unmeasured: 'shard-2', gateExitCode: 1,
        rehearsalTui: { outcome: 'ok', detail: '6 screens' },
      }) + '\n'));
      return 1;
    } });
    const result = await runLightRc('0.2.19', { base: 'abc123', head: MAIN_SHA, rehearsalTui: true, log: () => {} }, deps);
    expect(result).toMatchObject({ ok: false, unmeasured: 'shard-2', rehearsalTui: { outcome: 'ok' } });
  });
  test('③ no --base: merge-base of the previous cut is the base · shards 4 · the seven always-include paths · one gate call', async () => {
    const gitCalls: string[][] = [];
    const { calls, dispatched, deps } = localDeps({ git: (args) => { gitCalls.push(args); return fakeGit(args); } });
    const result = await runLightRc('0.2.19', { log: () => {} }, deps);
    expect(gitCalls).toEqual([
      ['fetch', '--quiet', 'origin', 'main'], ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'], ['rev-parse', 'HEAD'],
      ['merge-base', 'origin/main', 'origin/release/0.2.18'],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.base).toBe('abc123');
    expect(calls[0]!.shards).toBe(4);
    expect(calls[0]!.alwaysInclude).toHaveLength(7);
    expect(calls[0]!.alwaysInclude).toContain('scripts/discord-seat-probe.test.ts');
    expect(calls[0]!.alwaysInclude).toContain('scripts/ratchets/test-interference-patterns.test.ts');
    expect(dispatched[0]!.flags).toEqual({ remote: true, local: false });
    expect(dispatched[0]!.tool).toBe('self-gate');
    expect(result).toMatchObject({ version: '0.2.19', base: 'abc123', introduced: 0, preexisting: 0, alwaysInclude: 7, alwaysIncludeMissing: [], ok: true, remote: null });
  });

  test('③ every listed always-include path exists in this tree', () => {
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
    const paths = parseAlwaysIncludeList(readFileSync(join(REPO, LIGHT_RC_ALWAYS_FILE), 'utf8'));
    expect(paths.filter((path) => !existsSync(join(REPO, path)))).toEqual([]);
  });

  test('④ no previous published version ⇒ «--base 로 준다»', async () => {
    const { deps } = localDeps({ previousVersion: () => { throw new Error('no published previous release'); } });
    await expect(runLightRc('0.2.19', { log: () => {} }, deps)).rejects.toThrow('직전 판 컷을 못 찾았다 — --base 로 준다');
  });

  test('④ previous release branch missing ⇒ the same error', async () => {
    const { deps } = localDeps({ git: (args) => args[0] === 'merge-base' ? { rc: 1, stdout: '' } : fakeGit(args) });
    await expect(runLightRc('0.2.19', { log: () => {} }, deps)).rejects.toThrow('--base 로 준다');
  });

  test('an explicit --base skips the ledger and git lookup', async () => {
    const { calls, deps } = localDeps({ previousVersion: () => { throw new Error('must not read'); }, git: (args) => { if (args[0] === 'merge-base') throw new Error('must not run'); return fakeGit(args); } });
    await runLightRc('0.2.19', { base: 'deadbeef', shards: 2, log: () => {} }, deps);
    expect(calls[0]).toMatchObject({ base: 'deadbeef', shards: 2 });
  });

  test('remote run: the host re-runs light-rc --local --json at the base sha and its JSON is the result', async () => {
    let argv: string[] = [];
    const { calls, deps } = localDeps({
      dispatch: async (opts: DispatchOptions, dispatchDeps?: DispatchDeps) => {
        argv = typeof opts.remoteArgv === 'function' ? opts.remoteArgv(() => 'f'.repeat(40)) : opts.remoteArgv;
        dispatchDeps!.write!.out('{"ok":false,"introduced":2,"preexisting":3,"alwaysIncludeMissing":["x.test.ts"],"gateExitCode":1,"remote":null,"host":"node-b","remote":true}\n');
        return 1;
      },
    });
    const result = await runLightRc('0.2.19', { base: 'abc123', remote: 'node-b', log: () => {} }, deps);
    expect(calls).toHaveLength(0);
    expect(argv).toEqual(['bun', 'bin/elanous.mjs', 'release', 'light-rc', '--version', '0.2.19', '--base', 'f'.repeat(40), '--head', MAIN_SHA, '--shards', '4', '--local', '--json']);
    expect(result).toMatchObject({ introduced: 2, preexisting: 3, alwaysIncludeMissing: ['x.test.ts'], remote: 'node-b', ok: false });
  });

  test('default host through the real dispatch: the result names the host the gate ran on, not local', async () => {
    const sha = 'a'.repeat(40);
    let script = '';
    const localCalls: string[][] = [];
    const runner: GateRemoteRunner = {
      local: (_cmd, args) => {
        localCalls.push(args);
        return args[0] === 'rev-parse' ? { rc: 0, stdout: `${sha}\n`, stderr: '' }
          : args[0] === 'cat-file' ? { rc: 0, stdout: 'commit\n', stderr: '' } : { rc: 0, stdout: '', stderr: '' };
      },
      ssh: (_host, body) => {
        script = body;
        // The child prints its own result (remote: null — it ran locally on the host); the dispatch adds host · remote:true.
        return { rc: 0, stdout: '{"ok":true,"introduced":0,"preexisting":1,"unclassified":0,"alwaysIncludeMissing":[],"gateExitCode":0,"remote":null}\n', stderr: '\n__GATE_REMOTE_RC=0\n' };
      },
    };
    const { calls, deps } = localDeps({ dispatch: undefined, dispatchDeps: { runner, settings: { ...GATE_REMOTE_DEFAULTS, host: 'gatehost' }, load1: 0, env: {} } });
    const result = await runLightRc('0.2.19', { base: sha, log: () => {} }, deps);
    expect(calls).toHaveLength(0);
    expect(script).toContain("'release' 'light-rc' '--version' '0.2.19'");
    // ① the measured commit (origin/main), not the tree's HEAD, is what goes to the host and what the child measures.
    expect(localCalls).toContainEqual(['cat-file', '-t', MAIN_SHA]);
    expect(localCalls.some((args) => args[0] === 'push' && args.includes(`${MAIN_SHA}:refs/elanous/gate/${MAIN_SHA}`))).toBe(true);
    expect(script).toContain(`'--head' '${MAIN_SHA}'`);
    expect(result.measuredCommit).toBe(MAIN_SHA);
    expect(result).toMatchObject({ remote: 'gatehost', introduced: 0, preexisting: 1, ok: true });
  });

  test('a remote result without a host is shown as unknown, never as local', async () => {
    const { deps } = localDeps({
      dispatch: async (_opts: DispatchOptions, dispatchDeps?: DispatchDeps) => {
        dispatchDeps!.write!.out('{"introduced":0,"preexisting":0,"unclassified":0,"alwaysIncludeMissing":[],"gateExitCode":0}\n');
        return 0;
      },
    });
    const result = await runLightRc('0.2.19', { base: 'abc123', log: () => {} }, deps);
    expect(result.remote).toBe(LIGHT_RC_UNKNOWN_HOST);
  });

  test('unclassified failures (unknown / precondition-unmet) are not green even with introduced 0', async () => {
    const { deps } = localDeps({}, gateResult({ exitCode: 1, baseline: { introduced: 0, preexisting: 0, unknown: 1, preconditionUnmet: 1 } }));
    const result = await runLightRc('0.2.19', { base: 'abc123', log: () => {} }, deps);
    expect(result).toMatchObject({ introduced: 0, unclassified: 2, ok: false });
  });

  test('an unmeasured gate (no baseline) is not green', async () => {
    const { deps } = localDeps({}, gateResult({ exitCode: 1, baseline: undefined }));
    const result = await runLightRc('0.2.19', { base: 'abc123', log: () => {} }, deps);
    expect(result.introduced).toBeNull();
    expect(result.ok).toBe(false);
  });
});

describe('release light-rc CLI (LIGHT-RC ⑷)', () => {
  async function runCli(gate: SelfGateCliResult, ...args: string[]): Promise<string[]> {
    const { deps } = localDeps({}, gate);
    const out: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write);
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = new Command();
      registerReleaseCommands(cmd, {}, {}, {}, deps);
      await cmd.parseAsync(['release', 'light-rc', '--version', '0.2.19', '--base', 'abc123', ...args], { from: 'user' });
    } finally { write.mockRestore(); err.mockRestore(); log.mockRestore(); }
    return out;
  }

  test('⑤ introduced 1 ⇒ exit 1 · --json is one line', async () => {
    const out = await runCli(gateResult({ exitCode: 1, baseline: { introduced: 1, preexisting: 0, unknown: 0, preconditionUnmet: 0 } }), '--json');
    expect(process.exitCode).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]!.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, introduced: 1, version: '0.2.19', base: 'abc123' });
  });

  test('⑤ introduced 0 ⇒ exit 0', async () => {
    const out = await runCli(gateResult({ baseline: { introduced: 0, preexisting: 4, unknown: 0, preconditionUnmet: 0 } }), '--json');
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, introduced: 0, preexisting: 4 });
  });
});

describe('RELEASE-DAILY-LIGHT-RC ① — light-rc measures origin/main, not the tree it started in', () => {
  const SEAT_HEAD = 'e'.repeat(40);
  const seatGit = (calls: string[][] = []) => (args: string[]) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { rc: 0, stdout: `${args[1] === 'HEAD' ? SEAT_HEAD : MAIN_SHA}\n` };
    return { rc: 0, stdout: 'abc123\n' };
  };

  test('a tree whose HEAD is not origin/main runs the gate in a detached checkout of origin/main · says so · cleans up', async () => {
    const checkouts: string[] = [];
    let cleaned = 0;
    const gateDirs: string[] = [];
    const lines: string[] = [];
    const { calls, deps } = localDeps({
      git: seatGit(),
      checkout: (sha) => { checkouts.push(sha); return { dir: REPO, cleanup: () => { cleaned += 1; } }; },
      runGate: (cwd, options) => { gateDirs.push(cwd); calls.push(options); return gateResult(); },
    });
    const result = await runLightRc('0.2.25', { base: 'abc123', local: true, log: (line) => lines.push(line) }, deps);
    expect(checkouts).toEqual([MAIN_SHA]);
    expect(cleaned).toBe(1);
    expect(gateDirs).toEqual([REPO]);
    expect(result).toMatchObject({ measuredCommit: MAIN_SHA, worktreeHead: SEAT_HEAD });
    expect(lines.some((line) => line.startsWith(`ⓘ light-rc measures ${MAIN_SHA.slice(0, 12)} (origin/main)`) && line.includes(SEAT_HEAD.slice(0, 12)))).toBe(true);
  });

  test('a tree already at origin/main measures in place — no checkout, no differs line', async () => {
    const lines: string[] = [];
    const { deps } = localDeps({ checkout: () => { throw new Error('must not check out'); } });
    const result = await runLightRc('0.2.25', { base: 'abc123', local: true, log: (line) => lines.push(line) }, deps);
    expect(result).toMatchObject({ measuredCommit: MAIN_SHA, worktreeHead: MAIN_SHA });
    expect(lines.some((line) => line.startsWith('ⓘ light-rc measures'))).toBe(false);
  });

  test('the checkout is removed even when the gate throws', async () => {
    let cleaned = 0;
    const { deps } = localDeps({
      git: seatGit(),
      checkout: () => ({ dir: REPO, cleanup: () => { cleaned += 1; } }),
      runGate: () => { throw new Error('gate exploded'); },
    });
    await expect(runLightRc('0.2.25', { base: 'abc123', local: true, log: () => {} }, deps)).rejects.toThrow('gate exploded');
    expect(cleaned).toBe(1);
  });

  test('an explicit --head is measured as given (no fetch) · a failed fetch is said and the local origin/main measured', () => {
    const calls: string[][] = [];
    expect(resolveMeasuredCommit(REPO, MAIN_SHA, { git: seatGit(calls) }, () => {}).measuredCommit).toBe(MAIN_SHA);
    expect(calls.some((args) => args[0] === 'fetch')).toBe(false);
    const lines: string[] = [];
    const failing = (args: string[]) => args[0] === 'fetch' ? { rc: 128, stdout: '' } : seatGit()(args);
    expect(resolveMeasuredCommit(REPO, undefined, { git: failing }, (line) => lines.push(line)).measuredCommit).toBe(MAIN_SHA);
    expect(lines.some((line) => line.includes('git fetch origin main rc=128'))).toBe(true);
  });

  test('an unresolvable head is an error, never a silent fall back to the tree HEAD', () => {
    const git = (args: string[]) => args[0] === 'rev-parse' && args[1] !== 'HEAD' ? { rc: 1, stdout: '' } : seatGit()(args);
    expect(() => resolveMeasuredCommit(REPO, 'nope', { git }, () => {})).toThrow('cannot resolve nope');
  });

  test('the local gate is asked for importer tests (②)', async () => {
    const { calls, deps } = localDeps();
    await runLightRc('0.2.25', { base: 'abc123', local: true, log: () => {} }, deps);
    expect(calls[0]!.includeImporterTests).toBe(true);
  });
});

describe('RELEASE-DAILY-LIGHT-RC ② — self gate includeImporterTests lifts the caller cap for importers', () => {
  // The plain self gate runs at most GATE_CALLER_TEST_LIMIT caller tests; a day of landings changes many sources, so the
  // rest (overflow) were only reported — 0.2.24 shipped 20 regressions from source-only changes.
  const N = GATE_CALLER_TEST_LIMIT + 5;
  const users = Array.from({ length: N }, (_, i) => `src/u${String(i).padStart(2, '0')}.test.ts`);
  function importerRepo(): string {
    const cwd = tempRepo();
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/x.ts'), 'export const x = 1;\n');
    for (const user of users) writeFileSync(join(cwd, user), "import { x } from './x';\ntest('x', () => { x; });\n");
    return cwd;
  }
  function importerDeps() {
    const { ran, deps } = quietGateDeps(() => ({ status: 0, stdout: '1 pass\n', stderr: '' }));
    return {
      ran,
      deps: {
        ...deps,
        changedFiles: () => ({ files: ['src/x.ts'], baseRef: 'base-sha' }),
        runCommand: (_cmd: string, args: readonly string[]) => args[0] === 'grep' ? { status: 0, stdout: `${users.join('\n')}\n`, stderr: '' }
          : args[0] === 'ls-files' ? { status: 0, stdout: ['src/x.ts', ...users].join('\n'), stderr: '' } : { status: 0, stdout: '', stderr: '' },
      },
    };
  }

  test('a source-only change runs every test that imports it, past the caller cap (reason=changed-source-importer)', () => {
    const { ran, deps } = importerDeps();
    const result = runSelfGateCli(importerRepo(), { base: 'base-sha', includeImporterTests: true }, deps);
    expect(new Set(ran.flat())).toEqual(new Set(users));
    expect(result.importerTestsAdded).toHaveLength(5);
    expect(result.lines.some((line) => line.startsWith('importer tests added: 5 (reason=changed-source-importer · '))).toBe(true);
    expect(result.lines.some((line) => line.startsWith('unrun importer tests: 0;'))).toBe(true);
    expect(result.lines.some((line) => line.startsWith('⚠️ caller test cap exceeded'))).toBe(false);
  });

  test('without the option the plain self gate keeps its cap (overflow reported, not run · no added line)', () => {
    const { ran, deps } = importerDeps();
    const result = runSelfGateCli(importerRepo(), { base: 'base-sha' }, deps);
    expect(ran.flat()).toHaveLength(GATE_CALLER_TEST_LIMIT);
    expect(result.importerTestsAdded).toEqual([]);
    expect(result.lines.some((line) => line.startsWith('importer tests added'))).toBe(false);
    expect(result.lines.some((line) => line.startsWith('unrun importer tests: 5'))).toBe(true);
    expect(result.lines.some((line) => line.startsWith('⚠️ caller test cap exceeded'))).toBe(true);
  });
});
