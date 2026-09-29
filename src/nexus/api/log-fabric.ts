// ── NEXUS · 통합 로그 패브릭 REST (LF1 · 2026-07-13) ────────────────────────
//
// adb logcat 의 서버 반쪽 — logs.db(LF0) 위의 조회/스트림/레벨 제어 3면.
//
//   GET  /v1/logs          — 필터 조회 (level·surface·category·exactCategory·event·grep·since·session)
//   GET  /v1/logs/stream   — SSE 라이브 tail (같은 필터 서버측 적용 · 500ms 폴)
//   GET  /v1/logs/level    — 데몬 레벨/게이트 조회
//   POST /v1/logs/level    — 레벨 런타임 변경 (즉시 적용 + config write-through)
//
// 불변식 (PLAN §5):
//   • 이 파일 안에서 debug.log 호출 금지 — auth 경계(INCIDENT 2026-05-07) +
//     로그 평면 자기참조 방지. 진단은 응답 body 로만.
//   • 스트림 폴은 store 를 pull — StoreSink 쪽에 fan-out 훅을 달지 않는다
//     (역압·피드백 루프 원천 차단).
//
// 설계: 내부 문서 `PLAN-unified-log-fabric-2026-07-13` §LF1.

import {
  getDefaultLogStore,
  resolveLogInstanceName,
  LogCursorNotFoundError,
  LogStore,
  type LogQuery,
  type LogStoreRow,
} from '../../mss/logging/log-store.js';
import { readLogInstances, type LogInstanceView } from '../../mss/logging/instance-registry.js';
import { LOG_LEVEL_ORDER, type LogLevel } from '../../mss/logging/record.js';
import { debug, type DebugLevel } from '../../debug/log.js';
import { persistScopedDebugLevel, persistScopedRenderLogs } from '../../mss/logging/scoped-level.js';
import { userConfigPath } from '../../user-config.js';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { jsonResponse } from './http-server.js';

const STREAM_POLL_MS = 500;
/** HTTP 응답 보호 상한 — 무한정 큰 응답을 막는다. 로컬 직독(CLI)에는 걸지 않는다. */
export const HTTP_LOG_LIMIT_MAX = 1000;
/** Bounded server-side fan-in protects a daemon from opening every registered universe. */
const HTTP_LOG_STORE_MAX = 20;

const STREAM_BATCH_LIMIT = 500;
const VALID_DEBUG_LEVELS: readonly DebugLevel[] = ['off', 'trail', 'diag', 'normal', 'verbose', 'detail', 'keytrace'];

/** 테스트 주입 seam — 기본은 싱글톤(NODE_ENV=test 에서 null → 503). */
export interface LogFabricDeps {
  store?: () => LogStore | null;
  setLevel?: (level: DebugLevel) => void;
  persistLevel?: (level: DebugLevel) => void;
  /** OH9 — 렌더 무음 스위치 라이브 적용 + 영속(레벨과 직교 축). */
  setRenderSuppressed?: (on: boolean) => void;
  persistRenderLogs?: (render: boolean) => void;
  /** LF7-d — 레지스트리 주입(연합 조회 테스트용). */
  instances?: () => LogInstanceView[];
  /** 연합 스토어 open 주입 — 리졸버의 선택 결과를 테스트에서 관측한다. */
  openRemoteStore?: (view: LogInstanceView) => LogStore | null;
  /** `store=@active` 가 «최근에 쓰인» 우주를 고를 때 보는 logs.db 수정 시각(테스트 주입). */
  dbMtimeMs?: (dbPath: string) => number | null;
  /** 다중 과거 조회가 연 원격 스토어의 정리를 테스트에서 관측한다. */
  closeRemoteStore?: (store: LogStore) => void;
  /**
   * prod 합성 뿌리 주입 — ⛔ 이 자리를 «환경 변수»로 흔들지 않는다.
   * `homedir()` 는 플랫폼마다 다른 규칙으로 prod 경로를 고르는 «계약»이고, 시험 편의로 그것을
   * `process.env.HOME` 로 바꾸면 그 계약 자체가 달라진다(리뷰 must-fix 실측).
   */
  prodStateRoot?: () => string;
}

