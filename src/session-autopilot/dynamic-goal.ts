// AUTOPILOT-DYNAMIC-GOAL-FEED (CEO 11-25) — goals are not spammed: only important things become a goal, in three tiers.
//
// S: autopilot's goal was whatever the last autopilot_set({goal}) said — any mail or request could re-aim it, and the
//    goal never reached the model as one stable line.
// C: the person wants exactly three tiers: (1) STANDING goal — one per seat, day-scale (coordinator: the release
//    cycle); (2) FIRST-CLASS goal — only from a crown directive (seat mail carrying a `crownDirective` id), a person's
//    directive (autopilot_set goal in a human turn · /autopilot on <goal>) or a «war» arousal state — it overrides the
//    standing goal while open and the standing goal returns when it closes; (3) everything else is NOT a goal (it goes
//    to the commitments ledger / checklist). Ordinary mail and requests never change the goal.
// A: pure helpers here (classification from structured fields only — never the body · derivation · the one fixed-id
//    feed block); the controller (autopilot.ts) keeps the open first-class stack in its state file and logs
//    `autopilot.goal-derived {tier, source, goal}` only when the effective goal actually changes.
//
// 세 얼굴:
//   관측 = debug.log('autopilot', 'goal-derived' | 'goal-derived-held' | 'goal-refused', {tier, source, goal})
//   인지 = deriveEffectiveGoal(): open first-class (latest) > standing · sameDerived() = change detection
//   수복과 인계 = a closed first-class id is remembered (a re-delivered crown mail never re-opens it) · explicit hold
//                 defers applying (applied on resume) · the feed block replaces itself (never stacks)

import { FEDERATION_WORK_ORDER_NOTE, SEAT_MAIL_DATA_NOTE } from '../chat/interjection.js';

export type GoalTier = 'first-class' | 'standing';
export type FirstClassSource = 'crown' | 'human' | 'war';

/** `done` = the done criterion (one judgment line) — required when a person's goal is set through autopilot_set. */
export interface FirstClassGoal { id: string; source: FirstClassSource; text: string; at: number; done?: string;
  /** GOAL-DRIVE-NARROW — set as a task goal (`goal set --task` → ref `goal:task`). Absent = standing (no goal drive). */
  task?: boolean;
  /** DIRECTIVE-EXPIRY — epoch ms the carrying mail lapses; the goal closes (dropped · expired) then. */
  expiresAt?: number }
/** GOAL-DRIVE-NARROW — the ref a `goal set --task` mail carries. */
export const GOAL_TASK_REF = 'goal:task';
export interface DerivedGoal { tier: GoalTier; source: string; goal: string; done?: string }

/** The fixed id of the one goal block at the head of the turn input. */
export const GOAL_FEED_ID = 'autopilot-goal-feed';
export const GOAL_FEED_MARK = `<!-- ${GOAL_FEED_ID} -->`;
/** How many closed first-class ids are remembered (re-delivery guard). */
export const CLOSED_FIRST_CLASS_KEEP = 50;
const GOAL_TEXT_MAX = 80;

/** The structured mail fields read here (the body only supplies the goal TEXT, never the decision). */
export interface GoalMailSignal {
  msgId?: number; crownDirective?: string | null; text?: string; body?: string;
  /** AUTOPILOT-GOAL-CLEARING — structured ledger fields: sender · reply chain · refs (`goal-done:<ref>` · `goal:replace`) ·
   *  the request contract (doneWhen + deadlineAt — the crown→pin bar) · arrival time. */
  sender?: string; replyTo?: number; refs?: readonly string[]; doneWhen?: string; deadlineAt?: string; createdAt?: string;
  /** CROWN-GOAL-APPLY — the structured goal field (`msg post --goal`) — applied by the controller, never parsed from the body. */
  goal?: string;
  /** DIRECTIVE-EXPIRY (Q5) — the mail's structured expiry (ISO) and the earlier mail it retracts (`supersedes`). */
  expiresAt?: string;
  supersedes?: number;
}

const clip = (text: string): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return Array.from(t).length > GOAL_TEXT_MAX ? `${Array.from(t).slice(0, GOAL_TEXT_MAX - 1).join('')}…` : t;
};

/** Lead notes a notice puts in front of a mail body (#40017 trusted-sender note · untrusted-data note). */
const FRAME_LEAD_NOTES: readonly string[] = [FEDERATION_WORK_ORDER_NOTE, SEAT_MAIL_DATA_NOTE];

/** A lead note, whole or clipped (a goal stored before #40021 holds the note cut at 80 chars with «…»). */
function isLeadNote(line: string): boolean {
  const cut = line.replace(/…$/u, '').trim();
  return Array.from(cut).length >= 12 && FRAME_LEAD_NOTES.some((note) => note.startsWith(cut));
}

/**
 * Notice fallback: the body starts after the `msg:<id> · ` marker — everything before it (the trusted-sender lead
 * note, the `<federation_work_order …>` frame, the `[from …]` header) is framing.
 */
