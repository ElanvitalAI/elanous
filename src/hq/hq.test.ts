import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { healthUrlFor, hqArbiterCheck, hqFenceDecision, hqHeartbeat, hqHostSet, hqLease, hqSeen, readLocal, readSeenGeneration } from './hq.js';
import { decideArbiterCheck, decideFence, fileLeaseStore, parseLease, probeReachable, sha, type HostProbe, type LeaseStore, type SshRunner } from './lease.js';

let dir = '';
let clock = 1_000_000;
const opRequests: Array<{ key: string; text: string }> = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hq-lease-')); clock = 1_000_000; opRequests.length = 0; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** In-memory arbiter store with a switch for «unreachable». */
function memStore(): LeaseStore & { raw: string | null; down: boolean } {
  const s = {
    raw: null as string | null, down: false,
    read() { if (s.down) throw new Error('arbiter unreachable'); return { now: clock, raw: s.raw }; },
    cas(expected: string | null, next: string) { if (s.down) throw new Error('arbiter unreachable'); if (sha(s.raw) !== sha(expected)) return false; s.raw = next; return true; },
  };
  return s;
}
/** Fake ssh: `reachable` lists hosts that answer; `files` answers `cat` of a standby's local state. */
type FakeSsh = SshRunner & { reachable: Set<string> };
function fakeSsh(reachable: Set<string>, files: Record<string, string> = {}): FakeSsh {
  const run = ((host: string, script: string) => {
    if (!reachable.has(host)) return { status: 255, stdout: '', stderr: 'ssh: connect timed out' };
    if (script.startsWith('cat ')) return { status: 0, stdout: files[host] ?? '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  }) as FakeSsh;
  run.reachable = reachable;
  return run;
}
/** Fake tailnet probe over the same reachability set (views and the arbiter check never use ssh). */
const fakeProbe = (reachable: Set<string>): HostProbe => ({ ping: (h) => reachable.has(h), health: () => false });
const logs: Array<[string, string]> = [];
const log = ((category: string, event: string) => { logs.push([category, event]); }) as never;
function deps(me: string, store: LeaseStore, ssh: FakeSsh) {
  return { config: { hostName: me, arbiter: 'cloud-vm', standby: 'node-b', ttlSeconds: 1500 }, store, ssh, probe: fakeProbe(ssh.reachable), hostPath: join(dir, 'host'), localPath: join(dir, `${me}.json`), now: () => clock, log,
    opRequest: (request: { key: string; text: string }) => { const created = !opRequests.some((row) => row.key === request.key); if (created) opRequests.push(request); return { key: request.key, created }; } };
}

describe('HQ host-local identity', () => {
  test('host file wins over replicated config in lease and fence; mismatch is observed', () => {
    const store = memStore();
    const d = deps('mbp', store, fakeSsh(new Set()));
    hqHostSet('node-b', d.hostPath);
    logs.length = 0;
    expect(hqLease('acquire', d).ok).toBe(true);
    expect(parseLease(store.raw)?.holder).toBe('node-b');
    expect(hqFenceDecision('cron', d)).toMatchObject({ run: true, holder: 'node-b' });
    expect(logs.filter(([category, event]) => category === 'hq.lease' && event === 'hostname-mismatch')).toHaveLength(2);
  });

  test('explicit lease --host wins over host-local identity and replicated config', () => {
    const store = memStore();
    const d = deps('mbp', store, fakeSsh(new Set()));
    hqHostSet('node-b', d.hostPath);
    expect(hqLease('acquire', d, { host: 'operator-host' }).ok).toBe(true);
    expect(parseLease(store.raw)?.holder).toBe('operator-host');
  });

  test('fence does not treat replicated mbp config as this node-b host', () => {
    const store = memStore();
    const mbp = deps('mbp', store, fakeSsh(new Set()));
    expect(hqLease('acquire', mbp).ok).toBe(true);
    hqHostSet('node-b', mbp.hostPath);
    expect(hqFenceDecision('cron', mbp)).toMatchObject({ run: false, reason: 'not-holder', holder: 'mbp' });
  });

  test('mismatch carries local and config values in one observation', () => {
    const store = memStore();
    const d = deps('mbp', store, fakeSsh(new Set()));
    hqHostSet('node-b', d.hostPath);
    const observations: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    hqLease('status', { ...d, log: ((category: string, event: string, data: Record<string, unknown>) => {
      observations.push({ category, event, data });
    }) as typeof d.log });
    expect(observations).toEqual([{ category: 'hq.lease', event: 'hostname-mismatch', data: { local: 'node-b', config: 'mbp' } }]);
  });

  test('matching local and config names cause no mismatch observation', () => {
    const store = memStore();
    const d = deps('mbp', store, fakeSsh(new Set()));
    hqHostSet('mbp', d.hostPath);
    logs.length = 0;
    expect(hqLease('acquire', d).ok).toBe(true);
    expect(parseLease(store.raw)?.holder).toBe('mbp');
    expect(logs.some(([category, event]) => category === 'hq.lease' && event === 'hostname-mismatch')).toBe(false);
  });

  test('local host wins even when config has no hostName', () => {
    const store = memStore();
    const d = deps('mbp', store, fakeSsh(new Set()));
    hqHostSet('node-b', d.hostPath);
    logs.length = 0;
    expect(hqLease('acquire', { ...d, config: {}, store }).ok).toBe(true);
    expect(parseLease(store.raw)?.holder).toBe('node-b');
    expect(logs.some(([category, event]) => category === 'hq.lease' && event === 'hostname-mismatch')).toBe(false);
  });

  test('absent host file preserves config then OS hostname fallback', () => {
    const store = memStore();
    const d = deps('mbp', store, fakeSsh(new Set()));
    logs.length = 0;
    expect(hqLease('acquire', d).ok).toBe(true);
    expect(parseLease(store.raw)?.holder).toBe('mbp');
    expect(logs.some(([category, event]) => category === 'hq.lease' && event === 'hostname-mismatch')).toBe(false);
    const other = memStore();
    expect(hqLease('acquire', { ...d, config: {}, store: other }).ok).toBe(true);
    expect(parseLease(other.raw)?.holder).toBe(hostname().replace(/\.local$/, ''));
  });

  test('host set writes one line at mode 600, including replacements, and rejects multiline names', () => {
    const path = join(dir, 'identity', 'host');
    expect(hqHostSet('node-b', path)).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('node-b\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(hqHostSet('mbp', path)).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('mbp\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => hqHostSet('mbp\nmsb1', path)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('mbp\n');
  });

  test('host set does not reuse a pre-existing world-readable pid temp file', () => {
    const path = join(dir, 'host');
    const oldTemp = `${path}.${process.pid}.tmp`;
    writeFileSync(oldTemp, 'untouched\n', { mode: 0o644 });
    expect(hqHostSet('node-b', path)).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('node-b\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(oldTemp, 'utf8')).toBe('untouched\n');
  });

  test('host set forces mode 600 even when process umask would remove owner bits', () => {
    const path = join(dir, 'host');
    const child = spawnSync('bun', ['-e', `import { hqHostSet } from ${JSON.stringify(join(import.meta.dir, 'hq.ts'))}; process.umask(0o777); hqHostSet('node-b', ${JSON.stringify(path)});`],
      { encoding: 'utf8', timeout: 60_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('node-b\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('CLI lease --host is explicit and wins over machine-local and config names', () => {
    const home = join(dir, 'machine');
    const configDir = join(dir, 'replicated-config');
    mkdirSync(join(home, '.elanous-hq'), { recursive: true });
    mkdirSync(configDir);
    writeFileSync(join(home, '.elanous-hq', 'host'), 'node-b\n');
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ hq: { hostName: 'mbp', arbiter: 'local' } }));
    const child = spawnSync('bun', [join(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir, 'hq', 'lease', 'acquire', '--host', 'operator-host', '--json'],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home } });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim().split('\n').at(-1)!)).toMatchObject({ ok: true, record: { holder: 'operator-host' } });
  }, 60_000);

  test('CLI hq host set writes the machine-local file, not the config universe', () => {
    const home = join(dir, 'machine');
    const configDir = join(dir, 'replicated-config');
    const result = spawnSync('bun', [join(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', configDir, 'hq', 'host', 'set', 'node-b'],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home } });
    expect(result.status, result.stderr).toBe(0);
    const path = join(home, '.elanous-hq', 'host');
    expect(readFileSync(path, 'utf8')).toBe('node-b\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }, 60_000);

  test('a one-line host file without a trailing newline still overrides replicated config', () => {
    const store = memStore();
    const d = deps('mbp', store, fakeSsh(new Set()));
    writeFileSync(d.hostPath, 'node-b', { mode: 0o600 });
    expect(hqLease('acquire', d).ok).toBe(true);
    expect(parseLease(store.raw)?.holder).toBe('node-b');
  });

  test('invalid existing host file fails closed instead of using replicated config', () => {
    const store = memStore();
    const d = deps('mbp', store, fakeSsh(new Set()));
    for (const text of ['node-b\nmbp\n', '', ' node-b\n', 'node-b\r\n']) {
      writeFileSync(d.hostPath, text);
      expect(() => hqLease('acquire', d)).toThrow('invalid host file');
      expect(() => hqFenceDecision('cron', d)).toThrow('invalid host file');
      expect(store.raw).toBeNull();
    }
  });

  test('existing host path that cannot be read fails closed instead of using replicated config', () => {
    const store = memStore();
    const d = deps('mbp', store, fakeSsh(new Set()));
    mkdirSync(d.hostPath);
    expect(() => hqLease('acquire', d)).toThrow();
    expect(() => hqFenceDecision('cron', d)).toThrow();
    expect(store.raw).toBeNull();
  });
});

describe('HQ lease (HQ-HB)', () => {
  test('two hosts racing acquire — exactly one wins and generation is 1', () => {
    const store = memStore();
    // Interleave: both read the empty record, then both try to write.
    const a = store.read(); const b = store.read();
    const first = store.cas(a.raw, JSON.stringify({ holder: 'mbp', generation: 1, acquiredAt: clock, renewedAt: clock, ttlSeconds: 1500 }));
    const second = store.cas(b.raw, JSON.stringify({ holder: 'node-b', generation: 1, acquiredAt: clock, renewedAt: clock, ttlSeconds: 1500 }));
    expect([first, second]).toEqual([true, false]);
    // Through the operation: the loser re-reads and is refused.
    const lost = hqLease('acquire', deps('node-b', store, fakeSsh(new Set())));
    expect(lost.ok).toBe(false);
    expect(parseLease(store.raw)?.holder).toBe('mbp');
  });

  test('the same race on the real file store: one CAS wins', () => {
    const store = fileLeaseStore(join(dir, 'lease.json'), () => clock);
    const a = store.read(); const b = store.read();
    expect(store.cas(a.raw, '{"holder":"mbp","generation":1,"acquiredAt":1,"renewedAt":1,"ttlSeconds":1500}\n')).toBe(true);
    expect(store.cas(b.raw, '{"holder":"node-b","generation":1,"acquiredAt":1,"renewedAt":1,"ttlSeconds":1500}\n')).toBe(false);
  });

  test('expired lease takeover increments generation; non-holder renew is refused', () => {
    const store = memStore();
    expect(hqLease('acquire', deps('mbp', store, fakeSsh(new Set()))).ok).toBe(true);
    expect(hqLease('renew', deps('node-b', store, fakeSsh(new Set()))).ok).toBe(false);
    expect(hqLease('acquire', deps('node-b', store, fakeSsh(new Set()))).ok).toBe(false);
    clock += 1501;
    const taken = hqLease('acquire', deps('node-b', store, fakeSsh(new Set())));
    expect(taken.ok).toBe(true);
    expect(parseLease(store.raw)).toMatchObject({ holder: 'node-b', generation: 2 });
  });

  test('heartbeat: holder renews, non-holder stays standby and reports its view of the holder', () => {
    const store = memStore();
    hqLease('acquire', deps('mbp', store, fakeSsh(new Set())));
    clock += 600;
    expect(hqHeartbeat(deps('mbp', store, fakeSsh(new Set()))).outcome).toBe('renewed');
    const standby = hqHeartbeat(deps('node-b', store, fakeSsh(new Set())));
    expect(standby).toMatchObject({ outcome: 'standby', holder: 'mbp', holderReachable: false });
    expect(parseLease(store.raw)?.views?.node-b).toMatchObject({ target: 'mbp', reachable: false, at: clock });
    expect(logs.some(([c, e]) => c === 'hq.lease' && e === 'standby')).toBe(true);
  });
});

describe('quorum (OP 08:40 rule ①②③)', () => {
  test('arbiter down but standby reachable → HQ keeps running', () => {
    const store = memStore();
    hqLease('acquire', deps('mbp', store, fakeSsh(new Set())));
    store.down = true;
    clock += 3000; // past TTL — the standby link alone keeps quorum
    const decided = hqFenceDecision('telegram-poller', deps('mbp', store, fakeSsh(new Set(['node-b']), { node-b: '{"generation":1}' })));
    expect(decided).toMatchObject({ run: true, reason: 'quorum-standby', generation: 1 });
  });

  test('arbiter and standby both down → runs within TTL, fences once TTL has expired', () => {
    const store = memStore();
    hqLease('acquire', deps('mbp', store, fakeSsh(new Set())));
    store.down = true;
    clock += 600;
    expect(hqFenceDecision('cron', deps('mbp', store, fakeSsh(new Set())))).toMatchObject({ run: true, reason: 'within-ttl' });
    clock += 1500;
    expect(hqFenceDecision('cron', deps('mbp', store, fakeSsh(new Set())))).toMatchObject({ run: false, reason: 'no-quorum-expired' });
  });

  test('arbiter promotes node-b only after 2 consecutive dual-unreachable checks', () => {
    const store = memStore();
    hqLease('acquire', deps('mbp', store, fakeSsh(new Set())));
    const base = deps('cloud-vm', store, fakeSsh(new Set(['node-b'])));
    const arbiter = { ...base, config: { ...base.config, autoPromote: { enabled: true, streak: 2 } }, promote: () => ({ ok: true, apply: true, host: 'node-b', lines: [] }) };
    clock += 600; hqHeartbeat(deps('node-b', store, fakeSsh(new Set()))); // node-b cannot reach mbp
    expect(hqArbiterCheck(arbiter)).toMatchObject({ promoted: false, streak: 1, holder: 'mbp' });
    clock += 600; hqHeartbeat(deps('node-b', store, fakeSsh(new Set())));
    expect(hqArbiterCheck(arbiter)).toMatchObject({ promoted: true, holder: 'node-b', generation: 2 });
    expect(parseLease(store.raw)).toMatchObject({ holder: 'node-b', generation: 2, promotedFrom: 'mbp' });
  });

  test('arbiter default files one OP seat request (not a CEO card) at streak 3 without changing the lease', () => {
    const store = memStore();
    hqLease('acquire', deps('mbp', store, fakeSsh(new Set())));
    const base = deps('cloud-vm', store, fakeSsh(new Set()));
    const proposalLogs: Array<[string, string]> = [];
    const arbiter = { ...base, promote: () => { throw new Error('default must not promote'); },
      log: ((category: string, event: string) => { proposalLogs.push([category, event]); }) as typeof base.log };
    for (let i = 1; i <= 4; i++) {
      clock += 600;
      hqHeartbeat(deps('node-b', store, fakeSsh(new Set())));
      expect(hqArbiterCheck(arbiter)).toMatchObject({ ok: true, promoted: false, streak: i, holder: 'mbp', generation: 1 });
      expect(opRequests).toHaveLength(i < 3 ? 0 : 1);
      expect(parseLease(store.raw)).toMatchObject({ holder: 'mbp', generation: 1 });
    }
    expect(opRequests[0]).toMatchObject({ key: 'hq:promote:mbp:1' });
    expect(proposalLogs.filter(([category, event]) => category === 'hq.arbiter' && event === 'promote-proposed')).toHaveLength(2);
  });

  test('arbiter opt-in calls promote on configured streak and retains the existing takeover behavior', () => {
    const store = memStore();
    hqLease('acquire', deps('mbp', store, fakeSsh(new Set())));
    const base = deps('cloud-vm', store, fakeSsh(new Set()));
    const calls: Array<[string, boolean]> = [];
    const arbiter = { ...base, config: { ...base.config, autoPromote: { enabled: true, streak: 4 } },
      promote: (host: string, apply: boolean) => { calls.push([host, apply]); return { ok: true, apply, host, lines: [] }; } };
    for (let i = 1; i <= 4; i++) {
      clock += 600;
      hqHeartbeat(deps('node-b', store, fakeSsh(new Set())));
      expect(hqArbiterCheck(arbiter)).toMatchObject({ promoted: i === 4, streak: i });
      expect(calls).toHaveLength(i === 4 ? 1 : 0);
    }
    expect(calls).toEqual([['node-b', true]]);
    expect(parseLease(store.raw)).toMatchObject({ holder: 'node-b', generation: 2 });
  });

  test('a failed promotion runbook is never reported as promoted and files an OP request', () => {
    for (const promote of [() => { throw new Error('runbook failed'); }, () => ({ ok: false, apply: true, host: 'node-b', lines: [{ step: '② stop', status: 'failed' as const, measurement: 'ssh refused', command: 'x' }] })]) {
      const store = memStore();
      hqLease('acquire', deps('mbp', store, fakeSsh(new Set())));
      const base = deps('cloud-vm', store, fakeSsh(new Set()));
      const arbiter = { ...base, config: { ...base.config, autoPromote: { enabled: true, streak: 1 } }, promote };
      clock += 600;
      hqHeartbeat(deps('node-b', store, fakeSsh(new Set())));
      logs.length = 0; opRequests.length = 0;
      const outcome = hqArbiterCheck(arbiter);
      expect(outcome).toMatchObject({ ok: true, promoted: false, streak: 1 });
      expect(outcome.runbookFailed).toBeTruthy();
      expect(parseLease(store.raw)).toMatchObject({ holder: 'node-b', generation: 2 });
      expect(logs).toContainEqual(['hq.arbiter', 'promote-runbook-failed']);
      expect(logs).not.toContainEqual(['hq.lease', 'promoted']);
      expect(opRequests).toHaveLength(1);
      expect(opRequests[0]!.key).toBe('hq:promote-failed:node-b:2');
    }
  });

  test('one dual-unreachable check, then the standby sees mbp again → streak resets, no takeover', () => {
    const store = memStore();
    hqLease('acquire', deps('mbp', store, fakeSsh(new Set())));
    const arbiter = deps('cloud-vm', store, fakeSsh(new Set(['node-b'])));
    clock += 600; hqHeartbeat(deps('node-b', store, fakeSsh(new Set())));
    expect(hqArbiterCheck(arbiter).streak).toBe(1);
    clock += 600; hqHeartbeat(deps('node-b', store, fakeSsh(new Set(['mbp']))));
    expect(hqArbiterCheck(arbiter)).toMatchObject({ promoted: false, streak: 0, holder: 'mbp' });
  });

  test('arbiter alone cannot promote: the standby still reaches mbp', () => {
    const r = decideArbiterCheck({ holder: 'mbp', generation: 1, acquiredAt: 0, renewedAt: 0, ttlSeconds: 1500, views: { node-b: { target: 'mbp', reachable: true, at: 100 } }, dualUnreachableStreak: 1 },
      { arbiter: 'cloud-vm', standby: 'node-b', arbiterReachesHolder: false, now: 200 });
    expect(r).toMatchObject({ promoted: false, streak: 0 });
  });

  test('old-generation host is blocked after takeover — via the arbiter and via the standby', () => {
    const store = memStore();
    hqLease('acquire', deps('mbp', store, fakeSsh(new Set())));
    const base = deps('cloud-vm', store, fakeSsh(new Set(['node-b'])));
    const arbiter = { ...base, config: { ...base.config, autoPromote: { enabled: true, streak: 2 } }, promote: () => ({ ok: true, apply: true, host: 'node-b', lines: [] }) };
    for (let i = 0; i < 2; i++) { clock += 600; hqHeartbeat(deps('node-b', store, fakeSsh(new Set()))); hqArbiterCheck(arbiter); }
    expect(hqHeartbeat(deps('node-b', store, fakeSsh(new Set()))).outcome).toBe('renewed');
    // mbp comes back with arbiter reachable: not the holder any more.
    expect(hqFenceDecision('conatus', deps('mbp', store, fakeSsh(new Set(['node-b'])))))
      .toMatchObject({ run: false, reason: 'not-holder', holder: 'node-b', generation: 2 });
    // mbp comes back with arbiter unreachable but node-b reachable: node-b reports generation 2 > 1.
    store.down = true;
    expect(hqFenceDecision('git-push', deps('mbp', store, fakeSsh(new Set(['node-b']), { node-b: JSON.stringify(readLocal(join(dir, 'node-b.json'))) }))))
      .toMatchObject({ run: false, reason: 'stale-generation', generation: 2 });
  });

  test('fence runs only for the holder; no lease → skip', () => {
    expect(decideFence({ me: 'mbp', now: 1, local: {}, record: null })).toMatchObject({ run: false, reason: 'no-lease' });
    const record = { holder: 'mbp', generation: 3, acquiredAt: 0, renewedAt: 0, ttlSeconds: 1500 };
    expect(decideFence({ me: 'mbp', now: 1, local: {}, record })).toMatchObject({ run: true, generation: 3 });
    expect(decideFence({ me: 'node-b', now: 1, local: { holder: 'node-b', generation: 2 }, record })).toMatchObject({ run: false, reason: 'not-holder' });
  });

  test('fail-open role runs without quorum but never against a newer generation', () => {
    const local = { holder: 'mbp', generation: 1, confirmedAt: 0, ttlSeconds: 10 };
    expect(decideFence({ me: 'mbp', now: 100, local, record: 'unreachable', standbyReachable: false, failOpen: true })).toMatchObject({ run: true, reason: 'fail-open' });
    expect(decideFence({ me: 'mbp', now: 100, local, record: 'unreachable', standbyReachable: true, standbyGeneration: 2, failOpen: true })).toMatchObject({ run: false, reason: 'stale-generation' });
  });
});

describe('tailnet probe (OP 10-04 09:04 — the arbiter never sshes into home machines)', () => {
  test('unreachable only when BOTH tailscale ping and nexus health fail', () => {
    expect(probeReachable('mbp', { ping: () => false, health: () => false }).reachable).toBe(false);
    expect(probeReachable('mbp', { ping: () => true, health: () => false }).reachable).toBe(true);
    expect(probeReachable('mbp', { ping: () => false, health: () => true }).reachable).toBe(true);
    expect(probeReachable('mbp', { ping: () => { throw new Error('no tailscale'); }, health: () => true }).reachable).toBe(true);
  });

  test('arbiter-check never invokes ssh — it decides from pushed views and its own tailnet probe', () => {
    const store = memStore();
    hqLease('acquire', deps('mbp', store, fakeSsh(new Set())));
    clock += 600; hqHeartbeat(deps('node-b', store, fakeSsh(new Set()))); // node-b pushes: mbp unreachable
    const noSsh: SshRunner = () => { throw new Error('arbiter must not ssh'); };
    let pinged = 0;
    const down: HostProbe = { ping: () => { pinged++; return false; }, health: () => false };
    const arbiter = { ...deps('cloud-vm', store, fakeSsh(new Set())), ssh: noSsh, probe: down };
    expect(hqArbiterCheck(arbiter)).toMatchObject({ promoted: false, streak: 1, ping: false, health: false });
    // Health alone answering keeps the holder alive (one probe success = reachable).
    const healthy: HostProbe = { ping: () => false, health: () => true };
    clock += 600; hqHeartbeat(deps('node-b', store, fakeSsh(new Set())));
    expect(hqArbiterCheck({ ...arbiter, probe: healthy })).toMatchObject({ promoted: false, streak: 0, health: true });
    expect(pinged).toBe(1);
  });

  test('health URL: pinned per host, else the tailnet MagicDNS name on the nexus port', () => {
    expect(healthUrlFor('mbp', { healthUrls: { mbp: 'https://x.example:9/v1/health' } }, () => 'tail.ts.net')).toBe('https://x.example:9/v1/health');
    expect(healthUrlFor('node-b', {}, () => 'tail.ts.net')).toBe('https://node-b.tail.ts.net:31415/v1/health');
    expect(healthUrlFor('node-b', { tailnetDomain: 'pinned.ts.net' }, () => 'tail.ts.net')).toBe('https://node-b.pinned.ts.net:31415/v1/health');
    expect(healthUrlFor('node-b', {}, () => undefined)).toBeUndefined();
  });
});

describe('ssh store remote script (run with local bash in place of ssh)', () => {
  test('read · cas · conflict work on the real remote script', async () => {
    const { sshLeaseStore } = await import('./lease.js');
    const local: SshRunner = (_host, script, input) => {
      const r = spawnSync('bash', ['-c', script], { input: input ?? '', encoding: 'utf8', env: { ...process.env, HOME: dir } });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    const store = sshLeaseStore('cloud-vm', local);
    const first = store.read();
    expect(first.raw).toBeNull();
    expect(Number.isFinite(first.now)).toBe(true);
    const a = '{"holder":"mbp","generation":1,"acquiredAt":1,"renewedAt":1,"ttlSeconds":1500}\n';
    expect(store.cas(null, a)).toBe(true);
    expect(store.read().raw).toBe(a);
    expect(store.cas(null, a.replace('mbp', 'node-b'))).toBe(false);
    expect(store.read().raw).toBe(a);
  });
});

describe('seen generation — the pre-drill default source only before any lease was ever seen (TC → MK 10-04 10:12)', () => {
  test('observing a record writes the max generation seen (600) · never lowers it', async () => {
    const store = memStore();
    const mbp = deps('mbp', store, fakeSsh(new Set(['node-b'])));
    expect(hqSeen(mbp).seen).toBe(false);
    hqLease('acquire', mbp);
    expect(readSeenGeneration(`${mbp.localPath}.seen-generation`)).toBe(1);
    expect(statSync(`${mbp.localPath}.seen-generation`).mode & 0o777).toBe(0o600);
    // An older record (generation rewound) never lowers the marker.
    store.raw = '{"holder":"mbp","generation":3,"acquiredAt":1,"renewedAt":' + clock + ',"ttlSeconds":1500}\n';
    hqLease('status', mbp);
    store.raw = '{"holder":"mbp","generation":2,"acquiredAt":1,"renewedAt":' + clock + ',"ttlSeconds":1500}\n';
    hqLease('status', mbp);
    expect(hqSeen(mbp)).toMatchObject({ seen: true, generation: 3 });
  });

  test('`hq seen` exits 3 when never seen and 0 after a record was observed', async () => {
    const seenFile = join(dir, 'seen-generation');
    const cfgDir = mkdtempSync(join(tmpdir(), 'hq-seen-cfg-'));
    try {
      writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ hq: { seenGenerationFile: seenFile } }));
      const run = () => spawnSync('bun', [join(import.meta.dir, '../../bin/elanous.mjs'), '--test', '--config-dir', cfgDir, 'hq', 'seen', '--json'],
        { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELANOUS_CONFIG_DIR: cfgDir, ELANOUS_STATE_DIR: cfgDir } });
      const never = run();
      expect(never.status, never.stderr).toBe(3);
      expect(JSON.parse(never.stdout.trim().split('\n').at(-1)!)).toMatchObject({ seen: false, generation: null });
      writeFileSync(seenFile, '4\n', { mode: 0o600 });
      const seen = run();
      expect(seen.status).toBe(0);
      expect(JSON.parse(seen.stdout.trim().split('\n').at(-1)!)).toMatchObject({ seen: true, generation: 4 });
    } finally { rmSync(cfgDir, { recursive: true, force: true }); }
  }, 120_000);

  test('fence: a vanished record after a seen generation is «unknown» → skipped as no-lease-after-seen', () => {
    const store = memStore();
    const mbp = deps('mbp', store, fakeSsh(new Set(['node-b'])));
    expect(hqFenceDecision('cron', mbp)).toMatchObject({ run: false, reason: 'no-lease' });
    hqLease('acquire', mbp);
    expect(hqFenceDecision('cron', mbp)).toMatchObject({ run: true, reason: 'holder' });
    store.raw = null; // gcp record wiped after the drill
    expect(hqFenceDecision('cron', mbp)).toMatchObject({ run: false, reason: 'no-lease-after-seen', generation: 1 });
    expect(decideFence({ me: 'mbp', now: clock, local: {}, record: null })).toMatchObject({ run: false, reason: 'no-lease' });
  });
});

describe('hq config block is read from config.json (was silently dropped)', () => {
  test('parseHqConfig keeps typed fields and drops invalid ones', async () => {
    const { parseHqConfig } = await import('../user-config.js');
    expect(parseHqConfig(undefined)).toBeUndefined();
    expect(parseHqConfig({ arbiter: 'gcpvm', hostName: ' mbp ', ttlSeconds: 900, failOpenRoles: ['cron', 'nope'], healthUrls: { mbp: 'https://x/v1/health', bad: 3 }, seenGenerationFile: '/tmp/s' }))
      .toEqual({ arbiter: 'gcpvm', hostName: 'mbp', ttlSeconds: 900, failOpenRoles: ['cron'], healthUrls: { mbp: 'https://x/v1/health' }, seenGenerationFile: '/tmp/s' });
    expect(parseHqConfig({ ttlSeconds: -1, arbiter: '' })).toBeUndefined();
    expect(parseHqConfig({ autoPromote: { enabled: true, streak: 4 } })).toEqual({ autoPromote: { enabled: true, streak: 4 } });
    expect(parseHqConfig({ autoPromote: { enabled: 'yes', streak: -2 } })).toBeUndefined();
    expect(parseHqConfig({ boardFencing: 'enforce' })).toEqual({ boardFencing: 'enforce' });
    expect(parseHqConfig({ boardFencing: 'invalid' })).toBeUndefined();
  });
});

test('arbiter «local» runs the same lease script on this host (drill 10-04: gcp has no ssh to itself)', async () => {
  const { localShellRunner, sshLeaseStore } = await import('./lease.js');
  const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'hq-local-'));
  const prev = process.env.HOME;
  process.env.HOME = dir;
  try {
    const store = sshLeaseStore('local', localShellRunner);
    expect(store.read().raw).toBeNull();
    expect(store.cas(null, '{"holder":"mbp","generation":1}')).toBe(true);
    expect(store.read().raw).toContain('"holder":"mbp"');
    expect(store.cas(null, '{"holder":"node-b","generation":1}')).toBe(false);
  } finally { process.env.HOME = prev; }
});
