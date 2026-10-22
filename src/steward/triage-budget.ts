import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import type { TriageDecision, TriageIssue } from './triage.js';
import { InvalidWorkingBackwardsDraft } from './working-backwards.js';

export interface HashedTriageDecision extends TriageDecision {
  inputHash: string;
  /** Other issues whose ref/body the judge read while producing this decision. */
  contextInputs?: string[];
  /** Retained from a previous run without a current judgment; never route as a fresh decision. */
  deferred?: true;
}

export function triageInputHash(issue: TriageIssue, issues: TriageIssue[] = [], tracks?: Record<string, string>, contextInputs: string[] = []): string {
  const byId = new Map(issues.map(item => [item.identifier, item]));
  return createHash('sha256').update(JSON.stringify([
    'context-inputs-v2', issue.identifier, issue.ref, issue.title, issue.body,
    issues.map(item => [item.identifier, item.title]), tracks && Object.keys(tracks).length ? tracks : null,
    contextInputs.map(id => [id, byId.get(id)?.ref ?? null, byId.get(id)?.body ?? null]),
  ])).digest('hex');
}

export async function triageWithinBudget({ issues, previous, judge, tracks, concurrency = 8, perIssueMs = 90_000, deadlineMs = 240_000, now = Date.now, onJudged }: {
  issues: TriageIssue[];
  previous: Array<TriageDecision & { inputHash?: string }>;
  judge: (issue: TriageIssue, observedIssues?: TriageIssue[]) => Promise<TriageDecision>;
  tracks?: Record<string, string>;
  concurrency?: number;
  perIssueMs?: number;
  deadlineMs?: number;
  now?: () => number;
  onJudged?: (decision: HashedTriageDecision) => void;
}): Promise<{ decisions: HashedTriageDecision[]; stats: { reused: number; judged: number; timedOut: number; deferred: number } }> {
  const end = now() + deadlineMs;
  const slots = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 4;
  const stats = { reused: 0, judged: 0, timedOut: 0, deferred: 0 };
  const old = new Map(previous.map(decision => [decision.issue, decision]));
  const isTemporary = (decision: TriageDecision): boolean =>
    decision.rung === 'hitl' && decision.hitlReason === 'other' &&
    ['triage deferred — deadline', 'triage judgment timed out — human review',
      'triage judgment unavailable — human review'].includes(decision.why);
  const decisions: HashedTriageDecision[] = new Array(issues.length);
  const pending: number[] = [];
  for (const [index, issue] of issues.entries()) {
    const earlier = old.get(issue.identifier) as HashedTriageDecision | undefined;
    const hash = triageInputHash(issue, issues, tracks, earlier?.contextInputs ?? []);
    if (earlier?.inputHash === hash && !earlier.deferred && !isTemporary(earlier)) {
      decisions[index] = { ...earlier, inputHash: hash };
      stats.reused++;
    } else pending.push(index);
  }

  let cursor = 0;
  const activeWork = new Set<Promise<TriageDecision>>();
  const settleSignals = new Set<Promise<boolean>>();
  const timedOut = Symbol('triage-timeout');
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const remaining = end - now();
      if (remaining <= 0) return;
      if (activeWork.size >= slots) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settled = Promise.race([...settleSignals]);
        let deadlineElapsed: boolean;
        try {
          deadlineElapsed = await Promise.race([settled, new Promise<true>(resolve => { timer = setTimeout(() => resolve(true), remaining); })]);
        } finally { if (timer) clearTimeout(timer); }
        if (deadlineElapsed) return;
        continue;
      }
      const index = pending[cursor++]!;
      const issue = issues[index]!;
      const observed = new Set<string>();
      const observedIssues = issues.map(item => new Proxy(item, {
        get(target, property, receiver) {
          if (item.identifier !== issue.identifier && (property === 'ref' || property === 'body')) observed.add(item.identifier);
          return Reflect.get(target, property, receiver);
        },
      }));
      // Check immediately before invoking; a clock that advanced while preparing inputs must not start a new call.
      const issueRemaining = end - now();
      if (issueRemaining <= 0) { cursor--; return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let decision: TriageDecision;
      try {
        const work = Promise.resolve(judge(issue, observedIssues));
        // Even a timed-out judge keeps its concurrency slot until the underlying call settles.
        activeWork.add(work);
        const settled = work.then(() => false, () => false);
        void settled.then(() => {
          activeWork.delete(work);
          settleSignals.delete(settled);
        });
        settleSignals.add(settled);
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timedOut), Math.min(perIssueMs, issueRemaining));
        });
        decision = await Promise.race([work, timeout]);
        stats.judged++;
      } catch (error) {
        if (error === timedOut) {
          stats.timedOut++;
          decision = { issue: issue.identifier, rung: 'hitl', hitlReason: 'other', dependsOn: [], priority: 0, why: 'triage judgment timed out — human review' };
        } else {
          stats.judged++;
          decision = { issue: issue.identifier, rung: 'hitl', hitlReason: 'other', dependsOn: [], priority: 0, why: 'triage judgment unavailable — human review' };
        }
      } finally { if (timer) clearTimeout(timer); }
      const contextInputs = [...observed].sort();
      decisions[index] = { ...decision, inputHash: triageInputHash(issue, issues, tracks, contextInputs),
        ...(contextInputs.length ? { contextInputs } : {}) };
      onJudged?.(decisions[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(slots, pending.length) }, () => worker()));
  for (const index of pending.slice(cursor)) {
    const issue = issues[index]!;
    const earlier = old.get(issue.identifier);
    decisions[index] = earlier
      ? { ...earlier, inputHash: earlier.inputHash ?? '', deferred: true }
      : { issue: issue.identifier, rung: 'hitl', hitlReason: 'other', dependsOn: [], priority: 0,
        why: 'triage deferred — deadline', inputHash: triageInputHash(issue, issues, tracks), deferred: true };
    if (!earlier) onJudged?.(decisions[index]!);
    stats.deferred++;
  }
  debug.log('steward.triage', 'budget', stats);
  return { decisions, stats };
}

