import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFakeBins } from '../ux-sim/fake-bin.js';
import {
  annotateJsonStdout, decideGateDispatch, dispatchHeavyCheck, extractGateRemoteFlags, GATE_REMOTE_DEFAULTS, relativizeArgs,
  gateRemoteHostCap, hostSlotScript, isValidGateHost, looksLikeHost, outsideRepoArgs, unreproducibleArgs, remoteScript, remoteSelfGateArgv, resolveGateRemoteSettings, runOnRemote, type GateRemoteRunner, type SshResult,
} from './gate-remote.js';
import { parseGateRemoteConfig } from '../user-config.js';
import { reserveReleaseGateHosts } from '../release-loop/gate-host-reservation.js';

// Spawned CLI integration checks can exceed Bun's 5 s unit-test default under concurrent gate load.
setDefaultTimeout(60_000);

const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const dirs: string[] = [];
const slotDir = () => { const d = mkdtempSync(join(tmpdir(), 'gate-remote-slots-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeRunner(opts: { dirty?: boolean; push?: number; ssh?: SshResult | (() => SshResult); object?: 'commit' | 'tree' | 'missing' } = {}): GateRemoteRunner & { calls: string[][]; scripts: string[] } {
  const calls: string[][] = [];
  const scripts: string[] = [];
  return {
    calls, scripts,
    local(cmd, args) {
      calls.push([cmd, ...args]);
      if (args[0] === 'status') return { rc: 0, stdout: opts.dirty ? ' M src/x.ts\n' : '', stderr: '' };
      if (args[0] === 'cat-file') return { rc: opts.object === 'missing' ? 1 : 0, stdout: `${opts.object ?? 'commit'}\n`, stderr: '' };
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
  test('remote importer sweep carries a shard plan even when --shards was omitted', () => {
    const argv = remoteSelfGateArgv({ changed: true, base: 'origin/main', includeImporters: true }, () => { throw new Error('origin/main must stay pinned'); });
    expect(argv).toEqual(['bun', 'bin/elanous.mjs', 'self', 'gate', '--local', '--changed', '--base', 'origin/main', '--shards', '2', '--include-importers']);
    expect(remoteSelfGateArgv({ changed: true, base: 'feature', shards: 16, includeImporters: true, artifactDir: '/tmp/gate-artifacts' }, () => HEAD))
      .toEqual(['bun', 'bin/elanous.mjs', 'self', 'gate', '--local', '--changed', '--base', HEAD, '--shards', '16', '--include-importers', '--artifact-dir', '/tmp/gate-artifacts']);
    expect(remoteSelfGateArgv({ changed: true, base: 'origin/main' }, () => MAIN)).not.toContain('--shards');
  });
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
    expect(parseGateRemoteConfig({ hostCap: 3, hostCaps: { node-b: 4, node-c: 1, 'bad host': 5, wsl: 9, zero: 0 } }))
      .toEqual({ hostCaps: { node-b: 4, node-c: 1 } });
    expect(parseGateRemoteConfig({ hostCaps: { node-b: 8 } })).toEqual({ hostCaps: { node-b: 8 } });
    expect(parseGateRemoteConfig({ hostCaps: { node-b: 1.5 } })).toBeUndefined();
    expect(resolveGateRemoteSettings({ hostCap: 9 }, {}).hostCap).toBe(2);
    const perHost = resolveGateRemoteSettings({ hostCaps: { node-b: 6, node-c: 3, bad: 9 } }, {});
    expect(gateRemoteHostCap(perHost, 'node-b')).toBe(6);
    expect(gateRemoteHostCap(perHost, 'ubuntu@node-b')).toBe(6);
    expect(gateRemoteHostCap(perHost, 'node-c')).toBe(3);
    expect(gateRemoteHostCap(perHost, 'other')).toBe(2);
    expect(hostSlotScript(9).join('\n')).toContain('while [ $n -le 8 ]');
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
    expect(third.err).toContain('__GATE_REMOTE_BUSY=2');
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
  test('remote scratch uses disk and refuses low free space before checkout', () => {
    const home = slotDir();
    mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
    writeFileSync(join(home, '.bun', 'bin', 'df'), '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/fake 100 99 1 99%% /var/tmp\\n"\n', { mode: 0o755 });
    const script = remoteScript({ mirror: '~/m.git', commit: HEAD, fetchShas: [HEAD], argv: ['x'], installPwa: false });
    expect(script).toContain('TMPDIR=/var/tmp; export TMPDIR');
    expect(script).toContain('mktemp -d /var/tmp/elanous-gate-remote-XXXXXXXX');
    const run = spawnSync('sh', ['-s'], { input: script, encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    expect(run.status).toBe(97);
    expect(run.stderr).toContain('__GATE_REMOTE_INFRA=disk-low:1KiB');
    expect(run.stderr).not.toContain('clone');
  });

  test('heavy typecheck uses a stable slot checkout and a private per-slot cache', () => {
    const script = remoteScript({ mirror: '~/m.git', commit: HEAD, fetchShas: [HEAD],
      argv: ['bun', 'run', 'scripts/ci-typecheck-changed.ts', '--local'], installPwa: true, stableCheckout: true });
    expect(script).toContain('env GATE_REMOTE_SLOT="$n" sh "$W/run.sh"');
    expect(script).toContain('T="$HOME/.cache/elanous/gate-remote/slot$GATE_REMOTE_SLOT/checkout"');
    expect(script).toContain('ELANOUS_TSC_CACHE_DIR="$HOME/.cache/elanous/gate-remote/slot$GATE_REMOTE_SLOT/cache"');
    expect(script).toContain('git -C "$T" reset --hard -q');
    expect(script).toContain('git -C "$T" clean -ffd -q');
    expect(script).toContain('rm -rf "$T/apps/pwa/.next"');
    expect(script).not.toContain('trap \'rm -rf "$T"\' EXIT');
  });

  test('typecheck dispatch forwards stable checkout and does not run locally on remote failure', async () => {
    const runner = fakeRunner({ ssh: { rc: 97, stdout: '', stderr: '__GATE_REMOTE_INFRA=offline\n' } });
    const io = sink();
    let localCalls = 0;
    const rc = await dispatchHeavyCheck({ tool: 'ci-typecheck-changed', repo: '/r', flags: { remote: true, local: false },
      explicitRemoteOnly: true, stableCheckout: true, installPwa: true, remoteArgv: ['bun', 'run', 'scripts/ci-typecheck-changed.ts', '--local'],
      runLocal: () => { localCalls++; return 0; } }, { runner, settings, write: io.write });
    expect(rc).toBe(1);
    expect(localCalls).toBe(0);
    expect(io.err.join('')).toContain('remote unmeasured');
    expect(runner.scripts[0]).toContain('ELANOUS_TSC_CACHE_DIR="$HOME/.cache/elanous/gate-remote/slot$GATE_REMOTE_SLOT/cache"');
    expect(runner.scripts[0]).toContain('bun-install-pwa');
  });

  test('the remote script does all work inside run.sh under the slot lock', () => {
    const script = remoteScript({ mirror: '~/m.git', commit: HEAD, fetchShas: [HEAD], argv: ['x'], installPwa: false, hostCap: 2 });
    const runStart = script.indexOf("<<'__GATE_REMOTE_RUN__'");
    expect(runStart).toBeLessThan(script.indexOf('git clone'));
    expect(script.lastIndexOf('__GATE_REMOTE_RUN__')).toBeLessThan(script.indexOf('$GL "$GS/slot$n" sh "$W/run.sh"'));
    expect(script).toContain('while [ $n -le 2 ]');
  });

  test('busy marker carries the host-observed occupied slots and load', () => {
    const runner = fakeRunner({ ssh: { rc: 98, stdout: '', stderr: '__GATE_REMOTE_BUSY=4;load1=31.5\n' } });
    expect(runOnRemote({ repo: '/r', host: 'node-b', mirror: '~/m.git', argv: ['x'], hostCap: 4 }, runner))
      .toEqual({ kind: 'busy', occupied: 4, load1: 31.5, rc: 98 });
    expect(runner.scripts[0]).toContain('while [ $n -le 4 ]');
    expect(runner.scripts[0]).toContain('load1=$(load1)');
  });

  test('an empty optional load sample preserves the legacy busy classification', () => {
    const runner = fakeRunner({ ssh: { rc: 98, stdout: '', stderr: '__GATE_REMOTE_BUSY=4;load1=\n' } });
    expect(runOnRemote({ repo: '/r', host: 'node-b', mirror: '~/m.git', argv: ['x'], hostCap: 4 }, runner))
      .toEqual({ kind: 'busy', occupied: 4, load1: null, rc: 98 });
  });

  test.each([
    ['load above configured threshold', 41.2, 40],
    ['slots full while load is below threshold', 18.5, 40],
  ])('reports %s on every busy poll and names the wait resolution', async (_case, load1, threshold) => {
    let sshCalls = 0;
    let clock = 0;
    const runner = fakeRunner({ ssh: () => {
      if (++sshCalls === 1) {
        clock += 7000; // Initial SSH setup is not slot waiting time.
        return { rc: 98, stdout: '', stderr: `__GATE_REMOTE_BUSY=2;load1=${load1}\n` };
      }
      return { rc: 0, stdout: 'remote check\n', stderr: '\n__GATE_REMOTE_RC=0\n' };
    } });
    const io = sink();
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: 'node-b' }, explicitRemoteOnly: true,
      remoteArgv: ['x'], runLocal: () => { throw new Error('must not run locally'); } },
    { runner, settings: { ...settings, loadThreshold: threshold, slotWaitSeconds: 30 }, env: {}, load1: 1, write: io.write,
      now: () => clock, sleep: async (ms) => { clock += ms; }, log: (event, data) => events.push({ event, data }) });
    expect(rc).toBe(0);
    expect(io.err.slice(0, 2)).toEqual([
      `[gate.remote] waiting on node-b — reason=host-busy load=${load1}/${threshold} slots=2/2 elapsed=0s\n`,
      '[gate.remote] wait ended on node-b — reason=slot-open elapsed=15s\n',
    ]);
    expect(io.err.slice(2)).toEqual(['']);
    expect(events).toEqual([
      { event: 'wait-reason', data: { tool: 'self-gate', host: 'node-b', reason: 'host-busy', load1, loadThreshold: threshold, occupied: 2, cap: 2, elapsedMs: 0 } },
      { event: 'wait-ended', data: { tool: 'self-gate', host: 'node-b', reason: 'slot-open', elapsedMs: 15000 } },
    ]);
  });

  test('an explicit host uses its own configured cap and reports observed occupancy on busy', async () => {
    const runner = fakeRunner({ ssh: { rc: 98, stdout: '', stderr: '__GATE_REMOTE_BUSY=3\n' } });
    const io = sink();
    const configured = resolveGateRemoteSettings({ hostCaps: { node-b: 6, node-c: 3 }, slotWaitSeconds: 0 }, {});
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: 'node-c' }, explicitRemoteOnly: true, remoteArgv: ['x'], runLocal: () => { throw new Error('local gate must not run'); } },
      { runner, settings: configured, env: {}, load1: 1, write: io.write });
    expect(rc).toBe(1);
    expect(runner.scripts[0]).toContain('while [ $n -le 3 ]');
    expect(io.err.join('')).toContain('occupied 3/3');
  });

  test('a busy host is retried, then self gate fails without running locally', async () => {
    const runner = fakeRunner({ ssh: { rc: 98, stdout: '', stderr: '__GATE_REMOTE_BUSY\n' } });
    const io = sink();
    let local = 0;
    let clock = 0;
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, explicitRemoteOnly: true, remoteArgv: ['x'], runLocal: () => { local++; return 0; } },
      { runner, settings: { ...settings, slotWaitSeconds: 30 }, env: {}, load1: 1, write: io.write, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(rc).toBe(1);
    expect(local).toBe(0);
    // Attempts at t=0 and t=15s; the wait to t=30s reaches the deadline, so no third attempt.
    expect(runner.calls.filter((c) => c[0] === 'ssh').length).toBe(2);
    expect(io.err.join('')).toContain('remote unmeasured on node-b (stage=host-busy, rc=98) — host-busy');
  });

  test('a slot that frees exactly at the deadline is not used — the expired wait stays remote-unmeasured', async () => {
    let calls = 0;
    const runner = fakeRunner({ ssh: () => (++calls < 3
      ? { rc: 98, stdout: '', stderr: '__GATE_REMOTE_BUSY\n' }
      : { rc: 0, stdout: 'remote', stderr: '\n__GATE_REMOTE_RC=0\n' }) });
    const io = sink();
    let local = 0;
    let clock = 0;
    await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, explicitRemoteOnly: true, remoteArgv: ['x'], runLocal: () => { local++; return 0; } },
      { runner, settings: { ...settings, slotWaitSeconds: 20 }, env: {}, load1: 1, write: io.write, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(calls).toBe(2);
    expect(local).toBe(0);
    expect(io.err.join('')).toContain('remote unmeasured on node-b (stage=host-busy, rc=98) — host-busy');
    expect(io.out.join('')).toBe('');
  });
});

