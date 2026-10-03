import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionLedger } from './decision-ledger.js';
import { projectDecisionsToLinear } from './decision-linear-projection.js';
import { buildUserConfig } from '../user-config.js';

const project = '외부 행정·큰 일 (COO)';
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'decision-linear-'));
  const ledger = new DecisionLedger({ stateDir, now: () => new Date('2026-10-02T10:00:00Z'), resolveVersion: () => ({ released: null, dev: null, codename: null }) });
  const calls: Array<{ query: string; variables: any }> = [];
  let failId: string | undefined;
  let existingIssue: string | undefined;
  let failClose = false;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const call = JSON.parse(init.body as string);
    calls.push(call);
    const { query, variables } = call;
    if (query.includes('CooProjects')) return Response.json({ data: { projects: { nodes: [{ id: 'p1', name: project }], pageInfo: { hasNextPage: false } } } });
    if (query.includes('DecisionIssue(')) return Response.json({ data: { issues: { nodes: existingIssue ? [{ id: existingIssue, description: `결정 id: ${variables.decisionId}` }] : [] } } });
    if (query.includes('DecisionProjectTeam')) return Response.json({ data: { project: { teams: { nodes: [{ id: 't1' }] } } } });
    if (query.includes('DecisionIssueCreate')) {
      if (variables.input.description.includes(`결정 id: ${failId}`)) return new Response('error', { status: 500 });
      return Response.json({ data: { issueCreate: { success: true, issue: { id: `issue-${calls.filter(c => c.query.includes('DecisionIssueCreate')).length}` } } } });
    }
    if (query.includes('DecisionComment')) return Response.json({ data: { commentCreate: { success: true, comment: { id: 'comment-1' } } } });
    if (query.includes('DecisionIssueStates')) return Response.json({ data: { issue: { team: { states: { nodes: [{ id: 'done', type: 'completed' }, { id: 'cancel', type: 'canceled' }] } } } } });
    if (query.includes('DecisionIssueClose')) {
      if (failClose) { failClose = false; return new Response('error', { status: 500 }); }
      return Response.json({ data: { issueUpdate: { success: true } } });
    }
    throw new Error('unexpected GraphQL query');
  }) as typeof fetch;
  const deps = { stateDir, ledger, fetch: fetchFn, config: { decisions: { linearProjection: { enabled: true } }, coo: { linearProject: project } }, getSecret: async () => 'key' };
  const raise = (title: string) => ledger.raise({ title, category: 'publish', scqa: { s: 'SCQA private.', c: 'SCQA confidential.' },
    options: [{ key: 'a', label: 'Secret option', consequence: 'private result' }, { key: 'b', label: 'Hold', consequence: 'private' }],
    recommendation: { skipped: true, reason: 'Private' }, raisedBy: { agent: 'test' }, dueAt: '2026-10-04T09:00:00Z', refs: ['https://example.com/ref', '/private/path'] });
  return { stateDir, ledger, calls, deps, raise, failOn: (id: string) => { failId = id; }, existing: (id: string) => { existingIssue = id; }, failNextClose: () => { failClose = true; }, dispose: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test('two open decisions create once each, keep only allowed fields, decided and withdrawn close exactly once', async () => {
  const f = fixture();
  try {
    const a = f.raise('Publish?'); const b = f.raise('Withdraw?');
    expect(await projectDecisionsToLinear(f.deps)).toMatchObject({ created: 2, closed: 0, failed: 0 });
    expect(f.calls.filter(c => c.query.includes('DecisionIssueCreate'))).toHaveLength(2);
    const input = f.calls.find(c => c.query.includes('DecisionIssueCreate'))!.variables.input;
    expect(input).toMatchObject({ projectId: 'p1', teamId: 't1', title: '[결정] Publish?', dueDate: '2026-10-04' });
    expect(input.description).toContain(`결정 id: ${a.id}`);
    expect(input.description).toContain('https://example.com/ref');
    for (const privateText of ['SCQA private', 'SCQA confidential', 'Secret option', 'private result', '/private/path']) expect(input.description).not.toContain(privateText);
    const path = join(f.stateDir, 'decisions', 'linear-projection.json');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(state).sort()).toEqual([a.id, b.id]);
    expect(state[a.id].issue).toBeTruthy(); expect(state[b.id].issue).toBeTruthy();
    expect(await projectDecisionsToLinear(f.deps)).toMatchObject({ created: 0, skipped: 2 });
    f.ledger.decide(a.id, 'a', { kind: 'human' }, 'private note');
    f.ledger.withdraw(b.id, 'private withdrawal reason');
    const beforeDryRun = f.calls.length;
    expect(await projectDecisionsToLinear({ ...f.deps, dryRun: true })).toMatchObject({ closed: 2, plan: [
      { decisionId: a.id, action: 'close' }, { decisionId: b.id, action: 'close' },
    ] });
    expect(f.calls).toHaveLength(beforeDryRun);
    expect(await projectDecisionsToLinear(f.deps)).toMatchObject({ closed: 2, failed: 0 });
    const comments = f.calls.filter(c => c.query.includes('DecisionComment'));
    expect(comments.map(c => c.variables.input.body)).toEqual(['결정됨: a · human · 2026-10-02T10:00:00.000Z', '철회됨']);
    expect(f.calls.filter(c => c.query.includes('DecisionIssueClose')).map(c => c.variables.input.stateId)).toEqual(['done', 'cancel']);
    expect(JSON.parse(readFileSync(path, 'utf8'))[a.id].closedAt).toBeTruthy();
    expect(await projectDecisionsToLinear(f.deps)).toMatchObject({ closed: 0, created: 0, skipped: 2 });
    expect(f.calls.filter(c => c.query.includes('DecisionComment'))).toHaveLength(2);
  } finally { f.dispose(); }
});

