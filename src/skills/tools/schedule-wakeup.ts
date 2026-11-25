// ── 자기 예약 깨움 `ScheduleWakeup` (TUI-HOMEOSTASIS H5 · TUI-H5-SCHEDULE-WAKEUP · 0.2.31 · 2026-10-17) ─────
//
// 🚨 무엇을 푸는가: 자리 TUI 가 «다음 점검 13:20» 이라고 적고 턴을 끝내면, 13:20 에 아무것도 안 열린다
//   (10-16 OPT 실측). TUI 안에 «이 대화로 돌아오는» 예약이 없었다 — `schedule_manage` 는 시스템 crontab 이라
//   프로세스 밖에서 명령을 돌릴 뿐 이 TUI 의 다음 턴을 못 연다.
// ⭐ 이 모듈은 TUI 프로세스 «안» 타이머다: 모델이 «HH:MM» 또는 «N초 뒤»(반복 가능)를 예약하면, 그 시각에
//   H2 내부 턴 문(`startTurnIfIdle` · origin 'scheduled')으로 이 TUI 에 한 턴을 청한다. 문은 새로 짓지 않는다.
// ⛔ 입력칸 버퍼·`injectKey`·`hostControl.submit`·pty 주입 0(대표 비침투) — 거부 사유는 H2 가 낸다.
// ⛔ 조각 1 범위: 프로세스 안 타이머뿐 — TUI 가 재기동되면 예약은 사라진다(영속·재기동 복원은 후속).
//
// 규칙(grok-build scheduler 꼴): 최소 60초 · TUI 당 예약 상한 5 · 반복 7일 만료 · 직전 회차가 아직 돌면 건너뜀 ·
//   놓친 반복 틱은 하나로 합친다 · 발화 때 H2 가 거부하면(바쁨·사람 입력 중) 1분 뒤 다시 청하고(상한 30분),
//   그래도 거부하면 «턴 끝 배출» 대기 큐로 간다 — 입력칸이 다시 뜨는 순간(마운트) 반드시 1회 깨운다(소실 0).
//
// 세 얼굴:
//   관측 = debug.log('tui.wakeup', 'scheduled' | 'fired' | 'skipped' | 'rejected' | 'queued' | 'cancelled', { id, ... })
//   인지 = 예약 시각 도래 ∧ (직전 회차 진행 중 → 건너뜀 · 만료 → 소멸 · H2 거부 사유)
//   힐링 = H2 로 내부 턴(화면은 H2 의 «↻ 자동 재개(scheduled): …» 한 줄 · 예약 순간엔 «⏰ 예약 깨움 …» 한 줄) ·
//          거부 → 1분 뒤 재시도(상한 30분) → 그래도 거부하면 «⏰ 예약 깨움 대기» 한 줄 ⊕ «턴 끝 배출» 대기 큐(ELN-SEAT-WAKEUP-SCHEDULE-FAIL · OP #88346)
//
// 🩹 TUI-H5-ONESHOT-SCHEMA(0.2.32 · 라이브 실측 두 번): 모델이 «한 번만»을 `repeatMinutes:0` 으로 불렀다 →
//   «1 이상» 거부 → 1분 반복으로 재예약 → 취소 → 또 … 한 턴에 26회. ⇒ ① `repeatMinutes:0` = 일회성으로 받는다 ·
//   다른 틀린 값의 거부 문구는 «일회성은 repeatMinutes 생략» 을 가리킨다(재시도 고리를 끊는 안내) ·
//   ② 한 턴(같은 턴 id · H2 `lastTurnId`) 안 schedule·cancel 합계가 `WAKEUP_MAX_CALLS_PER_TURN` 을 넘으면
//   거부 ⊕ debug.log('tui.wakeup','loop-capped',{turnId,count}).

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../../debug/log.js';
import type { LLMToolDef } from '../../plugins/core/types.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../../chat/internal-turn-contract.js';
import type { TextInputInternalTurnYieldPort } from '../../chat/index.js';
import type { TurnEvent } from '../../turn-capsule/contract.js';

interface WakeupTurnGate {
  startTurnIfIdle(input: string, opts: StartTurnIfIdleOptions): StartTurnIfIdleResult;
  isInternalTurnActive(): boolean;
  lastTurnId(): string | null;
}

export const SCHEDULE_WAKEUP_TOOL_NAME = 'ScheduleWakeup';
export const WAKEUP_MIN_DELAY_MS = 60_000;
/** 대기 깨움 슬롯 — SEAT-QUEUE-CAPACITY(CEO 11-25): 5 → 20 · 조율 자리는 20+ 약속을 동시에 쥔다. */
export const WAKEUP_MAX_ENTRIES = 20;
export const WAKEUP_REPEAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const WAKEUP_RETRY_DELAY_MS = 60_000;
/** 바쁨(NotIdle)·사람 입력 중(HumanTyping)으로 못 연 깨움을 «버리지 않고» 미루는 상한 — 첫 예정 시각부터.
 *  TUI-WAKEUP-DEFER-NOT-DROP(10-22 OPT w7: 02:38·02:39 NotIdle → dropped · codex 는 idle 때 골을 이어가고 바쁘면 미룬다).
 *  상한을 넘겨도 여전히 버리지 않는다(OP #88346): «턴 끝 배출» 대기 큐 + 마운트 배출 · fired 사건에 delaySec. */
/** RAIL30 ④ — a one-shot wake overdue by more than this at restore is dropped (one digest line), not replayed. */
export const WAKEUP_RESTORE_DROP_AFTER_MS = 2 * 60 * 60_000;
export const WAKEUP_DEFER_MAX_MS = 30 * 60_000;
/** WAKE-FOLD-IDEMPOTENT (OP 11-25 19:43 · retro #40133): a one-shot refused NotIdle this long past due is no longer
 *  re-scheduled — it (with every other one-shot this late) is delivered once as a notice on the next turn's inbox. */
export const WAKEUP_BUSY_DELIVER_MS = 10 * 60_000;
/**
 * SEAT-TURN-FOLLOWUPS H3 — a refused wake backs off (5 s · 10 s · 20 s · 40 s · 60 s cap per entry) instead of retrying hot:
 * OP measured 149 wake retry refusals in 9 min. Reset when the wake fires.
 */
export const WAKE_REFUSAL_BACKOFF_BASE_MS = 5_000;
/** SEAT-TURN-FOLLOWUPS H3 — two wakes with the same cause (reason) inside this window open one turn (the 30-min check opened twice). */
export const WAKE_SAME_CAUSE_WINDOW_MS = 10 * 60_000;
export function wakeRefusalBackoffMs(refusals: number): number {
  return Math.min(WAKEUP_RETRY_DELAY_MS, WAKE_REFUSAL_BACKOFF_BASE_MS * 2 ** Math.max(0, refusals - 1));
}
const wakeCauseKey = (reason: string): string => reason.trim().replace(/\s+/gu, ' ').toLowerCase();
/** 미룸 대상인 거부 이유 — 곧 풀리는 «지금 바쁨» 뿐이다(Disabled·Cap·Superseded 는 미뤄도 안 풀린다). */
const WAKEUP_DEFERRABLE_REASONS: ReadonlySet<string> = new Set(['NotIdle', 'HumanTyping']);
/** 일회성 지연의 상한 — 반복 TTL 과 같은 7일(그보다 먼 일은 cron `schedule_manage` 몫). */
export const WAKEUP_MAX_DELAY_MS = WAKEUP_REPEAT_TTL_MS;
/** 한 턴 안 schedule·cancel 호출 합계 상한 — 넘으면 «다음 턴에» 로 거부(예약·취소 고리 차단).
 *  SEAT-QUEUE-CAPACITY(CEO 11-25): 6 → 12 — 슬롯 20 을 몇 턴에 채울 수 있게 · 고리 차단은 그대로(13번째부터 거부). */
export const WAKEUP_MAX_CALLS_PER_TURN = 12;
/** 상한 거부 때 함께 돌려주는 «가장 오래된 예약» 수 — 모델이 바로 cancel 할 id 목록. */
export const WAKEUP_REFUSAL_OLDEST = 5;
/** 반복 간격이 틀렸을 때의 거부 문구 — 일회성으로 가는 길을 같이 준다(«하지 마라»만 주면 재시도 고리가 돈다). */
export const WAKEUP_REPEAT_INVALID_ERROR =
  'repeatMinutes 는 반복 간격(분 · 1 이상)이다 — 한 번만 깨우려면 repeatMinutes 를 빼거나 0 으로 두고 delaySeconds 또는 at 만 줘라';

function formatWakeupTimeConflictError(req: ScheduleWakeupRequest): string {
  const corrected = { ...req };
  delete corrected.at;
  delete corrected.atProvided;
  return `at 과 delaySeconds 는 둘 중 하나만 줄 수 있다 — 교정 인자 예시(at 을 빼고 delaySeconds 사용): ${JSON.stringify(corrected)}. 같은 인자를 다시 보내지 말고 이 교정 인자로 한 번만 재시도하라`;
}

function canonicalToolArgs(args: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))));
}

export type WakeupTimerHandle = unknown;

