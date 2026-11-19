import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElsCore, type ElsPty } from './core.js';
import { elsJournalPath, loadJournal, saveJournal } from './journal.js';
import { emptyJournal, type SpaceJournal } from './space.js';
import { createLineDecoder } from './wire.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A pane PTY double: the test decides when it renders, fails to render, exits. */
function fakePty(id: string) {
  let alive = true;
  let screen = `${id} ready\n`;
  let renderFails = false;
  const exits: (() => void)[] = [];
  const pending: { resolve: (text: string) => void; reject: (error: Error) => void }[] = [];
  let holdRenders = false;
  const writes: string[] = [];
  const pty: ElsPty & { killed: boolean } = {
    id,
    killed: false,
    isAlive: () => alive,
    write: (text) => { writes.push(text); },
    writeAll: async (text) => { writes.push(text); },
    bracketedPasteEnabled: () => true,
    renderScreen: () => new Promise<string>((resolve, reject) => {
      if (holdRenders) { pending.push({ resolve, reject }); return; }
      if (renderFails) reject(new Error('render failed')); else resolve(screen);
    }),
    onExit: (cb) => { exits.push(cb); },
    kill: () => { pty.killed = true; },
  };
  return {
    pty, writes,
    setScreen: (text: string) => { screen = text; },
    failRenders: () => { renderFails = true; },
    holdRenders: () => { holdRenders = true; },
    releaseRenders: () => { holdRenders = false; for (const call of pending.splice(0)) { if (renderFails) call.reject(new Error('render failed')); else call.resolve(screen); } },
    /** Finish the held render at `index` (0 = the oldest) with `text`. */
    finishRender: (index: number, text: string) => { pending[index]!.resolve(text); },
    exit: () => { alive = false; for (const cb of exits) cb(); },
  };
}

/** An owner over a journal kept in memory (plus a switch that makes saves fail). */
function owner(initial: SpaceJournal = emptyJournal(), ids?: string[], now?: () => number) {
  let stored = initial;
  let saveFails = false;
  const ptys: ReturnType<typeof fakePty>[] = [];
  const core = createElsCore({
    load: () => stored,
    save: (journal) => { if (saveFails) throw new Error('disk full'); stored = journal; },
    spawn: () => { const pty = fakePty(`pty_${ptys.length + 1}`); ptys.push(pty); return pty.pty; },
    ...(now ? { now } : {}),
    ...(ids ? { randomId: (prefix: string) => `${prefix}${ids.shift() ?? 'x'}` } : {}),
  });
  return { core, ptys, stored: () => stored, failSaves: (on: boolean) => { saveFails = on; } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const paneOf = (result: { message: string }) => (JSON.parse(result.message) as { pane: string }).pane;

test('new records the pane only after its PTY exists; ls, read and send work on the live pane', async () => {
  const { core, ptys, stored } = owner();
  expect(core.start()).toBeUndefined();
  const created = core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] });
  expect(created.exitCode).toBe(0);
  const pane = paneOf(created);
  expect(stored().panes.map((row) => [row.id, row.ptyId, row.cwd, row.state])).toEqual([[pane, 'pty_1', '/work', 'working']]);
  expect((await core.read(pane)).message).toBe('pty_1 ready\n');
  expect(stored().panes[0]!.scrollback).toBe('pty_1 ready\n');
  expect((await core.send(pane, 'echo hi\n')).exitCode).toBe(0);
  expect(ptys[0]!.writes).toEqual(['echo hi\n']);
  const listed = JSON.parse(core.list().message) as { panes: { pane: string; ptyId: string; state: string; workspace: string }[] };
  expect(listed.panes.map((row) => [row.pane, row.ptyId, row.state, row.workspace])).toEqual([[pane, 'pty_1', 'working', 'HQ']]);
});

test('write failure: a new pane whose journal save fails is not recorded and its PTY is stopped', () => {
  const { core, ptys, stored, failSaves } = owner();
  core.start();
  failSaves(true);
  const created = core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] });
  expect(created.exitCode).toBe(1);
  expect(created.message).toContain('disk full');
  expect(ptys[0]!.pty.killed).toBe(true);
  expect(stored().panes).toEqual([]);
  expect((JSON.parse(core.list().message) as { panes: unknown[] }).panes).toEqual([]);
});

