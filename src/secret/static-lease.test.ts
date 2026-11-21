/**
 * HQ-VAULT V3 — 정적 키 임대 시험. 가짜 키 · 가짜 ssh · 가짜 tailnet status · 가짜 시계만 쓴다(실 자격·실 호스트 0).
 * 공통 단언(설계 §7): canary 값이 stdout · 로그 · ssh argv · 임대 원장 · 메타에 0.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  issueStaticLease, parseTailnetIdentities, readStaticLeaseRecords, REMOTE_STATIC_LEASE_COMMAND, REMOTE_STATIC_LEASE_SCRIPT, renewStaticLease, resolveStaticLeaseItem,
  revokeStaticLeases, runStaticLeaseRenewUntil, leaseStaticKeysForCredPush, STATIC_LEASE_DEFAULT_TTL_MS, writeLocalStaticLeaseCopy,
  type StaticLeaseDeps, type StaticLeaseRecord, type StaticLeaseSshRunner,
} from './static-lease.js';
import {
  _resetStaticLeaseConsumerForTests, resolveStaticLeaseCopy, staticLeaseCopyPath, staticLeaseMetaPath, StaticLeaseExpiredError,
} from './static-lease-consumer.js';
import { registerSecretLeaseCommands } from '../cli/secret-lease-cli.js';
import { KNOWN_LOG_EVENT_NAMES } from '../cli/log-event-names.js';
import { _resetKeyCacheForTests, keyFromCacheOrEnv } from '../config.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { currentBackendId, getSecretAsync, useBackend } from '../nexus/config/secrets/index.js';

const CANARY = 'CANARY-vault-v3-9f3e2a7d-not-a-real-key';
const T0 = Date.parse('2026-11-17T00:00:00.000Z');
const HOUR = 3_600_000;

interface Rig {
  base: string;
  issuer: string;
  hqRoot: string;
  universe: string;
  clock: { now: number };
  logs: { category: string; event: string; data: Record<string, unknown>; level: string }[];
  sshCalls: { dest: string; script: string; stdin: string }[];
  sshStatus: number | null;
  peers: unknown;
  allowed: string[];
  deps: StaticLeaseDeps;
}

let rig: Rig;
let seq = 0;

function tailnet(peers: { HostName: string; DNSName: string; ips?: string[]; key?: string }[]): unknown {
  return {
    BackendState: 'Running',
    Self: { HostName: 'mshq', DNSName: 'mshq.tail-vault-v3.ts.net.' },
    Peer: Object.fromEntries(peers.map((p, i) => [`nodekey:${i}`, {
      HostName: p.HostName, DNSName: p.DNSName, TailscaleIPs: p.ips ?? [`100.64.0.${i + 2}`], PublicKey: p.key ?? `nodekey:fake-${p.HostName}`, Online: true,
    }])),
  };
}

beforeEach(() => {
  _resetStaticLeaseConsumerForTests();
  const base = mkdtempSync(join(tmpdir(), 'vault-v3-static-lease-'));
  const issuer = join(base, 'issuer-config');
  const hqRoot = join(base, 'hq');
  const universe = join(hqRoot, 'universes', 'res-1121');
  mkdirSync(issuer, { recursive: true });
  mkdirSync(universe, { recursive: true });
  const r: Rig = {
    base, issuer, hqRoot, universe,
    clock: { now: T0 },
    logs: [], sshCalls: [], sshStatus: 0,
    peers: tailnet([{ HostName: 'node-b', DNSName: 'node-b.tail-vault-v3.ts.net.' }]),
    allowed: ['node-b'],
    deps: {},
  };
  const ssh: StaticLeaseSshRunner = (dest, script, stdin) => { r.sshCalls.push({ dest, script, stdin }); return { status: r.sshStatus }; };
  r.deps = {
    configDir: () => issuer,
    now: () => r.clock.now,
    newLeaseId: () => `sl_vaultv3_${++seq}`,
    readSourceValue: async () => CANARY,
    policy: () => ({ allowedHosts: r.allowed }),
    tailnetStatus: () => r.peers,
    ssh,
    knownConfigRoots: () => [hqRoot],
    log: (category, event, data, level) => { r.logs.push({ category, event, data, level }); },
    sleep: async (ms) => { r.clock.now += ms; },
  };
  rig = r;
});

afterEach(() => {
  rmSync(rig.base, { recursive: true, force: true });
});

/** 값이 «나가면 안 되는» 모든 곳 — 로그 · ssh argv(대상·스크립트) · 원장 파일 · 받는 쪽 메타. */
function assertNoCanaryOutsideCopy(extra: string[] = []): void {
  expect(JSON.stringify(rig.logs)).not.toContain(CANARY);
  for (const call of rig.sshCalls) {
    expect(call.dest).not.toContain(CANARY);
    expect(call.script).not.toContain(CANARY);
  }
  const ledger = join(rig.issuer, 'secret-lease-ledger', 'static');
  if (existsSync(ledger)) for (const f of readdirSync(ledger)) expect(readFileSync(join(ledger, f), 'utf8')).not.toContain(CANARY);
  const metaDir = join(rig.universe, 'secrets-lease', 'meta');
  if (existsSync(metaDir)) for (const f of readdirSync(metaDir)) expect(readFileSync(join(metaDir, f), 'utf8')).not.toContain(CANARY);
  for (const text of extra) expect(text).not.toContain(CANARY);
}