export interface CarriedDraft<T> {
  wish: T;
  /** `deadline` = never started before the stage deadline; `timeout` = per-item or stage deadline hit mid-draft. */
  reason: 'timeout' | 'deadline' | 'error';
}

type DraftOutcome<T> = { kind: 'drafted' } | { kind: 'invalid' } | { kind: 'carried'; reason: CarriedDraft<T>['reason'] };

export async function draftWithinBudget<T>({ wishes, draft, concurrency = 4, perItemMs = 120_000, deadlineMs = 240_000, now = Date.now }: {
  wishes: T[];
  /** `expired` rejects once this item's own deadline passes; drafts should race their slow calls against it. */
  draft: (wish: T, expired: Promise<never>) => Promise<void>;
  concurrency?: number;
  perItemMs?: number;
  deadlineMs?: number;
  now?: () => number;
}): Promise<{ drafted: T[]; carried: Array<CarriedDraft<T>>; invalid: T[]; stats: { drafted: number; carried: number; invalid: number } }> {
  const end = now() + deadlineMs;
  const slots = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 4;
  const outcomes: Array<DraftOutcome<T> | undefined> = new Array(wishes.length);
  let stageTimer: ReturnType<typeof setTimeout> | undefined;
  const stageExpired = new Promise<void>(resolve => { stageTimer = setTimeout(resolve, Math.max(0, end - now())); });
  const timedOut = Symbol('draft-timeout');
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < wishes.length) {
      const remaining = end - now();
      if (remaining <= 0) return;
      const index = cursor++;
      let itemTimer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => { itemTimer = setTimeout(() => reject(timedOut), Math.min(perItemMs, remaining)); });
      // The draft may finish without ever racing this promise — never leave its rejection unhandled.
      expired.catch(() => undefined);
      const work = Promise.resolve().then(() => draft(wishes[index]!, expired));
      const settled = work.then(() => undefined, () => undefined);
      try {
        await Promise.race([work, expired]);
        outcomes[index] = { kind: 'drafted' };
      } catch (error) {
        outcomes[index] = error instanceof InvalidWorkingBackwardsDraft ? { kind: 'invalid' }
          : { kind: 'carried', reason: error === timedOut ? 'timeout' : 'error' };
        // A timed-out draft keeps its concurrency slot until the underlying call settles or the stage ends.
        await Promise.race([settled, stageExpired]);
      } finally { if (itemTimer) clearTimeout(itemTimer); }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(slots, wishes.length) }, () => worker()));
  } finally { if (stageTimer) clearTimeout(stageTimer); }
  const result = { drafted: [] as T[], carried: [] as Array<CarriedDraft<T>>, invalid: [] as T[] };
  for (const [index, wish] of wishes.entries()) {
    const outcome = outcomes[index];
    if (outcome?.kind === 'drafted') result.drafted.push(wish);
    else if (outcome?.kind === 'invalid') result.invalid.push(wish);
    else result.carried.push({ wish, reason: outcome?.kind === 'carried' ? outcome.reason : 'deadline' });
  }
  const stats = { drafted: result.drafted.length, carried: result.carried.length, invalid: result.invalid.length };
  debug.log('steward.triage', 'draft-budget', stats);
  return { ...result, stats };
}