// ── 연합 스토어 리졸버 (LF7-d) ────────────────────────────────────────
//
// `?store=<인스턴스이름>` 으로 타 인스턴스의 logs.db 를 read-only 로 조회.
// 경로는 레지스트리(user 소유 파일)에서만 나온다 — 클라이언트가 임의 경로를
// 지정할 수 없다. 쓰기는 물리 격리·읽기는 연합 불변식의 데몬 반쪽.

const remoteStoreCache = new Map<string, LogStore>();

function openRemoteStore(view: LogInstanceView): LogStore | null {
  const cached = remoteStoreCache.get(view.dbPath);
  if (cached) return cached;
  try {
    const store = LogStore.openReadOnly(view.dbPath);
    remoteStoreCache.set(view.dbPath, store);
    return store;
  } catch {
    return null;
  }
}

/** GET fan-in owns these read-only handles for one response and therefore never retains them in the stream cache. */
function openRemoteStoreForQuery(view: LogInstanceView): LogStore | null {
  try { return LogStore.openReadOnly(view.dbPath); } catch { return null; }
}

/** store 파라미터 해석 — 반환 null 은 "타겟 자체가 없음"(404 사유 포함). */
function resolveStoreParam(
  url: URL,
  deps: LogFabricDeps,
  normalizedName?: string,
): { store: LogStore | null; error?: string } {
  const name = normalizedName ?? url.searchParams.get('store')?.trim();
  const self = (deps.store ?? getDefaultLogStore)();
  if (!name || name === resolveLogInstanceName()) return { store: self };
  const views = (deps.instances ?? readLogInstances)();
  let hit = views.find((v) => v.name === name) ?? views.find((v) => v.name === `test:${name}`);
  // prod 는 CLI 와 동형으로 암묵 타겟 — prod 데몬이 레지스트리에 아직 없어도
  // (LF7-b 이전 부팅) 홈 스토어 경로는 항상 알 수 있다.
  if (!hit && name === 'prod') {
    const prodRoot = (deps.prodStateRoot ?? (() => join(homedir(), '.elanous')))(); // prod 는 config-dir==state-dir(단일 뿌리)
    const dbPath = join(prodRoot, 'logs', 'logs.db');
    // ⭐ 이 합성은 «단일 뿌리 하나»를 만든 것이므로 그 수를 «안다» — 지어낸 값이 아니다.
    //   그리고 「걸쳤나」는 그 수에서 나온다(등록부가 쓰는 관계와 같다) — 두 값을 따로 두면 어긋난다.
    const stateDirCount = 1;
    hit = {
      name: 'prod', stateDir: prodRoot, pid: 0,
      startedAt: '', alive: false, liveness: 'dead', dbExists: existsSync(dbPath), dbPath,
      stateDirCount, ambiguous: stateDirCount > 1,
      kind: 'prod', configDir: prodRoot,
    };
  }
  if (!hit) return { store: null, error: `unknown instance '${name}'` };
  if (!hit.dbExists) return { store: null, error: `instance '${name}' has no log store yet` };
  const remote = (deps.openRemoteStore ?? openRemoteStore)(hit);
  if (!remote) return { store: null, error: `instance '${name}' store open failed` };
  return { store: remote };
}

interface SelectedLogStore {
  name: string;
  store?: LogStore | null;
  view?: LogInstanceView;
  reason?: string;
  remote: boolean;
}

/** Multi-store GET selection only validates names; opening is owned and closed by the query loop. */
function selectLogStores(url: URL, deps: LogFabricDeps): {
  selected: SelectedLogStore[];
  storeLimitReached: boolean;
  error?: string;
} {
  const names = [...new Set(url.searchParams.getAll('store')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean))];
  const selfName = resolveLogInstanceName();
  const self = (deps.store ?? getDefaultLogStore)();
  const views = (deps.instances ?? readLogInstances)();
  const limited = names.slice(0, HTTP_LOG_STORE_MAX);
  const storeLimitReached = names.length > limited.length;
  const selected: SelectedLogStore[] = [];

  for (const name of limited) {
    if (name === selfName) {
      selected.push({ name, store: self, remote: false });
      continue;
    }
    const view = views.find((candidate) => candidate.name === name)
      ?? views.find((candidate) => candidate.name === `test:${name}`);
    if (!view) return { selected: [], storeLimitReached, error: `unknown instance '${name}'` };
    selected.push(view.dbExists
      ? { name, view, remote: true }
      : { name, reason: `instance '${name}' has no log store yet`, remote: true });
  }
  return { selected, storeLimitReached };
}