test('exit is final: a read that finishes after the exit does not overwrite the exit state or the last screen', async () => {
  const { core, ptys, stored } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  const pty = ptys[0]!;
  pty.holdRenders();
  const lateRead = core.read(pane);          // render 0: the read, still rendering
  pty.exit();                                // render 1: the exit handler's final screen
  pty.finishRender(1, 'final screen\n');    // the exit is recorded first ...
  await settle();
  expect(stored().panes[0]!.state).toBe('exited');
  pty.finishRender(0, 'late read screen\n'); // ... then the read finishes
  expect((await lateRead).message).toBe('late read screen\n');
  await settle();
  const row = stored().panes[0]!;
  expect([row.state, row.ptyId, row.scrollback]).toEqual(['exited', '', 'final screen\n']);
  // A send after the exit is refused and changes nothing.
  expect((await core.send(pane, 'x')).exitCode).toBe(1);
  expect(stored().panes[0]!.state).toBe('exited');
});

test('render failure keeps the scrollback: at exit and on read', async () => {
  const { core, ptys, stored } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  ptys[0]!.setScreen('kept output\n');
  await core.read(pane);
  ptys[0]!.failRenders();
  const failedRead = await core.read(pane);
  expect(failedRead.exitCode).toBe(1);
  expect(stored().panes[0]!.scrollback).toBe('kept output\n');
  ptys[0]!.exit();
  await settle();
  expect([stored().panes[0]!.state, stored().panes[0]!.scrollback]).toEqual(['exited', 'kept output\n']);
  expect((await core.read(pane)).message).toBe('kept output\n');
});

test('ids are checked against every id in the journal; a colliding candidate is skipped', () => {
  // Candidates in order: w1 (workspace), t1 (tab), p1 (pane), then for the second pane t1 and p1 collide again.
  const { core, stored } = owner(emptyJournal(), ['1', '1', '1', '1', '2', '1', '2']);
  core.start();
  core.newPane({ ws: 'HQ', cwd: '/a', command: ['sh'] });
  core.newPane({ ws: 'HQ', cwd: '/b', command: ['sh'] });
  const journal = stored();
  expect(journal.workspaces.map((ws) => ws.id)).toEqual(['w1']);
  expect(journal.tabs.map((tab) => tab.id)).toEqual(['t1', 't2']);
  expect(journal.panes.map((pane) => pane.id)).toEqual(['p1', 'p2']);
});

