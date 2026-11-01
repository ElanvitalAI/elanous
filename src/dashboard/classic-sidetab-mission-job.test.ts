import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PendingTaskNotification } from '../agent/task-notification.js';
import { enqueueClassicSidetabMissionPairCompletion } from './classic-sidetab-mission-job.js';

const workspaces: string[] = [];
function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'classic-pair-job-'));
  workspaces.push(workspace);
  return workspace;
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
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
