import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  annotateJsonStdout, decideGateDispatch, dispatchHeavyCheck, extractGateRemoteFlags, GATE_REMOTE_DEFAULTS, relativizeArgs,
  hostSlotScript, isValidGateHost, looksLikeHost, outsideRepoArgs, unreproducibleArgs, remoteScript, resolveGateRemoteSettings, runOnRemote, type GateRemoteRunner, type SshResult,
} from './gate-remote.js';
import { parseGateRemoteConfig } from '../user-config.js';

const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const dirs: string[] = [];
const slotDir = () => { const d = mkdtempSync(join(tmpdir(), 'gate-remote-slots-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeRunner(opts: { dirty?: boolean; push?: number; ssh?: SshResult | (() => SshResult) } = {}): GateRemoteRunner & { calls: string[][]; scripts: string[] } {
  const calls: string[][] = [];
  const scripts: string[] = [];
  return {
    calls, scripts,
    local(cmd, args) {
      calls.push([cmd, ...args]);
      if (args[0] === 'status') return { rc: 0, stdout: opts.dirty ? ' M src/x.ts\n' : '', stderr: '' };
      if (args[0] === 'rev-parse') {
        const ref = args.at(-1)!;
        return { rc: 0, stdout: `${ref.startsWith('HEAD') ? HEAD : ref.startsWith('feature') ? 'c'.repeat(40) : MAIN}\n`, stderr: '' };
      }
      if (args[0] === 'push') return { rc: opts.push ?? 0, stdout: '', stderr: opts.push ? 'ssh: connect to host node-b port 22: Operation timed out' : '' };
      return { rc: 0, stdout: '', stderr: '' };
    },
    ssh(host, script) {
      calls.push(['ssh', host]);
      scripts.push(script);
      if (typeof opts.ssh === 'function') return opts.ssh();
      return opts.ssh ?? { rc: 0, stdout: '{"exportOnly":[],"preexisting":[],"notExported":[],"exportRan":3,"privateRan":3}\n', stderr: 'Ran 3 tests\nwarn: x\n\n__GATE_REMOTE_RC=0\n' };
    },
  };
}

const settings = { ...GATE_REMOTE_DEFAULTS, slotWaitSeconds: 0 };
const sink = () => { const out: string[] = []; const err: string[] = []; return { out, err, write: { out: (t: string | Uint8Array) => { out.push(typeof t === 'string' ? t : Buffer.from(t).toString()); }, err: (t: string | Uint8Array) => { err.push(typeof t === 'string' ? t : Buffer.from(t).toString()); } } }; };

describe('dispatch decision', () => {
  test('load above the threshold goes remote; at or below stays local', () => {
    expect(decideGateDispatch({ flags: { local: false }, settings, load1: 25, env: {} })).toMatchObject({ mode: 'remote', host: 'node-b' });
    expect(decideGateDispatch({ flags: { local: false }, settings, load1: 20, env: {} })).toMatchObject({ mode: 'local' });
  });
  test('--local always wins; config off stays local; explicit --remote overrides config off', () => {
    expect(decideGateDispatch({ flags: { local: true }, settings, load1: 99, env: {} })).toMatchObject({ mode: 'local', reason: 'flag-local' });
    const off = { ...settings, enabled: false };
    expect(decideGateDispatch({ flags: { local: false }, settings: off, load1: 99, env: {} })).toMatchObject({ mode: 'local', reason: 'config-off' });
    expect(decideGateDispatch({ flags: { local: false, remote: 'msb2' }, settings: off, load1: 1, env: {} })).toMatchObject({ mode: 'remote', host: 'msb2' });
  });
  test('the remote child and a test run never auto-dispatch', () => {
    expect(decideGateDispatch({ flags: { local: false, remote: true }, settings, load1: 99, env: { ELANOUS_GATE_REMOTE_CHILD: '1' } }).mode).toBe('local');
    expect(decideGateDispatch({ flags: { local: false }, settings, load1: 99, env: { NODE_ENV: 'test' } })).toMatchObject({ mode: 'local', reason: 'test-env' });
  });
  test('config > env > default', () => {
    expect(resolveGateRemoteSettings(undefined, {})).toEqual(GATE_REMOTE_DEFAULTS);
    expect(resolveGateRemoteSettings(undefined, { ELANOUS_GATE_REMOTE: 'off', ELANOUS_GATE_REMOTE_LOAD: '12' })).toMatchObject({ enabled: false, loadThreshold: 12 });
    expect(resolveGateRemoteSettings(undefined, { ELANOUS_GATE_REMOTE_LOAD: '9'.repeat(400) }).loadThreshold).toBe(20);
    expect(resolveGateRemoteSettings({ enabled: true, loadThreshold: 30, host: 'msb9' }, { ELANOUS_GATE_REMOTE: 'off', ELANOUS_GATE_REMOTE_LOAD: '12' }))
      .toMatchObject({ enabled: true, loadThreshold: 30, host: 'msb9' });
    expect(parseGateRemoteConfig({ enabled: false, hostCap: 1, host: ' node-b ', junk: 1 })).toEqual({ enabled: false, hostCap: 1, host: 'node-b' });
    expect(parseGateRemoteConfig('x')).toBeUndefined();
    expect(parseGateRemoteConfig({ hostCap: 0 })).toBeUndefined();
    expect(parseGateRemoteConfig({ hostCap: 1.5 })).toBeUndefined();
    expect(parseGateRemoteConfig({ hostCap: 3 })).toBeUndefined();
    expect(resolveGateRemoteSettings({ hostCap: 9 }, {}).hostCap).toBe(2);
    expect(hostSlotScript(5).join('\n')).toContain('while [ $n -le 2 ]');
  });
  test('flag extraction leaves the tool arguments alone', () => {
    expect(extractGateRemoteFlags(['--remote', 'node-b', '--json', 'src/a.test.ts'])).toMatchObject({ remote: 'node-b', local: false, rest: ['--json', 'src/a.test.ts'] });
    expect(extractGateRemoteFlags(['--remote', 'src/a.test.ts'])).toMatchObject({ remote: true, rest: ['src/a.test.ts'] });
    expect(extractGateRemoteFlags(['--local', '--base', 'x']).rest).toEqual(['--base', 'x']);
    expect(extractGateRemoteFlags(['--remote', '--local']).error).toContain('cannot be combined');
    expect(extractGateRemoteFlags(['--remote', 'foo.test.js'])).toMatchObject({ remote: true, rest: ['foo.test.js'] });
    expect(extractGateRemoteFlags(['--remote', 'README'])).toMatchObject({ remote: 'README' });
    expect(extractGateRemoteFlags(['--remote=user@node-b.lan', 'a.test.ts'])).toMatchObject({ remote: 'user@node-b.lan', rest: ['a.test.ts'] });
    expect(extractGateRemoteFlags(['--remote', 'node-b.lan', 'a.test.ts'])).toMatchObject({ remote: 'node-b.lan', rest: ['a.test.ts'] });
    expect(extractGateRemoteFlags(['--remote', 'user@node-b.lan', '--json'])).toMatchObject({ remote: 'user@node-b.lan', rest: ['--json'] });
    expect(looksLikeHost('package.json')).toBe(false);
    expect(looksLikeHost('list.txt')).toBe(false);
    expect(looksLikeHost('Makefile', () => true)).toBe(false);
  });
});

const has = (tool: string) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0;

describe.each([['lockf'], ['flock']] as const)('host lock (on the host) — %s path pinned', (tool) => {
  const lockTool = has(tool);
  /** One dispatcher: a scratch $W whose run.sh marks itself started and holds its slot for `holdMs`. */
  const slotRun = (dir: string, holdMs: number) => {
    const w = mkdtempSync(join(tmpdir(), 'gate-remote-w-'));
    dirs.push(w);
    writeFileSync(join(w, 'run.sh'), `: > "$W/started"\nsleep ${holdMs / 1000}\nexit 3\n`);
    const script = ['infra() { echo "__GATE_REMOTE_INFRA=$1" >&2; exit 97; }', ...hostSlotScript(2, dir, [tool])].join('\n');
    // Own process group, so a test can kill the whole holder tree by its pid (never by pattern).
    return { w, child: spawn('sh', ['-c', script], { env: { ...process.env, W: w }, detached: true }) };
  };
  /** Both holders have taken their slots (their run.sh wrote "started") — not a fixed sleep. */
  const waitStarted = async (...ws: string[]) => {
    for (let i = 0; i < 200 && !ws.every((w) => existsSync(join(w, 'started'))); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ws.every((w) => existsSync(join(w, 'started')))).toBe(true);
  };
  const exitOf = (child: ReturnType<typeof spawn>) => new Promise<{ code: number | null; err: string }>((resolve) => {
    let err = '';
    child.stderr!.on('data', (chunk) => { err += String(chunk); });
    child.on('close', (code) => resolve({ code, err }));
  });

  test.skipIf(!lockTool)('cap 2: a third concurrent run is refused (busy); a slot frees when its run ends; the run\'s own rc passes through', async () => {
    const dir = slotDir();
    const a = slotRun(dir, 1500);
    const b = slotRun(dir, 1500);
    const aDone = exitOf(a.child);
    const bDone = exitOf(b.child);
    await waitStarted(a.w, b.w);
    const c = slotRun(dir, 0);
    const third = await exitOf(c.child);
    expect(third.code).toBe(98);
    expect(third.err).toContain('__GATE_REMOTE_BUSY');
    expect(existsSync(join(c.w, 'started'))).toBe(false);
    expect((await aDone).code).toBe(3);
    expect((await bDone).code).toBe(3);
    const d = slotRun(dir, 0);
    expect((await exitOf(d.child)).code).toBe(3);
    expect(existsSync(join(d.w, 'started'))).toBe(true);
  });

  test.skipIf(!lockTool)('a killed holder releases its slot (kernel lock — no staleness guess)', async () => {
    const dir = slotDir();
    const a = slotRun(dir, 30_000);
    const b = slotRun(dir, 30_000);
    const aDone = exitOf(a.child);
    const bDone = exitOf(b.child);
    await waitStarted(a.w, b.w);
    // A run that dies (its whole tree) releases its slot; a run whose ssh merely dropped keeps running and keeps it.
    process.kill(-a.child.pid!, 'SIGKILL');
    process.kill(-b.child.pid!, 'SIGKILL');
    await aDone; await bDone;
    const c = slotRun(dir, 0);
    expect((await exitOf(c.child)).code).not.toBe(98);
  });

  test.skipIf(!lockTool)(`the pinned ${tool} path is the one the script takes`, () => {
    const script = hostSlotScript(2, '/x', [tool]).join('\n');
    expect(script).toContain(tool === 'lockf' ? 'GL="lockf -k -s -t 0"' : 'GL="flock -n"');
    expect(script).not.toContain(tool === 'lockf' ? 'flock' : 'lockf');
  });
});

describe('host lock wiring', () => {
  test('the remote script does all work inside run.sh under the slot lock', () => {
    const script = remoteScript({ mirror: '~/m.git', commit: HEAD, fetchShas: [HEAD], argv: ['x'], installPwa: false, hostCap: 2 });
    const runStart = script.indexOf("<<'__GATE_REMOTE_RUN__'");
    expect(runStart).toBeLessThan(script.indexOf('git clone'));
    expect(script.lastIndexOf('__GATE_REMOTE_RUN__')).toBeLessThan(script.indexOf('$GL "$GS/slot$n" sh "$W/run.sh"'));
    expect(script).toContain('while [ $n -le 2 ]');
  });

  test('a busy host is retried, then the check runs locally with a fallback reason', async () => {
    const runner = fakeRunner({ ssh: { rc: 98, stdout: '', stderr: '__GATE_REMOTE_BUSY\n' } });
    const io = sink();
    let local = 0;
    let clock = 0;
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, remoteArgv: ['x'], runLocal: () => { local++; return 0; } },
      { runner, settings: { ...settings, slotWaitSeconds: 30 }, env: {}, load1: 1, write: io.write, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(rc).toBe(0);
    expect(local).toBe(1);
    // Attempts at t=0 and t=15s; the wait to t=30s reaches the deadline, so no third attempt.
    expect(runner.calls.filter((c) => c[0] === 'ssh').length).toBe(2);
    expect(io.err.join('')).toContain('fallback to local — host-busy');
  });

  test('a slot that frees exactly at the deadline is not used — the expired wait runs locally', async () => {
    let calls = 0;
    const runner = fakeRunner({ ssh: () => (++calls < 3
      ? { rc: 98, stdout: '', stderr: '__GATE_REMOTE_BUSY\n' }
      : { rc: 0, stdout: 'remote', stderr: '\n__GATE_REMOTE_RC=0\n' }) });
    const io = sink();
    let local = 0;
    let clock = 0;
    await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, remoteArgv: ['x'], runLocal: () => { local++; return 0; } },
      { runner, settings: { ...settings, slotWaitSeconds: 20 }, env: {}, load1: 1, write: io.write, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(calls).toBe(2);
    expect(local).toBe(1);
    expect(io.out.join('')).toBe('');
  });
});

describe('remote run and fallback', () => {
  test('remote result: rc and JSON shape are the tool\'s own, plus host and remote:true', async () => {
    const runner = fakeRunner();
    const io = sink();
    const rc = await dispatchHeavyCheck({ tool: 'public-export-test-run', repo: '/r', json: true, flags: { local: false, remote: 'node-b' }, remoteArgv: ['bun', 'scripts/public-export-test-run.ts', '--local', '--json'], runLocal: () => { throw new Error('must not run locally'); } },
      { runner, settings, env: {}, load1: 1, write: io.write });
    expect(rc).toBe(0);
    const local = { exportOnly: [], preexisting: [], notExported: [], exportRan: 3, privateRan: 3 };
    const remote = JSON.parse(io.out.join(''));
    expect(remote).toEqual({ ...local, host: 'node-b', remote: true });
    expect(Object.keys(remote).slice(0, 5)).toEqual(Object.keys(local));
    // stderr is exactly the tool's own (marker stripped, nothing added).
    expect(io.err.join('')).toBe('Ran 3 tests\nwarn: x\n');
    const push = runner.calls.find((c) => c[1] === 'push')!;
    expect(push).toContain(`${HEAD}:refs/elanous/gate/${HEAD}`);
    expect(push).toContain('node-b:mirror/elanous-agent.git');
  });

  test('a failing check on the host is a real result (rc 1), not a fallback', async () => {
    const runner = fakeRunner({ ssh: { rc: 0, stdout: 'FAIL\n', stderr: '\n__GATE_REMOTE_RC=1\n' } });
    const io = sink();
    let local = 0;
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, remoteArgv: ['x'], runLocal: () => { local++; return 0; } },
      { runner, settings, env: {}, load1: 1, write: io.write });
    expect(rc).toBe(1);
    expect(local).toBe(0);
  });

  test.each([
    ['ssh unreachable (no rc marker)', { ssh: { rc: 255, stdout: '', stderr: 'ssh: connect to host node-b: timed out' } }, 'ssh rc=255'],
    ['remote clone failure', { ssh: { rc: 97, stdout: '', stderr: '__GATE_REMOTE_INFRA=clone\n' } }, 'remote-clone'],
    ['push failure', { push: 128 }, 'push-failed'],
    ['rc marker cut before its newline', { ssh: { rc: 0, stdout: 'x', stderr: '\n__GATE_REMOTE_RC=1' } }, 'rc-unparsed'],
    ['rc marker out of the exit-code range', { ssh: { rc: 0, stdout: 'x', stderr: '\n__GATE_REMOTE_RC=999\n' } }, 'rc-unparsed'],
    ['empty rc marker value', { ssh: { rc: 0, stdout: 'x', stderr: '\n__GATE_REMOTE_RC=\n' } }, 'rc-unparsed'],
    ['ssh dropped after the marker (output may be cut)', { ssh: { rc: 255, stdout: 'partial', stderr: '\n__GATE_REMOTE_RC=0\n' } }, 'ssh-incomplete'],
    ['dirty tree', { dirty: true }, 'dirty-tree'],
  ] as const)('infra failure → local fallback, never a test result: %s', async (_name, opts, reason) => {
    const runner = fakeRunner(opts as Parameters<typeof fakeRunner>[0]);
    const io = sink();
    let local = 0;
    const rc = await dispatchHeavyCheck({ tool: 'ci-typecheck-changed', repo: '/r', flags: { local: false, remote: true }, remoteArgv: ['x'], runLocal: () => { local++; return 7; } },
      { runner, settings, env: {}, load1: 1, write: io.write });
    expect(local).toBe(1);
    expect(rc).toBe(7);
    expect(io.err.join('')).toContain(reason);
    expect(io.out.join('')).toBe('');
  });

  test('the remote script checks out the exact commit, pins origin/main, and isolates state', () => {
    const script = remoteScript({ mirror: '~/mirror/elanous-agent.git', commit: HEAD, fetchShas: [HEAD, MAIN], mainSha: MAIN, argv: ['bun', 'run', 'scripts/ci-typecheck-changed.ts', '--local'], installPwa: false });
    expect(script).toContain(`git checkout -q --detach ${HEAD}`);
    expect(script).toContain(`git update-ref refs/remotes/origin/main ${MAIN}`);
    expect(script).toContain('ELANOUS_STATE_DIR="$W/state"');
    expect(script).toContain('ELANOUS_GATE_REMOTE_CHILD=1');
    expect(script).toContain('trap \'rm -rf "$W"\' EXIT');
    expect(script).not.toContain('apps/pwa');
    const outcome = runOnRemote({ repo: '/r', host: 'node-b', mirror: '~/mirror/elanous-agent.git', argv: ['x'], refs: ['origin/main'] }, fakeRunner());
    expect(outcome).toMatchObject({ kind: 'ran', rc: 0, commit: HEAD });
  });

  test('a tool stderr without a trailing newline is passed through exactly', async () => {
    const runner = fakeRunner({ ssh: { rc: 0, stdout: '', stderr: 'no newline at end\n__GATE_REMOTE_RC=1\n' } });
    const io = sink();
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, remoteArgv: ['x'], runLocal: () => { throw new Error('no local'); } },
      { runner, settings, env: {}, load1: 1, write: io.write });
    expect(rc).toBe(1);
    expect(io.err.join('')).toBe('no newline at end');
  });

  test('a completed run whose tool prints the busy/infra marker strings is still the tool\'s result', async () => {
    const toolErr = '__GATE_REMOTE_BUSY\n__GATE_REMOTE_INFRA=clone\n';
    const runner = fakeRunner({ ssh: { rc: 0, stdout: 'out', stderr: `${toolErr}\n__GATE_REMOTE_RC=1\n` } });
    const io = sink();
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, remoteArgv: ['x'], runLocal: () => { throw new Error('no local'); } },
      { runner, settings, env: {}, load1: 1, write: io.write });
    expect(rc).toBe(1);
    expect(io.err.join('')).toBe(toolErr);
    expect(io.out.join('')).toBe('out');
  });

  test('a remote decision for a non-reproducible invocation is a logged fallback, not a silent local run', async () => {
    const runner = fakeRunner();
    const io = sink();
    let local = 0;
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', localOnlyReason: 'self gate without --base measures uncommitted files on this host', flags: { local: false, remote: true }, remoteArgv: ['x'], runLocal: () => { local++; return 0; } },
      { runner, settings, env: {}, load1: 1, write: io.write });
    expect(rc).toBe(0);
    expect(local).toBe(1);
    expect(runner.calls.length).toBe(0);
    expect(io.err.join('')).toContain('fallback to local — self gate without --base');
    // --local stays quiet: nothing was asked of a remote host.
    const quiet = sink();
    await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', localOnlyReason: 'x', flags: { local: true }, remoteArgv: ['x'], runLocal: () => 0 }, { runner, settings, env: {}, load1: 99, write: quiet.write });
    expect(quiet.err.join('')).toBe('');
  });

  test('the push is non-interactive and time-bounded; a hung push falls back', async () => {
    const seen: Array<{ timeoutMs?: number; env?: NodeJS.ProcessEnv }> = [];
    const base = fakeRunner();
    const runner: GateRemoteRunner = { ...base, local(cmd, args, cwd, options) {
      if (args[0] === 'push') { seen.push(options ?? {}); return { rc: null, stdout: '', stderr: '', error: 'Error: spawnSync git ETIMEDOUT' }; }
      return base.local(cmd, args, cwd, options);
    } };
    const io = sink();
    let local = 0;
    await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, remoteArgv: ['x'], runLocal: () => { local++; return 0; } },
      { runner, settings, env: {}, load1: 1, write: io.write });
    expect(local).toBe(1);
    expect(seen[0]!.timeoutMs).toBeGreaterThan(0);
    expect(seen[0]!.env!.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(io.err.join('')).toContain('push-failed');
  });

  test('an unresolvable local origin/main falls back before any push', () => {
    const base = fakeRunner();
    const runner: GateRemoteRunner = { ...base, local(cmd, args, cwd, options) {
      if (args[0] === 'rev-parse' && args.at(-1)!.startsWith('origin/main')) return { rc: 1, stdout: '', stderr: '' };
      return base.local(cmd, args, cwd, options);
    } };
    expect(runOnRemote({ repo: '/r', host: 'node-b', mirror: '~/m.git', argv: ['x'] }, runner)).toEqual({ kind: 'infra', reason: 'origin-main-unresolved' });
    expect(base.calls.find((c) => c[1] === 'push')).toBeUndefined();
  });

  test('an argument line equal to the run.sh delimiter is refused (never ends the locked script early)', () => {
    expect(() => remoteScript({ mirror: '~/m.git', commit: HEAD, fetchShas: [HEAD], argv: ['bun', 'x\n__GATE_REMOTE_RUN__\nrm -rf ~'], installPwa: false })).toThrow('delimiter');
  });

  test('outside-repo arguments and bad hosts are detected', () => {
    expect(outsideRepoArgs(['/r/src/a.test.ts', '/tmp/x.test.ts', 'b.ts', '../external.test.ts', 'src/../../y.ts', '--json'], '/r')).toEqual(['/tmp/x.test.ts', '../external.test.ts', 'src/../../y.ts']);
    expect(isValidGateHost('node-b')).toBe(true);
    expect(isValidGateHost('user@node-b.lan')).toBe(true);
    expect(isValidGateHost('-oProxyCommand=x')).toBe(false);
    expect(isValidGateHost('a b')).toBe(false);
  });

  test('untracked/ignored files, ../ paths and anything reached through a symlink (file or directory) are not reproducible', () => {
    const repo = slotDir();
    const outside = slotDir();
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'real'));
    writeFileSync(join(repo, 'src/a.test.ts'), '');
    writeFileSync(join(repo, 'src/ignored.test.ts'), '');
    writeFileSync(join(repo, 'real/b.test.ts'), '');
    writeFileSync(join(outside, 'x.test.ts'), '');
    symlinkSync(join(outside, 'x.test.ts'), join(repo, 'src/link.test.ts'));
    symlinkSync(join(repo, 'src/a.test.ts'), join(repo, 'src/good-link.test.ts'));
    symlinkSync('loop-b.test.ts', join(repo, 'src/loop-a.test.ts'));
    symlinkSync('loop-a.test.ts', join(repo, 'src/loop-b.test.ts'));
    // A tracked file reached through an (untracked) directory link.
    symlinkSync(join(repo, 'real'), join(repo, 'dirlink'));
    const tracked = (path: string) => ['src/a.test.ts', 'real/b.test.ts', 'dirlink/b.test.ts', 'src/link.test.ts', 'src/good-link.test.ts', 'src/loop-a.test.ts'].includes(path);
    expect(unreproducibleArgs(['src/a.test.ts', 'real/b.test.ts', 'src/ignored.test.ts', '../z.test.ts', 'src/link.test.ts', 'src/good-link.test.ts', 'src/loop-a.test.ts', 'dirlink/b.test.ts'], repo, tracked))
      .toEqual(['src/ignored.test.ts', '../z.test.ts', 'src/link.test.ts', 'src/good-link.test.ts', 'src/loop-a.test.ts', 'dirlink/b.test.ts']);
  });

  test('non-UTF-8 bytes from the host pass through unchanged', async () => {
    const raw = Buffer.from([0xff, 0xfe, 0x41, 0x0a]);
    const runner = fakeRunner({ ssh: { rc: 0, stdout: raw, stderr: Buffer.concat([raw, Buffer.from('\n__GATE_REMOTE_RC=0\n')]) } });
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, remoteArgv: ['x'], runLocal: () => 0 },
      { runner, settings, env: {}, load1: 1, write: { out: (d) => out.push(Buffer.from(d)), err: (d) => err.push(Buffer.from(d)) } });
    expect(Buffer.concat(out).equals(raw)).toBe(true);
    expect(Buffer.concat(err).equals(raw)).toBe(true);
  });

  test('refs are resolved locally and the remote argv names the sha, not the ref', () => {
    const runner = fakeRunner();
    const outcome = runOnRemote({ repo: '/r', host: 'node-b', mirror: '~/m.git', refs: ['feature/x'], argv: (sha) => ['gate', '--base', sha('feature/x')] }, runner);
    expect(outcome.kind).toBe('ran');
    expect(runner.scripts[0]).toContain(`'--base' '${'c'.repeat(40)}'`);
    expect(runner.calls.find((c) => c[1] === 'push')).toContain(`${'c'.repeat(40)}:refs/elanous/gate/${'c'.repeat(40)}`);
  });

  test('helpers: JSON annotation passes non-JSON through; absolute repo paths become relative', () => {
    expect(annotateJsonStdout('plain\n', 'node-b')).toBe('plain\n');
    const pretty = '{\n  "a": "\\u00e9",\n  "b": [1, 2]\n}\n';
    expect(annotateJsonStdout(pretty, 'node-b')).toBe('{\n  "a": "\\u00e9",\n  "b": [1, 2]\n,"host":"node-b","remote":true}\n');
    expect(JSON.parse(annotateJsonStdout(pretty, 'node-b'))).toEqual({ a: 'é', b: [1, 2], host: 'node-b', remote: true });
    expect(annotateJsonStdout('{}\n', 'node-b')).toBe('{"host":"node-b","remote":true}\n');
    expect(relativizeArgs(['/r/src/a.test.ts', '/elsewhere/x', 'b.ts', '/r/..fixture.test.ts'], '/r')).toEqual(['src/a.test.ts', '/elsewhere/x', 'b.ts', '..fixture.test.ts']);
    expect(outsideRepoArgs(['..fixture.test.ts'], '/r')).toEqual([]);
  });
});

