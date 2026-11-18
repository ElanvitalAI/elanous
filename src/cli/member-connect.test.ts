import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectApprovedMemberSession, disconnectMemberSession, type ApprovedMemberHandoff } from './member-connect.js';
import { readTuiMemberSession } from '../tui/member-session-contract.js';
import { debug } from '../debug/log.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const expiresAt = '2099-01-01T00:00:00.000Z';
const token = 'aps_syntheticIssuerOnly';
function handoff(fetchImpl: typeof fetch): ApprovedMemberHandoff {
  // The relay binding writer requires a canonical directory (macOS tmpdir is a /private symlink).
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'member-connect-')));
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
  let exchanges = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => { if (init?.method === 'POST') exchanges++;
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
  expect(exchanges).toBe(0);
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

// Failure paths of replacing a stored session after an app rename.
function stored(input: ApprovedMemberHandoff, body: Record<string, unknown>): string {
  const file = join(input.configDir, 'member-session.json');
  writeFileSync(file, JSON.stringify({ nexusUrl: input.nexusUrl, sessionToken: 'aps_previousSession', expiresAt, appSlug: 'old-name', ...body }), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
function serverWith(ownerCheck: (authorization: string | null) => Response | Promise<Response>): { fetchImpl: typeof fetch; exchanges: () => number } {
  let exchanges = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/exchange')) { exchanges++; return Response.json({ sessionToken: token, expiresAt, appSlot: { appSlug: 'new-name' } }); }
    if (String(url).includes('/v1/members/owner')) {
      const authorization = new Headers(init?.headers).get('authorization');
      return authorization === `Bearer ${token}` ? Response.json({ memberId: 'member-server-verified' }) : ownerCheck(authorization);
    }
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }) as typeof fetch;
  return { fetchImpl, exchanges: () => exchanges };
}

test('a stored session the server rejects after an app rename is replaced by the new name', async () => {
  const server = serverWith(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
  const input = handoff(server.fetchImpl);
  const file = stored(input, {});
  await connectApprovedMemberSession(input);
  expect(readTuiMemberSession(file, input.now!())).toMatchObject({ sessionToken: token, appSlug: 'new-name' });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readdirSync(input.configDir)).toEqual(['member-session.json']);
});

test('an expired stored session is replaced without asking the server about it', async () => {
  const server = serverWith(() => { throw new Error('expired session must not be checked'); });
  const input = handoff(server.fetchImpl);
  const file = stored(input, { expiresAt: '2000-01-01T00:00:00.000Z' });
  await connectApprovedMemberSession(input);
  expect(readTuiMemberSession(file, input.now!())?.appSlug).toBe('new-name');
});

test('a stored session the server still accepts is kept and no exchange is spent', async () => {
  const server = serverWith(() => Response.json({ memberId: 'member-a' }));
  const input = handoff(server.fetchImpl);
  const file = stored(input, {});
  const original = readFileSync(file, 'utf8');
  await expect(connectApprovedMemberSession(input)).rejects.toThrow('이미 회원 연결');
  expect(server.exchanges()).toBe(0);
  expect(readFileSync(file, 'utf8')).toBe(original);
});

test('when the stored session cannot be checked (outage or network failure) it is kept', async () => {
  for (const failure of ['outage', 'network'] as const) {
    const server = serverWith(() => {
      if (failure === 'network') throw new Error('synthetic network failure');
      return Response.json({ error: 'down' }, { status: 503 });
    });
    const input = handoff(server.fetchImpl);
    const file = stored(input, {});
    const original = readFileSync(file, 'utf8');
    await expect(connectApprovedMemberSession(input)).rejects.toThrow('이미 회원 연결');
    expect(server.exchanges()).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
  }
});

test('a rejected stored session is replaced only when the new session is verified (write failure keeps the old file)', async () => {
  const server = serverWith(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
  const input = handoff((async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('/v1/members/owner') && new Headers(init?.headers).get('authorization') === `Bearer ${token}`)
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    return server.fetchImpl(url, init);
  }) as typeof fetch);
  const file = stored(input, {});
  const original = readFileSync(file, 'utf8');
  await expect(connectApprovedMemberSession(input)).rejects.toThrow();
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(readdirSync(input.configDir)).toEqual(['member-session.json']);
});

