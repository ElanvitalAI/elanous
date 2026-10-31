import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskNotificationQueue, type PendingTaskNotification } from '../agent/task-notification.js';
import { CLASSIC_SIDETAB_MISSION_TOOL_NAME, createClassicSidetabMissionIntegration, createClassicSidetabMissionPairSessionRegistry, createClassicSidetabMissionTool } from './classic-sidetab-mission.js';
import { startClassicSidetabMissionTrio } from './classic-sidetab-mission-trio.js';

test('two completed hands write one synthesis record with attribution rows and notify its path', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sidetab-trio-synthesis-'));
  const notifications: PendingTaskNotification[] = [];
  try {
    const started = await startClassicSidetabMissionTrio({
      mission: 'Compare the candidates for the demo.',
      context: { callId: 'synthesis-call', parentSessionId: 'synthesis-parent' },
      checkGrokAuth: () => ({ ok: false, reason: 'Grok unavailable for this pair run' }),
      spawnVisible: (agent) => agent === 'grok' ? null : { id: `${agent}-pty`, cwd },
      runVisible: async (agent) => ({
        ok: true,
        status: 'completed',
        path: join(cwd, `${agent}.md`),
        content: `${agent} candidate result`,
      }),
      registry: createClassicSidetabMissionPairSessionRegistry(),
      hasSession: () => true,
      killSession: () => {},
      enqueue: (notification) => notifications.push(notification),
      createId: (() => { let id = 0; return () => `synthesis-${++id}`; })(),
    });

    await started.completion;

    expect(notifications).toHaveLength(1);
    const notification = notifications[0]!;
    expect(notification.resultPath).toBeTruthy();
    const synthesisPath = notification.resultPath!;
    const contents = readFileSync(synthesisPath, 'utf8');
    expect(contents).toContain('| codex | Compare the candidates for the demo. |');
    expect(contents).toContain('| claude | Compare the candidates for the demo. |');
    expect(contents).toContain('| codex | Compare the candidates for the demo. | ' + join(cwd, 'codex.md') + ' | 완료 |  |');
    expect(contents).toContain('| claude | Compare the candidates for the demo. | ' + join(cwd, 'claude.md') + ' | 완료 |  |');
    expect(contents).toContain('codex candidate result');
    expect(contents).toContain('claude candidate result');
    expect(contents).toContain('## 채택 결과\n_부모 응답에서 확정_');
    expect(contents).toContain('## 채택 근거\n_부모 응답에서 확정_');
    const resultFiles = readdirSync(join(cwd, '.elanous', 'mission-results'));
    expect(resultFiles).toEqual([synthesisPath.split('/').at(-1)]);
    const payload = JSON.parse(notification.output) as { artifacts: string[]; body: string };
    expect(payload.artifacts).toEqual([synthesisPath]);
    expect(payload.body).toContain(`Synthesis record: ${synthesisPath}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('trio launches three visible agents with the same prompt and enqueues one comparison/adoption notification', async () => {
  const queue = new TaskNotificationQueue();
  queue.clear();
  const registry = createClassicSidetabMissionPairSessionRegistry();
  const spawned: string[] = [];
  const liveSessions = new Set<string>();
  const missions: Array<{ agent: string; mission: string }> = [];
  const delivered: PendingTaskNotification[] = [];
  let id = 0;
  const started = await startClassicSidetabMissionTrio({
    mission: 'Inspect and fix the graph demo.',
    context: { callId: 'trio-call', parentSessionId: 'parent-trio' },
    checkGrokAuth: () => { expect(spawned).toEqual(['claude', 'codex']); return { ok: true }; },
    spawnVisible: (agent) => { spawned.push(agent); const id = `${agent}-pty`; liveSessions.add(id); return { id, cwd: '/work' }; },
    runVisible: async (agent, mission) => {
      missions.push({ agent, mission });
      return { ok: true, status: 'completed', content: `${agent} candidate`, finalScreen: `${agent} raw final frame` };
    },
    registry,
    hasSession: (sessionId) => liveSessions.has(sessionId),
    killSession: (sessionId) => { liveSessions.delete(sessionId); },
    enqueue: (notification) => { delivered.push(notification); queue.enqueue(notification); },
    createId: () => `id-${++id}`,
    now: () => 100,
  });

  expect(spawned).toEqual(['claude', 'codex', 'grok']);
  expect(started.result.members.grok.status).toBe('running');
  await started.completion;
  expect(liveSessions.size).toBe(0);
  expect([...liveSessions]).toEqual([]);
  expect(missions).toHaveLength(3);
  expect(new Set(missions.map((entry) => entry.mission))).toEqual(new Set(['Inspect and fix the graph demo.']));
  expect(queue.drainForParentSession('other-parent')).toEqual([]);
  const notices = queue.drainForParentSession('parent-trio');
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ taskId: 'trio-call', agentName: 'Codex + Claude + Grok', state: 'done' });
  const payload = JSON.parse(delivered[0]!.output) as { body: string };
  expect(payload.body).toContain('codex candidate');
  expect(payload.body).toContain('claude candidate');
  expect(payload.body).toContain('grok candidate');
  expect(payload.body).toContain('grok final raw PTY screen:\ngrok raw final frame');
  expect(payload.body).toContain('adopted result');

  const second = await startClassicSidetabMissionTrio({
    mission: 'Inspect the same graph demo again.',
    context: { callId: 'trio-call-2', parentSessionId: 'parent-trio' },
    checkGrokAuth: () => ({ ok: true }),
    spawnVisible: (agent) => { spawned.push(agent); const id = `${agent}-pty`; liveSessions.add(id); return { id, cwd: '/work' }; },
    runVisible: async (agent, mission) => {
      missions.push({ agent, mission });
      return { ok: true, status: 'completed', content: `${agent} second candidate` };
    },
    registry,
    hasSession: (sessionId) => liveSessions.has(sessionId),
    killSession: (sessionId) => { liveSessions.delete(sessionId); },
    enqueue: (notification) => { delivered.push(notification); queue.enqueue(notification); },
    createId: () => `id-${++id}`,
  });
  expect(second.result.members.grok.status).toBe('running');
  await second.completion;
  expect(liveSessions.size).toBe(0);
  expect(spawned).toEqual(['claude', 'codex', 'grok', 'claude', 'codex', 'grok']);
  expect(delivered).toHaveLength(2);
  expect(queue.drainForParentSession('parent-trio')).toHaveLength(1);
});

test('unavailable Grok falls back to two hands and discloses why in one notification', async () => {
  const queue = new TaskNotificationQueue();
  queue.clear();
  const spawned: string[] = [];
  const ran: string[] = [];
  const delivered: PendingTaskNotification[] = [];
  let id = 0;
  const started = await startClassicSidetabMissionTrio({
    mission: 'Same goal',
    context: { callId: 'fallback-call', parentSessionId: 'fallback-parent' },
    checkGrokAuth: () => ({ ok: false, reason: 'grok whoami: login required' }),
    spawnVisible: (agent) => { spawned.push(agent); return { id: `${agent}-pty`, cwd: '/work' }; },
    runVisible: async (agent, mission) => { ran.push(`${agent}:${mission}`); return { ok: true, status: 'completed', content: `${agent} candidate` }; },
    registry: createClassicSidetabMissionPairSessionRegistry(),
    hasSession: () => true,
    killSession: () => {},
    enqueue: (notification) => { delivered.push(notification); queue.enqueue(notification); },
    createId: () => `fallback-${++id}`,
  });

  expect(started.result.grokFallback).toBe('grok whoami: login required');
  expect(started.result.members.grok).toMatchObject({ ok: false, status: 'failed' });
  await started.completion;
  expect(spawned).toEqual(['claude', 'codex']);
  expect(ran.sort()).toEqual(['claude:Same goal', 'codex:Same goal']);
  const notices = queue.drainForParentSession('fallback-parent');
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ agentName: 'Codex + Claude (Grok fallback)' });
  expect(delivered).toHaveLength(1);
  const payload = JSON.parse(delivered[0]!.output) as { body: string };
  expect(payload.body).toContain('Grok unavailable; continued with Codex + Claude');
  expect(payload.body).toContain('grok whoami: login required');
});

test('Grok PTY spawn failure still keeps the Codex and Claude missions running', async () => {
  const spawned: string[] = [];
  const ran: string[] = [];
  let id = 0;
  const started = await startClassicSidetabMissionTrio({
    mission: 'Same goal',
    checkGrokAuth: () => ({ ok: true }),
    spawnVisible: (agent) => { spawned.push(agent); return agent === 'grok' ? null : { id: `${agent}-pty`, cwd: '/work' }; },
    runVisible: async (agent) => { ran.push(agent); return { ok: true, status: 'completed', content: 'done' }; },
    registry: createClassicSidetabMissionPairSessionRegistry(),
    hasSession: () => true,
    killSession: () => {},
    enqueue: () => {},
    createId: () => `spawn-${++id}`,
  });
  await started.completion;
  expect(spawned).toEqual(['claude', 'codex', 'grok']);
  expect(ran.sort()).toEqual(['claude', 'codex']);
  expect(started.result.grokFallback).toBe('Grok sidetab PTY could not start');
});

test('sidetab mission tool opts into one same-goal three-hand comparison and rejects mixed prompts', async () => {
  const seen: string[] = [];
  const linkedIssueIds: Array<string | undefined> = [];
  const tool = createClassicSidetabMissionTool(
    async () => ({ ok: true, status: 'completed' }),
    undefined,
    async (mission, context) => {
      seen.push(mission);
      linkedIssueIds.push(context?.linearIssueId);
      return {
        trioId: 'trio-1',
        members: {
          codex: { ok: true, status: 'running', interactionId: 'codex-1' },
          claude: { ok: true, status: 'running', interactionId: 'claude-1' },
          grok: { ok: false, status: 'failed', error: 'Grok login unavailable; run grok login' },
        },
        grokFallback: 'Grok login unavailable; run grok login',
      };
    },
  );
  const result = await tool.dispatch({ agent: 'codex', mission: 'same task', withGrok: true });
  expect(result).toMatchObject({ status: 'running', id: 'codex-1' });
  expect(result.body).toContain('Grok fallback');
  expect(seen).toEqual(['same task']);
  const emptyParallel = await tool.dispatch({ agent: 'codex', mission: 'same task', parallelMission: '', withGrok: true });
  expect(emptyParallel.status).toBe('running');
  const emptyLinearIssue = await tool.dispatch({ agent: 'codex', mission: 'same task', linearIssueId: '', withGrok: true });
  expect(emptyLinearIssue.status).toBe('running');
  expect(emptyLinearIssue.body).not.toContain('Linked Linear');
  expect(linkedIssueIds.at(-1)).toBeUndefined();
  const emptySingleLinearIssue = await tool.dispatch({ agent: 'codex', mission: 'same task', linearIssueId: '' });
  expect(emptySingleLinearIssue.status).toBe('error');
  expect(emptySingleLinearIssue.body).toContain('non-empty ID');
  const linkedLinearIssue = await tool.dispatch({ agent: 'codex', mission: 'same task', linearIssueId: 'DEMO-123', withGrok: true });
  expect(linkedLinearIssue.status).toBe('running');
  expect(linkedLinearIssue.body).toContain('Linked Linear progress is not synchronized');
  expect(linkedIssueIds.at(-1)).toBe('DEMO-123');
  expect(seen).toEqual(['same task', 'same task', 'same task', 'same task']);
  const rejected = await tool.dispatch({ agent: 'codex', mission: 'primary', parallelMission: 'different', withGrok: true });
  expect(rejected).toMatchObject({ status: 'error' });
  expect(rejected.body).toContain('omit parallelMission');
  expect(tool.spec.name).toBe(CLASSIC_SIDETAB_MISSION_TOOL_NAME);
  expect(tool.spec.parameters).toMatchObject({ properties: { withGrok: { type: 'boolean' } } });
  const properties = tool.spec.parameters.properties as Record<string, { minLength?: number }>;
  expect(properties.linearIssueId?.minLength).toBe(1);
  expect(properties.parallelMission?.minLength).toBeUndefined();
});

test('RunSidetabMission production dispatch reaches the visible three-hand driver seam', async () => {
  const spawned: string[] = [];
  const delivered: PendingTaskNotification[] = [];
  let resolveAuth!: (value: { ok: boolean }) => void;
  let completion: Promise<void> | undefined;
  const integration = createClassicSidetabMissionIntegration(
    async () => ({ ok: false, status: 'failed' }),
    undefined,
    undefined,
    undefined,
    async (mission, context) => {
      const started = await startClassicSidetabMissionTrio({
        mission,
        context,
        checkGrokAuth: () => new Promise(resolve => { resolveAuth = resolve; }),
        spawnVisible: agent => { spawned.push(agent); return { id: `${agent}-pty`, cwd: '/work' }; },
        runVisible: async (agent, childMission) => ({ ok: true, status: 'completed', content: `${agent}:${childMission}`, finalScreen: `${agent} raw PTY frame` }),
        registry: createClassicSidetabMissionPairSessionRegistry(),
        hasSession: () => true,
        killSession: () => {},
        enqueue: notification => delivered.push(notification),
        createId: (() => { let n = 0; return () => `production-${++n}`; })(),
      });
      completion = started.completion;
      void started.completion;
      return started.result;
    },
  );
  const specs = integration.getTools([]);
  expect(specs.some(spec => spec.name === CLASSIC_SIDETAB_MISSION_TOOL_NAME)).toBe(true);
  const dispatched = integration.dispatchTool(CLASSIC_SIDETAB_MISSION_TOOL_NAME, {
    agent: 'codex', mission: 'same graph task', withGrok: true,
  }, { callId: 'production-call', parentSessionId: 'production-parent' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(spawned).toEqual(['claude', 'codex']);
  resolveAuth({ ok: true });
  await expect(dispatched).resolves.toMatchObject({ status: 'running', id: 'production-3' });
  await completion;
  expect(spawned).toEqual(['claude', 'codex', 'grok']);
  expect(delivered).toHaveLength(1);
  const body = JSON.parse(delivered[0]!.output).body as string;
  expect(body).toContain('same graph task');
  expect(body).toContain('grok final raw PTY screen:\ngrok raw PTY frame');
});