test('restart: panes of the previous server lose their pty id, keep cwd and scrollback; send is refused', async () => {
  const first = owner();
  first.core.start();
  const pane = paneOf(first.core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  await first.core.read(pane);
  const second = owner(first.stored());
  expect(second.core.start()).toBeUndefined();
  const row = second.stored().panes[0]!;
  expect([row.ptyId, row.state, row.cwd, row.scrollback]).toEqual(['', 'idle', '/work', 'pty_1 ready\n']);
  expect((await second.core.read(pane)).message).toBe('pty_1 ready\n');
  expect((await second.core.send(pane, 'x')).exitCode).toBe(1);
});

test('read failure: an unreadable journal stops the server from starting and the file is kept', () => {
  const state = mkdtempSync(join(tmpdir(), 'els-core-'));
  dirs.push(state);
  const path = elsJournalPath(state);
  saveJournal(path, emptyJournal());
  writeFileSync(path, '{not json');
  const core = createElsCore({ load: () => loadJournal(path), save: (journal) => saveJournal(path, journal), spawn: () => fakePty('x').pty });
  const refused = core.start();
  expect(refused?.exitCode).toBe(1);
  expect(refused?.message).toContain('unreadable');
  expect(readFileSync(path, 'utf8')).toBe('{not json');
});

test('the journal is written 0600 in a 0700 directory', () => {
  const state = mkdtempSync(join(tmpdir(), 'els-core-'));
  dirs.push(state);
  const path = elsJournalPath(state);
  saveJournal(path, emptyJournal());
  expect([statSync(path).mode & 0o777, statSync(join(state, 'els')).mode & 0o777]).toEqual([0o600, 0o700]);
});

test('write failure while recording an exit: memory keeps the exit and the next successful save writes it', async () => {
  const { core, ptys, stored, failSaves } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  failSaves(true);
  ptys[0]!.exit();
  await settle();
  expect(stored().panes[0]!.state).toBe('working');
  const listed = JSON.parse(core.list().message) as { panes: { pane: string; state: string }[] };
  expect(listed.panes.map((row) => [row.pane, row.state])).toEqual([[pane, 'exited']]);
  failSaves(false);
  expect(core.newPane({ ws: 'HQ', cwd: '/other', command: ['sh'] }).exitCode).toBe(0);
  expect(stored().panes.find((row) => row.id === pane)?.state).toBe('exited');
});

test('the exit is recorded the moment the PTY ends, before its final screen renders; a failed final render keeps the scrollback', async () => {
  const { core, ptys, stored } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  ptys[0]!.setScreen('seen before\n');
  await core.read(pane);
  ptys[0]!.holdRenders();
  const lateRead = core.read(pane);   // render 0
  ptys[0]!.exit();                    // render 1 (final screen) is still pending
  expect([stored().panes[0]!.state, stored().panes[0]!.ptyId]).toEqual(['exited', '']);
  ptys[0]!.finishRender(0, 'late read\n');
  await lateRead;
  ptys[0]!.failRenders();
  ptys[0]!.releaseRenders();          // the final render fails
  await settle();
  expect([stored().panes[0]!.state, stored().panes[0]!.scrollback]).toEqual(['exited', 'seen before\n']);
});

test('write failure on read or send: memory keeps the change and the next successful save writes it', async () => {
  const { core, ptys, stored, failSaves } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  failSaves(true);
  ptys[0]!.setScreen('read while the disk is full\n');
  expect((await core.read(pane)).message).toBe('read while the disk is full\n');
  expect(stored().panes[0]!.scrollback).toBe('');
  failSaves(false);
  expect(core.newPane({ ws: 'HQ', cwd: '/other', command: ['sh'] }).exitCode).toBe(0);
  expect(stored().panes.find((row) => row.id === pane)?.scrollback).toBe('read while the disk is full\n');
});

test('a journal with malformed records, duplicate ids or dangling references is refused', () => {
  const ws = { id: 'w1', name: 'HQ', rootCwd: '/', purpose: '', host: 'local' };
  const tab = { id: 't1', workspaceId: 'w1', label: 'sh', focusPaneId: 'p1' };
  const pane = { id: 'p1', tabId: 't1', kind: 'pty', title: 'sh', cwd: '/', command: ['sh'], state: 'idle', restore: 'cwd', ptyId: '', scrollback: '' };
  const journal = (patch: Record<string, unknown>) => ({ version: 1, workspaces: [ws], tabs: [tab], panes: [pane], ...patch });
  const state = mkdtempSync(join(tmpdir(), 'els-core-'));
  dirs.push(state);
  const path = elsJournalPath(state);
  const refused = (raw: unknown): string => {
    saveJournal(path, emptyJournal());
    writeFileSync(path, JSON.stringify(raw));
    const core = createElsCore({ load: () => loadJournal(path), save: (next) => saveJournal(path, next), spawn: () => fakePty('x').pty });
    return core.start()?.message ?? 'started';
  };
  expect(refused(journal({}))).toBe('started');
  expect(refused(journal({ panes: [null] }))).toContain('panes[0] is malformed');
  expect(refused(journal({ panes: [{ ...pane, state: 'gone' }] }))).toContain('panes[0] is malformed');
  expect(refused(journal({ panes: [{ ...pane, tabId: 't9' }] }))).toContain('missing tab');
  expect(refused(journal({ tabs: [{ ...tab, workspaceId: 'w9' }] }))).toContain('missing workspace');
  expect(refused(journal({ panes: [{ ...pane, id: 't1' }] }))).toContain('not unique');
  // The refused file is left exactly as it was.
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(journal({ panes: [{ ...pane, id: 't1' }] }));
});

test('a save fails before the rename or not at all: a failing chmod leaves the previous journal and no temp file', async () => {
  const state = mkdtempSync(join(tmpdir(), 'els-core-'));
  dirs.push(state);
  const path = elsJournalPath(state);
  saveJournal(path, emptyJournal());
  const before = readFileSync(path, 'utf8');
  const failing = { ...fs, chmodSync: ((target: string, mode: number) => {
    if (String(target).endsWith('.tmp')) throw new Error('chmod refused');
    fs.chmodSync(target, mode);
  }) as typeof fs.chmodSync };
  const next: SpaceJournal = { ...emptyJournal(), workspaces: [{ id: 'w1', name: 'HQ', rootCwd: '/', purpose: '', host: 'local' }] };
  expect(() => saveJournal(path, next, failing)).toThrow('chmod refused');
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(fs.readdirSync(join(state, 'els')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

test('the wire joins a multi-byte character split across two socket chunks', async () => {
  const lines: string[] = [];
  const decoder = createLineDecoder((line) => lines.push(line));
  const bytes = Buffer.from('{"text":"한글 ✓"}\n');
  const cut = bytes.indexOf(Buffer.from('글')) + 1; // inside the 3-byte «글»
  decoder.push(bytes.subarray(0, cut));
  decoder.push(bytes.subarray(cut));
  expect(lines).toEqual(['{"text":"한글 ✓"}']);
});

test('do types «⇢ from · text» + Enter into an idle pane and strips control characters', async () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  const done = await core.do(pane, 'run\x1b[31m tests\nnow', 'mshq/OP');
  expect(done.exitCode).toBe(0);
  expect(ptys[0]!.writes).toEqual(['⇢ mshq/OP · run [31m tests now\r']);
  expect((await core.do(pane, '   ', 'OP')).exitCode).toBe(2);
  expect((await core.do('pdeadbeef', 'x', 'OP')).exitCode).toBe(1);
});

test('do queues while «Turn running», keeps order, and delivers one line per idle drain', async () => {
  let clock = 0;
  const { core, ptys } = owner(emptyJournal(), undefined, () => clock);
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['eln'] }));
  const fake = ptys[0]!;
  fake.setScreen('Turn running · 12s\n');
  expect((await core.do(pane, 'first', 'OP')).message).toContain('queued 1');
  expect((await core.do(pane, 'second', 'JUD')).message).toContain('queued 2');
  expect(fake.writes).toEqual([]);                 // never overwrites the running turn
  await core.drain();
  expect(fake.writes).toEqual([]);                 // still running
  fake.setScreen('> \n');
  // lines already waiting keep their order even though the screen is idle now
  expect((await core.do(pane, 'third', 'OP')).message).toContain('queued 3');
  await core.drain();
  expect(fake.writes).toEqual(['⇢ OP · first\r']);
  await core.drain();                              // settle time not over: no second line yet
  expect(fake.writes.length).toBe(1);
  clock += 2_500;
  await core.drain();
  clock += 2_500;
  await core.drain();
  expect(fake.writes).toEqual(['⇢ OP · first\r', '⇢ JUD · second\r', '⇢ OP · third\r']);
  expect(core.queued(pane)).toBe(0);
});

test('do fails closed when the busy check cannot render, caps the queue, and drops the queue when the pane exits', async () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['eln'] }));
  const fake = ptys[0]!;
  fake.failRenders();
  const refused = await core.do(pane, 'hello', 'OP');
  expect(refused.exitCode).toBe(1);
  expect(refused.message).toContain('not sent');
  expect(fake.writes).toEqual([]);
  const busy = owner();
  busy.core.start();
  const busyPane = paneOf(busy.core.newPane({ ws: 'HQ', cwd: '/work', command: ['eln'] }));
  busy.ptys[0]!.setScreen('Turn running\n');
  for (let i = 0; i < 20; i++) expect((await busy.core.do(busyPane, `n${i}`, 'OP')).exitCode).toBe(0);
  expect((await busy.core.do(busyPane, 'one too many', 'OP')).message).toContain('not queued');
  busy.ptys[0]!.exit();
  await settle();
  expect(busy.core.queued(busyPane)).toBe(0);
  expect((await busy.core.do(busyPane, 'late', 'OP')).exitCode).toBe(1);
});

