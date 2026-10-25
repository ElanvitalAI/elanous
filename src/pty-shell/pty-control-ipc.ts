import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ptyManifestDbPath, getPtyManifest, markPtyControlled, listPtyManifestRows, listPtyManifestRowsAt } from './pty-manifest.js';
import { getHarnessRunId } from '../harness/harness-space.js';
import { renamePty, type PtyControlTarget } from './registry.js';
import { resizePtyWithOutcome, writePtyWithOutcome, writePtyWithOutcomeDetail } from './pty-write-outcome.js';
import { resetExternalWriteProvenanceForTesting } from './pty-write-provenance.js';
import { parsePtyWriteActor, resolveRemoteControlActor, type PtyWriteActor } from './pty-write-arbiter.js';
import { isPtyAccessMode, resolvePtyRef, type PtyRefReason } from './pty-ref.js';
import { RemotesStore } from '../cli/remotes.js';
import { bookmarkToElanousRemote } from '../cli/remote-resolve.js';
import { debug } from '../debug/log.js';
import { encodeSgrMouse, mouseModeOffReason, type PtyMouseInput } from './pty-mouse.js';
import { startPtyRecording, stopPtyRecording } from './pty-recording.js';
import { withExternalKeyCommand } from '../input/external-input-queue.js';

const OWNER_PTY_CONTROL_ACTIONS = ['takeover', 'release', 'input-text', 'input-key', 'input-mouse', 'resize', 'snapshot', 'rename', 'terminate', 'capabilities', 'record-start', 'record-stop'] as const;
export type PtyControlAction = typeof OWNER_PTY_CONTROL_ACTIONS[number];
type PtyControlStatus = 'success' | 'unknown-pty' | 'denied' | 'failed' | 'write-failed' | 'owner-unreachable';

/** Capability replies describe the owner process's dispatcher, not the requester's build. */
export type PtyControlCapabilitiesResult =
  | { readonly status: 'success'; readonly actions: readonly string[] }
  | { readonly status: 'unsupported' }
  | { readonly status: 'no-response' }
  | { readonly status: 'owner-result'; readonly result: PtyControlResult }
  /** A settled owner reply whose capability payload is not a string list. Preserve it verbatim for diagnosis. */
  | { readonly status: 'protocol-error'; readonly result: unknown };

