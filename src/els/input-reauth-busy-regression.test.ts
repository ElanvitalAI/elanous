import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';

for (const mode of ['queued-input', 'immediate-input', 'immediate-do'] as const) {
  test(`${mode}: output becoming busy during reauthorization defers delivery`, async () => {
    let screen = mode === 'queued-input' ? 'Turn running' : 'ready';
    const writes: string[] = [];
    const events: string[] = [];
    let clock = 0;
    const pty: ElsPty = {
      id: 'pty', isAlive: () => true, write: text => { writes.push(text); },
      renderScreen: async () => screen, onExit: () => {}, kill: () => {},
    };
    const core = createElsCore({ load: emptyJournal, save: () => {}, spawn: () => pty, now: () => clock });
    core.start();
    const pane = JSON.parse(core.newPane({ ws: 'test', cwd: '/', command: ['eln'] }).message).pane as string;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const validate = async () => { entered(); await gate; return true; };
    const audit = (event: string) => { events.push(event); return true; };

    let pending: Promise<unknown>;
    if (mode === 'queued-input') {
      expect((await core.inputLine(pane, 'hello', 'OP', audit, validate)).queued).toBe(1);
      screen = 'ready';
      pending = core.drain();
    } else {
      pending = mode === 'immediate-input'
        ? core.inputLine(pane, 'hello', 'OP', audit, validate)
        : core.do(pane, 'hello', 'OP', audit, validate);
    }
    await started; // idle screen already sampled; reauthorization is suspended
    screen = 'Turn running'; // target output changes, without an ELS raw input
    release();
    await pending;
    expect(writes).toEqual([]);
    expect(core.queued(pane)).toBe(1);
    expect(events).not.toContain('delivered');
    screen = 'ready';
    clock += 2500;
    await core.drain();
    expect(writes).toEqual([mode === 'immediate-do' ? '⇢ OP · hello\r' : 'hello\r']);
    expect(core.queued(pane)).toBe(0);
  });
}

for (const mode of ['queued-input', 'immediate-input', 'immediate-do'] as const) {
  test(`${mode}: revocation during final screen inspection prevents delivery`, async () => {
    let screen = mode === 'queued-input' ? 'Turn running' : 'ready';
    let allowed = true, renders = 0;
    const writes: string[] = [];
    const pty: ElsPty = {
      id: 'pty', isAlive: () => true, write: text => { writes.push(text); },
      renderScreen: async () => { if (++renders === (mode === 'queued-input' ? 3 : 2)) allowed = false; return screen; },
      onExit: () => {}, kill: () => {},
    };
    const core = createElsCore({ load: emptyJournal, save: () => {}, spawn: () => pty });
    core.start();
    const pane = JSON.parse(core.newPane({ ws: 'test', cwd: '/', command: ['eln'] }).message).pane as string;
    const validate = async () => allowed;
    if (mode === 'queued-input') {
      expect((await core.inputLine(pane, 'hello', 'OP', undefined, validate)).queued).toBe(1);
      screen = 'ready';
      await core.drain();
    } else if (mode === 'immediate-input') await core.inputLine(pane, 'hello', 'OP', undefined, validate);
    else await core.do(pane, 'hello', 'OP', undefined, validate);
    expect(allowed).toBe(false);
    expect(writes).toEqual([]);
  });
}

test('immediate input: target output becoming busy during final reauthorization must defer', async () => {
  let screen = 'ready', calls = 0;
  const writes: string[] = [];
  let output: ((data: string) => void) | undefined;
  const pty: ElsPty = { id: 'pty', isAlive: () => true, write: t => { writes.push(t); },
    renderScreen: async () => screen, onExit: () => {}, kill: () => {},
    onOutput: cb => { output = cb; return { dispose() { output = undefined; } }; } };
  const core = createElsCore({ load: emptyJournal, save: () => {}, spawn: () => pty });
  core.start();
  const pane = JSON.parse(core.newPane({ ws: 'test', cwd: '/', command: ['eln'] }).message).pane as string;
  const result = await core.inputLine(pane, 'hello', 'OP', undefined, async () => {
    if (++calls === 2) { screen = 'Turn running'; output?.('Turn running'); }
    return true;
  });
  expect(writes).toEqual([]);
  expect(result.queued).toBe(1);
});
