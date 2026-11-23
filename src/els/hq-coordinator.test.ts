import { describe, expect, test } from 'bun:test';
import { createElsCore } from './core.js';
import { validJournal } from './journal.js';
import { parseWorkspaceConfig } from './workspace-config.js';
import { workspacePlan } from './workspace-plan.js';
import type { SpaceJournal } from './space.js';

const initial: SpaceJournal = {
  version: 1,
  workspaces: [{ id: 'w', name: 'OP', rootCwd: '/x', purpose: '', host: 'local', coordinatorSeat: 'A' }],
  tabs: ['A', 'B'].map(id => ({ id: `t${id}`, workspaceId: 'w', label: id, focusPaneId: `p${id}` })),
  panes: ['A', 'B'].map(id => ({ id: `p${id}`, tabId: `t${id}`, kind: 'pty' as const, title: 'same', cwd: `/x/seats/${id}`, command: [], state: 'idle' as const, restore: 'cwd' as const, ptyId: '', scrollback: '' })),
  hqAuthorityLocation: 'future://authority',
};

describe('HQ coordinator', () => {
  test('persists one seat independently and rejects a second, including after restart', () => {
    let disk = JSON.stringify(initial); let fail = false;
    const make = () => {
      const core = createElsCore({ load: () => validJournal(JSON.parse(disk)), save: j => { if (fail) throw Error('disk full'); disk = JSON.stringify(j); }, spawn: () => { throw Error('unexpected'); }, mailBadges: () => new Map() });
      expect(core.start()).toBeUndefined(); return core;
    };
    let core = make();
    fail = true; expect(core.setHqCoordinator('A').message).toContain('disk full');
    fail = false; expect(core.setHqCoordinator('B').exitCode).toBe(0);
    expect(core.setHqCoordinator('A').message).toContain('already assigned');
    expect(core.setHqCoordinator('B').exitCode).toBe(0);
    core = make();
    expect(core.setHqCoordinator('A').exitCode).toBe(1);
    expect(JSON.parse(disk).workspaces[0].coordinatorSeat).toBe('A');
    expect(JSON.parse(core.list().message).hqAuthorityLocation).toBe('future://authority');
  });
  test('selector is explicit and ambiguity is refused before applying', () => {
    const text = JSON.stringify({ version: 1, seats: { A: { role: 'chief', tags: ['hq'] }, B: { tags: ['other'] } }, spaces: { main: { coordinator: 'B', seats: ['A'] } }, hq: { coordinator: { role: 'chief', tag: 'hq' }, authorityLocation: 'future://authority' } });
    const parsed = parseWorkspaceConfig(text, '/tmp/.elanous/workspace.json');
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.hq?.coordinator).toBe('A');
    const lines = workspacePlan(parsed.config!, { hqCoordinatorSeat: 'B', workspaces: [], tabs: [], panes: [] });
    expect(lines[0]).toContain('already assigned');
    const ambiguous = text.replace('"tags":["other"]', '"tags":["hq"],"role":"chief"');
    expect(parseWorkspaceConfig(ambiguous, '/tmp/.elanous/workspace.json').errors.join()).toContain('exactly one');
  });
});