test('do: a second line right after a delivery is queued (the screen may not show «Turn running» yet), then goes out after the settle time', async () => {
  let clock = 10_000;
  const { core, ptys } = owner(emptyJournal(), undefined, () => clock);
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['eln'] }));
  const fake = ptys[0]!;                           // the screen stays idle: the turn has not drawn yet
  expect((await core.do(pane, 'one', 'OP')).message).toContain('delivered');
  clock += 500;
  expect((await core.do(pane, 'two', 'OP')).message).toContain('queued 1');
  expect(fake.writes).toEqual(['⇢ OP · one\r']);
  clock += 2_500;
  await core.drain();
  expect(fake.writes).toEqual(['⇢ OP · one\r', '⇢ OP · two\r']);
  clock += 2_500;
  expect((await core.do(pane, 'three', 'OP')).message).toContain('delivered');   // settled and idle: straight through
});

test('do strips C1 control characters (0x9b is a one-byte CSI) as well as C0', async () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  await core.do(pane, 'a\u009b31mb\u0085c', 'OP');
  expect(ptys[0]!.writes).toEqual(['⇢ OP · a 31mb c\r']);
});

test('close stops the PTY and removes the pane and its tab; closeWorkspace removes everything under it; unknown refs fail', async () => {
  const { core, ptys, stored } = owner();
  core.start();
  const a = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  const b = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  const c = paneOf(core.newPane({ ws: 'OTHER', cwd: '/o', command: ['sh'] }));
  expect(core.close(a).exitCode).toBe(0);
  expect(ptys[0]!.pty.killed).toBe(true);
  expect(stored().panes.map((row) => row.id)).toEqual([b, c]);
  expect(stored().tabs).toHaveLength(2);
  expect(core.close('pdeadbeef').exitCode).toBe(1);
  expect(core.closeWorkspace('HQ').message).toContain('1 panes');
  expect(ptys[1]!.pty.killed).toBe(true);
  expect(stored().workspaces.map((row) => row.name)).toEqual(['OTHER']);
  expect(stored().panes.map((row) => row.id)).toEqual([c]);
  expect(core.closeWorkspace('nope').exitCode).toBe(1);
});

