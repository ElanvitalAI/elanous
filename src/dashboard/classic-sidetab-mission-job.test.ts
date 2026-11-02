import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PendingTaskNotification } from '../agent/task-notification.js';
import { enqueueClassicSidetabMissionPairCompletion, prepareClassicSidetabMissionOutputDirectory, runPreparedClassicSidetabVisibleMission } from './classic-sidetab-mission-job.js';
import { startClassicSidetabMissionPair } from './classic-sidetab-mission-pair.js';
import { createClassicSidetabMissionPairSessionRegistry } from './classic-sidetab-mission.js';

const workspaces: string[] = [];
function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'classic-pair-job-'));
  workspaces.push(workspace);
  return workspace;
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

test('production pair runner prepares output before the real visible-agent writes', async () => {
  const workspace = createWorkspace();
  const started = startClassicSidetabMissionPair({
    agent: 'codex', mission: 'write a visible result', parallelMission: 'write another visible result',
    spawnVisible: (agent) => {
      const cwd = join(workspace, agent);
      mkdirSync(cwd, { recursive: true });
      return { id: agent + '-first-run', cwd };
    },
    runVisible: async (agent, prompt, session) => {
      const outputPath = join(session!.cwd, '.elanous', 'mission-results', 'actual-' + agent + '.md.tmp');
      let screen = '\n› Ask Codex to do anything\n';
      let typed = '';
      let enterCount = 0;
      expect(existsSync(join(session!.cwd, '.elanous', 'mission-results'))).toBe(false);
      const result = await runPreparedClassicSidetabVisibleMission({
        agent, mission: prompt, outputPath,
        pty: {
          snapshot: () => screen,
          isAlive: () => true,
          write: (bytes) => {
            if (bytes !== '\r') { typed += bytes; screen += bytes; return; }
            enterCount += 1;
            if (enterCount === 1) {
              expect(existsSync(join(session!.cwd, '.elanous', 'mission-results'))).toBe(true);
              expect(statSync(join(session!.cwd, '.elanous', 'mission-results')).mode & 0o777).toBe(0o700);
              writeFileSync(outputPath, '# ' + agent + ' first-run result\n');
              screen = '\n› Ask Codex to do anything\n';
            } else {
              const marker = typed.match(/Say (M-[a-f0-9]{12}) alone and write it to the exact file path (.+)\./);
              expect(marker).not.toBeNull();
              writeFileSync(marker![2]!, marker![1]! + '\n');
              screen += '\n└ ' + marker![1] + '\n';
            }
            typed = '';
          },
        },
        handleTrust: () => false, sleep: async () => {}, pollMs: 0,
        readyTimeoutMs: 100, visibilityTimeoutMs: 100, completionTimeoutMs: 100,
      });
      expect(result).toMatchObject({ ok: true, missionTyped: true, missionSubmitted: true, completionMarker: true });
      expect(readFileSync(outputPath, 'utf8')).toBe('# ' + agent + ' first-run result\n');
      return result;
    },
    registry: createClassicSidetabMissionPairSessionRegistry(), hasSession: () => true, killSession: () => {}, enqueue: () => {},
    createId: (() => { let id = 0; return () => 'actual-' + (++id); })(),
  });
  await started.completion;
});

test('pair output preparation preserves permissions on an existing result directory', () => {
  const workspace = createWorkspace();
  const dir = join(workspace, '.elanous', 'mission-results');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o750);

  prepareClassicSidetabMissionOutputDirectory(join(dir, 'classic-pair-pty-1.md.tmp'));
  expect(statSync(dir).mode & 0o777).toBe(0o750);
});

test('pair completion is one parent-scoped notification with both answers and redacted result paths', async () => {
  const notifications: PendingTaskNotification[] = [];
  const workspaceDir = createWorkspace();
  const pair = {
    codex: {
      missionId: 'codex-mission',
      taskId: 'codex-mission',
      parentSessionId: 'parent-session-7',
      startedAt: 10,
      mission: 'Codex mission',
      workspaceDir,
      completion: Promise.resolve({ ok: true, path: '/private/codex.md', content: 'Codex answer /private/codex.md' }),
    },
    claude: {
      missionId: 'claude-mission',
      taskId: 'claude-mission',
      parentSessionId: 'parent-session-7',
      startedAt: 20,
      mission: 'Claude mission',
      workspaceDir,
      completion: Promise.resolve({ ok: true, path: '/private/claude.md', content: 'Claude answer /private/claude.md' }),
    },
  };

  await enqueueClassicSidetabMissionPairCompletion(pair, (notification) => notifications.push(notification), () => 50);

  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    taskId: 'codex-mission',
    parentSessionId: 'parent-session-7',
    agentName: 'Codex + Claude',
    state: 'done',
    durationMs: 40,
  });
  const notification = notifications[0]!;
  expect(notification.output).toContain('Full comparison attached');
  expect(notification.output).not.toContain('/private/');
  const synthesis = readFileSync(notification.resultPath!, 'utf8');
  expect(synthesis).toContain('Codex answer [internal result]');
  expect(synthesis).toContain('Claude answer [internal result]');
  expect(synthesis).not.toContain('/private/');
});

test('pair completion marks a missing answer as error and says which agent had no answer', async () => {
  const notifications: PendingTaskNotification[] = [];
  const workspaceDir = createWorkspace();
  await enqueueClassicSidetabMissionPairCompletion({
    codex: {
      missionId: 'codex-mission', taskId: 'pair-task', parentSessionId: 'parent-session-8', startedAt: 1,
      mission: 'Codex task', workspaceDir,
      completion: Promise.resolve({ ok: true, content: '  ' }),
    },
    claude: {
      missionId: 'claude-mission', taskId: 'pair-task', parentSessionId: 'parent-session-8', startedAt: 1,
      mission: 'Claude task', workspaceDir,
      completion: Promise.resolve({ ok: true, content: 'Claude answer' }),
    },
  }, (notification) => notifications.push(notification), () => 2);

  expect(notifications).toHaveLength(1);
  expect(notifications[0]!.state).toBe('error');
  expect(notifications[0]!.output).toContain('Pair completed with failures');
  const synthesis = readFileSync(notifications[0]!.resultPath!, 'utf8');
  expect(synthesis).toContain('| Codex | Codex task | 없음 | 실패/빈 결과 | 미채택 — 빈 결과 |');
  expect(synthesis).toContain('| Claude Code | Claude task | 없음 | 성공 | 채택');
  expect(synthesis).toContain('Claude answer');
});
