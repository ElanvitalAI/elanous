import { expect, test } from 'bun:test';
import type { SidetabRow } from './model.js';
import { bindWorkspacePty, createWorkspaceInputState, prepareWorkspaceInput, selectDefaultOpenTabsWorkspace, selectWorkspaceInput, setWorkspaceInputDraft } from './workspace-input.js';

const tab = (id: string, spaceId?: string): SidetabRow => ({
  id, kind: 'shell', label: id, badge: 'idle', ptyId: id, ownerPid: 7, ptyStartedAt: 100,
  ...(spaceId ? { spaceId } : {}),
});

test('no workspace binds the last open local tab as the write target', () => {
  const state = selectDefaultOpenTabsWorkspace(createWorkspaceInputState(), [tab('pty:a'), tab('pty:b')]);
  expect(state.activeSpaceId).toBe('open-tabs');
  expect(state.explicitSelection).toBe(false);
  expect(state.entries['open-tabs']?.target?.ptyId).toBe('pty:b');
  expect(setWorkspaceInputDraft(state, 'sidechat', 'watch the tabs').entries['open-tabs']?.sidechatDraft).toBe('watch the tabs');
});

test('an automatic open-tabs binding refreshes after its target exits and an explicit choice stays', () => {
  const automatic = selectDefaultOpenTabsWorkspace(createWorkspaceInputState(), [tab('pty:a'), tab('pty:b')]);
  const refreshed = selectDefaultOpenTabsWorkspace(automatic, [tab('pty:a')]);
  expect(refreshed.entries['open-tabs']?.target?.ptyId).toBe('pty:a');
  const grown = selectDefaultOpenTabsWorkspace(refreshed, [tab('pty:a'), tab('pty:c')]);
  expect(grown.entries['open-tabs']?.target?.ptyId).toBe('pty:a');
  const selected = selectWorkspaceInput(createWorkspaceInputState(), { id: 'workspace:A', kind: 'workspace', label: 'A', badge: 'idle', spaceId: 'A' });
  expect(selectDefaultOpenTabsWorkspace(selected, [tab('pty:a')]).activeSpaceId).toBe('A');
});

test('an already selected workspace is not replaced by open tabs', () => {
  const selected = selectWorkspaceInput(createWorkspaceInputState(), { id: 'workspace:A', kind: 'workspace', label: 'A', badge: 'idle', spaceId: 'A' });
  const state = selectDefaultOpenTabsWorkspace(selected, [tab('pty:a')]);
  expect(state.activeSpaceId).toBe('A');
  expect(state.entries['open-tabs']).toBeUndefined();
});


test('a row-list refresh with no local tab clears only the automatic binding', () => {
  const automatic = selectDefaultOpenTabsWorkspace(createWorkspaceInputState(), [tab('pty:a')]);
  const cleared = selectDefaultOpenTabsWorkspace(automatic, [{ ...tab('pty:remote'), remoteHost: 'other' }]);
  expect(cleared.activeSpaceId).toBeUndefined();
  const again = selectDefaultOpenTabsWorkspace(cleared, []);
  expect(again.activeSpaceId).toBeUndefined();
});

test('an explicit workspace named open-tabs is refused, and a departed member does not submit', () => {
  expect(() => selectWorkspaceInput(createWorkspaceInputState(), {
    id: 'workspace:open-tabs', kind: 'workspace', label: 'open-tabs', badge: 'idle', spaceId: 'open-tabs',
  })).toThrow('select a workspace');
  const picked = selectWorkspaceInput(createWorkspaceInputState(), {
    id: 'workspace:A', kind: 'workspace', label: 'A', badge: 'idle', spaceId: 'A',
  });
  const bound = setWorkspaceInputDraft(bindWorkspacePty(picked, { ...tab('pty:a', 'A'), lastActivityAt: 10 }), 'terminal', 'go');
  const departed = { ...tab('pty:a'), lastActivityAt: 10 };
  expect(() => prepareWorkspaceInput(bound, 'terminal', [departed])).toThrow('select it again');
  const automatic = setWorkspaceInputDraft(
    selectDefaultOpenTabsWorkspace(createWorkspaceInputState(), [tab('pty:b')]), 'terminal', 'go');
  const adopted = { ...tab('pty:b'), spaceId: 'open-tabs', lastActivityAt: 10 };
  expect(() => prepareWorkspaceInput(automatic, 'terminal', [adopted])).toThrow('select it again');
});

test('tabs already inside a workspace, remote tabs, and no live tab leave the selection empty', () => {
  const remote = { ...tab('pty:remote'), remoteHost: 'other' };
  for (const rows of [[tab('pty:a', 'A')], [remote], []] as const) {
    const state = selectDefaultOpenTabsWorkspace(createWorkspaceInputState(), rows);
    expect(state.activeSpaceId).toBeUndefined();
  }
  expect(() => setWorkspaceInputDraft(createWorkspaceInputState(), 'sidechat', 'watch')).toThrow('select a workspace');
});

test('a dead automatic target clears and the next local tab becomes the write target', () => {
  const automatic = selectDefaultOpenTabsWorkspace(createWorkspaceInputState(), [tab('pty:a'), tab('pty:b')]);
  const cleared = selectDefaultOpenTabsWorkspace(automatic, []);
  expect(cleared.activeSpaceId).toBeUndefined();
  expect(cleared.explicitSelection).toBe(false);
  const rebound = selectDefaultOpenTabsWorkspace(cleared, [tab('pty:c')]);
  expect(rebound.activeSpaceId).toBe('open-tabs');
  expect(rebound.entries['open-tabs']?.target?.ptyId).toBe('pty:c');
});