test('do: two do calls at the same moment on one idle pane — one goes out now, the other queues behind it, in order', async () => {
  let clock = 1_000;
  const { core, ptys } = owner(emptyJournal(), undefined, () => clock);
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['eln'] }));
  const fake = ptys[0]!;
  fake.holdRenders();                              // both calls reach the busy check before any screen is drawn
  const first = core.do(pane, 'first', 'OP');
  const second = core.do(pane, 'second', 'JUD');
  const third = core.do(pane, 'third', 'OP');
  await settle();
  fake.releaseRenders();
  const answers = await Promise.all([first, second, third]);
  expect(answers.map((row) => row.message.includes('delivered') ? 'now' : row.message.includes('queued') ? 'queued' : row.message)).toEqual(['now', 'queued', 'queued']);
  expect(fake.writes).toEqual(['⇢ OP · first\r']);
  clock += 2_500;
  await core.drain();
  clock += 2_500;
  await core.drain();
  expect(fake.writes).toEqual(['⇢ OP · first\r', '⇢ JUD · second\r', '⇢ OP · third\r']);
});

test('drain is per pane: a pane whose render never finishes does not hold back the queues of the other panes', async () => {
  let clock = 0;
  const { core, ptys } = owner(emptyJournal(), undefined, () => clock);
  core.start();
  const stuck = paneOf(core.newPane({ ws: 'HQ', cwd: '/a', command: ['eln'] }));
  const other = paneOf(core.newPane({ ws: 'HQ', cwd: '/b', command: ['eln'] }));
  ptys[0]!.setScreen('Turn running\n');
  ptys[1]!.setScreen('Turn running\n');
  await core.do(stuck, 'stuck-line', 'OP');
  await core.do(other, 'other-line', 'OP');
  ptys[0]!.setScreen('> \n');
  ptys[1]!.setScreen('> \n');
  ptys[0]!.holdRenders();                          // this pane's screen render hangs
  clock += 2_500;
  void core.drain();                               // starts the stuck pane's step, which never finishes
  await core.drain();                              // the other pane is still served
  expect(ptys[1]!.writes).toEqual(['⇢ OP · other-line\r']);
  expect(ptys[0]!.writes).toEqual([]);
  expect(core.queued(stuck)).toBe(1);
  ptys[0]!.releaseRenders();                       // it recovers: its line goes out on a later drain
  await settle();
  clock += 2_500;
  await core.drain();
  expect(ptys[0]!.writes).toEqual(['⇢ OP · stuck-line\r']);
});

test('a child tab survives a failed save: it stays in memory and the next save writes it', () => {
  const { core, stored, failSaves } = owner();
  core.start();
  failSaves(true);
  const opened = core.openVirtual({ ws: 'OP', cwd: '/', title: '↳ ⎇ harness · a ●', text: '' });
  expect(opened.exitCode).toBe(0);
  expect(stored().panes).toHaveLength(0);
  failSaves(false);
  expect(core.patchVirtual((JSON.parse(opened.message) as { pane: string }).pane, { text: 'x' }).message).toBe('ok');
  expect(stored().panes.map((p) => p.scrollback)).toEqual(['x']);
});

