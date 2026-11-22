import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElsCore, type ElsPty } from './core.js';
import { osc7CwdParser } from './osc7-cwd.js';
import { emptyJournal, type SpaceJournal } from './space.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('OSC 7 updates the persisted live cwd across output chunks; rejects invalid and remote reports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-live-cwd-')); dirs.push(root);
  const next = join(root, '한글 space'); mkdirSync(next);
  let stored: SpaceJournal = emptyJournal();
  let saves = 0;
  const subscribers = new Set<(data: string) => void>();
  const pty: ElsPty = { id: 'pty', isAlive: () => true, write: () => {}, renderScreen: async () => '',
    onExit: () => {}, kill: () => {}, onOutput: (cb) => { subscribers.add(cb); return { dispose: () => subscribers.delete(cb) }; } };
  const core = createElsCore({ load: () => stored, save: (j) => { stored = j; saves++; }, spawn: () => pty });
  expect(core.start()).toBeUndefined();
  expect(core.newPane({ ws: 'W', cwd: root, command: ['sh'] }).exitCode).toBe(0);
  const emit = (s: string) => { for (const cb of subscribers) cb(s); };
  const url = pathToFileURL(next); url.hostname = hostname();
  const osc = `\x1b]7;${url.href}\x1b\\`;
  emit(osc.slice(0, 5)); emit(osc.slice(5)); await settle();
  expect(stored.panes[0]!.cwd).toBe(next);
  const before = saves;
  emit(osc); emit('\x1b]7;file://remote.invalid/tmp\x07'); emit('\x1b]7;relative\x07');
  emit(`\x1b]7;${pathToFileURL(join(root, 'missing')).href}\x07`); await settle();
  expect(stored.panes[0]!.cwd).toBe(next);
  expect(saves).toBe(before);
  core.stopAll();
});

test('OSC parser bounds incomplete strings and does not parse nested or malformed reports', async () => {
  const found: string[] = [];
  const feed = osc7CwdParser((cwd) => found.push(cwd));
  const valid = '\x1b]7;file:///tmp\x07';
  for (const ch of valid) feed(ch);
  feed('\x1b]0;ignored\x1b]7;file:///bad\x07');
  feed('\x1bPignored\x1b]7;file:///bad\x07\x1b\\');
  feed('\x1b]7;file:///tmp%00bad\x07');
  feed('\x1b]7;file://remote.invalid/tmp\x07');
  feed('\x1b]7;file:///tmp?query\x07');
  feed('\x1b]7;' + 'x'.repeat(9000) + '\x07');
  feed('\x1b]7;file:///var\x1b'); feed('\\');
  expect(found).toEqual(['/tmp', '/var']);
});

test('reattached pane tracks cwd and stops observing after close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-live-reattach-')); dirs.push(root);
  const next = join(root, 'next'); mkdirSync(next);
  let stored: SpaceJournal = emptyJournal();
  const subscribers = new Set<(data: string) => void>();
  const pty: ElsPty = { id: 'pty', isAlive: () => true, write: () => {}, renderScreen: async () => '',
    onExit: () => {}, kill: () => {}, detach: () => {},
    onOutput: cb => { subscribers.add(cb); return { dispose: () => { subscribers.delete(cb); } }; } };
  const deps = { load: () => stored, save: (j: SpaceJournal) => { stored = j; }, spawn: () => pty, reattach: () => pty };
  const first = createElsCore(deps); first.start(); first.newPane({ ws: 'W', cwd: root, command: ['sh'] });
  const paneId = stored.panes[0]!.id;
  first.stopAll(); expect(subscribers.size).toBe(0);
  const second = createElsCore(deps); second.start(); expect(subscribers.size).toBe(1);
  for (const cb of subscribers) cb(`\x1b]7;${pathToFileURL(next).href}\x07`);
  await settle(); expect(stored.panes[0]!.cwd).toBe(next);
  second.close(paneId); expect(subscribers.size).toBe(0);
});

test('observations validate in order; close invalidates pending work', async () => {
  let stored = emptyJournal();
  const callbacks = new Set<(data: string) => void>();
  const waiting = new Map<string, (ok: boolean) => void>();
  const pty: ElsPty = { id: 'same-id', isAlive: () => true, write: () => {}, renderScreen: async () => '',
    onExit: () => {}, kill: () => {}, onOutput: cb => { callbacks.add(cb); return { dispose: () => { callbacks.delete(cb); } }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    isCwdDirectory: path => new Promise(resolve => waiting.set(path, resolve)) });
  core.start();
  const pane = (JSON.parse(core.newPane({ ws: 'W', cwd: '/', command: ['sh'] }).message) as { pane: string }).pane;
  const emit = (path: string) => { for (const cb of callbacks) cb(`\x1b]7;file://${path}\x07`); };
  emit('/first'); emit('/second');
  waiting.get('/first')!(true); await settle();
  waiting.get('/second')!(true); await settle();
  expect(stored.panes[0]!.cwd).toBe('/second');
  emit('/third');
  core.close(pane);
  expect(callbacks.size).toBe(0);
  waiting.get('/third')!(true); await settle();
  expect(stored.panes).toEqual([]);
});

