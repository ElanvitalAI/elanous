import { expect, test } from 'bun:test';
import { draftWithinBudget, triageInputHash, triageWithinBudget } from './triage-budget.js';
import { InvalidWorkingBackwardsDraft } from './working-backwards.js';
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

test('ten never-finishing drafts resolve within the stage deadline and are all carried', async () => {
  const wishes = issues.slice(0, 10);
  const started = Date.now();
  const result = await draftWithinBudget({ wishes, concurrency: 4, perItemMs: 10_000, deadlineMs: 60,
    draft: () => new Promise<void>(() => undefined) });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(result.carried.map(item => item.wish.identifier)).toEqual(wishes.map(issue => issue.identifier));
  expect(result.drafted).toEqual([]);
  expect(result.invalid).toEqual([]);
  expect(result.stats).toEqual({ drafted: 0, carried: 10, invalid: 0 });
});

test('a draft that outlives perItemMs is carried while the others are drafted', async () => {
  const wishes = issues.slice(0, 3);
  // The stuck slot holds until the stage deadline — keep that deadline well inside the runner's 5s test timeout.
  const result = await draftWithinBudget({ wishes, perItemMs: 20, deadlineMs: 250,
    draft: wish => wish.identifier === 'ELA-1' ? new Promise<void>(() => undefined) : Promise.resolve() });
  expect(result.drafted.map(issue => issue.identifier)).toEqual(['ELA-0', 'ELA-2']);
  expect(result.carried.map(item => [item.wish.identifier, item.reason])).toEqual([['ELA-1', 'timeout']]);
});

test('active drafts never exceed concurrency', async () => {
  let active = 0;
  let peak = 0;
  const result = await draftWithinBudget({ wishes: issues.slice(0, 10), concurrency: 3,
    draft: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
    } });
  expect(peak).toBe(3);
  expect(result.stats).toEqual({ drafted: 10, carried: 0, invalid: 0 });
});

test('a timed-out draft keeps its concurrency slot until it settles', async () => {
  let active = 0;
  let peak = 0;
  const result = await draftWithinBudget({ wishes: issues.slice(0, 4), concurrency: 2, perItemMs: 10, deadlineMs: 5_000,
    draft: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 40));
      active--;
    } });
  expect(peak).toBe(2);
  expect(result.stats).toEqual({ drafted: 0, carried: 4, invalid: 0 });
});

test('an InvalidWorkingBackwardsDraft lands only in invalid', async () => {
  const result = await draftWithinBudget({ wishes: issues.slice(0, 3),
    draft: async wish => { if (wish.identifier === 'ELA-1') throw new InvalidWorkingBackwardsDraft(); } });
  expect(result.invalid.map(issue => issue.identifier)).toEqual(['ELA-1']);
  expect(result.drafted.map(issue => issue.identifier)).toEqual(['ELA-0', 'ELA-2']);
  expect(result.carried).toEqual([]);
});

test('a plain Error is carried without rejecting or becoming invalid', async () => {
  const result = await draftWithinBudget({ wishes: issues.slice(0, 2),
    draft: async wish => { if (wish.identifier === 'ELA-0') throw new Error('llm down'); } });
  expect(result.carried.map(item => [item.wish.identifier, item.reason])).toEqual([['ELA-0', 'error']]);
  expect(result.invalid).toEqual([]);
  expect(result.drafted.map(issue => issue.identifier)).toEqual(['ELA-1']);
});

import * as tickFs from 'node:fs';
import * as tickOs from 'node:os';
import * as tickPath from 'node:path';
import * as tickBudget from './triage-budget.js';
import * as tickTriage from './triage.js';

const tickRoot = () => tickFs.mkdtempSync(tickPath.join(tickOs.tmpdir(), 'triage-tick-'));
const tickIssues = [{ identifier: 'TICK-1', ref: '1', title: '첫 항목', body: '' },
  { identifier: 'TICK-2', ref: '2', title: '둘째 항목', body: '' }];

