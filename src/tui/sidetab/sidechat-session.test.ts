import { expect, test } from 'bun:test';
import type { WorkspacePtyTarget } from '../../sidetab-core/workspace-input.js';
import { createWorkspaceSidechatRuntime } from './sidechat-session.js';

test('workspace sidechat uses a separate session, retains it, and never sends PTY keys', async () => {
  const target: WorkspacePtyTarget = { rowId: 'pty:a', spaceId: 'A', ptyId: 'pty:a', ownerPid: 42,
    ptyStartedAt: 100, bindingRevision: 1 };
  let created = 0;
  const prompts: string[] = [];
  const runtime = createWorkspaceSidechatRuntime({
    createSession: () => { created++; return 'sidechat-A'; },
    runTurn: async (id, prompt, _signal, onDelta) => {
      prompts.push(`${id}:${prompt}`);
      onDelta('first');
      onDelta('final Bearer abcdefghijklmnop', true);
    },
  });
  const observation = { target, screen: 'current screen', transcript: 'full output Bearer abcdefghijklmnop',
    observedAt: new Date().toISOString(), activityAt: 10, coverage: 'full' as const };
  const first = await runtime.send({ spaceId: 'A', target, observation, text: 'continue this task' });
  await runtime.send({ spaceId: 'A', target, observation, text: 'what changed?', sessionId: first.sessionId });
  expect(created).toBe(1);
  expect(first.sessionId).toBe('sidechat-A');
  expect(first.reply).toContain('final');
  expect(first.reply).not.toContain('abcdefghijklmnop');
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain('current screen');
  expect(prompts[0]).toContain('continue this task');
  expect(prompts[0]).not.toContain('abcdefghijklmnop');
  await expect(runtime.send({ spaceId: 'A', target, observation: { ...observation, coverage: 'partial' as 'full' },
    text: 'unsafe' })).rejects.toThrow('complete bound PTY observation');
  expect(prompts).toHaveLength(2);
});
