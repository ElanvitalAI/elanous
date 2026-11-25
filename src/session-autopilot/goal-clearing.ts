// AUTOPILOT-GOAL-CLEARING (owner 11-25 «골 셋팅 이후 클리어링 전략이 안 되어 있는 것 같습니다» · «골 셋팅 쓰레숄드를 높여야
// 하고 탈출 전략도 다양하게 세워주세요. 중대 토큰 낭비 및 전략의 품질을 떨어뜨려 연방 전체가 위험해집니다»).
//
// S: a goal (first-class autopilot goal or task pin) was opened and then only closed when the seat itself remembered to
//    call goal_done. Incident 11-25: «0.3.36 로스터 재조정» stayed in the 🚗 chip 1h+ after another seat had finished the
//    roster; crown directives stacked on top; the seat spent turns on mail-reply follow-up promises.
// C: every goal needs an exit that does not depend on the seat's memory — and goals must be rarer (higher bar) so the
//    federation does not burn tokens on goal churn.
// A: this module holds the pure parts — the per-goal lifecycle record (`GoalLife`), the machine done checks, the archive
//    («🎯 history»), the acceptance bar and the escape triggers. The controller (autopilot.ts) owns the state file and
//    calls these on every tick / turn end / mail arrival.
//
// Lifecycle (one record per open goal):
//   open ── done_check true ──────────────► cleared (by:check)
//        ── goal-done mail / ref ─────────► cleared (by:mail)
//        ── goal_done tool ───────────────► cleared (by:tool · outcome done|partial|dropped)
//        ── deadline ─► one nudge ── +30m ─► expired (loss ledger)
//        ── replaced ─────────────────────► superseded (archived · 🎯 history)
//        ── escape (narrow · freeze · hand-off · break-loop · parallel)
//
// 세 얼굴:
//   관측 = autopilot.goal-cleared {by, goal, id, outcome} · goal-rejected {reason} · goal-escape {kind, goal, tokens, turns}
//          · goal-nudge-due · goal-expired · goal-extended
//   인지 = evaluateCheck() · acceptGoal() · stallDue() / burnDue() / loopSig() / blockedDue()
//   수복과 인계 = auto-clear · one due nudge · expire with a loss-ledger line · escapes rewrite the goal's shape (narrow
//                 deadline · pin · hand-off note + decision card · parked pin) instead of letting the seat spin

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type GoalKind = 'autopilot' | 'task';

/** A machine done check — evaluated cheaply on each autopilot tick (or on mail arrival for `mail`). */
export type DoneCheck =
  | { kind: 'file'; path: string; updated?: boolean }
  | { kind: 'checklist'; version: string; id?: string; status: string; min?: number }
  | { kind: 'pr-merged'; pr: number }
  | { kind: 'mail'; from: string };

export type EscapeKind = 'narrow' | 'freeze' | 'hand-off' | 'break-loop' | 'parallel';

/** The lifecycle record of one open goal (first-class or pin) — keyed by the goal's id. */
export interface GoalLife {
  id: string;
  kind: GoalKind;
  text: string;
  at: number;
  deadline: number;
  done?: string;
  check?: DoneCheck;
  /** Model's size estimate (the acceptance bar): expected turns · expected minutes. */
  estTurns?: number;
  estMinutes?: number;
  /** The one «past due» nudge was queued at. */
  nudgedAt?: number;
  turns: number;
  /** Turns since the last state-changing call. */
  idleTurns: number;
  tokens: number;
  lastProgressAt: number;
  /** Waiting on replies since (blocked-on-others escape). */
  waitingSince?: number;
  /** Parked by the «parallel» escape — wakes on the awaited reply. */
  parked?: boolean;
  /** Recent tool / mail-pair signatures (loop escape). */
  sigs?: string[];
  /** escape kind → when it last fired (each fires at most once per ESCAPE_COOLDOWN_MS per goal). */
  escapes?: Partial<Record<EscapeKind, number>>;
}

export type GoalOutcome = 'done' | 'partial' | 'dropped' | 'superseded' | 'expired' | 'parked';
export interface GoalArchive { id: string; kind: GoalKind; text: string; outcome: GoalOutcome; by: string; at: number; reason?: string; life?: GoalLife }

