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
//   놓친 반복 틱은 하나로 합친다 · 발화 때 H2 가 거부하면(바쁨·사람 입력 중) 1분 뒤 «한 번» 다시 청하고,
//   그래도 거부면 반복은 다음 회차로, 일회성은 놓침으로 접는다.
//
// 세 얼굴:
//   관측 = debug.log('tui.wakeup', 'scheduled' | 'fired' | 'skipped' | 'rejected' | 'cancelled', { id, ... })
//   인지 = 예약 시각 도래 ∧ (직전 회차 진행 중 → 건너뜀 · 만료 → 소멸 · H2 거부 사유)
//   힐링 = H2 로 내부 턴(화면은 H2 의 «↻ 자동 재개(scheduled): …» 한 줄 · 예약 순간엔 «⏰ 예약 깨움 …» 한 줄) ·
//          거부 → 1분 뒤 1회 재시도 → 그래도 거부면 «⏰ 예약 깨움 놓침» 한 줄 ⊕ 로그(TF 가 본다)
//
// 🩹 TUI-H5-ONESHOT-SCHEMA(0.2.32 · 라이브 실측 두 번): 모델이 «한 번만»을 `repeatMinutes:0` 으로 불렀다 →
//   «1 이상» 거부 → 1분 반복으로 재예약 → 취소 → 또 … 한 턴에 26회. ⇒ ① `repeatMinutes:0` = 일회성으로 받는다 ·
//   다른 틀린 값의 거부 문구는 «일회성은 repeatMinutes 생략» 을 가리킨다(재시도 고리를 끊는 안내) ·
//   ② 한 턴(같은 턴 id · H2 `lastTurnId`) 안 schedule·cancel 합계가 `WAKEUP_MAX_CALLS_PER_TURN` 을 넘으면
//   거부 ⊕ debug.log('tui.wakeup','loop-capped',{turnId,count}).

