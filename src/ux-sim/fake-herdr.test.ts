import { describe, expect, test } from 'bun:test';

import { createFakeHerdr } from './fake-herdr.js';

describe('fake-herdr device', () => {
  test('agent get answers by pane id and by name · unknown target is agent_not_found rc1 on stderr', async () => {
    const h = createFakeHerdr({ panes: [{ paneId: 'w1:p1', agent: 'elanous', name: 'opt', status: 'idle' }] });
    const byPane = await h.run(['agent', 'get', 'w1:p1'], 1000);
    expect(byPane.code).toBe(0);
    expect(JSON.parse(byPane.stdout).result.agent).toMatchObject({ agent: 'elanous', agent_status: 'idle', pane_id: 'w1:p1', name: 'opt' });
    const byName = await h.run(['agent', 'get', 'opt'], 1000);
    expect(JSON.parse(byName.stdout).result.agent.pane_id).toBe('w1:p1');
    const missing = await h.run(['agent', 'get', 'nope'], 1000);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stderr).error.code).toBe('agent_not_found');
  });

  test('agent wait returns at once when the status matches, else on the next matching transition, else timeout', async () => {
    const h = createFakeHerdr({ panes: [{ paneId: 'w1:p1', agent: 'elanous', status: 'idle' }] });
    expect((await h.run(['agent', 'wait', 'w1:p1'], 1000)).code).toBe(0);
    const pending = h.run(['agent', 'wait', 'w1:p1', '--until', 'working', '--timeout', '1000'], 2000);
    h.setStatus('w1:p1', 'working');
    const woke = await pending;
    expect(woke.code).toBe(0);
    expect(JSON.parse(woke.stdout).result.agent.agent_status).toBe('working');
    const late = await h.run(['agent', 'wait', 'w1:p1', '--until', 'blocked', '--timeout', '20'], 1000);
    expect(late.code).toBe(1);
    expect(JSON.parse(late.stderr).error.code).toBe('timeout');
  });

  test('pane run records the submission and hands it to onRun · setStatus bumps state_change_seq', async () => {
    const h = createFakeHerdr({
      panes: [{ paneId: 'w1:p1', agent: 'elanous', status: 'idle' }],
      onRun: (s, herdr) => { herdr.setStatus(s.paneId, 'working'); },
    });
    expect((await h.run(['pane', 'run', 'w1:p1', 'hello'], 1000)).code).toBe(0);
    expect(h.submissions()).toEqual([{ paneId: 'w1:p1', text: 'hello' }]);
    expect(h.pane('w1:p1')).toMatchObject({ status: 'working', stateChangeSeq: 2 });
    expect((await h.run(['pane', 'run', 'w9:p9', 'x'], 1000)).code).toBe(1);
    expect(h.calls().map((a) => a.slice(0, 2).join(' '))).toEqual(['pane run', 'pane run']);
  });
});

describe('fake-herdr — pane report-agent / release-agent seq rule (herdr 0.9.1 · 10-22 tf-exit-race)', () => {
  const report = (seq: number, state = 'idle') =>
    ['pane', 'report-agent', 'w1:p1', '--source', 'custom:elanous', '--agent', 'elanous', '--state', state, '--seq', String(seq)];
  const release = (seq: number) => ['pane', 'release-agent', 'w1:p1', '--source', 'custom:elanous', '--agent', 'elanous', '--seq', String(seq)];
  const listed = async (h: ReturnType<typeof createFakeHerdr>): Promise<unknown[]> =>
    JSON.parse((await h.run(['agent', 'list'], 1000)).stdout).result.agents;

  test('report registers · larger seq updates · smaller is ignored rc0 · release removes and records its seq', async () => {
    const h = createFakeHerdr({ panes: [] });
    expect((await h.run(report(300), 1000)).code).toBe(0);
    expect(await listed(h)).toEqual([{ agent: 'elanous', agent_status: 'idle', pane_id: 'w1:p1' }]);
    await h.run(report(302, 'working'), 1000);
    await h.run(report(301, 'idle'), 1000);
    expect(h.reportedAgents()[0]).toMatchObject({ state: 'working', seq: 302 });
    expect((await h.run(release(303), 1000)).code).toBe(0);
    expect(await listed(h)).toEqual([]);
    // 반납 뒤 작은 seq 신고는 무시된다(실측 600 → 602 반납 → 601 working = 0개).
    await h.run(report(302, 'working'), 1000);
    expect(h.reportedAgents()).toEqual([]);
  });

  test('a release of an unregistered agent does not record its seq — a smaller late report still registers (the ghost)', async () => {
    const h = createFakeHerdr({ panes: [] });
    expect((await h.run(release(101), 1000)).code).toBe(0);
    await h.run(report(100), 1000);
    expect(h.reportedAgents()).toHaveLength(1);
    // 다음 기동의 큰 seq 반납은 지운다(실측 500).
    await h.run(release(500), 1000);
    expect(h.reportedAgents()).toEqual([]);
  });

  test('runSync answers report/release/agent list at once with the same rule · refuses waiting commands', () => {
    const h = createFakeHerdr({ panes: [] });
    expect(h.runSync(report(10)).code).toBe(0);
    expect(h.reportedAgents()).toHaveLength(1);
    expect(h.runSync(release(11)).code).toBe(0);
    expect(JSON.parse(h.runSync(['agent', 'list']).stdout).result.agents).toEqual([]);
    expect(h.runSync(['agent', 'wait', 'w1:p1']).code).toBe(2);
    expect(h.calls()).toHaveLength(4);
  });

  test('report-agent-session is rc0 and neither registers nor moves the state seq', async () => {
    const h = createFakeHerdr({ panes: [] });
    const session = ['pane', 'report-agent-session', 'w1:p1', '--source', 'custom:elanous', '--agent', 'elanous', '--agent-session-id', 's', '--session-start-source', 'startup', '--seq', '702'];
    expect((await h.run(session, 1000)).code).toBe(0);
    expect(h.reportedAgents()).toEqual([]);
    await h.run(report(700), 1000);
    await h.run(session, 1000);
    await h.run(report(701, 'working'), 1000);
    expect(h.reportedAgents()[0]).toMatchObject({ state: 'working' });
  });
});

describe('fake-herdr — report faults (TUI-HERDR-STATUS-STALE)', () => {
  const rep = (seq: number, state: string) => ['pane', 'report-agent', 'w1:p1', '--source', 'custom:elanous', '--agent', 'elanous', '--state', state, '--seq', String(seq)];

  test('applied-then-timeout applies the report and answers as a client timeout · timeout answers without applying', async () => {
    const faults = new Map<number, 'applied-then-timeout' | 'timeout'>([[1, 'applied-then-timeout'], [2, 'timeout']]);
    const h = createFakeHerdr({ panes: [], reportFault: (_argv, i) => faults.get(i) });
    expect((await h.run(rep(10, 'idle'), 1000)).code).toBe(0);
    expect(await h.run(rep(11, 'working'), 1000)).toEqual({ code: null, stdout: '', stderr: 'timeout', timedOut: true });
    expect(h.reportedAgents()[0]).toMatchObject({ state: 'working', seq: 11 });
    expect(h.runSync(rep(12, 'idle'))).toMatchObject({ code: null, timedOut: true });
    expect(h.reportedAgents()[0]).toMatchObject({ state: 'working', seq: 11 });
    expect(h.runSync(rep(13, 'idle')).code).toBe(0);
    expect(h.reportedAgents()[0]).toMatchObject({ state: 'idle', seq: 13 });
  });
});
