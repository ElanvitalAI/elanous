import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { buildUserConfig } from '../user-config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleTriage, triageIssues, runStewardStage, type TriageIssue, type TriageDecision } from './triage.js';

const issues: TriageIssue[] = [
  { identifier: 'ELA-1', ref: 'one', title: '기반 구축', body: '' },
  { identifier: 'ELA-2', ref: 'two', title: '유료 판매 시점', body: '' },
];

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

test('a cyclic dependency never schedules either issue now', () => {
  const rows = scheduleTriage([
    { issue: 'ELA-1', rung: 4, dependsOn: ['ELA-2'], priority: 1, why: 'one' },
    { issue: 'ELA-2', rung: 4, dependsOn: ['ELA-1'], priority: 2, why: 'two' },
  ]);
  expect(rows.map(row => row.disposition)).toEqual(['wait', 'wait']);
});

test('22 summaries flow through fake LLM triage and pure scheduler without auto-approving paid/public changes', async () => {
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
    const description = `모의 ${row.rung}${row.hitlReason ? `/${row.hitlReason}` : ''} · 의존 없음 · ${row.disposition}`;
    expect(lines.filter(line => /^\| (?:[1-9]|1[0-9]|2[0-2]) \|/.test(line))[index]).toContain(`| ${description} |`);
  }
});

test('schedule stage checks completed Linear dependencies read-only before releasing a dependent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-dependency-'));
  const calls: string[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    calls.push(query);
    if (query.includes('issues(')) return Response.json({ data: { issues: { nodes: issues.map(i => ({ id: i.ref, identifier: i.identifier, title: i.title, description: i.body, url: '', priority: 2, updatedAt: '2026-09-28T00:00:00Z', state: { type: 'started' } })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (query.includes('issue(id:')) return Response.json({ data: { issue: { identifier: 'ELA-2', state: { type: 'completed' } } } });
    throw new Error('unexpected mutation');
  }) as typeof fetch;
  const deps = { root, fetch: fetchFn, getSecret: async () => 'key', judge: async (issue: TriageIssue) => ({ rung: 4, dependsOn: issue.identifier === 'ELA-1' ? ['ELA-2'] : [], priority: 2, why: 'depends' }), decide: () => true };
  try {
    for (const stage of ['sync', 'triage', 'schedule'] as const) await runStewardStage(stage, deps);
    const rows = JSON.parse(readFileSync(join(root, 'steward', 'schedule.json'), 'utf8')) as Array<{ issue: string; disposition: string }>;
    expect(rows.find(row => row.issue === 'ELA-1')?.disposition).toBe('now');
    expect(calls.filter(query => query.includes('issue(id:'))).toHaveLength(1);
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
    expect(calls.every(q => q.includes('issues(') || q.includes('commentCreate('))).toBe(true);
    expect(readFileSync(join(root, 'steward', 'schedule.json'), 'utf8')).not.toContain('private-token');
    for (const file of ['issues.json', 'triage.json', 'schedule.json', 'observe.json']) {
      expect(readFileSync(join(root, 'steward', file), 'utf8')).not.toContain('private-token');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