// ── thresholds (defaults in code — no flags) ───────────────────────────────────────────────────────────────────────
const MIN = 60_000;
/** A goal with no deadline given (crown mail without deadlineAt · /autopilot on <goal>) gets this one. */
export const GOAL_DEFAULT_DEADLINE_MS = 3 * 60 * MIN;
/** Past due → nudge at the deadline; no action by deadline + this → expired. */
export const GOAL_EXPIRE_GRACE_MS = 30 * MIN;
/** Acceptance bar: the model's estimate must be ≥ 3 turns or > 15 minutes. */
export const GOAL_MIN_TURNS = 3;
export const GOAL_MIN_MINUTES = 15;
/** Rate limits per seat: ≤ 1 new autopilot goal and ≤ 3 pin changes per 30 minutes. */
export const GOAL_RATE_WINDOW_MS = 30 * MIN;
export const AUTOPILOT_GOALS_PER_WINDOW = 1;
export const PIN_CHANGES_PER_WINDOW = 3;
/** Escapes. */
export const STALL_TURNS = 4;
export const STALL_MS = 20 * MIN;
export const NARROW_DEADLINE_MS = 30 * MIN;
export const THRASH_REPLACEMENTS = 2;
export const THRASH_WINDOW_MS = 30 * MIN;
export const FREEZE_MS = 30 * MIN;
export const GOAL_TOKEN_BUDGET = 300_000;
export const BURN_ESTIMATE_MULT = 2;
export const LOOP_REPEATS = 3;
export const LOOP_SIG_KEEP = 30;
export const BLOCKED_MS = 15 * MIN;
export const ESCAPE_COOLDOWN_MS = 30 * MIN;
/** How many archived goals are kept · how many the «🎯 history» line shows · how long it shows after the last loss. */
export const HISTORY_KEEP = 20;
export const HISTORY_SHOW = 3;
export const HISTORY_ROW_SHOW_MS = 60 * MIN;
/** A pr-merged / checklist check runs at most this often (each is a process or a sqlite read). */
export const SLOW_CHECK_EVERY_MS = 5 * MIN;

/** The ref a «goal done by another seat» mail carries (also accepted as the first token of the body). */
export const GOAL_DONE_REF = 'goal-done:';
/** The ref a crown mail carries when it explicitly replaces the standing autopilot goal. */
export const GOAL_REPLACE_REF = 'goal:replace';

// ── done checks ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * `done_check` from the tool: an object `{type|kind, …}` or a short string — `file:<path>` · `file-updated:<path>` ·
 * `pr:<n>` · `mail:<SEAT>` · `checklist:<version>:<status>>=<n>` · `checklist:<version>:<id>=<status>`. Null = invalid.
 */
export function parseDoneCheck(raw: unknown): DoneCheck | null {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const kind = String(r.kind ?? r.type ?? '');
    if ((kind === 'file' || kind === 'file-updated') && typeof r.path === 'string' && r.path.trim()) return { kind: 'file', path: r.path.trim(), ...(kind === 'file-updated' || r.updated === true ? { updated: true } : {}) };
    if (kind === 'pr-merged' || kind === 'pr') { const pr = Number(r.pr); return Number.isInteger(pr) && pr > 0 ? { kind: 'pr-merged', pr } : null; }
    if (kind === 'mail' && typeof r.from === 'string' && r.from.trim()) return { kind: 'mail', from: r.from.trim().toUpperCase() };
    if (kind === 'checklist' && typeof r.version === 'string' && typeof r.status === 'string') {
      const min = Number(r.min);
      return { kind: 'checklist', version: r.version.trim(), status: r.status.trim(), ...(typeof r.id === 'string' && r.id.trim() ? { id: r.id.trim() } : {}), ...(Number.isFinite(min) && min > 0 ? { min } : {}) };
    }
    return null;
  }
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  let m = /^file(-updated)?:(.+)$/u.exec(s);
  if (m) return { kind: 'file', path: m[2]!.trim(), ...(m[1] ? { updated: true } : {}) };
  m = /^pr(?:-merged)?:#?(\d+)$/u.exec(s);
  if (m) return { kind: 'pr-merged', pr: Number(m[1]) };
  m = /^mail:([A-Za-z0-9_-]+)$/u.exec(s);
  if (m) return { kind: 'mail', from: m[1]!.toUpperCase() };
  m = /^checklist:([^:]+):([^:=>]+)>=(\d+)$/u.exec(s);
  if (m) return { kind: 'checklist', version: m[1]!, status: m[2]!, min: Number(m[3]) };
  m = /^checklist:([^:]+):([^:=]+)=([^:=]+)$/u.exec(s);
  if (m) return { kind: 'checklist', version: m[1]!, id: m[2]!, status: m[3]! };
  return null;
}