test('틱 주기 파생 예산 — 반복 주기는 항목 몫을 넓히되 단계 마감은 넘지 않는다', () => {
  const first = tickBudget.triageTickBudget({ cycle: { key: 'a', ticks: 1 }, issueCount: 4 });
  expect([first.basis, first.perIssueMs, first.concurrency]).toEqual(['first-tick', 90_000, 4]);
  const second = tickBudget.triageTickBudget({ cycle: { key: 'a', ticks: 2 }, issueCount: 4 });
  expect([second.basis, second.perIssueMs, second.concurrency]).toEqual(['repeat-tick', 180_000, 4]);
  const third = tickBudget.triageTickBudget({ cycle: { key: 'a', ticks: 3 }, issueCount: 40 });
  expect([third.perIssueMs, third.concurrency]).toEqual([240_000, 8]);
  expect(tickBudget.triageTickBudget({ cycle: { key: 'a', ticks: 9 }, issueCount: 1 }).perIssueMs).toBe(240_000);
});

test('틱 주기 — 같은 묶음은 틱을 세고 바뀐 묶음은 1부터 다시 센다', () => {
  const key = tickBudget.triageTickKey(tickIssues);
  const first = tickBudget.triageTickCycle(undefined, key);
  const second = tickBudget.triageTickCycle({ key, ticks: 1 }, key);
  const third = tickBudget.triageTickCycle({ key: second.key, ticks: second.ticks }, key);
  expect([first.ticks, second.ticks, third.ticks]).toEqual([1, 2, 3]);
  expect(tickBudget.triageTickKey([tickIssues[1]!, tickIssues[0]!])).toBe(key);
  expect(tickBudget.triageTickCycle({ key, ticks: 3 }, tickBudget.triageTickKey([tickIssues[0]!])).ticks).toBe(1);
});

