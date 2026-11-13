import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonSessionHistory } from '../../boot/daemon-runtime.js';
import { SessionStore } from '../../session/session-store.js';
import { createDevProxyRuntimeRef } from '../api/admin-dev-proxy.js';
import { routeRequest, type NexusHttpServerOpts } from '../api/http-server.js';
import { isPublicRoute } from '../api/public-routes.js';
import { wireDaemonHistoryToStore } from '../api/session-history-mirror.js';
import { createMemberSessionService, MemberSessionAccessError, type MemberSessionService } from './member-sessions.js';
import { createMemberStore, type MemberRegistration, type MemberStore } from './member-store.js';
import { createMembersApi, type MembersApi } from './members-api.js';

const ALPHA = 'alpha-synthetic-member-turn';
const BETA = 'beta-synthetic-member-turn';
const OPERATOR_PREVIEW = 'operator-canary-preview';
const LEGACY_PREVIEW = 'legacy-canary-preview';
const ESCAPE_PREVIEW = 'symlink-escape-canary';
const DAEMON_PREVIEW = 'daemon-mirror-canary';
const WEB = 'https://app.example.test';

function register(store: MemberStore, name: string): MemberRegistration {
  return store.register({
    sub: `sub-${name}`,
    email: `${name}@example.test`,
    emailVerified: true,
    name,
  }, { consents: { privacy: 'v1', terms: 'v1' } });
}

function apiFor(store: MemberStore, sessions: MemberSessionService | undefined, extras: {
  now?: () => number;
  resolve?: MembersApiOptionsResolver;
} = {}): MembersApi {
  return createMembersApi({
    store,
    google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
    successRedirectUri: `${WEB}/member`,
    webOrigin: WEB,
    ...(sessions ? { memberSessions: sessions } : {}),
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.resolve ? { resolveVerifiedMemberOwner: extras.resolve } : {}),
  });
}

type MembersApiOptionsResolver = NonNullable<Parameters<typeof createMembersApi>[0]['resolveVerifiedMemberOwner']>;