export const describeCheck = (c: DoneCheck): string =>
  c.kind === 'file' ? `${c.updated ? 'file-updated' : 'file'}:${c.path}`
    : c.kind === 'pr-merged' ? `pr:${c.pr}`
      : c.kind === 'mail' ? `mail:${c.from}`
        : c.id ? `checklist:${c.version}:${c.id}=${c.status}` : `checklist:${c.version}:${c.status}>=${c.min ?? 1}`;

export function resolveCheckPath(path: string, root: string): string {
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : join(root, path);
}

/** File check: exists (and, for `updated`, modified at or after the goal was set). Pure fs stat — cheap. */
export function fileCheckTrue(check: Extract<DoneCheck, { kind: 'file' }>, goalAt: number, root: string): boolean {
  const p = resolveCheckPath(check.path, root);
  if (!existsSync(p)) return false;
  if (!check.updated) return true;
  try { return statSync(p).mtimeMs >= goalAt; } catch { return false; }
}

/** Checklist check over items `{id, status}` of one version. */
export function checklistCheckTrue(check: Extract<DoneCheck, { kind: 'checklist' }>, items: ReadonlyArray<{ id: string; status: string }>): boolean {
  if (check.id) return items.some((i) => i.id === check.id && i.status === check.status);
  return items.filter((i) => i.status === check.status).length >= (check.min ?? 1);
}

/** Mail check: a mail from the named seat arrived at or after the goal was set. */
export const mailCheckTrue = (check: DoneCheck | undefined, sender: string | undefined, arrivedAt: number, goalAt: number): boolean =>
  check?.kind === 'mail' && !!sender && sender.toUpperCase() === check.from && arrivedAt >= goalAt;

// ── «goal done» mail ──────────────────────────────────────────────────────────────────────────────────────────────
/** The goal refs a mail marks done: `goal-done:<ref>` in its refs, or as the first token of its body. */
export function goalDoneRefs(mail: { refs?: readonly string[] | null; body?: string | null }): string[] {
  const out = (mail.refs ?? []).filter((r) => r.startsWith(GOAL_DONE_REF)).map((r) => r.slice(GOAL_DONE_REF.length).trim()).filter(Boolean);
  const first = (mail.body ?? '').trimStart().split(/\s/u, 1)[0] ?? '';
  if (first.startsWith(GOAL_DONE_REF) && first.length > GOAL_DONE_REF.length) out.push(first.slice(GOAL_DONE_REF.length));
  return [...new Set(out)];
}

/** The goal a ref names: exact id · `current` (the active goal) · a ≥4-char piece of its text. */
export function matchGoalRef(ref: string, lives: readonly GoalLife[], activeId: string | undefined): GoalLife | undefined {
  const r = ref.trim();
  if (!r) return undefined;
  if (r === 'current') return lives.find((l) => l.id === activeId);
  const exact = lives.find((l) => l.id === r);
  if (exact) return exact;
  if (Array.from(r).length < 4) return undefined;
  const lower = r.toLowerCase();
  return lives.find((l) => l.text.toLowerCase().includes(lower));
}

