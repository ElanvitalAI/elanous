import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDemoLinearMissionLink, syncLinearMissionProgress } from './linear-mission-sync.js';

const testLockRoot = mkdtempSync(join(tmpdir(), 'linear-mission-sync-suite-'));
afterAll(() => rmSync(testLockRoot, { recursive: true, force: true }));

function linearFetch(issue: { id: string; team: { key: string }; parent?: { id: string } | null; state?: { type: string } } | undefined, calls: Array<{ query: string; variables: Record<string, unknown> }>): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    let data: unknown;
    if (body.query.includes('LinearMissionIssueIdentity')) data = { issue };
    else if (body.query.includes('LinearIssueTransitionGuard')) data = {
      issue: {
        state: { type: issue?.state?.type },
        team: { states: { nodes: [{ id: 'started-id', type: 'started' }, { id: 'completed-id', type: 'completed' }] } },
      },
    };
    else if (body.query.includes('LinearIssueStatus')) data = { issue: { state: { type: issue?.state?.type } } };
    else if (body.query.includes('DecisionIssueStates')) data = { issue: { team: { states: { nodes: [{ id: 'started-id', type: 'started' }, { id: 'completed-id', type: 'completed' }] } } } };
    else data = { issueUpdate: { success: true } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('Linear mission progress sync', () => {
  it('binds only a DEMO child issue and stores parent identity', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const link = await resolveDemoLinearMissionLink('DEMO-42', { getApiKey: async () => 'test-key', fetch: linearFetch({ id: 'issue-id', team: { key: 'DEMO' }, parent: { id: 'parent-id' }, state: { type: 'unstarted' } }, calls) });
    expect(link).toEqual({ teamKey: 'DEMO', issueId: 'issue-id', parentIssueId: 'parent-id' });
    await expect(resolveDemoLinearMissionLink('DEMO-missing', { getApiKey: async () => 'test-key', fetch: linearFetch(undefined, []) })).rejects.toThrow('identity is incomplete');
    await expect(resolveDemoLinearMissionLink('DEMO-43', { getApiKey: async () => 'test-key', fetch: linearFetch({ id: 'other', team: { key: 'ENG' }, parent: { id: 'parent-id' }, state: { type: 'unstarted' } }, []) })).rejects.toThrow('DEMO 팀');
    await expect(resolveDemoLinearMissionLink('DEMO-44', { getApiKey: async () => 'test-key', fetch: linearFetch({ id: 'parent', team: { key: 'DEMO' }, state: { type: 'unstarted' } }, []) })).rejects.toThrow('하위 이슈');
  });

  it('moves an unstarted task to started on progress and completed on final', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetch = linearFetch({ id: 'issue-id', team: { key: 'DEMO' }, parent: { id: 'parent-id' }, state: { type: 'unstarted' } }, calls);
    const link = { teamKey: 'DEMO' as const, issueId: 'issue-id', parentIssueId: 'parent-id' };
    await syncLinearMissionProgress({ link, lineType: 'progress' }, { getApiKey: async () => 'test-key', fetch, lockRoot: testLockRoot });
    expect(calls.some(call => call.query.includes('LinearIssueTransitionGuard'))).toBe(true);
    expect(calls.filter(call => call.query.includes('mutation LinearIssueTransition')).map(call => call.variables.input)).toEqual([{ stateId: 'started-id' }]);
    calls.length = 0;
    await syncLinearMissionProgress({ link, lineType: 'final' }, { getApiKey: async () => 'test-key', fetch, lockRoot: testLockRoot });
    expect(calls.filter(call => call.query.includes('mutation LinearIssueTransition')).map(call => call.variables.input)).toEqual([{ stateId: 'completed-id' }]);
  });

  it('leaves non-unstarted workflow states unchanged on progress', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    await syncLinearMissionProgress({ link: { teamKey: 'DEMO', issueId: 'issue-id', parentIssueId: 'parent-id' }, lineType: 'progress' }, {
      getApiKey: async () => 'test-key', fetch: linearFetch({ id: 'issue-id', team: { key: 'DEMO' }, parent: { id: 'parent-id' }, state: { type: 'backlog' } }, calls), lockRoot: testLockRoot,
    });
    expect(calls.some(call => call.query.includes('mutation LinearIssueTransition'))).toBe(false);
  });

  it('serializes concurrent progress/final updates and lets the latest accepted final win', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'linear-mission-sync-'));
    try {
      const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
      let state = 'unstarted';
      let latestLine = { lineType: 'progress', sequence: 1 };
      let unblockFirstStatus!: () => void;
      let signalFirstStatus!: () => void;
      const firstStatusStarted = new Promise<void>(resolve => { signalFirstStatus = resolve; });
      const firstStatusGate = new Promise<void>(resolve => { unblockFirstStatus = resolve; });
      let statusCalls = 0;
      const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
        calls.push(body);
        if (body.query.includes('LinearIssueTransitionGuard')) {
          statusCalls += 1;
          if (statusCalls === 1) { signalFirstStatus(); await firstStatusGate; }
          const data = { issue: {
            state: { type: state },
            team: { states: { nodes: [{ id: 'started-id', type: 'started' }, { id: 'completed-id', type: 'completed' }] } },
          } };
          return new Response(JSON.stringify({ data }), { status: 200 });
        }
        if (body.query.includes('DecisionIssueStates')) return new Response(JSON.stringify({ data: { issue: { team: { states: { nodes: [{ id: 'started-id', type: 'started' }, { id: 'completed-id', type: 'completed' }] } } } } }), { status: 200 });
        const stateId = (body.variables.input as { stateId: string }).stateId;
        state = stateId === 'completed-id' ? 'completed' : 'started';
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 });
      }) as unknown as typeof globalThis.fetch;
      const link = { teamKey: 'DEMO' as const, issueId: 'issue-id', parentIssueId: 'parent-id' };
      const deps = { getApiKey: async () => 'test-key', fetch, lockRoot, getLatestLine: async () => latestLine };
      const progress = syncLinearMissionProgress({ link, lineType: 'progress', sequence: 1, latestLine: latestLine }, deps);
      await firstStatusStarted;
      latestLine = { lineType: 'final', sequence: 2 };
      const final = syncLinearMissionProgress({ link, lineType: 'final', sequence: 2, latestLine }, deps);
      unblockFirstStatus();
      await Promise.all([progress, final]);
      expect(state).toBe('completed');
      expect(calls.filter(call => call.query.includes('mutation LinearIssueTransition')).map(call => call.variables.input).at(-1)).toEqual({ stateId: 'completed-id' });
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
  });

  it('does not regress a completed or canceled issue', async () => {
    for (const stateType of ['completed', 'canceled']) {
      const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
      for (const lineType of ['progress', 'final']) {
        await syncLinearMissionProgress({ link: { teamKey: 'DEMO', issueId: 'issue-id', parentIssueId: 'parent-id' }, lineType }, {
          getApiKey: async () => 'test-key', fetch: linearFetch({ id: 'issue-id', team: { key: 'DEMO' }, parent: { id: 'parent-id' }, state: { type: stateType } }, calls), lockRoot: testLockRoot,
        });
      }
      expect(calls.some(call => call.query.includes('mutation LinearIssueTransition'))).toBe(false);
    }
  });
});
