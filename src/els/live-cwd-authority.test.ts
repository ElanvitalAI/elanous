import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('OSC validation is single-flight, preserves order, and authoritative over later proc reads', async () => {
  let stored = emptyJournal();
  let output = (_: string) => {};
  const validations: { path: string; done: (ok: boolean) => void }[] = [];
  let reads = 0;
  const pty: ElsPty = { id: 'p', pid: 42, isAlive: () => true, write() {}, kill() {},
    renderScreen: async () => '', onExit() {}, onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    procCwdReader: { read: async () => { reads++; return '/proc'; }, dispose() {} },
    isCwdDirectory: path => new Promise(resolve => validations.push({ path, done: resolve })) });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
    output('\x1b]7;file:///one\x07\x1b]7;file:///two\x07\x1b]7;file:///three\x07');
    expect(validations.map(v => v.path)).toEqual(['/one']);
    validations[0]!.done(true); await wait(0);
    expect(validations.map(v => v.path)).toEqual(['/one', '/two']);
    validations[1]!.done(true); await wait(0);
    expect(validations.map(v => v.path)).toEqual(['/one', '/two', '/three']);
    validations[2]!.done(true); await wait(0);
    output('plain output'); await wait(160);
    expect(stored.panes[0]!.cwd).toBe('/three'); expect(reads).toBe(0);
  } finally { core.stopAll(); }
});

test('failed cwd save retries without output and stops on shutdown', async () => {
  let stored = emptyJournal(); let output = (_: string) => {}; let attempts = 0; let fail = false; // 출처: #39597 시험의 저장 시도 횟수 초기값
  const pty: ElsPty = { id: 'p', isAlive: () => true, write() {}, kill() {},
    renderScreen: async () => '', onExit() {}, onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { attempts++; if (fail) throw Error('disk'); stored = j; },
    spawn: () => pty, isCwdDirectory: async () => true });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
    fail = true; output('\x1b]7;file:///new\x07'); await wait(20);
    expect(stored.panes[0]!.cwd).toBe('/initial');
    // Initial pane, OSC authority, validated cwd, and timed retry.
    await wait(300); expect(attempts).toBe(4);
    fail = false; await wait(550); expect(stored.panes[0]!.cwd).toBe('/new');
    fail = true; output('\x1b]7;file:///last\x07'); await wait(20); core.stopAll();
    const stoppedAt = attempts; await wait(300); expect(attempts).toBe(stoppedAt);
  } finally { core.stopAll(); }
});