export interface WakeupEntry {
  id: string;
  reason: string;
  /** 다음 발화 시각(ms). */
  dueAt: number;
  /** 반복 간격(ms) — 없으면 일회성. */
  repeatMs?: number;
  /** 반복 만료 시각(예약 시각 + 7일). 일회성은 없음. */
  expiresAt?: number;
  /** 이번 회차에 이미 1회 재시도했나. */
  retried: boolean;
  /** 이 예약이 마지막으로 연 내부 턴 id(직전 회차 진행 판정용). */
  lastTurnId?: string;
  fireCount: number;
  /** WAKE-FOLD-IDEMPOTENT — present only on a fold bundle: every original wake it carries, reason in full. A bundle is
   *  never folded again (later stale wakes are merged into it). */
  bundle?: WakeupBundleItem[];
}

export interface WakeupBundleItem { id: string; dueAt: number; reason: string }

function isBundleItem(value: unknown): value is WakeupBundleItem {
  if (!value || typeof value !== 'object') return false;
  const b = value as Partial<WakeupBundleItem>;
  return typeof b.id === 'string' && typeof b.reason === 'string' && typeof b.dueAt === 'number' && Number.isFinite(b.dueAt);
}

/** 재기동 복원(OP O2)용 영속 인터페이스 — 실물은 이 TUI 세션의 JSON 파일 1개.
 *  같은 세션 파일을 두 TUI 가 동시에 이어 쓰는 것은 지원하지 않는다(잠금 없음 · 마지막 쓰기 우선). */
export interface WakeupPersistence {
  /** 전체 목록을 저장한다. 실패하면 던지고 원본 파일은 그대로다. */
  save(entries: WakeupEntry[]): void;
  /** 저장된 목록. 파일이 없으면 빈 배열, 읽기·파싱 실패와 일부 항목 손상은 던진다(원본은 건드리지 않는다). */
  load(): WakeupEntry[];
}

const SEAT_FILE = /^[A-Z][A-Z0-9_-]{0,63}$/;

const SESSION_FILE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** `seat-state/<SEAT>/wakeups/<session>.json` — one file per TUI session, never shared across processes. */
export function seatWakeupFile(
  seat: string,
  sessionId: string,
  hqRoot: string = join(process.env.HOME ?? '', 'elanous-hq'),
): string {
  const name = seat.trim().toUpperCase();
  const session = sessionId.trim();
  if (!SEAT_FILE.test(name)) throw new Error(`invalid wakeup seat ${JSON.stringify(seat)}`);
  if (!SESSION_FILE.test(session)) throw new Error(`invalid wakeup session ${JSON.stringify(sessionId)}`);
  return join(hqRoot, 'seat-state', name, 'wakeups', `${session}.json`);
}

function isWakeupEntry(value: unknown): value is WakeupEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<WakeupEntry>;
  return typeof e.id === 'string' && /^w\d+$/.test(e.id) && typeof e.reason === 'string'
    && typeof e.dueAt === 'number' && Number.isFinite(e.dueAt)
    && (e.repeatMs === undefined || (typeof e.repeatMs === 'number' && Number.isFinite(e.repeatMs) && e.repeatMs >= WAKEUP_MIN_DELAY_MS))
    && (e.fireCount === undefined || (typeof e.fireCount === 'number' && Number.isFinite(e.fireCount) && e.fireCount >= 0))
    && (e.retried === undefined || typeof e.retried === 'boolean')
    && (e.expiresAt === undefined || (typeof e.expiresAt === 'number' && Number.isFinite(e.expiresAt)))
    && (e.bundle === undefined || (Array.isArray(e.bundle) && e.bundle.every(isBundleItem)));
}

class WakeupFileUnreadable extends Error {
  constructor(readonly filePath: string, readonly cause: unknown) {
    super(`wakeup file unreadable: ${filePath}`);
  }
}

/** 없는 파일은 빈 배열. 읽기·파싱 실패는 던진다 — 빈 배열로 합치면 다음 저장이 원본을 덮는다. */
function readWakeupEntries(filePath: string): WakeupEntry[] {
  let text: string;
  try { text = readFileSync(filePath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new WakeupFileUnreadable(filePath, error);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new WakeupFileUnreadable(filePath, error); }
  if (!Array.isArray(parsed)) throw new WakeupFileUnreadable(filePath, 'not-array');
  // 일부 항목만 깨져도 통째로 거부한다 — 걸러서 읽으면 다음 저장이 깨진 항목(원본 예약)을 영구 삭제한다.
  if (!parsed.every(isWakeupEntry)) throw new WakeupFileUnreadable(filePath, 'invalid-entry');
  // 같은 id 가 둘이면 복원이 하나를 덮어쓰고 다음 저장이 나머지를 영구 삭제한다 — 손상으로 본다.
  if (new Set(parsed.map(entry => entry.id)).size !== parsed.length) throw new WakeupFileUnreadable(filePath, 'duplicate-id');
  return parsed;
}

/** 이 TUI 세션의 파일 1개. 잠금은 없다. 쓰기는 임시 파일에 적은 뒤 rename 하고, 실패하면 임시만 지워 원본을 남긴다.
 *  읽기에 실패한(손상) 파일은 쓰기를 거부한다 — 빈 목록으로 덮어쓰면 원본이 사라진다. 만들기는 던지지 않는다. */
export function createFileWakeupPersistence(filePath: string): WakeupPersistence {
  let loadFailed = false;
  return {
    save(entries) {
      if (loadFailed) throw new Error(`wakeup file unreadable, write refused: ${filePath}`);
      const tmp = `${filePath}.${process.pid}.tmp`;
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(tmp, JSON.stringify(entries));
        renameSync(tmp, filePath);
      } catch (error) {
        try { unlinkSync(tmp); } catch { /* temp was never written, or already renamed */ }
        throw error;
      }
    },
    load(): WakeupEntry[] {
      try { return readWakeupEntries(filePath); }
      catch (error) { loadFailed = true; throw error; }
    },
  };
}

/** TUI 가 붙은 세션의 영속 위치를 고른다. 자리가 아니거나 세션이 없거나 하니스 자식이면 null(메모리만). */
export function sessionWakeupPersistence(
  seat: string | null | undefined,
  sessionId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  hqRoot?: string,
): WakeupPersistence | null {
  if (!seat || !sessionId || env.ELANOUS_HARNESS_ROLE?.trim()) return null;
  try { return createFileWakeupPersistence(seatWakeupFile(seat, sessionId, hqRoot)); }
  catch { return null; } // 쓸 수 없는 이름 — 기동은 계속하고 메모리만 쓴다
}

/** 세션이 붙거나 바뀔 때 부르는 묶개 — 같은 세션 id 를 다시 알려도 아무것도 하지 않는다(예약이 복제되지 않게). */
export function createSessionWakeupBinder(
  scheduler: Pick<WakeupScheduler, 'bindPersist'>,
  seat: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  hqRoot?: string,
): (sessionId: string | null | undefined) => void {
  let bound: string | null = null;
  return (sessionId) => {
    const next = sessionId ?? null;
    if (next === bound) return;
    bound = next;
    scheduler.bindPersist(sessionWakeupPersistence(seat, next, env, hqRoot));
  };
}

export interface WakeupSchedulerDeps {
  /** H2 문 — 대시보드의 `internalTurnGate.startTurnIfIdle`. */
  startTurnIfIdle: (input: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  /** 그 내부 턴이 아직 도는가(직전 회차 건너뜀). 없으면 늘 false. */
  isTurnActive?: (turnId: string) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => WakeupTimerHandle;
  clearTimer?: (handle: WakeupTimerHandle) => void;
  /** 화면 한 줄(입력칸 무접촉 — 채팅 줄에만). */
  notify?: (line: string) => void;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** OBSERVE-TURN-EVENT-LIFECYCLE — turn-life observation hook (fail-open). */
  turnLifeLog?: (event: string, data: Record<string, unknown>) => void;
  /** TURN-CAPSULE-EVENTS R1(C4) — 버스 원천 어댑터. 예약 시각 도래·거부 미룸·재기동 복원의 늦은
   *  깨움이 모두 버스 항목(source 'wakeup')으로 들어간다. 없으면 옛길(스케줄러 자체 타이머) 그대로 —
   *  순수 모듈 시험은 이 포트만 주입한다. 생산 배선은 CC-2(entry.ts) 몫이다. */
  publishEvent?: (event: TurnEvent) => { duplicate: boolean } | void;
  maxEntries?: number;
  /** 지금 도는 턴 id(사람·내부 · H2 `lastTurnId`). 주면 그 턴 안 schedule·cancel 합계에 상한을 건다. */
  currentTurnId?: () => string | null;
  /** 한 턴 호출 상한(기본 `WAKEUP_MAX_CALLS_PER_TURN`). */
  maxCallsPerTurn?: number;
  /** 세션 파일 영속. 없으면 메모리만(재기동 복원 없음). */
  persist?: WakeupPersistence;
  /** RAIL30 ④ — restore drops one-shots overdue by more than this (default {@link WAKEUP_RESTORE_DROP_AFTER_MS} · sims pass Infinity for the old rule). */
  restoreDropAfterMs?: number;
  /** WAKE-FOLD-IDEMPOTENT ③ — append a notice to the next turn's inbox (a queued notice rides the next turn even while
   *  the seat is busy). true = accepted. Absent = the old path (keep re-trying through the door). */
  deliverQueued?: (text: string, meta: { ids: string[]; count: number }) => boolean;
}

export type ScheduleWakeupRequest = {
  /** «HH:MM»(로컬 시각 · 지났으면 내일). delaySeconds 와 둘 중 하나. */
  at?: unknown;
  /** Host tool must preserve property presence even when the provider sent a non-string value. */
  atProvided?: boolean;
  delaySeconds?: number;
  reason: string;
  /** 반복 간격(분). 첫 발화는 at/delaySeconds — 둘 다 없으면 지금부터 repeatMinutes 뒤. 0 = 일회성(생략과 같다). */
  repeatMinutes?: number;
};

export type ScheduleWakeupResult =
  /** merged = 같은 reason 의 기존 예약 id(새로 만들지 않고 시각만 옮겼다) · folded = 상한 회수로 접은 늦은 예약 묶음. */
  | { ok: true; entry: WakeupEntry; merged?: string; folded?: { id: string; count: number } }
  /** code 'cap' = 예약 상한 — oldest = 가장 오래된 예약(먼저 cancel 할 후보). */
  | { ok: false; error: string; code?: 'cap'; oldest?: WakeupEntry[] };

export type CancelWakeupResult = { ok: true } | { ok: false; error: string; capped?: boolean };

