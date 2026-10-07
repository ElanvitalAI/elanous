// POD-TOKEN-PREREFRESH (10-06) — an account whose access token expires within 3 h is pre-refreshed on the
// HQ lease holder, and dropped for the next account when that cannot happen. ⛔ temp dirs and fake tokens only.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { hostCredentials, podCodexCredentialWithPrerefresh, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';

const jwt = (hours: number) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + Math.round(hours * 3600) })).toString('base64url')}.sig-Ab_c-D3`;

function fakeKubectl() {
  const applied: Array<Record<string, any>> = [];
  const k: Kubectl = (args, input) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.join(' ').endsWith('apply -f -')) applied.push(JSON.parse(input!));
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { k, applied };
}

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A temp canonical store with team/third homes; `third` has `thirdHours` left. */
function fixture(thirdHours: number) {
  const root = mkdtempSync(join(tmpdir(), 'pod-prerefresh-'));
  roots.push(root);
  const providers: Record<string, unknown> = {};
  const homes: Record<string, string> = {};
  for (const [name, hours] of [['team', 200], ['third', thirdHours]] as const) {
    const home = join(root, name);
    mkdirSync(home);
    homes[name] = home;
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(hours), refresh_token: `rt-${name}.Xx-1_fake`, account_id: `id-${name}` } }));
    providers[`openai-codex:${name}`] = { codexHome: home, tokens: { accessToken: 'stale', refreshToken: `store-rt-${name}`, expiresAt: 1 } };
  }
  const store = join(root, 'auth.json');
  writeFileSync(store, JSON.stringify({ version: 1, providers }));
  const credentials = (name: string) => hostCredentials(name, store, () => 'gh');
  return { homes, credentials };
}

function launchedAccounts(applied: Array<Record<string, any>>): string[] {
  const secret = applied.find((m) => m.kind === 'Secret');
  if (!secret) return [];
  return Object.keys(secret.stringData).filter((k) => k.startsWith('codex-')).sort()
    .map((k) => /id-(\w+)/.exec(JSON.parse(JSON.parse(secret.stringData[k]).codexAuth).tokens.account_id)![1]!);
}

function captureObservations() {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const original = debug.log.bind(debug);
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'pod.credential-prerefresh') events.push({ event, data: data ?? {} });
    return original(category, event, data);
  }) as typeof debug.log);
  return { events, restore: () => spy.mockRestore() };
}

describe('POD-TOKEN-PREREFRESH — Pod launch account selection', () => {
  test('2.5 h left on the lease holder → one pre-refresh, then launch with the same account', async () => {
    const { homes, credentials } = fixture(2.5);
    const calls: string[] = [];
    const { k, applied } = fakeKubectl();
    const obs = captureObservations();
    try {
      const result = await podSelfImplementSpawn({
        kubectl: k, accountBroker: () => 'third', rotationAccounts: ['team', 'third'], credentials, env: {},
        hqLeaseHolder: () => true, codexPrerefreshLockPath: (name) => join(homes[name]!, '.refresh.lock'),
        codexPrerefresh: async (name) => {
          calls.push(name);
          writeFileSync(join(homes[name]!, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(240), refresh_token: `rt-${name}.Rotated-2_fake`, account_id: `id-${name}` } }));
          return { ok: true, beforeH: 2.5, afterH: 240 };
        },
      })({ feature: 'x', spaceId: 'prerefresh-ok' }).done;
      expect(result.exitCode).toBe(0);
    } finally { obs.restore(); }
    expect(calls).toEqual(['third']);
    expect(launchedAccounts(applied)).toEqual(['third', 'team']);
    const job = applied.find((m) => m.kind === 'Job')!;
    expect(job.spec.template.spec.containers[0].args[0]).toContain("export ELANOUS_CODEX_ACCOUNT='third'");
    expect(obs.events).toHaveLength(1);
    expect(obs.events[0]).toMatchObject({ event: 'refreshed', data: { account: 'third', outcome: 'refreshed', afterH: 240 } });
    expect(obs.events[0]!.data.beforeH as number).toBeCloseTo(2.5, 0);
    expect(JSON.stringify(applied)).not.toMatch(/rt-third|Rotated-2/);
  });

  test('pre-refresh fails → the account is dropped and the launch goes to the next account', async () => {
    const { homes, credentials } = fixture(2.5);
    const calls: string[] = [];
    const { k, applied } = fakeKubectl();
    const obs = captureObservations();
    try {
      const result = await podSelfImplementSpawn({
        kubectl: k, accountBroker: () => 'third', rotationAccounts: ['team', 'third'], credentials, env: {},
        hqLeaseHolder: () => true, codexPrerefreshLockPath: (name) => join(homes[name]!, '.refresh.lock'),
        codexPrerefresh: async (name) => { calls.push(name); return { ok: false, kind: 'refresh-failed', message: 'codex refresh failed: status=400' }; },
      })({ feature: 'x', spaceId: 'prerefresh-failed' }).done;
      expect(result.exitCode).toBe(0);
    } finally { obs.restore(); }
    expect(calls).toEqual(['third']);
    expect(launchedAccounts(applied)).toEqual(['team']);
    expect(applied.find((m) => m.kind === 'Job')!.spec.template.spec.containers[0].args[0]).toContain("export ELANOUS_CODEX_ACCOUNT='team'");
    expect(obs.events.map((e) => e.data.outcome)).toEqual(['refresh-failed', 'refresh-failed-recheck-failed']);
  });

  test('no HQ lease → zero refreshes and the next account', async () => {
    const { credentials } = fixture(2.5);
    let refreshes = 0;
    const { k, applied } = fakeKubectl();
    const obs = captureObservations();
    try {
      const result = await podSelfImplementSpawn({
        kubectl: k, accountBroker: () => 'third', rotationAccounts: ['team', 'third'], credentials, env: {},
        hqLeaseHolder: () => false,
        codexPrerefresh: async () => { refreshes++; return { ok: true, beforeH: 2.5, afterH: 240 }; },
      })({ feature: 'x', spaceId: 'prerefresh-no-lease' }).done;
      expect(result.exitCode).toBe(0);
    } finally { obs.restore(); }
    expect(refreshes).toBe(0);
    expect(launchedAccounts(applied)).toEqual(['team']);
    expect(obs.events.map((e) => e.data)).toEqual([{ account: 'third', beforeH: expect.any(Number), afterH: null, outcome: 'no-lease' }]);
  });

  test('a fresh account never asks the lease or the refresher; other credential errors still throw', async () => {
    const { credentials } = fixture(200);
    let asked = 0;
    const cred = await podCodexCredentialWithPrerefresh('third', { credentials, refresh: async () => { asked++; return { ok: true, beforeH: 0, afterH: 0 }; }, isLeaseHolder: () => { asked++; return true; }, log: () => {} });
    expect(cred).not.toBeNull();
    expect(asked).toBe(0);
    await expect(podCodexCredentialWithPrerefresh('ghost', { credentials, refresh: async () => ({ ok: true, beforeH: 0, afterH: 0 }), isLeaseHolder: () => true, log: () => {} })).rejects.toThrow('openai-codex:ghost');
  });
});

// PREREFRESH-LOCK (10-06 · post-review of #24449) — two runs on one host, one expiring account.
// ⛔ Assertions are boolean/structural only: no token-looking string ever reaches a failure message.
describe('PREREFRESH-LOCK — per-account refresh serialization', () => {
  function lockDeps(homes: Record<string, string>, credentials: (name: string) => ReturnType<typeof hostCredentials>, refresh: (name: string) => Promise<any>) {
    const events: string[] = [];
    const lockDir = mkdtempSync(join(tmpdir(), 'pod-prerefresh-lock-'));
    roots.push(lockDir);
    return {
      events,
      deps: {
        credentials, refresh, isLeaseHolder: () => true,
        log: (_c: string, event: string) => { events.push(event); },
        lockPath: (name: string) => join(lockDir, `${name}.lock`),
        lockOpts: { staleMs: 10_000, retryBusyMs: 5, maxTries: 2_000 },
      },
    };
  }
  const writeFresh = (home: string, name: string) => writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(240), refresh_token: `rt-${name}.Rotated-3_fake`, account_id: `id-${name}` } }));

  test('two concurrent pre-refreshes of the same account → one refresh, both get a credential', async () => {
    const { homes, credentials } = fixture(2.5);
    let calls = 0;
    const { deps, events } = lockDeps(homes, credentials, async (name) => {
      calls++;
      await new Promise((r) => setTimeout(r, 60));   // the window in which the race happened
      writeFresh(homes[name]!, name);
      return { ok: true, beforeH: 2.5, afterH: 240 };
    });
    const [a, b] = await Promise.all([podCodexCredentialWithPrerefresh('third', deps), podCodexCredentialWithPrerefresh('third', deps)]);
    expect(calls === 1).toBe(true);
    expect(a !== null && b !== null).toBe(true);
    expect([...events].sort()).toEqual(['refresh-skipped-already-fresh', 'refreshed']);
  });

  test('refresh fails but the re-check shows a fresh credential (a peer refreshed it) → account kept', async () => {
    const { homes, credentials } = fixture(2.5);
    const { deps, events } = lockDeps(homes, credentials, async (name) => {
      writeFresh(homes[name]!, name);   // a peer path rotated it first; ours then fails
      return { ok: false, kind: 'refresh-failed', message: 'codex refresh failed: status=400' };
    });
    const cred = await podCodexCredentialWithPrerefresh('third', deps);
    expect(cred !== null).toBe(true);
    expect(events).toEqual(['refresh-failed', 'refresh-failed-recheck-ok']);
  });

  test('refresh fails and the re-check is still stale → account dropped (old behaviour)', async () => {
    const { homes, credentials } = fixture(2.5);
    let calls = 0;
    const { deps, events } = lockDeps(homes, credentials, async () => { calls++; throw new Error('codex refresh failed: status=400'); });
    const cred = await podCodexCredentialWithPrerefresh('third', deps);
    expect(cred === null).toBe(true);
    expect(calls === 1).toBe(true);
    expect(events).toEqual(['refresh-failed', 'refresh-failed-recheck-failed']);
  });

  test('a named account whose lock path cannot be resolved is never refreshed without the lock', async () => {
    for (const lockPath of [() => { throw new Error('store unreadable'); }, () => null]) {
      const { homes, credentials } = fixture(2.5);
      let calls = 0;
      const { deps, events } = lockDeps(homes, credentials, async () => { calls++; return { ok: true, beforeH: 2.5, afterH: 240 }; });
      const cred = await podCodexCredentialWithPrerefresh('third', { ...deps, lockPath });
      expect(calls === 0).toBe(true);
      expect(cred === null).toBe(true);
      expect(events).toEqual(['lock-unavailable']);
    }
  });

  test('a lock file that cannot be created (real ENOENT) is lock-unavailable — no refresh, no throw', async () => {
    const { homes, credentials } = fixture(2.5);
    let calls = 0;
    const { deps, events } = lockDeps(homes, credentials, async () => { calls++; return { ok: true, beforeH: 2.5, afterH: 240 }; });
    const cred = await podCodexCredentialWithPrerefresh('third', { ...deps, lockPath: () => join(homes.third!, 'no-such-dir', 'x.lock') });
    expect(calls === 0).toBe(true);
    expect(cred === null).toBe(true);
    expect(events).toEqual(['lock-unavailable']);
  });

  test('while the refresh lock is held the lock file carries only lock metadata, never a credential', async () => {
    const { homes, credentials } = fixture(2.5);
    const { deps } = lockDeps(homes, credentials, async (name) => {
      const raw = readFileSync(deps.lockPath(name), 'utf8');
      // 잠금 파일은 «pid:uuid» 한 줄(소유 표지)뿐이어야 한다 — 자격 문자열이 섞이면 이 꼴이 깨진다(값은 단언 메시지에 싣지 않는다).
      lockSeen = /^\d+:[0-9a-f-]{36}\n$/.test(raw) ? 'pid-uuid-only' : 'unexpected';
      writeFresh(homes[name]!, name);
      return { ok: true, beforeH: 2.5, afterH: 240 };
    });
    let lockSeen = '';
    const cred = await podCodexCredentialWithPrerefresh('third', deps);
    expect(cred !== null).toBe(true);
    expect(lockSeen === 'pid-uuid-only').toBe(true);
  });

  test('the lock file lives next to the account home and holds no token', async () => {
    const { codexAccountRefreshLockPath } = await import('../../oauth/codex.js');
    const root = mkdtempSync(join(tmpdir(), 'pod-prerefresh-lockpath-'));
    roots.push(root);
    const home = join(root, 'third');
    mkdirSync(home);
    const store = join(root, 'auth.json');
    writeFileSync(store, JSON.stringify({ version: 1, providers: { 'openai-codex:third': { codexHome: home, tokens: { accessToken: 'x', refreshToken: 'y', expiresAt: 1 } } } }));
    const p = codexAccountRefreshLockPath('third', store);
    expect(p === join(home, '.elanous-prerefresh.lock')).toBe(true);
    expect(codexAccountRefreshLockPath('default', store) === null).toBe(true);
    expect(codexAccountRefreshLockPath('ghost', store) === null).toBe(true);
  });
});
