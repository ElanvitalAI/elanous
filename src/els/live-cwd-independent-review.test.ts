import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition: () => boolean, timeout = 3000) => { // 출처: #39597 비동기 검증 대기 상한 3초
  const end = Date.now() + timeout;
  while (!condition() && Date.now() < end) await sleep(10);
  expect(condition()).toBe(true);
};

test('timed-out old validation may finish after a newer one without restoring old cwd', async () => {
  let stored = emptyJournal(); let output = (_: string) => {};
  const pending = new Map<string, (ok: boolean) => void>();
  const pty: ElsPty = { id: 'pty', isAlive: () => true, write() {}, kill() {}, onExit() {}, renderScreen: async () => '',
    onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    isCwdDirectory: path => new Promise(resolve => pending.set(path, resolve)) });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/', command: ['sh'] });
    output('\x1b]7;file:///old\x07\x1b]7;file:///new\x07');
    expect(pending.has('/old')).toBe(true);
    await until(() => pending.has('/new'));
    pending.get('/new')!(true);
    await until(() => stored.panes[0]?.cwd === '/new');
    pending.get('/old')!(true);
    await sleep(30);
    expect(stored.panes[0]!.cwd).toBe('/new');
  } finally { core.stopAll(); }
});

test('overflow keeps the last valid report even when later reports are invalid', async () => {
  let stored = emptyJournal(); let output = (_: string) => {}; let release = (_: boolean) => {};
  const pty: ElsPty = { id: 'pty', isAlive: () => true, write() {}, kill() {}, onExit() {}, renderScreen: async () => '',
    onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    isCwdDirectory: path => path === '/blocked' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(path === '/valid') });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
    output('\x1b]7;file:///blocked\x07' + Array.from({ length: 64 }, (_, i) => `\x1b]7;file:///invalid${i}\x07`).join('') + '\x1b]7;file:///valid\x07\x1b]7;file:///missing\x07');
    release(false);
    await until(() => stored.panes[0]?.cwd === '/valid', 700);
    expect(stored.panes[0]!.cwd).toBe('/valid');
  } finally { core.stopAll(); }
});

test('valid OSC remains authoritative when later output has no new OSC (OP #129885)', async () => {
  let stored = emptyJournal(); let output = (_: string) => {}; let observed = '/initial'; let reads = 0;
  const pty: ElsPty = { id: 'pty', pid: 42, isAlive: () => true, write() {}, kill() {}, onExit() {}, renderScreen: async () => '',
    onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    isCwdDirectory: async () => true,
    procCwdReader: { read: async () => { reads++; return observed; }, dispose() {} } });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
    await until(() => reads === 1);
    output('\x1b]7;file:///osc\x07');
    await until(() => stored.panes[0]?.cwd === '/osc');
    observed = '/shell'; output('new prompt without OSC');
    await sleep(250);
    expect(reads).toBe(1);
    expect(stored.panes[0]!.cwd).toBe('/osc');
  } finally { core.stopAll(); }
});

test('pane with no OSC updates cwd from proc after output', async () => {
  let stored = emptyJournal(); let output = (_: string) => {}; let observed = '/initial'; let reads = 0;
  const pty: ElsPty = { id: 'pty', pid: 42, isAlive: () => true, write() {}, kill() {}, onExit() {}, renderScreen: async () => '',
    onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    procCwdReader: { read: async () => { reads++; return observed; }, dispose() {} } });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
    await until(() => reads === 1);
    observed = '/shell'; output('new prompt without OSC');
    await until(() => stored.panes[0]?.cwd === '/shell', 700);
    expect(reads).toBe(2);
    expect(stored.panes[0]!.cwd).toBe('/shell');
  } finally { core.stopAll(); }
});