	export interface WakeupScheduler {
	  schedule(req: ScheduleWakeupRequest, requestKey?: string): ScheduleWakeupResult;
	  list(): WakeupEntry[];
	  /** 이 스케줄러가 세션 파일을 실제로 쓰는지. 도구 문면이 복원을 사실처럼 적지 않게 쓴다. */
	  persists(): boolean;
  /** 세션 파일이 연결돼 있는가(손상으로 쓰기를 거부 중이어도 true). */
  hasFile(): boolean;
  /** 세션이 붙거나 바뀐 뒤 저장 위치를 묶는다(null = 메모리만). 메모리의 예약은 새 파일로 이어진다. */
  bindPersist(next: WakeupPersistence | null): void;
	  cancel(id: string): boolean;
  /** cancel 과 같되 거부 사유(없는 id · 턴 상한)를 값으로 낸다 — LLM 도구가 쓴다. */
  tryCancel(id: string): CancelWakeupResult;
  /** 모든 타이머를 거둔다(TUI 종료). */
  dispose(): void;
  /** «턴 끝 배출»(ELN-SEAT-WAKEUP-SCHEDULE-FAIL · OP #88346): H2 의 yield port 를 감싸 «입력칸이
   *  다시 뜨는 순간(턴 끝 · idle) = 대기 큐 배출 시점» 으로 잇는다 — agent-wake wrapAgentWakePort 와
   *  같은 길. 대시보드가 포장 사슬에 낀다. */
  wrapPort(port: TextInputInternalTurnYieldPort): TextInputInternalTurnYieldPort;
}

function defaultSetTimer(fn: () => void, ms: number): WakeupTimerHandle {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return t;
}

function defaultClearTimer(handle: WakeupTimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** «HH:MM» → 다음 그 시각(로컬). 지금 이전·같은 시각이면 내일. 꼴이 틀리면 null. */
export function resolveWakeupAt(at: string, now: number): number | null {
  const m = HHMM.exec(at.trim());
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  let t = d.getTime();
  if (t <= now) {
    d.setDate(d.getDate() + 1);
    t = d.getTime();
  }
  return t;
}

export function formatWakeupClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 내부 턴에 실을 글 — 사람 발화처럼 보이지 않게 머리표를 단다. */
import { emitTurnLife } from '../../debug/turn-life.js';

export function formatWakeupPrompt(entry: Pick<WakeupEntry, 'id' | 'reason' | 'repeatMs'>): string {
  const repeat = entry.repeatMs ? ` · 반복 ${Math.round(entry.repeatMs / 60_000)}분` : '';
  return `[예약 깨움 ${entry.id}${repeat}] ${entry.reason} — 스스로 예약한 점검 시각이다. 남은 일을 이어서 처리하라.`;
}

/** Every original wake an entry carries — a bundle's items, else the entry itself. */
function wakeItems(e: Pick<WakeupEntry, 'id' | 'dueAt' | 'reason' | 'bundle'>): WakeupBundleItem[] {
  return e.bundle ? e.bundle.map(b => ({ ...b })) : [{ id: e.id, dueAt: e.dueAt, reason: e.reason }];
}

/** One delivery text for several past-due wakes — every reason in full, never truncated. */
export function formatWakeupDigest(items: readonly WakeupBundleItem[], via: 'turn' | 'turn-inbox'): string {
  const head = via === 'turn-inbox'
    ? `[예약 깨움 묶음 · ${items.length}건 · 바쁜 턴 동안 시각이 지나 다음 턴에 배달]`
    : `[예약 깨움 묶음 · ${items.length}건 · 시각 지난 예약을 한 번에 배달]`;
  return `${head} 스스로 예약한 점검들이다 — 이미 처리한 것은 건너뛰고 남은 것만 이어라:\n`
    + items.map(i => `- ${i.id}@${formatWakeupClock(i.dueAt)} ${i.reason}`).join('\n');
}

export function createWakeupScheduler(deps: WakeupSchedulerDeps): WakeupScheduler {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? defaultClearTimer;
  const log = deps.log ?? ((c, e, d) => debug.log(c, e, d));
  // OBSERVE-TURN-EVENT-LIFECYCLE — 예약 관측 주입(기본: debug 직접 방출).
  const turnLifeLog = deps.turnLifeLog ?? emitTurnLife;
  const maxEntries = deps.maxEntries ?? WAKEUP_MAX_ENTRIES;
  const entries = new Map<string, WakeupEntry>();
  const timers = new Map<string, WakeupTimerHandle>();
  /** «턴 끝 배출» 대기 큐(ELN-SEAT-WAKEUP-SCHEDULE-FAIL · OP #88346): 턴 중(NotIdle)·사람 입력 중
   *  (HumanTyping) 거부로 못 연 발화를 버리지 않고 여기 싣는다. Map(id → 이번 대기 구간에 «대기» 한 줄을
   *  냈는가) — 같은 예약 id 두 번은 하나로. 배출 = wrapPort 의 입력칸 마운트(턴 끝 · idle)에서 1회씩. */
  const queuedForTurnEnd = new Map<string, boolean>();
  let seq = 0;
  const maxCallsPerTurn = deps.maxCallsPerTurn ?? WAKEUP_MAX_CALLS_PER_TURN;
  let callTurnKey: string | null = null;
  let callCount = 0;
  const conflictErrors = new Map<string, string>();
  let persist = deps.persist;
  /** 손상된 파일을 만나 쓰기를 거부하는 중이면 그 이유. 이때 예약·취소는 거부하고 원본은 그대로 둔다. */
  let writeRefused: string | null = null;
  /** 영속 저장. 실패는 던진다(호출자가 정한다): 예약·취소 도구는 변경을 되돌리고 오류를 낸다. */
  const persistSave = (): void => {
    if (!persist) return;
    if (writeRefused) throw new Error(writeRefused);
    persist.save([...entries.values()].map(entry => ({ ...entry })));
  };
  /** 발화·만료·복원 정리 쪽 저장 — 실패해도 로그만 남기고 메모리 상태로 계속한다(다음 저장이 따라잡는다). */
  const persistBestEffort = (): void => {
    try { persistSave(); }
    catch (error) { log('tui.wakeup', 'persist-save-failed', { error: String(error) }); }
  };

  const readTurnId = (): string | null => deps.currentTurnId?.() ?? null;

  /** R1(C4) — 버스 원천 어댑터(선택). 버스는 보조 경로다: 발화 주체는 여전히 이 스케줄러(문)이고,
   *  게시 실패·중복(duplicate)은 무시한다(fail-open — 버스가 죽어도 예약 깨움은 산다). */
  const publish = (event: TurnEvent): void => {
    try { deps.publishEvent?.(event); } catch { /* secondary path — fail-open */ }
  };

  /** 한 턴 호출 상한 — 넘었으면 거부 문구, 아니면 null. 턴 경계가 unknown 이면 cap·dedupe 상태를 버린다. */
  const loopCapError = (action: 'schedule' | 'cancel', observedTurnId = readTurnId()): string | null => {
    if (observedTurnId === null) {
      callTurnKey = null;
      callCount = 0;
      conflictErrors.clear();
      return null;
    }
    const turnId = observedTurnId;
    if (turnId !== callTurnKey) {
      callTurnKey = turnId;
      callCount = 0;
      conflictErrors.clear();
    }
    callCount += 1;
    if (callCount <= maxCallsPerTurn) return null;
    log('tui.wakeup', 'loop-capped', { turnId, count: callCount, max: maxCallsPerTurn, action });
    return `이번 턴에 예약을 너무 많이 바꿨다(${maxCallsPerTurn}회 상한) — 지금 예약은 list 로 확인만 하고, 바꾸려면 다음 턴에`;
  };

  const tryCancel = (id: string): CancelWakeupResult => {
    const capped = loopCapError('cancel');
    if (capped) return { ok: false, error: capped, capped: true };
    if (writeRefused) return { ok: false, error: writeRefused };
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no pending wakeup ${JSON.stringify(id)}` };
    const handle = timers.get(id);
    if (handle !== undefined) clearTimer(handle);
    timers.delete(id);
    entries.delete(id);
    try { persistSave(); }
    catch (error) {
      // 저장 실패 — 이 한 항목만 되돌린다(취소는 일어나지 않았다).
      entries.set(id, entry);
      arm(entry);
      log('tui.wakeup', 'persist-save-failed', { error: String(error), action: 'cancel', id });
      return { ok: false, error: `예약을 저장하지 못해 취소하지 않았다: ${error instanceof Error ? error.message : String(error)}` };
    }
    queuedForTurnEnd.delete(id);
	    log('tui.wakeup', 'cancelled', { id });
	    return { ok: true };
  };

  const arm = (entry: WakeupEntry): void => {
    const prev = timers.get(entry.id);
    if (prev !== undefined) clearTimer(prev);
    timers.set(entry.id, setTimer(() => fire(entry.id), Math.max(0, entry.dueAt - now())));
  };

  const drop = (id: string): void => {
    const handle = timers.get(id);
    if (handle !== undefined) clearTimer(handle);
    timers.delete(id);
    entries.delete(id);
    queuedForTurnEnd.delete(id); // 예약이 끝났다(발화·만료·실패) — 대기 큐에 두 번 남지 않는다
    persistBestEffort();
  };

  /** 다음 회차로 — 놓친 틱은 하나로 합친다. 만료를 넘으면 소멸. */
  const advance = (entry: WakeupEntry, t: number, save = true): void => {
    queuedForTurnEnd.delete(entry.id); // 이번 틱은 성공·스킵으로 끝났다 — 다음 틱은 자기 거부 때 다시 싣는다
    if (!entry.repeatMs) { drop(entry.id); return; }
    let next = entry.dueAt + entry.repeatMs;
    let coalesced = 0;
    while (next <= t) { next += entry.repeatMs; coalesced++; }
    if (entry.expiresAt !== undefined && next > entry.expiresAt) {
      log('tui.wakeup', 'skipped', { id: entry.id, reason: 'expired', fireCount: entry.fireCount });
      drop(entry.id);
      return;
    }
    entry.dueAt = next;
    entry.retried = false;
    if (coalesced > 0) log('tui.wakeup', 'skipped', { id: entry.id, reason: 'coalesced', ticks: coalesced });
    arm(entry);
    if (save) persistBestEffort();
  };

	  const fire = (id: string): void => {
	    const entry = entries.get(id);
	    timers.delete(id);
	    if (!entry) return;
	    try { fireBody(id, entry); }
	    catch (error) {
	      log('tui.wakeup', 'fire-failed', { id, error: String(error) });
	      deps.notify?.(`⏰ 예약 깨움 처리 실패(${id}): ${entry.reason}`);
	    }
	  };

	  /** 입력칸이 다시 떴다(턴 끝 · idle) — «턴 끝 배출» 대기 큐를 1회씩 비운다(ELN-SEAT-WAKEUP-SCHEDULE-FAIL · OP #88346).
	   *  agent-wake onInputMounted 와 같은 길: 마운트 «중»에 물러남을 청하지 않게 0ms 미루고,
	   *  이미 발화·취소·만료된 id 는 건너뛴다(같은 예약 두 번 배출 없음). 남은 재청 타이머는 치운다. */
	  const drainQueuedWakeups = (): void => {
	    if (queuedForTurnEnd.size === 0) return;
	    const ids = [...queuedForTurnEnd.keys()];
	    queuedForTurnEnd.clear();
	    setTimer(() => {
	      for (const id of ids) {
	        const entry = entries.get(id);
	        if (!entry) continue;
	        const handle = timers.get(id);
	        if (handle !== undefined) { clearTimer(handle); timers.delete(id); }
	        fire(id);
	      }
	    }, 0);
	  };

	  /** H3 — consecutive refusals per wake id · when a cause last opened a turn (and by which id). */
	  const refusalsById = new Map<string, number>();
	  const lastFiredByCause = new Map<string, { id: string; at: number }>();
	  const fireBody = (id: string, entry: WakeupEntry): void => {
    const t = now();
    if (entry.expiresAt !== undefined && t > entry.expiresAt) {
      log('tui.wakeup', 'skipped', { id, reason: 'expired', fireCount: entry.fireCount });
      drop(id);
      return;
    }
    if (entry.lastTurnId && deps.isTurnActive?.(entry.lastTurnId)) {
      log('tui.wakeup', 'skipped', { id, reason: 'previous-running', turnId: entry.lastTurnId });
      advance(entry, t);
      return;
    }
    // SEAT-TURN-FOLLOWUPS H3 — another wake with the same cause just opened a turn: this one rides it (no second turn).
    const sameCause = lastFiredByCause.get(wakeCauseKey(entry.reason));
    if (sameCause && sameCause.id !== id && t - sameCause.at < WAKE_SAME_CAUSE_WINDOW_MS) {
      log('tui.wakeup', 'skipped', { id, reason: 'same-cause', firedBy: sameCause.id, agoSec: Math.round((t - sameCause.at) / 1000) });
      refusalsById.delete(id);
      advance(entry, t);
      return;
    }
    // OBSERVE-TURN-EVENT-LIFECYCLE — 예약 시각 도래(busy 여부·거부 사유는 문이 판정한다).
    try { turnLifeLog('turn-life:event-arrived', { source: 'scheduled', wakeupId: id, arrivedAt: t }); } catch { /* observability is fail-open */ }
    // R1(C4) — 원천 어댑터: 도래를 버스 항목으로도 낸다(source 'wakeup' · dedupeKey wakeup:<id>:<fireCount>).
    // 발화는 여전히 이 스케줄러가 직접 청하고, 버스 항목은 문이 열어주는 길(백업·순서 보증)이 된다.
    // duplicate 는 정상이다(같은 회차를 마운트 배출·버스가 다시 낼 때) — 무시한다.
    publish({ id: `wakeup-${id}-${entry.fireCount}`, source: 'wakeup', dedupeKey: `wakeup:${id}:${entry.fireCount}`,
      arrivedAt: t, deliverBy: entry.dueAt + (entry.repeatMs ?? WAKEUP_DEFER_MAX_MS), text: formatWakeupPrompt(entry) });
    // WAKE-FOLD-IDEMPOTENT ① — a past-due one-shot opening at an idle boundary carries every other past-due one-shot
    // with it: one turn, every reason in full (never 29 turns, never a re-scheduled bundle).
    const companions = entry.repeatMs ? [] : overdueOneShots(t, 0).filter(e => e.id !== id);
    const deliveredItems = entry.repeatMs ? [] : [entry, ...companions].flatMap(wakeItems);
    const prompt = companions.length > 0 || entry.bundle ? formatWakeupDigest(deliveredItems, 'turn') : formatWakeupPrompt(entry);
    let result: StartTurnIfIdleResult;
    try {
      result = deps.startTurnIfIdle(prompt, { origin: 'scheduled', reason: entry.reason });
    } catch (error) {
      result = { opened: false, reason: 'NotIdle', detail: `threw:${String(error)}` };
    }
    if (result.opened) {
      refusalsById.delete(id);
      lastFiredByCause.set(wakeCauseKey(entry.reason), { id, at: t });
      entry.lastTurnId = result.turnId;
      entry.fireCount += 1;
      queuedForTurnEnd.delete(id); // 두 번 배출 없음 — 발화됐으니 대기 큐에서 뺀다
      log('tui.wakeup', 'fired', {
        id, turnId: result.turnId, reason: entry.reason, retried: entry.retried, repeat: !!entry.repeatMs,
        delaySec: Math.max(0, Math.round((t - entry.dueAt) / 1000)), // 늦게 깬 시간(지연 초) — 첫 예정부터 실제 발화까지(OP #88346)
      });
      // A lone one-shot keeps its `fired` line as the delivery record; a digest adds one `delivered` line with its count.
      if (!entry.repeatMs && deliveredItems.length > 1) {
        for (const c of companions) removeQuiet(c.id);
        log('tui.wakeup', 'delivered', { via: 'turn', turnId: result.turnId, count: deliveredItems.length, entries: 1 + companions.length, ids: deliveredItems.map(i => i.id) });
      }
      advance(entry, t);
      return;
    }
    log('tui.wakeup', 'rejected', {
      id, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}), retried: entry.retried,
    });
    // ELN-SEAT-TURN-PACING: a minimum-interval refusal names when it may open (`retryAt`) — defer to then, never drop.
    const pacedAt = !result.opened && result.reason === 'Cap' && result.retryAt !== undefined ? result.retryAt : null;
    const deferrable = WAKEUP_DEFERRABLE_REASONS.has(result.reason) || pacedAt !== null;
    if (deferrable) {
      // WAKE-FOLD-IDEMPOTENT ③ — busy for WAKEUP_BUSY_DELIVER_MS past due: stop re-scheduling; hand this one-shot (and
      // every other one-shot as late) to the next turn's inbox as one notice. A refused hand-off keeps the old path.
      if (!entry.repeatMs && deps.deliverQueued && t - entry.dueAt >= WAKEUP_BUSY_DELIVER_MS && deliverToInbox(t)) return;
      // 바쁨·사람 입력 중 — 버리지 않는다(ELN-SEAT-WAKEUP-SCHEDULE-FAIL · OP #88346): 이 발화를 «턴 끝 배출»
      // 대기 큐에 싣는다(Map — 같은 예약 id 두 번은 하나로). 배출 시점 = wrapPort 의 입력칸 마운트(턴 끝 ·
      // idle) — agent-wake 의 idle 감시와 같은 길. 소실 0.
      const announced = queuedForTurnEnd.get(id) ?? false;
      queuedForTurnEnd.set(id, announced);
      const refusals = (refusalsById.get(id) ?? 0) + 1;
      refusalsById.set(id, refusals);
      // H3 — never a hot retry: a paced «retryAt» is honoured but floored by this entry's refusal back-off.
      const delay = pacedAt !== null ? Math.max(pacedAt - t, wakeRefusalBackoffMs(refusals)) : WAKEUP_RETRY_DELAY_MS;
      const nextTry = t + delay;
      // 상한 시각의 시도까지는 한다(<=) · 반복은 다음 회차 시각과 겹치면 그 회차에 넘긴다(<).
      const withinDeferCap = nextTry <= entry.dueAt + WAKEUP_DEFER_MAX_MS;
      const beforeNextTick = !entry.repeatMs || nextTry < entry.dueAt + entry.repeatMs;
      if (withinDeferCap && beforeNextTick) {
        entry.retried = true;
        // OBSERVE-TURN-EVENT-LIFECYCLE — 바쁨/거부 미룸: delay 후 같은 회차 재시도(상한 = 첫 예정 + DEFER_MAX).
        try { turnLifeLog('turn-life:event-while-busy', { source: 'scheduled', action: 'defer', wakeupId: id, retryMs: delay, deferCapAt: entry.dueAt + WAKEUP_DEFER_MAX_MS }); } catch { /* observability is fail-open */ }
        timers.set(id, setTimer(() => fire(id), delay));
        return;
      }
      // 미루기 상한·다음 회차 시각을 넘었다 — 예전엔 여기서 «놓침» 한 줄과 함께 소리 없이 소실(반복은 회차
      // 접기) 했다. 이제 큐에 남아 턴이 끝나면 반드시 1회 배출된다(반복은 그 뒤 advance 가 놓친 회차를
      // 하나로 합친다). 재청 고리는 30분 간격으로 흐리게 남는다 — 마운트 배출이 먼저 이기고, 마운트 없는
      // 표면의 소실 0 보증이 된다. «대기» 한 줄은 구간마다 한 번만 띄운다.
      if (!announced) {
        log('tui.wakeup', 'queued', { id, reason: result.reason, next: 'turn-end' });
        deps.notify?.(`⏰ 예약 깨움 대기(${id}): ${entry.reason} — ${result.reason} · 턴이 끝나면 즉시 깨운다`);
        queuedForTurnEnd.set(id, true); // «대기» 고지는 구간마다 한 번(발화·취소·회차 진행 때 큐가 비워진다)
      }
      // WAKE-CAP-RECLAIM (OP 11-25 12:0x): next TUI 는 wrapPort(마운트 배출)를 잇지 않는다 — 바쁜 자리에선 늦은 일회성이
      // 30분 흐린 재청마다 또 NotIdle 로 거부돼 몇 시간씩 쌓였다(OP 32건 · 최장 5.4시간 · fireCount 0). 버스 소비자는
      // `:late` 항목만 연다 — 소진 경로뿐 아니라 이 미룸 상한 경로의 일회성도 `:late` 로 내 idle 경계에서 배출되게 한다
      // (같은 dedupeKey 는 버스가 접는다 · 반복은 advance 가 다음 회차로 넘긴다).
      if (!entry.repeatMs) {
        publish({ id: `wakeup-${id}-${entry.fireCount}-late`, source: 'wakeup', dedupeKey: `wakeup:${id}:${entry.fireCount}:late`,
          arrivedAt: t, deliverBy: entry.dueAt + WAKEUP_DEFER_MAX_MS, text: formatWakeupPrompt(entry) });
      }
      const safetyDelay = pacedAt !== null ? Math.max(WAKEUP_DEFER_MAX_MS, pacedAt - t) : WAKEUP_DEFER_MAX_MS;
      timers.set(id, setTimer(() => fire(id), safetyDelay));
      return;
    } else if (!entry.retried) {
      // 바쁨이 아닌 거부 — 1분 뒤 한 번만 다시 청한다(기존 계약).
      entry.retried = true;
      // OBSERVE-TURN-EVENT-LIFECYCLE — 바쁨 아닌 거부(사람 입력 중 등): 1분 뒤 한 번 더.
      try { turnLifeLog('turn-life:event-while-busy', { source: 'scheduled', action: 'defer', wakeupId: id, retryMs: WAKEUP_RETRY_DELAY_MS }); } catch { /* observability is fail-open */ }
      timers.set(id, setTimer(() => fire(id), WAKEUP_RETRY_DELAY_MS));
      return;
    }
    const exhausted = deferrable ? 'defer-exhausted' : 'retry-exhausted';
    if (entry.repeatMs) {
      log('tui.wakeup', 'skipped', { id, reason: exhausted, next: 'repeat' });
      advance(entry, t);
      return;
    }
    // K10(턴 근본 C4) — 일회성도 버리지 않는다: 예전의 «놓침 한 줄 ⊕ 소멸» 폐기. 소진 뒤에는
    // «턴 끝 배출» 대기 큐(마운트 배출에서 1회) + 버스 항목으로 남는다(소실 0). Disabled 같은
    // 사유는 미뤄도 곧 풀리지 않으니 30분 흐린 재청만 돌고, «대기» 고지는 구간마다 한 번.
    log('tui.wakeup', 'queued', { id, reason: result.reason, next: 'turn-end', exhausted });
    // OBSERVE-TURN-EVENT-LIFECYCLE — 재청 소진(일회성): 버스에 «늦은 깨움» 항목으로도 낸다(drop 아님).
    try { turnLifeLog('turn-life:event-while-busy', { source: 'scheduled', action: 'queue', wakeupId: id, exhausted }); } catch { /* observability is fail-open */ }
    publish({ id: `wakeup-${id}-${entry.fireCount}-late`, source: 'wakeup', dedupeKey: `wakeup:${id}:${entry.fireCount}:late`,
      arrivedAt: t, deliverBy: entry.dueAt + WAKEUP_DEFER_MAX_MS, text: formatWakeupPrompt(entry) });
    const announcedLate = queuedForTurnEnd.get(id) ?? false;
    if (!announcedLate) {
      deps.notify?.(`⏰ 예약 깨움 대기(${id}): ${entry.reason} — ${result.reason} · 턴이 끝나면 즉시 깨운다`);
      queuedForTurnEnd.set(id, true);
    }
    timers.set(id, setTimer(() => fire(id), WAKEUP_DEFER_MAX_MS));
  };

  /** WAKE-CAP-RECLAIM (OP 11-25 12:0x) — 미룸 창(첫 예정 + 30분)까지 지난 일회성 = «묵은 늦은 예약». 오래된 순.
   *  WAKE-FOLD-IDEMPOTENT ① — a bundle is never stale-folded again (that re-wrap ate OP's wakes every 30 s at 19:43). */
  const staleOverdue = (t: number): WakeupEntry[] =>
    [...entries.values()].filter(e => !e.repeatMs && !e.bundle && e.dueAt + WAKEUP_DEFER_MAX_MS <= t).sort((a, b) => a.dueAt - b.dueAt);

  /** One-shots (bundles included) at least `lateMs` past due, oldest first. */
  const overdueOneShots = (t: number, lateMs: number): WakeupEntry[] =>
    [...entries.values()].filter(e => !e.repeatMs && e.dueAt + lateMs <= t).sort((a, b) => a.dueAt - b.dueAt);

  /** Remove one entry without saving (the caller saves once). */
  const removeQuiet = (id: string): void => {
    const handle = timers.get(id);
    if (handle !== undefined) clearTimer(handle);
    timers.delete(id);
    entries.delete(id);
    queuedForTurnEnd.delete(id);
    refusalsById.delete(id);
  };

  /** WAKE-FOLD-IDEMPOTENT ③ — once any one-shot is WAKEUP_BUSY_DELIVER_MS late, every past-due one-shot goes to the next turn's inbox as ONE notice
   *  (each original reason in full). Removed only once the inbox accepted it; false = nothing delivered. */
  const deliverToInbox = (t: number): boolean => {
    if (!deps.deliverQueued) return false;
    // Triggered by the oldest wake reaching the busy limit; carries every past-due one-shot so they arrive as one notice.
    if (overdueOneShots(t, WAKEUP_BUSY_DELIVER_MS).length === 0) return false;
    const due = overdueOneShots(t, 0);
    const items = due.flatMap(wakeItems).sort((a, b) => a.dueAt - b.dueAt);
    let accepted = false;
    try { accepted = deps.deliverQueued(formatWakeupDigest(items, 'turn-inbox'), { ids: items.map(i => i.id), count: items.length }); }
    catch (error) { log('tui.wakeup', 'deliver-failed', { error: String(error), count: items.length }); return false; }
    if (!accepted) { log('tui.wakeup', 'deliver-failed', { error: 'inbox-refused', count: items.length }); return false; }
    for (const e of due) removeQuiet(e.id);
    persistBestEffort();
    log('tui.wakeup', 'delivered', { via: 'turn-inbox', count: items.length, entries: due.length, ids: items.map(i => i.id), oldestLateSec: Math.max(0, Math.round((t - items[0]!.dueAt) / 1000)) });
    deps.notify?.(`⏰ 늦은 예약 ${items.length}건을 다음 턴 받은편지함에 한 묶음으로 넣었다(바쁜 턴 ${Math.round(WAKEUP_BUSY_DELIVER_MS / 60_000)}분 초과)`);
    return true;
  };

  /** 묵은 늦은 예약을 «늦은 예약 N건 묶음» 일회성 하나로 접는다 — 소실 0(각 id·시각·reason 을 전부 싣는다 · 자르지 않는다) ⊕ 슬롯 회수.
   *  WAKE-FOLD-IDEMPOTENT ①: 묶음이 이미 있으면 새 묶음으로 감싸지 않고 그 묶음에 합친다(멱등 · 묶음 id 그대로). 접을 게 없으면 null.
   *  저장은 호출자 몫. */
  const foldStale = (t: number, why: 'restore' | 'cap'): { id: string; count: number } | null => {
    const stale = staleOverdue(t);
    const existing = [...entries.values()].find(e => e.bundle);
    if (stale.length === 0 || (!existing && stale.length < 2)) return null;
    for (const e of stale) removeQuiet(e.id);
    const label = why === 'restore' ? '재기동 복원' : '상한 회수';
    const seen = new Set<string>();
    const items = [...(existing?.bundle ?? []), ...stale.flatMap(wakeItems)]
      .filter(i => (seen.has(i.id) ? false : (seen.add(i.id), true)))
      .sort((a, b) => a.dueAt - b.dueAt);
    const reason = `늦은 예약 ${items.length}건 묶음(${label}) — 이미 처리한 것은 건너뛰고 남은 것만 이어라: `
      + items.map(i => `${i.id}@${formatWakeupClock(i.dueAt)} ${i.reason}`).join(' · ');
    if (existing) {
      existing.bundle = items;
      existing.reason = reason;
      log('tui.wakeup', 'folded', { id: existing.id, why, into: 'existing', added: stale.length, count: items.length, ids: stale.map(e => e.id) });
      return { id: existing.id, count: items.length };
    }
    // The bundle is due now (not at the oldest item's time) so it is delivered at the next boundary, never «stale» itself.
    const folded: WakeupEntry = { id: `w${++seq}`, reason, dueAt: t, retried: false, fireCount: 0, bundle: items };
    entries.set(folded.id, folded);
    arm(folded);
    log('tui.wakeup', 'folded', { id: folded.id, why, count: stale.length, ids: stale.map(e => e.id), oldestLateSec: Math.max(0, Math.round((t - stale[0]!.dueAt) / 1000)) });
    deps.notify?.(`⏰ 늦은 예약 ${stale.length}건을 한 깨움(${folded.id})으로 묶었다 — ${label}`);
    return { id: folded.id, count: stale.length };
  };

  // 재기동 복원(OP O2): persist 가 있으면 이전 예약을 되살린다. 만료(expiresAt 경과)와
  // 기한이 지난 일회성은 폐기+log. 반복만 advance 의 coalescing 으로 다음 회차에 재무장한다.
  // 루프 안의 advance 는 저장하지 않는다 — 아직 안 읽은 뒤 항목이 파일에서 빠지지 않게, 전체를 메모리에
  // 올린 뒤에 한 번만 저장한다.
  const restoreFromPersist = (): void => {
    if (!persist) return;
    let restored = 0;
    let discarded = 0;
    let loaded: WakeupEntry[] = [];
    try { loaded = persist.load(); }
    catch (error) {
      // 손상 파일: 목록은 비우고 쓰기를 거부한다(원본 보존). TUI 기동은 계속하고 화면에 알린다.
      writeRefused = '예약 파일이 손상돼 예약·취소를 거부한다 — 원본은 그대로 두었으니 파일을 확인해라';
      log('tui.wakeup', 'persist-load-failed', { error: String(error) });
      deps.notify?.(`⏰ ${writeRefused}`);
    }
    for (const raw of loaded) {
      const entry: WakeupEntry = { ...raw, retried: !!raw.retried, fireCount: raw.fireCount ?? 0 };
      const m = /^w(\d+)$/.exec(entry.id);
      if (m) { const n = Number(m[1]); if (n > seq) seq = n; } // id 시퀀스를 불러온 최대 이후로 이어감
      entries.set(entry.id, entry);
    }
    const t = now();
    // RAIL30 ④ (11-25 JUD 16:5x 가 00:01·05:23 깨움을 재생) — 2 h 넘게 지난 일회성은 재기동에서 되살리지 않는다.
    // 그 사이 세상이 바뀌었다: 한 줄 «dropped n stale wakes» 만 남기고 버린다(반복 예약은 advance 가 다음 회차로 잇는다).
    if (!writeRefused) {
      const dropped = [...entries.values()].filter(e => !e.repeatMs && e.dueAt + (deps.restoreDropAfterMs ?? WAKEUP_RESTORE_DROP_AFTER_MS) <= t);
      for (const e of dropped) entries.delete(e.id);
      if (dropped.length > 0) {
        discarded += dropped.length;
        log('tui.wakeup', 'restore-dropped-stale', { count: dropped.length, ids: dropped.map(e => e.id), oldestLateSec: Math.round((t - Math.min(...dropped.map(e => e.dueAt))) / 1000) });
        deps.notify?.(`⏰ dropped ${dropped.length} stale wakes (overdue > 2 h at restart): ${dropped.slice(0, 3).map(e => `${e.id}@${formatWakeupClock(e.dueAt)}`).join(' · ')}${dropped.length > 3 ? ' · …' : ''}`);
      }
    }
    // WAKE-CAP-RECLAIM: 죽은 TUI(강제 종료된 옛 프로세스)의 묵은 늦은 예약은 이 프로세스가 이어받되 한 깨움으로 접는다.
    const foldedOnRestore = writeRefused ? null : foldStale(t, 'restore');
    for (const entry of [...entries.values()]) {
      if (entry.expiresAt !== undefined && t > entry.expiresAt) {
        log('tui.wakeup', 'restored-expired', { id: entry.id });
        entries.delete(entry.id);
        discarded++;
        continue;
      }
      if (!entry.repeatMs && entry.dueAt <= t) {
        // 턴 근본 C4(설계 §3 ③4) — 재기동 복원의 지난 일회성은 폐기하지 않고 «늦은 깨움»으로 즉시
        // 발화한다: arm 의 지연은 Math.max(0, dueAt-now)=0 → 다음 틱에 fire. 버스 항목은 fire 안에서
        // 같은 회차(dedupeKey)로 난다 — 중복 없음.
        log('tui.wakeup', 'restored-late', { id: entry.id, lateSec: Math.max(0, Math.round((t - entry.dueAt) / 1000)) });
        restored++;
        arm(entry);
        continue;
      }
      restored++;
      if (entry.repeatMs && entry.dueAt <= t) advance(entry, t, false); else arm(entry);
    }
    if (discarded > 0 || foldedOnRestore) persistBestEffort();
    if (restored > 0) log('tui.wakeup', 'restored', { count: restored, owner: process.pid });
  };
  restoreFromPersist();

  /** 세션이 붙거나 바뀐 뒤에 저장 위치를 묶는다(TUI 가 스케줄러를 만들 때는 세션 id 를 아직 모를 수 있다).
   *  예약은 «만든 세션»에 귀속한다: 세션이 바뀌면 지금 예약은 옛 파일에 이미 저장돼 있으니 메모리에서 비우고
   *  새 세션 파일에서 불러온다(옮기지 않는다 — 옮기면 왕복 때 두 파일에서 중복 발화한다).
   *  예외: 저장 위치가 없던 때(세션이 처음 붙기 전)에 건 예약은 어느 파일에도 없으니 첫 세션이 이어받는다. null = 메모리만. */
  const bindPersist = (next: WakeupPersistence | null): void => {
    const unsaved = persist && !writeRefused ? [] : [...entries.values()];
    for (const handle of timers.values()) clearTimer(handle);
    timers.clear();
    entries.clear();
    queuedForTurnEnd.clear(); // 세션이 바뀌면 대기 큐도 비운다 — 복원된 예약은 자기 거부 때 다시 싣는다
    persist = next ?? undefined;
    writeRefused = null;
    restoreFromPersist();
    if (writeRefused) {
      // 새 파일이 손상 — 저장 전 예약은 메모리에서 계속 돌되 저장하지 않는다(원본 보존).
      for (const entry of unsaved) { entries.set(entry.id, entry); arm(entry); }
      return;
    }
    for (const old of unsaved) {
      const entry = { ...old, id: `w${++seq}` };
      entries.set(entry.id, entry);
      arm(entry);
    }
    if (unsaved.length > 0 && persist) persistBestEffort();
  };

  return {
    schedule(req, requestKey) {
      const t = now();
      const reason = (req.reason ?? '').replace(/\s+/g, ' ').trim();
      const reject = (error: string): ScheduleWakeupResult => {
        log('tui.wakeup', 'rejected', { id: null, reason: 'invalid', error });
        return { ok: false, error };
      };
      // Every schedule attempt consumes the per-turn budget before validation.
      const turnId = readTurnId();
      const capped = loopCapError('schedule', turnId);
      if (capped) return { ok: false, error: capped };
      // Presence is the contract: invalidly typed `at` values from the host
      // must still conflict with delaySeconds rather than silently disappear.
      // UX #115497 — strict-mode 호스트가 optional 필드를 빈 값(at:""/null · delaySeconds:0/null)으로 채워 보낸다.
      // 빈 값·0 은 «미지정»이다. 실값(비어 있지 않은 at · 0 이 아닌 delaySeconds)만 존재로 센다.
      const atBlank = req.at === undefined || req.at === null || (typeof req.at === 'string' && req.at.trim() === '');
      const hasAt = (req.atProvided ?? req.at !== undefined) && !atBlank;
      const hasDelay = req.delaySeconds !== undefined && req.delaySeconds !== null && req.delaySeconds !== 0;
      if (hasAt && hasDelay) {
        const key = requestKey ?? canonicalToolArgs(req as Record<string, unknown>);
        if (turnId !== null) {
          const previousError = conflictErrors.get(key);
          if (previousError !== undefined) {
            return { ok: false, error: `${previousError} — 같은 충돌 인자의 재시도는 억제했다` };
          }
          if (conflictErrors.size < maxCallsPerTurn) conflictErrors.set(key, formatWakeupTimeConflictError(req));
        }
        const error = formatWakeupTimeConflictError(req);
        return reject(error);
      }
      if (!reason) return reject('reason 이 비었다 — 깨어나서 무엇을 할지 한 줄로 적어라');
      if (writeRefused) return reject(writeRefused);
      let repeatMs: number | undefined;
      // ⭐ 0 = 일회성(생략과 같다) — 모델이 «한 번만»을 0 으로 부른다(라이브 실측). 음수·NaN·1 미만 소수는 거부.
      if (req.repeatMinutes !== undefined && req.repeatMinutes !== 0) {
        if (typeof req.repeatMinutes !== 'number' || !Number.isFinite(req.repeatMinutes) || req.repeatMinutes * 60_000 < WAKEUP_MIN_DELAY_MS) {
          return reject(WAKEUP_REPEAT_INVALID_ERROR);
        }
        repeatMs = Math.round(req.repeatMinutes * 60_000);
      }
      let dueAt: number;
      if (hasAt) {
        if (typeof req.at !== 'string') return reject(`at 은 «HH:MM» 문자열이어야 한다 — 받은 값 ${JSON.stringify(req.at)}`);
        const resolved = resolveWakeupAt(req.at, t);
        if (resolved === null) return reject(`at 은 «HH:MM»(24시간) 꼴 — 받은 값 ${JSON.stringify(req.at)}`);
        dueAt = resolved;
      } else if (hasDelay) {
        if (!Number.isFinite(req.delaySeconds)) return reject('delaySeconds 가 수가 아니다');
        // 경계는 «받은 값»으로 잰다 — 반올림 뒤에 재면 59.9999초가 60초로 통과한다.
        const rawMs = req.delaySeconds! * 1000;
        if (rawMs < WAKEUP_MIN_DELAY_MS) return reject(`최소 ${WAKEUP_MIN_DELAY_MS / 1000}초 뒤부터 예약할 수 있다`);
        if (rawMs > WAKEUP_MAX_DELAY_MS) return reject('7일보다 먼 예약은 schedule_manage(cron) 몫');
        dueAt = t + Math.round(rawMs);
      } else if (repeatMs !== undefined) {
        dueAt = t + repeatMs;
      } else {
        return reject('at(«HH:MM») · delaySeconds · repeatMinutes 중 하나는 있어야 한다');
      }
      if (dueAt - t < WAKEUP_MIN_DELAY_MS) return reject(`최소 ${WAKEUP_MIN_DELAY_MS / 1000}초 뒤부터 예약할 수 있다`);
      if (dueAt - t > WAKEUP_MAX_DELAY_MS) return reject('7일보다 먼 예약은 schedule_manage(cron) 몫');
      // WAKE-CAP-RECLAIM (c): 같은 reason ⊕ 같은 반복 꼴의 예약이 이미 있으면 새로 만들지 않고 그 예약을 새 시각으로 옮긴다
      // (같은 «10분 뒤 추적» 을 매 턴 다시 걸어 슬롯이 차던 꼴).
      const same = [...entries.values()].find(e => e.reason === reason && (e.repeatMs ?? 0) === (repeatMs ?? 0));
      if (same) {
        const before = { ...same };
        same.dueAt = dueAt;
        same.retried = false;
        if (repeatMs !== undefined) same.expiresAt = t + WAKEUP_REPEAT_TTL_MS;
        queuedForTurnEnd.delete(same.id);
        arm(same);
        try { persistSave(); }
        catch (error) {
          Object.assign(same, before);
          arm(same);
          log('tui.wakeup', 'persist-save-failed', { error: String(error), action: 'merge', id: same.id });
          return reject(`예약을 저장하지 못해 예약하지 않았다: ${error instanceof Error ? error.message : String(error)}`);
        }
        log('tui.wakeup', 'merged', { id: same.id, dueAt, inMs: dueAt - t, previousDueAt: before.dueAt });
        deps.notify?.(`⏰ 예약 깨움 ${formatWakeupClock(dueAt)}: ${reason} (같은 예약 ${same.id} 시각만 옮김)`);
        return { ok: true, entry: { ...same }, merged: same.id };
      }
      // OP 11-25 07:49 — 바쁜 자리는 시각이 지난 일회성(«늦은 깨움» 배출 대기 · 소실 0 계약)이 쌓여 상한을 막았다
      // (20칸 중 늦은 대기 12). 상한은 «앞으로 올» 예약(미래 일회성 + 반복)만 센다. 늦은 대기는 따로 세고,
      // 전체는 상한 2배를 넘지 않는다(무한 적재 방지).
      // WAKE-CAP-RECLAIM (OP 11-25 12:0x · 전체 40 = 늦은 대기 32 + 앞으로 올 8): 막히면 먼저 묵은 늦은 예약을 한 깨움으로
      // 접어 슬롯을 회수한다(e). 그래도 막히면 거부 ⊕ 가장 오래된 예약 목록(d).
      const counts = () => {
        const overdue = [...entries.values()].filter(e => !e.repeatMs && e.dueAt <= t);
        // WAKE-FOLD-IDEMPOTENT ② — past-due wakes never count toward the cap (they are delivered, not scheduled).
        return { overdue, upcoming: entries.size - overdue.length, full: entries.size - overdue.length >= maxEntries };
      };
      // Housekeeping instead of a total cap: wakes ≥ 10 min late go to the next turn's inbox; stale ones that remain
      // (no inbox wired) fold into the single bundle once they pile up to the cap.
      deliverToInbox(t);
      let c = counts();
      let folded: { id: string; count: number } | null = null;
      if (c.full || c.overdue.length >= maxEntries) {
        folded = foldStale(t, 'cap');
        if (folded) { persistBestEffort(); c = counts(); }
      }
      if (c.full) {
        const { overdue, upcoming } = c;
        const late = overdue.length > 0
          ? ` · 그중 시각 지난 대기 ${overdue.length}개(${overdue.slice(0, 5).map(e => e.id).join(',')}${overdue.length > 5 ? ',…' : ''}) — 이미 처리했으면 cancel`
          : '';
        const error = `예약 상한 ${maxEntries}개(앞으로 올 예약 ${upcoming} · 전체 ${entries.size})${late} — list 로 보고 cancel 뒤 다시`;
        log('tui.wakeup', 'rejected', { id: null, reason: 'cap', error });
        const oldest = [...entries.values()].sort((a, b) => a.dueAt - b.dueAt).slice(0, WAKEUP_REFUSAL_OLDEST).map(e => ({ ...e }));
        return { ok: false, error, code: 'cap', oldest };
      }
      const entry: WakeupEntry = {
        id: `w${++seq}`,
        reason,
        dueAt,
        retried: false,
        fireCount: 0,
        ...(repeatMs !== undefined ? { repeatMs, expiresAt: t + WAKEUP_REPEAT_TTL_MS } : {}),
      };
	      entries.set(entry.id, entry);
	      arm(entry);
      try { persistSave(); }
      catch (error) {
        // 저장 실패 — 방금 건 이 한 항목만 되돌린다. 예약된 것처럼 말하지 않는다.
        const handle = timers.get(entry.id);
        if (handle !== undefined) clearTimer(handle);
        timers.delete(entry.id);
        entries.delete(entry.id);
        log('tui.wakeup', 'persist-save-failed', { error: String(error), action: 'schedule', id: entry.id });
        return reject(`예약을 저장하지 못해 예약하지 않았다: ${error instanceof Error ? error.message : String(error)}`);
      }
      log('tui.wakeup', 'scheduled', {
        id: entry.id, dueAt, inMs: dueAt - t, reason, ...(repeatMs ? { repeatMs, expiresAt: entry.expiresAt } : {}),
      });
      const repeat = repeatMs ? ` · ${Math.round(repeatMs / 60_000)}분마다(7일)` : ' (한 번)';
      deps.notify?.(`⏰ 예약 깨움 ${formatWakeupClock(dueAt)}${repeat}: ${reason}`);
      return { ok: true, entry: { ...entry }, ...(folded ? { folded } : {}) };
    },
	    list() {
	      return [...entries.values()].sort((a, b) => a.dueAt - b.dueAt).map(e => ({ ...e }));
	    },
    bindPersist,
    persists: () => !!persist && !writeRefused,
    hasFile: () => !!persist,
    cancel(id) {
      return tryCancel(id).ok;
    },
    tryCancel,
    dispose() {
      for (const handle of timers.values()) clearTimer(handle);
      timers.clear();
      queuedForTurnEnd.clear();
    },
    wrapPort(port: TextInputInternalTurnYieldPort): TextInputInternalTurnYieldPort {
      // attach 를 먼저 이어준 뒤 배출한다 — 마운트 «중»에 물러남을 청하지 않게 배출 본체는 0ms 미룬다
      // (drainQueuedWakeups). 배출이 실패해도 입력 마운트를 막지 않는다(fail-soft — agent-wake 관례).
      return {
        attach: (requestYield: () => boolean) => {
          port.attach(requestYield);
          try { drainQueuedWakeups(); }
          catch (error) { log('tui.wakeup', 'queued-drain-failed', { error: String(error) }); }
        },
        detach: (opts?: { yielded?: boolean }) => { port.detach(opts); },
        declined: (detail: string) => { port.declined?.(detail); },
      };
    },
  };
}

// ── LLM 도구 ───────────────────────────────────────────────────────────────────────────

const describeEntry = (e: WakeupEntry): Record<string, unknown> => ({
  id: e.id,
  at: formatWakeupClock(e.dueAt),
  dueAt: new Date(e.dueAt).toISOString(),
  reason: e.reason,
  ...(e.repeatMs ? { repeatMinutes: Math.round(e.repeatMs / 60_000), expiresAt: new Date(e.expiresAt!).toISOString() } : {}),
  fireCount: e.fireCount,
});

/** 자리 TUI 의 host tool — 대시보드가 자기 스케줄러를 넘겨 등록한다(하니스 자식·비 TUI 표면엔 없다). */
export function buildScheduleWakeupHostTool(scheduler: WakeupScheduler): LLMToolDef {
  // 저장 여부는 세션이 늦게 붙으면 바뀐다 — 설명(생성 시점)은 단정하지 않고, 결과(호출 시점)의 `saved` 가 사실을 말한다.
  const durable = 'When this TUI is attached to a session file, wakeups are saved per session and restored when that session is reopened; each schedule result reports `saved` (false = memory only, gone when this TUI exits). Wakeups belong to the session that created them and do not move when you switch sessions. Two TUIs writing the same session file is not supported (last write wins). A failed save leaves the previous file untouched and schedule/cancel then report an error; a damaged file refuses scheduling and cancelling. A one-shot past its time wakes late (immediately) on restore instead of being discarded; repeats resume at their next tick. ';
  return {
    name: SCHEDULE_WAKEUP_TOOL_NAME,
    description:
      'Wake THIS TUI later with an internal turn: when you would write «다음 점검 HH:MM» and end the turn, call this instead so the check actually happens. '
      + 'action=schedule (default) needs reason plus one of at ("HH:MM" local, past → tomorrow) / delaySeconds (≥60) / repeatMinutes (≥1; repeats expire after 7 days). Never provide both at and delaySeconds; the scheduler validates the timing choice. '
      + 'ONE-SHOT (wake once): give only delaySeconds or at and OMIT repeatMinutes (0 also means one-shot). Set repeatMinutes only when you really want it to repeat. '
      + `action=list shows pending wakeups; action=cancel needs id. Limits: ≥60s ahead, ≤7 days, at most ${WAKEUP_MAX_ENTRIES} upcoming (past-due one-shots do not count: they are delivered together in one notice — at the next idle turn, or on the next turn's inbox after 10 busy minutes), an identical reason re-times the existing wakeup instead of adding a duplicate, a refusal returns success:false with the oldest wakeups to cancel, at most ${WAKEUP_MAX_CALLS_PER_TURN} schedule/cancel calls per turn. `
      + 'If the TUI is busy or the human is typing at that time it retries once a minute (up to 30 minutes), then stays queued and wakes exactly once the moment the current turn ends — a scheduled wakeup is never silently lost. '
      + durable
      + 'Not the same as schedule_manage — that is an OS cron job that runs a command outside this TUI and never opens a turn here.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['schedule', 'list', 'cancel'], description: 'Default schedule.' },
        at: { type: 'string', description: 'Local wall-clock time "HH:MM" (24h). If already past today, schedules for tomorrow.' },
        delaySeconds: { type: 'number', description: 'Seconds from now (≥60). Use instead of at.' },
        repeatMinutes: { type: 'number', description: 'Repeat interval in minutes (≥1). Expires 7 days after scheduling. Omit (or 0) for a one-shot wakeup.' },
        reason: { type: 'string', description: 'What to do when woken — shown on screen and given to the wakeup turn.' },
        id: { type: 'string', description: 'Wakeup id for action=cancel (from schedule/list).' },
      },
      required: [],
    },
    handler: async (args) => {
      const action = typeof args.action === 'string' ? args.action : 'schedule';
      if (action === 'list') return { wakeups: scheduler.list().map(describeEntry) };
      if (action === 'cancel') {
        const id = typeof args.id === 'string' ? args.id : '';
        const r = scheduler.tryCancel(id);
        return r.ok ? { cancelled: id } : { error: r.error };
      }
      if (action !== 'schedule') return { error: `unknown action ${JSON.stringify(action)}` };
      const atProvided = Object.prototype.hasOwnProperty.call(args, 'at');
      const request: ScheduleWakeupRequest = {
        reason: typeof args.reason === 'string' ? args.reason : '',
        atProvided,
        ...(atProvided ? { at: args.at } : {}),
        ...(typeof args.delaySeconds === 'number' && args.delaySeconds !== 0 ? { delaySeconds: args.delaySeconds } : {}),
        ...(typeof args.repeatMinutes === 'number' ? { repeatMinutes: args.repeatMinutes } : {}),
      };
      const result = scheduler.schedule(request, canonicalToolArgs(args));
      if (result.ok) {
        return {
          scheduled: describeEntry(result.entry), saved: scheduler.persists(),
          ...(result.merged ? { merged: result.merged, note: `an identical wakeup (${result.merged}) already existed — moved it to the new time instead of adding a duplicate` } : {}),
          ...(result.folded ? { folded: result.folded } : {}),
        };
      }
      // WAKE-CAP-RECLAIM (d): 상한 거부는 «명시적 거부» — success:false ⊕ 이유 ⊕ 먼저 cancel 할 가장 오래된 예약.
      if (result.code === 'cap') {
        return {
          success: false, refused: 'wake-cap', error: result.error,
          oldest: (result.oldest ?? []).map(describeEntry),
          hint: 'NOT scheduled. Cancel the oldest wakeups listed (action:cancel id) that are already handled, then schedule again.',
        };
      }
      return { error: result.error };
    },
  };
}

// ── 대시보드 배선(실물 경로 = 시험이 같은 함수를 부른다) ─────────────────────────────────────

/** 대시보드의 H2 문에 스케줄러를 잇는다 — 직전 회차 판정 = «그 예약이 연 내부 턴이 아직 도나». */
export function createDashboardWakeupScheduler(
  gate: WakeupTurnGate,
  deps: Omit<WakeupSchedulerDeps, 'startTurnIfIdle' | 'isTurnActive'> = {},
): WakeupScheduler {
  // The N03 real-TUI scenario must cover a scheduled wake while a turn is busy,
  // then the one-minute retry after it settles. Keep the logical clock exact,
  // but let that isolated fake-LLM fixture advance timer deadlines quickly.
  // Both opt-ins are required; ordinary TUI sessions always use wall-clock time.
  const acceleratedTestClock = process.env.ELANOUS_TEST_FAKE_LLM === '1'
    && process.env.ELANOUS_TEST_FAST_WAKEUP_CLOCK === '1';
  let testNow = Date.now();
  const schedulerDeps: Omit<WakeupSchedulerDeps, 'startTurnIfIdle' | 'isTurnActive'> = acceleratedTestClock
    ? {
      ...deps,
      now: () => testNow,
      setTimer: (callback, logicalDelayMs) => {
        // Keep one busy deferral, then let the idle retry fire without spending 11 wall-clock seconds.
        return setTimeout(() => {
          testNow += logicalDelayMs;
          callback();
        }, 2_000);
      },
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    }
    : deps;
  return createWakeupScheduler({
    ...schedulerDeps,
    startTurnIfIdle: (text, opts) => gate.startTurnIfIdle(text, opts),
    isTurnActive: (turnId) => gate.isInternalTurnActive() && gate.lastTurnId() === turnId,
    // 한 턴 호출 상한의 턴 경계 = H2 가 아는 마지막 턴 id(사람 제출마다 human-N · 내부 턴마다 auto-N).
    currentTurnId: () => gate.lastTurnId(),
  });
}

/** 대시보드 host tool 로 등록한다 — 하니스 자식(`ELANOUS_HARNESS_ROLE` 있음)은 무인 런이라 싣지 않는다.
 *  host tool 은 대시보드 pluginHost 에만 있으므로 비 TUI 표면엔 애초에 없다. 등록했으면 true. */
export function registerScheduleWakeupHostTool(
  host: { registerHostTool(tool: LLMToolDef): void },
  scheduler: WakeupScheduler,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.ELANOUS_HARNESS_ROLE?.trim()) return false;
  host.registerHostTool(buildScheduleWakeupHostTool(scheduler));
  return true;
}