function compareLogRows(left: LogStoreRow, right: LogStoreRow): number {
  const timestamp = Date.parse(right.ts) - Date.parse(left.ts);
  if (timestamp !== 0) return timestamp;
  const id = right.id - left.id;
  if (id !== 0) return id;
  return (left.instance ?? '').localeCompare(right.instance ?? '');
}

// ── 쿼리 파싱 ─────────────────────────────────────────────────────────

/** `30s`/`15m`/`2h`/`7d` 상대 표기 또는 epoch ms/ISO → epoch ms. null=파싱 불가. */
export function parseSinceParam(raw: string, nowMs: number = Date.now()): number | null {
  const rel = /^(\d+)(s|m|h|d)$/.exec(raw.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 's' | 'm' | 'h' | 'd'];
    return nowMs - n * unit;
  }
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (dateOnly) {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return null;
    const [, year, month, day] = dateOnly;
    // Date(year, ...) maps 0–99 to 1900–1999; setFullYear preserves ISO years.
    const localMidnight = new Date(0);
    localMidnight.setHours(0, 0, 0, 0);
    localMidnight.setFullYear(Number(year), Number(month) - 1, Number(day));
    return localMidnight.getTime();
  }
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : null;
}

function csv(v: string | null): string[] | undefined {
  if (!v) return undefined;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export function parseLogQuery(url: URL): { query: LogQuery; error?: string } {
  const q: LogQuery = {};
  const level = url.searchParams.get('level');
  if (level) {
    if (!(level in LOG_LEVEL_ORDER)) return { query: q, error: `invalid level '${level}'` };
    q.minLevel = level as LogLevel;
  }
  const instances = csv(url.searchParams.get('instance'));
  if (instances) q.instances = instances;
  const surfaces = csv(url.searchParams.get('surface'));
  if (surfaces) q.surfaces = surfaces;
  const categories = csv(url.searchParams.get('category'));
  if (categories) q.categories = categories;
  const exactCategories = csv(url.searchParams.get('exactCategory'));
  if (exactCategories) q.exactCategories = exactCategories;
  const events = csv(url.searchParams.get('event'));
  if (events) q.events = events;
  const grep = url.searchParams.get('grep');
  if (grep) q.grep = grep;
  const sessionId = url.searchParams.get('sessionId');
  if (sessionId) q.sessionId = sessionId;
  const since = url.searchParams.get('since');
  if (since) {
    const ms = parseSinceParam(since);
    if (ms === null) return { query: q, error: `invalid since '${since}'` };
    q.sinceMs = ms;
  }
  const until = url.searchParams.get('until');
  if (until) {
    const ms = parseSinceParam(until);
    if (ms === null) return { query: q, error: `invalid until '${until}'` };
    q.untilMs = ms;
  }
  const before = url.searchParams.get('before');
  if (before) {
    const id = Number(before);
    if (!Number.isInteger(id) || id < 1) return { query: q, error: `invalid before '${before}'` };
    q.beforeId = id;
  }
  const limit = url.searchParams.get('limit');
  if (limit) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) return { query: q, error: `invalid limit '${limit}'` };
    // ⛔⭐ 상한은 **여기**가 자리다 — HTTP 응답은 무한정 커지면 안 된다(LF1 의 원래 의도).
    //   초판은 이 clamp 를 **스토어**에 뒀는데, 스토어는 CLI 의 **로컬 직독**도 함께 서빙한다.
    //   그래서 로컬 조회가 HTTP 용 상한을 물려받아 **`--since` 를 넓혀도 최근 1000건만** 왔고,
    //   두 트랙이 그것을 "7일치" 로 읽어 표본 판정을 잘못했다(2026-07-29 실측).
    q.limit = Math.min(n, HTTP_LOG_LIMIT_MAX);
  }
  return { query: q };
}

