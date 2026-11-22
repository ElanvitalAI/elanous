import { expect, spyOn, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';

// OP #129939: the 64 newest queued candidates win, even if an older valid one is evicted.
for (const retainedValid of [false, true]) test(`overflow keeps newest 64; retained valid=${retainedValid}`, async () => {
  let stored = emptyJournal(); let output = (_: string) => {}; let release = (_: boolean) => {};
  let reads = 0; const checked: string[] = [];
  const audit = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const pty: ElsPty = { id: 'p', pid: 42, isAlive: () => true, write() {}, kill() {}, renderScreen: async () => '', onExit() {},
    onOutput: cb => { output = cb; return { dispose() {} }; } };
  const core = createElsCore({ load: () => stored, save: j => { stored = j; }, spawn: () => pty,
    procCwdReader: { read: async () => { reads++; return '/wrong-proc'; }, dispose() {} },
    isCwdDirectory: path => { checked.push(path); return path === '/blocked' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(path === '/prior' || path === '/valid' || (retainedValid && path === '/missing63')); } });
  try {
    core.start(); core.newPane({ ws: 'W', cwd: '/initial', command: ['sh'] });
    output('\x1b]7;file:///prior\x07');
    await new Promise(resolve => setTimeout(resolve, 0));
    checked.length = 0;
    output('\x1b]7;file:///blocked\x07\x1b]7;file:///valid\x07' + Array.from({ length: 66 }, (_, i) => `\x1b]7;file:///missing${i}\x07`).join(''));
    release(false); await new Promise(resolve => setTimeout(resolve, 250));
    expect(checked).toEqual(['/blocked', ...Array.from({ length: 64 }, (_, i) => `/missing${i + 2}`)]);
    expect(stored.panes[0]!.cwd).toBe(retainedValid ? '/missing63' : '/prior');
    expect(reads).toBe(0);
    expect(audit.mock.calls.filter(call => String(call[0]).includes('osc-saturated'))).toHaveLength(1);
  } finally { core.stopAll(); audit.mockRestore(); }
});
