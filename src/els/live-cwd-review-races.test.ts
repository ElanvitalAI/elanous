import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';

test('proc makes progress and OSC observed before exit updates cwd without reviving the pane', async () => {
  let stored = emptyJournal();
  let output: (s: string) => void = () => {};
  let exit: () => void = () => {};
  let validate: (v: boolean) => void = () => {};
  const pending: ((cwd: string) => void)[] = [];
  const pty: ElsPty = { id: 'p', pid: 42, isAlive: () => true, write: () => {}, renderScreen: async () => '',
    onExit: cb => { exit = cb; }, kill: () => {}, onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    procCwdReader: { read: () => new Promise(resolve => pending.push(resolve)), dispose() {} },
    isCwdDirectory: () => new Promise(resolve => { validate = resolve; }) });
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  core.start(); core.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
  try {
    await delay(130); expect(pending.length).toBe(1);
    output('synthetic-output'); pending.shift()!('/one'); await delay(130);
    expect(stored.panes[0]!.cwd).toBe('/one'); expect(pending.length).toBe(1);
    output('synthetic-output-again'); pending.shift()!('/two'); await delay(130);
    expect(stored.panes[0]!.cwd).toBe('/two');
    output('\x1b]7;file:///late\x07'); exit(); validate(true);
    pending.shift()?.('/after-exit'); await delay(30);
    expect(stored.panes[0]!.state).toBe('exited'); expect(stored.panes[0]!.ptyId).toBe('');
    expect(stored.panes[0]!.cwd).toBe('/late'); expect(core.paneIsLive(stored.panes[0]!.id)).toBe(false);
  } finally { core.stopAll(); }
});


test('A B valid C missing: intermediate valid cwd survives', async () => {
  let stored = emptyJournal(); let output = (_: string) => {};
  const waiting = new Map<string, (ok: boolean) => void>();
  const pty: ElsPty = { id: 'p', isAlive: () => true, write() {}, kill() {}, renderScreen: async () => '', onExit() {},
    onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    isCwdDirectory: path => new Promise(resolve => waiting.set(path, resolve)) });
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/', command: ['sh'] });
    output('\x1b]7;file:///a\x07\x1b]7;file:///b\x07\x1b]7;file:///missing\x07');
    waiting.get('/a')!(true); await tick(); waiting.get('/b')!(true); await tick();
    waiting.get('/missing')!(false); await tick(); expect(stored.panes[0]!.cwd).toBe('/b');
  } finally { core.stopAll(); }
});

test('hung validation times out, later report advances, late answer cannot overwrite', async () => {
  let stored = emptyJournal(); let output = (_: string) => {}; let late = (_: boolean) => {};
  const pty: ElsPty = { id: 'p', isAlive: () => true, write() {}, kill() {}, renderScreen: async () => '', onExit() {},
    onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    isCwdDirectory: path => path === '/hung' ? new Promise(resolve => { late = resolve; }) : Promise.resolve(true) });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/', command: ['sh'] });
    output('\x1b]7;file:///hung\x07\x1b]7;file:///new\x07');
    await new Promise(resolve => setTimeout(resolve, 1150));
    expect(stored.panes[0]!.cwd).toBe('/new'); late(true);
    await new Promise(resolve => setTimeout(resolve, 20)); expect(stored.panes[0]!.cwd).toBe('/new');
  } finally { core.stopAll(); }
});

test('shutdown flushes dirty cwd immediately after disk recovery', async () => {
  let stored = emptyJournal(); let output = (_: string) => {}; let fail = false;
  const pty: ElsPty = { id: 'p', isAlive: () => true, write() {}, kill() {}, renderScreen: async () => '', onExit() {},
    onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { if (fail) throw Error('disk'); stored = j; }, spawn: () => pty,
    isCwdDirectory: async () => true });
  core.start(); core.newPane({ ws: 'W', cwd: '/', command: ['sh'] });
  fail = true; output('\x1b]7;file:///new\x07'); await new Promise(resolve => setTimeout(resolve, 20));
  expect(stored.panes[0]!.cwd).toBe('/'); fail = false; core.stopAll();
  expect(stored.panes[0]!.cwd).toBe('/new');
});