test('input: raw bytes reach the PTY as typed (no «⇢» line, nothing stripped); refusals leave the PTY alone', () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  expect(core.input(pane, 'ls\r\u001b[A').exitCode).toBe(0);
  expect(ptys[0]!.writes).toEqual(['ls\r\u001b[A']);
  expect(core.input('pdeadbeef', 'x').exitCode).toBe(1);
  expect(core.input(pane, 'x'.repeat(65_537)).exitCode).toBe(2);
  expect(core.input(pane, 7 as never).exitCode).toBe(2);
  expect(ptys[0]!.writes).toHaveLength(1);
  ptys[0]!.exit();
  expect(core.input(pane, 'x').message).toContain('is not running');
});

test('input starts the settle clock: a `do` right after a person typed is queued, not typed into the middle of a word', async () => {
  let clock = 1_000_000;
  const { core, ptys } = owner(emptyJournal(), undefined, () => clock);
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  core.input(pane, 'git sta');
  expect((await core.do(pane, 'hello', 'OP')).message).toContain('queued 1');
  expect(ptys[0]!.writes).toEqual(['git sta']);
});

test('resize: bounds are checked, the PTY and the remembered size follow, a PTY that cannot resize still remembers', () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  const sizes: [number, number][] = [];
  (ptys[0]!.pty as { resize?: (cols: number, rows: number) => void }).resize = (cols, rows) => { sizes.push([cols, rows]); };
  expect(core.paneSize(pane)).toEqual({ cols: 80, rows: 24 });
  expect(core.resize(pane, 120, 40)).toEqual({ exitCode: 0, message: '120x40' });
  expect(sizes).toEqual([[120, 40]]);
  expect(core.paneSize(pane)).toEqual({ cols: 120, rows: 40 });
  for (const [cols, rows] of [[9, 24], [501, 24], [80, 2], [80, 201], [80.5, 24], [Number.NaN, 24]]) expect(core.resize(pane, cols!, rows!).exitCode).toBe(2);
  expect(core.resize('pdeadbeef', 80, 24).exitCode).toBe(1);
  expect(sizes).toHaveLength(1);
  delete (ptys[0]!.pty as { resize?: unknown }).resize;
  expect(core.resize(pane, 100, 30).exitCode).toBe(0);
});

test('input: the limit is UTF-8 bytes, not characters — a Korean paste over 64 KiB is refused, one just under is delivered', () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  const over = '한'.repeat(21_846);            // 21,846 characters × 3 bytes = 65,538 bytes
  expect(over.length < 21_847).toBe(true); // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — fewer characters than the byte limit, so a length check would have let it through
  const refused = core.input(pane, over);
  expect([refused.exitCode, refused.message]).toEqual([2, expect.stringContaining('bytes')]);
  expect(ptys[0]!.writes).toEqual([]);
  expect(core.input(pane, '한'.repeat(21_845)).exitCode).toBe(0);   // 65,535 bytes
  expect(ptys[0]!.writes).toHaveLength(1);
});

/** Three workspaces with ids, and a second tab in the first, so order questions have an answer. */
function ordered() {
  const o = owner();
  o.core.start();
  const a = paneOf(o.core.newPane({ ws: 'A', cwd: '/a', command: ['sh'] }));
  const b = paneOf(o.core.newPane({ ws: 'B', cwd: '/b', command: ['sh'] }));
  const c = paneOf(o.core.newPane({ ws: 'C', cwd: '/c', command: ['sh'] }));
  const a2 = paneOf(o.core.newPane({ ws: 'A', cwd: '/a2', command: ['sh'] }));
  const rows = () => (JSON.parse(o.core.list().message) as { panes: { workspace: string; tab: string; pane: string }[] }).panes;
  return { ...o, a, b, c, a2, rows, order: () => rows().map((row) => `${row.workspace}:${row.pane}`) };
}

test('reorder workspace: before another, to the end, by name or id; ls follows; a no-op and bad input change nothing', () => {
  const t = ordered();
  expect(t.order()).toEqual([`A:${t.a}`, `A:${t.a2}`, `B:${t.b}`, `C:${t.c}`]);
  expect(t.core.reorder({ kind: 'workspace', id: 'C', before: 'A' }).exitCode).toBe(0);
  expect(t.order()).toEqual([`C:${t.c}`, `A:${t.a}`, `A:${t.a2}`, `B:${t.b}`]);
  expect(t.core.reorder({ kind: 'workspace', id: 'A' }).exitCode).toBe(0);               // no before = the end
  expect(t.order()).toEqual([`C:${t.c}`, `B:${t.b}`, `A:${t.a}`, `A:${t.a2}`]);
  const before = t.order();
  expect(t.core.reorder({ kind: 'workspace', id: 'B', before: 'B' }).message).toContain('stays');
  expect(t.core.reorder({ kind: 'workspace', id: 'nope' }).exitCode).toBe(1);
  expect(t.core.reorder({ kind: 'workspace', id: 'B', before: 'nope' }).exitCode).toBe(1);
  expect(t.core.reorder({ kind: 'pane', id: 'B' }).exitCode).toBe(2);
  expect(t.core.reorder({ kind: 'workspace', id: 7 as never }).exitCode).toBe(2);
  expect(t.order()).toEqual(before);
});