/** 행 → wire 형태(data JSON 파싱 · 실패 시 raw string 유지). */
function toWire(row: LogStoreRow): Record<string, unknown> {
  let data: unknown = row.data;
  if (typeof row.data === 'string' && row.data.length > 0) {
    try { data = JSON.parse(row.data); } catch { /* raw 유지 */ }
  }
  return {
    id: row.id,
    ts: row.ts,
    level: row.level,
    ...(row.instance ? { instance: row.instance } : {}),
    surface: row.surface,
    category: row.category,
    event: row.event,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.trace_id ? { traceId: row.trace_id } : {}),
    ...(data !== null && data !== undefined ? { data } : {}),
  };
}

// ── GET /v1/logs ──────────────────────────────────────────────────────

/** `store=@active` 가 가리키는 연합 — 이 인스턴스 ⊕ 최근 `ACTIVE_WINDOW_MS` 안에 logs.db 가 쓰인 우주(최신순 · 상한 `HTTP_LOG_STORE_MAX`).
 *  🅢 09-28 10:1x: 워크트리 발사 = 시험 우주 · 자식 = Pod 라 «이 인스턴스»만 보면 오늘 병합 150+ 가 0 으로 보였다.
 *  ⛔ 등록된 우주 전부(수백)를 한 GET 에서 열지 않는다 — 최근에 쓰인 것만. 고른 목록은 응답 `stores` 로 돌려준다(무엇을 봤나). */
export const ACTIVE_STORE_TOKEN = '@active';
const ACTIVE_WINDOW_MS = 24 * 60 * 60_000;
export function activeStoreNames(deps: LogFabricDeps, nowMs = Date.now()): string[] {
  const selfName = resolveLogInstanceName();
  const mtime = deps.dbMtimeMs ?? ((path: string) => { try { return statSync(path).mtimeMs; } catch { return null; } });
  const recent = (deps.instances ?? readLogInstances)()
    .filter((view) => view.dbExists && view.name !== selfName)
    .map((view) => ({ name: view.name, at: mtime(view.dbPath) }))
    .filter((view): view is { name: string; at: number } => view.at !== null && nowMs - view.at <= ACTIVE_WINDOW_MS)
    .sort((a, b) => b.at - a.at);
  const names = [selfName];
  for (const view of recent) {
    if (names.length >= HTTP_LOG_STORE_MAX) break;
    if (!names.includes(view.name)) names.push(view.name);
  }
  return names;
}