describe('HQ-VAULT V3 static lease — issue', () => {
  test('config-dir target: 0600 copy · lease metadata · value-free record · issued event', async () => {
    const res = await issueStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.action).toBe('issued');
    const copy = staticLeaseCopyPath(rig.universe, 'openrouter_api_key');
    expect(readFileSync(copy, 'utf8').trim()).toBe(CANARY);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(statSync(join(rig.universe, 'secrets-lease')).mode & 0o777).toBe(0o700);
    const meta = JSON.parse(readFileSync(staticLeaseMetaPath(rig.universe, 'openrouter_api_key'), 'utf8'));
    expect(meta).toMatchObject({ leaseId: res.record.leaseId, kind: 'static', id: 'openrouter', issuedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 24 * HOUR).toISOString() });
    expect(statSync(staticLeaseMetaPath(rig.universe, 'openrouter_api_key')).mode & 0o777).toBe(0o600);
    const [record] = readStaticLeaseRecords(rig.issuer);
    expect(record).toMatchObject({ leaseId: res.record.leaseId, kind: 'static', id: 'openrouter', targetType: 'config-dir', expiresAt: meta.expiresAt });
    expect(record!.fingerprint8).toMatch(/^[0-9a-f]{8}$/);
    expect(rig.logs.map((l) => `${l.category}/${l.event}`)).toEqual(['secret/secret.lease.issued']);
    expect(rig.logs[0]!.data.kind).toBe('static');
    expect(rig.sshCalls).toHaveLength(0);
    assertNoCanaryOutsideCopy();
  });

  test('default lifetime is 24h (design D1 proposal)', () => {
    expect(STATIC_LEASE_DEFAULT_TTL_MS).toBe(24 * HOUR);
  });

  test('host target: allow-listed tailnet peer · ssh to MagicDNS name · value only on stdin', async () => {
    const res = await issueStaticLease({ id: 'OPENROUTER_API_KEY', to: 'node-b' }, rig.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(rig.sshCalls).toHaveLength(1);
    const call = rig.sshCalls[0]!;
    expect(call.dest).toBe('node-b.tail-vault-v3.ts.net');
    expect(call.script).toBe(REMOTE_STATIC_LEASE_COMMAND);
    expect(call.stdin).toContain(CANARY);   // 값의 유일한 통로
    expect(JSON.parse(call.stdin)).toMatchObject({ op: 'install', cacheName: 'openrouter_api_key', leaseId: res.record.leaseId });
    expect(res.record.targetIdentity?.tailnetName).toBe('node-b.tail-vault-v3.ts.net');
    expect(res.record.targetIdentity?.nodeKeyFingerprint8).toMatch(/^[0-9a-f]{8}$/);
    assertNoCanaryOutsideCopy();
  });

  test('cred-push seam: several keys in one call, each its own lease', async () => {
    const results = await leaseStaticKeysForCredPush({ to: 'node-b', keys: ['openrouter', 'zai'] }, rig.deps);
    expect(results.map((r) => r.ok && r.record.cacheName)).toEqual(['openrouter_api_key', 'zai_api_key']);
    expect(rig.sshCalls).toHaveLength(2);
    assertNoCanaryOutsideCopy();
  });
});

describe('HQ-VAULT V3 static lease — refusals (default deny)', () => {
  test('allow-list refusal: host not in allowedHosts → nothing written, refused event', async () => {
    rig.allowed = [];
    const res = await issueStaticLease({ id: 'openrouter', to: 'node-b' }, rig.deps);
    expect(res).toMatchObject({ ok: false, reason: 'not-allowlisted' });
    expect(rig.sshCalls).toHaveLength(0);
    expect(readStaticLeaseRecords(rig.issuer)).toHaveLength(0);
    expect(rig.logs.map((l) => l.event)).toEqual(['secret.lease.refused']);
    expect(rig.logs[0]!.data).toMatchObject({ kind: 'static', reason: 'not-allowlisted' });
  });

  test('non-tailnet refusal: allow-listed name that is not a tailnet peer', async () => {
    rig.allowed = ['aws9'];
    const res = await issueStaticLease({ id: 'openrouter', to: 'aws9' }, rig.deps);
    expect(res).toMatchObject({ ok: false, reason: 'not-tailnet' });
    expect(rig.sshCalls).toHaveLength(0);
  });

  test('tailnet status unavailable or stopped → refused, never «assume ok»', async () => {
    rig.peers = null;
    expect(await issueStaticLease({ id: 'openrouter', to: 'node-b' }, rig.deps)).toMatchObject({ ok: false, reason: 'tailnet-unmeasured' });
    rig.peers = { BackendState: 'Stopped', Peer: {} };
    expect(await issueStaticLease({ id: 'openrouter', to: 'node-b' }, rig.deps)).toMatchObject({ ok: false, reason: 'tailnet-unmeasured' });
    expect(parseTailnetIdentities('not json')).toBeNull();
    expect(rig.sshCalls).toHaveLength(0);
  });

  test('config-dir outside known roots, missing, or escaping via symlink → refused', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'vault-v3-outside-'));
    try {
      expect(await issueStaticLease({ id: 'openrouter', to: outside }, rig.deps)).toMatchObject({ ok: false, reason: 'config-dir-outside-roots' });
      expect(await issueStaticLease({ id: 'openrouter', to: join(rig.hqRoot, 'nope') }, rig.deps)).toMatchObject({ ok: false, reason: 'config-dir-missing' });
      const link = join(rig.hqRoot, 'escape');
      symlinkSync(outside, link);
      expect(await issueStaticLease({ id: 'openrouter', to: link }, rig.deps)).toMatchObject({ ok: false, reason: 'config-dir-outside-roots' });
      expect(existsSync(join(outside, 'secrets-lease'))).toBe(false);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  test('OAuth / unknown / multi-field items are not static leases', async () => {
    expect(resolveStaticLeaseItem('codex')).toMatchObject({ refused: 'not-static' });
    expect(resolveStaticLeaseItem('no-such-key')).toMatchObject({ refused: 'unknown-item' });
    expect(resolveStaticLeaseItem('kis')).toMatchObject({ refused: 'ambiguous-item' });
    expect(resolveStaticLeaseItem('KIS_APP_KEY')).toMatchObject({ id: 'kis', cacheName: 'kis_app_key' });
    expect(await issueStaticLease({ id: 'codex', to: rig.universe }, rig.deps)).toMatchObject({ ok: false, reason: 'not-static' });
  });

  test('ttl outside 1m..7d is refused', async () => {
    expect(await issueStaticLease({ id: 'openrouter', to: rig.universe, ttlMs: 8 * 24 * HOUR }, rig.deps)).toMatchObject({ ok: false, reason: 'invalid-ttl' });
  });

  test('a leased copy is never the source of another lease', async () => {
    const res = await issueStaticLease({ id: 'openrouter', to: rig.universe }, { ...rig.deps, readSourceValue: async () => ({ refused: 'source-is-lease' }) });
    expect(res).toMatchObject({ ok: false, reason: 'source-is-lease' });
  });
});

