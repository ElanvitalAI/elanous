import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal, type SpaceJournal } from './space.js';

test('workspace close retains its existing partial-success contract on save failure, including coordinator restart and recovery', () => {
  let disk: SpaceJournal = emptyJournal();
  let failing = false;
  let killed = 0;
  let sequence = 0;
  const make = () => createElsCore({
    load: () => disk,
    save: next => { if (failing) throw new Error('disk full'); disk = next; },
    mailBadges: () => new Map(),
    spawn: () => ({ id: `pty-${++sequence}`, isAlive: () => true, write: () => {},
      renderScreen: async () => '', onExit: () => {}, kill: () => { killed++; } } as ElsPty),
  });
  const roles = (core: ReturnType<typeof make>) =>
    (JSON.parse(core.list().message) as { workspaces: { name: string; role?: string }[] }).workspaces
      .filter(ws => ws.role === 'coordinator').map(ws => ws.name);
  const core = make();
  expect(core.start()).toBeUndefined();
  for (const ws of ['OP', 'alpha']) expect(core.newPane({ ws, cwd: '/work', command: ['sh'] }).exitCode).toBe(0);
  expect(core.setCoordinator('alpha').exitCode).toBe(0);
  failing = true;
  const result = core.closeWorkspace('alpha');
  expect(result.exitCode).toBe(0);
  expect(result.message).toContain('not saved yet: disk full');
  expect(killed).toBe(1);
  expect(roles(core)).toEqual(['OP']);
  expect(disk.workspaces.find(ws => ws.name === 'alpha')?.role).toBe('coordinator');
  // A restart before another successful save necessarily reloads the old journal.
  failing = false;
  const restarted = make();
  expect(restarted.start()).toBeUndefined();
  expect(roles(restarted)).toEqual(['alpha']);
  // The original owner retains the removal and its next successful save makes it durable.
  expect(core.setCoordinator('OP').exitCode).toBe(0);
  const recovered = make();
  expect(recovered.start()).toBeUndefined();
  expect(roles(recovered)).toEqual(['OP']);
  expect(disk.workspaces.some(ws => ws.name === 'alpha')).toBe(false);
});