async function ask(api: MembersApi, path: string, headers?: HeadersInit, method = 'GET', body?: string): Promise<Response> {
  const response = await routeRequest(
    new Request(`https://api.example.test${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }),
    { membersApi: api } as NexusHttpServerOpts,
    {} as never,
    null,
    createDevProxyRuntimeRef(),
  );
  if (!response) throw new Error(`route ${method} ${path} returned no response`);
  return response;
}

function cookie(token: string): HeadersInit {
  return { cookie: `__Host-elanous_member_session=${encodeURIComponent(token)}` };
}

interface World {
  root: string;
  memberDb: string;
  ledgerDir: string;
  sessionDir: string;
  store: MemberStore;
  sessions: MemberSessionService;
  reads: { n: number };
  api: MembersApi;
  close(): void;
}

function world(resolve?: MembersApiOptionsResolver): World {
  const root = mkdtempSync(join(tmpdir(), 'member-sessions-'));
  const memberDb = join(root, 'members.sqlite');
  const ledgerDir = join(root, 'owners');
  const sessionDir = join(root, 'sessions');
  const store = createMemberStore({ path: memberDb });
  const sessions = createMemberSessionService({ directory: ledgerDir, sessionRoot: sessionDir });
  const reads = { n: 0 };
  const counted: MemberSessionService = {
    store: sessions.store,
    list(memberId) { reads.n += 1; return sessions.list(memberId); },
    read(memberId, sessionId) { reads.n += 1; return sessions.read(memberId, sessionId); },
    saveTurn(memberId, content) { return sessions.saveTurn(memberId, content); },
  };
  const api = apiFor(store, counted, resolve ? { resolve } : {});
  return {
    root, memberDb, ledgerDir, sessionDir, store, sessions, reads, api,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('member session route lists only the verified owner', async () => {
  let ownerA = '';
  const box = world((token) => token === 'aps_synthetic-member-a1'
    ? { memberId: ownerA, userSlug: 'member-a', plan: 'free', entitlements: {} }
    : null);
  try {
    const a = register(box.store, 'member-a');
    const b = register(box.store, 'member-b');
    const empty = register(box.store, 'member-c');
    ownerA = a.id;
    const alpha = box.sessions.saveTurn(a.id, ALPHA);
    const beta = box.sessions.saveTurn(b.id, BETA);
    box.sessions.store.appendById('legacy-cli-1', {
      role: 'user', content: LEGACY_PREVIEW, ts: '2026-01-01T00:00:00.000Z',
    }, { source: 'cli', title: 'legacy-canary-title' });
    const operator = box.sessions.store.create({ source: 'cli', title: 'operator-canary-title' });
    box.sessions.store.appendById(operator.id, {
      role: 'user', content: OPERATOR_PREVIEW, ts: '2026-01-01T00:00:00.000Z',
    });
    const outside = join(box.root, 'outside.txt');
    writeFileSync(outside, ESCAPE_PREVIEW);
    const decoy = box.sessions.store.create({ source: 'cli', title: 'escape-title' });
    rmSync(join(box.sessionDir, `${decoy.id}.jsonl`));
    symlinkSync(outside, join(box.sessionDir, `${decoy.id}.jsonl`));
    const ledgerPath = join(box.ledgerDir, 'owners.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { version: number; bindings: Record<string, string[]> };
    ledger.bindings[a.id] = [...(ledger.bindings[a.id] ?? []), decoy.id];
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    const history = new DaemonSessionHistory();
    const off = wireDaemonHistoryToStore(history, box.sessions.store);
    history.append('elanous-session-1', [{ role: 'user', content: DAEMON_PREVIEW }]);
    off();

    const hidden = [BETA, OPERATOR_PREVIEW, LEGACY_PREVIEW, ESCAPE_PREVIEW, DAEMON_PREVIEW, b.id, 'operator-canary-title', 'legacy-canary-title'];
    const listA = await ask(box.api, `/v1/members/sessions?memberId=${encodeURIComponent(b.id)}&sessionId=${encodeURIComponent(beta.sessionId)}&projectId=other&root=${encodeURIComponent(box.sessionDir)}`, {
      ...cookie(a.session.token),
      'x-member-id': b.id,
    });
    expect(listA.status).toBe(200);
    expect(listA.headers.get('cache-control')).toBe('no-store');
    const bodyA = await listA.json() as { ok: boolean; total: number; sessions: Array<{ id: string; title: string; source: string; origin?: string; preview: string; messageCount: number }> };
    expect(bodyA.ok).toBe(true);
    expect(bodyA.total).toBe(1);
    expect(bodyA.sessions.map(card => card.id)).toEqual([alpha.sessionId]);
    expect(bodyA.sessions[0]).toMatchObject({ title: 'member', source: 'pwa', origin: 'pwa', preview: ALPHA, messageCount: 1 });
    const textA = JSON.stringify(bodyA);
    for (const secret of hidden) expect(textA).not.toContain(secret);

    const listB = await ask(box.api, '/v1/members/sessions', cookie(b.session.token));
    const bodyB = await listB.json() as { total: number; sessions: Array<{ id: string; preview: string }> };
    expect(bodyB.total).toBe(1);
    expect(bodyB.sessions[0]?.id).toBe(beta.sessionId);
    expect(bodyB.sessions[0]?.preview).toBe(BETA);
    expect(JSON.stringify(bodyB)).not.toContain(ALPHA);

    const emptyList = await ask(box.api, '/v1/members/sessions', cookie(empty.session.token));
    expect(await emptyList.json()).toEqual({ ok: true, sessions: [], total: 0 });

    const stolen = await ask(box.api, `/v1/members/sessions/${beta.sessionId}?memberId=${encodeURIComponent(a.id)}&root=${encodeURIComponent(box.sessionDir)}`, cookie(a.session.token));
    expect(stolen.status).toBe(404);
    expect(stolen.headers.get('cache-control')).toBe('no-store');
    expect(await stolen.text()).not.toContain(BETA);
    const unknown = await ask(box.api, `/v1/members/sessions/${operator.id}`, cookie(a.session.token));
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).not.toContain(OPERATOR_PREVIEW);

    const transcript = await ask(box.api, `/v1/members/sessions/${alpha.sessionId}`, cookie(a.session.token));
    expect(transcript.status).toBe(200);
    expect(transcript.headers.get('cache-control')).toBe('no-store');
    expect(await transcript.json()).toEqual({ ok: true, exists: true, messages: [{ role: 'user', content: ALPHA }] });

    const bearer = await ask(box.api, '/v1/members/sessions', {
      authorization: 'Bearer aps_synthetic-member-a1',
      cookie: `__Host-elanous_member_session=${encodeURIComponent(b.session.token)}`,
    });
    const bearerBody = await bearer.json() as { sessions: Array<{ id: string }> };
    expect(bearer.status).toBe(200);
    expect(bearerBody.sessions.map(card => card.id)).toEqual([alpha.sessionId]);

    box.store.close();
    const reopened = createMemberStore({ path: box.memberDb });
    const rebound = createMemberSessionService({ directory: box.ledgerDir, sessionRoot: box.sessionDir });
    const againApi = apiFor(reopened, rebound);
    try {
      const again = await ask(againApi, '/v1/members/sessions', cookie(a.session.token));
      const againBody = await again.json() as { sessions: Array<{ id: string; preview: string }> };
      expect(againBody.sessions.map(card => card.id)).toEqual([alpha.sessionId]);
      expect(againBody.sessions[0]?.preview).toBe(ALPHA);
      expect(rebound.store.load('elanous-session-1')?.messages[0]?.content).toBe(DAEMON_PREVIEW);
      expect(againBody.sessions.some(card => card.id === 'elanous-session-1')).toBe(false);
    } finally { reopened.close(); }
  } finally { box.close(); }
});

test('member session route rejects unauthenticated and foreign principals before a read', async () => {
  const box = world(() => null);
  try {
    const member = register(box.store, 'member-auth');
    box.sessions.saveTurn(member.id, ALPHA);
    const before = box.reads.n;
    const cases: Array<{ path?: string; headers?: HeadersInit; method?: string; status: number }> = [
      { status: 401 },
      { headers: { origin: WEB }, status: 401 },
      { headers: cookie('not-a-session'), status: 401 },
      { headers: { authorization: 'Bearer daemon-synthetic-token' }, status: 401 },
      { headers: { authorization: 'Bearer temp-synthetic-token' }, status: 401 },
      { headers: { authorization: 'Bearer setup-synthetic-token' }, status: 401 },
      { headers: { authorization: 'Bearer emt_synthetic-token' }, status: 401 },
      { headers: { authorization: 'Bearer aps_not-a-member', ...cookie(member.session.token) }, status: 401 },
      { method: 'POST', status: 401 },
    ];
    for (const item of cases) {
      const response = await ask(box.api, item.path ?? '/v1/members/sessions', item.headers, item.method ?? 'GET');
      expect(response.status).toBe(item.status);
      const text = await response.text();
      expect(text).not.toContain(ALPHA);
      expect(text).not.toContain(member.id);
    }
    expect(box.reads.n).toBe(before);
    for (const path of ['/v1/members/sessions/%ZZ', '/v1/members/sessions/not%2Fowned', '/v1/members/sessions/abc/def']) {
      const response = await ask(box.api, path, cookie(member.session.token));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(ALPHA);
    }
    expect(box.reads.n).toBe(before);

    const expired = apiFor(box.store, box.sessions, { now: () => Date.parse(member.session.expiresAt) + 1000 });
    const expiredResponse = await ask(expired, '/v1/members/sessions', cookie(member.session.token));
    expect(expiredResponse.status).toBe(401);
    expect(await expiredResponse.text()).not.toContain(ALPHA);
    expect(box.reads.n).toBe(before);

    expect(box.store.requestDeletion(member.session.token)).toBe(true);
    const revoked = await ask(box.api, '/v1/members/sessions', cookie(member.session.token));
    expect(revoked.status).toBe(401);
    expect(box.reads.n).toBe(before);

    const broken = apiFor({
      ...box.store,
      memberForSession() { throw new Error('synthetic-db-down'); },
    }, box.sessions);
    const lookup = await ask(broken, '/v1/members/sessions', cookie('synthetic-cookie'));
    expect(lookup.status).toBe(503);
    expect(await lookup.text()).toBe('{"error":"unavailable"}');
    expect(box.reads.n).toBe(before);

    writeFileSync(join(box.ledgerDir, 'owners.json'), '{broken');
    const fresh = register(box.store, 'member-after-revoke');
    const corrupt = await ask(box.api, '/v1/members/sessions', cookie(fresh.session.token));
    expect(corrupt.status).toBe(503);
    expect(await corrupt.text()).toBe('{"error":"unavailable"}');

    const missing = apiFor(box.store, undefined);
    const closed = await ask(missing, '/v1/members/sessions', cookie(fresh.session.token));
    expect(closed.status).toBe(503);
    expect(await closed.text()).toBe('{"error":"unavailable"}');

    const common = await ask(box.api, '/v1/sessions/store', cookie(fresh.session.token));
    const commonText = await common.text();
    expect(common.status).toBe(401);
    expect(commonText).not.toContain(ALPHA);
    expect(commonText).not.toContain(OPERATOR_PREVIEW);
  } finally { box.close(); }
});

test('member session ownership files reject symlink escape', () => {
  const root = mkdtempSync(join(tmpdir(), 'member-sessions-link-'));
  try {
    const realOwners = join(root, 'real-owners');
    const linkedOwners = join(root, 'linked-owners');
    mkdirSync(realOwners);
    symlinkSync(realOwners, linkedOwners);
    expect(() => createMemberSessionService({
      directory: linkedOwners,
      sessionRoot: join(root, 'sessions'),
    })).toThrow(MemberSessionAccessError);
    const sessions = createMemberSessionService({
      directory: join(root, 'owners'),
      sessionRoot: join(root, 'sessions'),
    });
    const outside = join(root, 'outside-ledger.json');
    writeFileSync(outside, '{"version":1,"bindings":{}}');
    symlinkSync(outside, join(root, 'owners', 'owners.json'));
    expect(() => sessions.list('member-a')).toThrow(MemberSessionAccessError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('member session routes are exact self-verified entries', () => {
  expect(isPublicRoute('GET', '/v1/members/sessions', { setupMode: false })).toBe(true);
  expect(isPublicRoute('GET', '/v1/members/sessions/owned-id', { setupMode: false })).toBe(true);
  expect(isPublicRoute('POST', '/v1/members/sessions', { setupMode: false })).toBe(true);
  expect(isPublicRoute('POST', '/v1/members/sessions/owned-id', { setupMode: false })).toBe(false);
  expect(isPublicRoute('PUT', '/v1/members/sessions', { setupMode: false })).toBe(false);
  expect(isPublicRoute('GET', '/v1/members/sessions-evil', { setupMode: false })).toBe(false);
  expect(isPublicRoute('GET', '/v1/sessions/store', { setupMode: false })).toBe(false);
});

test('an explicit session root stays separate from the process session root', () => {
  const root = mkdtempSync(join(tmpdir(), 'member-sessions-root-'));
  const sessionDir = join(root, 'sessions');
  try {
    const sessions = createMemberSessionService({ directory: join(root, 'owners'), sessionRoot: sessionDir });
    const other = new SessionStore(join(root, 'other'));
    other.create({ source: 'cli', title: 'other-root' });
    other.appendById(other.list()[0]!.id, { role: 'user', content: 'other-root-preview', ts: '2026-01-01T00:00:00.000Z' });
    const saved = sessions.saveTurn('member-a-root', ALPHA);
    expect(sessions.list('member-a-root').map(card => card.id)).toEqual([saved.sessionId]);
    expect(sessions.store.load(other.list()[0]!.id)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('authenticated save uses the verified member and survives reopen', async () => {
  let ownerA = '';
  const box = world((token) => token === 'aps_synthetic-member-a1'
    ? { memberId: ownerA, userSlug: 'member-a', plan: 'free', entitlements: {} }
    : null);
  try {
    const a = register(box.store, 'member-save-a');
    const b = register(box.store, 'member-save-b');
    ownerA = a.id;
    const headers = { ...cookie(a.session.token), 'content-type': 'application/json', 'x-member-id': b.id };
    const denied = await ask(box.api, '/v1/members/sessions', { 'content-type': 'application/json' }, 'POST', JSON.stringify({ content: ALPHA }));
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe('{"error":"unauthorized"}');

    const foreignBody = await ask(box.api, `/v1/members/sessions?memberId=${encodeURIComponent(b.id)}`, headers, 'POST', JSON.stringify({ content: ALPHA, memberId: b.id }));
    expect(foreignBody.status).toBe(400);
    expect(await foreignBody.text()).toBe('{"error":"invalid-request"}');
    const blank = await ask(box.api, '/v1/members/sessions', headers, 'POST', JSON.stringify({ content: '   ' }));
    expect(blank.status).toBe(400);
    expect(box.sessions.list(a.id)).toEqual([]);
    expect(box.sessions.list(b.id)).toEqual([]);

    const posted = await ask(
      box.api,
      `/v1/members/sessions?memberId=${encodeURIComponent(b.id)}&projectId=other&root=${encodeURIComponent(box.sessionDir)}`,
      headers,
      'POST',
      JSON.stringify({ content: ALPHA }),
    );
    expect(posted.status).toBe(200);
    expect(posted.headers.get('cache-control')).toBe('no-store');
    const postedBody = await posted.json() as { ok: boolean; sessionId: string };
    expect(postedBody.ok).toBe(true);
    expect(postedBody.sessionId).toMatch(/^[A-Za-z0-9]/);
    const bearerPosted = await ask(box.api, '/v1/members/sessions', {
      authorization: 'Bearer aps_synthetic-member-a1',
      cookie: `__Host-elanous_member_session=${encodeURIComponent(b.session.token)}`,
      'content-type': 'application/json',
    }, 'POST', JSON.stringify({ content: 'aps-synthetic-member-turn' }));
    expect(bearerPosted.status).toBe(200);
    const bearerBody = await bearerPosted.json() as { sessionId: string };
    expect(JSON.stringify(bearerBody)).not.toContain(b.id);

    box.store.close();
    const reopenedStore = createMemberStore({ path: box.memberDb });
    const rebound = createMemberSessionService({ directory: box.ledgerDir, sessionRoot: box.sessionDir });
    const againApi = apiFor(reopenedStore, rebound, {
      resolve: (token) => token === 'aps_synthetic-member-a1'
        ? { memberId: ownerA, userSlug: 'member-a', plan: 'free', entitlements: {} }
        : null,
    });
    try {
      const list = await ask(againApi, '/v1/members/sessions', cookie(a.session.token));
      const listBody = await list.json() as { total: number; sessions: Array<{ id: string; preview: string }> };
      expect(list.status).toBe(200);
      expect(listBody.sessions.map(card => card.id).sort()).toEqual([postedBody.sessionId, bearerBody.sessionId].sort());
      expect(listBody.sessions.map(card => card.preview).sort()).toEqual([ALPHA, 'aps-synthetic-member-turn'].sort());
      const transcript = await ask(againApi, `/v1/members/sessions/${postedBody.sessionId}`, cookie(a.session.token));
      expect(transcript.status).toBe(200);
      expect(await transcript.json()).toEqual({ ok: true, exists: true, messages: [{ role: 'user', content: ALPHA }] });
      const hidden = await ask(againApi, `/v1/members/sessions/${postedBody.sessionId}`, cookie(b.session.token));
      expect(hidden.status).toBe(404);
      expect(await hidden.text()).not.toContain(ALPHA);
      const otherList = await ask(againApi, '/v1/members/sessions', cookie(b.session.token));
      expect(await otherList.json()).toEqual({ ok: true, sessions: [], total: 0 });
    } finally { reopenedStore.close(); }
  } finally { box.close(); }
});

const SERVICE_MODULE = fileURLToPath(new URL('./member-sessions.ts', import.meta.url));

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return { ...env, ...extra };
}

async function waitForPath(path: string, label: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(15);
  }
}

test('concurrent saves keep both bindings behind the ledger lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-sessions-lock-'));
  const ledgerDir = join(root, 'owners');
  const sessionDir = join(root, 'sessions');
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const held = join(root, 'held');
  const entered = join(root, 'entered');
  const done = join(root, 'done');
  const holder = Bun.spawn([process.execPath, '-e', `
    import { constants, fchmodSync, openSync, writeFileSync } from 'node:fs';
    import { dlopen, FFIType } from 'bun:ffi';
    const lib = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    const fd = openSync(process.env.LOCK, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    if (lib.symbols.flock(fd, 2) !== 0) throw new Error('holder flock failed');
    writeFileSync(process.env.HELD, '1');
    Bun.sleepSync(800);
    if (lib.symbols.flock(fd, 8) !== 0) throw new Error('holder unlock failed');
  `], {
    env: childEnv({ LOCK: join(ledgerDir, 'owners.json.lock'), HELD: held }),
    stdout: 'ignore',
    stderr: 'pipe',
  });
  let saver: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await waitForPath(held, 'holder');
    saver = Bun.spawn([process.execPath, '-e', `
      import { writeFileSync } from 'node:fs';
      const { createMemberSessionService } = await import(process.env.MODULE);
      const sessions = createMemberSessionService({ directory: process.env.LEDGER, sessionRoot: process.env.SESSIONS });
      writeFileSync(process.env.ENTERED, '1');
      const saved = sessions.saveTurn(process.env.MEMBER, process.env.CONTENT);
      writeFileSync(process.env.DONE, saved.sessionId);
    `], {
      env: childEnv({
        MODULE: SERVICE_MODULE,
        LEDGER: ledgerDir,
        SESSIONS: sessionDir,
        MEMBER: 'member-lock-a',
        CONTENT: 'locked-synthetic-turn',
        ENTERED: entered,
        DONE: done,
      }),
      stdout: 'ignore',
      stderr: 'pipe',
    });
    await waitForPath(entered, 'saver');
    await Bun.sleep(150);
    expect(existsSync(done)).toBe(false);
    const during = existsSync(join(ledgerDir, 'owners.json'))
      ? JSON.parse(readFileSync(join(ledgerDir, 'owners.json'), 'utf8')) as { bindings?: Record<string, string[]> }
      : { bindings: {} };
    expect(during.bindings?.['member-lock-a'] ?? []).toEqual([]);
    await waitForPath(done, 'saved id');
    expect(await holder.exited).toBe(0);
    if (!saver) throw new Error('saver did not start');
    expect(await saver.exited).toBe(0);
    const sessionId = readFileSync(done, 'utf8').trim();
    const reopened = createMemberSessionService({ directory: ledgerDir, sessionRoot: sessionDir });
    expect(reopened.list('member-lock-a').map(card => card.id)).toEqual([sessionId]);
    expect(reopened.read('member-lock-a', sessionId)?.messages).toEqual([{ role: 'user', content: 'locked-synthetic-turn' }]);

    const barrier = join(root, 'barrier');
    writeFileSync(barrier, 'wait');
    const readyA = join(root, 'ready-a');
    const readyB = join(root, 'ready-b');
    const doneA = join(root, 'done-a');
    const doneB = join(root, 'done-b');
    const spawnSaver = (ready: string, finished: string, content: string) => Bun.spawn([process.execPath, '-e', `
      import { readFileSync, writeFileSync } from 'node:fs';
      const { createMemberSessionService } = await import(process.env.MODULE);
      const sessions = createMemberSessionService({ directory: process.env.LEDGER, sessionRoot: process.env.SESSIONS });
      writeFileSync(process.env.READY, '1');
      const deadline = Date.now() + 8000;
      while (readFileSync(process.env.BARRIER, 'utf8') !== 'go') {
        if (Date.now() > deadline) throw new Error('barrier timeout');
        Bun.sleepSync(5);
      }
      const saved = sessions.saveTurn(process.env.MEMBER, process.env.CONTENT);
      writeFileSync(process.env.DONE, saved.sessionId);
    `], {
      env: childEnv({
        MODULE: SERVICE_MODULE,
        LEDGER: ledgerDir,
        SESSIONS: sessionDir,
        MEMBER: 'member-lock-same',
        CONTENT: content,
        READY: ready,
        BARRIER: barrier,
        DONE: finished,
      }),
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const first = spawnSaver(readyA, doneA, 'concurrent-turn-a');
    const second = spawnSaver(readyB, doneB, 'concurrent-turn-b');
    try {
      await waitForPath(readyA, 'ready a');
      await waitForPath(readyB, 'ready b');
      writeFileSync(barrier, 'go');
      await waitForPath(doneA, 'done a');
      await waitForPath(doneB, 'done b');
      expect(await first.exited).toBe(0);
      expect(await second.exited).toBe(0);
      const again = createMemberSessionService({ directory: ledgerDir, sessionRoot: sessionDir });
      const cards = again.list('member-lock-same');
      expect(cards.map(card => card.id).sort()).toEqual([readFileSync(doneA, 'utf8').trim(), readFileSync(doneB, 'utf8').trim()].sort());
      expect(cards.map(card => card.preview).sort()).toEqual(['concurrent-turn-a', 'concurrent-turn-b']);
      expect(again.list('member-lock-a').map(card => card.id)).toEqual([sessionId]);
    } finally {
      first.kill();
      second.kill();
    }
  } finally {
    holder.kill();
    saver?.kill();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
