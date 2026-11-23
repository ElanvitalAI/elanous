// ── 골 이어가기 `goal-continue` (TURN-END-BEFORE-GOAL · 0.2.36 · 2026-10-22 · 대표 P0 «classic·next 둘 다») ──────
//
// 🚨 무엇을 푸는가: 사용자가 목적·결과물을 준 일에서, 모델이 결과물 없이 «…하겠습니다 / …해야 합니다 /
//   제가 멈췄습니다» 로 턴을 «✔ 완료» 처리하고 멈춘다 — 사람이 다시 밀 때까지 정지(10-22 n8n 세션 실물 2회).
// ⭐ codex `on_thread_idle → continue_if_idle`(ext/goal extension.rs) 꼴: 턴이 끝났는데 «약속만 하고 끝난 답»이면
//   H2 내부 턴 문(`startTurnIfIdle` · origin `goal-continue`)으로 스스로 다음 턴을 연다. 문은 새로 짓지 않는다.
// ⛔ 사람에게 묻고 끝난 답(«…할까요?» · «확인해 주세요» · «원하시면»)은 정당한 멈춤 — 열지 않는다.
// ⛔ 입력칸 버퍼·`injectKey`·pty 주입 0(대표 비침투). 판정은 화면에 그린 답 줄(classic `chatLines` · next 세션 답)만 읽는다.
//
// 켜짐: 기본 켜짐 · `ELANOUS_TUI_GOAL_CONTINUE=0|off|false` 면 끔 · 하니스 자식(ELANOUS_HARNESS_ROLE)은 끔.
// 상한: 사람 입력 없이 연속 K=3 · 같은 답 끝 구절(지문)로는 1회 · 상한 → 화면 한 줄 «사람 확인 필요» ⊕ 'cap'.
//
// 세 얼굴:
//   관측 = debug.log('tui.goal-continue', 'decided', { opened|rejected, reason, tail, consecutive }) · 'cap'
//   인지 = 턴 끝 ∧ 답 끝 구절이 약속형 ∧ 질문형 아님 ∧ 상한 안
//   힐링 = H2 로 «약속한 일을 지금 실행하라» 한 턴(화면 «↻ 자동 재개(goal-continue): …») · 상한 → 멈춤 ⊕ 'cap'

import { compareTurnOutcome } from '../../commitment/turn-outcome-shadow.js';
import type { PlanTurnOutcome } from '../../code-edit/plan-outcome.js';
import type { BlockReason } from '../../agent-events/protocol.js';
import { outcomeOfPlanWire, type PlanWire } from '../../code-edit/plan-wire.js';
import type { TextInputInternalTurnYieldPort } from '../../chat/index.js';
import { debug } from '../../debug/log.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from './internal-turn.js';
import { classifyReplyTail, replyTailFromLines, type GoalContinueVerdict } from '../../chat/goal-continue-verdict.js';
import { CONTINUE_REASON } from '../chat/continue-banner.js';
export { classifyReplyTail, replyTailFromLines } from '../../chat/goal-continue-verdict.js';
export type { GoalContinueVerdict } from '../../chat/goal-continue-verdict.js';

export const GOAL_CONTINUE_ENV = 'ELANOUS_TUI_GOAL_CONTINUE';
export const DEFAULT_GOAL_CONTINUE_CAP = 3;
/** ELN-CONTINUE-AFTER-DECLARED-NEXT-STEP: automatic next turns after a seat turn cap, per person's turn (resets on human input). */
export const DEFAULT_SEAT_CAP_CONTINUE_LIMIT = 5;
export const SEAT_CAP_CONTINUE_ENV = 'ELANOUS_TUI_SEAT_CAP_CONTINUE';
/** Plan-driven continues in a row (no person's turn between) before a person is asked. */
export const DEFAULT_PLAN_CONTINUE_LIMIT = 10;
/** Language-free: the verdict came from the plan state, so the prompt only restates the contract. */
export const PLAN_CONTINUE_PROMPT = '[plan] Open steps remain in your plan and nothing is marked blocked. Continue with the active step using tools and keep the plan current with update_plan. '
  + 'Decide questions you can answer yourself; if you truly cannot go on without a person or an outside change, mark that step blocked with a reason instead of asking.';
