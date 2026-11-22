import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';

const wait = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
test('synthetic cd and foreground leader select live cwd and seat, never helper cwd; exit returns to OSC', async () => {
  let journal = emptyJournal(); let output = (_: string) => {}; const reads: number[] = [];
  const pty: ElsPty = { id: 'pty', pid: 42, isAlive: () => true, write() {}, kill() {},
    renderScreen: async () => '', onExit() {}, onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => journal, save: j => { journal = j; }, spawn: () => pty,
    isCwdDirectory: async () => true,
    procCwdReader: { read: async pid => { reads.push(pid); return pid === 100 ? '/hq/seats/LEADER/work' : pid === 101 ? '/hq/seats/HELPER' : '/hq/seats/SHELL'; }, dispose() {} },
    mailBadges: seats => new Map(seats.map(seat => [seat, { count: 3, oldestCreatedAt: null }])) });
  try {
    core.start(); const pane = JSON.parse(core.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] }).message).pane as string;
    output('\x1b]7;file:///hq/seats/SHELL/work\x07'); await wait();
    core.setForegrounds(new Map([[pane, { kind: 'other', command: ['app'], pid: 100 }]])); await wait(200);
    let listed = JSON.parse(core.list().message).panes[0];
    expect([listed.cwd, listed.seat, listed.unreadMail]).toEqual(['/hq/seats/LEADER/work', 'LEADER', { count: 3, oldestCreatedAt: null }]);
    expect(reads).toContain(100); expect(reads).not.toContain(101);
    core.setForegrounds(new Map([[pane, { kind: 'shell', command: ['sh'], pid: 42 }]])); await wait(200);
    listed = JSON.parse(core.list().message).panes[0];
    expect([listed.cwd, listed.seat]).toEqual(['/hq/seats/SHELL/work', 'SHELL']);
  } finally { core.stopAll(); }
});