test('a stored session file that is not private or is a link is never replaced', async () => {
  const server = serverWith(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
  const input = handoff(server.fetchImpl);
  const target = join(input.configDir, 'elsewhere.json');
  writeFileSync(target, '{}', { mode: 0o600 });
  symlinkSync(target, join(input.configDir, 'member-session.json'));
  await expect(connectApprovedMemberSession(input)).rejects.toThrow('이미 회원 연결');
  expect(readFileSync(target, 'utf8')).toBe('{}');
  expect(server.exchanges()).toBe(0);
});

test('a malformed stored session file is kept, not treated as stale', async () => {
  const server = serverWith(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
  const input = handoff(server.fetchImpl);
  const file = join(input.configDir, 'member-session.json');
  writeFileSync(file, JSON.stringify({ synthetic: 'not-a-session' }), { mode: 0o600 });
  await expect(connectApprovedMemberSession(input)).rejects.toThrow('이미 회원 연결');
  expect(server.exchanges()).toBe(0);
  expect(readFileSync(file, 'utf8')).toBe(JSON.stringify({ synthetic: 'not-a-session' }));
});

test('an expired file that is not a complete envelope is kept', async () => {
  const server = serverWith(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
  const input = handoff(server.fetchImpl);
  const file = join(input.configDir, 'member-session.json');
  const body = JSON.stringify({ sessionToken: 'aps_previousSession', expiresAt: '2000-01-01T00:00:00.000Z' });
  writeFileSync(file, body, { mode: 0o600 });
  await expect(connectApprovedMemberSession(input)).rejects.toThrow('이미 회원 연결');
  expect(readFileSync(file, 'utf8')).toBe(body);
  expect(server.exchanges()).toBe(0);
});

test('APP-BUILD-SESSION-REFRESH: an expired envelope is atomically replaced by a new connect without logging the token', async () => {
  const clock = Date.parse('2026-11-14T00:00:00.000Z');
  const staleToken = 'aps_abSessionExpiredOwner';
  const fetchImpl = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/exchange')) return Response.json({ sessionToken: token, expiresAt, appSlot: { appSlug: 'demo-app' } });
    if (String(url).includes('/v1/members/owner')) return Response.json({ memberId: 'member-server-verified' });
    return Response.json({ error: 'relay-unavailable' }, { status: 503 });
  }) as typeof fetch;
  const input = handoff(fetchImpl);
  const file = join(input.configDir, 'member-session.json');
  writeFileSync(file, JSON.stringify({ nexusUrl: input.nexusUrl, sessionToken: staleToken,
    expiresAt: new Date(clock - 1).toISOString(), appSlug: 'other-app' }), { mode: 0o600 });
  chmodSync(file, 0o600);
  const logged: unknown[][] = [];
  const debugSpy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never);
  const logSpy = spyOn(console, 'log'); const errorSpy = spyOn(console, 'error');
  try {
    expect(await connectApprovedMemberSession(input)).toEqual({ expiresAt, relayKeyUnavailable: true });
  } finally { debugSpy.mockRestore(); }
  try {
    expect(readTuiMemberSession(file, clock)).toEqual({ nexusUrl: 'https://api.elanous.ai', sessionToken: token, appSlug: 'demo-app' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(input.configDir)).toEqual(['member-session.json']);
    expect(logged.filter(args => args[0] === 'member-session')).toEqual([
      ['member-session', 'refreshed', { reason: 'stale-replaced', appSlug: 'demo-app' }, { level: 'info' }]]);
    const printed = JSON.stringify([logged, logSpy.mock.calls, errorSpy.mock.calls]);
    expect(printed.includes(token)).toBe(false);
    expect(printed.includes(staleToken)).toBe(false);
  } finally { logSpy.mockRestore(); errorSpy.mockRestore(); }
});

test('APP-BUILD-SESSION-REFRESH: a valid envelope for a different app is left untouched with a clear token-free message', async () => {
  const urls: string[] = [];
  // The stored session's server check fails (outage), so it is kept; no exchange is spent.
  const fetchImpl = (async (url: RequestInfo | URL) => { urls.push(String(url)); throw new Error('synthetic outage'); }) as unknown as typeof fetch;
  const input = handoff(fetchImpl);
  const file = join(input.configDir, 'member-session.json');
  const existingToken = 'aps_abSessionValidOther';
  // Exactly 30 minutes before the handoff clock's expiry, so the message names whole minutes.
  writeFileSync(file, JSON.stringify({ nexusUrl: input.nexusUrl, sessionToken: existingToken,
    expiresAt: new Date(input.now!() + 30 * 60_000).toISOString(), appSlug: 'other-app' }), { mode: 0o600 });
  chmodSync(file, 0o600);
  const original = readFileSync(file, 'utf8');
  let message = '';
  try { await connectApprovedMemberSession(input); } catch (error) { message = (error as Error).message; }
  expect(message).toBe('이미 회원 연결이 유효합니다 (앱 other-app · 잔여 30분). 기존 연결은 그대로 둡니다. '
    + '바꾸려면 elanous member disconnect 뒤 다시 연결해 주세요.');
  expect(message.includes(existingToken)).toBe(false);
  expect(urls.some(url => url.endsWith('/exchange'))).toBe(false);
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(readdirSync(input.configDir)).toEqual(['member-session.json']);
});

test('APP-BUILD-SESSION-REFRESH: a concurrent writer that lands a session after the expired check is never overwritten', async () => {
  const clock = Date.parse('2026-11-14T00:00:00.000Z');
  let file = '';
  const racingToken = 'aps_abSessionConcurrentWinner';
  const fetchImpl = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/exchange')) return Response.json({ sessionToken: token, expiresAt, appSlot: { appSlug: 'demo-app' } });
    // Another connect wins between our expired inspection and publication (new inode).
    rmSync(file);
    writeFileSync(file, JSON.stringify({ nexusUrl: 'https://api.elanous.ai', sessionToken: racingToken,
      expiresAt, appSlug: 'other-app' }), { flag: 'wx', mode: 0o600 });
    return Response.json({ memberId: 'member-server-verified' });
  }) as typeof fetch;
  const input = handoff(fetchImpl);
  file = join(input.configDir, 'member-session.json');
  writeFileSync(file, JSON.stringify({ nexusUrl: input.nexusUrl, sessionToken: 'aps_abSessionExpired',
    expiresAt: new Date(clock - 1).toISOString(), appSlug: 'demo-app' }), { mode: 0o600 });
  chmodSync(file, 0o600);
  await expect(connectApprovedMemberSession(input)).rejects.toThrow('이미 회원 연결이 있습니다');
  expect(readTuiMemberSession(file, clock)?.sessionToken).toBe(racingToken);
  expect(readdirSync(input.configDir)).toEqual(['member-session.json']);
});