export const PLAN_NUDGE_PROMPT = '[plan] Record this turn\'s outcome with update_plan before ending a turn: finished steps completed, the active step in_progress, a step that needs a person blocked (with a reason), '
  + 'a step that waits for something waiting (with a wake). Then continue if work remains.';

export const SEAT_CAP_CONTINUE_PROMPT = '[자리 턴 상한 이어가기] 앞 자리 턴이 도구·시간 상한에 닿아 마감됐다. 위 진행 요약을 이어받아 남은 일을 계속한다 — 다 끝났다면 update_goal(status:"complete", evidence) 로 마감하고, 사람 판단·권한이 필요한 막힘이면 무엇이 필요한지 한 줄로 쓰고 멈춘다.';
const HUMAN_ACTION = /로그인(?:이 필요|해 주세요)|결제(?:가 필요|해 주세요|해야 합니다)|(?:사람|사용자)의\s*(?:결정|승인)|(?:결정|승인)(?:이 필요|해 주세요)|권한이 필요|비밀번호를 입력해 주세요|위험\s*(?:승인|감수)(?:가 필요|를 직접)|직접\s*(?:선택|확인|승인)(?:해 주세요|이 필요)|\bhuman\s+(?:approval|decision|login|payment)\s+(?:is )?(?:required|needed)\b/iu;
const REMAINING_WORK = /(?:남은\s*(?:일|작업|것)|remaining work).{0,80}(?:아직|미완|남아\s*있|못\s*(?:했|하)|하지\s*못|not yet|unfinished|incomplete)/iu;
const NO_REMAINING_WORK = /(?:남은\s*(?:일|작업|것)(?:은|이)?\s*(?:없|완료|끝)|(?:모두|전부)\s*(?:완료|끝났)|\bno remaining work\b|\ball remaining work\b.{0,16}\b(?:done|complete|finished)\b)/iu;

function remainingWorkTail(tail: string | null): string | null {
  if (!tail || NO_REMAINING_WORK.test(tail) || !REMAINING_WORK.test(tail)) return null;
  const sentence = tail.split(/(?<=[.!?。？])\s+/u).reverse().find((part) => REMAINING_WORK.test(part));
  return (sentence ?? tail).slice(-120);
}