describe('HQ-VAULT V3 static lease — renew · revoke', () => {
  test('getSecretAsync resolves each KIS credential slot from its own lease', async () => {
    const previousBackend = currentBackendId();
    const values: Record<string, string> = { KIS_APP_KEY: 'FAKE-KIS-KEY-ONLY', KIS_APP_SECRET: 'FAKE-KIS-SECRET-ONLY' };
    const deps: StaticLeaseDeps = { ...rig.deps, now: Date.now, readSourceValue: async (item) => values[item.envName] };
    try {
      setElanousConfigDir(rig.universe);
      useBackend('file');
      const issued = await leaseStaticKeysForCredPush({ to: rig.universe, keys: ['KIS_APP_KEY', 'KIS_APP_SECRET'] }, deps);
      expect(issued.every((result) => result.ok)).toBe(true);
      expect((await getSecretAsync('cred:kis.app_key')) === values.KIS_APP_KEY).toBe(true);
      expect((await getSecretAsync('cred:kis.app_secret')) === values.KIS_APP_SECRET).toBe(true);
      assertNoCanaryOutsideCopy([JSON.stringify(issued)]);
    } finally {
      useBackend(previousBackend);
      resetElanousConfigDir();
    }
  });

  test('a revoked KIS slot cannot borrow the other live slot', async () => {
    const previousBackend = currentBackendId();
    const values: Record<string, string> = { KIS_APP_KEY: 'FAKE-KIS-KEY-ONLY', KIS_APP_SECRET: 'FAKE-KIS-SECRET-ONLY' };
    const deps: StaticLeaseDeps = { ...rig.deps, now: Date.now, readSourceValue: async (item) => values[item.envName] };
    try {
      setElanousConfigDir(rig.universe);
      useBackend('file');
      const issued = await leaseStaticKeysForCredPush({ to: rig.universe, keys: ['KIS_APP_KEY', 'KIS_APP_SECRET'] }, deps);
      expect(issued.every((result) => result.ok)).toBe(true);
      expect(await revokeStaticLeases({ to: rig.universe, id: 'KIS_APP_SECRET' }, deps)).toMatchObject([{ result: 'removed' }]);
      expect((await getSecretAsync('cred:kis.app_key')) === values.KIS_APP_KEY).toBe(true);
      await expect(getSecretAsync('cred:kis.app_secret')).rejects.toThrow(StaticLeaseExpiredError);
      assertNoCanaryOutsideCopy([JSON.stringify(issued)]);
    } finally {
      useBackend(previousBackend);
      resetElanousConfigDir();
    }
  });

  test('cred-push renew keeps both KIS env slots and their distinct receipts', async () => {
    const values: Record<string, string> = { KIS_APP_KEY: 'FAKE-KIS-KEY-ONLY', KIS_APP_SECRET: 'FAKE-KIS-SECRET-ONLY' };
    const deps: StaticLeaseDeps = { ...rig.deps, readSourceValue: async (item) => values[item.envName] };
    const first = await leaseStaticKeysForCredPush({ to: rig.universe, keys: ['KIS_APP_KEY', 'KIS_APP_SECRET'] }, deps);
    expect(first.every((x) => x.ok)).toBe(true);
    if (!first[0]?.ok || !first[1]?.ok) return;
    expect(first.map((x) => x.ok && x.record.envName)).toEqual(['KIS_APP_KEY', 'KIS_APP_SECRET']);
    expect(new Set(first.map((x) => x.ok && x.record.leaseId)).size).toBe(2);
    for (const result of first) {
      if (!result.ok) continue;
      expect(result.record.fingerprint8).toBe(createHash('sha256').update(values[result.record.envName]!).digest('hex').slice(0, 8));
      expect(readFileSync(staticLeaseCopyPath(rig.universe, result.record.cacheName), 'utf8').trim()).toBe(values[result.record.envName]);
    }
    rig.clock.now = T0 + 13 * HOUR;
    const renewed = await leaseStaticKeysForCredPush({ to: rig.universe, keys: ['KIS_APP_KEY', 'KIS_APP_SECRET'] }, deps);
    expect(renewed.map((x) => x.ok && [x.action, x.record.envName, x.record.leaseId])).toEqual(first.map((x) => x.ok && ['renewed', x.record.envName, x.record.leaseId]));
    expect(readStaticLeaseRecords(rig.issuer)).toHaveLength(2);
    const out: string[] = []; const err: string[] = []; const codes: number[] = [];
    const program = new Command().exitOverride();
    registerSecretLeaseCommands(program.command('secret'), { ...deps, output: { log: (s) => out.push(s), error: (s) => err.push(s) }, setExitCode: (c) => codes.push(c) });
    await program.parseAsync(['node', 'eln', 'secret', 'lease', 'KIS_APP_KEY,KIS_APP_SECRET', '--to', rig.universe, '--renew']);
    expect(codes).toEqual([0]);
    expect(err).toEqual([]);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('kis/KIS_APP_KEY');
    expect(out[1]).toContain('kis/KIS_APP_SECRET');
    expect(out[0]).toContain(first[0].record.leaseId);
    expect(out[1]).toContain(first[1].record.leaseId);
    expect(out.join('\n')).not.toContain(values.KIS_APP_KEY);
    expect(out.join('\n')).not.toContain(values.KIS_APP_SECRET);
  });

  test('pinned KIS renew and exact-slot revoke cannot cross to the other env slot', async () => {
    const deps: StaticLeaseDeps = { ...rig.deps, readSourceValue: async (item) => item.envName === 'KIS_APP_KEY' ? 'FAKE-KIS-KEY-ONLY' : 'FAKE-KIS-SECRET-ONLY' };
    const key = await issueStaticLease({ id: 'KIS_APP_KEY', to: rig.universe }, deps);
    const secret = await issueStaticLease({ id: 'KIS_APP_SECRET', to: rig.universe }, deps);
    if (!key.ok || !secret.ok) throw new Error('fixture issue failed');
    rig.clock.now = T0 + 13 * HOUR;
    expect(await renewStaticLease({ id: 'KIS_APP_SECRET', to: rig.universe, leaseId: key.record.leaseId }, deps)).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await revokeStaticLeases({ to: rig.universe, id: 'KIS_APP_SECRET' }, deps)).toEqual([{ leaseId: secret.record.leaseId, id: 'kis', target: secret.record.target, result: 'removed' }]);
    expect(await renewStaticLease({ id: 'KIS_APP_SECRET', to: rig.universe }, deps)).toMatchObject({ ok: false, reason: 'revoked' });
    expect(await renewStaticLease({ id: 'KIS_APP_KEY', to: rig.universe }, deps)).toMatchObject({ ok: true, action: 'renewed', record: { envName: 'KIS_APP_KEY', leaseId: key.record.leaseId } });
    expect(readFileSync(staticLeaseCopyPath(rig.universe, 'kis_app_key'), 'utf8').trim()).toBe('FAKE-KIS-KEY-ONLY');
    expect(existsSync(staticLeaseCopyPath(rig.universe, 'kis_app_secret'))).toBe(false);
  });

  test('an expired KIS secret does not block renewing the still-active key slot', async () => {
    const deps: StaticLeaseDeps = { ...rig.deps, readSourceValue: async (item) => item.envName === 'KIS_APP_KEY' ? 'FAKE-KIS-KEY-ONLY' : 'FAKE-KIS-SECRET-ONLY' };
    const key = await issueStaticLease({ id: 'KIS_APP_KEY', to: rig.universe }, deps);
    const secret = await issueStaticLease({ id: 'KIS_APP_SECRET', to: rig.universe, ttlMs: HOUR }, deps);
    if (!key.ok || !secret.ok) throw new Error('fixture issue failed');
    rig.clock.now = T0 + 13 * HOUR;
    expect(await renewStaticLease({ id: 'KIS_APP_SECRET', to: rig.universe }, deps)).toMatchObject({ ok: false, reason: 'expired' });
    expect(await renewStaticLease({ id: 'KIS_APP_KEY', to: rig.universe }, deps)).toMatchObject({ ok: true, action: 'renewed', record: { envName: 'KIS_APP_KEY', leaseId: key.record.leaseId } });
    expect(readStaticLeaseRecords(rig.issuer)).toHaveLength(2);
  });

  test('renew: fresh before 50%, same leaseId re-issued after 50%', async () => {
    const first = await issueStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps);
    if (!first.ok) throw new Error('issue failed');
    rig.clock.now = T0 + 1 * HOUR;
    expect(await renewStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps)).toMatchObject({ ok: true, action: 'fresh' });
    rig.clock.now = T0 + 13 * HOUR;
    const renewed = await renewStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps);
    expect(renewed).toMatchObject({ ok: true, action: 'renewed' });
    if (!renewed.ok) return;
    expect(renewed.record.leaseId).toBe(first.record.leaseId);
    expect(renewed.record.expiresAt).toBe(new Date(T0 + 37 * HOUR).toISOString());
    const meta = JSON.parse(readFileSync(staticLeaseMetaPath(rig.universe, 'openrouter_api_key'), 'utf8'));
    expect(meta.expiresAt).toBe(renewed.record.expiresAt);
    expect(rig.logs.map((l) => l.event)).toEqual(['secret.lease.issued', 'secret.lease.renewed']);
    assertNoCanaryOutsideCopy();
  });

  test('renew --until: an exiting loop (fake clock) that renews and then stops', async () => {
    const rounds: string[] = [];
    const last = await runStaticLeaseRenewUntil({ id: 'openrouter', to: rig.universe, untilMs: T0 + 30 * HOUR }, rig.deps, (r) => rounds.push(r.ok ? r.action : r.reason));
    expect(last.ok).toBe(true);
    expect(rounds).toEqual(['issued', 'renewed', 'renewed']);
    expect(rig.clock.now).toBe(T0 + 30 * HOUR);
  });

  test('#38086 must-fix: a running --renew --until loop never resurrects a revoked lease', async () => {
    let revokedOnce = false;
    const rounds: string[] = [];
    const deps: StaticLeaseDeps = {
      ...rig.deps,
      sleep: async (ms) => {
        rig.clock.now += ms;
        if (!revokedOnce) {
          revokedOnce = true;
          const [rec] = readStaticLeaseRecords(rig.issuer);
          expect(await revokeStaticLeases({ leaseId: rec!.leaseId }, rig.deps)).toMatchObject([{ result: 'removed' }]);
        }
      },
    };
    const last = await runStaticLeaseRenewUntil({ id: 'openrouter', to: rig.universe, untilMs: T0 + 30 * HOUR }, deps, (r) => rounds.push(r.ok ? r.action : r.reason));
    expect(last).toMatchObject({ ok: false, reason: 'revoked' });
    expect(rounds).toEqual(['issued', 'revoked']);
    expect(rig.clock.now).toBe(T0 + 12 * HOUR);   // 거절 즉시 나간다 — until 까지 돌지 않는다
    expect(new Set(readStaticLeaseRecords(rig.issuer).map((x) => x.leaseId)).size).toBe(1);
    expect(existsSync(staticLeaseCopyPath(rig.universe, 'openrouter_api_key'))).toBe(false);
    expect(rig.logs.at(-1)).toMatchObject({ event: 'secret.lease.refused', data: { kind: 'static', reason: 'revoked' } });
    assertNoCanaryOutsideCopy();
  });

  test('#38086 must-fix: one-shot --renew after revoke refuses (CLI rc 1), mints nothing, copy stays absent', async () => {
    const first = await issueStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps);
    if (!first.ok) throw new Error('issue failed');
    await revokeStaticLeases({ leaseId: first.record.leaseId }, rig.deps);
    rig.clock.now = T0 + 13 * HOUR;
    expect(await renewStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps)).toMatchObject({ ok: false, reason: 'revoked' });
    const out: string[] = []; const err: string[] = []; const codes: number[] = [];
    const program = new Command().exitOverride();
    registerSecretLeaseCommands(program.command('secret'), { ...rig.deps, output: { log: (l) => out.push(l), error: (l) => err.push(l) }, setExitCode: (c) => codes.push(c) });
    await program.parseAsync(['node', 'eln', 'secret', 'lease', 'openrouter', '--to', rig.universe, '--renew']);
    expect(codes).toEqual([1]);
    expect(err[0]).toContain('revoked');
    expect(readStaticLeaseRecords(rig.issuer).map((x) => x.leaseId)).toEqual([first.record.leaseId]);
    expect(existsSync(staticLeaseCopyPath(rig.universe, 'openrouter_api_key'))).toBe(false);
    expect(rig.logs.filter((l) => l.event === 'secret.lease.refused').every((l) => l.data.reason === 'revoked')).toBe(true);
    assertNoCanaryOutsideCopy([...out, ...err]);
  });

  test('#38086 must-fix: revoke-pending (host unreachable) also blocks renew — no new install over ssh', async () => {
    const first = await issueStaticLease({ id: 'openrouter', to: 'node-b' }, rig.deps);
    if (!first.ok) throw new Error('issue failed');
    rig.sshStatus = 255;
    expect(await revokeStaticLeases({ leaseId: first.record.leaseId }, rig.deps)).toMatchObject([{ result: 'pending' }]);
    rig.sshStatus = 0;
    rig.clock.now = T0 + 13 * HOUR;
    const sshBefore = rig.sshCalls.length;
    expect(await renewStaticLease({ id: 'openrouter', to: 'node-b' }, rig.deps)).toMatchObject({ ok: false, reason: 'revoked' });
    expect(await renewStaticLease({ id: 'openrouter', to: 'node-b', leaseId: first.record.leaseId }, rig.deps)).toMatchObject({ ok: false, reason: 'revoked' });
    expect(rig.sshCalls.length).toBe(sshBefore);
    expect(readStaticLeaseRecords(rig.issuer).map((x) => x.leaseId)).toEqual([first.record.leaseId]);
  });

  test('pinned renew of the same leaseId still works; an unknown pinned leaseId is refused, not minted', async () => {
    const first = await issueStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps);
    if (!first.ok) throw new Error('issue failed');
    rig.clock.now = T0 + 13 * HOUR;
    expect(await renewStaticLease({ id: 'openrouter', to: rig.universe, leaseId: first.record.leaseId }, rig.deps)).toMatchObject({ ok: true, action: 'renewed', record: { leaseId: first.record.leaseId } });
    expect(await renewStaticLease({ id: 'openrouter', to: rig.universe, leaseId: 'sl_vaultv3_ghost' }, rig.deps)).toMatchObject({ ok: false, reason: 'not-found' });
    expect(readStaticLeaseRecords(rig.issuer)).toHaveLength(1);
  });

  test('revoke by leaseId: copy removed, tombstone kept, record revokedAt, revoked event', async () => {
    const res = await issueStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps);
    if (!res.ok) throw new Error('issue failed');
    const out = await revokeStaticLeases({ leaseId: res.record.leaseId }, rig.deps);
    expect(out).toEqual([{ leaseId: res.record.leaseId, id: 'openrouter', target: res.record.target, result: 'removed' }]);
    expect(existsSync(staticLeaseCopyPath(rig.universe, 'openrouter_api_key'))).toBe(false);
    expect(JSON.parse(readFileSync(staticLeaseMetaPath(rig.universe, 'openrouter_api_key'), 'utf8')).revokedAt).toBeString();
    expect(readStaticLeaseRecords(rig.issuer)[0]!.revokedAt).toBeString();
    expect(rig.logs.at(-1)).toMatchObject({ event: 'secret.lease.revoked', data: { kind: 'static', result: 'removed' } });
    // 회수 뒤 소비자는 «없음»이 아니라 «회수됨»으로 시끄럽다
    expect(() => resolveStaticLeaseCopy('openrouter_api_key', { roots: [rig.universe], cacheFilePath: join(rig.base, 'cache', 'openrouter_api_key'), now: () => rig.clock.now })).toThrow(StaticLeaseExpiredError);
  });

  test('late revoke never deletes a newer lease (leaseId CAS)', async () => {
    const old = await issueStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps);
    if (!old.ok) throw new Error('issue failed');
    // 다른 원장(예: 다른 금고 판)이 같은 대상에 새 임대를 썼다
    const newer: StaticLeaseRecord = { ...old.record, leaseId: 'sl_vaultv3_newer' };
    writeLocalStaticLeaseCopy(rig.universe, newer, CANARY);
    const out = await revokeStaticLeases({ leaseId: old.record.leaseId }, rig.deps);
    expect(out).toEqual([{ leaseId: old.record.leaseId, id: 'openrouter', target: old.record.target, result: 'stale' }]);
    expect(readFileSync(staticLeaseCopyPath(rig.universe, 'openrouter_api_key'), 'utf8').trim()).toBe(CANARY);
  });

  test('host revoke: ssh revoke op; unreachable host stays revoke-pending', async () => {
    const res = await issueStaticLease({ id: 'openrouter', to: 'node-b' }, rig.deps);
    if (!res.ok) throw new Error('issue failed');
    rig.sshStatus = 255;
    expect(await revokeStaticLeases({ to: 'node-b' }, rig.deps)).toEqual([{ leaseId: res.record.leaseId, id: 'openrouter', target: 'node-b', result: 'pending' }]);
    expect(readStaticLeaseRecords(rig.issuer)[0]!.revokePending).toBe(true);
    rig.sshStatus = 0;
    expect(await revokeStaticLeases({ to: 'node-b', id: 'openrouter' }, rig.deps)).toEqual([{ leaseId: res.record.leaseId, id: 'openrouter', target: 'node-b', result: 'removed' }]);
    expect(JSON.parse(rig.sshCalls.at(-1)!.stdin)).toMatchObject({ op: 'revoke', leaseId: res.record.leaseId });
    assertNoCanaryOutsideCopy();
  });
});