export function handleLogsQuery(req: Request, opts: MetaApiOpts, deps: LogFabricDeps = {}): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  let requestedNames = [...new Set(url.searchParams.getAll('store').flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean))];
  let activeStores: string[] | null = null;
  if (requestedNames.includes(ACTIVE_STORE_TOKEN)) {
    activeStores = activeStoreNames(deps);
    requestedNames = activeStores.length > 1 ? activeStores : [...activeStores, activeStores[0]!].slice(0, 1);
    url.searchParams.delete('store');
    for (const name of requestedNames) url.searchParams.append('store', name);
  }
  // Preserve every legacy response shape and error path unless this is explicitly a multi-store request.
  if (requestedNames.length <= 1) {
    const resolved = resolveStoreParam(url, deps, requestedNames[0]);
    if (resolved.error) return jsonResponse({ ok: false, error: 'unknown_store', reason: resolved.error }, 404);
    const store = resolved.store;
    if (!store) return jsonResponse({ ok: false, error: 'log-store-unavailable' }, 503);
    const { query, error } = parseLogQuery(url);
    if (error) return jsonResponse({ ok: false, error: 'bad_request', reason: error }, 400);
    let rows;
    try { rows = store.query(query); }
    catch (e) {
      if (e instanceof LogCursorNotFoundError) {
        return jsonResponse({ ok: false, error: 'cursor_not_found', reason: `before=${e.beforeId} row not in this store`, before: e.beforeId }, 400);
      }
      throw e;
    }
    return jsonResponse({ ok: true, logs: rows.map(toWire), count: rows.length, ts: new Date().toISOString() }, 200);
  }

  const { query, error } = parseLogQuery(url);
  if (error) return jsonResponse({ ok: false, error: 'bad_request', reason: error }, 400);
  // A numeric row id is local to one database; accepting it for fan-in would make
  // pagination silently skip or reject rows in the other stores.
  if (query.beforeId !== undefined) {
    return jsonResponse({ ok: false, error: 'multi_store_cursor_unsupported', reason: 'before is only supported when querying one store', before: query.beforeId }, 400);
  }
  const selection = selectLogStores(url, deps);
  if (selection.error) return jsonResponse({ ok: false, error: 'unknown_store', reason: selection.error }, 404);
  const rows: LogStoreRow[] = [];
  const failedStores: Array<{ name: string; reason: string }> = [];
  let opened = 0;
  for (const selected of selection.selected) {
    let store = selected.store;
    if (!store && selected.view) store = (deps.openRemoteStore ?? openRemoteStoreForQuery)(selected.view);
    if (!store) {
      failedStores.push({ name: selected.name, reason: selected.reason ?? `instance '${selected.name}' store open failed` });
      continue;
    }
    try {
      rows.push(...store.query({ ...query, limit: query.limit ?? 100 }).map((row) => ({
        ...row,
        instance: row.instance ?? selected.name,
      })));
      opened += 1;
    } catch (e) {
      failedStores.push({ name: selected.name, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      if (selected.remote) {
        try { (deps.closeRemoteStore ?? ((remote) => remote.close()))(store); } catch { /* response is already complete */ }
      }
    }
  }
  if (opened === 0) return jsonResponse({ ok: false, error: 'log-store-unavailable', failedStores }, 503);
  const limit = query.limit ?? 100;
  const merged = rows.sort(compareLogRows).slice(0, limit);
  return jsonResponse({
    ok: true,
    logs: merged.map(toWire),
    count: merged.length,
    ts: new Date().toISOString(),
    ...(failedStores.length ? { failedStores } : {}),
    ...(selection.storeLimitReached ? { storeLimitReached: true } : {}),
    ...(activeStores ? { stores: activeStores } : {}),
  }, 200);
}

// ── GET /v1/logs/facets · /v1/logs/histogram — 대시보드 데이터 (LF4) ──

export function handleLogsFacets(req: Request, opts: MetaApiOpts, deps: LogFabricDeps = {}): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const resolvedF = resolveStoreParam(url, deps);
  if (resolvedF.error) return jsonResponse({ ok: false, error: 'unknown_store', reason: resolvedF.error }, 404);
  const store = resolvedF.store;
  if (!store) return jsonResponse({ ok: false, error: 'log-store-unavailable' }, 503);
  const since = url.searchParams.get('since');
  let sinceMs: number | undefined;
  if (since) {
    const ms = parseSinceParam(since);
    if (ms === null) return jsonResponse({ ok: false, error: 'bad_request', reason: `invalid since` }, 400);
    sinceMs = ms;
  }
  return jsonResponse({ ok: true, ...store.facets(sinceMs) }, 200);
}

export function handleLogsHistogram(req: Request, opts: MetaApiOpts, deps: LogFabricDeps = {}): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const resolvedH = resolveStoreParam(url, deps);
  if (resolvedH.error) return jsonResponse({ ok: false, error: 'unknown_store', reason: resolvedH.error }, 404);
  const store = resolvedH.store;
  if (!store) return jsonResponse({ ok: false, error: 'log-store-unavailable' }, 503);
  const sinceMs = parseSinceParam(url.searchParams.get('since') ?? '1h') ?? Date.now() - 3_600_000;
  const bucketRaw = Number(url.searchParams.get('bucketMs'));
  const surfaces = url.searchParams.get('surface')?.split(',').map((s) => s.trim()).filter(Boolean);
  return jsonResponse({
    ok: true,
    buckets: store.histogram({
      sinceMs,
      ...(Number.isFinite(bucketRaw) && bucketRaw > 0 ? { bucketMs: bucketRaw } : {}),
      ...(surfaces && surfaces.length ? { surfaces } : {}),
    }),
  }, 200);
}

// ── GET /v1/logs/stream — SSE 라이브 tail ─────────────────────────────

