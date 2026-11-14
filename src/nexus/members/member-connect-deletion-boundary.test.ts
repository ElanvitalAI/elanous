import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from './member-store.js';
import { createMemberConnectEntry } from './member-connect-entry-api.js';
import { createMembersApi } from './members-api.js';

const apiOrigin = 'https://api.example.test';
const webOrigin = 'https://app.example.test';
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = 's'.repeat(43);
const pollSecret = 'p'.repeat(43);

function fixture(sub: string) {
  const dir = mkdtempSync(join(tmpdir(), 'member-connect-deletion-'));
  const at = Date.parse('2026-11-14T09:00:00.000Z');
  const path = join(dir, 'members.sqlite');
  const store = createMemberStore({ path, now: () => at });
  const member = store.register({ sub, email: sub + '@example.test', emailVerified: true, name: sub },
    { consents: { privacy: 'v1', terms: 'v1' } }, new Date(at).toISOString());
  let issued = 0;
  const api = createMembersApi({ store, now: () => at,
    google: { redirectUri: apiOrigin + '/v1/members/oauth/google/callback' } as never,
    successRedirectUri: webOrigin + '/member', webOrigin,
    issueOwnerSession: () => { issued++; return { sessionToken: 'aps_fake-owner-session', expiresAt: '2026-11-15T09:00:00.000Z' }; },
  });
  const cookie = '__Host-elanous_member_session=' + member.session.token;
  const start = async () => {
    const response = await api.handle(new Request(apiOrigin + '/v1/members/connect/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, codeChallenge: challenge, pollSecret }),
    }));
    const body = await response?.json() as { id: string; approvalUrl: string; userCode: string };
    return { response, ...body };
  };
  const preview = async (approvalUrl: string) => {
    const response = await api.handle(new Request(approvalUrl, { headers: { cookie } }));
    const csrf = /name="csrf" value="([^"]+)"/.exec(await response?.text() ?? '')?.[1];
    return { response, csrf };
  };
  const approve = (approvalUrl: string, csrf: string, userCode: string) => api.handle(new Request(approvalUrl, {
    method: 'POST', headers: { origin: apiOrigin, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, userCode }).toString(),
  }));
  const deleteAccount = (origin: string) => api.handle(new Request(apiOrigin + '/v1/members', {
    method: 'DELETE', headers: { origin, cookie },
  }));
  const poll = (id: string) => api.handle(new Request(apiOrigin + '/v1/members/connect/poll?id=' + id, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pollSecret }),
  }));
  const exchange = (code: string) => api.handle(new Request(apiOrigin + '/v1/members/app-slot/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, state, codeVerifier: verifier }),
  }));
  return { api, store, member, path, dir, cookie, start, preview, approve, deleteAccount, poll, exchange,
    issued: () => issued, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('foreign-origin deletion and wrong user code cannot cancel or approve a valid TUI connection', async () => {
  const box = fixture('control-member');
  try {
    const started = await box.start();
    const page = await box.preview(started.approvalUrl);
    expect(started.response?.status).toBe(201);
    expect(page.response?.status).toBe(200);
    expect(page.csrf).toBeTruthy();
    const deniedDelete = await box.deleteAccount('https://foreign.example.test');
    const wrongCode = await box.approve(started.approvalUrl, page.csrf!, 'ABCD-EFGH');
    const approved = await box.approve(started.approvalUrl, page.csrf!, started.userCode);
    const polled = await box.poll(started.id);
    const pollBody = await polled?.json() as { code?: string };
    const exchanged = pollBody.code ? await box.exchange(pollBody.code) : undefined;
    const observed = { foreignDelete: deniedDelete?.status, wrongCode: wrongCode?.status,
      approval: approved?.status, poll: polled?.status, exchange: exchanged?.status, issuerCalls: box.issued() };
    expect(observed).toEqual({ foreignDelete: 403, wrongCode: 403, approval: 200, poll: 200, exchange: 200, issuerCalls: 1 });
  } finally { box.close(); }
});

test('account deletion after approval must not deliver or exchange the pending TUI code', async () => {
  const box = fixture('cancel-member');
  try {
    const started = await box.start();
    const page = await box.preview(started.approvalUrl);
    expect(started.response?.status).toBe(201);
    expect(page.response?.status).toBe(200);
    const approved = await box.approve(started.approvalUrl, page.csrf!, started.userCode);
    const deleted = await box.deleteAccount(webOrigin);
    const profile = await box.api.handle(new Request(apiOrigin + '/v1/members', { headers: { cookie: box.cookie } }));
    const polled = await box.poll(started.id);
    const pollBody = await polled?.json() as { code?: string };
    const exchanged = pollBody.code ? await box.exchange(pollBody.code) : undefined;
    const observed = { approval: approved?.status, deletion: deleted?.status, staleProfile: profile?.status,
      codeDelivered: Boolean(pollBody.code), exchangeStatus: exchanged?.status ?? null, issuerCalls: box.issued() };
    expect(observed.approval).toBe(200);
    expect(observed.deletion).toBe(202);
    expect(observed.staleProfile).toBe(401);
    expect({ codeDelivered: observed.codeDelivered, exchangeStatus: observed.exchangeStatus,
      issuerCalls: observed.issuerCalls }).toEqual({ codeDelivered: false, exchangeStatus: null, issuerCalls: 0 });
  } finally { box.close(); }
});

test('account deletion before approval prevents stale browser approval and code delivery', async () => {
  const box = fixture('cancel-before-member');
  try {
    const started = await box.start();
    const page = await box.preview(started.approvalUrl);
    expect(started.response?.status).toBe(201);
    expect(page.response?.status).toBe(200);
    const deleted = await box.deleteAccount(webOrigin);
    const staleApproval = await box.approve(started.approvalUrl, page.csrf!, started.userCode);
    const polled = await box.poll(started.id);
    const pollBody = await polled?.json() as { code?: string; approved?: boolean };
    const observed = { deletion: deleted?.status, staleApproval: staleApproval?.status,
      poll: polled?.status, codeDelivered: Boolean(pollBody.code), issuerCalls: box.issued() };
    expect(observed).toEqual({ deletion: 202, staleApproval: 401, poll: 202, codeDelivered: false, issuerCalls: 0 });
  } finally { box.close(); }
});

test('poll code decision and deletion serialize across separate SQLite processes', async () => {
  const childPath = join(import.meta.dir, 'member-connect-deletion-child.ts');
  const at = Date.parse('2026-11-14T09:00:00.000Z');
  const setup = async (box: ReturnType<typeof fixture>, beforeDecision?: () => void) => {
    const guardedStore = { ...box.store,
      withActiveForAuth: <T>(memberId: string, effect: () => T) => box.store.withActiveForAuth(memberId, () => {
        beforeDecision?.();
        return effect();
      }),
    };
    const entry = createMemberConnectEntry({ origin: apiOrigin, now: () => at,
      memberForRequest: () => box.member.id, store: guardedStore });
    const start = await entry.handle(new Request(apiOrigin + '/v1/members/connect/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, codeChallenge: challenge, pollSecret }),
    }));
    const { id, approvalUrl, userCode } = await start!.json() as { id: string; approvalUrl: string; userCode: string };
    const page = await entry.handle(new Request(approvalUrl));
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page!.text())![1];
    const approved = await entry.handle(new Request(approvalUrl, { method: 'POST', headers: { origin: apiOrigin },
      body: new URLSearchParams({ csrf, userCode }).toString() }));
    expect(approved?.status).toBe(200);
    const poll = () => entry.handle(new Request(apiOrigin + '/v1/members/connect/poll?id=' + id, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pollSecret }),
    }));
    return { poll };
  };
  const spawnDeletion = (box: ReturnType<typeof fixture>, ready: string, go: string, attempting: string) => Bun.spawn({
    cmd: [process.execPath, childPath, box.path, box.member.session.token, ready, go, attempting],
    stdout: 'ignore', stderr: 'pipe',
  });
  const awaitMarker = async (marker: string) => {
    const deadline = Date.now() + 3_000;
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(marker)).toBe(true);
  };

  const deletedFirst = fixture('poll-delete-first');
  try {
    const { poll } = await setup(deletedFirst);
    const ready = join(deletedFirst.dir, 'delete-first.ready');
    const go = join(deletedFirst.dir, 'delete-first.go');
    writeFileSync(go, 'go');
    const child = spawnDeletion(deletedFirst, ready, go, join(deletedFirst.dir, 'delete-first.attempting'));
    expect(await child.exited).toBe(0);
    expect((await poll())?.status).toBe(401);
  } finally { deletedFirst.close(); }

  const decisionFirst = fixture('poll-decision-first');
  try {
    let childPendingAtDecision = false;
    const ready = join(decisionFirst.dir, 'decision-first.ready');
    const go = join(decisionFirst.dir, 'decision-first.go');
    const attempting = join(decisionFirst.dir, 'decision-first.attempting');
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const { poll } = await setup(decisionFirst, () => {
      writeFileSync(go, 'go');
      const deadline = Date.now() + 3_000;
      while (!existsSync(attempting) && Date.now() < deadline)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      if (!existsSync(attempting)) throw new Error('deletion child did not attempt');
      // Give the independent process time to attempt the locked DELETE.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      childPendingAtDecision = child?.exitCode === null;
    });
    child = spawnDeletion(decisionFirst, ready, go, attempting);
    await awaitMarker(ready);
    const delivered = await poll();
    expect(delivered?.status).toBe(200);
    expect(childPendingAtDecision).toBe(true);
    expect(child).toBeDefined();
    expect(await child!.exited).toBe(0);
    expect(decisionFirst.store.activeForAuth(decisionFirst.member.id)).toBe(false);
    expect((await poll())?.status).toBe(404);
  } finally { decisionFirst.close(); }
});
