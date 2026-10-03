import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { classifyIssue, planIssues, ruleJudgment, unsafeReason, type StewardAsk } from './triage-plan.js';
import { triageIssues, type TriageIssue } from './triage.js';
import { triageInputHash } from './triage-budget.js';

const issue = (n: number): TriageIssue => ({ identifier: `ELA-${n}`, ref: `ref-${n}`, title: `Review ${n}`, body: '' });

test('100 new issues classify in eight slots then make exactly one planning call within 240 seconds', async () => {
  const issues = Array.from({ length: 100 }, (_, n) => issue(n));
  const originalNow = Date.now;
  let clock = 0;
  let active = 0;
  let peak = 0;
  const counts = { classify: 0, planning: 0 };
  const ask: StewardAsk = async (prompt, role) => {
    counts[role]++;
    if (role === 'classify') {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      clock += 5_000 / 8;
      active--;
      return { rung: 4, why: 'work', capability: 'existing-capability' };
    }
    clock += 10_000;
    return { plans: issues.map((item, n) => ({ issue: item.identifier, priority: n, dependsOn: [], owner: null })) };
  };
  try {
    Date.now = () => clock;
    const rows = await triageIssues(issues, undefined, () => true, undefined, [], ask);
    expect(rows).toHaveLength(100);
    expect(rows.every(row => row.rung === 4 && !row.deferred)).toBe(true);
    expect(rows[99]?.priority).toBe(99);
    expect(peak).toBe(8);
    expect(counts).toEqual({ classify: 100, planning: 1 });
    expect(clock).toBeLessThan(240_000);
  } finally { Date.now = originalNow; }
});

test('normalized duplicate uses no classify calls, while sensitive content is confirmed by classify', async () => {
  const first = issue(0);
  const duplicate = { ...issue(1), ref: first.ref, title: '  REVIEW   0 ' };
  expect(ruleJudgment(duplicate, [first, duplicate])).toMatchObject({ rung: 0, duplicateOf: 'ELA-0' });
  expect(ruleJudgment({ ...duplicate, ref: 'another-ref' }, [first, duplicate])).toMatchObject({ rung: 0, duplicateOf: 'ELA-0' });
  // A different body is no proof of a duplicate — it goes to classification.
  expect(ruleJudgment({ ...duplicate, body: 'different task' }, [first, duplicate])).toBeUndefined();
  expect(ruleJudgment({ ...issue(2), body: '결제 승인' }, [first])).toBeUndefined();
  const calls: string[] = [];
  const ask: StewardAsk = async (_prompt, role) => {
    calls.push(role);
    return role === 'planning'
      ? { plans: [{ issue: 'ELA-0', priority: 0, dependsOn: [], owner: null }, { issue: 'ELA-2', priority: 2, dependsOn: [], owner: null }] }
      : { rung: 2, why: 'check payment', hitlReason: 'money', capability: 'existing-capability' };
  };
  const rows = await triageIssues([first, duplicate, { ...issue(2), body: '결제 승인' }], undefined, () => true, undefined, [], ask);
  expect(rows[1]).toMatchObject({ rung: 0, duplicateOf: 'ELA-0' });
  expect(rows[2]).toMatchObject({ rung: 'hitl', hitlReason: 'money' });
  expect(calls).toEqual(['classify', 'classify', 'planning']);
});

test('same normalized title: a different ref with the same body is a duplicate; a different body is classified', async () => {
  const first = { ...issue(0), body: 'original task' };
  const differentRef = { ...issue(1), title: ' REVIEW  0 ', body: first.body };
  const differentBody = { ...issue(2), ref: first.ref, title: 'Review 0', body: 'separate task' };
  const batch = [first, differentRef, differentBody];
  const calls: string[] = [];
  const rows = await triageIssues(batch, undefined, () => true, undefined, [], async (_prompt, role) => {
    calls.push(role);
    return role === 'classify' ? { rung: 4, why: 'distinct work', capability: 'existing-capability' }
      : { plans: [{ issue: 'ELA-0', priority: 0, dependsOn: [], owner: null }, { issue: 'ELA-2', priority: 1, dependsOn: [], owner: null }] };
  });
  expect(rows.map(row => [row.rung, row.duplicateOf])).toEqual([[4, undefined], [0, 'ELA-0'], [4, undefined]]);
  expect(calls).toEqual(['classify', 'classify', 'planning']);
});

