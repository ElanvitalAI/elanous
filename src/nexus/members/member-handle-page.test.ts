// MEMBER-JOURNEY-FRICTIONLESS S3 (0.3.32 P0): 회원 가입 후 «내 주소» 핸들 확인 화면 —
// S2(추천·가용성 API, PR #39357) 위에 확인 화면과 저장 흐름까지가 S3이다(지시서 agent-results/52a9407c).
// 정본 = 회원 서버: GET /v1/members/handle 이 HTML 을 내고, 저장 성공은 정본 홈으로 간다.
// S2의 추천(slugFromName)·가용성(handle/check) 로직은 화면이 복제하지 않는다 — API만 믿는다.
import { afterEach, expect, test } from 'bun:test';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';
import {
  beginHandleCheck,
  completeHandleCheck,
  resolveHandleSaveOutcome,
  type HandleCheckView,
} from './member-handle-page.js';

const WEB = 'https://nexus.example.test';
const stores: ReturnType<typeof createMemberStore>[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const reg = (
  store: ReturnType<typeof createMemberStore>,
  name: string,
  email = `${name}@example.test`,
) =>
  store.register(
    { sub: name, email, emailVerified: true, name },
    { consents: { privacy: 'v1', terms: 'v1' } },
  );

const world = () => {
  const store = createMemberStore({ path: ':memory:' });
  stores.push(store);
  const api = createMembersApi({
    store,
    google: { redirectUri: `${WEB}/v1/members/oauth/google/callback` } as never,
    successRedirectUri: `${WEB}/app/`,
    webOrigin: WEB,
  });
  const member = (name: string, email = `${name}@example.test`) => {
    const registered = reg(store, name, email);
    const cookie = `__Host-elanous_member_session=${store.createSession(registered.id).token}`;
    const call = async (path: string, init: { method?: string; body?: string } = {}) => {
      const headers: Record<string, string> = { cookie };
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      const response = await api.handle(
        new Request(`${WEB}${path}`, { method: init.method ?? 'GET', body: init.body, headers }),
      );
      return {
        status: response?.status ?? 0,
        location: response?.headers.get('location') ?? null,
        contentType: response?.headers.get('content-type') ?? null,
        body: response ? await response.text() : '',
      };
    };
    return { id: registered.id, call };
  };
  return { api, store, member };
};

// ── ① 화면: 추천 자동채움 + 손으로 고칠 수 있는 입력 ──────────────────────────
test('S3 handle page: pre-fills the name-based recommendation into an editable field', async () => {
  const w = world();
  const m = w.member('김주성');
  const page = await m.call('/v1/members/handle');
  expect(page.status).toBe(200);
  expect(page.contentType).toContain('text/html');
  expect(page.body).toContain('내 주소');
  expect(page.body).toContain('.elanous.app');
  const input = /<input[^>]*\bid="handle-input"[^>]*>/i.exec(page.body);
  expect(input).not.toBeNull();
  expect(input![0]).toContain('value="gimjuseong"');
  expect(input![0]).not.toMatch(/\b(readonly|disabled)\b/i);
});

test('S3 handle page: a name without usable characters falls back, the field is never empty', async () => {
  const w = world();
  const fromEmail = await w.member('日本語', 'taro@example.test').call('/v1/members/handle');
  expect(fromEmail.status).toBe(200);
  expect(fromEmail.body).toContain('value="taro"');
  const fallback = await w.member('😀').call('/v1/members/handle');
  expect(fallback.status).toBe(200);
  expect(fallback.body).toContain('value="member"');
});

// ── ② 체크 결과: ok/taken/reserved/invalid + 대안 ────────────────────────────
test('check outcome: ok confirms, taken shows adoptable alternatives, reserved and invalid say why', () => {
  const okView = beginHandleCheck(null, 'gimjuseong');
  const ok = completeHandleCheck(okView, okView.generation, {
    handle: 'gimjuseong',
    status: 'ok',
    alternatives: [],
    suggestion: null,
  });
  expect(ok.status).toBe('ok');
  expect(ok.message).toContain('쓸 수 있는');
  expect(ok.alternatives).toEqual([]);
  const takenView = beginHandleCheck(ok, 'alicekim');
  const taken = completeHandleCheck(takenView, takenView.generation, {
    handle: 'alicekim',
    status: 'taken',
    alternatives: ['alicekim1', 'alicekim2', 'alicekim3'],
    suggestion: null,
  });
  expect(taken.status).toBe('taken');
  expect(taken.message).toContain('이미 쓰이');
  expect(taken.alternatives).toEqual(['alicekim1', 'alicekim2', 'alicekim3']);
  const reservedView = beginHandleCheck(null, 'admin');
  const reserved = completeHandleCheck(reservedView, reservedView.generation, {
    handle: 'admin',
    status: 'reserved',
    alternatives: [],
    suggestion: null,
  });
  expect(reserved.status).toBe('reserved');
  expect(reserved.message).toContain('쓸 수 없');
  const invalidView = beginHandleCheck(null, '9abc!');
  const invalid = completeHandleCheck(invalidView, invalidView.generation, {
    handle: '9abc!',
    status: 'invalid',
    alternatives: [],
    suggestion: null,
  });
  expect(invalid.status).toBe('invalid');
  expect(invalid.message).toContain('영문 소문자');
});

// ── ③ 조회 장애: 재시도 가능한 unavailable ───────────────────────────────────
test('check outcome: a failed or malformed lookup answers retryable unavailable, never a wrong status', () => {
  const view = beginHandleCheck(null, 'gimjuseong');
  const failed = completeHandleCheck(view, view.generation, null);
  expect(failed.status).toBe('unavailable');
  expect(failed.message).toContain('확인하지 못했');
  const malformed = completeHandleCheck(view, view.generation, { handle: 3, status: ['no'] });
  expect(malformed.status).toBe('unavailable');
});

// ── ④ 역순 응답 race ────────────────────────────────────────────────────────
test('out-of-order check responses: only the newest request result lands', () => {
  let view: HandleCheckView = beginHandleCheck(null, 'firstvalue1');
  const firstGeneration = view.generation;
  view = beginHandleCheck(view, 'secondvalue');
  expect(view.generation).toBe(firstGeneration + 1);
  const stale = completeHandleCheck(view, firstGeneration, {
    handle: 'firstvalue1',
    status: 'ok',
    alternatives: [],
  });
  expect(stale).toBe(view);
  expect(stale.status).toBe('checking');
  const landed = completeHandleCheck(view, view.generation, {
    handle: 'secondvalue',
    status: 'taken',
    alternatives: ['secondvalue1'],
  });
  expect(landed.status).toBe('taken');
  expect(landed.alternatives).toEqual(['secondvalue1']);
});

// ── ⑤ 저장 결과 판정 ────────────────────────────────────────────────────────
test('save outcome: 200 goes home, 401 signs in again, a conflict re-checks, other failures stay', () => {
  expect(resolveHandleSaveOutcome(200)).toEqual({ kind: 'home' });
  expect(resolveHandleSaveOutcome(401)).toEqual({ kind: 'signin' });
  expect(resolveHandleSaveOutcome(400)).toEqual({ kind: 'recheck' });
  expect(resolveHandleSaveOutcome(403)).toEqual({ kind: 'recheck' });
  expect(resolveHandleSaveOutcome(409)).toEqual({ kind: 'recheck' });
  expect(resolveHandleSaveOutcome(500)).toEqual({ kind: 'unavailable' });
});

// ── ⑥ 인증 경계(라우트): 익명은 화면도 저장도 못 한다 ────────────────────────
test('the handle page keeps the session boundary: anonymous GET is 401 and leaks no claim form', async () => {
  const w = world();
  const anonymous = await w.api.handle(new Request(`${WEB}/v1/members/handle`));
  expect(anonymous?.status).toBe(401);
  expect((await anonymous?.text()) ?? '').not.toContain('<form');
  const anonymousSave = await w.api.handle(
    new Request(`${WEB}/v1/members/handle`, {
      method: 'PUT',
      body: JSON.stringify({ handle: 'anonattempt1' }),
      headers: { 'content-type': 'application/json' },
    }),
  );
  expect(anonymousSave?.status).toBe(401);
});

// ── ⑦ 기존 핸들 보유 → 정본 홈 직행 ─────────────────────────────────────────
test('a member who already has a handle is sent straight to the canonical home, no claim form', async () => {
  const w = world();
  const m = w.member('alreadyhand');
  w.store.claimHandle(m.id, 'alreadyset1');
  const page = await m.call('/v1/members/handle');
  expect(page.status).toBe(302);
  expect(page.location).toBe(`${WEB}/v1/members/home`);
  expect(page.body).not.toContain('<form');
});

// ── ⑧ 성공 목적지 + 폭별 배치 ───────────────────────────────────────────────
test('the page renders the success destination and keeps its layout at phone and desktop widths', async () => {
  const w = world();
  const m = w.member('widthcheck');
  const page = await m.call('/v1/members/handle');
  expect(page.status).toBe(200);
  expect(page.body).toContain('/v1/members/home');
  expect(page.body).toContain('@media (max-width:720px)');
  expect(page.body).toContain('@media (max-width:380px)');
});