export function goalContinueFingerprint(tail: string): string {
  let h = 2166136261;
  for (let i = 0; i < tail.length; i++) { h ^= tail.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

/** next: 세션 메시지 중 «이번 턴이 만든» 마지막 답만.
 *  ① 보통 턴 = 턴 시작 때 길이(startIndex) 뒤에서 찾는다 — 이번 턴 답이 없으면 빈 배열(앞 턴 답으로 안 연다 · r3).
 *  ② 이번 턴에 자동 압축이 있었으면(startIndex 가 'after-last-user') 압축으로 줄어든 길이 대신
 *     «마지막 사람 메시지 뒤» 의 답만 본다 — 이번 턴 사람 글은 압축 뒤에도 마지막 사람 글이다(r5 must-fix). */
export function replyLinesOfThisTurn(messages: ReadonlyArray<{ role: string; content?: unknown }>, startIndex: number | 'after-last-user'): string[] {
  let from: number;
  if (startIndex === 'after-last-user') {
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') { lastUser = i; break; }
    if (lastUser < 0) return [];
    from = lastUser + 1;
  } else {
    from = Math.max(0, startIndex);
  }
  const reply = messages.slice(from).filter((m) => m.role === 'assistant').at(-1);
  return typeof reply?.content === 'string' ? reply.content.split('\n') : [];
}

export function formatGoalContinuePrompt(phrase: string): string {
  return `[골 이어가기] 방금 답이 «${phrase}» 로 끝났다 — 약속만 하고 턴을 끝내지 말고, 그 일을 지금 도구로 실행해 결과물을 만든다. `
    + '원래 사용자 요청 범위 안에서만 이어간다. 정말 사람 판단·권한이 필요하면 무엇이 필요한지 한 줄로 묻고 멈춘다.';
}

export function isGoalContinueEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ELANOUS_HARNESS_ROLE?.trim()) return false;
  const v = (env[GOAL_CONTINUE_ENV] ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false');
}

// ── 배선 컨트롤러 ────────────────────────────────────────────────────────────────────

export interface GoalContinueDeps {
  /** H2 문 — classic `internalTurnGate.startTurnIfIdle` · next `wakeup.gate.startTurnIfIdle`. */
  startTurnIfIdle: (input: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  isEnabled?: () => boolean;
  consecutiveCap?: number;
  /** When the plan was not touched, ask for its state once before the wording rules continue (the Next TUI turns this on). */
  planNudge?: boolean;
  /** Plan-driven automatic continues allowed in a row (default 10). */
  planContinueLimit?: number;
  /** The plan said something a person or the host should act on: blocked (reason), waiting (wake) or done. */
  onPlanOutcome?: (outcome: Exclude<PlanTurnOutcome, { kind: 'continue' | 'gap' }>, plan: PlanWire) => void;
  /** Seat name for the shadow comparison events. */
  seat?: string;
  /** Automatic continues allowed after seat-cap exhaustion before a person is needed (default 5; env ELANOUS_TUI_SEAT_CAP_CONTINUE overrides, 0 = off). */
  seatCapContinueLimit?: number;
  notify?: (line: string) => void;
  /**
   * SEAT-STATE-ENUM: the same «a person is needed» stop as a code — BLOCKED with one reason — so a coordinator never reads the
   * notice wording. A plan block carries the model's own `code`; the automatic-continue limits are a person's decision.
   */
  onBlocked?: (reason: BlockReason, detail: string) => void;
  /** Clock for a paced retry (`retryAt`). Default Date.now. */
  now?: () => number;
  /** 사람 입력 직후 거부(HumanTyping)면 다시 잴 시각까지 미룬다(기본 setTimeout · unref). */
  defer?: (fn: () => void, ms: number) => void;
  /**
   * ELN-TURN-CAP-CONTINUE-STALL (③): the gate only parks a pending turn. This asks, after a short
   * wait, whether the input loop took that turn (`takePending`). A false reading withdraws it and
   * paints the stop. Unset means the caller has no loop to watch, so opening stays synchronous.
   */
  confirmSeatCapTurnStarted?: (turnId: string) => Promise<boolean>;
  /** HumanTyping 재시도 간격(기본 문 조용창 10초 + 여유). */
  retryMs?: number;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

export interface GoalContinueTurnEnd {
  /** 화면에 그린 답 줄(classic `chatLines` 꼬리) — 또는 답 원문 한 줄(next). */
  lines: readonly string[];
  /** 턴이 실패(✘)·취소로 끝났으면 true — 이어가지 않는다. */
  failed?: boolean;
  /** The goal loop's stop reason; `max_turns` = the seat turn cap (tools / wall clock) was exhausted. */
  stopReason?: string;
  /** The plan state at turn end (DECISION-GATE v2): the structured outcome, read instead of the reply's wording. */
  plan?: PlanWire;
  turnId?: string;
}

export interface GoalContinueController {
  /** 모델 턴이 끝났다 — 답 끝 구절을 판정해 둔다(여는 것은 check). */
  noteTurnEnded(end: GoalContinueTurnEnd): void;
  /** A goal-loop completion is terminal until a person starts a fresh turn. */
  noteGoalCompleted(): void;
  /** 판정된 턴 끝이 무장돼 있으면 H2 로 연다. 사람 입력이 먼저면 미뤘다가 다시 잰다. */
  check(): { opened: boolean; reason: string };
  /** 사람이 턴을 열었다 — 연속 카운터·지문을 비운다. */
  noteHumanTurn(): void;
  /** classic: H2 yield port 를 감싸 «입력칸 마운트 = 판정 시점»으로 잇는다(입력칸 무접촉). */
  wrapPort(port: TextInputInternalTurnYieldPort): TextInputInternalTurnYieldPort;
}

function defaultDefer(fn: () => void, ms: number): void {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
}

/** First retry after a «turn-running» refusal at turn end (TURN-FIELD-BUG-5). OP #91474 (CX-7 diag): busy drops right after settle. */
export const TURN_RUNNING_RETRY_BASE_MS = 50;

export function createGoalContinue(deps: GoalContinueDeps): GoalContinueController {
  const isEnabled = deps.isEnabled ?? (() => isGoalContinueEnabledByEnv());
  const cap = deps.consecutiveCap ?? DEFAULT_GOAL_CONTINUE_CAP;
  const defer = deps.defer ?? defaultDefer;
  const retryFromEnv = Number(process.env.ELANOUS_TEST_GOAL_CONTINUE_RETRY_MS);
  const retryMs = deps.retryMs ?? (Number.isFinite(retryFromEnv) && retryFromEnv >= 0 ? retryFromEnv : 10_500);
  const log = deps.log ?? ((c, e, d) => debug.log(c, e, d));
  const blockedFor = (reason: BlockReason, detail: string): void => { try { deps.onBlocked?.(reason, detail); } catch { /* reporting cannot break a turn end */ } };

  const seatCapLimit = (() => {
    const raw = Number((process.env[SEAT_CAP_CONTINUE_ENV] ?? '').trim());
    return Number.isInteger(raw) && raw >= 0 && (process.env[SEAT_CAP_CONTINUE_ENV] ?? '').trim() !== '' ? raw : (deps.seatCapContinueLimit ?? DEFAULT_SEAT_CAP_CONTINUE_LIMIT);
  })();
  let seatCapConsecutive = 0;
  type Armed = { tail: string; phrase: string; fingerprint: string; mode: 'pledge' | 'remaining' | 'seat-cap' | 'plan' | 'plan-nudge' };
  let armed: Armed | null = null;
  let planConsecutive = 0;
  let planNudged = false;
  const planLimit = deps.planContinueLimit ?? DEFAULT_PLAN_CONTINUE_LIMIT;
  let consecutive = 0;
  /** 사람 턴 이후 이미 이어간 답들의 지문 — A→B→A 에서도 같은 답으로 두 번 열지 않는다(r2 must-fix). */
  const openedFingerprints = new Set<string>();
  let capNotified = false;
  let retryArmed = false;
  /** TURN-FIELD-BUG-5: «turn-running» refusals in a row — the turn-end check runs before busy drops. */
  let turnRunningStreak = 0;
  let completedGoal = false;

  /**
   * A refused open: busy · a person typing · or ELN-SEAT-TURN-PACING's minimum interval (`Cap` with `retryAt`) keep the
   * arm and measure again once — at `retryAt` for pacing, else after `retryMs`. Any other refusal (incl. the pacing run cap,
   * which has no `retryAt`: only a new event or a person opens the next turn) drops the arm.
   */
  const handleRejected = (result: { reason: string; retryAt?: number; detail?: string }): void => {
    const pacedAt = result.reason === 'Cap' && result.retryAt !== undefined ? result.retryAt : null;
    const transient = result.reason === 'HumanTyping' || result.reason === 'NotIdle' || pacedAt !== null;
    if (!transient) { armed = null; return; }
    if (retryArmed) return;
    retryArmed = true;
    // TURN-FIELD-BUG-5: the turn-end check runs inside settle, while busy is still up — the gate says NotIdle
    // «turn-running» although the turn is over. Try again almost at once (busy drops right after settle), doubling up
    // to retryMs so a turn that really keeps running is not polled hard. Any other refusal keeps the old wait.
    const turnRunning = result.reason === 'NotIdle' && result.detail === 'turn-running';
    const fast = turnRunning ? Math.min(retryMs, TURN_RUNNING_RETRY_BASE_MS * 2 ** turnRunningStreak) : null;
    if (turnRunning) turnRunningStreak += 1;
    const wait = pacedAt !== null ? Math.max(0, pacedAt - (deps.now ?? Date.now)()) : fast ?? retryMs;
    defer(() => { retryArmed = false; try { check(); } catch { /* fail-soft */ } }, wait);
  };

  const check: GoalContinueController['check'] = () => {
    if (completedGoal) return { opened: false, reason: 'goal-completed' };
    if (!armed) return { opened: false, reason: 'not-armed' };
    const { tail, phrase, fingerprint, mode } = armed;
    if (mode === 'plan' || mode === 'plan-nudge') {
      if (mode === 'plan' && planConsecutive >= planLimit) {
        armed = null;
        log('tui', 'turn.auto-continue', { rejected: true, reason: 'plan-limit', n: planConsecutive, limit: planLimit });
        deps.notify?.(`⏸ Plan still has open steps after ${planConsecutive} automatic continues — a person is needed · any key resumes`);
        blockedFor('HUMAN_DECISION', 'plan-limit');
        return { opened: false, reason: 'plan-limit' };
      }
      const planResult = deps.startTurnIfIdle(mode === 'plan' ? PLAN_CONTINUE_PROMPT : PLAN_NUDGE_PROMPT,
        { origin: 'goal-continue', reason: mode === 'plan' ? 'plan has open steps · continuing' : 'plan not updated · asking for its state' });
      if (planResult.opened) {
        armed = null;
        if (mode === 'plan') planConsecutive += 1; else planNudged = true;
        log('tui', 'turn.auto-continue', { opened: true, reason: mode === 'plan' ? 'plan-open' : 'plan-nudge', n: planConsecutive, limit: planLimit, turnId: planResult.turnId });
        return { opened: true, reason: mode === 'plan' ? 'plan-open' : 'plan-nudge' };
      }
      handleRejected(planResult);
      return { opened: false, reason: planResult.reason };
    }
    if (mode === 'seat-cap') {
      // A capped seat turn is not a repeated answer: progress is judged by the counter, not the reply fingerprint.
      if (seatCapConsecutive >= seatCapLimit) {
        armed = null;
        log('tui', 'turn.auto-continue', { rejected: true, reason: 'seat-cap-limit', n: seatCapConsecutive, limit: seatCapLimit });
        deps.notify?.(`⏸ Seat turn cap reached ${seatCapConsecutive} times in a row — a person is needed · any key resumes`);
        blockedFor('HUMAN_DECISION', 'seat-cap-limit');
        return { opened: false, reason: 'seat-cap-limit' };
      }
      const capResult = deps.startTurnIfIdle(SEAT_CAP_CONTINUE_PROMPT, { origin: 'goal-continue', reason: CONTINUE_REASON.turnLimit(seatCapConsecutive + 1, seatCapLimit) });
      if (capResult.opened) {
        // The gate only parks the turn. Watch until the input loop takes it; if it never does,
        // the confirm hook withdraws that pending turn and we stop instead of saying «continuing».
        if (deps.confirmSeatCapTurnStarted && capResult.turnId) {
          const turnId = capResult.turnId;
          armed = null;
          void deps.confirmSeatCapTurnStarted(turnId).then((started) => {
            if (started) {
              seatCapConsecutive += 1;
              log('tui', 'turn.auto-continue', { opened: true, reason: 'seat-cap', n: seatCapConsecutive, limit: seatCapLimit, turnId });
              return;
            }
            log('tui', 'turn.auto-continue', { rejected: true, reason: 'seat-cap-not-started', n: seatCapConsecutive, turnId });
            deps.notify?.('⏸ 멈춤 · Enter 로 계속');
          }).catch(() => { /* fail-soft: a thrown watch must not re-arm */ });
          return { opened: true, reason: 'seat-cap-pending' };
        }
        armed = null;
        seatCapConsecutive += 1;
        log('tui', 'turn.auto-continue', { opened: true, reason: 'seat-cap', n: seatCapConsecutive, limit: seatCapLimit, turnId: capResult.turnId });
        return { opened: true, reason: 'seat-cap' };
      }
      handleRejected(capResult);
      return { opened: false, reason: capResult.reason };
    }
    // 초기화는 실제 사람 턴(noteHumanTurn)에서만 — 키만 치고 안 보낸 것으로 상한을 우회하지 못한다(r2 must-fix).
    if (openedFingerprints.has(fingerprint)) {
      armed = null;
      log('tui.goal-continue', 'decided', { rejected: true, reason: 'same-reply', tail, consecutive });
      if (mode === 'remaining') {
        log('tui.proactive', 'stop-no-progress', { reason: 'same-remaining', remainingDigest: fingerprint, autoTurn: consecutive });
        return { opened: false, reason: 'no-progress' };
      }
      return { opened: false, reason: 'same-reply' };
    }
    if (consecutive >= cap) {
      armed = null;
      if (!capNotified) {
        capNotified = true;
        log('tui.goal-continue', 'cap', { cap, tail });
        deps.notify?.(`⏸ 골 이어가기 상한(${cap}회 연속) — 사람 확인 필요 · 키 하나면 다시 이어간다`);
      }
      log('tui.goal-continue', 'decided', { rejected: true, reason: 'cap', tail, consecutive });
      log('tui.proactive', 'stop-cap', { reason: mode === 'remaining' ? 'work-remaining' : 'pledge', remainingDigest: fingerprint, autoTurn: consecutive, cap });
      return { opened: false, reason: 'cap' };
    }
    const result = deps.startTurnIfIdle(formatGoalContinuePrompt(phrase), { origin: 'goal-continue', reason: mode === 'remaining' ? CONTINUE_REASON.remainingPlan : CONTINUE_REASON.nextStep });
    if (result.opened) {
      armed = null;
      turnRunningStreak = 0;
      consecutive += 1;
      openedFingerprints.add(fingerprint);
      log('tui.goal-continue', 'decided', { opened: true, reason: 'pledge-without-result', phrase, tail, consecutive, turnId: result.turnId });
      log('tui', 'turn.auto-continue', { opened: true, reason: mode === 'remaining' ? 'remaining-work' : 'declared-next-step', n: consecutive, limit: cap, turnId: result.turnId });
      log('tui.proactive', 'continue', { reason: mode === 'remaining' ? 'work-remaining' : 'pledge-without-result', remainingDigest: fingerprint, autoTurn: consecutive, turnId: result.turnId });
      return { opened: true, reason: 'pledge-without-result' };
    }
    log('tui.goal-continue', 'decided', { rejected: true, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}), tail, consecutive });
    // 사람이 막 쳤거나(조용창) 아직 안 비켰다 — 무장은 남기고 조금 뒤 다시 잰다(그 사이 사람 턴이면 noteHumanTurn 이 푼다).
    handleRejected(result);
    return { opened: false, reason: result.reason };
  };

  const armLegacy = (end: GoalContinueTurnEnd, tail: string | null): void => {
      if (end.stopReason === 'max_turns') {
        // Seat cap exhausted: continue unless the reply names something only a person can give.
        const capVerdict = classifyReplyTail(tail);
        if (tail && (HUMAN_ACTION.test(tail) || (!capVerdict.pledge && capVerdict.reason === 'asks-human'))) {
          log('tui', 'turn.auto-continue', { rejected: true, reason: 'blocked-needs-person', tail: tail.slice(-80) });
          return;
        }
        armed = { tail: tail ?? '', phrase: 'seat turn cap', fingerprint: goalContinueFingerprint(tail ?? 'seat-cap'), mode: 'seat-cap' };
        return;
      }
      const verdict = classifyReplyTail(tail);
      const remaining = remainingWorkTail(tail);
      if (tail && HUMAN_ACTION.test(tail)) {
        log('tui.goal-continue', 'skipped', { reason: 'asks-human', tail: tail.slice(-80) });
        log('tui.proactive', 'stop-human', { reason: 'human-action', remainingDigest: goalContinueFingerprint(tail), autoTurn: consecutive });
        return;
      }
      if (!verdict.pledge && !remaining) {
        // 평범한 끝(질문·결과 보고)은 관측만 — 대부분의 턴이 여기다.
        log('tui.goal-continue', 'skipped', { reason: verdict.reason, ...(tail ? { tail: tail.slice(-80) } : {}) });
        return;
      }
      const phrase = remaining ?? (verdict.pledge ? verdict.phrase : '');
      armed = { tail: tail!, phrase, fingerprint: goalContinueFingerprint(remaining ?? tail!), mode: remaining ? 'remaining' : 'pledge' };
  };

  return {
    noteTurnEnded(end) {
      armed = null;
      turnRunningStreak = 0;
      if (completedGoal) return;
      if (!isEnabled()) return;
      if (end.failed) {
        log('tui.goal-continue', 'decided', { rejected: true, reason: 'turn-failed' });
        return;
      }
      const tail = replyTailFromLines(end.lines);
      const planOutcome = outcomeOfPlanWire(end.plan);
      if (planOutcome.kind !== 'gap') {
        // The plan state is the verdict — the wording of the reply is only compared against it (shadow).
        const legacy = classifyReplyTail(tail);
        compareTurnOutcome({
          seat: deps.seat ?? 'UNKNOWN', turnId: end.turnId ?? '',
          extractedPatterns: legacy.pledge || remainingWorkTail(tail) ? ['declared-next-step'] : [],
          plan: { items: (end.plan?.steps ?? []).map((step, index) => ({ id: `s${index}`, status: step.status === 'completed' ? 'done' as const : step.status })) },
        }, { emit: log });
        if (planOutcome.kind === 'continue') {
          armed = { tail: tail ?? '', phrase: 'plan open', fingerprint: goalContinueFingerprint(planOutcome.step), mode: 'plan' };
          return;
        }
        planConsecutive = 0;
        log('tui', 'turn.plan-outcome', { kind: planOutcome.kind, ...(planOutcome.kind === 'blocked' ? { reasonChars: planOutcome.reason.length } : {}) });
        if (planOutcome.kind === 'blocked') {
          deps.notify?.(`⏸ Blocked: ${planOutcome.reason || planOutcome.step} — a person is needed · any key resumes`);
          blockedFor(planOutcome.code ?? 'HUMAN_DECISION', 'plan-blocked');
        }
        else if (planOutcome.kind === 'waiting') deps.notify?.(`⏳ Waiting for ${planOutcome.wake.kind} ${planOutcome.wake.target}`);
        try { if (end.plan) deps.onPlanOutcome?.(planOutcome, end.plan); } catch { /* the host's reaction cannot break a turn end */ }
        return;
      }
      armLegacy(end, tail);
      // No structure: ask for the plan state once before falling back to wording — but only when the old rules would have continued anyway.
      const armedByLegacy = armed as Armed | null; // armLegacy assigns it; TypeScript cannot see through the call
      if (deps.planNudge === true && armedByLegacy && !planNudged) armed = { ...armedByLegacy, mode: 'plan-nudge' };
    },
    noteGoalCompleted() {
      completedGoal = true;
      armed = null;
    },
    check,
    noteHumanTurn() {
      completedGoal = false;
      armed = null;
      consecutive = 0;
      seatCapConsecutive = 0;
      planConsecutive = 0;
      planNudged = false;
      openedFingerprints.clear();
      capNotified = false;
    },
    wrapPort(port) {
      return {
        attach(requestYield) {
          port.attach(requestYield);
          if (armed) defer(() => { try { check(); } catch { /* fail-soft */ } }, 0);
        },
        detach(opts) { port.detach(opts); },
        declined(detail) { port.declined?.(detail); },
      };
    },
  };
}
