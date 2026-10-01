import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { buildUserConfig } from '../user-config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleTriage, trackTablePrompt, triageIssues, runStewardStage, runStewardStageCommand, type TriageIssue, type TriageDecision } from './triage.js';
import { markStageStart, readFailureStreak, writeFailureStreak } from './failure-streak.js';
import { CardStore } from '../task-cards/card-store.js';
import { triageInputHash, triageWithinBudget } from './triage-budget.js';

const issues: TriageIssue[] = [
  { identifier: 'ELA-1', ref: 'one', title: '기반 구축', body: '' },
  { identifier: 'ELA-2', ref: 'two', title: '유료 판매 시점', body: '' },
];

test('steward config parses alert threshold and ignores invalid thresholds', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-alert-config-'));
  const path = join(root, 'config.json');
  try {
    writeFileSync(path, JSON.stringify({ loops: { steward: { alertAfterFailures: 5 } } }));
    expect(buildUserConfig(path).loops?.steward?.alertAfterFailures).toBe(5);
    for (const invalid of [0, -1, 1.5, '4']) {
      writeFileSync(path, JSON.stringify({ loops: { steward: { alertAfterFailures: invalid } } }));
      expect(buildUserConfig(path).loops?.steward?.alertAfterFailures).toBeUndefined();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('command records failure and failed alert delivery preserves stage exit code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-alert-command-'));
  const now = () => new Date('2026-10-01T00:00:00.000Z');
  const alerts: string[] = [];
  try {
    for (let n = 1; n <= 4; n++) {
      const code = await runStewardStageCommand('triage', { root, now, runStage: async () => { throw new Error('stage failed'); },
        deliverAlert: async (text, kind) => { expect(kind).toBe('alert'); alerts.push(text); if (n === 3) throw new Error('delivery failed'); return true; } });
      expect(code).toBe(1);
      expect(readFailureStreak(root).consecutive).toBe(n);
    }
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toContain('연속 실패 3회');
    expect(alerts[1]).toContain('연속 실패 4회');
    expect(readFailureStreak(root).alertedAt).toBe(now().toISOString());
    expect(await runStewardStageCommand('sync', { root, now, runStage: async () => {}, deliverAlert: () => { throw new Error('unexpected alert'); } })).toBe(0);
    expect(readFailureStreak(root).alertedAt).toBeUndefined();
    for (let n = 0; n < 3; n++) await runStewardStageCommand('triage', { root, now, runStage: async () => { throw new Error('again'); }, deliverAlert: text => { alerts.push(text); return true; } });
    expect(alerts).toHaveLength(3);
    expect(await runStewardStageCommand('triage', { root, now, runStage: async () => { throw undefined; }, deliverAlert: () => { throw new Error('unexpected alert'); } })).toBe(1);
    expect(readFailureStreak(root).consecutive).toBe(4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('overlapping commands for the same root do not mistake a live stage for a timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-overlap-'));
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const entered = new Promise<void>(resolve => { firstEntered = resolve; });
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  const alerts: string[] = [];
  let secondRan = false;
  try {
    for (let n = 0; n < 2; n++) {
      expect(await runStewardStageCommand('sync', { root, runStage: async () => { throw new Error('earlier failure'); }, deliverAlert: text => { alerts.push(text); return true; } })).toBe(1);
    }
    const first = runStewardStageCommand('triage', { root, runStage: async () => { firstEntered(); await held; throw new Error('first failed'); }, deliverAlert: text => { alerts.push(text); return true; } });
    await entered;
    const second = runStewardStageCommand('sync', { root, runStage: async () => { secondRan = true; throw new Error('second failed'); }, deliverAlert: text => { alerts.push(text); return true; } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(secondRan).toBe(false);
    expect(readFailureStreak(root).consecutive).toBe(2);
    expect(alerts).toHaveLength(0);
    releaseFirst();
    expect(await first).toBe(1);
    expect(await second).toBe(0);
    expect(readFailureStreak(root)).toMatchObject({ consecutive: 3, lastStage: 'triage', lastReason: 'first failed' });
    expect(readFailureStreak(root).open).toBeUndefined();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('연속 실패 3회');
    expect(secondRan).toBe(false);
  } finally { releaseFirst(); rmSync(root, { recursive: true, force: true }); }
});

test('two processes racing into sync acquire one atomic owner; loser cannot overwrite snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-sync-race-'));
  const script = join(root, 'race.ts');
  const url = new URL('./triage.ts', import.meta.url).href;
  const dir = join(root, 'steward');
  mkdirSync(dir);
  writeFileSync(join(dir, 'issues.json'), 'original');
  writeFileSync(script, `import { runStewardStageCommand } from ${JSON.stringify(url)};
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2]!;
writeFileSync(join(root, 'ready-' + process.pid), 'yes');
while (!existsSync(join(root, 'go'))) await Bun.sleep(5);
const code = await runStewardStageCommand('sync', { root, runStage: async () => {
  writeFileSync(join(root, 'entered-' + process.pid), 'yes');
  await Bun.sleep(300);
  writeFileSync(join(root, 'steward', 'issues.json'), String(process.pid));
} });
process.exit(code);
`);
  const children = Array.from({ length: 2 }, () => Bun.spawn(['bun', script, root], { stdout: 'pipe', stderr: 'pipe' }));
  try {
    for (let n = 0; n < 200 && children.some(child => !existsSync(join(root, `ready-${child.pid}`))); n++) await Bun.sleep(5);
    expect(children.every(child => existsSync(join(root, `ready-${child.pid}`)))).toBe(true);
    writeFileSync(join(root, 'go'), 'start');
    const results = await Promise.all(children.map(async child => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
    expect(results).toEqual([{ code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    const owners = children.filter(child => existsSync(join(root, `entered-${child.pid}`)));
    expect(owners).toHaveLength(1);
    expect(readFileSync(join(dir, 'issues.json'), 'utf8')).toBe(String(owners[0]!.pid));
  } finally {
    for (const child of children) { child.kill(); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
});

test('two processes starting together after a stale lock serialize without counting a live stage as killed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-stale-race-'));
  const script = join(root, 'probe.ts');
  const triageUrl = new URL('./triage.ts', import.meta.url).href;
  const streakUrl = new URL('./failure-streak.ts', import.meta.url).href;
  try {
    mkdirSync(join(root, 'steward', 'stage.lock'), { recursive: true });
    writeFileSync(join(root, 'steward', 'stage.lock', 'pid'), '99999999');
    writeFileSync(script, `import { runStewardStageCommand } from ${JSON.stringify(triageUrl)};
import { readFailureStreak } from ${JSON.stringify(streakUrl)};
import { existsSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2]!;
writeFileSync(join(root, 'ready-' + process.pid), 'yes');
while (!existsSync(join(root, 'go'))) await Bun.sleep(5);
const code = await runStewardStageCommand('triage', { root, runStage: async () => {
  const running = join(root, 'running');
  mkdirSync(running);
  try {
    await Bun.sleep(150);
    if (readFailureStreak(root).consecutive !== 0) throw new Error('live stage counted as killed');
  } finally { rmdirSync(running); }
}, deliverAlert: () => { throw new Error('unexpected alert'); } });
process.exit(code);
`);
    const children = Array.from({ length: 2 }, () => Bun.spawn(['bun', script, root], { stdout: 'pipe', stderr: 'pipe' }));
    for (let n = 0; n < 200 && children.some(child => !existsSync(join(root, `ready-${child.pid}`))); n++) await Bun.sleep(5);
    expect(children.every(child => existsSync(join(root, `ready-${child.pid}`)))).toBe(true);
    writeFileSync(join(root, 'go'), 'start');
    const results = await Promise.all(children.map(async child => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
    expect(results).toEqual([{ code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    expect(readFailureStreak(root).consecutive).toBe(0);
    expect(readFailureStreak(root).open).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a killed command releases the OS lock and leaves its open stage to count once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-kill-lock-'));
  const script = join(root, 'hold.ts');
  const triageUrl = new URL('./triage.ts', import.meta.url).href;
  writeFileSync(script, `import { runStewardStageCommand } from ${JSON.stringify(triageUrl)};
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
await runStewardStageCommand('triage', { root: process.argv[2], runStage: async () => {
  writeFileSync(join(process.argv[2], 'entered'), 'yes');
  await new Promise(() => {});
} });
`);
  const child = Bun.spawn(['bun', script, root], { stdout: 'pipe', stderr: 'pipe' });
  try {
    let entered = false;
    for (let n = 0; n < 100; n++) {
      if (existsSync(join(root, 'entered'))) { entered = true; break; }
      await Bun.sleep(10);
    }
    expect(entered).toBe(true);
    child.kill();
    await child.exited;
    const result = await Promise.race([
      runStewardStageCommand('sync', { root, runStage: async () => { throw new Error('again'); } }),
      Bun.sleep(3000).then(() => 'timeout' as const),
    ]);
    expect(result).toBe(1);
    expect(readFailureStreak(root)).toMatchObject({ consecutive: 2, lastStage: 'sync' });
    expect(readFailureStreak(root).open).toBeUndefined();
  } finally { child.kill(); await child.exited; rmSync(root, { recursive: true, force: true }); }
});

test('command accounts for killed stage at next start even if next stage succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-killed-command-'));
  const alerts: string[] = [];
  try {
    for (let n = 0; n < 2; n++) await runStewardStageCommand('triage', { root, runStage: async () => { throw new Error('failure'); }, deliverAlert: text => { alerts.push(text); return true; } });
    markStageStart(root, 'triage', new Date('2026-10-01T00:00:00Z'));
    mkdirSync(join(root, 'steward', 'stage.lock'));
    writeFileSync(join(root, 'steward', 'stage.lock', 'pid'), '99999999');
    expect(await runStewardStageCommand('sync', { root, runStage: async () => {}, deliverAlert: text => { alerts.push(text); throw new Error('delivery failed'); } })).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('마지막 triage · killed or timed out: triage');
    expect(readFailureStreak(root).consecutive).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('steward config parses team, observe mode and role caps', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-config-'));
  const path = join(root, 'config.json');
  try {
    writeFileSync(path, JSON.stringify({ loops: { steward: { linearTeam: 'ELA', mode: 'observe', budget: 3, roles: { builder: { maxConcurrent: 2 } } } } }));
    expect(buildUserConfig(path).loops?.steward).toEqual({ linearTeam: 'ELA', mode: 'observe', budget: 3, roles: { builder: { maxConcurrent: 2 } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('LLM decisions emit route/escalate and mandatory HITL for paid sale', async () => {
  const events: unknown[] = [];
  const result = await triageIssues(issues, async issue => ({ rung: 4, dependsOn: issue.ref === 'two' ? ['ELA-1'] : [], priority: 2, why: 'needs work' }), event => { events.push(event); return true; });
  expect(result.map(d => d.rung)).toEqual([4, 'hitl']);
  expect(result[1]?.hitlReason).toBe('money');
  expect(events.map((e: any) => [e.kind, e.refs.issue])).toEqual([['ROUTE', 'ELA-1'], ['ESCALATE', 'ELA-2']]);
});

test('dependencies precede dependents, caps and budget wait, unsafe decisions never auto-approve', () => {
  const decisions: TriageDecision[] = [
    { issue: 'ELA-2', rung: 4, dependsOn: ['ELA-1'], priority: 1, why: 'downstream', role: 'builder', cost: 1 },
    { issue: 'ELA-1', rung: 4, dependsOn: [], priority: 2, why: 'upstream', role: 'builder', cost: 1 },
    { issue: 'ELA-3', rung: 'hitl', hitlReason: 'public', dependsOn: [], priority: 0, why: 'publish' },
  ];
  expect(scheduleTriage(decisions, { budget: 1, roles: { builder: { maxConcurrent: 1 } } }).map(d => [d.issue, d.disposition]))
    .toEqual([['ELA-3', 'hitl'], ['ELA-1', 'now'], ['ELA-2', 'wait']]);
  expect(scheduleTriage(decisions, { budget: 10 }).find(row => row.issue === 'ELA-2')?.disposition).toBe('wait');
  expect(scheduleTriage(decisions, { budget: 10 }, {}, new Set(['ELA-1'])).find(row => row.issue === 'ELA-2')?.disposition).toBe('now');
});

test('LLM HITL reason cannot be downgraded to an executable rung', async () => {
  const [decision] = await triageIssues([{ identifier: 'ELA-9', ref: 'id-9', title: 'Review contract', body: '' }],
    async () => ({ rung: 2, dependsOn: [], priority: 1, why: 'requires human decision', hitlReason: 'money' }), () => true);
  expect(decision?.rung).toBe('hitl');
  expect(scheduleTriage([decision!])[0]?.disposition).toBe('hitl');
});

test('money, public, security and irreversible cases cannot be auto-approved', async () => {
  for (const [title, reason] of [
    ['유료 판매 시점', 'money'], ['저장소 공개 전환', 'public'],
    ['키 교체', 'security'], ['영구 삭제', 'irreversible'],
    ['돈이 걸린 결정', 'money'], ['보안 승인', 'security'], ['비가역 조치', 'irreversible'],
  ] as const) {
    const [decision] = await triageIssues([{ identifier: 'ELA-5', ref: 'id-5', title, body: '' }],
      async () => ({ rung: 1, dependsOn: [], priority: 1, why: 'agent requested execution' }), () => true);
    expect(decision?.hitlReason).toBe(reason);
    expect(scheduleTriage([decision!])[0]?.disposition).toBe('hitl');
  }
});

test('deadline-carried routing is HITL in the following schedule, never current executable routing', async () => {
  const prior = { issue: issues[0]!.identifier, rung: 4 as const, dependsOn: [], priority: 1, why: 'old route',
    inputHash: triageInputHash(issues[0]!, issues.slice(0, 1)) };
  const changed = [{ ...issues[0]!, body: 'changed' }];
  const { decisions } = await triageWithinBudget({ issues: changed, previous: [prior], deadlineMs: 0,
    judge: async () => { throw new Error('must not start'); } });
  const persisted = JSON.parse(JSON.stringify(decisions)) as TriageDecision[];
  expect(persisted[0]?.rung).toBe(4);
  expect(persisted[0]?.deferred).toBe(true);
  expect(scheduleTriage(persisted)[0]?.disposition).toBe('hitl');
  expect(scheduleTriage([{ ...prior, deferred: undefined }])[0]?.disposition).toBe('now');
});

test('triageIssues emits ESCALATE for newly deferred HITL but not for carried routing', async () => {
  const originalNow = Date.now;
  let ticks = 0;
  const events: Array<{ kind: string; what: string }> = [];
  const prior = { issue: issues[0]!.identifier, rung: 4 as const, dependsOn: [], priority: 1, why: 'old route',
    inputHash: triageInputHash(issues[0]!, issues) };
  try {
    Date.now = () => ticks++ === 0 ? 0 : 240_000;
    const decisions = await triageIssues([{ ...issues[0]!, body: 'changed' }, issues[1]!],
      async () => { throw new Error('must not start'); }, event => { events.push(event); return true; }, undefined, [prior]);
    expect(decisions.map(row => row.deferred)).toEqual([true, true]);
    expect(events.map(event => [event.kind, event.what])).toEqual([['ESCALATE', 'ELA-2']]);
  } finally { Date.now = originalNow; }
});

test('schedule stage blocks stale routing persisted by a deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-deferred-schedule-'));
  try {
    const dir = join(root, 'steward');
    mkdirSync(dir);
    const prior = { issue: issues[0]!.identifier, rung: 4 as const, dependsOn: [], priority: 1, why: 'old route',
      inputHash: triageInputHash(issues[0]!, issues.slice(0, 1)) };
    const { decisions } = await triageWithinBudget({ issues: [{ ...issues[0]!, body: 'changed' }], previous: [prior], deadlineMs: 0,
      judge: async () => { throw new Error('must not start'); } });
    writeFileSync(join(dir, 'triage.json'), JSON.stringify(decisions));
    await runStewardStage('schedule', { root, getSecret: async () => 'key' });
    const rows = JSON.parse(readFileSync(join(dir, 'schedule.json'), 'utf8')) as Array<{ issue: string; disposition: string }>;
    expect(rows).toEqual([{ ...decisions[0], disposition: 'hitl' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a cyclic dependency never schedules either issue now', () => {
  const rows = scheduleTriage([
    { issue: 'ELA-1', rung: 4, dependsOn: ['ELA-2'], priority: 1, why: 'one' },
    { issue: 'ELA-2', rung: 4, dependsOn: ['ELA-1'], priority: 2, why: 'two' },
  ]);
  expect(rows.map(row => row.disposition)).toEqual(['wait', 'wait']);
});

test('22 sample summaries flow through fake LLM triage; unknown hand distribution stays unmeasured', async () => {
  const lines = readFileSync('docs/goal-context/steward-directives-2026-09-28.md', 'utf8').split('\n');
  const summaries = lines.filter(line => /^\| (?:[1-9]|1[0-9]|2[0-2]) \|/.test(line)).map((line, index) => ({
    identifier: `ELA-${index + 1}`, ref: String(index + 1), title: line.split('|')[2]!.trim(), body: '',
  }));
  const decisions = await triageIssues(summaries, async () => ({ rung: 4, dependsOn: [], priority: 2, why: 'fake judgment' }), () => true);
  const scheduled = scheduleTriage(decisions);
  expect(scheduled).toHaveLength(22);
  expect(scheduled.filter(row => row.disposition === 'hitl').map(row => row.issue)).toEqual(['ELA-20', 'ELA-4', 'ELA-6']);
  expect(scheduled.every(row => row.rung !== 'hitl' || row.disposition === 'hitl')).toBe(true);
  for (const [index, issue] of summaries.entries()) {
    const row = scheduled.find(item => item.issue === issue.identifier)!;
    const fields = lines.filter(line => /^\| (?:[1-9]|1[0-9]|2[0-2]) \|/.test(line))[index]!.split('|');
    expect(fields[2]?.trim()).toBe(issue.title);
    expect(fields[4]?.trim()).toBe('미확인');
    expect(fields[5]?.trim()).toBe('판정 불가');
    if (row.rung === 'hitl') expect(row.disposition).toBe('hitl');
  }
});

test('22 sample directives through fake Linear and observe report create 22 cards with both sections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-sample-cards-'));
  const lines = readFileSync('docs/goal-context/steward-directives-2026-09-28.md', 'utf8').split('\n');
  const summaries = lines.filter(line => /^\| (?:[1-9]|1[0-9]|2[0-2]) \|/.test(line)).map((line, index) => ({
    identifier: `ELA-${index + 1}`, ref: `fake-${index + 1}`, title: line.split('|')[2]!.trim(), body: '',
  }));
  const calls: string[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    calls.push(query);
    if (query.includes('issues(')) return Response.json({ data: { issues: {
      nodes: summaries.map(item => ({ id: item.ref, identifier: item.identifier, title: item.title, description: item.body, url: '', priority: 2, updatedAt: '2026-09-28T00:00:00Z', state: { type: 'started' } })),
      pageInfo: { hasNextPage: false, endCursor: null },
    } } });
    if (query.includes('commentCreate(')) return Response.json({ data: { commentCreate: { success: true } } });
    throw new Error(`unexpected Linear query: ${query}`);
  }) as typeof fetch;
  const deps = { root, fetch: fetchFn, getSecret: async () => 'key', judge: async () => ({ rung: 4, dependsOn: [], priority: 2, why: 'fake judgment' }),
    decide: () => true, sendDigest: async () => {}, now: () => new Date('2026-09-28T00:00:00Z') };
  try {
    for (const stage of ['sync', 'triage', 'schedule', 'report'] as const) await runStewardStage(stage, deps);
    const store = new CardStore(root);
    try {
      const cards = store.listCards();
      expect(cards).toHaveLength(22);
      expect(cards.every(card => card.sections.length === 2 && card.sections[0]?.key.startsWith('intake:') && card.sections[1]?.key.startsWith('triage:'))).toBe(true);
      expect(cards.filter(card => JSON.parse(card.sections[1]!.content).disposition === 'hitl')).toHaveLength(3);
    } finally { store.close(); }
    expect(calls.filter(query => query.includes('commentCreate('))).toHaveLength(22);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a live prior run skips sync and all later stages without overwriting snapshots; dead pid resumes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-overlap-graph-'));
  const dir = join(root, 'steward');
  mkdirSync(dir);
  const context = join(root, 'context.json');
  const previousContext = process.env.ELANOUS_GRAPH_CONTEXT;
  const requests: string[] = [];
  const snapshot = join(dir, 'issues.json');
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(init?.body));
    return Response.json({ data: { issues: { nodes: [{ id: 'fresh', identifier: 'ELA-10', title: 'Fresh', description: '', url: '', priority: 2, updatedAt: '2026-09-28T00:00:00Z', state: { type: 'started' } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
  }) as typeof fetch;
  const deps = { root, fetch: fetchFn, getSecret: async () => 'key' };
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = context;
    writeFileSync(context, JSON.stringify({ graphId: 'steward', runId: 'current' }));
    writeFileSync(snapshot, 'previous snapshot');
    writeFailureStreak(root, { consecutive: 0, lastStage: 'triage', lastReason: '', lastAt: '' });
    writeFileSync(join(dir, 'streak.json'), JSON.stringify({ ...readFailureStreak(root),
      open: { stage: 'triage', startedAt: new Date().toISOString(), pid: process.pid, runId: 'prior' } }));
    expect(await runStewardStageCommand('sync', { root, fetch: fetchFn, getSecret: async () => { throw new Error('skip must not request secret'); } })).toBe(0);
    expect(readFileSync(snapshot, 'utf8')).toBe('previous snapshot');
    expect(readFailureStreak(root).open?.stage).toBe('triage');
    for (const stage of ['triage', 'schedule', 'report'] as const) expect(await runStewardStageCommand(stage, deps)).toBe(0);
    expect(requests).toHaveLength(0);
    expect(readFileSync(snapshot, 'utf8')).toBe('previous snapshot');
    writeFileSync(context, JSON.stringify({ graphId: 'steward', runId: 'next' }));
    writeFailureStreak(root, { consecutive: 0, lastStage: 'sync', lastReason: '', lastAt: '' });
    writeFileSync(join(dir, 'streak.json'), JSON.stringify({ ...readFailureStreak(root),
      open: { stage: 'triage', startedAt: new Date().toISOString(), pid: 99999999, runId: 'prior' } }));
    expect(await runStewardStageCommand('sync', deps)).toBe(0);
    expect(requests).toHaveLength(1);
    expect(readFileSync(snapshot, 'utf8')).toContain('ELA-10');
  } finally {
    if (previousContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previousContext;
    rmSync(root, { recursive: true, force: true });
  }
});

test('without graph context, skipped sync prevents every following stage and a dead pid resumes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-overlap-no-graph-'));
  const dir = join(root, 'steward');
  mkdirSync(dir);
  const previousContext = process.env.ELANOUS_GRAPH_CONTEXT;
  const snapshot = join(dir, 'issues.json');
  const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
  const requests: string[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(init?.body));
    return Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
  }) as typeof fetch;
  const deps = { root, fetch: fetchFn, getSecret: async () => 'key' };
  try {
    delete process.env.ELANOUS_GRAPH_CONTEXT;
    writeFileSync(snapshot, 'unchanged');
    writeFileSync(join(dir, 'triage.json'), 'unchanged');
    writeFileSync(join(dir, 'schedule.json'), 'unchanged');
    writeFileSync(join(dir, 'streak.json'), JSON.stringify({ ...readFailureStreak(root),
      open: { stage: 'report', startedAt: new Date().toISOString(), pid: child.pid } }));
    expect(await runStewardStageCommand('sync', deps)).toBe(0);
    for (const stage of ['triage', 'schedule', 'report'] as const) expect(await runStewardStageCommand(stage, deps)).toBe(0);
    expect(requests).toHaveLength(0);
    for (const file of ['issues.json', 'triage.json', 'schedule.json']) expect(readFileSync(join(dir, file), 'utf8')).toBe('unchanged');
    expect(readFailureStreak(root).open?.stage).toBe('report');
    expect(existsSync(join(dir, 'skipped-no-context.json'))).toBe(true);
    child.kill();
    await child.exited;
    expect(await runStewardStageCommand('sync', deps)).toBe(0);
    expect(requests).toHaveLength(1);
    expect(existsSync(join(dir, 'skipped-no-context.json'))).toBe(false);
    expect(readFileSync(snapshot, 'utf8')).toBe('[]');
  } finally {
    child.kill(); await child.exited;
    if (previousContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previousContext;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a same-run overlap skips only the losing sync — the run\'s own later stages still run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-same-run-overlap-'));
  const dir = join(root, 'steward');
  mkdirSync(dir);
  const context = join(root, 'context.json');
  const previousContext = process.env.ELANOUS_GRAPH_CONTEXT;
  const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
  let ran = false;
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = context;
    writeFileSync(context, JSON.stringify({ graphId: 'steward', runId: 'same' }));
    writeFileSync(join(dir, 'issues.json'), 'unchanged');
    writeFileSync(join(dir, 'streak.json'), JSON.stringify({ ...readFailureStreak(root),
      open: { stage: 'triage', startedAt: new Date().toISOString(), pid: child.pid, runId: 'same' } }));
    let syncRan = false;
    expect(await runStewardStageCommand('sync', { root, runStage: async () => { syncRan = true; } })).toBe(0);
    expect(syncRan).toBe(false);
    expect(readFileSync(join(dir, 'issues.json'), 'utf8')).toBe('unchanged');
    // No shared skip marker from a same-run loser, so the winner's triage is not skipped (review must-fix).
    expect(existsSync(join(dir, 'skipped-same.json'))).toBe(false);
    expect(await runStewardStageCommand('triage', { root, runStage: async () => { ran = true; } })).toBe(0);
    expect(ran).toBe(true);
  } finally {
    child.kill(); await child.exited;
    if (previousContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previousContext;
    rmSync(root, { recursive: true, force: true });
  }
});

test('five dependency states are fetched in exactly one Linear request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-batch-deps-'));
  const dir = join(root, 'steward');
  mkdirSync(dir);
  const calls: Array<{ query: string; variables: { ids: string[] } }> = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables: { ids: string[] } };
    calls.push(request);
    return Response.json({ data: { issues: { nodes: request.variables.ids.map((identifier, index) => ({ identifier, state: { type: index < 4 ? 'completed' : 'started' } })), pageInfo: { hasNextPage: false, endCursor: null } } } });
  }) as typeof fetch;
  try {
    writeFileSync(join(dir, 'triage.json'), JSON.stringify([{ issue: 'ELA-0', rung: 4, dependsOn: Array.from({ length: 5 }, (_, n) => `ELA-${n + 1}`), priority: 1, why: 'depends' }]));
    await runStewardStage('schedule', { root, fetch: fetchFn, getSecret: async () => 'key' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.variables.ids).toHaveLength(5);
    expect(JSON.parse(readFileSync(join(dir, 'schedule.json'), 'utf8'))[0].disposition).toBe('wait');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('more than 250 dependencies are fetched in bounded Linear batches with paginated results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-large-deps-'));
  const dir = join(root, 'steward');
  mkdirSync(dir);
  const dependencies = Array.from({ length: 502 }, (_, n) => `ELA-${n + 1}`);
  const calls: Array<{ ids: string[]; after: string | null }> = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { variables: { ids: string[]; after: string | null } };
    const { ids, after } = request.variables;
    calls.push({ ids, after });
    const start = after === null ? 0 : Number(after);
    const end = Math.min(start + 125, ids.length);
    return Response.json({ data: { issues: { nodes: ids.slice(start, end).map(identifier => ({ identifier, state: { type: 'completed' } })),
      pageInfo: { hasNextPage: end < ids.length, endCursor: end < ids.length ? String(end) : null } } } });
  }) as typeof fetch;
  try {
    writeFileSync(join(dir, 'triage.json'), JSON.stringify([
      { issue: 'ELA-0', rung: 4, dependsOn: dependencies, priority: 1, why: 'depends' },
    ]));
    await runStewardStage('schedule', { root, fetch: fetchFn, getSecret: async () => 'key' });
    expect(calls.map(call => [call.ids.length, call.after])).toEqual([[250, null], [250, '125'], [250, null], [250, '125'], [2, null]]);
    expect(JSON.parse(readFileSync(join(dir, 'schedule.json'), 'utf8'))[0].disposition).toBe('now');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('schedule stage checks completed Linear dependencies read-only before releasing a dependent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-dependency-'));
  const calls: string[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    calls.push(query);
    if (query.includes('identifier:{in:')) return Response.json({ data: { issues: { nodes: [{ identifier: 'ELA-2', state: { type: 'completed' } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (query.includes('issues(')) return Response.json({ data: { issues: { nodes: issues.map(i => ({ id: i.ref, identifier: i.identifier, title: i.title, description: i.body, url: '', priority: 2, updatedAt: '2026-09-28T00:00:00Z', state: { type: 'started' } })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    throw new Error('unexpected mutation');
  }) as typeof fetch;
  const deps = { root, fetch: fetchFn, getSecret: async () => 'key', judge: async (issue: TriageIssue) => ({ rung: 4, dependsOn: issue.identifier === 'ELA-1' ? ['ELA-2'] : [], priority: 2, why: 'depends' }), decide: () => true };
  try {
    for (const stage of ['sync', 'triage', 'schedule'] as const) await runStewardStage(stage, deps);
    const rows = JSON.parse(readFileSync(join(root, 'steward', 'schedule.json'), 'utf8')) as Array<{ issue: string; disposition: string }>;
    expect(rows.find(row => row.issue === 'ELA-1')?.disposition).toBe('now');
    expect(calls.filter(query => query.includes('identifier:{in:'))).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('card write failure warns and does not block observe report, comments or digest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-card-failure-'));
  const warnings: string[] = [];
  const calls: string[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    calls.push(query);
    if (query.includes('commentCreate(')) return Response.json({ data: { commentCreate: { success: true } } });
    throw new Error('unexpected request');
  }) as typeof fetch;
  const digests: string[] = [];
  try {
    const dir = join(root, 'steward');
    mkdirSync(dir);
    writeFileSync(join(dir, 'issues.json'), JSON.stringify(issues));
    writeFileSync(join(dir, 'schedule.json'), JSON.stringify(scheduleTriage([{ issue: 'ELA-1', rung: 4, dependsOn: [], priority: 1, why: 'needs work' }])));
    await runStewardStage('report', { root, fetch: fetchFn, getSecret: async () => 'key',
      cardStore: { createCard: () => { throw new Error('disk unavailable'); }, appendSection: () => { throw new Error('unexpected'); }, close: () => {} },
      warn: message => warnings.push(message), sendDigest: async text => { digests.push(text); }, now: () => new Date('2026-09-28T00:00:00Z') });
    expect(warnings).toEqual(['steward report: card write failed: disk unavailable']);
    expect(calls.filter(query => query.includes('commentCreate('))).toHaveLength(1);
    expect(digests).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('observe stages only fetch, judge, schedule and comment; no task spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-test-'));
  const calls: string[] = [];
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    calls.push(query);
    if (query.includes('issues(')) return Response.json({ data: { issues: { nodes: issues.map(i => ({ id: i.ref, identifier: i.identifier, title: i.title, description: i.body, url: '', priority: 2, updatedAt: '2026-09-28T00:00:00Z', state: { type: 'started' } })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (query.includes('commentCreate(')) return Response.json({ data: { commentCreate: { success: true } } });
    throw new Error('unexpected mutation');
  };
  const digest: string[] = [];
  const deps = { root, fetch: fetchFn as typeof fetch, getSecret: async () => 'private-token',
    judge: async () => ({ rung: 4, dependsOn: [], priority: 2, why: 'investigate' }),
    decide: () => true, sendDigest: async (text: string) => { digest.push(text); }, now: () => new Date('2026-09-28T00:00:00Z') };
  try {
    for (const stage of ['sync', 'triage', 'schedule', 'report', 'report'] as const) await runStewardStage(stage, deps);
    expect(calls.filter(q => q.includes('commentCreate('))).toHaveLength(2);
    expect(digest).toHaveLength(1);
    const store = new CardStore(root);
    try {
      const cards = store.listCards();
      expect(cards).toHaveLength(2);
      expect(cards.every(card => card.sections.length === 2 && card.sections.every(section => section.owner === 'steward'))).toBe(true);
    } finally { store.close(); }
    expect(calls.every(q => q.includes('issues(') || q.includes('commentCreate('))).toBe(true);
    expect(readFileSync(join(root, 'steward', 'schedule.json'), 'utf8')).not.toContain('private-token');
    for (const file of ['issues.json', 'triage.json', 'schedule.json', 'observe.json']) {
      expect(readFileSync(join(root, 'steward', file), 'utf8')).not.toContain('private-token');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a HITL judgment without one of the four named reasons stays HITL as other instead of failing the stage', async () => {
  const quiet = [{ identifier: 'ELA-12', ref: 'twelve', title: '문서 방향 결정', body: '' }];
  const result = await triageIssues(quiet, async () => ({ rung: 'hitl', dependsOn: [], priority: 1, why: '방향을 사람이 정해야 한다', hitlReason: null }), () => true);
  expect(result).toHaveLength(1);
  expect(result[0]?.rung).toBe('hitl');
  expect(result[0]?.hitlReason).toBe('other');
});

test('one malformed judgment goes to a human and the other issues are still triaged', async () => {
  const both: TriageIssue[] = [
    { identifier: 'ELA-20', ref: 'a', title: '기반 정리', body: '' },
    { identifier: 'ELA-21', ref: 'b', title: '셸 한 줄', body: '' },
  ];
  const result = await triageIssues(both, async (issue) => issue.identifier === 'ELA-20'
    ? 'not json'
    : { rung: 1, dependsOn: [], priority: 2, why: 'shell' }, () => true);
  expect(result.map((d) => [d.issue, d.rung, d.hitlReason ?? null])).toEqual([['ELA-20', 'hitl', 'other'], ['ELA-21', 1, null]]);
});

test('a malformed judgment is retried by the triage stage after recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-triage-retry-'));
  const dir = join(root, 'steward');
  mkdirSync(dir);
  writeFileSync(join(dir, 'issues.json'), JSON.stringify([issues[0]]));
  let calls = 0;
  let fail = true;
  try {
    const deps = { root, getSecret: async () => 'key', judge: async () => {
      calls++;
      return fail ? 'not json' : { rung: 4, dependsOn: [], priority: 2, why: 'recovered' };
    }, decide: () => true };
    await runStewardStage('triage', deps);
    const path = join(dir, 'triage.json');
    const failed = JSON.parse(readFileSync(path, 'utf8')) as TriageDecision[];
    expect(failed[0]?.why).toBe('triage judgment unavailable — human review');
    fail = false;
    await runStewardStage('triage', deps);
    expect(calls).toBe(2);
    const recovered = JSON.parse(readFileSync(path, 'utf8')) as TriageDecision[];
    expect(recovered[0]?.rung).toBe(4);
    await runStewardStage('triage', deps);
    expect(calls).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('triage stage rejudges ELA-0 when its injected judge reads a changed ELA-1 body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-triage-context-'));
  const dir = join(root, 'steward');
  mkdirSync(dir);
  const path = join(dir, 'issues.json');
  const pair: TriageIssue[] = [
    { identifier: 'ELA-0', ref: 'zero', title: 'Route', body: 'unchanged' },
    { identifier: 'ELA-1', ref: 'one', title: 'Context', body: 'tech' },
  ];
  const judged: string[] = [];
  const deps = { root, getSecret: async () => 'key', decide: () => true,
    judge: async (issue: TriageIssue, all: TriageIssue[]) => {
      judged.push(issue.identifier);
      return { rung: 4, dependsOn: [], priority: 2,
        why: issue.identifier === 'ELA-0' ? `routed by ${all[1]!.body}` : 'independent' };
    } };
  try {
    writeFileSync(path, JSON.stringify(pair));
    await runStewardStage('triage', deps);
    const first = JSON.parse(readFileSync(join(dir, 'triage.json'), 'utf8')) as Array<TriageDecision & { contextInputs?: string[] }>;
    expect(first[0]?.contextInputs).toEqual(['ELA-1']);
    expect(first[1]?.contextInputs).toBeUndefined();
    judged.length = 0;
    writeFileSync(path, JSON.stringify([pair[0], { ...pair[1]!, body: 'content' }]));
    await runStewardStage('triage', deps);
    const second = JSON.parse(readFileSync(join(dir, 'triage.json'), 'utf8')) as TriageDecision[];
    expect(judged).toEqual(['ELA-0', 'ELA-1']);
    expect(second[0]?.why).toBe('routed by content');
    judged.length = 0;
    await runStewardStage('triage', deps);
    expect(judged).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('triage stage treats corrupt previous JSON as empty and only emits newly judged decisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-triage-cache-'));
  const dir = join(root, 'steward');
  mkdirSync(dir);
  const path = join(dir, 'triage.json');
  const judged: string[] = [];
  const events: unknown[] = [];
  const deps = { root, getSecret: async () => 'key', judge: async (issue: TriageIssue) => {
    judged.push(issue.identifier);
    return { rung: 4, dependsOn: [], priority: 2, why: 'new judgment' };
  }, decide: (event: any) => { events.push(event); return true; } };
  try {
    writeFileSync(join(dir, 'issues.json'), JSON.stringify(issues));
    writeFileSync(path, '{broken');
    await runStewardStage('triage', deps);
    expect(judged).toEqual(['ELA-1', 'ELA-2']);
    expect(events).toHaveLength(2);
    const first = JSON.parse(readFileSync(path, 'utf8')) as Array<TriageDecision & { inputHash: string }>;
    expect(first.map((row, n) => row.inputHash === triageInputHash(issues[n]!, issues))).toEqual([true, true]);
    judged.length = 0;
    events.length = 0;
    await runStewardStage('triage', deps);
    expect(judged).toEqual([]);
    expect(events).toHaveLength(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(first);
    writeFileSync(join(dir, 'issues.json'), JSON.stringify([issues[0], { ...issues[1]!, body: 'changed' }]));
    await runStewardStage('triage', deps);
    expect(judged).toEqual(['ELA-2']);
    expect(events).toHaveLength(1);
    judged.length = 0;
    events.length = 0;
    writeFileSync(join(dir, 'issues.json'), JSON.stringify([issues[0], { ...issues[1]!, title: 'renamed', body: 'changed' }]));
    await runStewardStage('triage', deps);
    expect(judged).toEqual(['ELA-1', 'ELA-2']);
    expect(events).toHaveLength(2);
    const legacy = first.map(({ inputHash: _hash, ...row }) => row);
    writeFileSync(path, JSON.stringify(legacy));
    judged.length = 0;
    events.length = 0;
    await runStewardStage('triage', deps);
    expect(judged).toEqual(['ELA-1', 'ELA-2']);
    expect(events).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const TRACKS = {
  S: 'COO — release ladder, integration, decisions, handoffs',
  T: 'CMO — content, website, blog, ads, teaser',
  O: 'CTO — tech, harness back half, PRs, review, observability, release loop, intake',
  F: 'front features and channels — PWA, Android, iOS, desktop, messengers, UX',
};

test('owner track: the table reaches the judge, only its keys survive, schedule caps by owner', async () => {
  const fields: Array<[string, string]> = [['ELA-11', 'O'], ['ELA-12', 'T'], ['ELA-13', 'F'], ['ELA-14', 'S']];
  const four: TriageIssue[] = [
    { identifier: 'ELA-11', ref: 'a', title: 'Release gate flakes on shard 7', body: '' },
    { identifier: 'ELA-12', ref: 'b', title: 'Draft the 0.2.5 blog post', body: '' },
    { identifier: 'ELA-13', ref: 'c', title: 'Chat input collapses on a phone', body: '' },
    { identifier: 'ELA-14', ref: 'd', title: 'Cut 0.2.5 and post the checklist', body: '' },
  ];
  const seen: Array<Record<string, string> | undefined> = [];
  const expected = new Map(fields);
  const result = await triageIssues(four, async (issue, _all, tracks) => {
    seen.push(tracks);
    return { rung: 4, dependsOn: [], priority: 1, why: 'fits', owner: expected.get(issue.identifier) };
  }, () => true, TRACKS);
  expect(seen.every(t => t === TRACKS)).toBe(true);
  expect(result.map(d => [d.issue, d.owner])).toEqual(fields);
  const off = await triageIssues(four.slice(0, 1), async () => ({ rung: 4, dependsOn: [], priority: 1, why: 'x', owner: 'Z' }), () => true, TRACKS);
  expect(off[0]?.owner).toBeUndefined();
  const none = await triageIssues(four.slice(0, 1), async () => ({ rung: 4, dependsOn: [], priority: 1, why: 'x', owner: 'O' }), () => true);
  expect(none[0]?.owner).toBeUndefined();
  const scheduled = scheduleTriage([...result, { issue: 'ELA-15', rung: 4, dependsOn: [], priority: 2, why: 'more', owner: 'O' }], { roles: { O: { maxConcurrent: 1 } } });
  expect(scheduled.filter(d => d.owner === 'O').map(d => d.disposition)).toEqual(['now', 'wait']);
});

test('track table prompt lists every key and is empty without a table', () => {
  const text = trackTablePrompt(TRACKS);
  for (const k of Object.keys(TRACKS)) expect(text).toContain(`- ${k}: `);
  expect(text).toContain('"S"|"T"|"O"|"F"');
  expect(trackTablePrompt(undefined)).toBe('');
});

test('config parses steward tracks and drops bad keys or empty descriptions', () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-tracks-'));
  const path = join(root, 'config.json');
  try {
    writeFileSync(path, JSON.stringify({ loops: { steward: { tracks: { ...TRACKS, '9x': 'bad key', E: '  ', G: 3 } } } }));
    expect(buildUserConfig(path).loops?.steward?.tracks).toEqual(TRACKS);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