export function handleLogsStream(req: Request, opts: MetaApiOpts, deps: LogFabricDeps = {}): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const resolvedS = resolveStoreParam(url, deps);
  if (resolvedS.error) return jsonResponse({ ok: false, error: 'unknown_store', reason: resolvedS.error }, 404);
  const store = resolvedS.store;
  if (!store) return jsonResponse({ ok: false, error: 'log-store-unavailable' }, 503);
  const { query, error } = parseLogQuery(url);
  if (error) return jsonResponse({ ok: false, error: 'bad_request', reason: error }, 400);

  let cancelled = false;
  let cursor = store.maxId(); // 접속 시점 이후만 — 과거는 GET /v1/logs 로
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (chunk: string): void => {
        if (cancelled) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { /* closed */ }
      };
      send(': unified log fabric stream\n\n');
      const tick = (): void => {
        if (cancelled) return;
        try {
          const rows = store.query({ ...query, afterId: cursor, limit: STREAM_BATCH_LIMIT });
          for (const row of rows) {
            cursor = Math.max(cursor, row.id);
            send(`event: log\ndata: ${JSON.stringify(toWire(row))}\n\n`);
          }
          // 필터에 걸러진 행도 커서는 전진해야 다음 폴이 재스캔 안 함 —
          // 필터가 있으면 상한을 별도로 당긴다.
          if (rows.length === 0) {
            const m = store.maxId();
            if (m > cursor) cursor = m;
          }
        } catch { /* fail-soft — 다음 tick */ }
        if (!cancelled) setTimeout(tick, STREAM_POLL_MS);
      };
      setTimeout(tick, STREAM_POLL_MS);
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}

// ── GET /v1/logs/instances — 연합 셀렉터 데이터 (LF7-d) ────────────────

export function handleLogsInstances(req: Request, opts: MetaApiOpts, deps: LogFabricDeps = {}): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const self = resolveLogInstanceName();
  const views = (deps.instances ?? readLogInstances)();
  const instances = views.map((v) => ({
    name: v.name,
    alive: v.alive,
    dbExists: v.dbExists,
    stateDir: v.stateDir,
    ...(v.repoPath ? { repoPath: v.repoPath } : {}),
    current: v.name === self,
  }));
  // 자기 자신이 레지스트리에 아직 없으면(구버전 부팅 등) 셀렉터용으로 합성.
  if (!instances.some((i) => i.current)) {
    instances.unshift({ name: self, alive: true, dbExists: true, stateDir: '', current: true });
  }
  // prod 도 암묵 타겟(리졸버 동형) — 미등록이면 홈 스토어 존재 시 합성.
  if (!instances.some((i) => i.name === 'prod')) {
    const prodDb = join(homedir(), '.elanous', 'logs', 'logs.db');
    if (existsSync(prodDb)) {
      instances.push({ name: 'prod', alive: false, dbExists: true, stateDir: join(homedir(), '.elanous'), current: false });
    }
  }
  return jsonResponse({ ok: true, self, instances }, 200);
}

// ── GET/POST /v1/logs/level — 레벨 런타임 제어 ────────────────────────
//
// POST 는 이 데몬 프로세스에 즉시 적용(setLevel) + config write-through
// (재기동 후 유지 — config-first). ⚠️ 별도 프로세스(TUI 대시보드 등)에는
// 각자의 /debug level 이 있다 — 본 API 는 nexus 데몬 스코프.

export function handleLogsLevelGet(req: Request, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const st = debug.status();
  return jsonResponse({
    ok: true,
    level: st.level,
    gates: {
      file: st.file,
      mirror: st.mirror,
      verbose: st.verbose,
      diag: st.diag,
      keytrace: debug.isKeyTraceEnabled(),
      // OH9 — 렌더 무음 스위치. true = 렌더 카테고리 억제 중(레벨과 직교).
      renderSuppressed: st.renderSuppressed,
    },
    filePath: st.path,
  }, 200);
}

