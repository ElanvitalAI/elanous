import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { validJournal } from './journal.js';
import { emptyJournal, type SpaceJournal } from './space.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('OSC authority survives invalid reports, output and holder reattachment, including unchanged initial cwd', async () => {
  let journal: SpaceJournal = emptyJournal(); let output = (_: string) => {}; let reads = 0;
  const pty: ElsPty = { id: 'pty', pid: 42, isAlive: () => true, write() {}, kill() {}, detach() {},
    renderScreen: async () => '', onExit() {}, onOutput: cb => { output = cb; return { dispose() {} }; } };
  const deps = { load: () => validJournal(JSON.parse(JSON.stringify(journal))), save: (j: SpaceJournal) => { journal = j; },
    spawn: () => pty, reattach: () => pty, isCwdDirectory: async (path: string) => path !== '/missing',
    procCwdReader: { read: async () => { reads++; return '/proc'; }, dispose() {} } };
  const first = createElsCore(deps); first.start(); first.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
  output('\x1b]7;file:///initial\x07'); await wait(20);
  expect(journal.panes[0]!.cwdOsc7).toBe(true);
  output('\x1b]7;file:///missing\x07'); output('prompt'); await wait(150);
  expect(journal.panes[0]!.cwd).toBe('/initial'); expect(reads).toBe(0);
  first.stopAll();
  const second = createElsCore(deps); second.start(); output('after restart'); await wait(150);
  expect(journal.panes[0]!.cwd).toBe('/initial'); expect(reads).toBe(0);
  output('\x1b]7;file:///latest\x07'); await wait(20);
  expect(journal.panes[0]!.cwd).toBe('/latest'); second.stopAll();
});

test('an invalid first local OSC permits proc, including after reattachment', async () => {
  let journal = emptyJournal(); let output = (_: string) => {}; let reads = 0;
  const pty: ElsPty = { id: 'pty', pid: 42, isAlive: () => true, write() {}, kill() {}, detach() {},
    renderScreen: async () => '', onExit() {}, onOutput: cb => { output = cb; return { dispose() {} }; } };
  const deps = { load: () => validJournal(JSON.parse(JSON.stringify(journal))), save: (j: SpaceJournal) => { journal = j; },
    spawn: () => pty, reattach: () => pty, isCwdDirectory: async () => false,
    procCwdReader: { read: async () => { reads++; return '/proc'; }, dispose() {} } };
  const first = createElsCore(deps); first.start(); first.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
  output('\x1b]7;file:///missing\x07'); await wait(150);
  expect(journal.panes[0]!.cwd).toBe('/proc'); expect(journal.panes[0]!.cwdOsc7).toBeUndefined(); expect(reads).toBe(1);
  first.stopAll();
  const second = createElsCore(deps); second.start(); output('prompt'); await wait(150);
  expect(journal.panes[0]!.cwd).toBe('/proc'); expect(reads).toBe(2); second.stopAll();
});

test('a pane with no OSC updates from proc on subsequent output', async () => {
  let journal = emptyJournal(); let output = (_: string) => {}; let observed = '/first';
  const pty: ElsPty = { id: 'pty', pid: 42, isAlive: () => true, write() {}, kill() {},
    renderScreen: async () => '', onExit() {}, onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => journal, save: j => { journal = j; }, spawn: () => pty,
    procCwdReader: { read: async () => observed, dispose() {} } });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] }); await wait(150);
    expect(journal.panes[0]!.cwd).toBe('/first');
    observed = '/second'; output('prompt'); await wait(150);
    expect(journal.panes[0]!.cwd).toBe('/second'); expect(journal.panes[0]!.cwdOsc7).toBeUndefined();
  } finally { core.stopAll(); }
});

test('shutdown checkpoints pending OSCs and reattachment validates them in order', async () => {
  let journal = emptyJournal(); let output = (_: string) => {}; let release = (_: boolean) => {};
  let generation = 0; let reads = 0;
  const pty: ElsPty = { id: 'pty', pid: 42, isAlive: () => true, write() {}, kill() {}, detach() {},
    renderScreen: async () => '', onExit() {}, onOutput: cb => { output = cb; return { dispose() {} }; } };
  const deps = { load: () => validJournal(JSON.parse(JSON.stringify(journal))), save: (j: SpaceJournal) => { journal = j; },
    spawn: () => pty, reattach: () => pty,
    isCwdDirectory: (path: string) => generation === 0 ? new Promise<boolean>(resolve => { release = resolve; }) : Promise.resolve(path !== '/missing'),
    procCwdReader: { read: async () => { reads++; return '/proc'; }, dispose() {} } };
  const first = createElsCore(deps); first.start(); first.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
  output('\x1b]7;file:///valid\x07\x1b]7;file:///missing\x07'); first.stopAll();
  expect(journal.panes[0]!.cwd).toBe('/initial');
  expect(journal.panes[0]!.cwdOsc7).toBeUndefined();
  expect(journal.panes[0]!.cwdOscPending).toEqual(['/valid', '/missing']);
  generation = 1;
  const second = createElsCore(deps);
  try {
    second.start(); await wait(30);
    expect(journal.panes[0]!.cwd).toBe('/valid');
    expect(journal.panes[0]!.cwdOsc7).toBe(true);
    expect(journal.panes[0]!.cwdOscPending).toBeUndefined();
    release(true); output('prompt'); await wait(150);
    expect(journal.panes[0]!.cwd).toBe('/valid'); expect(reads).toBe(0);
  } finally { second.stopAll(); }
});

test('invalid shutdown checkpoint permits proc after reattachment', async () => {
  let journal = emptyJournal(); let output = (_: string) => {};
  const pty: ElsPty = { id: 'pty', pid: 42, isAlive: () => true, write() {}, kill() {}, detach() {},
    renderScreen: async () => '', onExit() {}, onOutput: cb => { output = cb; return { dispose() {} }; } };
  let generation = 0;
  const deps = { load: () => validJournal(JSON.parse(JSON.stringify(journal))), save: (j: SpaceJournal) => { journal = j; },
    spawn: () => pty, reattach: () => pty,
    isCwdDirectory: () => generation ? Promise.resolve(false) : new Promise<boolean>(() => {}),
    procCwdReader: { read: async () => '/proc', dispose() {} } };
  const first = createElsCore(deps); first.start(); first.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
  output('\x1b]7;file:///missing\x07'); first.stopAll(); generation = 1;
  const second = createElsCore(deps);
  try {
    second.start(); await wait(180);
    expect(journal.panes[0]!.cwd).toBe('/proc');
    expect(journal.panes[0]!.cwdOsc7).toBeUndefined();
    expect(journal.panes[0]!.cwdOscPending).toBeUndefined();
  } finally { second.stopAll(); }
});
