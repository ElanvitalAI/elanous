import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ptyManifestDbPath, getPtyManifest, markPtyControlled } from './pty-manifest.js';
import { getHarnessRunId } from '../harness/harness-space.js';
import { renamePty, type PtyControlTarget } from './registry.js';
import { resizePtyWithOutcome, writePtyWithOutcome } from './pty-write-outcome.js';
import { resetExternalWriteProvenanceForTesting } from './pty-write-provenance.js';
import { parsePtyWriteActor, resolveRemoteControlActor, type PtyWriteActor } from './pty-write-arbiter.js';
import { isPtyAccessMode } from './pty-ref.js';
import { debug } from '../debug/log.js';
import { encodeSgrMouse, mouseModeOffReason, type PtyMouseInput } from './pty-mouse.js';
import { startPtyRecording, stopPtyRecording } from './pty-recording.js';

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

export async function requestRemotePtyControl(id: string, action: PtyControlAction, payloadOrTimeout?: PtyControlPayload | number, timeoutOrOptions: PtyControlRequestOptions | number = {}): Promise<PtyControlResult> {
  const payload = typeof payloadOrTimeout === 'number' ? undefined : payloadOrTimeout;
  const options = typeof timeoutOrOptions === 'number' ? { timeoutMs: timeoutOrOptions } : timeoutOrOptions;
  const timeoutMs = typeof payloadOrTimeout === 'number' ? payloadOrTimeout : options.timeoutMs ?? 2_000;
  const actor: PtyWriteActor = options.actor ?? 'human';
  const opened = dbAt(options.manifestDbPath);
  const d = opened.database;
  try {
    cleanupStale(d);
    const target = options.manifestDbPath
      ? d.query('SELECT owner_pid, alive FROM pty_manifest WHERE id=?').get(id) as { owner_pid: number; alive: number } | null
      : getPtyManifest(id);
    if (!target || !target.alive) return { status: 'unknown-pty' };
    const ownerPid = 'owner_pid' in target ? target.owner_pid : target.ownerPid;
    const requestId = crypto.randomUUID();
    const now = Date.now();
    // ⭐ 요청자의 run anchor 를 요청에 실어 보낸다 — 인가는 **owner 가** 자기 PTY 의 run 과 대조해 내린다
    //    (요청자 자기 신고를 그대로 믿지 않는다는 뜻이 아니라, 판정 지점이 자원 소유자라는 뜻).
    d.run(`INSERT INTO pty_control_requests (request_id, pty_id, action, payload_json, actor, requester_run_id, owner_pid, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [requestId, id, action, payload ? JSON.stringify(payload) : null, actor, getHarnessRunId(process.env), ownerPid, 'pending', now, now]);
    const readback = (): ControlRow | null => d.query(SELECT_ROW).get(requestId) as ControlRow | null;
    const del = (): void => { d.run('DELETE FROM pty_control_requests WHERE request_id=?', [requestId]); };
    const deadline = now + timeoutMs;
    while (Date.now() < deadline) {
      const row = readback();
      if (row && settled(row.status)) { del(); return resultFrom(row); }
      await Bun.sleep(25);
    }
    if (d.run("DELETE FROM pty_control_requests WHERE request_id=? AND status='pending'", [requestId]).changes > 0) return { status: 'owner-unreachable' };
    const graceDeadline = Date.now() + 500;
    while (Date.now() < graceDeadline) {
      const row = readback();
      if (!row) return { status: 'owner-unreachable' };
      if (settled(row.status)) { del(); return resultFrom(row); }
      await Bun.sleep(25);
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
  inFlight = processPtyControlRequestsOnce(getHandle, takeover, options).finally(() => { inFlight = null; });
  return inFlight;
}

async function processPtyControlRequestsOnce(getHandle: (id: string) => PtyControlTarget | undefined, takeover: (id: string, actor: 'human') => boolean, options: PtyControlProcessOptions): Promise<void> {
  const d = db();
  const now = options.now ?? Date.now;
  reapExpiredTakeovers(d, getHandle, now(), resolveTakeoverTtlMs(options));
  const rows = d.query(`SELECT ${ROW_COLUMNS} FROM pty_control_requests WHERE owner_pid=? AND status='pending' ORDER BY created_at ASC`).all(process.pid) as ControlRow[];
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
          const outcome = writePtyWithOutcome(handle, payload.chars, authorized.actor);
          result = outcome === 'success'
            ? { status: 'success' }
            : outcome === 'denied'
              ? { status: 'denied', reason: 'write-arbiter' }
              : { status: 'write-failed', reason: 'adapter-write' };
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
  // ⛔⭐ 쓰기 출처 맵도 «같이» 비운다 — 별도 export 로만 두면 아무도 안 부르고 테스트 사이에 샌다
  //   (오늘 `index.ts:65 readStdinLine` 이 정확히 그 형태로 죽어 있었다).
  resetExternalWriteProvenanceForTesting();
}
