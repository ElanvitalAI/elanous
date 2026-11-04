import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskNotificationQueue } from '../agent/task-notification.js';
import type { ClassicSidetabMissionResult } from './classic-sidetab-mission.js';
import { CLASSIC_SIDETAB_MISSION_TOOL_NAME, createClassicSidetabMissionPairSessionRegistry, createClassicSidetabMissionTool } from './classic-sidetab-mission.js';
import { createDashboardClassicSidetabMissionCallbacks } from './index.js';
import { startClassicSidetabMissionPair } from './classic-sidetab-mission-pair.js';

let workspaceDir: string;
function createWorkspace(): string {
  workspaceDir = mkdtempSync(join(tmpdir(), 'classic-pair-synthesis-'));
  execFileSync('git', ['init', '--quiet', workspaceDir]);
  execFileSync('git', ['-C', workspaceDir, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', workspaceDir, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(workspaceDir, 'one.txt'), 'one\n');
  writeFileSync(join(workspaceDir, 'two.txt'), 'two\n');
  execFileSync('git', ['-C', workspaceDir, 'add', 'one.txt', 'two.txt']);
  execFileSync('git', ['-C', workspaceDir, 'commit', '--quiet', '-m', 'base']);
  return workspaceDir;
}
function candidate(baseSha: string, agent: string, file: string, before: string, after: string, note: string): string {
  return `${note}\n<SIDETAB-CANDIDATE-V1 base-sha="${baseSha}">\n` +
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n</SIDETAB-CANDIDATE-V1>`;
}
function cleanupWorkspace(): void {
  if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
}

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
    agent: 'codex', mission: 'Parent objective: produce two visible results.',
    decomposition: {
      status: 'ready',
      codex: { scope: 'Write the first result.', deliverables: 'First result artifact.', dependsOn: 'Parent objective.' },
      claude: { scope: 'Write the second result.', deliverables: 'Second result artifact.', dependsOn: 'Parent objective.' },
    },
  });
  expect(result).toMatchObject({ status: 'running', id: 'codex-mission' });
  expect(result?.body).toContain('codex-mission');
  expect(result?.body).toContain('claude-mission');
  expect(result && 'ids' in result).toBe(false);
});

test('structured parent split reaches both mock children under the same tool call ID', async () => {
  const cwd = createWorkspace();
  const childRuns: Array<{ agent: string; prompt: string }> = [];
  let notificationTaskId: string | undefined;
  let notificationParentSessionId: string | undefined;
  let completion: Promise<unknown> | undefined;
  const sessions = new Map<string, { id: string; cwd: string }>();
  let id = 0;
  const tool = createClassicSidetabMissionTool(
    async () => ({ ok: false, status: 'failed' }),
    async (agent, codexBrief, claudeBrief, context) => {
      const started = startClassicSidetabMissionPair({
        agent, mission: codexBrief, parallelMission: claudeBrief, context,
        spawnVisible: (hand) => {
          const session = { id: `${hand}-pty`, cwd };
          sessions.set(session.id, session);
          return session;
        },
        runVisible: async (hand, prompt) => {
          childRuns.push({ agent: hand, prompt });
          return { ok: true, content: `${hand} completed`, path: join(cwd, `${hand}-result.md`) };
        },
        registry: createClassicSidetabMissionPairSessionRegistry(),
        hasSession: (sessionId) => sessions.has(sessionId),
        killSession: (sessionId) => { sessions.delete(sessionId); },
        enqueue: (notification) => {
          notificationTaskId = notification.taskId;
          notificationParentSessionId = notification.parentSessionId;
        },
        createId: () => `mock-id-${++id}`,
        now: () => 100,
      });
      completion = started.completion;
      return started.result;
    },
  );
  const result = await tool.dispatch({
    agent: 'claude',
    mission: 'Implement authenticated exports and document their public behavior.',
    decomposition: {
      status: 'ready',
      codex: { scope: 'Implement the export authorization guard.', deliverables: 'Guard and focused unit tests.', dependsOn: 'Existing export API contract is already available.' },
      claude: { scope: 'Document authenticated export behavior.', deliverables: 'User-facing docs and examples.', dependsOn: 'Existing export API contract is already available.' },
    },
  }, { callId: 'parent-call-live', parentSessionId: 'parent-session-live' });
  await completion;
  expect(result.status).toBe('running');
  expect(childRuns).toHaveLength(2);
  expect(childRuns[0]?.agent).toBe('codex');
  expect(childRuns[0]?.prompt).toContain('Implement the export authorization guard.');
  expect(childRuns[1]?.agent).toBe('claude');
  expect(childRuns[1]?.prompt).toContain('Document authenticated export behavior.');
  expect(notificationTaskId).toBe('parent-call-live');
  expect(notificationParentSessionId).toBe('parent-session-live');
  cleanupWorkspace();
});

test('production pair seam starts both PTYs, binds both IDs, and routes one joined result to the parent call', async () => {
  const cwd = createWorkspace();
  const baseSha = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const queue = new TaskNotificationQueue();
  queue.clear();
  const registry = createClassicSidetabMissionPairSessionRegistry();
  const sessions = new Map<string, { id: string; cwd: string }>();
  const spawned: string[] = [];
  const ran: Array<{ agent: string; prompt: string; sessionId?: string; missionId?: string }> = [];
  const resolveByAgent = new Map<string, (value: ClassicSidetabMissionResult) => void>();
  let id = 0;

  const started = startClassicSidetabMissionPair({
    agent: 'claude', mission: 'Build the first half.', parallelMission: 'Build the second half.',
    context: { callId: 'parent-tool-call-42', parentSessionId: 'parent-session-7' },
    spawnVisible: (agent) => {
      spawned.push(agent);
      const session = { id: `${agent}-pty`, cwd };
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
  expect(ran).toHaveLength(2);
  expect(ran[0]).toMatchObject({ agent: 'codex', sessionId: 'codex-pty', missionId: 'mission-1' });
  expect(ran[0]!.prompt).toContain('Build the second half.');
  expect(ran[0]!.prompt).toContain(`Parent candidate protocol (base ${baseSha})`);
  expect(ran[1]).toMatchObject({ agent: 'claude', sessionId: 'claude-pty', missionId: 'mission-2' });
  expect(ran[1]!.prompt).toContain('Build the first half.');
  expect(ran[1]!.prompt).toContain(`Parent candidate protocol (base ${baseSha})`);

  resolveByAgent.get('codex')!({ ok: true, content: candidate(baseSha, 'codex', 'one.txt', 'one', 'codex-one', 'Codex result'), path: join(cwd, 'codex-result.md') });
  resolveByAgent.get('claude')!({ ok: true, content: candidate(baseSha, 'claude', 'two.txt', 'two', 'claude-two', 'Claude result'), path: join(cwd, 'claude-result.md') });
  await started.completion;

  expect(queue.drainForParentSession('other-parent')).toEqual([]);
  const delivered = queue.drainForParentSession('parent-session-7');
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    taskId: 'parent-tool-call-42', parentSessionId: 'parent-session-7', agentName: 'Codex + Claude', state: 'done',
  });
  const notification = JSON.parse(delivered[0]!.output) as { body: string };
  expect(delivered[0]!.output.length).toBeLessThanOrEqual(500);
  expect(delivered[0]!.resultPath).toBeTruthy();
  expect(notification.body).toContain('Full comparison attached');
  const synthesis = readFileSync(delivered[0]!.resultPath!, 'utf8');
  expect(synthesis).toContain('| Codex | Build the second half. | codex-result.md | 성공 | 채택');
  expect(synthesis).toContain('| Claude Code | Build the first half. | claude-result.md | 성공 | 채택');
  expect(synthesis).toContain('Codex result');
  expect(synthesis).toContain('Claude result');
  expect(registry.cancel('mission-1', (sessionId) => sessions.has(sessionId), (sessionId) => sessions.delete(sessionId))).toBeUndefined();
  cleanupWorkspace();
});


test('pair opens Codex last for the completion-marker workaround regardless of primary mission agent', async () => {
  const cwd = createWorkspace();
  const spawned: string[] = [];
  const ran: Array<{ agent: string; prompt: string; sessionId?: string }> = [];
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'Codex prompt.', parallelMission: 'Claude prompt.',
    spawnVisible: (agent) => {
      spawned.push(agent);
      return { id: `${agent}-pty`, cwd };
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
  expect(ran).toHaveLength(2);
  expect(ran[0]).toMatchObject({ agent: 'codex', sessionId: 'codex-pty' });
  expect(ran[0]!.prompt).toContain('Codex prompt.');
  expect(ran[1]).toMatchObject({ agent: 'claude', sessionId: 'claude-pty' });
  expect(ran[1]!.prompt).toContain('Claude prompt.');
  await started.completion;
  cleanupWorkspace();
});

test('pair safety timeout kills both registered PTYs and still emits one parent error receipt', async () => {
  const cwd = createWorkspace();
  const queue = new TaskNotificationQueue();
  queue.clear();
  const registry = createClassicSidetabMissionPairSessionRegistry();
  const sessions = new Set<string>();
  const killed: string[] = [];
  let id = 0;
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'first', parallelMission: 'second',
    context: { callId: 'timeout-call', parentSessionId: 'parent-session-timeout' },
    spawnVisible: (agent) => { const session = { id: `${agent}-pty`, cwd }; sessions.add(session.id); return session; },
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
  const receipt = queue.drainForParentSession('parent-session-timeout')[0]!;
  expect(receipt).toMatchObject({
    taskId: 'timeout-call', parentSessionId: 'parent-session-timeout', state: 'error',
  });
  expect(registry.cancel('timeout-mission-1', (sessionId) => sessions.has(sessionId), (sessionId) => sessions.delete(sessionId))).toBeUndefined();
  expect(receipt?.resultPath).toBeTruthy();
  expect(readFileSync(receipt.resultPath!, 'utf8')).toContain('exceeded the one-hour safety timeout');
  cleanupWorkspace();
});

test('pair without a tool call ID still reaches only its parent via session-scoped queue routing', async () => {
  const cwd = createWorkspace();
  const queue = new TaskNotificationQueue();
  queue.clear();
  const registry = createClassicSidetabMissionPairSessionRegistry();
  let id = 0;
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'first', parallelMission: 'second \\| with slash',
    context: { parentSessionId: 'parent-session-no-call-id' },
    spawnVisible: (agent) => ({ id: `${agent}-pty`, cwd }),
    runVisible: async (agent) => agent === 'codex'
      ? { ok: true, content: 'Codex contribution' }
      : { ok: false, status: 'failed', error: 'Claude blocked by auth' },
    registry,
    hasSession: () => true,
    killSession: () => {},
    enqueue: (notification) => queue.enqueue(notification),
    createId: () => `no-call-mission-${++id}`,
  });

  await started.completion;
  expect(queue.drainForParentSession('sibling-session')).toEqual([]);
  const notification = queue.drainForParentSession('parent-session-no-call-id')[0]!;
  expect(notification).toMatchObject({
    taskId: 'no-call-mission-1', parentSessionId: 'parent-session-no-call-id', state: 'error',
  });
  const saved = JSON.parse(notification.output) as { status: string };
  expect(notification.output.length).toBeLessThanOrEqual(500);
  expect(saved.status).toBe('error');
  expect(notification.resultPath).toBeTruthy();
  const synthesis = readFileSync(notification.resultPath!, 'utf8');
  expect(synthesis).toContain('| Claude Code | second &#92;&#124; with slash | 없음 | 실패/빈 결과 | 미채택 — Claude blocked by auth |');
  expect(synthesis).toContain('| Codex | first | 없음 | 성공 | 채택');
  cleanupWorkspace();
});

test('either public mission ID cancels both PTYs through the production pair registry', async () => {
  const cwd = createWorkspace();
  const registry = createClassicSidetabMissionPairSessionRegistry();
  const sessions = new Set<string>();
  const killed: string[] = [];
  let id = 0;
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'first', parallelMission: 'second',
    spawnVisible: (agent) => { const session = { id: `${agent}-pty`, cwd }; sessions.add(session.id); return session; },
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
  cleanupWorkspace();
});

test('repeated parent call IDs create distinct pair synthesis files', async () => {
  const cwd = createWorkspace();
  let sessionId = 0;
  let missionId = 0;
  const runPair = () => startClassicSidetabMissionPair({
    agent: 'codex' as const, mission: 'first', parallelMission: 'second',
    context: { callId: 'same-parent-call', parentSessionId: 'repeat-parent' },
    spawnVisible: (agent: 'codex' | 'claude') => ({ id: `${agent}-repeat-${++sessionId}`, cwd }),
    runVisible: async (agent: 'codex' | 'claude') => ({ ok: true, content: `${agent} result` }),
    registry: createClassicSidetabMissionPairSessionRegistry(), hasSession: () => true, killSession: () => {},
    enqueue: (notification) => queue.enqueue(notification), createId: () => `mission-${'x'.repeat(1000)}-${++missionId}`,
  });
  const queue = new TaskNotificationQueue();
  queue.clear();
  await runPair().completion;
  const firstNotice = queue.drainForParentSession('repeat-parent')[0]!;
  const first = firstNotice.resultPath;
  expect(firstNotice.output.length).toBeLessThanOrEqual(500);
  queue.clear();
  await runPair().completion;
  const secondNotice = queue.drainForParentSession('repeat-parent')[0]!;
  const second = secondNotice.resultPath;
  expect(secondNotice.output.length).toBeLessThanOrEqual(500);
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  cleanupWorkspace();
});

test('synthesis write failure keeps bounded previews of both successful results', async () => {
  const cwd = createWorkspace();
  writeFileSync(join(cwd, '.elanous'), 'blocker');
  const queue = new TaskNotificationQueue();
  queue.clear();
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'first', parallelMission: 'second',
    context: { callId: 'write-failure', parentSessionId: 'write-failure-parent' },
    spawnVisible: (agent) => ({ id: `${agent}-pty`, cwd }),
    runVisible: async (agent) => {
      const path = join(cwd, `${agent}-result.md`);
      return { ok: true, path, content: `${agent} answer survives writer failure at ${path}` };
    },
    registry: createClassicSidetabMissionPairSessionRegistry(), hasSession: () => true, killSession: () => {},
    enqueue: (notification) => queue.enqueue(notification),
  });
  await started.completion;
  const delivered = queue.drainForParentSession('write-failure-parent')[0]!;
  expect(delivered.state).toBe('error');
  expect(delivered.truncated).toBe(true);
  expect(delivered.resultPath).toBeUndefined();
  expect(delivered.output.length).toBeLessThanOrEqual(500);
  expect(delivered.output).toContain('codex answer survives writer failure');
  expect(delivered.output).toContain('claude answer survives writer failure');
  expect(delivered.output).not.toContain(join(cwd, 'codex-result.md'));
  cleanupWorkspace();
});

test('missing base SHA fails closed without running child missions', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'classic-pair-no-base-'));
  const killed: string[] = [];
  const ran: string[] = [];
  const queue = new TaskNotificationQueue();
  queue.clear();
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'unsafe to launch', parallelMission: 'unsafe child',
    spawnVisible: (agent) => ({ id: `${agent}-pty`, cwd }),
    runVisible: async (agent) => { ran.push(agent); return { ok: true, content: 'should not execute' }; },
    registry: createClassicSidetabMissionPairSessionRegistry(), hasSession: () => true,
    killSession: (id) => killed.push(id), enqueue: (notification) => queue.enqueue(notification),
  });

  await started.completion;

  expect(ran).toEqual([]);
  expect(killed.sort()).toEqual(['claude-pty', 'codex-pty']);
  expect(started.result.codex).toMatchObject({ ok: false, status: 'failed' });
  expect(queue.drain()[0]?.state).toBe('error');
  rmSync(cwd, { recursive: true, force: true });
});
