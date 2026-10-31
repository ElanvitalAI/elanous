import { expect, test } from 'bun:test';
import { TaskNotificationQueue } from '../agent/task-notification.js';
import { CLASSIC_SIDETAB_MISSION_TOOL_NAME, createClassicSidetabMissionPairSessionRegistry } from './classic-sidetab-mission.js';
import { createDashboardClassicSidetabMissionCallbacks } from './index.js';
import { startClassicSidetabMissionPair } from './classic-sidetab-mission-pair.js';

test('tool response lists both mission IDs in its body without an unused ids field', async () => {
  const mission = createDashboardClassicSidetabMissionCallbacks(
    async () => ({ ok: false }),
    undefined,
    async () => ({
      pairId: 'codex-mission+claude-mission',
      codex: { ok: true, status: 'running', interactionId: 'codex-mission' },
      claude: { ok: true, status: 'running', interactionId: 'claude-mission' },
    }),
  );
  const result = await mission.dispatchTool(CLASSIC_SIDETAB_MISSION_TOOL_NAME, {
    agent: 'codex', mission: 'first', parallelMission: 'second',
  });
  expect(result).toMatchObject({ status: 'running', id: 'codex-mission' });
  expect(result?.body).toContain('codex-mission');
  expect(result?.body).toContain('claude-mission');
  expect(result && 'ids' in result).toBe(false);
});

test('production pair seam starts both PTYs, binds both IDs, and routes one joined result to the parent call', async () => {
  const queue = new TaskNotificationQueue();
  queue.clear();
  const registry = createClassicSidetabMissionPairSessionRegistry();
  const sessions = new Map<string, { id: string; cwd: string }>();
  const spawned: string[] = [];
  const ran: Array<{ agent: string; prompt: string; sessionId?: string; missionId?: string }> = [];
  const resolveByAgent = new Map<string, (value: { ok: boolean; content: string }) => void>();
  let id = 0;

  const started = startClassicSidetabMissionPair({
    agent: 'claude', mission: 'Build the first half.', parallelMission: 'Build the second half.',
    context: { callId: 'parent-tool-call-42', parentSessionId: 'parent-session-7' },
    spawnVisible: (agent) => {
      spawned.push(agent);
      const session = { id: `${agent}-pty`, cwd: '/work' };
      sessions.set(session.id, session);
      return session;
    },
    runVisible: (agent, prompt, session, missionId) => {
      ran.push({ agent, prompt, ...(session ? { sessionId: session.id } : {}), ...(missionId ? { missionId } : {}) });
      return new Promise((resolve) => { resolveByAgent.set(agent, resolve); });
    },
    registry,
    hasSession: (sessionId) => sessions.has(sessionId),
    killSession: (sessionId) => { sessions.delete(sessionId); },
    enqueue: (notification) => queue.enqueue(notification),
    createId: () => `mission-${++id}`,
    now: () => 100,
  });

  expect(spawned).toEqual(['claude', 'codex']);
  expect(started.result.codex.interactionId).toBe('mission-1');
  expect(started.result.claude.interactionId).toBe('mission-2');
  expect(ran).toEqual([
    { agent: 'codex', prompt: 'Build the second half.', sessionId: 'codex-pty', missionId: 'mission-1' },
    { agent: 'claude', prompt: 'Build the first half.', sessionId: 'claude-pty', missionId: 'mission-2' },
  ]);

  resolveByAgent.get('codex')!({ ok: true, content: 'Codex result' });
  resolveByAgent.get('claude')!({ ok: true, content: 'Claude result' });
  await started.completion;

  expect(queue.drainForParentSession('other-parent')).toEqual([]);
  const delivered = queue.drainForParentSession('parent-session-7');
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    taskId: 'parent-tool-call-42', parentSessionId: 'parent-session-7', agentName: 'Codex + Claude', state: 'done',
  });
  expect(delivered[0]!.output).toContain('Codex result');
  expect(delivered[0]!.output).toContain('Claude result');
  expect(registry.cancel('mission-1', (sessionId) => sessions.has(sessionId), (sessionId) => sessions.delete(sessionId))).toBeUndefined();
});

