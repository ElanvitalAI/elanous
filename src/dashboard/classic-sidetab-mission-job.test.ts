import { expect, test } from 'bun:test';
import { enqueueClassicSidetabMissionPairCompletion } from './classic-sidetab-mission-job.js';

test('pair completion is one parent-scoped notification with both answers and redacted result paths', async () => {
  const notifications: unknown[] = [];
  const pair = {
    codex: {
      missionId: 'codex-mission',
      taskId: 'codex-mission',
      parentSessionId: 'parent-session-7',
      startedAt: 10,
      completion: Promise.resolve({ ok: true, path: '/private/codex.md', content: 'Codex answer /private/codex.md' }),
    },
    claude: {
      missionId: 'claude-mission',
      taskId: 'claude-mission',
      parentSessionId: 'parent-session-7',
      startedAt: 20,
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
  const output = JSON.stringify(notifications[0]);
  expect(output).toContain('Codex answer:');
  expect(output).toContain('Claude answer:');
  expect(output).toContain('[internal result]');
  expect(output).not.toContain('/private/');
});

test('pair completion marks a missing answer as error and says which agent had no answer', async () => {
  const notifications: Array<{ state: string; output: string }> = [];
  await enqueueClassicSidetabMissionPairCompletion({
    codex: {
      missionId: 'codex-mission', taskId: 'pair-task', parentSessionId: 'parent-session-8', startedAt: 1,
      completion: Promise.resolve({ ok: true, content: '  ' }),
    },
    claude: {
      missionId: 'claude-mission', taskId: 'pair-task', parentSessionId: 'parent-session-8', startedAt: 1,
      completion: Promise.resolve({ ok: true, content: 'Claude answer' }),
    },
  }, (notification) => notifications.push(notification), () => 2);

  expect(notifications).toHaveLength(1);
  expect(notifications[0]!.state).toBe('error');
  const output = JSON.parse(notifications[0]!.output) as { body: string };
  expect(output.body).toContain('Codex answer:\ncompleted without an answer');
  expect(output.body).toContain('Claude answer:');
});