describe('HQ-VAULT V3 static lease — consumer expiry is loud', () => {
  test('lease expiry between copy read and return refuses the value', async () => {
    const issued = await issueStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps);
    if (!issued.ok) throw new Error('issue failed');
    const cacheName = 'openrouter_api_key';
    const copy = JSON.parse(readFileSync(staticLeaseMetaPath(rig.universe, cacheName), 'utf8')).copyPath as string;
    let clock = rig.clock.now;
    expect(() => resolveStaticLeaseCopy(cacheName, {
      roots: [rig.universe], cacheFilePath: join(rig.base, 'cache', cacheName), now: () => clock,
      readFile: path => {
        const value = readFileSync(path, 'utf8');
        if (path === copy) clock = Date.parse(issued.record.expiresAt);
        return value;
      },
    })).toThrow(StaticLeaseExpiredError);
  });

  test('lease revoke between copy read and return refuses the value', async () => {
    const issued = await issueStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps);
    if (!issued.ok) throw new Error('issue failed');
    const cacheName = 'openrouter_api_key';
    const metaPath = staticLeaseMetaPath(rig.universe, cacheName);
    const copy = JSON.parse(readFileSync(metaPath, 'utf8')).copyPath as string;
    expect(() => resolveStaticLeaseCopy(cacheName, {
      roots: [rig.universe], cacheFilePath: join(rig.base, 'cache', cacheName), now: () => rig.clock.now,
      readFile: path => {
        const value = readFileSync(path, 'utf8');
        if (path === copy) writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, 'utf8')), revokedAt: new Date(rig.clock.now).toISOString() }), { mode: 0o600 });
        return value;
      },
    })).toThrow(StaticLeaseExpiredError);
  });

  test('a separate .elanous root cannot claim its HOME cache as the operating host lease', async () => {
    const issued = await issueStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps);
    if (!issued.ok) throw new Error('issue failed');
    const cacheName = 'openrouter_api_key';
    const fakeHome = join(rig.base, 'other-home');
    const separateRoot = join(fakeHome, '.elanous');
    const cacheDir = join(fakeHome, '.cache');
    const cacheFile = join(cacheDir, cacheName);
    mkdirSync(join(separateRoot, 'secrets-lease', 'meta'), { recursive: true, mode: 0o700 });
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(cacheFile, CANARY, { mode: 0o600 });
    const meta = JSON.parse(readFileSync(staticLeaseMetaPath(rig.universe, cacheName), 'utf8'));
    writeFileSync(staticLeaseMetaPath(separateRoot, cacheName), JSON.stringify({ ...meta, copyPath: cacheFile }), { mode: 0o600 });
    expect(() => resolveStaticLeaseCopy(cacheName, {
      roots: [separateRoot], cacheFilePath: cacheFile, now: () => rig.clock.now,
    })).toThrow(StaticLeaseExpiredError);
  });

  test('instance metadata accepts its own copy and refuses another instance copy', async () => {
    const issued = await issueStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps);
    if (!issued.ok) throw new Error('issue failed');
    const cacheName = 'openrouter_api_key';
    const deps = { roots: [rig.universe], cacheFilePath: join(rig.base, 'cache', cacheName), now: () => rig.clock.now };
    expect(resolveStaticLeaseCopy(cacheName, deps)?.value).toBe(CANARY);

    const other = join(rig.hqRoot, 'universes', 'another');
    const otherCopy = staticLeaseCopyPath(other, cacheName);
    mkdirSync(join(other, 'secrets-lease', 'copies'), { recursive: true, mode: 0o700 });
    writeFileSync(otherCopy, CANARY, { mode: 0o600 });
    const metaPath = staticLeaseMetaPath(rig.universe, cacheName);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    writeFileSync(metaPath, JSON.stringify({ ...meta, copyPath: otherCopy }), { mode: 0o600 });
    expect(() => resolveStaticLeaseCopy(cacheName, deps)).toThrow(StaticLeaseExpiredError);
    expect(() => resolveStaticLeaseCopy(cacheName, { ...deps, cacheFilePath: otherCopy })).toThrow(StaticLeaseExpiredError);
  });

  test('expired copy → typed error + one secret.lease.expired event, never the stale value', async () => {
    const res = await issueStaticLease({ id: 'openrouter', to: rig.universe }, rig.deps);
    if (!res.ok) throw new Error('issue failed');
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const deps = {
      roots: [rig.universe], cacheFilePath: join(rig.base, 'cache', 'openrouter_api_key'),
      now: () => rig.clock.now, log: (_c: string, event: string, data: Record<string, unknown>) => { events.push({ event, data }); },
    };
    expect(resolveStaticLeaseCopy('openrouter_api_key', deps)?.value).toBe(CANARY);
    rig.clock.now = T0 + 24 * HOUR;
    let caught: unknown;
    try { resolveStaticLeaseCopy('openrouter_api_key', deps); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(StaticLeaseExpiredError);
    expect((caught as StaticLeaseExpiredError).reason).toBe('expired');
    expect(String((caught as Error).message)).not.toContain(CANARY);
    expect(() => resolveStaticLeaseCopy('openrouter_api_key', deps)).toThrow(StaticLeaseExpiredError);
    expect(events.map((e) => e.event)).toEqual(['secret.lease.expired']);   // 같은 임대·이유는 1회
    expect(events[0]!.data).toMatchObject({ kind: 'static', reason: 'expired', leaseId: res.record.leaseId });
    expect(JSON.stringify(events)).not.toContain(CANARY);
  });

  test('config.ts key resolver: leased copy wins, then expiry throws instead of falling back to env or plain cache', async () => {
    const envName = 'VAULTV3_TEST_API_KEY';
    const cacheDir = join(rig.base, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, envName.toLowerCase()), 'plain-cache-vault-v3', { mode: 0o600 });
    const record: StaticLeaseRecord = {
      format: 'elanous-secret-lease/v1', leaseId: 'sl_vaultv3_cfg', kind: 'static', id: 'vaultv3-test', envName, cacheName: envName.toLowerCase(),
      target: rig.universe, targetType: 'config-dir', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 400).toISOString(),
      ttlMs: 400, fingerprint8: '00000000',
    };
    writeLocalStaticLeaseCopy(rig.universe, record, CANARY);
    const saved = { cache: process.env.ELANOUS_KEY_CACHE_DIR, keep: process.env.ELANOUS_KEEP_ENV_KEYS, env: process.env[envName] };
    process.env.ELANOUS_KEY_CACHE_DIR = cacheDir;
    delete process.env.ELANOUS_KEEP_ENV_KEYS;
    process.env[envName] = 'env-fallback-vault-v3';
    setElanousConfigDir(rig.universe);
    _resetKeyCacheForTests();
    try {
      expect(keyFromCacheOrEnv(envName)).toBe(CANARY);
      await new Promise((r) => setTimeout(r, 500));
      expect(() => keyFromCacheOrEnv(envName)).toThrow(StaticLeaseExpiredError);
    } finally {
      resetElanousConfigDir();
      _resetKeyCacheForTests();
      for (const [k, v] of [['ELANOUS_KEY_CACHE_DIR', saved.cache], ['ELANOUS_KEEP_ENV_KEYS', saved.keep], [envName, saved.env]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

describe('HQ-VAULT V3 static lease — CLI · events · remote script', () => {
  async function runCli(argv: string[]): Promise<{ out: string[]; err: string[]; codes: number[] }> {
    const out: string[] = []; const err: string[] = []; const codes: number[] = [];
    const program = new Command().exitOverride();
    const secret = program.command('secret');
    registerSecretLeaseCommands(secret, { ...rig.deps, output: { log: (l) => out.push(l), error: (l) => err.push(l) }, setExitCode: (c) => codes.push(c) });
    await program.parseAsync(['node', 'eln', 'secret', ...argv]);
    return { out, err, codes };
  }

  test('lease → list → revoke through the CLI prints names only (canary 0 on stdout/stderr)', async () => {
    const issued = await runCli(['lease', 'openrouter,zai', '--to', 'node-b']);
    expect(issued.codes).toEqual([0]);
    expect(issued.out).toHaveLength(2);
    expect(issued.out[0]).toContain('lease issued · openrouter/OPENROUTER_API_KEY → node-b');
    const listed = await runCli(['lease', 'list']);
    expect(listed.out.slice(1).map((l) => l.split('\t')[5])).toEqual(['active', 'active']);
    const refused = await runCli(['lease', 'openrouter', '--to', 'aws9']);
    expect(refused.codes).toEqual([1]);
    expect(refused.err[0]).toContain('not-allowlisted');
    const revoked = await runCli(['lease', 'revoke', '--to', 'node-b']);
    expect(revoked.codes).toEqual([0]);
    assertNoCanaryOutsideCopy([...issued.out, ...issued.err, ...listed.out, ...refused.err, ...revoked.out, ...revoked.err]);
  });

  test('secret.lease.* events are allow-listed (same names as V2 OAuth lease)', () => {
    for (const name of ['issued', 'renewed', 'revoked', 'expired', 'refused']) expect(KNOWN_LOG_EVENT_NAMES.has(`secret.lease.${name}`)).toBe(true);
  });

  test('remote script (run locally under a fake HOME, no ssh): 0600 copy, meta, CAS revoke', async () => {
    const fakeHome = join(rig.base, 'remote-home');
    mkdirSync(fakeHome, { recursive: true });
    const localSsh: StaticLeaseSshRunner = (dest, script, stdin) => {
      rig.sshCalls.push({ dest, script, stdin });
      // 원격의 `bun` 대신 이 시험을 돌리는 bun 그 자신(PATH 차이에 흔들리지 않게).
      const local = script.replace(/^umask 077; bun -e /, `umask 077; '${process.execPath}' -e `);
      const r = spawnSync('/bin/sh', ['-c', local], { input: stdin, env: { ...process.env, HOME: fakeHome }, encoding: 'utf8' });
      return { status: r.status };
    };
    const res = await issueStaticLease({ id: 'openrouter', to: 'node-b' }, { ...rig.deps, ssh: localSsh });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const copy = join(fakeHome, '.cache', 'openrouter_api_key');
    expect(readFileSync(copy, 'utf8').trim()).toBe(CANARY);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    const metaPath = join(fakeHome, '.elanous', 'secrets-lease', 'meta', 'openrouter_api_key.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    expect(meta).toMatchObject({ leaseId: res.record.leaseId, kind: 'static', copyPath: copy, expiresAt: res.record.expiresAt });
    expect(readFileSync(metaPath, 'utf8')).not.toContain(CANARY);
    // 받는 쪽 소비자 해석기가 이 메타를 그대로 집행한다
    const consumer = spawnSync(process.execPath, ['-e', [
      "import { resolveStaticLeaseCopy } from './src/secret/static-lease-consumer.ts';",
      "import { readFileSync } from 'node:fs'; import { homedir } from 'node:os'; import { join } from 'node:path';",
      "const home = homedir(); const copy = join(home, '.cache', 'openrouter_api_key');",
      "const meta = JSON.parse(readFileSync(join(home, '.elanous', 'secrets-lease', 'meta', 'openrouter_api_key.json'), 'utf8'));",
      "const result = resolveStaticLeaseCopy('openrouter_api_key', { roots: [join(home, '.elanous')], cacheFilePath: copy, now: () => Date.parse(meta.issuedAt) + 1000 });",
      "if (result?.value !== readFileSync(copy, 'utf8').trim()) process.exit(1);",
    ].join('\n')], { cwd: process.cwd(), env: { ...process.env, HOME: fakeHome }, encoding: 'utf8' });
    expect(consumer.stderr).toBe('');
    expect(consumer.status).toBe(0);
    expect(consumer.stdout + consumer.stderr).not.toContain(CANARY);
    expect(await revokeStaticLeases({ leaseId: res.record.leaseId }, { ...rig.deps, ssh: localSsh })).toMatchObject([{ result: 'removed' }]);
    expect(existsSync(copy)).toBe(false);
    expect(JSON.parse(readFileSync(metaPath, 'utf8')).revokedAt).toBeString();
    assertNoCanaryOutsideCopy();
  });
});

describe('remote static lease script — meta area relative to the remote HOME', () => {
  test('the remote script still writes meta under <remote HOME>/.elanous/secrets-lease/meta', () => {
    expect(REMOTE_STATIC_LEASE_SCRIPT).toContain('area=path.join(home,".elanous","secrets-lease","meta")');
    expect(REMOTE_STATIC_LEASE_SCRIPT).toContain('const home=os.homedir(),cacheDir=path.join(home,".cache")');
  });
});
