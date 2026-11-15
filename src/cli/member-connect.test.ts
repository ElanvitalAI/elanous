import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectApprovedMemberSession, type ApprovedMemberHandoff } from './member-connect.js';
import { readTuiMemberSession } from '../tui/member-session-contract.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const expiresAt = '2099-01-01T00:00:00.000Z';
const token = 'aps_syntheticIssuerOnly';
function handoff(fetchImpl: typeof fetch): ApprovedMemberHandoff {
  const configDir = mkdtempSync(join(tmpdir(), 'member-connect-'));
  roots.push(configDir);
  return { configDir, nexusUrl: 'https://api.elanous.ai', code: 'synthetic-code', state: 'synthetic-state',
    codeVerifier: 'synthetic-verifier', fetchImpl, now: () => Date.parse('2026-11-14T00:00:00.000Z') };
}

test('relay 404, outage and network failure retain the verified private member session for retry', async () => {
  for (const failure of ['missing', 'outage', 'network'] as const) {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/exchange')) return Response.json({ sessionToken: token, expiresAt, appSlot: { appSlug: 'demo-app' } });
      if (String(url).includes('/v1/members/owner')) return Response.json({ memberId: 'synthetic-owner' });
      if (failure === 'network') throw new Error('synthetic-private-server-error');
      return Response.json({ error: 'synthetic-private-server-error' }, { status: failure === 'missing' ? 404 : 503 });
    }) as typeof fetch;
    const input = handoff(fetchImpl);
    expect(await connectApprovedMemberSession(input)).toEqual({ expiresAt, relayKeyUnavailable: true });
    const path = join(input.configDir, 'member-session.json');
    expect(readTuiMemberSession(path, input.now!())?.appSlug).toBe('demo-app');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(input.configDir)).toEqual(['member-session.json']);
  }
});

test('only a server-exchanged app session with a verified owner becomes a private TUI envelope', async () => {
  const requests: Array<{ url: string; method: string; authorization: string | null; credentials?: RequestCredentials }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'), credentials: init?.credentials });
    if (requests.length === 1) {
      expect(JSON.parse(String(init?.body))).toEqual({ code: 'synthetic-code', state: 'synthetic-state',
        codeVerifier: 'synthetic-verifier' });
      return Response.json({ sessionToken: token, expiresAt, appSlot: { appSlug: 'demo-app' },
        memberId: 'untrusted-exchange-body' });
    }
    if (String(input).endsWith('/v1/member/keys')) return Response.json({ id: '11111111-1111-4111-8111-111111111111', key: 'emk_syntheticOnly' }, { status: 201 });
    return Response.json({ memberId: 'member-server-verified' });
  }) as typeof fetch;
  const input = handoff(fetchImpl);
  expect(await connectApprovedMemberSession(input)).toEqual({ expiresAt });
  expect(requests).toEqual([
    { url: 'https://api.elanous.ai/v1/members/app-slot/exchange', method: 'POST',
      authorization: null, credentials: 'omit' },
    { url: 'https://api.elanous.ai/v1/members/owner?appSlug=demo-app', method: 'GET',
      authorization: `Bearer ${token}`, credentials: 'omit' },
    { url: 'https://api.elanous.ai/v1/member/keys', method: 'POST',
      authorization: `Bearer ${token}`, credentials: 'omit' },
  ]);
  const file = join(input.configDir, 'member-session.json');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ nexusUrl: input.nexusUrl,
    sessionToken: token, expiresAt, appSlug: 'demo-app' });
  expect(readFileSync(file, 'utf8')).not.toContain('member-server-verified');
  expect(readFileSync(file, 'utf8')).not.toContain('untrusted-exchange-body');
  expect(readTuiMemberSession(file, input.now!())?.appSlug).toBe('demo-app');
  expect(readdirSync(input.configDir).filter(name => name === 'member-session.json' || name === 'config.json')).toEqual(['config.json', 'member-session.json']);
});

test('unconfigured issuer, denied owner, and untrusted origin never create a session file', async () => {
  for (const [response, expected] of [
    [Response.json({ error: 'members-not-configured', secret: 'private-sentinel' }, { status: 503 }), '설치 관리자'],
    [Response.json({ error: 'member-store-unavailable', secret: 'private-sentinel' }, { status: 503 }), '잠시 후'],
    [Response.json({ sessionToken: token, expiresAt, appSlot: { appSlug: 'demo-app' } }), '소유자를 확인'],
  ] as const) {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? response : Response.json({ error: 'unauthorized' }, { status: 401 })) as typeof fetch;
    const input = handoff(fetchImpl);
    await expect(connectApprovedMemberSession(input)).rejects.toThrow(expected);
    expect(existsSync(join(input.configDir, 'member-session.json'))).toBe(false);
    expect(readdirSync(input.configDir)).toEqual([]);
  }
  const input = handoff((async () => { throw new Error('network must not run'); }) as unknown as typeof fetch);
  await expect(connectApprovedMemberSession({ ...input, nexusUrl: 'http://remote.example.test' }))
    .rejects.toThrow('주소가 올바르지');
  expect(readdirSync(input.configDir)).toEqual([]);
});

