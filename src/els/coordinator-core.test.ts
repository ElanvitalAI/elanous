import { describe, expect, test } from 'bun:test';
import { createElsCore } from './core.js';
import { validJournal } from './journal.js';
import type { SpaceJournal, Workspace } from './space.js';

const workspace = (id: string, name: string, rootCwd = `/work/${id}`): Workspace =>
  ({ id, name, rootCwd, purpose: '', host: 'local' });

function fixture(workspaces: Workspace[]) {
  // Deliberately interleave tabs/panes: list ordering must follow workspaces, then tabs.
  const initial: SpaceJournal = {
    version: 1, workspaces,
    tabs: workspaces.flatMap(w => [
      { id: `t-${w.id}-1`, workspaceId: w.id, label: 'one', focusPaneId: `p-${w.id}-1` },
      { id: `t-${w.id}-2`, workspaceId: w.id, label: 'two', focusPaneId: `p-${w.id}-2` },
    ]).reverse(),
    panes: workspaces.flatMap(w => [1, 2].map(n => ({
      id: `p-${w.id}-${n}`, tabId: `t-${w.id}-${n}`, kind: 'pty' as const,
      title: `${w.name}-${n}`, cwd: w.rootCwd, command: ['sh'], state: 'idle' as const,
      restore: 'cwd' as const, ptyId: '', scrollback: '',
    }))),
  };
  let disk = JSON.stringify(initial);
  let fail = false;
  let writes = 0;
  const make = () => {
    const core = createElsCore({
      load: () => validJournal(JSON.parse(disk)),
      save: journal => {
        writes++;
        if (fail) throw new Error('disk full');
        disk = JSON.stringify(journal);
      },
      spawn: () => { throw new Error('unexpected spawn'); },
      mailBadges: () => new Map(),
    });
    expect(core.start()).toBeUndefined();
    return core;
  };
  return { make, disk: () => JSON.parse(disk) as SpaceJournal, writes: () => writes, fail: (value: boolean) => { fail = value; } };
}

function listing(core: ReturnType<typeof createElsCore>) {
  const result = core.list();
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.message) as { workspaces: Workspace[]; panes: { pane: string }[] };
}
const roles = (workspaces: readonly Workspace[]) => workspaces.filter(w => w.role === 'coordinator').map(w => w.id);