describe('payload files', () => {
  test('a payload travels in the script body (stdin), never argv, and is exposed by env inside the scratch dir', () => {
    const script = remoteScript({ mirror: '~/m.git', commit: HEAD, fetchShas: [HEAD], argv: ['bun', 'x'], installPwa: false, payloadFiles: [{ env: 'ELANOUS_EXPORT_REDACTIONS', content: 'real\tplaceholder\n' }] });
    expect(script.startsWith('{\numask 077')).toBe(true);
    expect(script).toContain("cat > \"$W/payload-0\" <<'__GATE_REMOTE_PAYLOAD_0__' || infra payload\nreal\tplaceholder\n__GATE_REMOTE_PAYLOAD_0__");
    expect(script).toContain('ELANOUS_EXPORT_REDACTIONS="$W/payload-0" ELANOUS_STATE_DIR=');
    expect(() => remoteScript({ mirror: '~/m.git', commit: HEAD, fetchShas: [HEAD], argv: ['x'], installPwa: false, payloadFiles: [{ env: 'A', content: '__GATE_REMOTE_PAYLOAD_0__' }] })).toThrow('delimiter');
  });
});

describe('the whole remote script, executed (no ssh)', () => {
  test('clone → fetch → checkout of the exact sha → pinned origin/main → install → tool, with rc and stdout/stderr passed through', () => {
    const root = slotDir();
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'marker.txt'), 'base\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    writeFileSync(join(repo, 'marker.txt'), 'head\n');
    git(repo, 'commit', '-qam', 'head');
    const head = git(repo, 'rev-parse', 'HEAD');
    const mirror = join(root, 'mirror.git');
    git(root, 'init', '-q', '--bare', mirror);
    // A fake host home: bun is a stub that records its calls (bun install must run before the tool).
    const home = join(root, 'home');
    mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
    writeFileSync(join(home, '.bun', 'bin', 'bun'), '#!/bin/sh\necho "bun $*" >> "$W/bun.calls"\nexit 0\n', { mode: 0o755 });
    const hostEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home };
    const runner: GateRemoteRunner = {
      local(cmd, args, cwd, options) {
        // The push goes to the local bare mirror path instead of host:path.
        const fixed = args[0] === 'push' ? ['push', '--quiet', mirror, ...args.slice(3)] : args;
        const r = spawnSync(cmd, fixed, { cwd, encoding: 'utf8', ...(options?.env ? { env: options.env } : {}) });
        return { rc: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      },
      ssh(_host, script) {
        const r = spawnSync('sh', ['-s'], { input: script, encoding: 'utf8', env: hostEnv, cwd: root });
        return { rc: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      },
    };
    const tool = 'printf "%s|%s|" "$(git rev-parse HEAD)" "$(git rev-parse origin/main)"; cat marker.txt; test -s "$W/bun.calls" && echo installed; echo "tool err" >&2; exit 3';
    const outcome = runOnRemote({ repo, host: 'h', mirror, argv: ['sh', '-c', tool], slotDir: join(root, 'slots') }, runner);
    expect(outcome).toMatchObject({ kind: 'ran', rc: 3, commit: head });
    if (outcome.kind !== 'ran') return;
    expect(outcome.stdout.toString()).toBe(`${head}|${base}|head\ninstalled\n`);
    expect(outcome.stderr.toString()).toBe('tool err\n');
  });
});

