import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElsCore } from './core.js';
import { validJournal } from './journal.js';
import type { SpaceJournal } from './space.js';

test('restoring deleted cwd preserves pane, reason, cwd and screen without spawning; survives another restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-restore-cwd-'));
  try {
    const cwd = join(root, 'deleted');
    mkdirSync(cwd);
    let journal: SpaceJournal = { version: 1, workspaces: [{ id: 'w', name: 'W', rootCwd: root, purpose: '', host: 'local' }],
      tabs: [{ id: 't', workspaceId: 'w', label: 'shell', focusPaneId: 'p' }],
      panes: [{ id: 'p', tabId: 't', kind: 'pty', title: 'shell', cwd, command: ['sh'], state: 'working', restore: 'cwd', ptyId: 'gone', scrollback: 'saved screen' }] };
    rmSync(cwd, { recursive: true }); // synthetic directory deletion between save and restart
    let spawns = 0;
    const make = () => createElsCore({ load: () => validJournal(journal), save: next => { journal = validJournal(next); },
      spawn: () => { spawns++; throw new Error('must not spawn'); }, mailBadges: () => new Map() });
    for (let i = 0; i < 2; i++) {
      const core = make();
      expect(core.start()).toBeUndefined();
      const pane = (JSON.parse(core.list().message) as { panes: Array<{ cwd: string; state: string; unavailableReason: string }> }).panes[0]!;
      expect(pane.cwd).toBe(cwd);
      expect(pane.state).toBe('blocked');
      expect(pane.unavailableReason).toContain('cwd');
      expect((await core.frame('p')).message).toContain('saved screen');
      expect((await core.frame('p')).message).toContain('cwd');
      expect(core.paneIsLive('p')).toBe(false);
      expect(journal.panes[0]!.cwd).toBe(cwd);
      core.stopAll();
    }
    expect(spawns).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('existing directory is not blocked, and a file at cwd is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-restore-cwd-kind-'));
  try {
    const file = join(root, 'file');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, 'not a directory');
    const rows = [root, file].map((cwd, n) => ({ id: `p${n}`, tabId: 't', kind: 'pty' as const, title: `p${n}`, cwd,
      command: ['sh'], state: 'idle' as const, restore: 'cwd' as const, ptyId: '', scrollback: 'old' }));
    const journal: SpaceJournal = { version: 1, workspaces: [{ id: 'w', name: 'W', rootCwd: root, purpose: '', host: 'local' }],
      tabs: [{ id: 't', workspaceId: 'w', label: 'shell', focusPaneId: 'p0' }], panes: rows };
    const core = createElsCore({ load: () => journal, save: () => {}, spawn: () => { throw new Error('unexpected spawn'); }, mailBadges: () => new Map() });
    expect(core.start()).toBeUndefined();
    const panes = (JSON.parse(core.list().message) as { panes: Array<{ state: string; unavailableReason?: string }> }).panes;
    expect(panes[0]!.state).toBe('idle');
    expect(panes[0]!.unavailableReason).toBeUndefined();
    expect(panes[1]!.state).toBe('blocked');
    expect(panes[1]!.unavailableReason).toContain('not a directory');
    expect(JSON.parse((await core.status('p1')).message).reason).toContain('not a directory');
    core.stopAll();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
