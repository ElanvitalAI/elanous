import { createHash } from 'node:crypto';
import { debug } from '../debug/log.js';
import type { TriageDecision, TriageIssue } from './triage.js';

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