test('pair opens Codex last for the completion-marker workaround regardless of primary mission agent', async () => {
  const spawned: string[] = [];
  const ran: Array<{ agent: string; prompt: string; sessionId?: string }> = [];
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'Codex prompt.', parallelMission: 'Claude prompt.',
    spawnVisible: (agent) => {
      spawned.push(agent);
      return { id: `${agent}-pty`, cwd: '/work' };
    },
    runVisible: async (agent, prompt, session) => {
      ran.push({ agent, prompt, ...(session ? { sessionId: session.id } : {}) });
      return { ok: true, content: `${agent} result` };
    },
    registry: createClassicSidetabMissionPairSessionRegistry(),
    hasSession: () => true,
    killSession: () => {},
    enqueue: () => {},
    createId: () => `order-mission-${spawned.length}`,
  });

  expect(spawned).toEqual(['claude', 'codex']);
  expect(ran).toEqual([
    { agent: 'codex', prompt: 'Codex prompt.', sessionId: 'codex-pty' },
    { agent: 'claude', prompt: 'Claude prompt.', sessionId: 'claude-pty' },
  ]);
  await started.completion;
});

test('pair safety timeout kills both registered PTYs and still emits one parent error receipt', async () => {
  const queue = new TaskNotificationQueue();
  queue.clear();
  const registry = createClassicSidetabMissionPairSessionRegistry();
  const sessions = new Set<string>();
  const killed: string[] = [];
  let id = 0;
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'first', parallelMission: 'second',
    context: { callId: 'timeout-call', parentSessionId: 'parent-session-timeout' },
    spawnVisible: (agent) => { const session = { id: `${agent}-pty`, cwd: '/work' }; sessions.add(session.id); return session; },
    runVisible: async () => new Promise(() => {}),
    registry,
    hasSession: (sessionId) => sessions.has(sessionId),
    killSession: (sessionId) => { killed.push(sessionId); sessions.delete(sessionId); },
    enqueue: (notification) => queue.enqueue(notification),
    createId: () => `timeout-mission-${++id}`,
    timeoutMs: 5,
  });

  await started.completion;
  expect(killed.sort()).toEqual(['claude-pty', 'codex-pty']);
  expect(queue.drainForParentSession('parent-session-timeout')).toMatchObject([{
    taskId: 'timeout-call', parentSessionId: 'parent-session-timeout', state: 'error',
  }]);
  expect(registry.cancel('timeout-mission-1', (sessionId) => sessions.has(sessionId), (sessionId) => sessions.delete(sessionId))).toBeUndefined();
});

test('pair without a tool call ID still reaches only its parent via session-scoped queue routing', async () => {
  const queue = new TaskNotificationQueue();
  queue.clear();
  const registry = createClassicSidetabMissionPairSessionRegistry();
  let id = 0;
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'first', parallelMission: 'second',
    context: { parentSessionId: 'parent-session-no-call-id' },
    spawnVisible: (agent) => ({ id: `${agent}-pty`, cwd: '/work' }),
    runVisible: async (agent) => ({ ok: true, content: `${agent} result` }),
    registry,
    hasSession: () => true,
    killSession: () => {},
    enqueue: (notification) => queue.enqueue(notification),
    createId: () => `no-call-mission-${++id}`,
  });

  await started.completion;
  expect(queue.drainForParentSession('sibling-session')).toEqual([]);
  expect(queue.drainForParentSession('parent-session-no-call-id')).toMatchObject([{
    taskId: 'no-call-mission-1', parentSessionId: 'parent-session-no-call-id', state: 'done',
  }]);
});

test('either public mission ID cancels both PTYs through the production pair registry', async () => {
  const registry = createClassicSidetabMissionPairSessionRegistry();
  const sessions = new Set<string>();
  const killed: string[] = [];
  let id = 0;
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'first', parallelMission: 'second',
    spawnVisible: (agent) => { const session = { id: `${agent}-pty`, cwd: '/work' }; sessions.add(session.id); return session; },
    runVisible: async (_agent, _prompt, _session, missionId) => ({ ok: false, status: 'cancelled', interactionId: missionId }),
    registry,
    hasSession: (sessionId) => sessions.has(sessionId),
    killSession: (sessionId) => { killed.push(sessionId); sessions.delete(sessionId); },
    enqueue: () => {},
    createId: () => `cancel-mission-${++id}`,
  });

  expect(registry.cancel('cancel-mission-2', (sessionId) => sessions.has(sessionId), (sessionId) => { killed.push(sessionId); sessions.delete(sessionId); })).toBe(true);
  expect(killed.sort()).toEqual(['claude-pty', 'codex-pty']);
  await started.completion;
  expect(registry.cancel('cancel-mission-1', (sessionId) => sessions.has(sessionId), (sessionId) => sessions.delete(sessionId))).toBeUndefined();
});