/** Consecutive healthy shadow ticks before a live move is safe to record. */
export const LIVE_AFTER_TICKS = 3;

/** Reasons a decision is a placeholder, not a judgment — they must never be reused as if they were fresh. */
const TEMPORARY_WHYS = ['triage deferred — deadline', 'triage judgment timed out — human review',
  'triage judgment unavailable — human review'];

export function isTemporaryDecision(decision: TriageDecision): boolean {
  return decision.rung === 'hitl' && decision.hitlReason === 'other' && TEMPORARY_WHYS.includes(decision.why);
}

export interface TriageTickCycle {
  /** sha256 of this tick's sorted issue identifiers — the batch fingerprint. */
  key: string;
  /** Consecutive ticks (this one included) that carried the same fingerprint. */
  ticks: number;
}

export interface TriageTickBudget {
  cycle: TriageTickCycle;
  deadlineMs: number;
  perIssueMs: number;
  concurrency: number;
  /** `repeat-tick` when the same batch already arrived in the previous tick. */
  basis: 'first-tick' | 'repeat-tick';
}

export type TriageItemOutcome = 'reused' | 'judged' | 'timed-out' | 'unavailable' | 'deferred';

export interface TriageItemEvent {
  /** 1-based position of the issue in this tick's batch. */
  index: number;
  /** Which tick cycle the item was judged in. */
  cycle: number;
  issue: string;
  outcome: TriageItemOutcome;
  /** No fresh judgment backs this item — the next tick (or a human) must pick it up. */
  degraded: boolean;
  why: string;
}

export interface TriageItemMetrics {
  items: number;
  fresh: number;
  reused: number;
  degraded: number;
  byOutcome: Record<TriageItemOutcome, number>;
}

export interface TriageTickHealth {
  degraded: string[];
  /** Degraded last tick, freshly judged this tick. */
  healed: string[];
  health: 'healthy' | 'healing' | 'degraded';
  /** Consecutive non-degraded shadow ticks. */
  liveStreak: number;
  /** Shadow has stayed healthy long enough that a live move is safe; the mode itself is not flipped here. */
  liveEligible: boolean;
  transition?: 'shadow→live' | 'live→shadow';
}

export interface TriageTickRecord extends TriageTickHealth {
  at: string;
  mode: string;
  key: string;
  ticks: number;
  issues: number;
  deadlineMs: number;
  perIssueMs: number;
  concurrency: number;
  reused: number;
  judged: number;
  timedOut: number;
  deferred: number;
  events: TriageItemEvent[];
}

export function triageTickKey(issues: TriageIssue[]): string {
  return createHash('sha256').update(JSON.stringify(issues.map(issue => issue.identifier).sort())).digest('hex').slice(0, 16);
}

/** The tick cycle: a batch that keeps re-arriving is the same cycle, counted up; a changed batch starts at 1. */
export function triageTickCycle(previous: Pick<TriageTickRecord, 'key' | 'ticks'> | undefined, key: string): TriageTickCycle {
  const ticks = previous && previous.key === key && Number.isFinite(previous.ticks) ? Math.max(1, previous.ticks) + 1 : 1;
  return { key, ticks };
}

/**
 * Budget derived from the tick cycle: the stage deadline is fixed per tick, but a repeat cycle widens each issue's
 * slice (up to 3×) instead of re-running the same timeout on the batch that already ran out of window last tick.
 */
export function triageTickBudget({ cycle, issueCount, deadlineMs = 240_000, basePerIssueMs = 90_000, maxConcurrency = 8 }: {
  cycle: TriageTickCycle;
  issueCount: number;
  deadlineMs?: number;
  basePerIssueMs?: number;
  maxConcurrency?: number;
}): TriageTickBudget {
  const count = Math.max(1, Math.floor(issueCount));
  const concurrency = Math.max(1, Math.min(Math.max(1, Math.floor(maxConcurrency)), count));
  const stretch = Math.min(Math.max(1, Math.floor(cycle.ticks)), 3);
  return { cycle, deadlineMs, perIssueMs: Math.min(deadlineMs, basePerIssueMs * stretch), concurrency,
    basis: cycle.ticks > 1 ? 'repeat-tick' : 'first-tick' };
}

