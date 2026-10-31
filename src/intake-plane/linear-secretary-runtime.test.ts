import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explicitLinearDueDates, explicitLinearTeamOnlyKey, runLinearSecretaryRequest } from './linear-secretary-runtime.js';

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('explicit due-date parsing does not treat version decimals as dates', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  expect(explicitLinearDueDates('0.2.43 준비, 11-04 마감', now)).toEqual(['2026-11-04']);
  expect(explicitLinearDueDates('버전 1.5와 2.3 확인', now)).toEqual([]);
  expect(explicitLinearDueDates('10-28 과거 마감, 2026-10-28도 지난 날짜', now)).toEqual([]);
  expect(explicitLinearDueDates('2027-01-02 마감', new Date('2026-12-31T12:00:00.000Z'))).toEqual(['2027-01-02']);
});

test('team-only Linear destination requires the explicit projectless marker and validates team key syntax', () => {
  expect(explicitLinearTeamOnlyKey('demo canary projectless=true teamKey=DEMO due 2026-11-05')).toBe('DEMO');
  expect(explicitLinearTeamOnlyKey('PROJECTLESS = TRUE TEAMKEY = demo due 2026-11-05')).toBe('DEMO');
  expect(explicitLinearTeamOnlyKey('teamKey=Q work projectless=true due 2026-11-05')).toBe('Q');
  expect(explicitLinearTeamOnlyKey('use DEMO team, without project')).toBeUndefined();
  expect(() => explicitLinearTeamOnlyKey('projectless=true teamKey=ELA!')).toThrow('explicit teamKey');
  expect(() => explicitLinearTeamOnlyKey('projectless=true without a team key')).toThrow('explicit teamKey');
  expect(() => explicitLinearTeamOnlyKey('projectless=true teamKey=DEMO teamKey=UX')).toThrow('explicit teamKey');
});

test('malformed projectless destination fails at the secretary entry point before any Linear write', async () => {
  let projectResolverCalls = 0;
  await expect(runLinearSecretaryRequest('projectless=true due 2026-11-05', {
    getApiKey: async () => 'test-key',
    getProject: () => { projectResolverCalls++; return 'configured project'; },
    fetch: Object.assign(async () => { throw new Error('Linear network access should not run'); }, { preconnect: globalThis.fetch.preconnect }),
  })).rejects.toThrow('projectless=true requires an explicit teamKey=<KEY>');
  expect(projectResolverCalls).toBe(0);
});

test('projectless secretary request honors the explicit team and never resolves a configured project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'linear-secretary-projectless-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src', 'scope.md'), 'projectless=true teamKey=DEMO team scope evidence');
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let projectResolverCalls = 0;
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    if (/CooProjects|DecisionProjectTeam/.test(body.query)) throw new Error('project lookup must not run');
    if (body.query.includes('LinearSecretaryViewer')) return Response.json({ data: { viewer: { id: 'viewer-1' } } });
    if (body.query.includes('LinearTeamByKey')) return Response.json({ data: { teams: { nodes: [{ id: 'team-demo', states: { nodes: [{ id: 'state-started', type: 'started' }] } }] } } });
    if (body.query.includes('LinearTeamIssueCreate')) return Response.json({ data: { issueCreate: { success: true, issue: { id: `created-${calls.filter(call => call.query.includes('LinearTeamIssueCreate')).length}` } } } });
    if (body.query.includes('LinearIssueDescriptionUpdate')) return Response.json({ data: { issueUpdate: { success: true } } });
    throw new Error(`unexpected Linear operation: ${body.query}`);
  }) as typeof fetch;
  const dueDate = '2026-11-05';
  const result = await runLinearSecretaryRequest(`projectless=true teamKey=DEMO demo due ${dueDate}`, {
    getApiKey: async () => 'test-key',
    getProject: () => { projectResolverCalls++; return 'wrong/default project'; },
    repositoryRoot: root,
    fetch: fakeFetch,
    plan: async (_request, evidence, _now, allowedDates) => {
      expect(allowedDates).toEqual([dueDate]);
      return {
        title: 'Grounded parent', rationale: 'Use the matched source', dueDate,
        tasks: [1, 2, 3].map(n => ({ title: `Task ${n}`, intent: `Intent ${n}`, dueDate, refs: [evidence[0]!.link] })),
      };
    },
  });
  expect(result.childIssueIds).toHaveLength(3);
  expect(projectResolverCalls).toBe(0);
  const writes = calls.filter(call => call.query.includes('LinearTeamIssueCreate'));
  expect(writes).toHaveLength(4);
  expect(writes.map(call => call.variables.input)).toEqual([
    { teamId: 'team-demo', title: 'Grounded parent', description: expect.any(String), dueDate, assigneeId: 'viewer-1', stateId: 'state-started' },
    ...[1, 2, 3].map(n => ({ teamId: 'team-demo', title: `Task ${n}`, description: expect.any(String), dueDate, assigneeId: 'viewer-1', parentId: 'created-1' })),
  ]);
  expect(writes.every(call => !('projectId' in (call.variables.input as Record<string, unknown>)))).toBe(true);
});
