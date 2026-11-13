import { expect, test } from 'bun:test';
import type { SidetabRow } from '../../sidetab-core/model.js';
import type { WorkspacePtyTarget } from '../../sidetab-core/workspace-input.js';
import { createWorkspaceBroadcast } from './workspace-broadcast.js';

const target = (id: string, spaceId = 'A'): WorkspacePtyTarget => ({
  rowId: id, spaceId, ptyId: id, ownerPid: 42, ptyStartedAt: 100, bindingRevision: 1,
});
const row = (id: string, spaceId = 'A'): SidetabRow => ({
  id, spaceId, ptyId: id, ownerPid: 42, ptyStartedAt: 100,
  kind: 'codex', label: id, badge: 'busy',
});

test('broadcast validates every explicit PTY before writing and reports partial delivery', async () => {
  let rows = [row('a'), row('b')];
  const writes: string[] = [];
  const broadcast = createWorkspaceBroadcast({
    rows: () => rows,
    sendTerminal: async (pty, text) => { writes.push(`${pty.ptyId}:${text}`); return pty.ptyId !== 'b'; },
  });
  await expect(broadcast.send('A', [target('a'), target('b', 'B')], 'go')).rejects.toThrow('target set');
  expect(writes).toEqual([]);
  rows = [row('a'), { ...row('b'), ownerPid: 43 }];
  await expect(broadcast.send('A', [target('a'), target('b')], 'go')).rejects.toThrow('target changed');
  expect(writes).toEqual([]);
  rows = [row('a'), row('b')];
  expect(await broadcast.send('A', [target('a'), target('b')], 'go')).toEqual({ sent: 1, total: 2, outcome: 'rejected' });
  expect(writes).toEqual(['a:go', 'b:go']);
  rows = [{ ...row('a'), currentProcess: true }, row('b')];
  await expect(broadcast.send('A', [target('a'), target('b')], 'go')).rejects.toThrow('target changed');
});

test('broadcast preserves the delivered count when a later takeover writer throws', async () => {
  const writes: string[] = [];
  const broadcast = createWorkspaceBroadcast({
    rows: () => [row('a'), row('b')],
    sendTerminal: async (pty) => {
      writes.push(pty.ptyId);
      if (pty.ptyId === 'b') throw new Error('takeover lost');
      return true;
    },
  });
  expect(await broadcast.send('A', [target('a'), target('b')], 'go')).toEqual({ sent: 1, total: 2, outcome: 'unknown' });
  expect(writes).toEqual(['a', 'b']);
});