function noticeBody(text: string): string | null {
  const marker = /(?:^|\n)msg:\d+\s*·\s*/u.exec(text);
  if (!marker) return null;
  const rest = text.slice(marker.index + marker[0].length);
  const close = rest.search(/\n<\/(?:federation_work_order|seat_mail_untrusted)>/u);
  return close >= 0 ? rest.slice(0, close) : rest.replace(/\n\n\[미읽음 총 \d+통\]\s*$/u, '');
}

/**
 * AUTOPILOT-HUMAN-GOAL — the ONE goal-text sanitizer for every source (crown mail · trusted-mail notice · a person's
 * line · a goal text already stored): the first meaningful line with every frame removed — lead notes (whole or
 * clipped), frame/markup tag lines (`<federation_work_order …>`, `<seat_mail_untrusted …>`, `<!-- … -->`), pure
 * header lines (`[from OPC · request]`) and leading bracket tags (`[지시]`, `[TG-OP …]`). Clipped to one chip line.
 */
export function sanitizeGoalText(text: string): string {
  const source = noticeBody(text) ?? text;
  for (const raw of source.split('\n')) {
    let line = raw.trim();
    if (!line || isLeadNote(line) || /^<[^>]*>$/u.test(line)) continue;
    line = line.replace(/^msg:\d+\s*·\s*/u, '');
    while (/^\[[^\]\n]*\]/u.test(line)) line = line.replace(/^\[[^\]\n]*\]\s*/u, '');
    if (line && !isLeadNote(line)) return clip(line);
  }
  return '';
}

/**
 * Tier 2 from a seat mail: ONLY a non-empty `crownDirective` id opens a first-class goal. Intent, sender, priority,
 * alert and body never do — ordinary mail and requests stay tier 3 (not a goal).
 */
export function firstClassFromMail(m: GoalMailSignal, at: number): FirstClassGoal | null {
  const crown = typeof m.crownDirective === 'string' ? m.crownDirective.trim() : '';
  if (!crown) return null;
  // DIRECTIVE-EXPIRY — a directive that lapsed before it arrived opens nothing; a live one carries its expiry.
  const expiresAt = m.expiresAt ? Date.parse(m.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= at) return null;
  // The goal text comes from the mail BODY (the notice only as a fallback) — through the one sanitizer.
  const headline = sanitizeGoalText(m.body ?? '') || sanitizeGoalText(m.text ?? '');
  return { id: `crown:${crown}`, source: 'crown', text: headline ? `[지시] ${headline}` : `[지시] ${crown}`, at,
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}) };
}

/** The goal text a stored first-class entry shows (re-sanitized: a goal stored by an older build loses its frame). */
export function firstClassText(g: FirstClassGoal): string {
  if (g.source === 'crown') return `[지시] ${sanitizeGoalText(g.text) || g.id.replace(/^crown:/u, '')}`;
  return sanitizeGoalText(g.text) || g.text;
}

/** Open first-class (the latest opened wins) > standing. Null = no goal derivable (leave the state's goal alone). */
export function deriveEffectiveGoal(firstClass: readonly FirstClassGoal[] | undefined, standing: string | undefined, standingDone?: string): DerivedGoal | null {
  const open = firstClass?.at(-1);
  if (open) return { tier: 'first-class', source: open.source === 'crown' ? open.id : open.source, goal: firstClassText(open), ...(open.done?.trim() ? { done: open.done.trim() } : {}) };
  if (standing?.trim()) return { tier: 'standing', source: 'standing', goal: standing.trim(), ...(standingDone?.trim() ? { done: standingDone.trim() } : {}) };
  return null;
}

export const sameDerived = (a: DerivedGoal | null | undefined, b: DerivedGoal | null | undefined): boolean =>
  (a ?? null) === (b ?? null) || (!!a && !!b && a.tier === b.tier && a.source === b.source && a.goal === b.goal && (a.done ?? '') === (b.done ?? ''));

/** The one goal block («🎯 지금 골: …») — fixed id, so re-feeding the same goal yields the same bytes. */
export function goalFeedBlock(d: DerivedGoal | null | undefined): string | null {
  if (!d) return null;
  return `${GOAL_FEED_MARK}\n🎯 지금 골: ${d.goal} (${d.tier === 'first-class' ? '1급 골' : '상시 골'} · ${d.source})\n`
    + (d.done ? `완료 기준: ${d.done}\n` : '')
    + '보통 우편·요청은 골을 바꾸지 않는다 — 약속 원장·체크리스트에 적고 이 골을 향해 간다.';
}

/** Put the goal block at the head of the turn input: any earlier block with the fixed id is replaced, never stacked. */
export function withGoalFeed(blocks: readonly string[], block: string | null): string[] {
  const rest = blocks.filter((b) => !b.startsWith(GOAL_FEED_MARK));
  return block ? [block, ...rest] : rest;
}