/** The structured mail another seat posts to mark a seat's goal done (`eln seat goal-done`). */
export function goalDoneMail(input: { from: string; to: string; goalRef: string; reason: string }): { from: string; to: string; body: string; intent: 'info'; refs: string[] } {
  return { from: input.from, to: input.to, intent: 'info', refs: [`${GOAL_DONE_REF}${input.goalRef}`],
    body: `${GOAL_DONE_REF}${input.goalRef} — ${input.reason.trim() || 'done'}` };
}

// ── acceptance bar ────────────────────────────────────────────────────────────────────────────────────────────────
export interface GoalAsk { kind: GoalKind; doneCriterion?: string; deadline?: number | null; estTurns?: number; estMinutes?: number }
/** Null = accepted; otherwise the refusal reason (logged as `goal-rejected {reason}`). */
export function goalBarReason(ask: GoalAsk, history: { goalOpens?: readonly number[]; pinChanges?: readonly number[] }, now: number): string | null {
  if (!ask.doneCriterion?.trim()) return 'no-done-criterion';
  if (ask.deadline === undefined || ask.deadline === null) return 'no-deadline';
  const bigEnough = (ask.estTurns ?? 0) >= GOAL_MIN_TURNS || (ask.estMinutes ?? 0) > GOAL_MIN_MINUTES;
  if (!bigEnough) return 'too-small';
  const recent = (xs: readonly number[] | undefined): number => (xs ?? []).filter((at) => now - at < GOAL_RATE_WINDOW_MS).length;
  if (ask.kind === 'autopilot' && recent(history.goalOpens) >= AUTOPILOT_GOALS_PER_WINDOW) return 'rate-autopilot';
  if (ask.kind === 'task' && recent(history.pinChanges) >= PIN_CHANGES_PER_WINDOW) return 'rate-pin';
  return null;
}

/** The one refusal line per reason (model-facing). */
export const GOAL_REJECT_TEXT: Record<string, string> = {
  'no-done-criterion': '골에는 완료 기준(done_criterion · 한 줄 판정)이 필요하다',
  'no-deadline': '골에는 기한(deadline «HH:MM»·ISO)이 필요하다',
  'too-small': `골은 여러 턴 일만 — expected_turns ≥ ${GOAL_MIN_TURNS} 또는 expected_minutes > ${GOAL_MIN_MINUTES} 을 적는다. 상태 확인·답장·한 걸음 일은 그냥 이번 턴에 한다`,
  'rate-autopilot': `자율주행 골은 30분에 ${AUTOPILOT_GOALS_PER_WINDOW}개까지 — 지금 골을 끝내거나(goal_done) 30분 뒤에 바꾼다`,
  'rate-pin': `작업 골(핀) 변경은 30분에 ${PIN_CHANGES_PER_WINDOW}번까지 — 지금 핀부터 끝낸다`,
  'crown-below-bar': '대표 지시가 완료 기준·기한(15분 이상) 없이 와서 골이 아니라 보통 턴으로 처리한다',
};

/** A crown mail becomes a pin only with doneWhen + a deadline at least GOAL_MIN_MINUTES away (its size proxy). */
export function crownPinBar(m: { doneWhen?: string | null; deadlineAt?: string | null }, now: number): { done: string; deadline: number } | null {
  const done = m.doneWhen?.trim();
  const deadline = m.deadlineAt ? Date.parse(m.deadlineAt) : NaN;
  if (!done || !Number.isFinite(deadline) || deadline - now <= GOAL_MIN_MINUTES * MIN) return null;
  return { done, deadline };
}

// ── escapes ───────────────────────────────────────────────────────────────────────────────────────────────────────
const cooled = (life: GoalLife, kind: EscapeKind, now: number): boolean => {
  const last = life.escapes?.[kind];
  return last === undefined || now - last >= ESCAPE_COOLDOWN_MS;
};
/** Stall: ≥ STALL_TURNS turns without a state change, or ≥ STALL_MS since the last progress with at least one idle turn. */
export const stallDue = (life: GoalLife, now: number): boolean =>
  !life.parked && cooled(life, 'narrow', now) && (life.idleTurns >= STALL_TURNS || (life.idleTurns >= 1 && now - life.lastProgressAt >= STALL_MS));