test('reorder tab: inside its own workspace only; before a sibling or to the end of the workspace; another workspace is refused', () => {
  const t = ordered();
  const tabOf = (pane: string) => t.rows().find((row) => row.pane === pane)!.tab;
  expect(t.core.reorder({ kind: 'tab', id: tabOf(t.a2), before: tabOf(t.a) }).exitCode).toBe(0);
  expect(t.order()).toEqual([`A:${t.a2}`, `A:${t.a}`, `B:${t.b}`, `C:${t.c}`]);
  expect(t.core.reorder({ kind: 'tab', id: tabOf(t.a2) }).exitCode).toBe(0);               // to the end of A, not of the journal
  expect(t.order()).toEqual([`A:${t.a}`, `A:${t.a2}`, `B:${t.b}`, `C:${t.c}`]);
  const before = t.order();
  expect(t.core.reorder({ kind: 'tab', id: tabOf(t.a), before: tabOf(t.b) }).exitCode).toBe(2);
  expect(t.core.reorder({ kind: 'tab', id: 'tnope' }).exitCode).toBe(1);
  expect(t.order()).toEqual(before);
});

test('reorder is saved with the journal: a new owner over the same file lists the same order; a failed save changes nothing', () => {
  const t = ordered();
  t.core.reorder({ kind: 'workspace', id: 'B', before: 'A' });
  const saved = t.stored();
  expect(saved.workspaces.map((ws) => ws.name)).toEqual(['B', 'A', 'C']);
  const again = createElsCore({ load: () => saved, save: () => {}, spawn: () => fakePty('x').pty });
  again.start();
  expect((JSON.parse(again.list().message) as { panes: { workspace: string }[] }).panes.map((row) => row.workspace)).toEqual(['B', 'A', 'A', 'C']);
  t.failSaves(true);
  const refused = t.core.reorder({ kind: 'workspace', id: 'C', before: 'B' });
  expect([refused.exitCode, refused.message]).toEqual([1, expect.stringContaining('not saved')]);
  t.failSaves(false);
  expect(t.order().map((entry) => entry.split(':')[0])).toEqual(['B', 'A', 'A', 'C']);
});

test('reorder: an empty `before` means the end, exactly like omitting it or «end»; a blank or unknown name is still refused', () => {
  const spellings: [string, { before?: string }][] = [['omitted', {}], ['empty', { before: '' }], ['end', { before: 'end' }]];
  for (const [label, extra] of spellings) {
    const t = ordered();
    expect([label, t.core.reorder({ kind: 'workspace', id: 'A', ...extra }).exitCode]).toEqual([label, 0]);
    expect([label, t.order()]).toEqual([label, [`B:${t.b}`, `C:${t.c}`, `A:${t.a}`, `A:${t.a2}`]]);
  }
  const t = ordered();
  const unchanged = t.order();
  expect(t.core.reorder({ kind: 'workspace', id: 'A', before: ' ' }).exitCode).toBe(1);
  expect(t.core.reorder({ kind: 'tab', id: 'tnope', before: '' }).exitCode).toBe(1);
  expect(t.order()).toEqual(unchanged);
});

test('pane build reports belong to live PTYs and expire without a heartbeat', () => {
  let clock = 1000;
  const { core, ptys } = owner(emptyJournal(), undefined, () => clock);
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  const build = () => (JSON.parse(core.list().message) as { panes: { build: { sha: string | null; age: string } }[] }).panes[0]!.build;
  expect(build().sha).toBeNull();
  expect(core.reportBuild(pane, 'bad').exitCode).toBe(1);
  expect(core.reportBuild('missing', 'a'.repeat(40)).exitCode).toBe(1);
  expect(core.reportBuild(pane, 'a'.repeat(40)).exitCode).toBe(0);
  expect(build()).toMatchObject({ sha: 'a'.repeat(40), source: 'self-reported', trusted: false });
  clock += 90_000;
  expect(build()).toMatchObject({ sha: null, age: 'unknown' });
  core.reportBuild(pane, 'a'.repeat(40));
  ptys[0]!.exit();
  expect(build()).toMatchObject({ sha: null, age: 'unknown' });
  expect(core.reportBuild(pane, 'a'.repeat(40)).exitCode).toBe(1);
});