test('security key mentions are HITL candidates and classification confirms the reason', async () => {
  for (const title of ['API 키 검토', 'access token review']) {
    const candidate = { ...issue(9), title };
    expect(unsafeReason(candidate)).toBe('security');
    const result = await classifyIssue(candidate, async () => ({ rung: 2, why: 'inspect key handling', capability: 'existing-capability' }));
    expect(result).toMatchObject({ rung: 'hitl', hitlReason: 'security' });
  }
});

test('planning only receives newly classified issues and may depend on reused issue keys', async () => {
  const issues = [issue(0), issue(1)];
  const prior = { issue: 'ELA-0', rung: 4 as const, why: 'previous', priority: 1, dependsOn: [], inputHash: triageInputHash(issues[0]!, issues) };
  const calls: string[] = [];
  const rows = await triageIssues(issues, undefined, () => true, undefined, [prior], async (prompt, role) => {
    calls.push(role);
    if (role === 'classify') return { rung: 4, why: 'new', capability: 'new-capability' };
    expect(prompt).toContain('ELA-0');
    return { plans: [{ issue: 'ELA-1', priority: 2, dependsOn: ['ELA-0'], owner: null }] };
  });
  expect(calls).toEqual(['classify', 'planning']);
  expect(rows[0]).toMatchObject(prior);
  expect(rows[1]?.dependsOn).toEqual(['ELA-0']);
});

test('planning is skipped on empty batch and rejects omitted issues', async () => {
  const ask: StewardAsk = async () => { throw new Error('must not call'); };
  expect(await planIssues([], ask)).toEqual([]);
  await expect(planIssues([{ issue: 'ELA-1', rung: 4, why: 'ok' }], async () => ({ plans: [] }))).rejects.toThrow('Invalid steward plan');
  expect(await classifyIssue(issue(1), async () => ({ rung: 1, why: 'shell', capability: 'existing-capability' }))).toMatchObject({ rung: 1, why: 'shell', capability: 'existing-capability' });
});

test('classification finishing after its timeout cannot enter the frozen planning batch', async () => {
  const batch = [issue(0), issue(1)];
  const originalTimer = globalThis.setTimeout;
  let finishLate!: (value: unknown) => void;
  let latePromptSeen!: () => void;
  const lateStarted = new Promise<void>(resolve => { latePromptSeen = resolve; });
  let planningCalls = 0;
  try {
    globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
      originalTimer(callback, delay === 90_000 ? 5 : delay, ...args)) as typeof setTimeout;
    const result = triageIssues(batch, undefined, () => true, undefined, [], async (prompt, role) => {
      if (role === 'classify') {
        if (prompt.includes('ELA-0')) {
          latePromptSeen();
          return new Promise(resolve => { finishLate = resolve; });
        }
        return { rung: 4, why: 'on time', capability: 'existing-capability' };
      }
      planningCalls++;
      expect(prompt).toContain('ELA-1');
      expect(prompt).not.toContain('"issue":"ELA-0"');
      finishLate({ rung: 4, why: 'too late' });
      await Promise.resolve();
      return { plans: [{ issue: 'ELA-1', priority: 7, dependsOn: [], owner: null }] };
    });
    await lateStarted;
    const rows = await result;
    expect(rows[0]?.why).toBe('triage judgment timed out — human review');
    expect(rows[1]).toMatchObject({ rung: 4, priority: 7, why: 'on time' });
    expect(planningCalls).toBe(1);
  } finally { globalThis.setTimeout = originalTimer; }
});

test('steward implementation contains no literal provider model names', () => {
  for (const file of ['triage.ts', 'triage-plan.ts', 'triage-budget.ts']) {
    expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(/gpt-|claude-|grok-/);
  }
});