/** [LF7-c 로 은퇴 — persistScopedDebugLevel 이 승계] debug.level 만 raw
 *  디스크 read-modify-write (원자적 tmp→rename). 레벨 영속은 이제 인스턴스
 *  스코프 파일(scoped-level.ts)로 가고 config.json 은 아예 안 만진다 —
 *  아래 사건 기록은 "왜 config 왕복이 금지인가"의 근거로 보존.
 *
 *  ⚠️ 사건 수리(2026-07-13): 종전 구현은 `getUserConfig() → saveUserConfig()`
 *  전체 왕복이었는데, `--test` 데몬은 test-safe **overlay**(텔레그램 토큰
 *  스왑·발신채널 drop·discord off — in-memory 전용 설계)가 getUserConfig 에
 *  걸려 있어 **overlay 된 뷰가 통째로 디스크에 저장**됐다 — 프로덕션
 *  telegram.botToken 이 테스트 토큰으로 덮이고 report/home 채널이 소실
 *  (즉시 백업 복원). 교훈: **overlay 프로세스에서 getUserConfig 결과를
 *  saveUserConfig 로 되쓰기 금지.** 여기선 파일을 직접 읽어 debug.level
 *  한 필드만 patch — overlay 무관·직렬화 부작용 0. */
export function persistDebugLevelRaw(level: DebugLevel, path: string = userConfigPath()): void {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  const dbg = (raw.debug ?? {}) as Record<string, unknown>;
  dbg.level = level;
  raw.debug = dbg;
  const tmp = `${path}.tmp-logs-level`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2));
  renameSync(tmp, path);
}

export async function handleLogsLevelPost(
  req: Request,
  opts: MetaApiOpts,
  deps: LogFabricDeps = {},
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  let body: unknown;
  try { body = await req.json(); }
  catch { return jsonResponse({ ok: false, error: 'invalid_json' }, 400); }
  const rawLevel = (body as { level?: unknown })?.level;
  const rawRender = (body as { render?: unknown })?.render;
  const hasLevel = rawLevel !== undefined && rawLevel !== null;
  const hasRender = rawRender !== undefined && rawRender !== null;
  // OH9 — level·render 는 직교 축이라 body 에 둘 중 하나만 와도 된다
  // (`elanous logs level --render on` 은 level 없이 render 만).
  if (!hasLevel && !hasRender) {
    return jsonResponse({ ok: false, error: 'no_level_or_render', valid: VALID_DEBUG_LEVELS }, 400);
  }
  if (hasLevel && (typeof rawLevel !== 'string' || !(VALID_DEBUG_LEVELS as readonly string[]).includes(rawLevel))) {
    return jsonResponse({ ok: false, error: 'invalid_level', valid: VALID_DEBUG_LEVELS }, 400);
  }
  // render: boolean 또는 'on'/'off' 수용. true = 렌더 로그 ON(비억제).
  let render: boolean | undefined;
  if (hasRender) {
    if (typeof rawRender === 'boolean') render = rawRender;
    else if (rawRender === 'on') render = true;
    else if (rawRender === 'off') render = false;
    else return jsonResponse({ ok: false, error: 'invalid_render', valid: ['on', 'off', true, false] }, 400);
  }

  let persisted = true;
  if (hasLevel) {
    const setLevel = deps.setLevel ?? ((l: DebugLevel) => debug.setLevel(l));
    setLevel(rawLevel as DebugLevel);
    // 영속 — 인스턴스 스코프 파일(LF7-c). 공유 config 무접촉 — 테스트 인스턴스의
    // 레벨 변경이 prod/타 인스턴스에 절대 번지지 않는다. 실패해도 라이브 적용은
    // 유효(응답에 표시).
    try {
      const persist = deps.persistLevel ?? persistScopedDebugLevel;
      persist(rawLevel as DebugLevel);
    } catch { persisted = false; }
  }
  if (render !== undefined) {
    // OH9 — 렌더 무음 라이브 적용(setRenderSuppressed = !render) + 영속.
    const setSuppressed = deps.setRenderSuppressed ?? ((on: boolean) => debug.setRenderSuppressed(on));
    setSuppressed(!render);
    try {
      const persist = deps.persistRenderLogs ?? persistScopedRenderLogs;
      persist(render);
    } catch { persisted = false; }
  }
  return jsonResponse({
    ok: true,
    ...(hasLevel ? { level: rawLevel } : {}),
    ...(render !== undefined ? { render } : {}),
    persisted,
  }, 200);
}