function isOwnerPtyControlAction(action: string): action is PtyControlAction {
  return (OWNER_PTY_CONTROL_ACTIONS as readonly string[]).includes(action);
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export type PtyControlPayload =
  | { readonly chars: string }
  | PtyMouseInput
  | { readonly cols: number; readonly rows: number }
  | { readonly ansi: boolean }
  | { readonly nickname: string }
  | { readonly cols: number; readonly rows: number; readonly title?: string };

export interface PtyControlRequestOptions {
  /** 요청자가 주장하는 쓰기 주체. `'agent'` 는 run-identity 일치를 요구한다(`resolveRemoteControlActor`). */
  readonly actor?: PtyWriteActor;
  readonly timeoutMs?: number;
  /** 대상 PTY를 발견한 매니페스트 뿌리. 연합 조회는 이 DB에 제어 요청을 남겨 그 행의 owner가 처리하게 한다. */
  readonly manifestDbPath?: string;
  /** 요청자 poll 루프의 시계(기본 `Date.now`) — deadline·grace 경계를 재는 유일한 시계다.
   *  ⛔ 원장 시각(`created_at`/`updated_at`)은 여전히 `Date.now()` 다 — 원장 형식은 이 옵션에 안 흔들린다. */
  readonly now?: () => number;
  /** 요청자 poll 루프의 대기(기본 `Bun.sleep`) — 기본값에서 25ms cadence 계약은 그대로다. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 사람 타이핑 세션 — 있으면 재해석·재캡처 없이 이 «고정값»만 쓴다(`beginPtyHumanTypingSession`). */
  readonly typingSession?: PtyHumanTypingSession;
  /** 아직 세션이 없을 때 캡처할 북마크 이름(없으면 remotes.json 의 default · 그것도 없으면 로컬). */
  readonly bookmarkName?: string;
  /** 호출자가 이미 캡처해 둔 북마크 핀 — 재조회하지 않는다. */
  readonly typingBookmark?: PtyTypingBookmarkPin;
}

export interface PtyControlResult {
  readonly status: PtyControlStatus;
  readonly from?: string;
  readonly to?: string;
  readonly policy?: string;
  readonly reason?: string;
  readonly screen?: string;
  readonly source?: 'live' | 'frame';
  readonly frameAt?: number;
  readonly diagnostic?: 'owner-unavailable' | 'render-unavailable';
  readonly frameUnavailable?: boolean;
  readonly actions?: readonly string[];
  readonly path?: string;
  readonly recordingId?: string;
  readonly bytes?: number;
  readonly durationMs?: number;
}

interface ControlRow {
  request_id: string;
  pty_id: string;
  action: string;
  payload_json: string | null;
  /** NULL = 마이그레이션 前 행 또는 미지정 → `'human'`(종전 동작). ⚠️ 아는 값이 아니면 거부한다
   *  — 여기는 신뢰 경계 밖이라 컬럼에 무엇이든 들어올 수 있다(`parsePtyWriteActor`). */
  actor: string | null;
  /** 요청 프로세스의 K run anchor(`''` 가능) — owner 가 대상 PTY 의 run 과 대조한다. */
  requester_run_id: string | null;
  owner_pid: number;
  status: 'pending' | 'processing' | PtyControlStatus;
  result_json: string | null;
}

const ROW_COLUMNS = 'request_id, pty_id, action, payload_json, actor, requester_run_id, owner_pid, status, result_json';

const PTY_CONTROL_STALE_MS = 30_000;
const PTY_CONTROL_PROCESSING_STALE_MS = 120_000;
const DEFAULT_PTY_TAKEOVER_TTL_MS = 30 * 60_000;
let database: Database | null = null;

export function migratePtyControlSchema(d: Database): void {
  try { d.run('ALTER TABLE pty_control_requests ADD COLUMN payload_json TEXT'); } catch { /* existing database */ }
  // F3 `agent` 슬라이스 — 주체와 그 주체의 run anchor. NULL 인 기존 행은 'human'/'' 로 읽혀 종전 동작 유지.
  try { d.run('ALTER TABLE pty_control_requests ADD COLUMN actor TEXT'); } catch { /* existing database */ }
  try { d.run('ALTER TABLE pty_control_requests ADD COLUMN requester_run_id TEXT'); } catch { /* existing database */ }
  try { d.run('ALTER TABLE pty_takeover_previous_modes ADD COLUMN taken_over_at INTEGER NOT NULL DEFAULT 0'); } catch { /* existing database or table not yet created */ }
}

function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const next = new Database(path);
  next.run('PRAGMA journal_mode = WAL');
  next.run('PRAGMA busy_timeout = 2000');
  next.run(`CREATE TABLE IF NOT EXISTS pty_control_requests (
    request_id TEXT PRIMARY KEY, pty_id TEXT NOT NULL, action TEXT NOT NULL,
    payload_json TEXT, actor TEXT, requester_run_id TEXT,
    owner_pid INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  migratePtyControlSchema(next);
  next.run('CREATE INDEX IF NOT EXISTS idx_pty_control_owner_status ON pty_control_requests (owner_pid, status)');
  // PTY owner restart 뒤에도 release가 최초 takeover 직전 모드로 돌아가도록 요청 원장과 같은
  // manifest DB에 보존한다. pty_id는 registry가 소유하는 canonical ID다.
  next.run(`CREATE TABLE IF NOT EXISTS pty_takeover_previous_modes (
    pty_id TEXT PRIMARY KEY, previous_mode TEXT NOT NULL, taken_over_at INTEGER NOT NULL DEFAULT 0
  )`);
  migratePtyControlSchema(next);
  return next;
}

function db(): Database {
  if (database) return database;
  database = openDb(ptyManifestDbPath());
  return database;
}

function dbAt(path?: string): { database: Database; close: () => void } {
  if (!path || path === ptyManifestDbPath()) return { database: db(), close: () => {} };
  const remote = openDb(path);
  return { database: remote, close: () => remote.close() };
}

const SELECT_ROW = `SELECT ${ROW_COLUMNS} FROM pty_control_requests WHERE request_id=?`;
function settled(status: ControlRow['status']): boolean { return status !== 'pending' && status !== 'processing'; }
function resultFrom(row: ControlRow): PtyControlResult {
  if (!settled(row.status)) return { status: 'owner-unreachable' };
  try { return JSON.parse(row.result_json ?? `{"status":"${row.status}"}`) as PtyControlResult; } catch { return { status: row.status as PtyControlStatus }; }
}
function cleanupStale(d: Database): void {
  const now = Date.now();
  d.run("DELETE FROM pty_control_requests WHERE created_at < ? AND status != 'processing'", [now - PTY_CONTROL_STALE_MS]);
  d.run("DELETE FROM pty_control_requests WHERE created_at < ? AND status = 'processing'", [now - PTY_CONTROL_PROCESSING_STALE_MS]);
}

// ── TUI-IDLE-PTY-DEEP-IDLE-FU (#29694) — owner 큐 재읽기의 깊은 유휴 감속 ⊕ 첫 요청 즉시 깨움 ──
//
// owner 프로세스는 `registry.startPtyControlPoller` 가 **25ms 마다** 부르는 `processPtyControlRequests` 로
// 제어 큐(같은 SQLite 원장)를 다시 읽는다. 사람이 자리를 비운 채 TUI 가 몇 시간 떠 있으면 그 재읽기가
// 시간당 14만 번씩 DB 를 두드린다 — 제어가 **10분 넘게** 없었으면 재읽기 간격을 1.5s 로 늦춘다.
// ⛔ 감속만 넣으면 첫 원격 요청이 최대 1.5s 뒤에야 처리돼 25ms 응답 계약이 깨진다. 그래서 요청자는
//    큐와 «별도»인 깨어움 표식을 남기고(`signalPtyControlWake`), owner 는 tick 마다 그 파일의 존재만
//    싸게 확인한다(`consumePtyControlWake`). DB 재읽기보다 훨씬 싸고, 그 tick 안에서 즉시 깬다.
interface ControlCadenceState {
  /** 마지막 **제어 요청 처리** 시각 — `markPtyControlled` 와 같은 사건을 앵커로 쓴다. */
  lastControlAt: number | null;
  /** 마지막으로 큐를 실제로 **다시 읽은** 시각 — 감속 간격의 기준점. */
  lastDbReadAt: number | null;
  /** 이 상태를 마지막으로 관측한 시계 값 — 시계가 뒤로 가면 앵커를 버린다(시계 교체 감지). */
  lastSeenAt: number | null;
  observed: 'active' | 'deep-idle' | null;
}

/** 큐 원장 경로마다 따로 센다 — 원장 경로가 바뀌면(시험용 `setPtyManifestDbPathForTesting`) 이전
 *  경로의 유휴 앵커가 새 원장에 얹히지 않는다. ⛔ 열쇠는 **읽는 원장과 같은 경로**여야 한다
 *  (`processPtyControlRequestsOnce` 가 여는 `db()` 와 동일: `ptyManifestDbPath()`). */
const controlCadence = new Map<string, ControlCadenceState>();

function cadenceState(dbPath: string): ControlCadenceState {
  const known = controlCadence.get(dbPath);
  if (known) return known;
  const fresh: ControlCadenceState = { lastControlAt: null, lastDbReadAt: null, lastSeenAt: null, observed: null };
  controlCadence.set(dbPath, fresh);
  return fresh;
}

/** 재읽기를 늦추기 시작하는 유휴 길이. 「10분+ 유휴 뒤 1.5s」의 앞 절반. */
const PTY_CONTROL_DEEP_IDLE_AFTER_MS = 10 * 60_000;
/** 깊은 유휴에서의 재읽기 간격. 요청 wake 는 이 간격을 «기다리지 않는다». */
const PTY_CONTROL_DEEP_IDLE_POLL_MS = 1_500;

/** 감속 계단의 두 값과 «계측» 훅 — 생산 기본값은 위 상수 ⊕ env override 다. */
interface ControlCadenceLimits {
  readonly deepIdleAfterMs: number;
  readonly deepIdlePollMs: number;
  /** 큐를 실제로 다시 읽을 때마다 1회 — 감속 계측용(생산 진입점은 넘기지 않는다). */
  readonly onQueueRead?: () => void;
}

/** 생산 폴러는 옵션 없이 호출되므로 env override 뒤 상수 기본값만 사용한다. */
function resolveCadenceMs(envName: string, fallback: number): number {
  return positiveInteger(Number(process.env[envName])) ?? fallback;
}

function cadenceLimits(options: PtyControlProcessOptions): ControlCadenceLimits {
  return {
    deepIdleAfterMs: resolveCadenceMs('ELANOUS_PTY_CONTROL_DEEP_IDLE_AFTER_MS', PTY_CONTROL_DEEP_IDLE_AFTER_MS),
    deepIdlePollMs: resolveCadenceMs('ELANOUS_PTY_CONTROL_DEEP_IDLE_POLL_MS', PTY_CONTROL_DEEP_IDLE_POLL_MS),
    ...(options.onQueueRead ? { onQueueRead: options.onQueueRead } : {}),
  };
}

/** 깨어움 표식은 큐와 같은 원장 디렉터리에 둔다 — 요청자와 owner 가 같은 원장(`ptyManifestDbPath`)을
 *  볼 때 owner 의 tick 이 곧바로 그 자리를 본다. 연합 큐(`manifestDbPath`)로 남의 원장에 요청하면
 *  표식은 그 원장 자리에 남고 그 owner 는 감속 간격만큼만 늦다(요청 timeout 안쪽 · fail-soft).
 *  ⭐ 표식은 **owner 별** 파일이다(`control-wake-<ownerPid>`) — 요청자는 이미 `ownerPid` 를 알고,
 *  같은 `ELANOUS_STATE_DIR` 원장을 공유하는 여러 프로세스의 `startPtyControlPoller` 가 각자 돌아도
 *  비대상 owner 가 대상 owner 의 표식을 가져가 즉시 깨움(25ms)을 훔치지 못하게 한다. */
function wakeSignalPath(dbPath: string, ownerPid: number): string {
  return join(dirname(dbPath), `control-wake-${ownerPid}`);
}

/** 구형 요청자가 남기던 공유 표식 — 읽기 «호환 경로»로만 유지한다(새 경로는 owner 별 파일만 쓴다). */
function legacyWakeSignalPath(dbPath: string): string {
  return join(dirname(dbPath), 'control-wake');
}

/** 요청자가 대상 owner 의 깨움 표식을 남긴다 — owner «별» 파일(`control-wake-<ownerPid>`). */
export function signalPtyControlWake(dbPath: string, ownerPid: number): void {
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(wakeSignalPath(dbPath, ownerPid), '');
  } catch { /* fail-soft — 표식이 없으면 감속 간격만큼만 늦다(timeout 안쪽) */ }
}

/** «자기» `ownerPid` 의 표식이 있으면 지우고 `true` — 요청자는 행을 «넣은 뒤» 그 행의 owner
 *  표식을 남기므로, 그 owner 의 이 tick 재읽기는 그 행을 반드시 본다. 남의 owner 표식과 구형
 *  공유 표식은 잔존 호환으로 «읽기만» 한다(비대상 owner 가 이 표식을 지울 수는 없다). */
function consumePtyControlWake(dbPath: string): boolean {
  const own = wakeSignalPath(dbPath, process.pid);
  let woke = false;
  if (existsSync(own)) {
    woke = true;
    try { rmSync(own, { force: true }); } catch { /* 다음 tick 이 다시 지운다 */ }
  }
  const legacy = legacyWakeSignalPath(dbPath);
  if (existsSync(legacy)) {
    woke = true;
    try { rmSync(legacy, { force: true }); } catch { /* 다음 tick 이 다시 지운다 */ }
  }
  return woke;
}

function observeControlCadence(state: ControlCadenceState, mode: 'active' | 'deep-idle', idleMs: number): void {
  if (state.observed === mode) return;
  state.observed = mode;
  debug.log('pty.control', 'poll-cadence', { mode, idleMs });
}

/** 깊은 유휴 감속 gate — `false` 면 이번 tick 은 큐를 **다시 읽지 않는다**.
 *  ⛔ 첫 tick 은 언제나 읽는다(기동 직후 도착한 요청을 감속 뒤에 두지 않는다).
 *  ⛔ 감속 시계는 `pollClock`(기본 `Date.now`) 뿐이다 — `now`(takeover TTL 시계)를 섞으면 시험이
 *     주입한 값이 실제 tick 을 감속시키는 회귀가 난다. */
function shouldReadControlQueue(dbPath: string, nowMs: number, limits: ControlCadenceLimits): boolean {
  const state = cadenceState(dbPath);
  // 시계가 뒤로 갔다 = 이전 관측과 다른 시계다. 그 앵커로는 유휴를 못 재므로 버리고 다시 센다.
  if (state.lastSeenAt !== null && nowMs < state.lastSeenAt) {
    state.lastControlAt = null;
    state.lastDbReadAt = null;
    state.observed = null;
  }
  state.lastSeenAt = nowMs;
  const woke = consumePtyControlWake(dbPath);
  if (state.lastControlAt === null || woke) state.lastControlAt = nowMs;
  const idleMs = nowMs - state.lastControlAt;
  const deepIdle = idleMs >= limits.deepIdleAfterMs;
  const sinceReadMs = state.lastDbReadAt === null ? Number.POSITIVE_INFINITY : nowMs - state.lastDbReadAt;
  if (!woke && deepIdle && sinceReadMs < limits.deepIdlePollMs) {
    observeControlCadence(state, 'deep-idle', idleMs);
    return false;
  }
  state.lastDbReadAt = nowMs;
  observeControlCadence(state, deepIdle ? 'deep-idle' : 'active', idleMs);
  limits.onQueueRead?.();
  return true;
}

export async function requestRemotePtyControlCapabilities(id: string, options: PtyControlRequestOptions = {}): Promise<PtyControlCapabilitiesResult> {
  const result = await requestRemotePtyControl(id, 'capabilities', undefined, options);
  if (result.status === 'success') {
    return isStringList(result.actions)
      ? { status: 'success', actions: result.actions }
      : { status: 'protocol-error', result };
  }
  if (result.status === 'denied' && result.reason === 'unsupported-action') return { status: 'unsupported' };
  if (result.status === 'owner-unreachable') return { status: 'no-response' };
  return { status: 'owner-result', result };
}

// ── PTY-HUMAN-TYPING-REMOTE (0.2.36 · UX 칸) — 사람 타이핑의 ref 해석·bookmark 캡처는 «한 번» ──
//
// `--remote --human` 타이핑은 호출자가 준 ref(alias·nickname)를 그대로 원장에 흘리면 안 된다:
// 타이핑 도중 nickname 이 바뀌면 같은 입력이 다른 PTY 로 풀리고, 북마크(host·token·url)가 갈라지면
// «어느 원격에 쓰는가» 자체가 흔들린다. ⇒ 첫 글자를 넣기 前에 한 번 해석·캡처하고 그 값을 세션 전체에
// 고정한다. 해석이 확정되기 前에는 원장 행을 «쓰지 않는다»(fail-closed).
//
// ⛔ 여기서 해석기를 새로 만들지 않는다 — 목록은 `pty-manifest`(listPtyManifestRows/…At),
//    해석은 `pty-ref`(resolvePtyRef), 북마크는 `cli/remotes`(RemotesStore) 가 정본이다.

/** 사람 타이핑 세션이 고정하는 원격 북마크 신원 — 캡처는 세션 시작 때 한 번뿐이다. */
export interface PtyTypingBookmarkPin {
  readonly name: string;
  readonly host: string;
  readonly url: string;
  readonly token?: string;
}

/** 타이핑 세션의 고정값 — 이 객체가 사는 동안 재해석·재조회가 없다. */
export interface PtyHumanTypingSession {
  /** 호출자가 준 ref(그대로 보존 — 원장·로그 대조용). */
  readonly ref: string;
  /** 해석된 canonical pty id — 이후 모든 요청이 쓰는 유일한 주소. */
  readonly ptyId: string;
  /** 어느 단계로 확정됐나(`exact-id`·`nickname-exact`·`kind`·`id-prefix`·`nickname-substr`). */
  readonly resolvedBy: PtyRefReason;
  /** 캡처된 원격 북마크(로컬이면 null). */
  readonly bookmark: PtyTypingBookmarkPin | null;
  /** 해석에 쓴 매니페스트 뿌리 — 연합 요청이면 그 원장이다. */
  readonly manifestDbPath?: string;
}

export interface PtyHumanTypingOptions {
  /** 해석에 쓸 매니페스트 뿌리 — 없으면 이 프로세스의 원장(`ptyManifestDbPath`). */
  readonly manifestDbPath?: string;
  /** 이미 읽어 둔 핀(호출자가 캡처를 마친 경우) — 재조회하지 않는다. */
  readonly bookmark?: PtyTypingBookmarkPin;
  /** 캡처할 북마크 이름. 없으면 default 북마크, 그것도 없으면 로컬(null). */
  readonly bookmarkName?: string;
  /** remotes.json 저장소 재정의(시험·연합). */
  readonly remotes?: RemotesStore;
}

export type PtyHumanTypingResolution =
  | { readonly ok: true; readonly session: PtyHumanTypingSession }
  | {
    readonly ok: false;
    readonly status: 'ambiguous-ref' | 'unresolved-ref' | 'unknown-bookmark';
    /** ambiguous 면 후보 canonical id 들(사람이 고를 수 있게). */
    readonly candidates: readonly string[];
  };

type BookmarkCapture = { readonly ok: true; readonly pin: PtyTypingBookmarkPin | null } | { readonly ok: false };

function captureTypingBookmark(options: PtyHumanTypingOptions): BookmarkCapture {
  if (options.bookmark) return { ok: true, pin: options.bookmark };
  const wanted = options.bookmarkName?.trim() ?? '';
  try {
    const store = options.remotes ?? new RemotesStore();
    const listed = wanted ? undefined : store.listRemotes().find((item) => item.isDefault);
    const entry = wanted ? store.getRemote(wanted) : listed?.entry;
    if (!entry) return wanted ? { ok: false } : { ok: true, pin: null };
    const token = store.readToken(entry);
    return {
      ok: true,
      pin: {
        name: wanted || listed?.name || entry.host,
        host: entry.host,
        url: bookmarkToElanousRemote(entry),
        ...(token ? { token } : {}),
      },
    };
  } catch {
    return { ok: false };
  }
}

/**
 * ★ 사람 타이핑 세션 시작 — ref(alias·nickname·id)를 canonical id 로 **한 번** 해석하고
 *   bookmark host/token/URL 을 **한 번** 캡처한다. 해석이 확정되지 않으면 세션을 만들지 않는다.
 *
 * 목록은 «한 번의 스냅숏»이다(살아 있는 행만) — 해석 도중 목록이 바뀌어도 이 세션은 흔들리지 않는다.
 */
export function beginPtyHumanTypingSession(ref: string, options: PtyHumanTypingOptions = {}): PtyHumanTypingResolution {
  const items = (options.manifestDbPath ? listPtyManifestRowsAt(options.manifestDbPath) : listPtyManifestRows())
    .filter((row) => row.alive)
    .map((row) => ({ id: row.id, kind: row.kind, ...(row.nickname ? { nickname: row.nickname } : {}) }));
  const resolution = resolvePtyRef(ref, items);
  if (!resolution.match) {
    const candidates = resolution.candidates.map((item) => item.id);
    debug.log('pty.control', 'typing-ref-unresolved', { ref, reason: resolution.reason, candidates });
    return { ok: false, status: resolution.reason === 'ambiguous' ? 'ambiguous-ref' : 'unresolved-ref', candidates };
  }
  const captured = captureTypingBookmark(options);
  if (!captured.ok) {
    // ⛔ 명시적으로 부른 북마크를 못 읽었으면 fail-closed. (부르지 않은 default 캡처 실패는 로컬로 떨어진다 — 아래)
    if (options.bookmarkName?.trim()) {
      debug.log('pty.control', 'typing-bookmark-unavailable', { ref, bookmark: options.bookmarkName.trim() });
      return { ok: false, status: 'unknown-bookmark', candidates: [] };
    }
    debug.log('pty.control', 'typing-bookmark-skipped', { ref, reason: 'default-bookmark-unreadable' });
  }
  const session: PtyHumanTypingSession = {
    ref,
    ptyId: resolution.match.id,
    resolvedBy: resolution.reason,
    bookmark: captured.ok ? captured.pin : null,
    ...(options.manifestDbPath ? { manifestDbPath: options.manifestDbPath } : {}),
  };
  debug.log('pty.control', 'typing-session-pinned', {
    ref: session.ref,
    ptyId: session.ptyId,
    resolvedBy: session.resolvedBy,
    bookmark: session.bookmark?.name ?? 'local',
  });
  return { ok: true, session };
}

export async function requestRemotePtyControl(id: string, action: PtyControlAction, payloadOrTimeout?: PtyControlPayload | number, timeoutOrOptions: PtyControlRequestOptions | number = {}): Promise<PtyControlResult> {
  const payload = typeof payloadOrTimeout === 'number' ? undefined : payloadOrTimeout;
  const options = typeof timeoutOrOptions === 'number' ? { timeoutMs: timeoutOrOptions } : timeoutOrOptions;
  const timeoutMs = typeof payloadOrTimeout === 'number' ? payloadOrTimeout : options.timeoutMs ?? 2_000;
  const actor: PtyWriteActor = options.actor ?? 'human';
  // 요청자 poll 루프의 시계·대기 — 기본값이면 종전 그대로(`Date.now` ⊕ 25ms `Bun.sleep`)이고,
  // 시험만 가상 시각으로 deadline·grace 경계와 cadence 를 결정론적으로 민다(벽시계 판별 없음).
  const pollNow = options.now ?? Date.now;
  const pollWait = options.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms));
  // ⭐ 사람 타이핑(input-text/input-key)은 원장에 «쓰기 前» ref 를 canonical id 로 확정한다.
  //    확정 전에는 행을 안 쓴다(fail-closed) — 미해석·모호한 ref 가 남의 PTY 에 닿지 않게.
  const typingAction = action === 'input-text' || action === 'input-key';
  let session = options.typingSession;
  let targetId = id;
  if (typingAction) {
    if (!session) {
      const started = beginPtyHumanTypingSession(id, {
        ...(options.manifestDbPath ? { manifestDbPath: options.manifestDbPath } : {}),
        ...(options.bookmarkName ? { bookmarkName: options.bookmarkName } : {}),
        ...(options.typingBookmark ? { bookmark: options.typingBookmark } : {}),
      });
      if (!started.ok) {
        return started.status === 'ambiguous-ref'
          ? { status: 'denied', reason: 'pty-ref-ambiguous' }
          : started.status === 'unknown-bookmark'
            ? { status: 'denied', reason: 'typing-bookmark-unavailable' }
            : { status: 'unknown-pty' };
      }
      session = started.session;
    }
    targetId = session.ptyId;
  }
  // 세션 핀이 연합 원장을 정했으면 그 원장을 쓴다(재해석·재조회 없음).
  const queuePath = options.manifestDbPath ?? session?.manifestDbPath;
  const opened = dbAt(queuePath);
  const d = opened.database;
  try {
    cleanupStale(d);
    const target = queuePath
      ? d.query('SELECT owner_pid, alive FROM pty_manifest WHERE id=?').get(targetId) as { owner_pid: number; alive: number } | null
      : getPtyManifest(targetId);
    if (!target || !target.alive) return { status: 'unknown-pty' };
    const ownerPid = 'owner_pid' in target ? target.owner_pid : target.ownerPid;
    const requestId = crypto.randomUUID();
    const now = Date.now();
    // ⭐ 요청자의 run anchor 를 요청에 실어 보낸다 — 인가는 **owner 가** 자기 PTY 의 run 과 대조해 내린다
    //    (요청자 자기 신고를 그대로 믿지 않는다는 뜻이 아니라, 판정 지점이 자원 소유자라는 뜻).
    d.run(`INSERT INTO pty_control_requests (request_id, pty_id, action, payload_json, actor, requester_run_id, owner_pid, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [requestId, targetId, action, payload ? JSON.stringify(payload) : null, actor, getHarnessRunId(process.env), ownerPid, 'pending', now, now]);
    // ⭐ 깊은 유휴 감속 중인 owner 를 즉시 깨운다 — 행을 넣은 «뒤» 표식을 남기므로 그 재읽기가 이 행을 본다.
    //    표식은 그 행의 `ownerPid` «별» 파일이다 — 같은 원장을 공유하는 다른 owner 가 가져가지 못한다.
    signalPtyControlWake(queuePath ?? ptyManifestDbPath(), ownerPid);
    const readback = (): ControlRow | null => d.query(SELECT_ROW).get(requestId) as ControlRow | null;
    const del = (): void => { d.run('DELETE FROM pty_control_requests WHERE request_id=?', [requestId]); };
    const deadline = pollNow() + timeoutMs;
    while (pollNow() < deadline) {
      const row = readback();
      if (row && settled(row.status)) { del(); return resultFrom(row); }
      await pollWait(25);
    }
    if (d.run("DELETE FROM pty_control_requests WHERE request_id=? AND status='pending'", [requestId]).changes > 0) return { status: 'owner-unreachable' };
    const graceDeadline = pollNow() + 500;
    while (pollNow() < graceDeadline) {
      const row = readback();
      if (!row) return { status: 'owner-unreachable' };
      if (settled(row.status)) { del(); return resultFrom(row); }
      await pollWait(25);
    }
    const final = readback();
    if (final && settled(final.status)) { del(); return resultFrom(final); }
    return { status: 'owner-unreachable' };
  } finally {
    opened.close();
  }
}