test('an existing member envelope cannot be silently replaced or switched', async () => {
  let calls = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => { calls++;
    return init?.method === 'POST'
    ? Response.json({ sessionToken: token, expiresAt, appSlot: { appSlug: 'demo-app' } })
    : Response.json({ memberId: 'member-b' }); }) as typeof fetch;
  const input = handoff(fetchImpl);
  const file = join(input.configDir, 'member-session.json');
  writeFileSync(file, JSON.stringify({ nexusUrl: input.nexusUrl, sessionToken: 'aps_existingOwner',
    expiresAt, appSlug: 'other-app' }), { mode: 0o600 });
  chmodSync(file, 0o600);
  const original = readFileSync(file, 'utf8');
  await expect(connectApprovedMemberSession(input)).rejects.toThrow('이미 회원 연결');
  expect(calls).toBe(0);
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(readdirSync(input.configDir)).toEqual(['member-session.json']);
});

test('a linked destination or config directory cannot receive an exchanged session', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; throw new Error('network must not run'); }) as unknown as typeof fetch;
  const input = handoff(fetchImpl);
  const destination = join(input.configDir, 'member-session.json');
  symlinkSync(join(input.configDir, 'missing-target'), destination);
  await expect(connectApprovedMemberSession(input)).rejects.toThrow('이미 회원 연결');
  expect(calls).toBe(0);
  expect(readdirSync(input.configDir)).toEqual(['member-session.json']);

  const linkedDir = `${input.configDir}-link`;
  symlinkSync(input.configDir, linkedDir);
  roots.push(linkedDir);
  await expect(connectApprovedMemberSession({ ...input, configDir: linkedDir }))
    .rejects.toThrow('저장 경로가 안전하지');
  expect(calls).toBe(0);
});

test('a forged exchange reply cannot become a member session', async () => {
  for (const reply of [
    { sessionToken: 'local-owner-fake', expiresAt, appSlot: { appSlug: 'demo-app' } },
    { sessionToken: token, expiresAt: '2020-01-01T00:00:00.000Z', appSlot: { appSlug: 'demo-app' } },
    { sessionToken: token, expiresAt, appSlot: { appSlug: '../other-member' } },
  ]) {
    const input = handoff((async () => Response.json(reply)) as unknown as typeof fetch);
    await expect(connectApprovedMemberSession(input)).rejects.toThrow('응답이 올바르지');
    expect(readdirSync(input.configDir)).toEqual([]);
  }
});

test('expiry is rechecked after owner verification at the publication boundary', async () => {
  const expiry = Date.parse('2026-11-14T00:00:01.000Z');
  const expiredBoundaryDelta = 0;
  for (const delta of [-1, expiredBoundaryDelta]) {
    let clock = expiry - 1_000;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input).endsWith('/v1/member/keys')) return Response.json({ id: '11111111-1111-4111-8111-111111111111', key: 'emk_syntheticOnly' }, { status: 201 });
      if (init?.method === 'POST') return Response.json({ sessionToken: token,
        expiresAt: new Date(expiry).toISOString(), appSlot: { appSlug: 'demo-app' } });
      clock = expiry + delta;
      return Response.json({ memberId: 'member-server-verified' });
    }) as unknown as typeof fetch;
    const input = { ...handoff(fetchImpl), now: () => clock };
    const file = join(input.configDir, 'member-session.json');
    if (delta < expiredBoundaryDelta) {
      await expect(connectApprovedMemberSession(input)).resolves.toEqual({ expiresAt: new Date(expiry).toISOString() });
      expect(readTuiMemberSession(file, clock)?.appSlug).toBe('demo-app');
      expect(readdirSync(input.configDir).includes('config.json')).toBe(true);
    } else {
      await expect(connectApprovedMemberSession(input)).rejects.toThrow('안전하게 저장하지 못했습니다');
      expect(existsSync(file)).toBe(false);
      expect(readdirSync(input.configDir)).toEqual([]);
    }
  }
});