test('disabled and missing key never fetch; dry run describes actions without mutations or state writes', async () => {
  const f = fixture();
  try {
    f.raise('Open');
    const disabled = await projectDecisionsToLinear({ ...f.deps, config: { ...f.deps.config, decisions: { linearProjection: { enabled: false } } } });
    expect(disabled.created).toBe(0); expect(disabled.reason).toContain('꺼짐'); expect(f.calls).toHaveLength(0);
    const missing = await projectDecisionsToLinear({ ...f.deps, getSecret: async () => undefined });
    expect(missing.reason).toBe('Linear 키가 없습니다 — `elanous connector linear set-key`'); expect(f.calls).toHaveLength(0);
    expect(await projectDecisionsToLinear({ ...f.deps, dryRun: true })).toMatchObject({ created: 1, plan: [{ action: 'create' }] });
    let keyRead = false;
    expect(await projectDecisionsToLinear({ ...f.deps, dryRun: true, getSecret: async () => { keyRead = true; return undefined; } })).toMatchObject({ plan: [{ action: 'create' }] });
    expect(keyRead).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(existsSync(join(f.stateDir, 'decisions', 'linear-projection.json'))).toBe(false);
  } finally { f.dispose(); }
});

test('one HTTP 500 does not prevent the next decision from creating', async () => {
  const f = fixture();
  try {
    const first = f.raise('First'); f.raise('Second'); f.failOn(first.id);
    expect(await projectDecisionsToLinear(f.deps)).toMatchObject({ created: 1, failed: 1 });
    expect(Object.keys(JSON.parse(readFileSync(join(f.stateDir, 'decisions', 'linear-projection.json'), 'utf8')))).toHaveLength(1);
  } finally { f.dispose(); }
});

test('crash recovery reuses an existing remote issue; a failed move retries without duplicate comment', async () => {
  const f = fixture();
  try {
    const entry = f.raise('Recovery'); f.existing('remote-1');
    expect(await projectDecisionsToLinear(f.deps)).toMatchObject({ created: 0, skipped: 1, failed: 0 });
    expect(f.calls.filter(c => c.query.includes('DecisionIssueCreate'))).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(f.stateDir, 'decisions', 'linear-projection.json'), 'utf8'))[entry.id].issue).toBe('remote-1');
    f.ledger.decide(entry.id, 'a', { kind: 'human' }); f.failNextClose();
    expect(await projectDecisionsToLinear(f.deps)).toMatchObject({ closed: 0, failed: 1 });
    expect(await projectDecisionsToLinear(f.deps)).toMatchObject({ closed: 1, failed: 0 });
    expect(f.calls.filter(c => c.query.includes('DecisionComment'))).toHaveLength(1);
  } finally { f.dispose(); }
});

test('corrupt state is rejected without fetching or creating a duplicate issue', async () => {
  const f = fixture();
  try {
    f.raise('No duplicates');
    const path = join(f.stateDir, 'decisions', 'linear-projection.json');
    writeFileSync(path, '{broken');
    await expect(projectDecisionsToLinear(f.deps)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  } finally { f.dispose(); }
});

test('real isolated CLI dry run remains disabled after a decision is raised', () => {
  const f = fixture();
  try {
    f.raise('Real CLI');
    const run = spawnSync('bun', ['bin/elanous.mjs', `--test=${f.stateDir}`, 'decisions', 'linear-sync', '--dry-run', '--json'],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 240000 });
    expect(run.status, run.stderr.slice(0, 500)).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toMatchObject({ created: 0, closed: 0, reason: 'decisions.linearProjection.enabled 꺼짐' });
    expect(existsSync(join(f.stateDir, 'decisions', 'linear-projection.json'))).toBe(false);
  } finally { f.dispose(); }
});

test('user config projection is strictly opt-in', () => {
  const f = fixture();
  try {
    expect(buildUserConfig(join(f.stateDir, 'absent.json')).decisions?.linearProjection.enabled).toBe(false);
    const path = join(f.stateDir, 'config.json');
    Bun.write(path, JSON.stringify({ decisions: { linearProjection: { enabled: 'true' } } }));
    expect(buildUserConfig(path).decisions?.linearProjection.enabled).toBe(false);
    Bun.write(path, JSON.stringify({ decisions: { linearProjection: { enabled: true } } }));
    expect(buildUserConfig(path).decisions?.linearProjection.enabled).toBe(true);
  } finally { f.dispose(); }
});
