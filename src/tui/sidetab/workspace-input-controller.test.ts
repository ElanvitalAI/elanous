import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('the sidetab row refresh rebinds a dead automatic target without submitting', async () => {
  const open = (id: string): SidetabRow => ({ id, kind: 'shell', label: id, badge: 'idle', ptyId: id, ownerPid: 7, ptyStartedAt: 100, lastActivityAt: 10 });
  let rows = [open('pty:a'), open('pty:b')];
  let submits = 0;
  const controller = createWorkspaceInputController({
    rows: () => rows,
    observe: async () => undefined,
    sendTerminal: async () => false,
    sendSidechat: async () => { submits += 1; return { sessionId: 'unused' }; },
  });
  const entryPath = new URL('../entry.ts', import.meta.url);
  const entry = await Bun.file(entryPath).text();
  const refreshBody = entry.slice(entry.indexOf('const refreshSidetabRows'), entry.indexOf('const toggleWorkspaceRow'));
  const call = 'refreshWorkspaceInputRows(workspaceInput)';
  expect(refreshBody.includes(call)).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), 'sidetab-refresh-'));
  const file = join(dir, 'refresh.ts');
  const writeHarness = (body: string) => writeFileSync(file, [
    'let current = []; let workspaceInput = null; let refreshWorkspaceInputRows = () => {};',
    'export function install(next) { current = next.rows; workspaceInput = next.workspaceInput; refreshWorkspaceInputRows = next.refreshWorkspaceInputRows; }',
    'const sidetabApi = { loadSidetabRows() { return current(); } };',
    'let sidetabRows = []; let sidetabSelected = 0; const herdrSidetabRows = []; const remoteSidetabRows = []; const elsSidetabRows = [];',
    'const getSidetabViewMode = () => "all"; const sidetabScope = () => undefined; const refreshRichView = () => {};',
    body.replace(/: void/g, ''),
    'export function refresh() { refreshSidetabRows(); }',
  ].join('\n'));
  try {
    writeHarness(refreshBody.replace(call, '/* refresh call removed */'));
    const detached = await import(`${file}?detached=${Date.now()}`);
    detached.install({ rows: () => rows, workspaceInput: controller, refreshWorkspaceInputRows: () => {} });
    detached.refresh();
    expect(controller.state().entries['open-tabs']?.target?.ptyId).toBeUndefined();
    writeHarness(refreshBody);
    const { refreshWorkspaceInputRows } = await import('./workspace-input-controller.js');
    const attached = await import(`${file}?attached=${Date.now()}`);
    attached.install({ rows: () => rows, workspaceInput: controller, refreshWorkspaceInputRows });
    attached.refresh();
    expect(controller.state().entries['open-tabs']?.target?.ptyId).toBe('pty:b');
    rows = [open('pty:a')];
    attached.refresh();
    expect(controller.state().entries['open-tabs']?.target?.ptyId).toBe('pty:a');
    expect(submits).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  expect(entryPath.pathname.endsWith('/src/tui/entry.ts')).toBe(true);
});

test('automatic open tabs bind the last local tab and rebind after the target exits', async () => {
  const open = (id: string): SidetabRow => ({ id, kind: 'shell', label: id, badge: 'idle', ptyId: id, ownerPid: 7, ptyStartedAt: 100, lastActivityAt: 10 });
  let rows = [open('pty:a'), open('pty:b')];
  const controller = createWorkspaceInputController({
    rows: () => rows,
    observe: async () => undefined,
    sendTerminal: async () => false,
    sendSidechat: async () => ({ sessionId: 'unused' }),
  });
  controller.ensureDefaultWorkspace();
  expect(controller.state().entries['open-tabs']?.target?.ptyId).toBe('pty:b');
  rows = [];
  controller.ensureDefaultWorkspace();
  expect(controller.state().activeSpaceId).toBeUndefined();
  rows = [open('pty:a')];
  controller.ensureDefaultWorkspace();
  expect(controller.state().entries['open-tabs']?.target?.ptyId).toBe('pty:a');
  controller.select(workspace('kept'));
  rows = [open('pty:a'), open('pty:c')];
  controller.ensureDefaultWorkspace();
  expect(controller.state().activeSpaceId).toBe('kept');
});

test('sidechat with no workspace submits against the original open-tab row', async () => {
  const open = { id: 'pty:open', kind: 'shell' as const, label: 'open', badge: 'idle' as const, ptyId: 'pty:open', ownerPid: 7, ptyStartedAt: 100, lastActivityAt: 10 };
  const chats: string[] = [];
  const controller = createWorkspaceInputController({
    rows: () => [open],
    observe: async (target) => ({
      target, screen: 'open screen', transcript: 'open transcript',
      observedAt: new Date().toISOString(), activityAt: 10, coverage: 'full',
    }),
    sendTerminal: async () => false,
    sendSidechat: async ({ spaceId, text }) => { chats.push(`${spaceId}:${text}`); return { sessionId: 'chat-open', reply: 'seen' }; },
  });
  controller.ensureDefaultWorkspace();
  controller.edit('sidechat', 'watch the tabs');
  expect(await controller.submit('sidechat')).toBe(true);
  expect(chats).toEqual(['open-tabs:watch the tabs']);
  expect(controller.conversation('open-tabs').at(-1)?.text).toBe('seen');
});
