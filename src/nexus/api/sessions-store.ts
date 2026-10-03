/**
 * `GET    /v1/sessions/store`           — on-disk 세션 목록(CLI + 텔레그램 실화).
 * `GET    /v1/sessions/store/:id`       — 세션 transcript(내용 보기).
 * `POST   /v1/sessions/store/:id/fork`  — 히스토리 복사 새 세션(codex fork 방식).
 * `DELETE /v1/sessions/store/:id`       — on-disk 세션 삭제(파괴적·index+jsonl 제거).
 *
 * 라이브 세션 관리(2026-07-09). 기존 `/v1/sessions*`(in-memory DaemonSessionHistory·
 * 텔레그램 미등록으로 빈 화면)와 달리, **on-disk 단일 진실원**(`src/session/index.ts`
 * index.json + <id>.jsonl)을 직접 읽어 대화중 세션까지 노출한다. 읽기 위주 + fork 는
 * 새 세션 생성만(원본 불변). 설계: 내부 문서 `DESIGN-live-session-management-2026-07-09`.
 */
import {
  listSessions,
  loadSession,
  forkSessionById,
  deleteSession,
  HARNESS_SESSION_ORIGIN,
  isHarnessSessionOrigin,
  type SessionMeta,
} from '../../session/index.js';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProject } from '../../project/project-store.js';
import { sessionRoot } from '../../session/index.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { jsonResponse } from './http-server.js';

/** active(대화중) 판정 임계 — updatedAt 이 10분 내면 최근 대화중으로 표시. */
const ACTIVE_MS = 10 * 60_000;

export interface SessionStoreCard {
  id: string;
  title: string;
  source: string;
  /** 세밀 origin(cli/pwa/tg/dc/harness) — PWA 챗 write-through 세션 구분.
   *  `harness` = 하니스 자식이 만든 세션. 기본 목록에서 숨기고 includeHarness=1 로 포함. */
  origin?: string;
  sourceKind?: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  forkedFromId?: string;
  /** 마지막 user/assistant 메시지 요약(≤120자). */
  preview: string;
  /** updatedAt 이 최근(<10m) — "대화중" 뱃지. */
  active: boolean;
}

function toCard(m: SessionMeta, preview: string, nowMs: number): SessionStoreCard {
  const ageMs = Math.max(0, nowMs - Date.parse(m.updatedAt));
  return {
    id: m.id,
    title: m.title,
    source: m.source,
    ...(m.origin ? { origin: m.origin } : {}),
    ...(m.sourceKind ? { sourceKind: m.sourceKind } : {}),
    ...(m.projectId !== undefined ? { projectId: m.projectId } : {}),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    messageCount: m.messageCount,
    ...(m.forkedFromId ? { forkedFromId: m.forkedFromId } : {}),
    preview,
    active: Number.isFinite(ageMs) && ageMs <= ACTIVE_MS,
  };
}

function lastPreview(id: string): string {
  try {
    const loaded = loadSession(id);
    if (!loaded) return '';
    const last = loaded.messages
      .filter((x) => x.role === 'user' || x.role === 'assistant')
      .slice(-1)[0];
    return (last?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  } catch {
    return '';
  }
}

/** GET /v1/sessions/store — on-disk 세션 목록(newest-first·기본 빈 세션 제외). */
export function handleSessionsStoreList(req: Request, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const includeEmpty = url.searchParams.get('includeEmpty') === '1';
  // 운영 크론 실행(sourceKind:'scheduled')은 기본 숨김 — includeOperational=1 로 포함.
  const includeOperational = url.searchParams.get('includeOperational') === '1';
  // 하니스 자식 세션(origin:'harness')은 기본 숨김 — includeHarness=1 로 포함.
  // 신분이 없는 옛 세션은 사람 대화로 본다(숨기지 않음). 제목 문면으로 판정하지 않는다.
  const includeHarness = url.searchParams.get('includeHarness') === '1';
  const projectId = url.searchParams.get('projectId');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 300);
  const nowMs = Date.now();

  let metas = listSessions({
    limit: 600,
    ...(projectId !== null ? { projectId } : {}),
    ...(includeOperational ? {} : { excludeSourceKinds: ['scheduled'] }),
    ...(includeHarness ? {} : { excludeOrigins: [HARNESS_SESSION_ORIGIN] }),
  }); // 이미 updatedAt DESC
  if (!includeHarness) metas = metas.filter((m) => !isHarnessSessionOrigin(m.origin));
  if (!includeEmpty) metas = metas.filter((m) => m.messageCount > 0);
  metas = metas.slice(0, limit);

  const sessions = metas.map((m) => toCard(m, lastPreview(m.id), nowMs));
  return jsonResponse({ ok: true, sessions, total: sessions.length, ts: new Date(nowMs).toISOString() }, 200);
}

