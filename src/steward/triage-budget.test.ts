import { expect, test } from 'bun:test';
import { triageInputHash, triageWithinBudget } from './triage-budget.js';
import type { TriageDecision, TriageIssue } from './triage.js';

const issues = Array.from({ length: 46 }, (_, n): TriageIssue => ({
  identifier: `ELA-${n}`, ref: `ref-${n}`, title: `Title ${n}`, body: `Body ${n}`,
}));
const decision = (issue: TriageIssue): TriageDecision => ({ issue: issue.identifier, rung: 4, dependsOn: [], priority: 2, why: 'reviewed' });

test('44 unchanged decisions reuse their input hash; only two changed issues are judged', async () => {
  const previous = issues.map(issue => ({ ...decision(issue), inputHash: triageInputHash(issue, issues) }));
  const changed = issues.map((issue, n) => n >= 44 ? { ...issue, body: `Changed ${n}` } : issue);
  const calls: string[] = [];
  const { decisions, stats } = await triageWithinBudget({ issues: changed, previous, judge: async issue => {
    calls.push(issue.identifier);
    return decision(issue);
  } });
  expect(calls).toEqual(['ELA-44', 'ELA-45']);
  expect(stats).toEqual({ reused: 44, judged: 2, timedOut: 0, deferred: 0 });
  expect(decisions.map((d, n) => d.inputHash === triageInputHash(changed[n]!, changed))).toEqual(issues.map(() => true));
  expect(triageInputHash({ ...issues[0]!, ref: 'new-ref' }, issues)).not.toBe(previous[0]!.inputHash);
  expect(triageInputHash({ ...issues[0]!, title: 'new title' }, issues)).not.toBe(previous[0]!.inputHash);
  expect(triageInputHash({ ...issues[0]!, identifier: 'ELA-new' }, issues)).not.toBe(previous[0]!.inputHash);
});

test('changing only the target ref rejudges a decision that may depend on its ref', async () => {
  const sample = issues.slice(0, 2);
  const previous = sample.map(issue => ({ ...decision(issue), inputHash: triageInputHash(issue, sample) }));
  const changed = [{ ...sample[0]!, ref: 'new-ref' }, sample[1]!];
  const calls: string[] = [];
  const { decisions, stats } = await triageWithinBudget({ issues: changed, previous, judge: async issue => {
    calls.push(issue.identifier);
    return { ...decision(issue), why: `reviewed ${issue.ref}` };
  } });
  expect(calls).toEqual(['ELA-0']);
  expect(decisions[0]?.why).toBe('reviewed new-ref');
  expect(stats).toEqual({ reused: 1, judged: 1, timedOut: 0, deferred: 0 });
});

test('a change to the prompt issue list or track table invalidates settled decisions', async () => {
  const sample = issues.slice(0, 2);
  const tracks = { O: 'tech' };
  const previous = sample.map(issue => ({ ...decision(issue), inputHash: triageInputHash(issue, sample, tracks) }));
  const changedList = [sample[0]!, { ...sample[1]!, title: 'new title' }];
  const calls: string[] = [];
  const listResult = await triageWithinBudget({ issues: changedList, previous, tracks, judge: async issue => {
    calls.push(issue.identifier);
    return decision(issue);
  } });
  expect(calls).toEqual(['ELA-0', 'ELA-1']);
  expect(listResult.stats.reused).toBe(0);
  calls.length = 0;
  const trackResult = await triageWithinBudget({ issues: sample, previous, tracks: { O: 'reassigned' }, judge: async issue => {
    calls.push(issue.identifier);
    return decision(issue);
  } });
  expect(calls).toEqual(['ELA-0', 'ELA-1']);
  expect(trackResult.stats.reused).toBe(0);
});

test('two changed titles in a 46-issue prompt invalidate all 46 cached judgments', async () => {
  const previous = issues.map(issue => ({ ...decision(issue), inputHash: triageInputHash(issue, issues) }));
  const changed = issues.map((issue, index) => index >= 44 ? { ...issue, title: `Renamed ${index}` } : issue);
  const called: string[] = [];
  const { stats } = await triageWithinBudget({ issues: changed, previous, judge: async issue => {
    called.push(issue.identifier);
    return decision(issue);
  } });
  expect(called).toHaveLength(46);
  expect(stats).toEqual({ reused: 0, judged: 46, timedOut: 0, deferred: 0 });
});

test('one hanging judgment times out without preventing other issues from finishing', async () => {
  const { decisions, stats } = await triageWithinBudget({ issues: issues.slice(0, 3), previous: [], perIssueMs: 10, deadlineMs: 200,
    judge: async issue => issue.identifier === 'ELA-0' ? new Promise<TriageDecision>(() => {}) : decision(issue) });
  expect(decisions.map(d => d.rung)).toEqual(['hitl', 4, 4]);
  expect(decisions[0]?.why).toBe('triage judgment timed out — human review');
  expect(stats).toEqual({ reused: 0, judged: 2, timedOut: 1, deferred: 0 });
});