/** Token burn: over the budget, or turns over 2× the estimate. */
export const burnDue = (life: GoalLife): boolean =>
  life.escapes?.['hand-off'] === undefined && (life.tokens > GOAL_TOKEN_BUDGET || (!!life.estTurns && life.turns > BURN_ESTIMATE_MULT * life.estTurns));
/** Loop: the signature repeated ≥ LOOP_REPEATS times among the goal's recent signatures (null = no loop). */
export function loopSig(life: GoalLife, now: number): string | null {
  if (!cooled(life, 'break-loop', now)) return null;
  const counts = new Map<string, number>();
  for (const s of life.sigs ?? []) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const [s, c] of counts) if (c >= LOOP_REPEATS) return s;
  return null;
}
/** Blocked: waiting on replies longer than BLOCKED_MS. */
export const blockedDue = (life: GoalLife, now: number): boolean =>
  !life.parked && life.waitingSince !== undefined && now - life.waitingSince > BLOCKED_MS;

/** A tool call's signature: name + its args (stable JSON, clipped). */
export function toolSig(name: string, args: unknown): string {
  let a = '';
  try { a = JSON.stringify(args ?? null) ?? ''; } catch { a = String(args); }
  return `${name}:${a.length > 200 ? a.slice(0, 200) : a}`;
}

// ── lines (English — UX surface) ──────────────────────────────────────────────────────────────────────────────────
const clock = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const clearedLine = (text: string, by: string): string => `✓ goal cleared: ${text} (done by ${by})`;
export const pastDueLine = (text: string): string => `⏰ goal past due: ${text} — close with partial result, extend with new deadline, or drop (reason)`;
export const expiredLine = (text: string): string => `⌛ goal expired: ${text} (no action 30 min past due)`;
export const supersededLine = (text: string, by: string): string => `🎯 goal superseded: ${text} → ${by}`;
export function escapeLine(kind: EscapeKind, goal: string, detail: { deadline?: number; note?: string; sig?: string; card?: string }): string {
  switch (kind) {
    case 'narrow': return `⤴ escape: narrow — «${goal}» stalled; shrink it to the next smallest deliverable and finish by ${clock(detail.deadline ?? 0)}`;
    case 'freeze': return `⤴ escape: freeze — goal replaced too often; «${goal}» stays, the others became pins; goal changes frozen until ${clock(detail.deadline ?? 0)}`;
    case 'hand-off': return `⤴ escape: hand off — «${goal}» burned its budget; handoff note ${detail.note ?? '(none)'}; delegate to a space coordinator/hand${detail.card ? ` or decide on card ${detail.card}` : ''}`;
    case 'break-loop': return `⤴ escape: break loop — «${goal}» repeats ${detail.sig ?? '(same action)'}; stop it, write a one-line diagnosis, try another path`;
    case 'parallel': return `⤴ escape: parallel — «${goal}» parked until the reply arrives; pull the next roster item`;
  }
}

const OUTCOME_WORD: Record<GoalOutcome, string> = { done: 'done', partial: 'partial', dropped: 'dropped', superseded: 'superseded', expired: 'expired', parked: 'parked' };
/** «🎯 history: A (superseded) · B (done by check) · C (expired)» — newest first, last HISTORY_SHOW. */
export function historyLine(history: readonly GoalArchive[] | undefined): string | null {
  const last = [...(history ?? [])].slice(-HISTORY_SHOW).reverse();
  if (!last.length) return null;
  const clip = (t: string): string => (Array.from(t).length > 28 ? `${Array.from(t).slice(0, 27).join('')}…` : t);
  return `🎯 history: ${last.map((h) => `${clip(h.text)} (${OUTCOME_WORD[h.outcome]}${h.outcome === 'done' ? ` by ${h.by}` : ''})`).join(' · ')}`;
}

/** The loss-ledger line (expired goals and escapes). */
export const lossLine = (at: number, what: string, life: Pick<GoalLife, 'id' | 'text' | 'tokens' | 'turns'>, reason: string): string =>
  `- ${new Date(at).toISOString()} · ${what} · ${life.text} · id=${life.id} · tokens=${life.tokens} · turns=${life.turns} · ${reason}`;