test('APP-BUILD-SESSION-REFRESH: a temporary envelope left by a dead connect does not block the next one', async () => {
  const clock = Date.parse('2026-11-14T00:00:00.000Z');
  const fetchImpl = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/exchange')) return Response.json({ sessionToken: token, expiresAt, appSlot: { appSlug: 'demo-app' } });
    if (String(url).includes('/v1/members/owner')) return Response.json({ memberId: 'member-server-verified' });
    return Response.json({ error: 'relay-unavailable' }, { status: 503 });
  }) as typeof fetch;
  const input = handoff(fetchImpl);
  const file = join(input.configDir, 'member-session.json');
  const stray = join(input.configDir, '.member-session-00000000-0000-4000-8000-000000000000.json');
  writeFileSync(stray, '{"partial":', { mode: 0o600 });
  writeFileSync(file, JSON.stringify({ nexusUrl: input.nexusUrl, sessionToken: 'aps_abSessionExpired',
    expiresAt: new Date(clock - 1).toISOString(), appSlug: 'demo-app' }), { mode: 0o600 });
  chmodSync(file, 0o600);
  expect(await connectApprovedMemberSession(input)).toEqual({ expiresAt, relayKeyUnavailable: true });
  expect(readTuiMemberSession(file, clock)?.sessionToken).toBe(token);
});