describe('onRemoteOutcome hook (self gate --artifact-dir fetch)', () => {
  test('called once with the ran outcome and the runner; the rc and output stay the tool\'s own', async () => {
    const runner = fakeRunner({ ssh: { rc: 0, stdout: 'out', stderr: '\n__GATE_REMOTE_RC=1\n' } });
    const io = sink();
    const seen: string[] = [];
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: 'node-c' }, remoteArgv: ['x'], runLocal: () => { throw new Error('no local'); },
      onRemoteOutcome: (outcome, host, r) => { seen.push(`${outcome.kind}@${host}`); expect(r).toBe(runner); } },
      { runner, settings, env: {}, load1: 1, write: io.write });
    expect(rc).toBe(1);
    expect(seen).toEqual(['ran@node-c']);
    expect(io.out.join('')).toBe('out');
  });

  test('a throwing hook never changes the rc (fetch failure is not a verdict)', async () => {
    const runner = fakeRunner({ ssh: { rc: 0, stdout: '', stderr: '\n__GATE_REMOTE_RC=0\n' } });
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, remoteArgv: ['x'], runLocal: () => { throw new Error('no local'); },
      onRemoteOutcome: () => { throw new Error('fetch exploded'); } },
      { runner, settings, env: {}, load1: 1, write: sink().write });
    expect(rc).toBe(0);
  });

  test('infra reaches the hook without a local fallback; a local decision never calls it', async () => {
    const order: string[] = [];
    await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, explicitRemoteOnly: true, remoteArgv: ['x'], runLocal: () => { order.push('local'); return 0; },
      onRemoteOutcome: (outcome) => { order.push(outcome.kind); } },
      { runner: fakeRunner({ ssh: { rc: 255, stdout: '', stderr: 'timed out' } }), settings, env: {}, load1: 1, write: sink().write });
    expect(order).toEqual(['infra']);
    const none: string[] = [];
    await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: true }, remoteArgv: ['x'], runLocal: () => 0, onRemoteOutcome: (o) => { none.push(o.kind); } },
      { runner: fakeRunner(), settings, env: {}, load1: 1, write: sink().write });
    expect(none).toEqual([]);
  });
});