describe('coordinator core', () => {
  test('default OP by name or seat root is effective only in the listing, with no write', () => {
    for (const op of [workspace('op', 'OP'), workspace('op', 'renamed', '/hq/seats/OP/')]) {
      const f = fixture([workspace('a', 'alpha'), op, workspace('b', 'beta')]);
      const core = f.make();
      const before = f.disk();
      expect(roles(listing(core).workspaces)).toEqual(['op']);
      expect(listing(core).workspaces.map(w => w.id)).toEqual(['op', 'a', 'b']);
      expect(f.writes()).toBe(0);
      expect(f.disk()).toEqual(before);
      expect(roles(f.disk().workspaces)).toEqual([]);
    }
    const noOp = fixture([workspace('a', 'alpha', '/hq/seats/OP/subdir')]).make();
    expect(roles(listing(noOp).workspaces)).toEqual([]);
  });

  test('seat-root OP beats an earlier name-only OP in the list and assignment audit', () => {
    const f = fixture([workspace('named', 'OP'), workspace('seat', 'renamed', '/hq/seats/OP/'), workspace('other', 'other')]);
    const core = f.make();
    expect(roles(listing(core).workspaces)).toEqual(['seat']);
    expect(listing(core).workspaces.map(w => w.id)).toEqual(['seat', 'named', 'other']);
    expect(core.setCoordinator('other').message).toBe('els ws coordinator: seat -> other');
    expect(roles(listing(core).workspaces)).toEqual(['other']);
    expect(core.closeWorkspace('other').exitCode).toBe(0);
    expect(roles(listing(core).workspaces)).toEqual(['seat']);
    expect(core.closeWorkspace('seat').exitCode).toBe(0);
    // Name-only OP remains supported by the existing default contract.
    expect(roles(listing(core).workspaces)).toEqual(['named']);
  });

  test('set by name or id is exclusive, persisted across restart, and overrides default', () => {
    const f = fixture([workspace('a', 'alpha'), workspace('op', 'OP'), workspace('b', 'beta')]);
    let core = f.make();
    expect(core.setCoordinator('beta').exitCode).toBe(0);
    expect(roles(f.disk().workspaces)).toEqual(['b']);
    expect(roles(listing(core).workspaces)).toEqual(['b']);
    core = f.make();
    expect(roles(listing(core).workspaces)).toEqual(['b']);
    expect(core.setCoordinator('a').exitCode).toBe(0);
    expect(roles(f.disk().workspaces)).toEqual(['a']);
    expect(roles(listing(f.make()).workspaces)).toEqual(['a']);
  });

  test('coordinator goes first without changing saved order; panes follow effective workspace and tab order', () => {
    const f = fixture([workspace('a', 'alpha'), workspace('b', 'beta'), workspace('c', 'gamma')]);
    const core = f.make();
    expect(core.setCoordinator('c').exitCode).toBe(0);
    expect(f.disk().workspaces.map(w => w.id)).toEqual(['a', 'b', 'c']);
    expect(listing(core).workspaces.map(w => w.id)).toEqual(['c', 'a', 'b']);
    expect(listing(core).panes.map(p => p.pane)).toEqual([
      'p-c-2', 'p-c-1', 'p-a-2', 'p-a-1', 'p-b-2', 'p-b-1',
    ]);
    expect(core.reorder({ kind: 'workspace', id: 'b', before: 'a' }).exitCode).toBe(0);
    expect(listing(f.make()).workspaces.map(w => w.id)).toEqual(['c', 'b', 'a']);
    expect(core.closeWorkspace('c').exitCode).toBe(0);
    expect(listing(core).workspaces.map(w => w.id)).toEqual(['b', 'a']);
  });

  test('closing the designated workspace restores OP; closing OP leaves no coordinator, including after restart', () => {
    const f = fixture([workspace('a', 'alpha'), workspace('op', 'OP'), workspace('b', 'beta')]);
    const core = f.make();
    expect(core.setCoordinator('b').exitCode).toBe(0);
    expect(core.closeWorkspace('b').exitCode).toBe(0);
    expect(roles(listing(core).workspaces)).toEqual(['op']);
    expect(roles(f.disk().workspaces)).toEqual([]);
    expect(roles(listing(f.make()).workspaces)).toEqual(['op']);
    expect(core.closeWorkspace('op').exitCode).toBe(0);
    expect(roles(listing(core).workspaces)).toEqual([]);
    expect(roles(listing(f.make()).workspaces)).toEqual([]);
    expect(listing(core).workspaces.map(w => w.id)).toEqual(['a']);
  });

  test('invalid set does not mutate or notify', () => {
    const f = fixture([workspace('a', 'alpha'), workspace('op', 'OP')]);
    const core = f.make();
    let changes = 0;
    core.onChange(() => changes++);
    const before = f.disk();
    expect(core.setCoordinator('').exitCode).toBe(2);
    expect(core.setCoordinator('   ').exitCode).toBe(2);
    expect(core.setCoordinator('missing').exitCode).toBe(1);
    expect(f.writes()).toBe(0);
    expect(changes).toBe(0);
    expect(f.disk()).toEqual(before);
    expect(roles(listing(core).workspaces)).toEqual(['op']);
  });

  test('failed set preserves in-memory and saved assignment, ordering, and notifications', () => {
    const f = fixture([workspace('a', 'alpha'), workspace('op', 'OP'), workspace('b', 'beta')]);
    const core = f.make();
    expect(core.setCoordinator('a').exitCode).toBe(0);
    const before = f.disk();
    const view = listing(core);
    let changes = 0;
    core.onChange(() => changes++);
    f.fail(true);
    for (const result of [core.setCoordinator('b')]) {
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('disk full');
      expect(f.disk()).toEqual(before);
      expect(listing(core)).toEqual(view);
      expect(changes).toBe(0);
    }
    f.fail(false);
    expect(roles(listing(f.make()).workspaces)).toEqual(['a']);
    expect(core.setCoordinator('op').exitCode).toBe(0);
    expect(changes).toBe(1);
    expect(roles(listing(f.make()).workspaces)).toEqual(['op']);
  });
});
