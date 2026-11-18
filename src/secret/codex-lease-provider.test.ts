/**
 * HQ-VAULT V2 — the Codex provider consumes a mirror lease: uses it before expiry, fails LOUDLY «expired» after,
 * never refreshes and never falls back. FAKE values only (dummy strings · fake fetch · fake clock for issuance).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueCodexLease, type CodexLeaseDeps } from './codex-lease.js';
import { CodexLeaseExpiredError, _setCodexLeaseObserverForTesting } from './codex-lease-guard.js';
import { loadFreshCodexAuthState, readCodexOwnerMirrorForRun, _setCodexAuthObserverForTesting } from '../oauth/codex.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { setUserConfigOverlay } from '../user-config.js';
import { withFakeFetchDevice } from '../ux-sim/fake-fetch.js';
import { getProviderForConfig } from '../llm.js';
import type { UserConfig } from '../user-config/types.js';

const ACCESS = 'VAULTV2-PROV-FAKE-ACCESS-3b9e';
const REFRESH = 'VAULTV2-PROV-CANARY-REFRESH-77c1';
const HOUR = 3_600_000;

let root: string;
let events: string[];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_REMOTE_CODEX_ACCESS_ONLY', 'ELANOUS_CODEX_ACCOUNT', 'ELANOUS_LLM_MODE', 'NODE_ENV'];

const target = () => join(root, 'universes', 'u1');

function deps(t: number): CodexLeaseDeps {
  return {
    now: () => t, ownerHost: () => 'mshq', isOwnerHost: () => true,
    ownerStorePath: () => join(root, 'owner', 'auth.json'), stateRoot: () => join(root, 'owner-state'),
    allowedRoots: () => [join(root, 'universes')], allowedHosts: () => [],
    refreshOwnerAccount: async () => { throw new Error('unexpected refresh'); },
    ssh: () => { throw new Error('unexpected ssh'); }, newLeaseId: () => 'lease-prov-1',
  };
}

/** Issue a lease at fake time `t` from a fake owner store whose access lives `life` ms. */
async function leaseAt(t: number, life: number): Promise<void> {
  mkdirSync(join(root, 'owner'), { recursive: true });
  writeFileSync(join(root, 'owner', 'auth.json'), JSON.stringify({ version: 1, providers: { 'openai-codex': {
    tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: t + life }, authMode: 'chatgpt', lastRefresh: 'fake', chatGPT: { accountId: 'acct-fake' },
  } } }));
  await issueCodexLease({ to: target() }, deps(t));
}

const countingFetch = () => {
  let calls = 0;
  const fn = (async () => { calls++; throw new Error('no network in tests'); }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-v2-prov-'));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.HOME = join(root, 'home');
  process.env.XDG_CONFIG_HOME = join(root, 'home', '.config');
  process.env.CODEX_HOME = join(root, 'home', '.codex');
  delete process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY;
  delete process.env.ELANOUS_CODEX_ACCOUNT;
  setElanousConfigDir(target());
  setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, codexTokenOwnerHost: 'mshq' }, hq: { ...config.hq, hostName: 'mshq' } }));
  events = [];
  _setCodexLeaseObserverForTesting((event) => { events.push(event); });
  _setCodexAuthObserverForTesting(() => {});
});

afterEach(() => {
  resetElanousConfigDir();
  setUserConfigOverlay(null);
  _setCodexLeaseObserverForTesting(null);
  _setCodexAuthObserverForTesting(null);
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  rmSync(root, { recursive: true, force: true });
});

describe('owner-host universe (config dir holds the lease)', () => {
  test('before expiry: the leased access token is returned without any refresh call', async () => {
    await leaseAt(Date.now(), 8 * HOUR);
    const fetch = countingFetch();
    const state = await loadFreshCodexAuthState({ fetchImpl: fetch.fn });
    expect(state?.tokens.accessToken).toBe(ACCESS);
    expect(state?.tokens.refreshToken).toBe('');
    expect(fetch.calls()).toBe(0);
  });

  test('after expiry: typed «expired» error + secret.lease.expired, no refresh, no fallback', async () => {
    await leaseAt(Date.now() - 2 * 24 * HOUR, 1 * HOUR);
    const fetch = countingFetch();
    let caught: unknown;
    try { await loadFreshCodexAuthState({ fetchImpl: fetch.fn }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CodexLeaseExpiredError);
    expect(String(caught)).toContain('expired');
    expect(String(caught)).not.toContain(ACCESS);
    expect(fetch.calls()).toBe(0);
    expect(events).toContain('secret.lease.expired');
  });
});

describe('access-only consumer (non-owner path)', () => {
  function writeFreshHostMirror(): void {
    // A different, still-valid host mirror the consumer must NOT silently fall back to.
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const jwt = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 8 * 3600 })}.sig`;
    mkdirSync(process.env.CODEX_HOME!, { recursive: true });
    writeFileSync(join(process.env.CODEX_HOME!, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt, refresh_token: '' } }));
  }

  test('expired lease in the config dir throws «expired» instead of using the host mirror', async () => {
    process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = '1';
    writeFreshHostMirror();
    await leaseAt(Date.now() - 2 * 24 * HOUR, 1 * HOUR);
    expect(() => readCodexOwnerMirrorForRun()).toThrow(CodexLeaseExpiredError);
    expect(events).toContain('secret.lease.expired');
  });

  test('a live lease in the config dir is selected before the host mirror', async () => {
    process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = '1';
    writeFreshHostMirror();
    await leaseAt(Date.now(), 8 * HOUR);
    const picked = readCodexOwnerMirrorForRun();
    expect(picked.state.tokens.accessToken).toBe(ACCESS);
    expect(picked.storePath).toBe(join(target(), 'auth.json'));
  });
});

describe('provider request (fake fetch device)', () => {
  const run = async () => {
    process.env.ELANOUS_LLM_MODE = 'real';
    process.env.NODE_ENV = 'production';
    process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = '1'; // access-only consumer: never consults the HQ fence
    const provider = getProviderForConfig({ llm: { provider: 'openai-codex', model: 'gpt-6.1-terra' } } as UserConfig);
    return withFakeFetchDevice([{ url: 'https://chatgpt.com/backend-api/codex/responses', method: 'POST',
      response: () => new Response('fake-stop', { status: 418 }) }], async (device) => {
      let failure: unknown;
      try { for await (const _ of provider.streamChat!([{ role: 'user', content: 'probe' }])) { /* drain */ } }
      catch (error) { failure = error; }
      return { failure, calls: device.calls() };
    });
  };

  test('before expiry a model call goes out with the leased bearer token', async () => {
    await leaseAt(Date.now(), 8 * HOUR);
    const { calls } = await run();
    expect(calls).not.toHaveLength(0);
    expect(calls.some((c) => Object.entries(c.headers).some(([k, v]) => k.toLowerCase() === 'authorization' && v.includes(ACCESS)))).toBe(true);
    expect(calls.every((c) => !JSON.stringify(c).includes(REFRESH))).toBe(true);
  });

  test('after expiry no model call is made and the failure says «expired»', async () => {
    await leaseAt(Date.now() - 2 * 24 * HOUR, 1 * HOUR);
    const { failure, calls } = await run();
    expect(calls.length).toBe(0);
    expect(String(failure)).toContain('expired');
  });
});
