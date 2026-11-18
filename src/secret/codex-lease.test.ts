/**
 * HQ-VAULT V2 — Codex OAuth mirror lease. FAKE credentials only: dummy strings, a fake refresher, a fake clock,
 * a fake ssh runner. No real auth file, keychain, network or ssh is touched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  CODEX_LEASE_MAX_TTL_MS, CODEX_LEASE_TOKEN_MARGIN_MS, CodexLeaseRefusedError, issueCodexLease, revokeCodexLease,
  watchCodexLease, REMOTE_LEASE_SCRIPT, type CodexLeaseDeps, type LeaseSshRunner,
} from './codex-lease.js';
import {
  CodexLeaseExpiredError, CodexLeaseInvalidError, CodexLeaseRevokedError, _setCodexLeaseObserverForTesting, assertCodexLeaseUsable,
} from './codex-lease-guard.js';
import { readLeaseRecords, secretLeaseStorePath } from './lease-store.js';
import { registerSecretOauthLeaseCommands, runCodexOauthLease } from '../cli/secret-oauth-lease-cli.js';
import { KNOWN_LOG_EVENT_NAMES } from '../cli/log-event-names.js';

// Canary dummies — synthetic strings, never real credentials.
const ACCESS = 'VAULTV2-FAKE-ACCESS-7f3c';
const ACCESS_NEW = 'VAULTV2-FAKE-ACCESS-NEW-91aa';
const REFRESH = 'VAULTV2-CANARY-REFRESH-d41d8c';
const HOUR = 3_600_000;

let root: string;
let ownerStore: string;
let stateRoot: string;
let events: Array<{ event: string; data: Record<string, unknown> }>;
let savedHome: string | undefined;

function writeOwnerStore(entries: Record<string, unknown>): void {
  mkdirSync(join(ownerStore, '..'), { recursive: true });
  writeFileSync(ownerStore, JSON.stringify({ version: 1, providers: entries }), { mode: 0o600 });
}

function ownerEntry(expiresAt: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt }, authMode: 'chatgpt', lastRefresh: 'fake', chatGPT: { accountId: 'acct-fake' }, ...extra };
}

function fakeDeps(clock: { t: number }, over: Partial<CodexLeaseDeps> = {}): CodexLeaseDeps {
  let n = 0;
  return {
    now: () => clock.t,
    ownerHost: () => 'mshq',
    isOwnerHost: () => true,
    ownerStorePath: () => ownerStore,
    stateRoot: () => stateRoot,
    allowedRoots: () => [join(root, 'universes')],
    allowedHosts: () => ['node-b', 'node-c'],
    refreshOwnerAccount: async () => { throw new Error('unexpected refresh'); },
    ssh: () => { throw new Error('unexpected ssh'); },
    newLeaseId: () => `lease-fake-${++n}`,
    ...over,
  };
}

const target = () => join(root, 'universes', 'u1');
const leaseFile = () => join(target(), 'auth.json');
const readLease = () => JSON.parse(readFileSync(leaseFile(), 'utf8')) as { providers: Record<string, any> };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-v2-lease-'));
  ownerStore = join(root, 'owner', 'auth.json');
  stateRoot = join(root, 'owner-state');
  events = [];
  _setCodexLeaseObserverForTesting((event, data) => { events.push({ event, data }); });
  savedHome = process.env.HOME;
  process.env.HOME = join(root, 'home'); // the provider's default-root probe must never see a real home
});

afterEach(() => {
  _setCodexLeaseObserverForTesting(null);
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

describe('issue to an isolated config dir', () => {
  test('lease has no refresh token, mode 0600, and an expiry = min(token − margin, now + cap)', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    const result = await issueCodexLease({ to: target() }, fakeDeps(clock));
    expect(result.action).toBe('issued');
    expect(result.expiresAt).toBe(clock.t + 8 * HOUR - CODEX_LEASE_TOKEN_MARGIN_MS);
    const raw = readFileSync(leaseFile(), 'utf8');
    expect(raw).not.toContain(REFRESH);
    expect(statSync(leaseFile()).mode & 0o777).toBe(0o600);
    const entry = readLease().providers['openai-codex'];
    expect(entry.tokens.refreshToken).toBe('');
    expect(entry.tokens.refresh_token).toBe('');
    expect(entry.tokens.expiresAt).toBe(result.expiresAt);
    expect(entry.lease).toEqual({ leaseId: 'lease-fake-1', kind: 'oauth', provider: 'codex', owner: 'mshq', issuedAt: clock.t, expiresAt: result.expiresAt });
    // Ledger: values-free row.
    const ledgerRaw = readFileSync(secretLeaseStorePath(stateRoot), 'utf8');
    expect(ledgerRaw).not.toContain(REFRESH);
    expect(ledgerRaw).not.toContain(ACCESS);
    expect(statSync(secretLeaseStorePath(stateRoot)).mode & 0o777).toBe(0o600);
    expect(readLeaseRecords(secretLeaseStorePath(stateRoot))).toEqual([{ leaseId: 'lease-fake-1', kind: 'oauth', provider: 'codex', account: 'default',
      target: { kind: 'config-dir', path: target() }, owner: 'mshq', issuedAt: clock.t, expiresAt: result.expiresAt }]);
    expect(events.map((e) => e.event)).toEqual(['secret.lease.issued']);
  });

  test('a long-lived access token is capped at the D1 lifetime', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 10 * 24 * HOUR) });
    const result = await issueCodexLease({ to: target() }, fakeDeps(clock));
    expect(result.expiresAt).toBe(clock.t + CODEX_LEASE_MAX_TTL_MS);
  });

  test('a named account close to expiry is refreshed by the owner first (fake refresher)', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex:team': ownerEntry(clock.t + 1 * HOUR) });
    let refreshed = 0;
    const deps = fakeDeps(clock, { refreshOwnerAccount: async (account) => {
      refreshed++;
      expect(account).toBe('team');
      writeOwnerStore({ 'openai-codex:team': { ...ownerEntry(clock.t + 6 * HOUR), tokens: { accessToken: ACCESS_NEW, refreshToken: `${REFRESH}-rotated`, expiresAt: clock.t + 6 * HOUR } } });
    } });
    const result = await issueCodexLease({ to: target(), account: 'team' }, deps);
    expect(refreshed).toBe(1);
    expect(result.expiresAt).toBe(clock.t + 6 * HOUR - CODEX_LEASE_TOKEN_MARGIN_MS);
    const raw = readFileSync(leaseFile(), 'utf8');
    expect(raw).toContain(ACCESS_NEW);
    expect(raw).not.toContain(REFRESH);
  });
});

describe('refusals', () => {
  const refusedWith = async (p: Promise<unknown>, reason: string) => {
    let caught: unknown;
    try { await p; } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CodexLeaseRefusedError);
    expect(String((caught as CodexLeaseRefusedError).reason)).toBe(reason);
    expect(events.some((e) => e.event === 'secret.lease.refused' && e.data.reason === reason)).toBe(true);
  };

  test('caller is not the owner host', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    await refusedWith(issueCodexLease({ to: target() }, fakeDeps(clock, { isOwnerHost: () => false })), 'not-owner-host');
  });

  test('target outside the allow-list (config dir and host)', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    await refusedWith(issueCodexLease({ to: join(root, 'elsewhere', 'u') }, fakeDeps(clock)), 'target-not-allowed');
    await refusedWith(issueCodexLease({ to: 'gcp9' }, fakeDeps(clock)), 'target-not-allowed');
    await refusedWith(issueCodexLease({ to: 'relative/dir' }, fakeDeps(clock)), 'target-not-allowed');
  });

  test('the owner store directory is never a target', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    const deps = fakeDeps(clock, { allowedRoots: () => [root] });
    await refusedWith(issueCodexLease({ to: join(root, 'owner') }, deps), 'target-is-owner-store');
    await refusedWith(issueCodexLease({ to: join(root, 'universes', '.codex-team') }, deps), 'target-is-owner-store');
  });

  test('source holds no refresh token (a mirror cannot re-lend)', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': { ...ownerEntry(clock.t + 8 * HOUR), tokens: { accessToken: ACCESS, refreshToken: '', expiresAt: clock.t + 8 * HOUR }, source: 'mirror' } });
    await refusedWith(issueCodexLease({ to: target() }, fakeDeps(clock)), 'no-refresh-token');
  });

  test('access too close to expiry for the default account (never force-refreshed)', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 20 * 60_000) });
    await refusedWith(issueCodexLease({ to: target() }, fakeDeps(clock)), 'access-expiring');
  });

  test('a target that already holds a real refresh-owning login is not overwritten', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    mkdirSync(target(), { recursive: true });
    writeFileSync(leaseFile(), JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: 'x', refreshToken: 'VAULTV2-OTHER-LOGIN', expiresAt: 1 } } } }));
    await refusedWith(issueCodexLease({ to: target() }, fakeDeps(clock)), 'target-holds-refresh');
    expect(readFileSync(leaseFile(), 'utf8')).toContain('VAULTV2-OTHER-LOGIN');
  });
});

describe('renew · revoke · watch', () => {
  test('--renew is a no-op before the renew point and keeps the leaseId after it', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 30 * HOUR) });
    const deps = fakeDeps(clock);
    const first = await issueCodexLease({ to: target() }, deps);
    clock.t += 2 * HOUR;
    const fresh = await issueCodexLease({ to: target(), renew: true }, deps);
    expect(fresh.action).toBe('fresh');
    clock.t = first.renewAfter + 1;
    const renewed = await issueCodexLease({ to: target(), renew: true }, deps);
    expect(renewed.action).toBe('renewed');
    expect(renewed.leaseId).toBe(first.leaseId);
    expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt);
    expect(readLease().providers['openai-codex'].lease.expiresAt).toBe(renewed.expiresAt);
    expect(events.map((e) => e.event)).toEqual(['secret.lease.issued', 'secret.lease.renewed']);
    const [row] = readLeaseRecords(secretLeaseStorePath(stateRoot));
    expect(row?.renewCount).toBe(1);
  });

  test('revoke by leaseId tombstones the target entry; the consumer then fails «revoked»', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    const deps = fakeDeps(clock);
    const lease = await issueCodexLease({ to: target() }, deps);
    const result = revokeCodexLease({ leaseId: lease.leaseId }, deps);
    expect(result.revoked).toEqual([{ leaseId: lease.leaseId, target: target() }]);
    const entry = readLease().providers['openai-codex'];
    expect(entry.tokens.accessToken).toBe('');
    expect(readFileSync(leaseFile(), 'utf8')).not.toContain(ACCESS);
    expect(() => assertCodexLeaseUsable(entry, { now: clock.t })).toThrow(CodexLeaseRevokedError);
    expect(readLeaseRecords(secretLeaseStorePath(stateRoot))[0]?.revokedAt).toBe(clock.t);
    expect(events.filter((e) => e.event === 'secret.lease.revoked').length).toBe(2); // owner + consumer side
  });

  test('revoke by --to, and a second revoke is refused (no live lease)', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    const deps = fakeDeps(clock);
    await issueCodexLease({ to: target() }, deps);
    expect(revokeCodexLease({ to: target() }, deps).revoked.length).toBe(1);
    expect(() => revokeCodexLease({ to: target() }, deps)).toThrow(CodexLeaseRefusedError);
  });

  test('a fresh issue supersedes the older lease on the same target', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    const deps = fakeDeps(clock);
    await issueCodexLease({ to: target() }, deps);
    await issueCodexLease({ to: target() }, deps);
    const rows = readLeaseRecords(secretLeaseStorePath(stateRoot));
    expect(rows.map((r) => [r.leaseId, r.revokedAt !== undefined])).toEqual([['lease-fake-1', true], ['lease-fake-2', false]]);
  });

  test('watch mode renews on schedule and exits at --until (fake clock + fake sleep)', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 30 * HOUR) });
    const sleeps: number[] = [];
    const until = clock.t + 30 * HOUR;
    const ticks = await watchCodexLease({ to: target(), untilMs: until }, {
      ...fakeDeps(clock),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.t += ms;
        // The owner keeps its own token fresh (as the official refresh path would).
        writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 30 * HOUR) });
      },
    });
    // Lease 24 h (D1 cap) · renew at 50 % → wake at +12 h, +24 h, then the last 6 h up to --until.
    expect(ticks.map((t) => t.action)).toEqual(['issued', 'renewed', 'renewed']);
    expect(sleeps).toEqual([12 * HOUR, 12 * HOUR, 6 * HOUR]);
    expect(clock.t).toBe(until);
  });
});

describe('--ttl (short verification lease)', () => {
  test('a 5-minute lease is usable before and «expired» at its end; below the floor is refused', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    const deps = fakeDeps(clock);
    const lease = await issueCodexLease({ to: target(), ttlMs: 5 * 60_000 }, deps);
    expect(lease.expiresAt).toBe(clock.t + 5 * 60_000);
    const entry = readLease().providers['openai-codex'];
    expect(assertCodexLeaseUsable(entry, { now: lease.expiresAt - 1 })).toBe(entry);
    expect(() => assertCodexLeaseUsable(entry, { now: lease.expiresAt })).toThrow(CodexLeaseExpiredError);
    let caught: unknown;
    try { await issueCodexLease({ to: target(), ttlMs: 60_000 }, deps); } catch (error) { caught = error; }
    expect(String((caught as CodexLeaseRefusedError).reason)).toBe('bad-ttl');
  });
});

describe('consumer guard', () => {
  const marker = { leaseId: 'lease-x', kind: 'oauth', provider: 'codex', owner: 'mshq', issuedAt: 1000, expiresAt: 5000 };
  const entry = (over: Record<string, unknown> = {}) => ({ tokens: { accessToken: ACCESS, refreshToken: '', refresh_token: '', expiresAt: 5000 }, lease: marker, ...over });

  test('before expiry it passes through untouched', () => {
    const e = entry();
    expect(assertCodexLeaseUsable(e, { now: 4999 })).toBe(e);
    expect(events).toEqual([]);
  });

  test('at and after expiry it throws a typed «expired» error and logs secret.lease.expired', () => {
    for (const now of [5000, 9000]) {
      let caught: unknown;
      try { assertCodexLeaseUsable(entry(), { now }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(CodexLeaseExpiredError);
      expect((caught as Error).message).toContain('expired');
      expect((caught as CodexLeaseExpiredError).code).toBe('SECRET_LEASE_EXPIRED');
      expect((caught as Error).message).not.toContain(ACCESS);
    }
    expect(events.filter((e) => e.event === 'secret.lease.expired').length).toBe(2);
    expect(JSON.stringify(events)).not.toContain(ACCESS);
  });

  test('a lease carrying refresh authority or a malformed marker is rejected', () => {
    expect(() => assertCodexLeaseUsable(entry({ tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 5000 } }), { now: 1 })).toThrow(CodexLeaseInvalidError);
    expect(() => assertCodexLeaseUsable(entry({ lease: { leaseId: 'x' } }), { now: 1 })).toThrow(CodexLeaseInvalidError);
  });

  test('a non-lease entry is not the guard\'s business', () => {
    const plain = { tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 1 } };
    expect(assertCodexLeaseUsable(plain, { now: 10 })).toBe(plain);
  });
});

describe('remote host seam (fake ssh)', () => {
  test('the lease travels on stdin only; argv carries no value; refresh never travels', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    const calls: Array<{ host: string; script: string; stdin?: string }> = [];
    const ssh: LeaseSshRunner = (host, script, _t, stdin) => { calls.push({ host, script, stdin }); return { status: 0, stdout: '', stderr: '' }; };
    const result = await issueCodexLease({ to: 'node-b' }, fakeDeps(clock, { ssh }));
    expect(result.target).toBe('node-b:~/.elanous/remote-parent-credentials/cli-mirror');
    expect(calls.length).toBe(1);
    expect(calls[0]!.host).toBe('node-b');
    expect(calls[0]!.script).not.toContain(ACCESS);
    expect(calls[0]!.script).not.toContain(REFRESH);
    expect(calls[0]!.stdin).toContain(ACCESS);
    expect(calls[0]!.stdin).not.toContain(REFRESH);
  });

  test('remote refusal codes map to typed refusals; the owner host is never a target', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    const ssh: LeaseSshRunner = () => ({ status: 6, stdout: '', stderr: 'VAULTV2-REMOTE-STDERR' });
    let caught: unknown;
    try { await issueCodexLease({ to: 'node-c' }, fakeDeps(clock, { ssh })); } catch (error) { caught = error; }
    expect((caught as CodexLeaseRefusedError).reason).toBe('target-holds-refresh');
    expect((caught as Error).message).not.toContain('VAULTV2-REMOTE-STDERR');
    caught = undefined;
    try { await issueCodexLease({ to: 'node-b' }, fakeDeps(clock, { ownerHost: () => 'node-b' })); } catch (error) { caught = error; }
    expect((caught as CodexLeaseRefusedError).reason).toBe('target-is-owner-store');
  });

  test('the remote script installs, then CAS-revokes, in a fake HOME', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    const fakeHome = join(root, 'remote-home');
    mkdirSync(fakeHome, { recursive: true });
    const ssh: LeaseSshRunner = (_host, script, timeoutMs, stdin) => {
      const r = spawnSync('sh', ['-c', script], { input: stdin, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, HOME: fakeHome } });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const deps = fakeDeps(clock, { ssh });
    const lease = await issueCodexLease({ to: 'node-b' }, deps);
    const remoteFile = join(fakeHome, '.elanous', 'remote-parent-credentials', 'cli-mirror', 'auth.json');
    expect(statSync(remoteFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(remoteFile, 'utf8')).not.toContain(REFRESH);
    revokeCodexLease({ leaseId: lease.leaseId }, deps);
    const after = JSON.parse(readFileSync(remoteFile, 'utf8')) as { providers: Record<string, any> };
    expect(after.providers['openai-codex'].lease.revokedAt).toBe(clock.t);
    expect(after.providers['openai-codex'].tokens.accessToken).toBe('');
    expect(REMOTE_LEASE_SCRIPT).not.toContain(REFRESH);
  });
});

describe('CLI canary — no refresh token in stdout, stderr, events, lease file or ledger', () => {
  test('issue · renew · list · revoke through the command tree', async () => {
    const clock = { t: 1_800_000_000_000 };
    writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
    const out: string[] = [];
    const err: string[] = [];
    const deps = fakeDeps(clock);
    const run = async (...args: string[]) => {
      const program = new Command().exitOverride();
      registerSecretOauthLeaseCommands(program.command('secret'), { leaseDeps: async () => deps, out: (s) => out.push(s), err: (s) => err.push(s), sleep: async () => {} });
      await program.parseAsync(['node', 'eln', 'secret', 'oauth-lease', ...args]);
    };
    const savedExit = process.exitCode;
    try {
      await run('codex', '--to', target());
      await run('codex', '--to', target(), '--renew', '--json');
      await run('list');
      await run('codex', '--to', 'gcp9');
      await run('revoke', '--to', target());
    } finally { process.exitCode = savedExit ?? 0; }
    expect(out[0]).toContain('codex lease issued');
    expect(out[0]).toContain('refresh=미포함');
    expect(err.some((l) => l.includes('reason=target-not-allowed'))).toBe(true);
    const everything = [...out, ...err, JSON.stringify(events), readFileSync(leaseFile(), 'utf8'), readFileSync(secretLeaseStorePath(stateRoot), 'utf8')].join('\n');
    expect(everything).not.toContain(REFRESH);
    const printed = [...out, ...err, JSON.stringify(events), readFileSync(secretLeaseStorePath(stateRoot), 'utf8')].join('\n');
    expect(printed).not.toContain(ACCESS);
  });
});

test('V3 seam handler: runCodexOauthLease takes V3 LeaseOptions and returns a boolean', async () => {
  const clock = { t: 1_800_000_000_000 };
  writeOwnerStore({ 'openai-codex': ownerEntry(clock.t + 8 * HOUR) });
  const out: string[] = [];
  const err: string[] = [];
  const io = { leaseDeps: async () => fakeDeps(clock), out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  expect(await runCodexOauthLease({ to: target(), ttl: '30m' }, io)).toBe(true);
  expect(await runCodexOauthLease({ to: 'gcp9' }, io)).toBe(false);
  expect(out[0]).toContain('codex lease issued');
  expect(err[0]).toContain('reason=target-not-allowed');
  expect(events.every((e) => e.data.kind === 'oauth')).toBe(true);
  expect([...out, ...err, JSON.stringify(events)].join('\n')).not.toContain(REFRESH);
});

test('secret.lease.* events are registered', () => {
  for (const name of ['secret.lease.issued', 'secret.lease.renewed', 'secret.lease.revoked', 'secret.lease.expired', 'secret.lease.refused'])
    expect(KNOWN_LOG_EVENT_NAMES.has(name)).toBe(true);
});
