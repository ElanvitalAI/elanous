import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { buildUserConfig } from '../user-config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleTriage, trackTablePrompt, triageIssues, runStewardStage, type TriageIssue, type TriageDecision } from './triage.js';
import { CardStore } from '../task-cards/card-store.js';

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
