import { expect, test } from 'bun:test';
import type { WorkspacePtyTarget } from '../../sidetab-core/workspace-input.js';
import { createWorkspaceTerminalWriter, WorkspaceTerminalOutcomeUnknownError } from './workspace-terminal-writer.js';

const target: WorkspacePtyTarget = { rowId: 'pty:a', spaceId: 'A', ptyId: 'pty:a',
  ownerPid: 42, ptyStartedAt: 100, bindingRevision: 1 };

test('workspace writer takes over, rechecks lifetime, sends once, and releases', async () => {
  const actions: string[] = [];
  let ownerPid = 42;
  const writer = createWorkspaceTerminalWriter({
    current: () => ({ ownerPid, startedAt: 100, alive: true }),
    control: async (_id, action, payload) => { actions.push(`${action}:${payload?.chars ?? ''}`); return { status: 'success' }; },
  });
  expect(await writer.send(target, 'continue')).toBe(true);
  expect(actions).toEqual(['takeover:', 'input-text:continue\r', 'release:']);
  actions.length = 0;
  ownerPid = 43;
  expect(await writer.send(target, 'wrong target')).toBe(false);
  expect(actions).toEqual([]);
});

test('workspace writer releases takeover when target changes before input', async () => {
  const actions: string[] = [];
  let ownerPid = 42;
  const writer = createWorkspaceTerminalWriter({
    current: () => ({ ownerPid, startedAt: 100, alive: true }),
    control: async (_id, action) => { actions.push(action); if (action === 'takeover') ownerPid = 43; return { status: 'success' }; },
  });
  expect(await writer.send(target, 'unsafe')).toBe(false);
  expect(actions).toEqual(['takeover', 'release']);
});

test('workspace writer marks a failed release after input as unknown', async () => {
  const actions: string[] = [];
  const writer = createWorkspaceTerminalWriter({
    current: () => ({ ownerPid: 42, startedAt: 100, alive: true }),
    control: async (_id, action) => {
      actions.push(action);
      if (action === 'release') throw new Error('release channel broke');
      return { status: 'success' };
    },
  });
  await expect(writer.send(target, 'continue')).rejects.toBeInstanceOf(WorkspaceTerminalOutcomeUnknownError);
  expect(actions).toEqual(['takeover', 'input-text', 'release']);
});

test('workspace writer treats a failed input acknowledgement as unknown after takeover', async () => {
  const actions: string[] = [];
  const writer = createWorkspaceTerminalWriter({
    current: () => ({ ownerPid: 42, startedAt: 100, alive: true }),
    control: async (_id, action) => {
      actions.push(action);
      return { status: action === 'input-text' ? 'owner-unreachable' : 'success' };
    },
  });
  await expect(writer.send(target, 'continue')).rejects.toBeInstanceOf(WorkspaceTerminalOutcomeUnknownError);
  expect(actions).toEqual(['takeover', 'input-text', 'release']);
});
