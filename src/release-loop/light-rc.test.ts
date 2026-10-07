import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { runSelfGateCli, type SelfGateCliOptions, type SelfGateCliResult } from '../self-implement/gate-cli.js';
import { GATE_REMOTE_DEFAULTS, type DispatchDeps, type DispatchOptions, type GateRemoteRunner } from '../self-implement/gate-remote.js';
import { registerReleaseCommands } from '../cli/release-cli.js';
import { LIGHT_RC_ALWAYS_FILE, LIGHT_RC_UNKNOWN_HOST, parseAlwaysIncludeList, runLightRc, type LightRcDeps } from './light-rc.js';

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
    const result = runSelfGateCli(cwd, { base: 'base-sha', alwaysInclude: ['a.test.ts', 'b.test.ts', './a.test.ts'] }, deps);
    expect(ran).toEqual([['a.test.ts']]);
    expect(result.testFiles).toEqual(['a.test.ts']);
    expect(result.alwaysIncludeMissing).toEqual(['b.test.ts']);
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

function localDeps(over: Partial<LightRcDeps> = {}, gate: SelfGateCliResult = gateResult()) {
  const calls: SelfGateCliOptions[] = [];
  const dispatched: DispatchOptions[] = [];
  const deps: LightRcDeps = {
    cwd: REPO,
    git: () => ({ rc: 0, stdout: 'abc123\n' }),
    previousVersion: () => '0.2.18',
    runGate: (_cwd, options) => { calls.push(options); return gate; },
    dispatch: async (opts: DispatchOptions) => { dispatched.push(opts); return opts.runLocal(); },
    ...over,
  };
  return { calls, dispatched, deps };
}

describe('runLightRc (LIGHT-RC ⑶)', () => {
  test('③ no --base: merge-base of the previous cut is the base · shards 4 · the six always-include paths · one gate call', async () => {
    const gitCalls: string[][] = [];
    const { calls, dispatched, deps } = localDeps({ git: (args) => { gitCalls.push(args); return { rc: 0, stdout: 'abc123\n' }; } });
    const result = await runLightRc('0.2.19', { log: () => {} }, deps);
    expect(gitCalls).toEqual([['merge-base', 'origin/main', 'origin/release/0.2.18']]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.base).toBe('abc123');
    expect(calls[0]!.shards).toBe(4);
    expect(calls[0]!.alwaysInclude).toHaveLength(6);
    expect(calls[0]!.alwaysInclude).toContain('scripts/discord-seat-probe.test.ts');
    expect(dispatched[0]!.flags).toEqual({ remote: true, local: false });
    expect(result).toMatchObject({ version: '0.2.19', base: 'abc123', introduced: 0, preexisting: 0, alwaysInclude: 6, alwaysIncludeMissing: [], ok: true, remote: null });
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
    const { deps } = localDeps({ git: () => ({ rc: 1, stdout: '' }) });
    await expect(runLightRc('0.2.19', { log: () => {} }, deps)).rejects.toThrow('--base 로 준다');
  });

  test('an explicit --base skips the ledger and git lookup', async () => {
    const { calls, deps } = localDeps({ previousVersion: () => { throw new Error('must not read'); }, git: () => { throw new Error('must not run'); } });
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
    expect(argv).toEqual(['bun', 'bin/elanous.mjs', 'release', 'light-rc', '--version', '0.2.19', '--base', 'f'.repeat(40), '--shards', '4', '--local', '--json']);
    expect(result).toMatchObject({ introduced: 2, preexisting: 3, alwaysIncludeMissing: ['x.test.ts'], remote: 'node-b', ok: false });
  });

  test('default host through the real dispatch: the result names the host the gate ran on, not local', async () => {
    const sha = 'a'.repeat(40);
    let script = '';
    const runner: GateRemoteRunner = {
      local: (_cmd, args) => args[0] === 'rev-parse' ? { rc: 0, stdout: `${sha}\n`, stderr: '' } : { rc: 0, stdout: '', stderr: '' },
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