describe('self gate explicit remote placement', () => {
  test('changed typecheck keeps node-b fixed and becomes unmeasured during a release reservation', async () => {
    const root = slotDir();
    const release = reserveReleaseGateHosts(root, 'gate-run', ['node-b']);
    try {
      const runner = fakeRunner();
      const io = sink();
      let localCalls = 0;
      const rc = await dispatchHeavyCheck({ tool: 'ci-typecheck-changed', repo: '/r', flags: { local: false, remote: 'node-b' },
        explicitRemoteOnly: true, reservationRoot: root, remoteArgv: ['x'], runLocal: () => { localCalls++; return 0; } },
      { runner, settings, env: {}, load1: 1, write: io.write });
      expect(rc).toBe(1);
      expect(localCalls).toBe(0);
      expect(runner.calls.some(([kind]) => kind === 'ssh')).toBe(false);
      expect(io.err.join('')).toContain('remote unmeasured');
      expect(io.err.join('')).not.toContain('using node-c');
    } finally { release(); }
  });

  test('a release gate reservation reroutes node-b to node-c and names the reason', async () => {
    const root = slotDir();
    const release = reserveReleaseGateHosts(root, 'gate-run', ['node-b']);
    try {
      const runner = fakeRunner();
      const io = sink();
      const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: 'node-b' },
        explicitRemoteOnly: true, reportRemoteHost: true, reservationRoot: root, remoteArgv: ['x'],
        runLocal: () => { throw new Error('must stay remote'); } },
      { runner, settings, env: {}, load1: 1, write: io.write });
      expect(rc).toBe(0);
      expect(runner.calls).toContainEqual(['ssh', 'node-c']);
      expect(io.err.join('')).toContain('node-b reserved (release gate gate-run holds node-b) — using node-c');
      expect(io.err.join('')).toContain('executed on node-c (rc=0)');
    } finally { release(); }
  });

  test('an SSH user prefix still matches the reserved machine', async () => {
    const root = slotDir();
    const release = reserveReleaseGateHosts(root, 'gate-run', ['node-b']);
    try {
      const runner = fakeRunner();
      const io = sink();
      const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: 'agent@node-b' },
        explicitRemoteOnly: true, reservationRoot: root, remoteArgv: ['x'], runLocal: () => { throw new Error('must stay remote'); } },
      { runner, settings, env: {}, load1: 1, write: io.write });
      expect(rc).toBe(0);
      expect(runner.calls).toContainEqual(['ssh', 'node-c']);
      expect(io.err.join('')).toContain('agent@node-b reserved');
    } finally { release(); }
  });

  test('unreadable reservation evidence blocks both hosts without local fallback', async () => {
    const root = slotDir();
    const release = reserveReleaseGateHosts(root, 'gate-run', ['node-b']);
    release();
    writeFileSync(join(root, 'release', 'gate-host-reservations', 'broken.json'), '{broken');
    const runner = fakeRunner();
    const io = sink();
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: 'node-b' },
      explicitRemoteOnly: true, reservationRoot: root, remoteArgv: ['x'], runLocal: () => { throw new Error('must not run locally'); } },
    { runner, settings, env: {}, load1: 1, write: io.write });
    expect(rc).toBe(1);
    expect(runner.calls.some(call => call[0] === 'ssh')).toBe(false);
    expect(io.err.join('')).toContain('remote unmeasured on node-b (stage=host-reserved, rc=unknown) — host-reserved: node-b');
  });

  test('a reserved non-node-b request is refused without changing its explicit host', async () => {
    const root = slotDir();
    const release = reserveReleaseGateHosts(root, 'gate-run', ['msb2']);
    try {
      const runner = fakeRunner();
      const io = sink();
      const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: 'msb2' },
        explicitRemoteOnly: true, reservationRoot: root, remoteArgv: ['x'], runLocal: () => { throw new Error('must not run locally'); } },
      { runner, settings, env: {}, load1: 1, write: io.write });
      expect(rc).toBe(1);
      expect(runner.calls.some(call => call[0] === 'ssh')).toBe(false);
      expect(io.err.join('')).toContain('host-reserved: msb2');
      expect(io.err.join('')).not.toContain('using node-c');
    } finally { release(); }
  });

  test('an explicit remote request inside a remote child cannot silently run the local runner', async () => {
    const io = sink();
    let local = 0;
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, explicitRemoteOnly: true,
      remoteArgv: ['x'], runLocal: () => { local++; return 0; } },
      { runner: fakeRunner(), settings, env: { ELANOUS_GATE_REMOTE_CHILD: '1' }, load1: 1, write: io.write });
    expect(rc).toBe(1);
    expect(local).toBe(0);
    expect(io.err).toEqual(['[gate.remote] remote unmeasured on node-b (stage=placement, rc=unknown) — remote-child\n']);
  });

  test.each([
    ['SSH/remote infra', { runner: fakeRunner({ ssh: { rc: 255, stdout: '', stderr: 'ssh: timed out\nconnection lost' } }) }, 'stage=ssh, rc=255'],
    ['host-busy', { runner: fakeRunner({ ssh: { rc: 98, stdout: '', stderr: '__GATE_REMOTE_BUSY\n' } }) }, 'stage=host-busy, rc=98'],
  ])('%s refuses local execution with a clear reason', async (_case, setup, reason) => {
    const io = sink();
    let local = 0;
    const runner = 'runner' in setup ? setup.runner : fakeRunner();
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, explicitRemoteOnly: true,
      remoteArgv: ['x'],
      runLocal: () => { local++; return 0; } }, { runner, settings, env: {}, load1: 1, write: io.write });
    expect(rc).toBe(1);
    expect(local).toBe(0);
    expect(io.out.join('')).toBe('');
    if (_case === 'SSH/remote infra') {
      expect(io.err[0]).toContain(reason);
      expect(io.err[0]!.trimEnd().split('\n')).toHaveLength(1);
      expect(io.err[0]).toContain('remote unmeasured on node-b');
      expect(io.err[1]).toBe('ssh: timed out\nconnection lost\n');
    } else {
      expect(io.err[0]).toContain('[gate.remote] waiting on node-b — reason=host-busy');
      expect(io.err[1]).toContain('[gate.remote] wait ended on node-b — reason=deadline-slot-still-busy');
      expect(io.err[2]).toContain(reason);
      expect(io.err[2]).toContain('remote unmeasured on node-b');
    }
  });

  test('self gate runs locally only with an explicit --local request', async () => {
    let local = 0;
    const io = sink();
    const options = { tool: 'self-gate' as const, repo: '/r', remoteArgv: ['x'], runLocal: () => { local++; return 7; } };
    const runner = fakeRunner();
    const deps = { runner, settings, env: {}, load1: 1, write: io.write };
    expect(await dispatchHeavyCheck({ ...options, flags: { local: false } }, deps)).toBe(0);
    expect(runner.calls).toContainEqual(['ssh', 'node-b']);
    expect(local).toBe(0);
    expect(await dispatchHeavyCheck({ ...options, flags: { local: true } }, deps)).toBe(7);
    expect(local).toBe(1);
  });

  test('automatic self gate without a reproducible base falls back locally; explicit remote remains unmeasured', async () => {
    const runner = fakeRunner();
    let local = 0;
    const io = sink();
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', localOnlyReason: 'self gate without --base',
      flags: { local: false }, remoteArgv: ['x'], runLocal: () => { local++; return 7; } },
    { runner, settings, env: {}, load1: 1, write: io.write });
    expect(rc).toBe(7);
    expect(local).toBe(1);
    expect(runner.calls.length).toBe(0);
    expect(io.err.join('')).toContain('fallback to local');
  });


  test('automatic self gate remote failure stays unmeasured without local execution', async () => {
    const io = sink();
    let local = 0;
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false }, explicitRemoteOnly: false,
      remoteArgv: ['x'], runLocal: () => { local++; return 7; } },
      { runner: fakeRunner({ ssh: { rc: 255, stdout: '', stderr: 'ssh: timed out' } }), settings, env: {}, load1: 25, write: io.write });
    expect(rc).toBe(1);
    expect(local).toBe(0);
    expect(io.err.join('')).toContain('remote unmeasured on node-b (stage=ssh, rc=255) — ssh rc=255');
    expect(io.err.join('')).toContain('ssh: timed out');
  });

  test('remote success names its execution host without overriding the remote return code', async () => {
    const io = sink();
    let local = 0;
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: 'node-c' }, explicitRemoteOnly: true, reportRemoteHost: true,
      remoteArgv: ['x'], runLocal: () => { local++; return 0; } },
      { runner: fakeRunner({ ssh: { rc: 0, stdout: 'remote check\n', stderr: '\n__GATE_REMOTE_RC=3\n' } }), settings, env: {}, load1: 1, write: io.write });
    expect(rc).toBe(3);
    expect(local).toBe(0);
    expect(io.out.join('')).toBe('remote check\n');
    expect(io.err.join('')).toBe('[gate.remote] executed on node-c (rc=3)\n');
    const auto = sink();
    const autoRc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false }, reportRemoteHost: true, remoteArgv: ['x'],
      runLocal: () => { throw new Error('unexpected local check'); } },
      { runner: fakeRunner({ ssh: { rc: 0, stdout: 'automatic\n', stderr: '\n__GATE_REMOTE_RC=4\n' } }), settings, env: {}, load1: 25, write: auto.write });
    expect(autoRc).toBe(4);
    expect(auto.err.join('')).toBe('[gate.remote] executed on node-b (rc=4)\n');
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
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, explicitRemoteOnly: true, remoteArgv: ['x'], runLocal: () => { local++; return 0; } },
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

  test('a remote decision for a non-reproducible self gate invocation is unmeasured, not a local run', async () => {
    const runner = fakeRunner();
    const io = sink();
    let local = 0;
    const rc = await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', localOnlyReason: 'self gate without --base measures uncommitted files on this host', flags: { local: false, remote: true }, explicitRemoteOnly: true, remoteArgv: ['x'], runLocal: () => { local++; return 0; } },
      { runner, settings, env: {}, load1: 1, write: io.write });
    expect(rc).toBe(1);
    expect(local).toBe(0);
    expect(runner.calls.length).toBe(0);
    expect(io.err.join('')).toContain('remote unmeasured on node-b (stage=reproducibility, rc=unknown) — self gate without --base');
    // --local stays quiet: nothing was asked of a remote host.
    const quiet = sink();
    await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', localOnlyReason: 'x', flags: { local: true }, remoteArgv: ['x'], runLocal: () => 0 }, { runner, settings, env: {}, load1: 99, write: quiet.write });
    expect(quiet.err.join('')).toBe('');
  });

  test('the push is non-interactive and time-bounded; a hung push leaves self gate unmeasured', async () => {
    const seen: Array<{ timeoutMs?: number; env?: NodeJS.ProcessEnv }> = [];
    const base = fakeRunner();
    const runner: GateRemoteRunner = { ...base, local(cmd, args, cwd, options) {
      if (args[0] === 'push') { seen.push(options ?? {}); return { rc: null, stdout: '', stderr: '', error: 'Error: spawnSync git ETIMEDOUT' }; }
      return base.local(cmd, args, cwd, options);
    } };
    const io = sink();
    let local = 0;
    await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: true }, explicitRemoteOnly: true, remoteArgv: ['x'], runLocal: () => { local++; return 0; } },
      { runner, settings, env: {}, load1: 1, write: io.write });
    expect(local).toBe(0);
    expect(seen[0]!.timeoutMs).toBeGreaterThan(0);
    expect(seen[0]!.env!.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(io.err.join('')).toContain('push-failed');
  });

  test('explicit commit on a dirty worktree uses cat-file and pushes and checks out that commit without status or HEAD lookup', () => {
    const runner = fakeRunner({ dirty: true });
    const outcome = runOnRemote({ repo: '/r', host: 'node-b', mirror: '~/m.git', commit: MAIN, argv: ['x'] }, runner);
    expect(outcome).toMatchObject({ kind: 'ran', rc: 0, commit: MAIN });
    expect(runner.calls[0]).toEqual(['git', 'cat-file', '-t', MAIN]);
    expect(runner.calls.some((call) => call[1] === 'status' || call.includes('HEAD^{commit}'))).toBe(false);
    expect(runner.calls.find((call) => call[1] === 'push')).toContain(`${MAIN}:refs/elanous/gate/${MAIN}`);
    expect(runner.scripts[0]).toContain(`git checkout -q --detach ${MAIN}`);
  });

  test.each([
    ['short', 'abc', 'invalid-commit'],
    ['non-hex', 'g'.repeat(40), 'invalid-commit'],
    ['missing', MAIN, 'commit-missing'],
    ['non-commit object', MAIN, 'commit-missing'],
  ])('explicit commit %s returns infra without push or ssh', (label, commit, reason) => {
    const runner = fakeRunner({ object: label === 'missing' ? 'missing' : label === 'non-commit object' ? 'tree' : 'commit' });
    expect(runOnRemote({ repo: '/r', host: 'node-b', mirror: '~/m.git', commit, argv: ['x'] }, runner)).toEqual({ kind: 'infra', reason });
    expect(runner.calls.find((call) => call[1] === 'push')).toBeUndefined();
    expect(runner.scripts).toEqual([]);
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
        const r = spawnSync(cmd, fixed, { cwd, encoding: 'utf8', env: { ...(options?.env ?? process.env), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
        return { rc: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      },
      ssh(_host, script) {
        const r = spawnSync('sh', ['-s'], { input: script, encoding: 'utf8', env: hostEnv, cwd: root });
        return { rc: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      },
    };
    const tool = 'printf "%s|%s|" "$(git rev-parse HEAD)" "$(git rev-parse origin/main)"; cat marker.txt; test -s "$W/bun.calls" && echo installed; printf "tmp=%s scratch=%s\\n" "$TMPDIR" "$W"; echo "tool err" >&2; exit 3';
    const outcome = runOnRemote({ repo, host: 'h', mirror, argv: ['sh', '-c', tool], slotDir: join(root, 'slots') }, runner);
    expect(outcome).toMatchObject({ kind: 'ran', rc: 3, commit: head });
    if (outcome.kind !== 'ran') return;
    expect(outcome.stdout.toString().startsWith(`${head}|${base}|head\ninstalled\n`)).toBe(true);
    expect(outcome.stdout.toString()).toContain('tmp=/var/tmp scratch=/var/tmp/elanous-gate-remote-');
    expect(outcome.stderr.toString()).toBe('tool err\n');
    writeFileSync(join(repo, 'marker.txt'), 'dirty\n');
    const pinned = runOnRemote({ repo, host: 'h', mirror, commit: base, argv: ['sh', '-c', tool], slotDir: join(root, 'slots') }, runner);
    expect(pinned).toMatchObject({ kind: 'ran', rc: 3, commit: base });
    if (pinned.kind !== 'ran') return;
    expect(pinned.stdout.toString().startsWith(`${base}|${base}|base\ninstalled\n`)).toBe(true);
    expect(pinned.stdout.toString()).toContain('tmp=/var/tmp scratch=/var/tmp/elanous-gate-remote-');
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
  test('a valid --remote call reaches the dispatcher: missing origin/main refuses local measurement for tsc and self gate', () => {
    // A scratch repo with no origin/main: the dispatcher refuses before any push/ssh, so no host is contacted.
    const scratch = slotDir();
    spawnSync('git', ['init', '-q'], { cwd: scratch });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: scratch });
    // Drop the remote-child marker: when this suite itself runs inside a remote gate, it would (correctly) skip dispatch.
    const { ELANOUS_GATE_REMOTE_CHILD: _child, ...inherited } = process.env;
    const env = { ...inherited, NODE_ENV: 'test', ELANOUS_STATE_DIR: join(scratch, '.state') };
    mkdirSync(join(env.ELANOUS_STATE_DIR, 'release', 'gate-host-reservations'), { recursive: true });
    mkdirSync(join(scratch, '.elanous-test', 'release', 'gate-host-reservations'), { recursive: true });
    const tsc = spawnSync('bun', [join(repoRoot, 'scripts/ci-typecheck-changed.ts'), '--remote', 'node-b'], { cwd: scratch, encoding: 'utf8', env });
    expect(tsc.stderr).toContain('[tsc-gate] ⛔ 원격 판정 실패 원인 [base-env]');
    expect(tsc.stderr).toContain('merge-base(HEAD, origin/main) 을 이 트리에서 풀 수 없다');
    expect(tsc.stderr).toContain('node-b 를 띄우지 않는다');
    expect(tsc.status).toBe(2);
    const gate = spawnSync('bun', [join(repoRoot, 'bin/elanous.mjs'), '--test', 'self', 'gate', '--changed', '--base', 'HEAD', '--remote', 'node-b'], { cwd: scratch, encoding: 'utf8', env });
    expect(gate.stderr).toContain('[gate.remote] remote unmeasured on node-b (stage=preflight, rc=unknown) — origin-main-unresolved');
    expect(gate.status).toBe(1);
    expect(`${gate.stdout}${gate.stderr}`).not.toContain('gate: no changed files');
  });

  test('spawned self gate --remote preserves the SSH failure and never starts the local gate', async () => {
    await withFakeBins({ ssh: { stderr: 'ssh: isolated gate failure\noriginal detail: connection refused\n', exitCode: 255 } }, async (fakeBins) => {
    const scratch = slotDir();
    expect(spawnSync('git', ['init', '-q'], { cwd: scratch }).status).toBe(0);
    expect(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: scratch }).status).toBe(0);
    expect(spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: scratch }).status).toBe(0);
    mkdirSync(join(scratch, '.elanous-test', 'release', 'gate-host-reservations'), { recursive: true });
    writeFileSync(join(scratch, '.git', 'info', 'exclude'), 'bin/\n.elanous-test/\nlog/\n');
    const { ELANOUS_GATE_REMOTE_CHILD: _child, ...inherited } = fakeBins.env;
    const gate = spawnSync('bun', [join(repoRoot, 'bin/elanous.mjs'), '--test', 'self', 'gate', '--changed', '--base', 'HEAD', '--remote', 'isolated-host'], {
      cwd: scratch, encoding: 'utf8', env: { ...inherited, NODE_ENV: 'test' },
    });
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain('remote unmeasured on isolated-host (stage=push, rc=128)');
    expect(gate.stderr).toContain('ssh: isolated gate failure\noriginal detail: connection refused\n');
    const localRuns = (gate.stdout.match(/\[self gate\]/g) ?? []).length;
    expect(localRuns).toBe(0);
    expect(`${gate.stdout}${gate.stderr}`).not.toContain('[tsc-gate]');
    expect(gate.stdout).toBe('');
    console.log(`isolated self gate CLI: rc=${gate.status} local=${localRuns} stdout=${JSON.stringify(gate.stdout)} stderr=${JSON.stringify(gate.stderr)}`);
    const automatic = spawnSync('bun', [join(repoRoot, 'bin/elanous.mjs'), '--test', 'self', 'gate', '--changed', '--base', 'HEAD'], {
      cwd: scratch, encoding: 'utf8', env: { ...inherited, NODE_ENV: 'test' },
    });
    expect(automatic.status).toBe(1);
    expect(automatic.stderr).toContain('remote unmeasured on node-b (stage=push, rc=128)');
    expect(automatic.stderr).toContain('ssh: isolated gate failure\noriginal detail: connection refused\n');
    expect(automatic.stdout).toBe('');
    const local = spawnSync('bun', [join(repoRoot, 'bin/elanous.mjs'), '--test', 'self', 'gate', '--changed', '--base', 'HEAD', '--local'], {
      cwd: scratch, encoding: 'utf8', env: { ...inherited, NODE_ENV: 'test' },
    });
    expect(local.status).toBe(0);
    expect(local.stdout).toContain('[self gate] changed=0 base=HEAD reason=no-changes');
    expect((local.stdout.match(/\[self gate\]/g) ?? []).length).toBe(1);
    expect(`${local.stdout}${local.stderr}`).not.toContain('ssh: isolated gate failure');
    expect(fakeBins.calls().filter((call) => call.name === 'ssh').length).toBe(2);
    expect(fakeBins.calls()[0]?.argv).toContain('isolated-host');
    expect(fakeBins.calls()[1]?.argv).toContain('node-b');
    });
  });

  test('spawned self gate rejects --pr --remote before a mismatched PR head can be reported passed', async () => {
    // PR head and seat checkout intentionally differ. The fake remote would claim a third SHA passed;
    // the production CLI must reject this unreproducible combination without contacting either gh or SSH.
    const scratch = slotDir();
    expect(spawnSync('git', ['init', '-q'], { cwd: scratch }).status).toBe(0);
    expect(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'seat tree'], { cwd: scratch }).status).toBe(0);
    expect(spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: scratch }).status).toBe(0);
    const treeHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).stdout.trim();
    const requestedPrHead = 'c'.repeat(40);
    const reportedRemoteHead = 'd'.repeat(40);
    expect(treeHead).not.toBe(requestedPrHead);
    expect(reportedRemoteHead).not.toBe(requestedPrHead);
    expect(treeHead).not.toBe(reportedRemoteHead);
    mkdirSync(join(scratch, '.elanous-test', 'release', 'gate-host-reservations'), { recursive: true });
    writeFileSync(join(scratch, '.git', 'info', 'exclude'), 'bin/\n.elanous-test/\nlog/\n');

    await withFakeBins({
      gh: { stdout: JSON.stringify({ headRefOid: requestedPrHead, files: [{ path: 'src/example.ts' }] }) },
      ssh: { stdout: `gate: passed head=${reportedRemoteHead}\n`, stderr: '__GATE_REMOTE_RC=0\n' },
    }, async (fakeBins) => {
      const { ELANOUS_GATE_REMOTE_CHILD: _child, ...inherited } = fakeBins.env;
      // Keep the normal production CLI path; NODE_ENV=test activates test-only routing seams.
      const gate = spawnSync('bun', [join(repoRoot, 'bin/elanous.mjs'), '--test', 'self', 'gate', '--changed', '--base', 'HEAD', '--pr', '123', '--remote', 'isolated-host'], {
        cwd: scratch, encoding: 'utf8', env: { ...inherited, NODE_ENV: 'development' },
      });
      expect(gate.status).toBe(1);
      expect(gate.stdout).toBe('');
      expect(gate.stderr).toContain('remote unmeasured');
      expect(gate.stderr).toContain('--pr');
      expect(`${gate.stdout}${gate.stderr}`).not.toContain('gate: passed');
      expect(fakeBins.calls()).toEqual([]);
    });
  });

  test('the spawned self gate CLI reads the live release reservation from its selected state root', () => {
    const scratch = slotDir();
    const state = slotDir();
    spawnSync('git', ['init', '-q'], { cwd: scratch });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: scratch });
    const release = reserveReleaseGateHosts(state, 'graph-run-live', ['node-b']);
    try {
      const { ELANOUS_GATE_REMOTE_CHILD: _child, ...inherited } = process.env;
      const gate = spawnSync('bun', [join(repoRoot, 'bin/elanous.mjs'), '--config-dir', state, 'self', 'gate', '--changed', '--base', 'HEAD', '--remote', 'node-b'],
        { cwd: scratch, encoding: 'utf8', env: { ...inherited, NODE_ENV: 'test', ELANOUS_STATE_DIR: state } });
      expect(gate.status).toBe(1);
      expect(gate.stderr).toContain('node-b reserved (release gate graph-run-live holds node-b) — using node-c');
      expect(gate.stderr).toContain('remote unmeasured on node-c (stage=preflight, rc=unknown) — origin-main-unresolved');
    } finally { release(); }
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
