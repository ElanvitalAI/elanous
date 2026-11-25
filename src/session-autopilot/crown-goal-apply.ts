// CROWN-GOAL-APPLY (OP 11-25) — a seat's autopilot goal is set by the SYSTEM, not by the model obeying mail text.
//
// S: crown-directive mails at 11:0x / 11:3x told the eln OP seat to change its goal to «착지 10/시간»; the chip kept the
//    stale, finished «[지시] 오전 결과 전체를 한 장으로». A crown mail without `goal:replace` only becomes a pin when it
//    meets the bar, else it is rejected as `crown-below-bar` — and the model never re-aimed the goal itself.
// C: the sender must be able to set the goal structurally, and the receiving TUI must apply it with no model in the loop.
// Q: how does a goal travel without parsing body words (no regex grounding)?
// A: a structured `goal` field on the mail (`msg post --goal "<text>"`, or `autopilot goal set --seat <SEAT> "<goal>"`).
//    The receiving TUI's autopilot controller applies it (same state file autopilot_set writes): every open first-class
//    goal is superseded, the chip shows the new goal, `autopilot goal-applied {source, msgId}` is logged and one line
//    lands in the transcript.
// GOAL-SET-COORD-BY-OP (OP 11-25 13:1x) — who may set a goal follows the federation hierarchy (federation.yaml ⊕ els
//    journal ladder, not a hardcoded list): OP / CLAUDE-OP (and the declared HQ) → any seat; a space coordinator → the
//    hands of its own space (any seat below it on the ladder); a crown-directive mail → any seat. A refusal names its reason.
//    (The 13:15 «applied:false» on TC/UX/JUD/RES/REL/MK was NOT a sender refusal: those seats are not role:coordinator
//    in coord-tracks.json, so their autopilot was never ON and the goal sat in firstClass without becoming the chip —
//    a goal from a setter now switches a never-switched autopilot ON; an explicit human off / hold is kept, with a reason.)
//
// 세 얼굴:
//   관측 = debug.log('autopilot', 'goal-applied' | 'goal-apply-refused', {source, msgId, goal})
//   인지 = goalApplyFromMail(): structured field + sender/crown check only (the body is never read)
//   수복과 인계 = a re-delivered goal mail never re-opens (closed ids) · a refused setter is logged, never silently dropped

import type { MessageEnvelope } from '../msg/msg-store.js';

/** Seats allowed to set ANY seat's autopilot goal (a crown-directive id also qualifies any sender; a coordinator may set its own hands'). */
export const GOAL_SETTER_SEATS: readonly string[] = ['OP', 'CLAUDE-OP'];

/** The federation ladder slice the policy reads (hand-raise-ladder FederationLadder satisfies it). */
export interface GoalLadder { readonly hq?: string; parentOf(seat: string): string }
export type GoalLadderSource = GoalLadder | (() => GoalLadder | null) | null | undefined;

export type GoalRefuseReason = 'no-sender' | 'sender-not-allowed' | 'not-above-target';
export type GoalSetterVerdict =
  | { ok: true; by: 'hq' | 'crown' | 'coordinator' }
  | { ok: false; reason: GoalRefuseReason; detail: string };

const LADDER_MAX_STEPS = 8;
const upper = (s: string | null | undefined): string => (s ?? '').trim().toUpperCase();

/**
 * May `sender` set the goal of `seat`? OP / CLAUDE-OP / the ladder's HQ → any seat · a crown-directive id → any seat ·
 * otherwise the sender must be above the seat on the federation ladder (a space coordinator over its hands).
 * The ladder is read only when the first two rules do not already decide (a function source is called lazily).
 */
export function goalSetterVerdict(input: { sender?: string | null; seat?: string | null; crownDirective?: string | null; ladder?: GoalLadderSource }): GoalSetterVerdict {
  const sender = upper(input.sender);
  if (!sender) return { ok: false, reason: 'no-sender', detail: 'the mail names no sender' };
  if (GOAL_SETTER_SEATS.includes(sender)) return { ok: true, by: 'hq' };
  if (typeof input.crownDirective === 'string' && input.crownDirective.trim() !== '') return { ok: true, by: 'crown' };
  let ladder: GoalLadder | null = null;
  try { ladder = typeof input.ladder === 'function' ? input.ladder() : input.ladder ?? null; } catch { ladder = null; }
  if (ladder?.hq && upper(ladder.hq) === sender) return { ok: true, by: 'hq' };
  const seat = upper(input.seat);
  if (!ladder || !seat) return { ok: false, reason: 'sender-not-allowed', detail: `${sender} is not ${GOAL_SETTER_SEATS.join(' / ')} and no federation ladder places it above ${seat || 'the seat'}` };
  let cur = seat;
  for (let i = 0; i < LADDER_MAX_STEPS; i += 1) {
    const parent = upper(ladder.parentOf(cur));
    if (!parent || parent === cur) break;
    if (parent === sender) return { ok: true, by: 'coordinator' };
    cur = parent;
  }
  return { ok: false, reason: 'not-above-target', detail: `${sender} is not above ${seat} on the federation ladder (parent of ${seat} = ${upper(ladder.parentOf(seat))})` };
}