test('APP-BUILD-SESSION-REFRESH: of two connects that both saw the same expired file, only the first publishes', async () => {
  const clock = Date.parse('2026-11-14T00:00:00.000Z');
  const gates: Array<() => void> = [];
  let bothWaiting: () => void = () => {};
  const waiting = new Promise<void>(done => { bothWaiting = done; });
  const make = (sessionToken: string, appSlug: string) => (async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/exchange')) return Response.json({ sessionToken, expiresAt, appSlot: { appSlug } });
    if (String(url).includes('/v1/members/owner')) {
      await new Promise<void>(release => { gates.push(release); if (gates.length === 2) bothWaiting(); });
      return Response.json({ memberId: 'member-server-verified' });
    }
    return Response.json({ error: 'relay-unavailable' }, { status: 503 });
  }) as typeof fetch;
  const first = handoff(make('aps_abSessionFirstWinner', 'demo-app'));
  const file = join(first.configDir, 'member-session.json');
  writeFileSync(file, JSON.stringify({ nexusUrl: first.nexusUrl, sessionToken: 'aps_abSessionExpired',
    expiresAt: new Date(clock - 1).toISOString(), appSlug: 'demo-app' }), { mode: 0o600 });
  chmodSync(file, 0o600);
  const second = { ...first, fetchImpl: make('aps_abSessionSecondLoser', 'other-app') };
  const a = connectApprovedMemberSession(first);
  const b = connectApprovedMemberSession(second);
  await waiting;
  gates[0]!();
  await expect(a).resolves.toEqual({ expiresAt, relayKeyUnavailable: true });
  gates[1]!();
  await expect(b).rejects.toThrow('이미 회원 연결이 있습니다');
  expect(readTuiMemberSession(file, clock)?.sessionToken).toBe('aps_abSessionFirstWinner');
  expect(readdirSync(first.configDir)).toEqual(['member-session.json']);
});

test('APP-BUILD-SESSION-REFRESH: explicit disconnect removes a valid or expired envelope and refuses an unsafe one', () => {
  const now = Date.parse('2026-11-14T00:00:00.000Z');
  const input = handoff((async () => { throw new Error('network must not run'); }) as unknown as typeof fetch);
  const file = join(input.configDir, 'member-session.json');
  expect(disconnectMemberSession(input.configDir, now)).toEqual({ removed: false });
  for (const offset of [30 * 60_000, -1]) {
    writeFileSync(file, JSON.stringify({ nexusUrl: input.nexusUrl, sessionToken: 'aps_abSessionDisconnect',
      expiresAt: new Date(now + offset).toISOString(), appSlug: 'demo-app' }), { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(disconnectMemberSession(input.configDir, now)).toEqual({ removed: true, appSlug: 'demo-app' });
    expect(readdirSync(input.configDir)).toEqual([]);
  }
  symlinkSync(join(input.configDir, 'missing-target'), file);
  expect(() => disconnectMemberSession(input.configDir, now)).toThrow('안전하게 확인하지 못했습니다');
  expect(readdirSync(input.configDir)).toEqual(['member-session.json']);
});
