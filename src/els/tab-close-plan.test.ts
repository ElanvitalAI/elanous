import { expect, test } from 'bun:test';
import { planTabClose } from './tab-close-plan.js';
import type { SpaceJournal } from './space.js';

const journal: SpaceJournal = {
  version: 1,
  workspaces: [{ id: 'w1', name: 'OP', rootCwd: '/', purpose: '', host: 'local' }],
  tabs: [{ id: 't1', workspaceId: 'w1', label: 'one', focusPaneId: 'p1' }, { id: 't2', workspaceId: 'w1', label: 'two', focusPaneId: 'p3' }],
  panes: [
    { id: 'p1', tabId: 't1', kind: 'pty', title: 'a', cwd: '/', command: ['sh'], state: 'working', restore: 'cwd', ptyId: 'a', scrollback: '' },
    { id: 'p2', tabId: 't1', kind: 'pty', title: 'b', cwd: '/', command: ['sh'], state: 'working', restore: 'cwd', ptyId: 'b', scrollback: '' },
    { id: 'p3', tabId: 't2', kind: 'pty', title: 'c', cwd: '/', command: ['sh'], state: 'working', restore: 'cwd', ptyId: 'c', scrollback: '' },
  ],
};

test('tab close plan removes every pane in the selected tab and retains workspace and other tabs without mutating input', () => {
  const result = planTabClose(journal, 't1');
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected a close plan');
  expect(result.paneIds).toEqual(['p1', 'p2']);
  expect(result.next.tabs.map(t => t.id)).toEqual(['t2']);
  expect(result.next.panes.map(p => p.id)).toEqual(['p3']);
  expect(result.next.workspaces.map(w => w.id)).toEqual(['w1']);
  expect(journal.tabs.map(t => t.id)).toEqual(['t1', 't2']);
  expect(journal.panes.map(p => p.id)).toEqual(['p1', 'p2', 'p3']);
});

test('tab close plan rejects malformed and unknown tab ids without creating a plan', () => {
  expect(planTabClose(journal, '')).toEqual({ ok: false, exitCode: 2, message: 'els tab close: tab id is required' });
  expect(planTabClose(journal, 42)).toEqual({ ok: false, exitCode: 2, message: 'els tab close: tab id is required' });
  expect(planTabClose(journal, 'missing')).toEqual({ ok: false, exitCode: 1, message: 'els tab close: unknown tab missing' });
});