test('deadline returns after active work times out and never starts queued work; deferred carries prior decision or HITL', async () => {
  let clock = 0;
  const calls: string[] = [];
  const previous = [{ ...decision(issues[1]!), inputHash: triageInputHash(issues[1]!) }];
  const changed = [issues[0]!, { ...issues[1]!, body: 'changed' }, issues[2]!];
  const { decisions, stats } = await triageWithinBudget({ issues: changed, previous, concurrency: 1, perIssueMs: 100, deadlineMs: 15,
    now: () => clock, judge: async issue => {
      calls.push(issue.identifier);
      clock = 20;
      return decision(issue);
    } });
  expect(calls).toEqual(['ELA-0']);
  expect(decisions[1]).toEqual({ ...previous[0], deferred: true });
  expect(decisions[2]?.why).toBe('triage deferred — deadline');
  expect(decisions[2]?.deferred).toBe(true);
  expect(stats).toEqual({ reused: 0, judged: 1, timedOut: 0, deferred: 2 });
  expect(decisions[1]?.inputHash).not.toBe(triageInputHash(changed[1]!));

  const started = Date.now();
  const hanging = await triageWithinBudget({ issues: changed, previous: [], concurrency: 1, deadlineMs: 15, perIssueMs: 1_000,
    judge: async () => new Promise<TriageDecision>(() => {}) });
  expect(Date.now() - started).toBeLessThan(250);
  expect(hanging.stats).toEqual({ reused: 0, judged: 0, timedOut: 1, deferred: 2 });
});

test('newly deferred HITL is signaled once while a carried decision is not re-emitted', async () => {
  const sample = issues.slice(0, 2);
  const previous = [{ ...decision(sample[0]!), inputHash: triageInputHash(sample[0]!, sample) }];
  const changed = [{ ...sample[0]!, body: 'new input' }, sample[1]!];
  const signaled: string[] = [];
  const result = await triageWithinBudget({ issues: changed, previous, deadlineMs: 0,
    judge: async () => { throw new Error('must not start'); }, onJudged: row => signaled.push(row.issue) });
  expect(result.decisions[0]).toEqual({ ...previous[0], deferred: true });
  expect(result.decisions[1]?.rung).toBe('hitl');
  expect(signaled).toEqual(['ELA-1']);
  const retryCalls: string[] = [];
  const retry = await triageWithinBudget({ issues: changed, previous: result.decisions,
    judge: async issue => { retryCalls.push(issue.identifier); return decision(issue); } });
  expect(retryCalls).toEqual(['ELA-0', 'ELA-1']);
  expect(retry.decisions.every(row => !row.deferred)).toBe(true);
});

test('deadline and per-issue fallback are retried on the next run, not cached as settled judgments', async () => {
  const first = await triageWithinBudget({ issues: issues.slice(0, 2), previous: [], concurrency: 1,
    perIssueMs: 5, deadlineMs: 6, judge: async () => new Promise<TriageDecision>(() => {}) });
  let calls = 0;
  const second = await triageWithinBudget({ issues: issues.slice(0, 2), previous: first.decisions,
    judge: async issue => { calls++; return decision(issue); } });
  expect(calls).toBe(2);
  expect(second.stats).toEqual({ reused: 0, judged: 2, timedOut: 0, deferred: 0 });
});

test('an unavailable judgment is retried after the judge recovers', async () => {
  const sample = issues.slice(0, 2);
  const first = await triageWithinBudget({ issues: sample, previous: [], judge: async issue => {
    if (issue.identifier === 'ELA-0') throw new Error('temporary outage');
    return decision(issue);
  } });
  expect(first.decisions[0]?.why).toBe('triage judgment unavailable — human review');
  const called: string[] = [];
  const second = await triageWithinBudget({ issues: sample, previous: first.decisions, judge: async issue => {
    called.push(issue.identifier);
    return decision(issue);
  } });
  expect(called).toEqual(['ELA-0']);
  expect(second.stats).toEqual({ reused: 1, judged: 1, timedOut: 0, deferred: 0 });
});

test('deadline retains the previous temporary HITL when no new judgment can start', async () => {
  const sample = [issues[0]!];
  const prior = { issue: sample[0]!.identifier, rung: 'hitl' as const, hitlReason: 'other' as const,
    dependsOn: [], priority: 0, why: 'triage judgment unavailable — human review',
    inputHash: triageInputHash(sample[0]!, sample) };
  let calls = 0;
  const deferred = await triageWithinBudget({ issues: sample, previous: [prior], deadlineMs: 0,
    judge: async issue => { calls++; return decision(issue); } });
  expect(calls).toBe(0);
  expect(deferred.decisions).toEqual([{ ...prior, deferred: true }]);
  expect(deferred.stats).toEqual({ reused: 0, judged: 0, timedOut: 0, deferred: 1 });
  const retry = await triageWithinBudget({ issues: sample, previous: deferred.decisions,
    judge: async issue => { calls++; return decision(issue); } });
  expect(calls).toBe(1);
  expect(retry.stats).toEqual({ reused: 0, judged: 1, timedOut: 0, deferred: 0 });
});