test('verified send submits an intact long multiline paste and observes the turn start', async () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  const body = `${'한글'.repeat(4000)}\nnext line`;
  const sent = core.sendVerified(pane, body);
  await settle();
  expect(ptys[0]!.writes).toEqual([`\x1b[200~${body}\x1b[201~\r`]);
  ptys[0]!.setScreen('• Working (1s • esc to interrupt)');
  const result = await sent;
  expect(result.exitCode).toBe(0);
  expect(result.message).toContain('turn started');
});

test('verified send refuses an already running pane and an injected paste terminator', async () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  ptys[0]!.setScreen('Turn running');
  expect((await core.sendVerified(pane, 'new task')).message).toContain('not sent');
  expect((await core.sendVerified(pane, 'bad\x1b[201~payload')).exitCode).toBe(2);
  expect(ptys[0]!.writes).toEqual([]);
});

test('verified send reports an unobserved start without claiming failure to submit', async () => {
  const { core } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  const result = await core.sendVerified(pane, 'task');
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain('submitted; turn start not observed');
}, 5000);

// D10 (els-round1b-a110): 3 concurrent seats, mock provider, turn finishes in 0s — «Turn running» never
// renders before the first 100ms poll, but the fresh «✻ Worked for» completion hint proves the turn started.
test('verified send observes a fast turn through its fresh completion hint (busy marker missed)', async () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  const sent = core.sendVerified(pane, 'SYNTHETIC simultaneous');
  await settle();
  expect(ptys[0]!.writes).toEqual(['\x1b[200~SYNTHETIC simultaneous\x1b[201~\r']);
  ptys[0]!.setScreen('elanous\n\n> \n\nSYNTHETIC_OK\n\n✻ Worked for 0s · done 2:35 PM\n❯ \n● Turn done · Enter send');
  const result = await sent;
  expect(result.exitCode).toBe(0);
  expect(result.message).toContain('turn started (already completed before the busy marker could be observed)');
}, 5000);

test('verified send does not mistake a completion hint that predates the submit for a started turn', async () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  ptys[0]!.setScreen('✻ Worked for 9s · done 1:00 PM\n❯ \n● Turn done');
  const result = await core.sendVerified(pane, 'task');
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain('submitted; turn start not observed');
}, 5000);

test('verified send uses checked plain mode when bracketed paste is unavailable', async () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  ptys[0]!.pty.bracketedPasteEnabled = () => false;
  const result = await core.sendVerified(pane, 'echo safely\n');
  expect(result.exitCode).toBe(0);
  expect(result.message).toContain('mode=plain; turn start unverified');
  expect(ptys[0]!.writes).toEqual(['echo safely\r']);
});

test('plain mode refuses a body with a line break inside (it would submit two commands) — nothing is written (JUD-B #103319)', async () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  ptys[0]!.pty.bracketedPasteEnabled = () => false;
  const result = await core.sendVerified(pane, 'echo one\nrm -rf ~\n');
  expect(result).toEqual({ exitCode: 2, message: 'els send: plain 모드는 한 줄 텍스트만 — 줄바꿈·제어 문자가 있어 보내지 않음 (bracketed paste 를 켠 pane 에선 여러 줄 가능)' });
  expect(ptys[0]!.writes).toEqual([]);
});

test('plain mode refuses Ctrl-C / Ctrl-D / DEL inside the body; TAB is still text; bracketed paste keeps multi-line (JUD-B #103319)', async () => {
  const { core, ptys } = owner();
  core.start();
  const pane = paneOf(core.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }));
  ptys[0]!.pty.bracketedPasteEnabled = () => false;
  for (const body of ['sleep 9\u0003', 'cat\u0004', 'ab\u007fc', 'a\rb']) expect((await core.sendVerified(pane, body)).exitCode).toBe(2);
  expect(ptys[0]!.writes).toEqual([]);
  expect((await core.sendVerified(pane, 'printf "a\tb"')).exitCode).toBe(0);
  expect(ptys[0]!.writes).toEqual(['printf "a\tb"\r']);
});