test('항목별 사건/퇴화 지표 — 재사용·신선 판정·퇴화를 항목마다 가른다', () => {
  type EventsInput = Parameters<typeof tickBudget.triageItemEvents>[0];
  const prior = [
    { issue: 'TICK-1', rung: 4, dependsOn: [], priority: 1, why: 'cached judgment', inputHash: 'h1' },
    { issue: 'TICK-3', rung: 'hitl', hitlReason: 'other', dependsOn: [], priority: 1,
      why: 'triage judgment timed out — human review', inputHash: 'h3' },
  ] as unknown as EventsInput['previous'];
  const decisions = [
    { issue: 'TICK-1', rung: 4, dependsOn: [], priority: 1, why: 'cached judgment', inputHash: 'h1' },
    { issue: 'TICK-2', rung: 4, dependsOn: [], priority: 1, why: 'fresh judgment', inputHash: 'h2' },
    { issue: 'TICK-3', rung: 4, dependsOn: [], priority: 1, why: 'fresh after timeout', inputHash: 'h3b' },
    { issue: 'TICK-4', rung: 'hitl', hitlReason: 'other', dependsOn: [], priority: 1,
      why: 'triage judgment unavailable — human review', inputHash: 'h4' },
    { issue: 'TICK-5', rung: 'hitl', hitlReason: 'other', dependsOn: [], priority: 1,
      why: 'triage deferred — deadline', inputHash: 'h5', deferred: true },
  ] as unknown as EventsInput['decisions'];
  const sixIssues = ['TICK-1', 'TICK-2', 'TICK-3', 'TICK-4', 'TICK-5', 'TICK-6'].map(identifier =>
    ({ identifier, ref: identifier, title: '', body: '' }));
  const events = tickBudget.triageItemEvents({ cycle: { key: 'k', ticks: 2 }, issues: sixIssues, decisions, previous: prior });
  expect(events.map(event => [event.issue, event.outcome, event.degraded])).toEqual([
    ['TICK-1', 'reused', false],
    ['TICK-2', 'judged', false],
    ['TICK-3', 'judged', false],
    ['TICK-4', 'unavailable', true],
    ['TICK-5', 'deferred', true],
    ['TICK-6', 'unavailable', true],
  ]);
  expect(events.map(event => event.cycle)).toEqual([2, 2, 2, 2, 2, 2]);
  expect(events.map(event => event.index)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(tickBudget.triageItemMetrics(events)).toEqual({
    items: 6, fresh: 2, reused: 1, degraded: 3,
    byOutcome: { reused: 1, judged: 2, 'timed-out': 0, unavailable: 2, deferred: 1 },
  });
});

test('힐링·shadow→live — 지난 틱 퇴화 항목의 회복과 연속 건강 틱을 기록한다', () => {
  const events = (rows: Array<[string, tickBudget.TriageItemOutcome]>) => rows.map(([issue, outcome], index) =>
    ({ index: index + 1, cycle: 1, issue, outcome, degraded: outcome !== 'judged' && outcome !== 'reused', why: outcome }));
  const first = tickBudget.triageTickHealth({ mode: 'shadow', events: events([['A', 'judged'], ['B', 'judged']]) });
  expect([first.health, first.liveStreak, first.liveEligible]).toEqual(['healthy', 1, false]);
  const dip = tickBudget.triageTickHealth({ previous: { mode: 'shadow', degraded: [], liveStreak: 1 },
    mode: 'shadow', events: events([['A', 'timed-out'], ['B', 'judged']]) });
  expect([dip.health, dip.degraded, dip.liveStreak]).toEqual(['degraded', ['A'], 0]);
  const healed = tickBudget.triageTickHealth({ previous: { mode: 'shadow', degraded: ['A'], liveStreak: 0 },
    mode: 'shadow', events: events([['A', 'judged'], ['B', 'judged']]) });
  expect([healed.health, healed.healed, healed.liveStreak]).toEqual(['healing', ['A'], 1]);
  // A가 회복해도 이번 틱에 B 퇴화가 남아 있으면 — 판정은 'healing'이지만 연속 건강 틱은 0으로 리셋된다.
  const mixed = tickBudget.triageTickHealth({ previous: { mode: 'shadow', degraded: ['A'], liveStreak: tickBudget.LIVE_AFTER_TICKS - 1 },
    mode: 'shadow', events: events([['A', 'judged'], ['B', 'timed-out']]) });
  expect([mixed.health, mixed.healed, mixed.degraded, mixed.liveStreak, mixed.liveEligible]).toEqual(['healing', ['A'], ['B'], 0, false]);
  const recovered = tickBudget.triageTickHealth({ previous: { mode: 'shadow', degraded: ['B'], liveStreak: 0 },
    mode: 'shadow', events: events([['A', 'judged'], ['B', 'judged']]) });
  expect([recovered.health, recovered.healed, recovered.liveStreak]).toEqual(['healing', ['B'], 1]);
  const top = tickBudget.triageTickHealth({ previous: { mode: 'shadow', degraded: [], liveStreak: tickBudget.LIVE_AFTER_TICKS - 1 },
    mode: 'shadow', events: events([['A', 'judged']]) });
  expect([top.liveStreak, top.liveEligible]).toEqual([tickBudget.LIVE_AFTER_TICKS, true]);
  const live = tickBudget.triageTickHealth({ previous: { mode: 'shadow', degraded: [], liveStreak: 3 }, mode: 'live',
    events: events([['A', 'judged']]) });
  expect([live.transition, live.liveStreak, live.liveEligible]).toEqual(['shadow→live', 0, false]);
});

test('실 틱 3개가 생산 진입점(runStewardStage triage)에서 예산·사건·shadow→live 를 원장에 남긴다', async () => {
  const root = tickRoot();
  tickFs.mkdirSync(tickPath.join(root, 'steward'), { recursive: true });
  tickFs.writeFileSync(tickPath.join(root, 'steward', 'issues.json'), JSON.stringify(tickIssues));
  let calls = 0;
  const deps = {
    root,
    getSecret: async () => 'test-key',
    decide: () => true,
    judge: async () => {
      calls++;
      return { rung: 4, dependsOn: [], priority: 1, why: 'fake judgment' };
    },
  } as unknown as Parameters<typeof tickTriage.runStewardStage>[1];

  await tickTriage.runStewardStage('triage', deps);
  await tickTriage.runStewardStage('triage', deps);
  await tickTriage.runStewardStage('triage', deps);

  const ticks = tickBudget.readTriageTicks(root);
  expect(ticks.map(tick => tick.ticks)).toEqual([1, 2, 3]);
  expect(ticks.map(tick => tick.perIssueMs)).toEqual([90_000, 180_000, 240_000]);
  expect(ticks.map(tick => tick.concurrency)).toEqual([2, 2, 2]);
  expect(ticks.map(tick => tick.health)).toEqual(['healthy', 'healthy', 'healthy']);
  expect(ticks.map(tick => tick.liveStreak)).toEqual([1, 2, 3]);
  expect(ticks.at(-1)!.liveEligible).toBe(true);
  expect(ticks.map(tick => [tick.reused, tick.judged])).toEqual([[0, 2], [2, 0], [2, 0]]);
  expect(ticks[1]!.events.map(event => event.outcome)).toEqual(['reused', 'reused']);
  expect(calls).toBe(2);
  const judged = JSON.parse(tickFs.readFileSync(tickPath.join(root, 'steward', 'triage.json'), 'utf8')) as
    Array<{ issue: string; why: string }>;
  expect(judged.map(entry => entry.issue)).toEqual(['TICK-1', 'TICK-2']);
  expect(judged.map(entry => entry.why)).toEqual(['fake judgment', 'fake judgment']);

  // shadow 3틱 다음의 live 전환도 같은 생산 진입점에서 — 커맨드 노드가 넘기는 launchSettings override 로 튼다.
  await tickTriage.runStewardStage('triage', { ...deps, launchSettings: { mode: 'live' } } as unknown as
    Parameters<typeof tickTriage.runStewardStage>[1]);
  const afterLive = tickBudget.readTriageTicks(root);
  expect(afterLive).toHaveLength(4);
  expect(afterLive.map(tick => tick.mode)).toEqual(['shadow', 'shadow', 'shadow', 'live']);
  expect(afterLive.at(-1)!.transition).toBe('shadow→live');
  expect(afterLive.at(-1)!.liveStreak).toBe(0);
  expect(afterLive.at(-1)!.liveEligible).toBe(false);
  const ledger = tickFs.readFileSync(tickPath.join(root, 'steward', 'triage-ticks.jsonl'), 'utf8').trim().split('\n');
  expect(ledger).toHaveLength(4);
  expect(JSON.parse(ledger[3]!) as Record<string, unknown>).toMatchObject({ mode: 'live', transition: 'shadow→live' });
  expect(calls).toBe(2);
});

test('퇴화한 실 틱 다음 틱이 힐링으로 원장에 남는다 — 판정 불가는 재사용되지 않는다', async () => {
  const root = tickRoot();
  tickFs.mkdirSync(tickPath.join(root, 'steward'), { recursive: true });
  const round = (value: number) => tickFs.writeFileSync(tickPath.join(root, 'steward', 'issues.json'),
    JSON.stringify(tickIssues.map(issue => ({ ...issue, title: `${issue.title} r${value}` }))));
  round(1);
  let down = false;
  const deps = {
    root,
    getSecret: async () => 'test-key',
    decide: () => true,
    judge: async () => {
      if (down) throw new Error('judge down');
      return { rung: 4, dependsOn: [], priority: 1, why: 'fake judgment' };
    },
  } as unknown as Parameters<typeof tickTriage.runStewardStage>[1];

  await tickTriage.runStewardStage('triage', deps);
  round(2);
  down = true;
  await tickTriage.runStewardStage('triage', deps);
  round(3);
  down = false;
  await tickTriage.runStewardStage('triage', deps);

  const ticks = tickBudget.readTriageTicks(root);
  expect(ticks.map(tick => tick.health)).toEqual(['healthy', 'degraded', 'healing']);
  expect(ticks[1]!.degraded).toEqual(['TICK-1', 'TICK-2']);
  expect(ticks[1]!.events.map(event => event.outcome)).toEqual(['unavailable', 'unavailable']);
  expect(ticks[1]!.liveStreak).toBe(0);
  expect(ticks[2]!.healed).toEqual(['TICK-1', 'TICK-2']);
  expect(ticks[2]!.events.map(event => event.outcome)).toEqual(['judged', 'judged']);
});