test('adopted PTY gets one watcher after startup and stopAll disposes it', async () => {
  let stored = emptyJournal();
  const callbacks = new Set<(data: string) => void>();
  let detached = 0;
  const pty: ElsPty = { id: 'same', isAlive: () => true, write: () => {}, renderScreen: async () => '',
    onExit: () => {}, kill: () => {}, detach: () => { detached++; },
    onOutput: cb => { callbacks.add(cb); return { dispose: () => { callbacks.delete(cb); } }; } };
  const first = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty });
  first.start(); first.newPane({ ws: 'W', cwd: '/', command: ['sh'] }); first.stopAll();
  expect(callbacks.size).toBe(0);
  const second = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty, reattach: () => pty,
    isCwdDirectory: async () => true });
  expect(second.start()).toBeUndefined();
  expect(callbacks.size).toBe(1);
  for (const cb of callbacks) cb('\x1b]7;file:///adopted\x07');
  await settle(); expect(stored.panes[0]!.cwd).toBe('/adopted');
  second.stopAll(); expect(callbacks.size).toBe(0); expect(detached).toBe(2);
});

test('proc fallback is output driven, OSC wins an in-flight race, and close invalidates it', async () => {
  let stored = emptyJournal();
  const callbacks = new Set<(data: string) => void>();
  const pending: ((cwd: string | undefined) => void)[] = [];
  let reads = 0; let disposed = 0;
  const pty: ElsPty = { id: 'proc-pty', pid: 42, isAlive: () => true, write: () => {}, renderScreen: async () => '',
    onExit: () => {}, kill: () => {}, onOutput: cb => { callbacks.add(cb); return { dispose: () => { callbacks.delete(cb); } }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    isCwdDirectory: async () => true,
    procCwdReader: { read: () => { reads++; return new Promise(resolve => pending.push(resolve)); }, dispose: () => { disposed++; } } });
  core.start();
  const pane = (JSON.parse(core.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] }).message) as { pane: string }).pane;
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(reads).toBe(1);
  pending.shift()!('/fallback'); await settle(); expect(stored.panes[0]!.cwd).toBe('/fallback');
  core.input(pane, 'x'); await new Promise(resolve => setTimeout(resolve, 150)); expect(reads).toBe(1);
  for (const cb of callbacks) cb('prompt');
  await new Promise(resolve => setTimeout(resolve, 150)); expect(reads).toBe(2);
  for (const cb of callbacks) cb('\x1b]7;file:///osc\x07');
  await settle(); pending.shift()!('/stale'); await settle();
  expect(stored.panes[0]!.cwd).toBe('/osc');
  for (const cb of callbacks) cb('more output');
  await new Promise(resolve => setTimeout(resolve, 150)); expect(reads).toBe(2);
  expect(stored.panes[0]!.cwd).toBe('/osc');
  core.close(pane); core.stopAll(); expect(disposed).toBe(1);
});

test('pending proc result cannot update a closed pane', async () => {
  let stored = emptyJournal(); let finish: ((cwd: string | undefined) => void) | undefined;
  const pty: ElsPty = { id: 'pty', pid: 7, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    procCwdReader: { read: () => new Promise(resolve => { finish = resolve; }), dispose: () => {} } });
  core.start(); const pane = JSON.parse(core.newPane({ ws: 'W', cwd: '/', command: ['sh'] }).message).pane as string;
  await new Promise(resolve => setTimeout(resolve, 150)); expect(finish).toBeDefined();
  core.close(pane); finish!('/late'); await settle(); expect(stored.panes).toEqual([]); core.stopAll();
});

