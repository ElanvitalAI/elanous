import { expect, test } from 'bun:test';
import type { SidetabRow } from '../../sidetab-core/model.js';
import type { CompleteTerminalObservation, WorkspacePtyTarget } from '../../sidetab-core/workspace-input.js';
import { createWorkspaceInputController } from './workspace-input-controller.js';

const workspace = (id: string): SidetabRow => ({ id: `workspace:${id}`, kind: 'workspace', label: id, badge: 'busy', spaceId: id });
const pty = (spaceId: string, id: string, activity = 10): SidetabRow => ({
  id, kind: 'codex', label: id, badge: 'busy', spaceId, ptyId: id,
  ownerPid: 42, ptyStartedAt: 100, lastActivityAt: activity,
});

test('workspace sidechat requires a fresh full observation and never writes PTY bytes', async () => {
  const row = pty('A', 'pty:a');
  let rows = [row];
  const writes: string[] = [];
  const chats: string[] = [];
  let observed: CompleteTerminalObservation | undefined;
  const controller = createWorkspaceInputController({
    rows: () => rows,
    observe: async () => observed,
    sendTerminal: async (_target, text) => { writes.push(text); return true; },
    sendSidechat: async ({ text, observation, sessionId }) => {
      chats.push(`${sessionId ?? 'new'}:${observation.transcript}:${text}`);
      return { sessionId: 'chat-A', reply: 'A reply' };
    },
  });
  controller.select(workspace('A'));
  controller.bind(row);
  controller.edit('sidechat', 'continue mission');
  await expect(controller.submit('sidechat')).rejects.toThrow('full current observation');
  expect(writes).toEqual([]);
  observed = {
    target: controller.state().entries.A!.target!, screen: 'current screen', transcript: 'complete redacted transcript',
    observedAt: new Date().toISOString(), activityAt: 10, coverage: 'full',
  };
  expect(await controller.submit('sidechat')).toBe(true);
  expect(chats).toEqual(['new:complete redacted transcript:continue mission']);
  expect(writes).toEqual([]);
  expect(controller.state().entries.A?.sidechatSessionId).toBe('chat-A');
  expect(controller.conversation('A')).toEqual([
    { role: 'user', text: 'continue mission' },
    { role: 'assistant', text: 'A reply' },
  ]);
  rows = [pty('A', 'pty:a', 11)];
  await expect(controller.submit('sidechat')).rejects.toThrow('full current observation');
  expect(chats).toHaveLength(1);
  expect(controller.state().entries.A?.sidechatDraft).toBe('continue mission');
});

test('workspace switch during observation cannot reroute a sidechat to the new workspace', async () => {
  const a = pty('A', 'pty:a');
  const b = pty('B', 'pty:b');
  let release!: (value: CompleteTerminalObservation) => void;
  const chats: string[] = [];
  const controller = createWorkspaceInputController({
    rows: () => [a, b],
    observe: () => new Promise((resolve) => { release = resolve; }),
    sendTerminal: async () => true,
    sendSidechat: async ({ target }) => { chats.push(target.ptyId); return { sessionId: 'wrong' }; },
  });
  controller.select(workspace('A'));
  controller.bind(a);
  controller.edit('sidechat', 'A draft');
  const pending = controller.submit('sidechat');
  controller.select(workspace('B'));
  controller.bind(b);
  controller.edit('sidechat', 'B draft');
  release({ target: controller.state().entries.A!.target as WorkspacePtyTarget,
    screen: 'A screen', transcript: 'A transcript', observedAt: new Date().toISOString(), activityAt: 10, coverage: 'full' });
  await expect(pending).rejects.toThrow('full current observation');
  expect(chats).toEqual([]);
  expect(controller.state().entries.A?.sidechatDraft).toBe('A draft');
  expect(controller.state().entries.B?.sidechatDraft).toBe('B draft');
});

test('a completed sidechat retains its own session after switching workspaces', async () => {
  const a = pty('A', 'pty:a');
  let release!: (result: { sessionId: string }) => void;
  const controller = createWorkspaceInputController({
    rows: () => [a],
    observe: async (target) => ({ target, screen: 'A', transcript: 'A full transcript',
      observedAt: new Date().toISOString(), activityAt: 10, coverage: 'full' }),
    sendTerminal: async () => true,
    sendSidechat: () => new Promise((resolve) => { release = resolve; }),
  });
  controller.select(workspace('A'));
  controller.bind(a);
  controller.edit('sidechat', 'A question');
  const pending = controller.submit('sidechat');
  await Promise.resolve();
  controller.select(workspace('B'));
  controller.edit('sidechat', 'B question');
  release({ sessionId: 'chat-A' });
  expect(await pending).toBe(true);
  expect(controller.state().activeSpaceId).toBe('B');
  expect(controller.state().entries.A?.sidechatSessionId).toBe('chat-A');
  expect(controller.state().entries.B?.sidechatSessionId).toBeUndefined();
});

test('terminal submission keeps its lock until a delayed takeover writer settles', async () => {
  const a = pty('A', 'pty:a');
  let release!: (sent: boolean) => void;
  let writes = 0;
  const controller = createWorkspaceInputController({
    rows: () => [a],
    observe: async () => undefined,
    sendTerminal: () => { writes++; return new Promise((resolve) => { release = resolve; }); },
    sendSidechat: async () => ({ sessionId: 'unused' }),
  });
  controller.select(workspace('A'));
  controller.bind(a);
  controller.edit('terminal', 'go');
  const pending = controller.submit('terminal');
  await expect(controller.submit('terminal')).rejects.toThrow('already submitting');
  expect(writes).toBe(1);
  release(true);
  expect(await pending).toBe(true);
  const next = controller.submit('terminal');
  release(true);
  expect(await next).toBe(true);
  expect(writes).toBe(2);
});