import { debug } from '../../debug/log.js';
import type { LLMToolDef } from '../../plugins/core/types.js';
import type { InternalTurnGate, StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../../dashboard/input/internal-turn.js';

export const SCHEDULE_WAKEUP_TOOL_NAME = 'ScheduleWakeup';
export const WAKEUP_MIN_DELAY_MS = 60_000;
export const WAKEUP_MAX_ENTRIES = 5;
export const WAKEUP_REPEAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const WAKEUP_RETRY_DELAY_MS = 60_000;
/** 바쁨(NotIdle)·사람 입력 중(HumanTyping)으로 못 연 깨움을 «버리지 않고» 미루는 상한 — 첫 예정 시각부터.
 *  TUI-WAKEUP-DEFER-NOT-DROP(10-22 OPT w7: 02:38·02:39 NotIdle → dropped · codex 는 idle 때 골을 이어가고 바쁘면 미룬다). */
export const WAKEUP_DEFER_MAX_MS = 30 * 60_000;
/** 미룸 대상인 거부 이유 — 곧 풀리는 «지금 바쁨» 뿐이다(Disabled·Cap·Superseded 는 미뤄도 안 풀린다). */
const WAKEUP_DEFERRABLE_REASONS: ReadonlySet<string> = new Set(['NotIdle', 'HumanTyping']);
/** 일회성 지연의 상한 — 반복 TTL 과 같은 7일(그보다 먼 일은 cron `schedule_manage` 몫). */
export const WAKEUP_MAX_DELAY_MS = WAKEUP_REPEAT_TTL_MS;
/** 한 턴 안 schedule·cancel 호출 합계 상한 — 넘으면 «다음 턴에» 로 거부(예약·취소 고리 차단). */
export const WAKEUP_MAX_CALLS_PER_TURN = 6;
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
  maxEntries?: number;
  /** 지금 도는 턴 id(사람·내부 · H2 `lastTurnId`). 주면 그 턴 안 schedule·cancel 합계에 상한을 건다. */
  currentTurnId?: () => string | null;
  /** 한 턴 호출 상한(기본 `WAKEUP_MAX_CALLS_PER_TURN`). */
  maxCallsPerTurn?: number;
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
  | { ok: true; entry: WakeupEntry }
  | { ok: false; error: string };

export type CancelWakeupResult = { ok: true } | { ok: false; error: string; capped?: boolean };

export interface WakeupScheduler {
  schedule(req: ScheduleWakeupRequest, requestKey?: string): ScheduleWakeupResult;
  list(): WakeupEntry[];
  cancel(id: string): boolean;
  /** cancel 과 같되 거부 사유(없는 id · 턴 상한)를 값으로 낸다 — LLM 도구가 쓴다. */
  tryCancel(id: string): CancelWakeupResult;
  /** 모든 타이머를 거둔다(TUI 종료). */
  dispose(): void;
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
export function formatWakeupPrompt(entry: Pick<WakeupEntry, 'id' | 'reason' | 'repeatMs'>): string {
  const repeat = entry.repeatMs ? ` · 반복 ${Math.round(entry.repeatMs / 60_000)}분` : '';
  return `[예약 깨움 ${entry.id}${repeat}] ${entry.reason} — 스스로 예약한 점검 시각이다. 남은 일을 이어서 처리하라.`;
}

export function createWakeupScheduler(deps: WakeupSchedulerDeps): WakeupScheduler {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? defaultClearTimer;
  const log = deps.log ?? ((c, e, d) => debug.log(c, e, d));
  const maxEntries = deps.maxEntries ?? WAKEUP_MAX_ENTRIES;
  const entries = new Map<string, WakeupEntry>();
  const timers = new Map<string, WakeupTimerHandle>();
  let seq = 0;
  const maxCallsPerTurn = deps.maxCallsPerTurn ?? WAKEUP_MAX_CALLS_PER_TURN;
  let callTurnKey: string | null = null;
  let callCount = 0;
  const conflictErrors = new Map<string, string>();

  const readTurnId = (): string | null => deps.currentTurnId?.() ?? null;

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
    if (!entries.has(id)) return { ok: false, error: `no pending wakeup ${JSON.stringify(id)}` };
    drop(id);
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
  };

  /** 다음 회차로 — 놓친 틱은 하나로 합친다. 만료를 넘으면 소멸. */
  const advance = (entry: WakeupEntry, t: number): void => {
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
  };

  const fire = (id: string): void => {
    const entry = entries.get(id);
    timers.delete(id);
    if (!entry) return;
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
    let result: StartTurnIfIdleResult;
    try {
      result = deps.startTurnIfIdle(formatWakeupPrompt(entry), { origin: 'scheduled', reason: entry.reason });
    } catch (error) {
      result = { opened: false, reason: 'NotIdle', detail: `threw:${String(error)}` };
    }
    if (result.opened) {
      entry.lastTurnId = result.turnId;
      entry.fireCount += 1;
      log('tui.wakeup', 'fired', {
        id, turnId: result.turnId, reason: entry.reason, retried: entry.retried, repeat: !!entry.repeatMs,
      });
      advance(entry, t);
      return;
    }
    log('tui.wakeup', 'rejected', {
      id, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}), retried: entry.retried,
    });
    const deferrable = WAKEUP_DEFERRABLE_REASONS.has(result.reason);
    if (deferrable) {
      // 바쁨·사람 입력 중 — 버리지 않고 1분마다 다시 청한다(같은 회차). 상한 = 첫 예정 시각 + WAKEUP_DEFER_MAX_MS,
      // 반복이면 다음 회차 시각도 상한(그 회차가 이 깨움을 대신한다).
      const nextTry = t + WAKEUP_RETRY_DELAY_MS;
      // 상한 시각의 시도까지는 한다(<=) · 반복은 다음 회차 시각과 겹치면 그 회차에 넘긴다(<).
      const withinDeferCap = nextTry <= entry.dueAt + WAKEUP_DEFER_MAX_MS;
      const beforeNextTick = !entry.repeatMs || nextTry < entry.dueAt + entry.repeatMs;
      if (withinDeferCap && beforeNextTick) {
        entry.retried = true;
        timers.set(id, setTimer(() => fire(id), WAKEUP_RETRY_DELAY_MS));
        return;
      }
    } else if (!entry.retried) {
      // 바쁨이 아닌 거부 — 1분 뒤 한 번만 다시 청한다(기존 계약).
      entry.retried = true;
      timers.set(id, setTimer(() => fire(id), WAKEUP_RETRY_DELAY_MS));
      return;
    }
    const exhausted = deferrable ? 'defer-exhausted' : 'retry-exhausted';
    if (entry.repeatMs) {
      log('tui.wakeup', 'skipped', { id, reason: exhausted, next: 'repeat' });
      advance(entry, t);
      return;
    }
    log('tui.wakeup', 'skipped', { id, reason: exhausted, next: 'dropped' });
    deps.notify?.(`⏰ 예약 깨움 놓침(${id}): ${entry.reason} — ${result.reason}`);
    drop(id);
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
      const hasAt = req.atProvided ?? req.at !== undefined;
      const hasDelay = req.delaySeconds !== undefined;
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
      if (entries.size >= maxEntries) return reject(`예약 상한 ${maxEntries}개 — list 로 보고 cancel 뒤 다시`);
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
      log('tui.wakeup', 'scheduled', {
        id: entry.id, dueAt, inMs: dueAt - t, reason, ...(repeatMs ? { repeatMs, expiresAt: entry.expiresAt } : {}),
      });
      const repeat = repeatMs ? ` · ${Math.round(repeatMs / 60_000)}분마다(7일)` : ' (한 번)';
      deps.notify?.(`⏰ 예약 깨움 ${formatWakeupClock(dueAt)}${repeat}: ${reason}`);
      return { ok: true, entry: { ...entry } };
    },
    list() {
      return [...entries.values()].sort((a, b) => a.dueAt - b.dueAt).map(e => ({ ...e }));
    },
    cancel(id) {
      return tryCancel(id).ok;
    },
    tryCancel,
    dispose() {
      for (const handle of timers.values()) clearTimer(handle);
      timers.clear();
      entries.clear();
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
  return {
    name: SCHEDULE_WAKEUP_TOOL_NAME,
    description:
      'Wake THIS TUI later with an internal turn: when you would write «다음 점검 HH:MM» and end the turn, call this instead so the check actually happens. '
      + 'action=schedule (default) needs reason plus one of at ("HH:MM" local, past → tomorrow) / delaySeconds (≥60) / repeatMinutes (≥1; repeats expire after 7 days). Never provide both at and delaySeconds; the schema requires one timing variant. '
      + 'ONE-SHOT (wake once): give only delaySeconds or at and OMIT repeatMinutes (0 also means one-shot). Set repeatMinutes only when you really want it to repeat. '
      + `action=list shows pending wakeups; action=cancel needs id. Limits: ≥60s ahead, ≤7 days, at most 5 pending, at most ${WAKEUP_MAX_CALLS_PER_TURN} schedule/cancel calls per turn. `
      + 'If the TUI is busy or the human is typing at that time it retries once a minute later, then gives up (repeats move to the next tick). '
      + 'In-process timer: lost when the TUI restarts. Not the same as schedule_manage — that is an OS cron job that runs a command outside this TUI and never opens a turn here.',
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
      oneOf: [
        { not: { anyOf: [{ required: ['at'] }, { required: ['delaySeconds'] }] } },
        { required: ['at'], not: { required: ['delaySeconds'] } },
        { required: ['delaySeconds'], not: { required: ['at'] } },
      ],
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
        ...(typeof args.delaySeconds === 'number' ? { delaySeconds: args.delaySeconds } : {}),
        ...(typeof args.repeatMinutes === 'number' ? { repeatMinutes: args.repeatMinutes } : {}),
      };
      const result = scheduler.schedule(request, canonicalToolArgs(args));
      return result.ok ? { scheduled: describeEntry(result.entry) } : { error: result.error };
    },
  };
}

// ── 대시보드 배선(실물 경로 = 시험이 같은 함수를 부른다) ─────────────────────────────────────

/** 대시보드의 H2 문에 스케줄러를 잇는다 — 직전 회차 판정 = «그 예약이 연 내부 턴이 아직 도나». */
export function createDashboardWakeupScheduler(
  gate: Pick<InternalTurnGate, 'startTurnIfIdle' | 'isInternalTurnActive' | 'lastTurnId'>,
  deps: Omit<WakeupSchedulerDeps, 'startTurnIfIdle' | 'isTurnActive'> = {},
): WakeupScheduler {
  return createWakeupScheduler({
    ...deps,
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