test.skipIf(process.platform !== 'darwin')('real shell cd is captured through core fallback on output', async () => {
  const { spawn } = await import('node:child_process');
  const { realpath } = await import('node:fs/promises');
  const root = mkdtempSync(join(tmpdir(), 'els-core-proc-')); dirs.push(root);
  const next = join(root, 'next'); mkdirSync(next);
  const shell = spawn('/bin/sh', [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let stored = emptyJournal();
  const callbacks = new Set<(data: string) => void>();
  shell.stdout.on('data', data => { for (const cb of callbacks) cb(String(data)); });
  const pty: ElsPty = { id: 'shell', pid: shell.pid, isAlive: () => shell.exitCode === null,
    write: text => { shell.stdin.write(text); }, renderScreen: async () => '', onExit: cb => { shell.once('exit', cb); },
    kill: () => { shell.kill(); }, onOutput: cb => { callbacks.add(cb); return { dispose: () => { callbacks.delete(cb); } }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: root, command: ['sh'] });
    const ready = new Promise<void>(resolve => shell.stdout.once('data', () => resolve()));
    shell.stdin.write(`cd '${next}' && printf 'synthetic-cd-event\\n'\n`); await ready;
    for (let i = 0; i < 30 && stored.panes[0]!.cwd === root; i++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(await realpath(stored.panes[0]!.cwd)).toBe(await realpath(next));
  } finally { core.stopAll(); shell.kill(); }
});

test('output during a lookup starts a fresh single-flight lookup even with continuous output', async () => {
  let stored = emptyJournal();
  const callbacks = new Set<(data: string) => void>();
  const pending: ((cwd: string | undefined) => void)[] = [];
  let reads = 0;
  const pty: ElsPty = { id: 'pty', pid: 42, isAlive: () => true, write: () => {}, renderScreen: async () => '',
    onExit: () => {}, kill: () => {}, onOutput: cb => { callbacks.add(cb); return { dispose: () => { callbacks.delete(cb); } }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    procCwdReader: { read: () => { reads++; return new Promise(resolve => pending.push(resolve)); }, dispose: () => {} } });
  core.start(); core.newPane({ ws: 'W', cwd: '/', command: ['sh'] });
  await new Promise(resolve => setTimeout(resolve, 140)); expect(reads).toBe(1);
  const stream = setInterval(() => { for (const cb of callbacks) cb('output'); }, 20);
  await new Promise(resolve => setTimeout(resolve, 150)); expect(reads).toBe(1);
  pending.shift()!('/old'); await new Promise(resolve => setTimeout(resolve, 140)); expect(reads).toBe(2);
  // A point-in-time proc observation must be usable even when output never stops.
  expect(stored.panes[0]!.cwd).toBe('/old');
  clearInterval(stream);
  pending.shift()!('/also-old'); await new Promise(resolve => setTimeout(resolve, 140)); expect(reads).toBe(3);
  expect(stored.panes[0]!.cwd).toBe('/also-old');
  pending.shift()!('/new'); await settle(); expect(stored.panes[0]!.cwd).toBe('/new');
  core.stopAll();
});

test('a later invalid OSC does not discard an earlier valid report', async () => {
  let stored = emptyJournal();
  const callbacks = new Set<(data: string) => void>();
  const waiting = new Map<string, (ok: boolean) => void>();
  const pty: ElsPty = { id: 'pty', isAlive: () => true, write: () => {}, renderScreen: async () => '',
    onExit: () => {}, kill: () => {}, onOutput: cb => { callbacks.add(cb); return { dispose: () => { callbacks.delete(cb); } }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    isCwdDirectory: path => new Promise(resolve => waiting.set(path, resolve)) });
  core.start(); core.newPane({ ws: 'W', cwd: '/', command: ['sh'] });
  for (const cb of callbacks) { cb('\x1b]7;file:///valid\x07'); cb('\x1b]7;file:///missing\x07'); }
  waiting.get('/valid')!(true); await settle(); waiting.get('/missing')!(false); await settle();
  expect(stored.panes[0]!.cwd).toBe('/valid'); core.stopAll();
});

test('reobserving an unsaved cwd retries the journal without a duplicate change notification', async () => {
  let stored = emptyJournal(); let fail = false; let notifications = 0;
  const callbacks = new Set<(data: string) => void>();
  const pty: ElsPty = { id: 'pty', isAlive: () => true, write: () => {}, renderScreen: async () => '',
    onExit: () => {}, kill: () => {}, onOutput: cb => { callbacks.add(cb); return { dispose: () => { callbacks.delete(cb); } }; } };
  const core = createElsCore({ load: () => stored, save: j => { if (fail) throw new Error('disk'); stored = j; },
    spawn: () => pty, isCwdDirectory: async () => true });
  core.start(); core.newPane({ ws: 'W', cwd: '/', command: ['sh'] });
  core.onChange(() => { notifications++; });
  const emit = () => { for (const cb of callbacks) cb('\x1b]7;file:///next\x07'); };
  fail = true; emit(); await settle(); expect(stored.panes[0]!.cwd).toBe('/');
  // The first OSC marks authority, then validation changes cwd; a repeat adds no notification.
  expect(notifications).toBe(2);
  fail = false; emit(); await new Promise(resolve => setTimeout(resolve, 300)); expect(stored.panes[0]!.cwd).toBe('/next');
  expect(notifications).toBe(2); core.stopAll();
});
