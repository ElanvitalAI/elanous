/**
 * POST /v1/sessions/store/:id/fork 계약 테스트 (PWA 파리티 P2 · 2026-07-12).
 *
 * beforeUser 파라미터 파싱/검증 + forkSessionById 위임 계약만 검증한다.
 * 세션 store 는 실 ~/.elanous 고정(homedir·XDG 거부)이라 실제 fork 를 부르면
 * 실 데이터가 오염된다 — deps.fork 주입으로 격리(memory: 세션 저장소 테스트
 * 격리). 절단 엔진 자체(truncateBeforeNthUser)는 acp/session-fork 테스트 소관.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { createProject } from '../../project/project-store.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleSessionsStoreFork, handleSessionsStoreGet, handleSessionsStoreList } from './sessions-store.js';
import { loadSession } from '../../session/index.js';
import {
  HARNESS_SESSION_ORIGIN,
  appendMessage,
  createSession,
  isHarnessSessionOrigin,
  type forkSessionById,
} from '../../session/index.js';
import type { MetaApiOpts } from './meta-api.js';

const OPTS: MetaApiOpts = { noAuth: true } as MetaApiOpts;

type ForkFn = typeof forkSessionById;
type ForkCall = { id: string; opts: { beforeUser?: number } };

function makeForkSpy(result: 'ok' | 'null' = 'ok'): { fn: ForkFn; calls: ForkCall[] } {
  const calls: ForkCall[] = [];
  const fn = ((id: string, opts: { beforeUser?: number } = {}) => {
    calls.push({ id, opts });
    if (result === 'null') return null;
    return {
      meta: { id: 'forked-new-id', title: '⑂ t', source: 'cli' },
      messages: [],
    } as unknown as ReturnType<ForkFn>;
  }) as ForkFn;
  return { fn, calls };
}

function forkReq(body?: string): Request {
  return new Request('http://localhost:31415/v1/sessions/store/src-id/fork', {
    method: 'POST',
    ...(body !== undefined ? { body } : {}),
  });
}

describe('handleSessionsStoreFork — beforeUser 파라미터', () => {
  it('body 없음 → 풀카피 fork (하위호환 · beforeUser 미전달)', async () => {
    const spy = makeForkSpy();
    const res = await handleSessionsStoreFork(forkReq(), 'src-id', OPTS, { fork: spy.fn });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; id: string; beforeUser?: number };
    expect(j.ok).toBe(true);
    expect(j.id).toBe('forked-new-id');
    expect(j.beforeUser).toBeUndefined();
    expect(spy.calls).toEqual([{ id: 'src-id', opts: {} }]);
  });

  it('beforeUser=N → 타임트래블 절단 fork 위임 + 응답에 echo', async () => {
    const spy = makeForkSpy();
    const res = await handleSessionsStoreFork(
      forkReq(JSON.stringify({ beforeUser: 2 })), 'src-id', OPTS, { fork: spy.fn },
    );
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; beforeUser?: number };
    expect(j.beforeUser).toBe(2);
    expect(spy.calls).toEqual([{ id: 'src-id', opts: { beforeUser: 2 } }]);
  });

  it('beforeUser 가 1 미만 / 비정수면 400 invalid_before_user (CLI --before-user 검증 동형)', async () => {
    for (const bad of [0, -1, 1.5, 'x']) {
      const spy = makeForkSpy();
      const res = await handleSessionsStoreFork(
        forkReq(JSON.stringify({ beforeUser: bad })), 'src-id', OPTS, { fork: spy.fn },
      );
      expect(res.status).toBe(400);
      const j = await res.json() as { error: string };
      expect(j.error).toBe('invalid_before_user');
      expect(spy.calls.length).toBe(0);
    }
  });

  it('JSON 파싱 불가 body → 400 invalid_json', async () => {
    const spy = makeForkSpy();
    const res = await handleSessionsStoreFork(forkReq('{not-json'), 'src-id', OPTS, { fork: spy.fn });
    expect(res.status).toBe(400);
    const j = await res.json() as { error: string };
    expect(j.error).toBe('invalid_json');
    expect(spy.calls.length).toBe(0);
  });

  it('소스 세션 미존재(fork null) → 404 not_found', async () => {
    const spy = makeForkSpy('null');
    const res = await handleSessionsStoreFork(forkReq(), 'ghost-id', OPTS, { fork: spy.fn });
    expect(res.status).toBe(404);
    const j = await res.json() as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBe('not_found');
  });
});

describe('PATCH /v1/sessions/store/:id — project only', () => {
  let root: string;
  let config: string;
  let previous: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'session-patch-'));
    config = mkdtempSync(join(tmpdir(), 'projects-patch-'));
    previous = process.env.ELANOUS_SESSION_ROOT;
    process.env.ELANOUS_SESSION_ROOT = root;
    setElanousConfigDir(config);
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.ELANOUS_SESSION_ROOT;
    else process.env.ELANOUS_SESSION_ROOT = previous;
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  });
  async function patch(id: string, body: unknown, authorized = true): Promise<Response> {
    const req = new Request(`http://localhost/v1/sessions/store/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer owner' } : {}) },
      body: JSON.stringify(body),
    });
    const response = await routeRequest(req, { metaApi: { noAuth: false, bearerToken: 'owner' } } as NexusHttpServerOpts,
      {} as never, null, createDevProxyRuntimeRef());
    if (!response) throw new Error('route missing');
    return response;
  }
  it('assigns and clears only projectId; rejects other fields and unknown project/session and unauthenticated requests', async () => {
    const session = createSession({ title: 'Keep', origin: 'pwa' }, root);
    appendMessage(session.id, { role: 'user', content: 'untouched', ts: new Date().toISOString() }, root);
    const original = loadSession(session.id, root)!;
    const project = createProject({ name: 'Test' });
    expect((await patch(session.id, { projectId: project.id }, false)).status).toBe(401);
    expect((await patch(session.id, { projectId: 'missing' })).status).toBe(400);
    expect((await patch('absent', { projectId: project.id })).status).toBe(404);
    expect((await patch(session.id, { projectId: project.id, title: 'Changed' })).status).toBe(400);
    expect((await patch(session.id, { title: 'Changed' })).status).toBe(400);
    expect((await patch(session.id, { projectId: project.id })).status).toBe(200);
    expect(loadSession(session.id, root)).toEqual({ ...original, meta: { ...original.meta, projectId: project.id } });
    expect((await patch(session.id, { projectId: null })).status).toBe(200);
    expect(loadSession(session.id, root)).toEqual(original);
  });
});

describe('handleSessionsStoreList — harness origin default hide', () => {
  let sessionRoot: string;
  let priorSessionRoot: string | undefined;
  let priorHarness: string | undefined;

  beforeEach(() => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'sessions-store-list-'));
    priorSessionRoot = process.env.ELANOUS_SESSION_ROOT;
    priorHarness = process.env.ELANOUS_HARNESS_SPACE;
    process.env.ELANOUS_SESSION_ROOT = sessionRoot;
    delete process.env.ELANOUS_HARNESS_SPACE;
  });

  afterEach(() => {
    if (priorSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
    else process.env.ELANOUS_SESSION_ROOT = priorSessionRoot;
    if (priorHarness === undefined) delete process.env.ELANOUS_HARNESS_SPACE;
    else process.env.ELANOUS_HARNESS_SPACE = priorHarness;
    rmSync(sessionRoot, { recursive: true, force: true });
  });

  function addUser(id: string, content: string): void {
    appendMessage(id, { role: 'user', content, ts: new Date().toISOString() }, sessionRoot);
  }

  async function list(query = ''): Promise<{ sessions: Array<{ id: string; origin?: string; sourceKind?: string; projectId?: string }>; total: number }> {
    const res = handleSessionsStoreList(
      new Request(`http://localhost:31415/v1/sessions/store${query}`),
      OPTS,
    );
    expect(res.status).toBe(200);
    return await res.json() as { sessions: Array<{ id: string; origin?: string; sourceKind?: string; projectId?: string }>; total: number };
  }

  it('기본 목록은 하니스 origin 을 숨기고 사람·신분없는 옛 세션은 남긴다', async () => {
    const human = createSession({ origin: 'cli', title: 'human' }, sessionRoot);
    const old = createSession({ title: 'unlabeled old' }, sessionRoot);
    const harness = createSession({ origin: HARNESS_SESSION_ORIGIN, title: 'harness child' }, sessionRoot);
    const scheduled = createSession({ origin: 'cli', sourceKind: 'scheduled', title: 'cron' }, sessionRoot);
    const empty = createSession({ origin: 'cli', title: 'empty' }, sessionRoot);
    addUser(human.id, 'hello human');
    addUser(old.id, 'old chat');
    addUser(harness.id, 'goal child');
    addUser(scheduled.id, 'cron run');

    const body = await list();
    const ids = body.sessions.map((s) => s.id);
    expect(ids).toContain(human.id);
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(harness.id);
    expect(ids).not.toContain(scheduled.id);
    expect(ids).not.toContain(empty.id);
    expect(body.sessions.every((s) => !isHarnessSessionOrigin(s.origin))).toBe(true);
  });

  it('projectId 쿼리는 세 세션 중 한 개만 고르고, 쿼리 없으면 옛 카드까지 모두 남긴다', async () => {
    const matching = createSession({ projectId: 'project-a', title: 'matching' }, sessionRoot);
    const other = createSession({ projectId: 'project-b', title: 'other' }, sessionRoot);
    const old = createSession({ title: 'legacy' }, sessionRoot);
    for (const id of [matching.id, other.id, old.id]) addUser(id, 'hello');

    const filtered = await list('?projectId=project-a');
    expect(filtered.total).toBe(1);
    expect(filtered.sessions.map((s) => s.id)).toEqual([matching.id]);
    expect(filtered.sessions[0]?.projectId).toBe('project-a');

    const unfiltered = await list();
    expect(unfiltered.total).toBe(3);
    expect(unfiltered.sessions.map((s) => s.id).sort()).toEqual([matching.id, other.id, old.id].sort());
    expect(unfiltered.sessions.find((s) => s.id === other.id)?.projectId).toBe('project-b');
    expect(Object.hasOwn(unfiltered.sessions.find((s) => s.id === old.id)!, 'projectId')).toBe(false);
  });

  it('includeHarness=1 은 하니스 세션을 포함하고 기본보다 많다', async () => {
    const human = createSession({ origin: 'cli', title: 'human' }, sessionRoot);
    const harness = createSession({ origin: HARNESS_SESSION_ORIGIN, title: 'harness child' }, sessionRoot);
    addUser(human.id, 'hello');
    addUser(harness.id, 'child');
    const def = await list();
    const withHarness = await list('?includeHarness=1');
    expect(def.sessions.map((s) => s.id)).toEqual([human.id]);
    expect(withHarness.total).toBeGreaterThan(def.total);
    expect(withHarness.sessions.map((s) => s.id)).toContain(harness.id);
    expect(withHarness.sessions.map((s) => s.id)).toContain(human.id);
  });

  it('includeOperational=1 은 크론을 포함해도 하니스는 기본 숨김을 유지한다', async () => {
    const human = createSession({ origin: 'cli', title: 'human' }, sessionRoot);
    const harness = createSession({ origin: HARNESS_SESSION_ORIGIN, title: 'harness child' }, sessionRoot);
    const scheduled = createSession({ origin: 'cli', sourceKind: 'scheduled', title: 'cron' }, sessionRoot);
    addUser(human.id, 'hello');
    addUser(harness.id, 'child');
    addUser(scheduled.id, 'cron');
    const body = await list('?includeOperational=1');
    const ids = body.sessions.map((s) => s.id);
    expect(ids).toContain(human.id);
    expect(ids).toContain(scheduled.id);
    expect(ids).not.toContain(harness.id);
  });

  it('기본 목록에서 고른 사람 세션은 GET 으로 이어서 열 수 있다', async () => {
    const human = createSession({ origin: 'cli', title: 'human' }, sessionRoot);
    addUser(human.id, 'keep going');
    const listed = await list();
    expect(listed.sessions[0]?.id).toBe(human.id);
    const res = handleSessionsStoreGet(
      new Request(`http://localhost:31415/v1/sessions/store/${human.id}`),
      human.id,
      OPTS,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; messages: Array<{ content: string }> };
    expect(body.ok).toBe(true);
    expect(body.messages.some((m) => m.content === 'keep going')).toBe(true);
  });

  it('없는 세션: 기본은 404 · `?ifExists=1` 이면 200 에 exists:false(새 세션 복원이 오류를 남기지 않게)', async () => {
    const missing = 'no-such-session-id';
    const plain = handleSessionsStoreGet(new Request(`http://localhost:31415/v1/sessions/store/${missing}`), missing, OPTS);
    expect(plain.status).toBe(404);
    const soft = handleSessionsStoreGet(new Request(`http://localhost:31415/v1/sessions/store/${missing}?ifExists=1`), missing, OPTS);
    expect(soft.status).toBe(200);
    expect(await soft.json()).toEqual({ ok: true, exists: false, messages: [] });
  });
});