/** One event per item: what actually happened to it this tick and whether that leaves it degraded. */
export function triageItemEvents({ cycle, issues, decisions, previous = [] }: {
  cycle: TriageTickCycle;
  issues: TriageIssue[];
  decisions: Array<TriageDecision & { inputHash?: string; deferred?: true }>;
  previous?: Array<TriageDecision & { inputHash?: string }>;
}): TriageItemEvent[] {
  const judged = new Map(decisions.map(decision => [decision.issue, decision]));
  const earlier = new Map(previous.map(decision => [decision.issue, decision]));
  const events: TriageItemEvent[] = [];
  for (const [index, issue] of issues.entries()) {
    const decision = judged.get(issue.identifier);
    const before = earlier.get(issue.identifier);
    let outcome: TriageItemOutcome;
    if (!decision) outcome = 'unavailable';
    else if (decision.deferred === true) outcome = 'deferred';
    else if (decision.why === 'triage judgment timed out — human review') outcome = 'timed-out';
    else if (decision.why === 'triage judgment unavailable — human review') outcome = 'unavailable';
    else if (before && before.inputHash !== undefined && before.inputHash === decision.inputHash &&
      !before.deferred && !isTemporaryDecision(before)) outcome = 'reused';
    else outcome = 'judged';
    events.push({ index: index + 1, cycle: cycle.ticks, issue: issue.identifier, outcome,
      degraded: outcome !== 'judged' && outcome !== 'reused',
      why: decision?.why ?? 'triage decision missing' });
  }
  return events;
}

export function triageItemMetrics(events: TriageItemEvent[]): TriageItemMetrics {
  const byOutcome: Record<TriageItemOutcome, number> = { reused: 0, judged: 0, 'timed-out': 0, unavailable: 0, deferred: 0 };
  for (const event of events) byOutcome[event.outcome]++;
  const reused = byOutcome.reused;
  return { items: events.length, fresh: byOutcome.judged, reused,
    degraded: events.filter(event => event.degraded).length, byOutcome };
}

/** Healing and the shadow→live transition, read off the previous real tick — never off an assumed one. */
export function triageTickHealth({ previous, mode, events }: {
  previous?: Pick<TriageTickRecord, 'mode' | 'degraded' | 'liveStreak'>;
  mode: string;
  events: TriageItemEvent[];
}): TriageTickHealth {
  const degraded = events.filter(event => event.degraded).map(event => event.issue);
  const healed = (previous?.degraded ?? []).filter(issue => !degraded.includes(issue)).sort();
  const health = healed.length ? 'healing' : degraded.length ? 'degraded' : 'healthy';
  // Any degradation still present this tick resets the streak — a healed item next to a degraded one is not a healthy tick.
  const liveStreak = mode === 'shadow' ? (degraded.length ? 0 : (previous?.mode === 'shadow' ? previous.liveStreak + 1 : 1)) : 0;
  const transition = previous && previous.mode !== mode
    ? (mode === 'live' && previous.mode === 'shadow' ? 'shadow→live'
      : mode === 'shadow' && previous.mode === 'live' ? 'live→shadow' : undefined)
    : undefined;
  return { degraded, healed, health, liveStreak, liveEligible: mode === 'shadow' && liveStreak >= LIVE_AFTER_TICKS,
    ...(transition ? { transition } : {}) };
}

export function triageTickLedgerPath(root: string): string {
  return join(root, 'steward', 'triage-ticks.jsonl');
}

/** The real ticks that already ran, oldest first. A torn line is not a tick. */
export function readTriageTicks(root: string, limit = 24): TriageTickRecord[] {
  let text: string;
  try { text = readFileSync(triageTickLedgerPath(root), 'utf8'); } catch { return []; }
  const records: TriageTickRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof (parsed as { mode?: unknown }).mode === 'string' &&
        typeof (parsed as { key?: unknown }).key === 'string' && typeof (parsed as { ticks?: unknown }).ticks === 'number' &&
        Array.isArray((parsed as { degraded?: unknown }).degraded) && Array.isArray((parsed as { events?: unknown }).events)) {
        records.push(parsed as TriageTickRecord);
      }
    } catch { /* torn line */ }
  }
  return records.slice(-Math.max(1, limit));
}

export function appendTriageTick(root: string, record: TriageTickRecord): void {
  try {
    mkdirSync(join(root, 'steward'), { recursive: true });
    appendFileSync(triageTickLedgerPath(root), `${JSON.stringify(record)}\n`);
  } catch (error) {
    debug.log('steward.triage', 'tick-ledger-failed', { reason: String(error) }, { level: 'warn' });
  }
}