// Entry points are verified through the entry points (in-process imports never take the `import.meta.main` branch).
describe('entry-point wiring (spawned, no remote work)', () => {
  const repoRoot = join(import.meta.dir, '..', '..');
  const run = (args: string[]) => spawnSync('bun', args, { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ELANOUS_GATE_REMOTE_CHILD: '' } });
  test('ci-typecheck-changed: --remote and --local are parsed (combined = refused, rc 2); other arguments still refused', () => {
    const both = run(['run', 'scripts/ci-typecheck-changed.ts', '--remote', '--local']);
    expect(both.status).toBe(2);
    expect(both.stderr).toContain('cannot be combined');
    const other = run(['run', 'scripts/ci-typecheck-changed.ts', '--remote', 'node-b', '--base', 'x']);
    expect(other.status).toBe(2);
    expect(other.stderr).toContain('--base x');
  });
  test('public-export-test-run: an invalid --remote host is refused before any work (rc 2)', () => {
    const r = run(['scripts/public-export-test-run.ts', '--remote=-oProxyCommand=x', '--json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('invalid --remote host');
  });
  test('a valid --remote call reaches the dispatcher: with no local origin/main it logs a fallback and runs locally (tsc · self gate)', () => {
    // A scratch repo with no origin/main: the dispatcher falls back before any push/ssh, so no host is contacted.
    const scratch = slotDir();
    spawnSync('git', ['init', '-q'], { cwd: scratch });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: scratch });
    // Drop the remote-child marker: when this suite itself runs inside a remote gate, it would (correctly) skip dispatch.
    const { ELANOUS_GATE_REMOTE_CHILD: _child, ...inherited } = process.env;
    const env = { ...inherited, NODE_ENV: 'test', ELANOUS_STATE_DIR: join(scratch, '.state') };
    const tsc = spawnSync('bun', [join(repoRoot, 'scripts/ci-typecheck-changed.ts'), '--remote', 'node-b'], { cwd: scratch, encoding: 'utf8', env });
    expect(tsc.stderr).toContain('[gate.remote] fallback to local — origin-main-unresolved');
    expect(`${tsc.stdout}${tsc.stderr}`).toContain('[tsc-gate]');
    const gate = spawnSync('bun', [join(repoRoot, 'bin/elanous.mjs'), 'self', 'gate', '--changed', '--base', 'HEAD', '--remote', 'node-b'], { cwd: scratch, encoding: 'utf8', env });
    expect(gate.stderr).toContain('[gate.remote] fallback to local — origin-main-unresolved');
    expect(gate.status).toBe(0);
  });

  test('self gate: --remote with --local, or an invalid host, is refused (rc 2)', () => {
    const both = run(['bin/elanous.mjs', 'self', 'gate', '--changed', '--base', 'origin/main', '--remote', 'node-b', '--local']);
    expect(both.status).toBe(2);
    expect(`${both.stdout}${both.stderr}`).toContain('cannot be combined');
    const bad = run(['bin/elanous.mjs', 'self', 'gate', '--changed', '--base', 'origin/main', '--remote', 'a b']);
    expect(bad.status).toBe(2);
    expect(`${bad.stdout}${bad.stderr}`).toContain('invalid --remote host');
  });
});