function parsePayload(row: ControlRow): PtyControlPayload | null {
  try { return row.payload_json ? JSON.parse(row.payload_json) as PtyControlPayload : null; } catch { return null; }
}

/** 화면 렌더 상한 — ⛔ 이 함수는 **절대 reject 하지 않고 절대 매달리지 않는다**.
 *  둘 중 하나라도 새면 위 두 사고(행 유실 · 전역 차단)가 난다. */
const SNAPSHOT_RENDER_TIMEOUT_MS = 5_000;
async function renderScreenBounded(render: () => Promise<string>): Promise<PtyControlResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const screen = await Promise.race([
      render(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('screen-render-timeout')), SNAPSHOT_RENDER_TIMEOUT_MS); }),
    ]);
    return { status: 'success', screen, source: 'live' };
  } catch (e) {
    return { status: 'failed', reason: (e as Error)?.message === 'screen-render-timeout' ? 'screen-render-timeout' : 'screen-render-failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const TERMINATION_TIMEOUT_MS = 1_000;
async function terminatePty(handle: PtyControlTarget): Promise<PtyControlResult> {
  if (!handle.kill) return { status: 'failed', reason: 'termination-failed' };
  try {
    handle.kill('SIGTERM');
    const deadline = Date.now() + TERMINATION_TIMEOUT_MS;
    while (handle.isAlive() && Date.now() < deadline) await Bun.sleep(25);
    return handle.isAlive()
      ? { status: 'failed', reason: 'termination-failed' }
      : { status: 'success' };
  } catch {
    return { status: 'failed', reason: 'termination-failed' };
  }
}

/** 진행 중인 처리 — ⛔ **직렬화 가드**(무인 리뷰 must-fix · 2026-07-29).
 *  `snapshot` 이 들어오며 이 함수가 async 가 됐다. 원자적 claim 은 **중복 처리**만 막을 뿐,
 *  느린 `renderScreen()` 을 await 하는 동안 **다음 폴링이 뒤 요청을 먼저 집어** FIFO 가 깨진다
 *  (기존 5개 액션의 순서 계약이 회귀한다). ⇒ 한 번에 하나만 돈다. */
let inFlight: Promise<void> | null = null;

export interface PtyControlProcessOptions {
  readonly now?: () => number;
  readonly takeoverTtlMs?: number;
  /** 깊은 유휴 감속 계단 **전용** 시계(기본 `Date.now`). `now` 는 takeover TTL 시계라 섞지 않는다. */
  readonly pollClock?: () => number;
  /** 큐를 실제로 다시 읽을 때마다 1회 — 감속 계측용. 생산 진입점은 넘기지 않는다. */
  readonly onQueueRead?: () => void;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function resolveTakeoverTtlMs(options: PtyControlProcessOptions): number {
  if (options.takeoverTtlMs !== undefined) {
    return positiveInteger(options.takeoverTtlMs) ?? DEFAULT_PTY_TAKEOVER_TTL_MS;
  }
  return positiveInteger(Number(process.env.ELANOUS_PTY_TAKEOVER_TTL_MS))
    ?? DEFAULT_PTY_TAKEOVER_TTL_MS;
}

function reapExpiredTakeovers(d: Database, getHandle: (id: string) => PtyControlTarget | undefined, now: number, ttlMs: number): void {
  const loans = d.query('SELECT pty_id, previous_mode, taken_over_at FROM pty_takeover_previous_modes WHERE taken_over_at > 0 AND ? - taken_over_at >= ?').all(now, ttlMs) as Array<{ pty_id: string; previous_mode: string; taken_over_at: number }>;
  for (const loan of loans) {
    const handle = getHandle(loan.pty_id);
    if (!handle) continue;
    const heldMs = now - loan.taken_over_at;
    if (!isPtyAccessMode(loan.previous_mode)) {
      debug.log('pty.takeover', 'takeover-expire-denied', { id: loan.pty_id, reason: 'invalid-previous-mode' });
      continue;
    }
    const from = handle.accessMode;
    if (!handle.setAccessMode(loan.previous_mode)) {
      debug.log('pty.takeover', 'takeover-expire-denied', { id: loan.pty_id, reason: 'transition-policy' });
      continue;
    }
    d.run('DELETE FROM pty_takeover_previous_modes WHERE pty_id=?', [loan.pty_id]);
    debug.log('pty.takeover', 'takeover-expired', { id: loan.pty_id, from, to: handle.accessMode, heldMs });
  }
}

export function processPtyControlRequests(getHandle: (id: string) => PtyControlTarget | undefined, takeover: (id: string, actor: 'human') => boolean, options: PtyControlProcessOptions = {}): Promise<void> {
  if (inFlight) return inFlight;
  // 깊은 유휴 감속(#29694) — 이 함수는 `pty-shell/registry.ts:startPtyControlPoller` 가 25ms 마다 부른다.
  //   감속 구간에서는 여기서 «큐를 다시 읽지 않는» 것으로 끝나고, 첫 원격 요청의 표식이 오면 즉시 통과한다.
  //   ⛔ 감속 열쇠는 아래 `processPtyControlRequestsOnce` 가 실제로 여는 원장(`db()` = `ptyManifestDbPath()`)과
  //      같은 경로다 — 상태는 한 큐, 읽기는 다른 큐로 갈라지지 않는다.
  if (!shouldReadControlQueue(ptyManifestDbPath(), (options.pollClock ?? Date.now)(), cadenceLimits(options))) return Promise.resolve();
  inFlight = processPtyControlRequestsOnce(getHandle, takeover, options).finally(() => { inFlight = null; });
  return inFlight;
}

async function processPtyControlRequestsOnce(getHandle: (id: string) => PtyControlTarget | undefined, takeover: (id: string, actor: 'human') => boolean, options: PtyControlProcessOptions): Promise<void> {
  const d = db();
  const now = options.now ?? Date.now;
  reapExpiredTakeovers(d, getHandle, now(), resolveTakeoverTtlMs(options));
  const rows = d.query(`SELECT ${ROW_COLUMNS} FROM pty_control_requests WHERE owner_pid=? AND status='pending' ORDER BY created_at ASC`).all(process.pid) as ControlRow[];
  // 제어를 «처리했다» = 유휴 앵커를 지금으로 되감는다(`markPtyControlled` 와 같은 사건).
  if (rows.length > 0) cadenceState(ptyManifestDbPath()).lastControlAt = (options.pollClock ?? Date.now)();
  for (const row of rows) {
    if (d.run("UPDATE pty_control_requests SET status='processing', updated_at=? WHERE request_id=? AND status='pending'", [Date.now(), row.request_id]).changes === 0) continue;
    let requested: PtyWriteActor | null = null;
    let result: PtyControlResult = { status: 'failed', reason: 'control-processing-error' };
    try {
      markPtyControlled(row.pty_id, Date.now());
      const handle = getHandle(row.pty_id);
      requested = parsePtyWriteActor(row.actor);
      if (!handle || !handle.isAlive()) result = { status: 'unknown-pty' };
      // This only makes owners started after this code available honest; already-running owners retain their startup code.
      else if (!isOwnerPtyControlAction(row.action)) result = { status: 'denied', reason: 'unsupported-action' };
      else if (row.action === 'capabilities') result = { status: 'success', actions: OWNER_PTY_CONTROL_ACTIONS };
      else if (row.action === 'terminate') result = await terminatePty(handle);
      else if (row.action === 'record-start' || row.action === 'record-stop') {
        if (requested === null) result = { status: 'denied', reason: 'invalid-actor' };
        else if (row.action === 'record-stop') {
          const stopped = stopPtyRecording(row.pty_id);
          result = stopped.ok
            ? { status: 'success', path: stopped.path, bytes: stopped.bytes, durationMs: stopped.durationMs }
            : { status: 'denied', reason: stopped.reason };
        } else {
          const payload = parsePayload(row);
          if (payload !== null && (typeof payload !== 'object' || Array.isArray(payload)
            || !('cols' in payload) || !('rows' in payload)
            || !Number.isSafeInteger(payload.cols) || payload.cols < 1
            || !Number.isSafeInteger(payload.rows) || payload.rows < 1
            || ('title' in payload && payload.title !== undefined && typeof payload.title !== 'string'))) {
            result = { status: 'denied', reason: 'invalid-record-payload' };
          } else {
            // The cast header must carry the PTY's real size, and only the owner knows it:
            // a caller's cols/rows are never trusted, and an unknown size is refused, never guessed.
            const cols = handle.cols;
            const rows = handle.rows;
            if (cols === undefined || rows === undefined) {
              result = { status: 'denied', reason: 'dimensions-unknown' };
            } else {
              const started = startPtyRecording(row.pty_id, {
                cols,
                rows,
                ...(payload && 'title' in payload && typeof payload.title === 'string' ? { title: payload.title } : {}),
              });
              result = started.ok
                ? { status: 'success', recordingId: started.recordingId, path: started.path }
                : { status: 'denied', reason: started.reason };
            }
          }
        }
      } else if (row.action === 'snapshot') {
        if (!handle.renderScreen) {
          result = { status: 'failed', reason: 'screen-unavailable' };
        }
        // ⛔⭐ 두 가지를 함께 막는다(무인 리뷰 must-fix · 2026-07-29):
        //   ① **거부** — 여기서 throw 가 새면 프로세서가 통째로 reject 하고 이 행이
        //      'processing' 인 채 남는다(요청자는 타임아웃, 행은 유실).
        //   ② **영원한 pending** — 화면 렌더가 끝나지 않으면 직렬화 가드(inFlight)가
        //      영구 고정돼 **기존 5개 액션까지 전부 차단**된다. 내가 넣은 가드가 만든
        //      새 위험이라 여기서 반드시 상한을 준다.
        else {
          const payload = parsePayload(row);
          const ansi = payload !== null && 'ansi' in payload && payload.ansi === true;
          result = await renderScreenBounded(() => handle.renderScreen!(ansi ? { ansi: true } : undefined));
        }
      } else if (requested === null) result = { status: 'denied', reason: 'invalid-actor' };
      else if (row.action === 'rename') {
        const payload = parsePayload(row);
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || !('nickname' in payload) || typeof payload.nickname !== 'string') result = { status: 'denied', reason: 'invalid-rename-payload' };
        // Rename changes only the label; unlike ownership transfer, both humans and agents may request it.
        else result = renamePty(row.pty_id, payload.nickname) ? { status: 'success' } : { status: 'unknown-pty' };
      } else if (row.action === 'takeover' || row.action === 'release') {
        // ⚠️ 소유권 전이는 아직 사람 축만이다 — `agent` 는 자기 소유(`auto`) 자식에 그냥 쓰면 되므로
        //    이 슬라이스에 agent 전이가 필요 없다. 조용히 human 으로 떨어뜨리지 않고 **거부**한다.
        //    사유에 액션을 실어 `takeover`/`release` 중 무엇이 막혔는지 관측에서 갈린다.
        if (requested === 'agent') result = { status: 'denied', reason: `agent-${row.action}-unsupported` };
        else {
          const from = handle.accessMode;
          const policy = handle.transitionPolicy;
          if (row.action === 'takeover') {
            // INSERT OR IGNORE preserves the original mode and first takeover time over repeated requests.
            const saved = d.run('INSERT OR IGNORE INTO pty_takeover_previous_modes (pty_id, previous_mode, taken_over_at) VALUES (?, ?, ?)', [row.pty_id, from, now()]);
            const ok = takeover(row.pty_id, 'human');
            if (!ok && saved.changes > 0) d.run('DELETE FROM pty_takeover_previous_modes WHERE pty_id=?', [row.pty_id]);
            result = ok ? { status: 'success', from, to: handle.accessMode, policy } : { status: 'denied', from, policy, reason: 'transition-policy' };
          } else {
            const saved = d.query('SELECT previous_mode FROM pty_takeover_previous_modes WHERE pty_id=?').get(row.pty_id) as { previous_mode: string } | null;
            if (!saved) result = { status: 'denied', from, policy, reason: 'no-takeover-to-release' };
            else if (!isPtyAccessMode(saved.previous_mode)) {
              result = { status: 'denied', from, policy, reason: 'invalid-previous-mode' };
            } else {
              const ok = handle.setAccessMode(saved.previous_mode);
              if (ok) d.run('DELETE FROM pty_takeover_previous_modes WHERE pty_id=?', [row.pty_id]);
              result = ok
                ? { status: 'success', from, to: handle.accessMode, policy }
                : { status: 'denied', from, policy, reason: 'transition-policy' };
            }
          }
        }
      } else {
        const authorized = resolveRemoteControlActor(requested, row.requester_run_id ?? '', getPtyManifest(row.pty_id)?.runId ?? '');
        const payload = parsePayload(row);
        if (!authorized.allow) result = { status: 'denied', reason: authorized.reason };
        else if (!payload) result = { status: 'denied', reason: 'invalid-payload' };
        else if (row.action === 'resize' && 'cols' in payload) {
          const outcome = resizePtyWithOutcome(handle, payload.cols, payload.rows, authorized.actor);
          result = outcome === 'success'
            ? { status: 'success' }
            : outcome === 'denied'
              ? { status: 'denied', reason: 'write-arbiter' }
              : { status: 'failed', reason: 'resize-error' };
        } else if (row.action === 'input-mouse' && 'kind' in payload && 'x' in payload && 'y' in payload) {
          let chars: string | undefined;
          try { chars = encodeSgrMouse(payload); }
          catch { result = { status: 'denied', reason: 'invalid-mouse-payload' }; }
          if (chars !== undefined) {
            const off = mouseModeOffReason(handle);
            if (off) result = { status: 'denied', reason: off };
            else {
              const outcome = writePtyWithOutcome(handle, chars, authorized.actor);
              result = outcome === 'success' ? { status: 'success' } : outcome === 'denied' ? { status: 'denied', reason: 'write-arbiter' } : { status: 'write-failed', reason: 'adapter-write' };
            }
          }
        } else if ((row.action === 'input-text' || row.action === 'input-key') && 'chars' in payload) {
          // ⛔⭐ 여기서 세지 «않는다» — 계기는 `registry.write`(진짜 초크포인트)에 있다.
          //   여기서도 세면 크로스-프로세스 쓰기가 **두 번** 세어진다(`[S]` 리뷰 후 이동).
          //   `input-key` 는 TUI 외부 입력 대기열(`input/external-input-queue`)을 타지 않는다 — 글이 아니라 키다.
          const write = (): ReturnType<typeof writePtyWithOutcomeDetail> => writePtyWithOutcomeDetail(handle, payload.chars, authorized.actor);
          const outcome = row.action === 'input-key' ? withExternalKeyCommand(write) : write();
          result = outcome.status === 'success'
            ? { status: 'success' }
            : outcome.status === 'denied'
              ? { status: 'denied', reason: 'write-arbiter' }
              : { status: 'write-failed', reason: outcome.reason ?? 'adapter-write' };
        } else result = { status: 'denied', reason: 'invalid-payload' };
      }
    } catch (error) {
      result = { status: 'failed', reason: 'control-processing-error' };
      debug.log('pty.takeover', 'control-processing-error', { id: row.pty_id, action: row.action, actor: requested ?? row.actor, error: (error as Error).message });
    }
    d.run("UPDATE pty_control_requests SET status=?, result_json=?, updated_at=? WHERE request_id=? AND status='processing'", [result.status, JSON.stringify(result), Date.now(), row.request_id]);
    debug.log('pty.arbiter', 'control-settled', { id: row.pty_id, action: row.action, actor: requested ?? row.actor, outcome: result.status, reason: result.reason });
  }
}

export function resetPtyControlIpcForTesting(): void {
  database?.close(); database = null;
  // 깊은 유휴 감속 상태(#29694)도 «같이» 비운다 — 남으면 다음 시험/기동이 감속 구간에서 시작한다.
  controlCadence.clear();
  try {
    rmSync(wakeSignalPath(ptyManifestDbPath(), process.pid), { force: true });
    rmSync(legacyWakeSignalPath(ptyManifestDbPath()), { force: true });
  } catch { /* 표식이 없으면 그만 */ }
  // ⛔⭐ 쓰기 출처 맵도 «같이» 비운다 — 별도 export 로만 두면 아무도 안 부르고 테스트 사이에 샌다
  //   (오늘 `index.ts:65 readStdinLine` 이 정확히 그 형태로 죽어 있었다).
  resetExternalWriteProvenanceForTesting();
}