test('queue overflow with only invalid OSC retains the prior cwd, not proc (OP #129885)', async () => {
  let stored = emptyJournal(); let output = (_: string) => {}; let first = (_: boolean) => {}; let calls = 0;
  const pty: ElsPty = { id: 'p', pid: 42, isAlive: () => true, write() {}, kill() {}, renderScreen: async () => '', onExit() {},
    onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    procCwdReader: { read: async () => '/actual', dispose() {} },
    isCwdDirectory: () => ++calls === 1 ? new Promise(resolve => { first = resolve; }) : Promise.resolve(false) });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/', command: ['sh'] });
    for (let i = 0; i < 66; i++) output(`\x1b]7;file:///path${i}\x07`);
    // A saturated batch with no valid candidate retains the previous cwd (OP #129939).
    first(false); await new Promise(resolve => setTimeout(resolve, 250));
    expect(stored.panes[0]!.cwd).toBe('/'); expect(calls).toBe(65);
  } finally { core.stopAll(); }
});

test('overflow cannot replace a valid OSC with proc after later invalid reports', async () => {
  let stored = emptyJournal(); let output = (_: string) => {}; let first = (_: boolean) => {}; let calls = 0; let reads = 0;
  const pty: ElsPty = { id: 'p', pid: 42, isAlive: () => true, write() {}, kill() {}, renderScreen: async () => '', onExit() {},
    onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    procCwdReader: { read: async () => { reads++; return '/actual'; }, dispose() {} },
    isCwdDirectory: () => ++calls === 1 ? new Promise(resolve => { first = resolve; }) : Promise.resolve(false) });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/', command: ['sh'] });
    for (let i = 0; i < 66; i++) output(`\x1b]7;file:///path${i}\x07`);
    first(true); await new Promise(resolve => setTimeout(resolve, 250));
    expect(calls).toBe(65); expect(reads).toBe(0); expect(stored.panes[0]!.cwd).toBe('/path0');
  } finally { core.stopAll(); }
});

test('pane exit after failed cwd and exit saves retries entire journal without a watcher', async () => {
  let stored = emptyJournal(); let output = (_: string) => {}; let exit = () => {}; let fail = false;
  const pty: ElsPty = { id: 'p', isAlive: () => true, write() {}, kill() {}, renderScreen: async () => '',
    onExit: cb => { exit = cb; }, onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { if (fail) throw Error('disk'); stored = j; }, spawn: () => pty,
    isCwdDirectory: async () => true });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/', command: ['sh'] }); fail = true;
    output('\x1b]7;file:///new\x07'); await new Promise(resolve => setTimeout(resolve, 20)); exit();
    await new Promise(resolve => setTimeout(resolve, 20)); fail = false;
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(stored.panes[0]!.cwd).toBe('/new'); expect(stored.panes[0]!.state).toBe('exited');
  } finally { core.stopAll(); }
});

test('overflow retains the last report and valid OSC remains authoritative over proc', async () => {
  let stored = emptyJournal(); let output = (_: string) => {}; let release = (_: boolean) => {};
  let reads = 0; const checked: string[] = [];
  const pty: ElsPty = { id: 'p', pid: 42, isAlive: () => true, write() {}, kill() {}, renderScreen: async () => '', onExit() {},
    onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    procCwdReader: { read: async () => { reads++; return '/wrong-proc'; }, dispose() {} },
    isCwdDirectory: path => { checked.push(path); return path === '/first' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(path === '/final'); } });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
    output('\x1b]7;file:///first\x07' + Array.from({ length: 100 }, (_, i) => `\x1b]7;file:///invalid${i}\x07`).join('') + '\x1b]7;file:///final\x07');
    expect(checked).toEqual(['/first']); release(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(checked.at(-1)).toBe('/final'); expect(checked.length).toBeLessThanOrEqual(65);
    expect(stored.panes[0]!.cwd).toBe('/final');
    output('ordinary output'); await new Promise(resolve => setTimeout(resolve, 150));
    expect(reads).toBe(0); expect(stored.panes[0]!.cwd).toBe('/final');
  } finally { core.stopAll(); }
});

test('closing an exited pane cancels pending OSC validation', async () => {
  let stored = emptyJournal(); let output = (_: string) => {}; let exit = () => {}; let release = (_: boolean) => {};
  const pty: ElsPty = { id: 'p', isAlive: () => true, write() {}, kill() {}, renderScreen: async () => '',
    onExit: cb => { exit = cb; }, onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    isCwdDirectory: () => new Promise(resolve => { release = resolve; }) });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/', command: ['sh'] });
    const id = stored.panes[0]!.id; output('\x1b]7;file:///late\x07'); exit(); core.close(id); release(true);
    await new Promise(resolve => setTimeout(resolve, 10)); expect(stored.panes).toEqual([]);
  } finally { core.stopAll(); }
});