/** Max goal length kept (one chip line is clipped further by the chip itself). */
export const GOAL_FIELD_MAX = 300;

export interface GoalApplySignal {
  readonly msgId?: number;
  readonly sender?: string;
  readonly goal?: string | null;
  readonly crownDirective?: string | null;
  /** DIRECTIVE-EXPIRY (Q5) — the mail's structured expiry (ISO). */
  readonly expiresAt?: string | null;
}

export type GoalApplyDecision =
  | { kind: 'none' }
  | { kind: 'expired'; goal: string; sender: string; expiresAt: string }
  | { kind: 'refused'; reason: GoalRefuseReason; detail: string; sender: string; goal: string }
  | { kind: 'apply'; goal: string; source: string; id: string; crown: boolean; by: string };

const normalizeGoal = (goal: string): string => {
  const one = goal.replace(/\s+/g, ' ').trim();
  return Array.from(one).length > GOAL_FIELD_MAX ? Array.from(one).slice(0, GOAL_FIELD_MAX).join('') : one;
};

/** May `sender` set a goal (directly, because the mail carries a crown-directive id, or — given the seat and the ladder — as its coordinator)? */
export function maySetGoal(sender: string | undefined, crownDirective?: string | null, seat?: string | null, ladder?: GoalLadderSource): boolean {
  return goalSetterVerdict({ sender: sender ?? null, crownDirective: crownDirective ?? null, seat: seat ?? null, ladder }).ok;
}

/** The one refusal message the CLIs print. */
export const goalSetterRefusal = (v: Extract<GoalSetterVerdict, { ok: false }>): string =>
  `${v.detail} — only ${GOAL_SETTER_SEATS.join(' / ')} (any seat), a space coordinator (its own hands) or --crown-directive <id> may set a seat goal`;

/** The decision for one mail — structured fields only. `none` = this mail sets no goal. `seat` = the receiving seat. */
export function goalApplyFromMail(m: GoalApplySignal, at: number, ctx: { seat?: string | null; ladder?: GoalLadderSource } = {}): GoalApplyDecision {
  const raw = typeof m.goal === 'string' ? normalizeGoal(m.goal) : '';
  if (!raw) return { kind: 'none' };
  const sender = (m.sender ?? '').trim().toUpperCase();
  // DIRECTIVE-EXPIRY — a goal mail that lapsed (or was retracted) before it was applied never sets the goal.
  if (m.expiresAt && Number.isFinite(Date.parse(m.expiresAt)) && Date.parse(m.expiresAt) <= at) return { kind: 'expired', goal: raw, sender, expiresAt: m.expiresAt };
  const verdict = goalSetterVerdict({ sender, seat: ctx.seat ?? null, crownDirective: m.crownDirective ?? null, ladder: ctx.ladder });
  if (!verdict.ok) return { kind: 'refused', reason: verdict.reason, detail: verdict.detail, sender, goal: raw };
  const crown = typeof m.crownDirective === 'string' && m.crownDirective.trim() !== '';
  return {
    kind: 'apply', goal: raw, crown, by: sender,
    source: crown ? `crown:${m.crownDirective!.trim()}` : `mail:${sender || 'unknown'}`,
    id: `goal:${typeof m.msgId === 'number' ? m.msgId : at}`,
  };
}

/** The one transcript line when a goal was applied. English UI text. */
export function goalAppliedLine(input: { goal: string; sender: string; msgId?: number; applied: boolean }): string {
  const by = `${input.sender || 'mail'}${typeof input.msgId === 'number' ? ` (msg #${input.msgId})` : ''}`;
  return input.applied ? `🎯 Goal set by ${by}: ${input.goal}` : `🎯 Goal set by ${by}: ${input.goal} — applies when autopilot is on`;
}

/** The mail `autopilot goal set` posts: a structured goal field; the body only tells a human reader what it is. */
export function goalSetEnvelope(input: { from: string; seat: string; goal: string; crownDirective?: string; ladder?: GoalLadderSource }): MessageEnvelope {
  const from = input.from.trim().toUpperCase();
  const to = input.seat.trim().toUpperCase();
  const goal = normalizeGoal(input.goal);
  if (!goal) throw new Error('goal must be nonempty');
  if (!to) throw new Error('--seat is required');
  const verdict = goalSetterVerdict({ sender: from, seat: to, crownDirective: input.crownDirective ?? null, ladder: input.ladder });
  if (!verdict.ok) throw new Error(goalSetterRefusal(verdict));
  return {
    from, to, intent: 'info', kind: 'goal', goal,
    body: `Autopilot goal set by ${from}: ${goal}`,
    ...(input.crownDirective?.trim() ? { crownDirective: input.crownDirective.trim() } : {}),
  };
}