test('no judge starts when deadline expires before the first slot is claimed', async () => {
  let ticks = 0;
  let calls = 0;
  const result = await triageWithinBudget({ issues: issues.slice(0, 2), previous: [], deadlineMs: 10,
    now: () => ticks++ === 0 ? 0 : 10,
    judge: async issue => { calls++; return decision(issue); } });
  expect(calls).toBe(0);
  expect(result.stats).toEqual({ reused: 0, judged: 0, timedOut: 0, deferred: 2 });
});

test('legacy previous decisions without hashes are never treated as matching the current input', async () => {
  const old = decision(issues[0]!);
  const result = await triageWithinBudget({ issues: issues.slice(0, 2), previous: [old], deadlineMs: 0,
    judge: async () => { throw new Error('judge must not run'); } });
  expect(result.decisions[0]).toEqual({ ...old, inputHash: '', deferred: true });
  expect(result.stats).toEqual({ reused: 0, judged: 0, timedOut: 0, deferred: 2 });
});

test('deadline crossing after a slot is claimed still does not invoke judge', async () => {
  let ticks = 0;
  let calls = 0;
  const result = await triageWithinBudget({ issues: issues.slice(0, 1), previous: [], deadlineMs: 10,
    now: () => ++ticks < 3 ? 0 : 10,
    judge: async issue => { calls++; return decision(issue); } });
  expect(calls).toBe(0);
  expect(result.stats).toEqual({ reused: 0, judged: 0, timedOut: 0, deferred: 1 });
});

test('a synchronous judge error does not consume a concurrency slot', async () => {
  const result = await triageWithinBudget({ issues: issues.slice(0, 2), previous: [], concurrency: 1,
    judge: issue => issue.identifier === 'ELA-0' ? (() => { throw new Error('broken'); })() : Promise.resolve(decision(issue)) });
  expect(result.decisions.map(d => d.rung)).toEqual(['hitl', 4]);
  expect(result.stats).toEqual({ reused: 0, judged: 2, timedOut: 0, deferred: 0 });
});

test('a late-settling timed-out judge releases its slot for queued work before the deadline', async () => {
  const calls: string[] = [];
  const result = await triageWithinBudget({ issues: issues.slice(0, 2), previous: [], concurrency: 1,
    perIssueMs: 5, deadlineMs: 100, judge: async issue => {
      calls.push(issue.identifier);
      if (issue.identifier === 'ELA-0') await new Promise(resolve => setTimeout(resolve, 15));
      return decision(issue);
    } });
  expect(calls).toEqual(['ELA-0', 'ELA-1']);
  expect(result.stats).toEqual({ reused: 0, judged: 1, timedOut: 1, deferred: 0 });
  expect(result.decisions[0]?.why).toBe('triage judgment timed out — human review');
});

test('a timed-out but still running judge does not free a concurrency slot', async () => {
  let active = 0;
  let peak = 0;
  const { stats } = await triageWithinBudget({ issues: issues.slice(0, 3), previous: [], concurrency: 1,
    perIssueMs: 5, deadlineMs: 16, judge: async issue => {
      active++;
      peak = Math.max(peak, active);
      if (issue.identifier === 'ELA-0') return new Promise<TriageDecision>(() => {});
      active--;
      return decision(issue);
    } });
  expect(peak).toBe(1);
  expect(stats).toEqual({ reused: 0, judged: 0, timedOut: 1, deferred: 2 });
});

test('default budget allows eight simultaneous judgments and defers queued work at 240 seconds', async () => {
  let clock = 0;
  let active = 0;
  let peak = 0;
  const calls: string[] = [];
  const result = await triageWithinBudget({ issues: issues.slice(0, 9), previous: [], now: () => clock,
    judge: async item => {
      calls.push(item.identifier);
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      clock = 240_000;
      active--;
      return decision(item);
    } });
  expect(peak).toBe(8);
  expect(calls).toHaveLength(8);
  expect(result.stats).toEqual({ reused: 0, judged: 8, timedOut: 0, deferred: 1 });
});

test('active judgments never exceed concurrency and all decisions preserve input order', async () => {
  let active = 0;
  let peak = 0;
  const { decisions, stats } = await triageWithinBudget({ issues: issues.slice(0, 9), previous: [], concurrency: 3,
    judge: async issue => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return decision(issue);
    } });
  expect(peak).toBe(3);
  expect(decisions.map(d => d.issue)).toEqual(issues.slice(0, 9).map(i => i.identifier));
  expect(stats).toEqual({ reused: 0, judged: 9, timedOut: 0, deferred: 0 });
});