/** GET /v1/sessions/store/:id — 세션 transcript(meta + messages). */
export function handleSessionsStoreGet(req: Request, id: string, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const loaded = loadSession(id);
  if (!loaded) {
    // `?ifExists=1` — «있으면 복원»하는 호출자(PWA 챗·터미널 독: 새 세션은 아직 저장소에 없다)용.
    // 없음을 오류가 아니라 값으로 돌려준다 — 404 가 매 새 세션마다 콘솔에 빨간 줄을 남겼다(탭 트리아지 P0).
    // ⛔ 기본은 404 그대로(다른 호출자 계약 불변).
    if (new URL(req.url).searchParams.get('ifExists') === '1') return jsonResponse({ ok: true, exists: false, messages: [] }, 200);
    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  }
  return jsonResponse({ ok: true, exists: true, meta: loaded.meta, messages: loaded.messages }, 200);
}

/** POST /v1/sessions/store/:id/fork — 히스토리 복사 새 세션(원본 불변·forkedFromId 링크).
 *
 *  S3 타임트래블(PWA 파리티 P2 · 2026-07-12): JSON body `{ beforeUser?: N }` 로
 *  N번째(1-based) 사용자 발화 직전으로 절단해 분기 — CLI `--before-user` ·
 *  tg `/fork before:N` 과 의미론 동일(`forkSessionById` 단일 경로). body 없으면
 *  현행 풀카피(하위호환). `deps.fork` 는 테스트 주입점(세션 store 는 실 ~/.elanous
 *  고정이라 spy 격리 — memory: 세션 저장소 테스트 격리). */
export async function handleSessionsStoreFork(
  req: Request,
  id: string,
  opts: MetaApiOpts,
  deps: { fork: typeof forkSessionById } = { fork: forkSessionById },
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);

  let beforeUser: number | undefined;
  try {
    const raw = (await req.text()).trim();
    if (raw) {
      const body = JSON.parse(raw) as { beforeUser?: unknown };
      if (body.beforeUser !== undefined) {
        const n = Number(body.beforeUser);
        if (!Number.isInteger(n) || n < 1) {
          return jsonResponse({ ok: false, error: 'invalid_before_user' }, 400);
        }
        beforeUser = n;
      }
    }
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
  }

  const forked = deps.fork(id, beforeUser !== undefined ? { beforeUser } : {});
  if (!forked) return jsonResponse({ ok: false, error: 'not_found' }, 404);
  return jsonResponse(
    {
      ok: true,
      id: forked.meta.id,
      meta: forked.meta,
      ...(beforeUser !== undefined ? { beforeUser } : {}),
    },
    200,
  );
}

/** PATCH /v1/sessions/store/:id — only project membership; leave transcript and other meta untouched. */
export async function handleSessionsStorePatch(req: Request, id: string, opts: MetaApiOpts): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    return jsonResponse({ ok: false, error: 'invalid_session_id' }, 400);
  }
  let body: unknown;
  try { body = await req.json(); }
  catch { return jsonResponse({ ok: false, error: 'invalid_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !Object.hasOwn(body, 'projectId')
    || Object.keys(body).some((key) => key !== 'projectId')) {
    return jsonResponse({ ok: false, error: 'invalid_project_id' }, 400);
  }
  const projectId = (body as { projectId: unknown }).projectId;
  if (projectId !== null && (typeof projectId !== 'string' || !getProject(projectId))) {
    return jsonResponse({ ok: false, error: 'invalid_project_id' }, 400);
  }

  const root = sessionRoot();
  const lock = join(root, '.index.lock');
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch {
      if (!existsSync(lock)) continue;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmdirSync(lock); continue; }
      } catch { continue; }
      if (Date.now() >= deadline) throw new Error(`timed out acquiring lock ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    const path = join(root, 'index.json');
    const entries = JSON.parse(readFileSync(path, 'utf8')) as SessionMeta[];
    const pos = entries.findIndex((meta) => meta.id === id);
    if (pos < 0) return jsonResponse({ ok: false, error: 'not_found' }, 404);
    const meta = { ...entries[pos] };
    if (projectId === null) delete meta.projectId;
    else meta.projectId = projectId;
    entries[pos] = meta;
    const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temp, JSON.stringify(entries, null, 2) + '\n', 'utf8');
    renameSync(temp, path);
    return jsonResponse({ ok: true, meta }, 200);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return jsonResponse({ ok: false, error: 'not_found' }, 404);
    throw error;
  } finally {
    rmdirSync(lock);
  }
}

/** DELETE /v1/sessions/store/:id — on-disk 세션 삭제(index.json + <id>.jsonl 제거).
 *  파괴적·복구불가. in-flight turn abort + in-memory history forget 도 fail-soft 로 동반. */
export function handleSessionsStoreDelete(req: Request, id: string, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    return jsonResponse({ ok: false, error: 'invalid_session_id' }, 400);
  }
  // in-flight turn 중단 + in-memory 기록 제거(있으면) — on-disk 삭제 전에.
  try { opts.abortSession?.(id); } catch { /* fail-soft */ }
  try { opts.history?.forget(id); } catch { /* fail-soft */ }
  const deleted = deleteSession(id); // on-disk(index+jsonl) 제거
  return jsonResponse({ ok: true, id, deleted }, 200);
}
