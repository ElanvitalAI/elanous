import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { createElsCore, type ElsPty } from './core.js';
import { connectHolderElsPty, type HolderMeta } from './holder.js';
import { emptyJournal } from './space.js';
import { parsePaneRows } from './attach-view.js';
import { layoutSpaceList, withCommands } from './space-tabs-view.js';

// ELS-AGENT-STATUS-UNKNOWN-AND-TAB-BAR (OP 11-23): the agents list read «?» for almost every live seat. Two causes:
// the holder-backed PTY learned its output time only from a screen read, and a pane without a self-report (an eln started
// before #39760, or a pane the foreground probe missed) listed `unknown`. Expectations are literals (OP rule 11).

class FakeSocket extends EventEmitter {
  destroyed = false;
  write() { return true; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
  receive(message: object) { this.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)); }
}
const meta: HolderMeta = { paneId: 'pane', ptyId: 'generation', pid: 42, cwd: '/', command: ['fake'], title: 'fake', socketPath: '/fake', startedAt: 0, cols: 80, rows: 24 };

test('holder PTY: an output broadcast sets the output time; a snapshot never moves it back', () => {
  const socket = new FakeSocket();
  const pty = connectHolderElsPty('/fake', 'pane', meta, () => undefined, (() => socket as unknown as Socket) as never);
  socket.emit('connect');
  socket.receive({ type: 'pong', paneId: 'pane', ptyId: 'generation', pid: 42 });
  expect(pty.lastOutputAt?.()).toBeUndefined();
  const before = Date.now();
  socket.receive({ type: 'output', paneId: 'pane', chunk: 'codex is thinking' });
  const seen = pty.lastOutputAt?.();
  expect(seen).toBeGreaterThanOrEqual(before);
  expect(seen).toBeLessThanOrEqual(Date.now());
  const screen = pty.renderScreen();
  socket.receive({ type: 'snapshot', paneId: 'pane', ptyId: 'generation', pid: 42, alive: true, bracketedPaste: false, lastOutputAt: 1_000, screen: 'ok' });
  expect(pty.lastOutputAt?.()).toBe(seen!);
  void screen;
  pty.detach?.();
});

test('a live pane always gets an activity status: no self-report or no probe → output time decides; never «?»', () => {
  let journal = emptyJournal(), clock = 100_000, count = 0;
  const outputs = new Map<string, number | undefined>();
  const core = createElsCore({ load: () => journal, save: next => { journal = next; }, now: () => clock, mailBadges: () => new Map(),
    spawn: () => { const id = `pty${++count}`; return { id, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {}, lastOutputAt: () => outputs.get(id) } as ElsPty; } });
  core.start();
  const make = (title: string) => (JSON.parse(core.newPane({ ws: 'HQ', cwd: '/tmp', command: ['sh'], title }).message) as { pane: string }).pane;
  const busyEln = make('JUD-B'), quietEln = make('JUD-3'), silentCodex = make('TC-H-CX-7'), unprobed = make('REVIEW-1');
  outputs.set('pty1', 99_000); outputs.set('pty2', 10_000); outputs.set('pty3', undefined); outputs.set('pty4', 95_000);
  const fg = (kind: 'eln' | 'codex', pid: number) => ({ kind, pid, command: [kind] });
  core.setForegrounds(new Map([[busyEln, fg('eln', 1)], [quietEln, fg('eln', 2)], [silentCodex, fg('codex', 3)]]));
  const states = () => Object.fromEntries((JSON.parse(core.list().message) as { panes: { pane: string; activityState: string }[] }).panes.map(row => [row.pane, row.activityState]));
  expect(states()).toEqual({ [busyEln]: 'working', [quietEln]: 'idle', [silentCodex]: 'idle', [unprobed]: 'working' });
  const json = core.list().message;
  const shown = layoutSpaceList(withCommands(parsePaneRows(json), json), busyEln, 28, 14).lines.join('\n');
  expect(shown).toContain('🟢 JUD-B'); expect(shown).toContain('⚪ JUD-3'); expect(shown).toContain('⚪ TC-H-CX-7'); expect(shown).toContain('🟢 REVIEW-1');
  expect(shown).not.toContain('? ');
  clock += 31_000;                                   // past the 30 s window: the busy ones go quiet
  expect(states()).toEqual({ [busyEln]: 'idle', [quietEln]: 'idle', [silentCodex]: 'idle', [unprobed]: 'idle' });
  // A turn event still wins over the output time for an eln that reports.
  expect(core.agentEvent(quietEln, { op: 'event', v: 1, ws: 'HQ', pane: quietEln, sid: 's', seq: 1, at: clock, event: { kind: 'turn', phase: 'start', id: 't1' } }).exitCode).toBe(0);
  expect(states()[quietEln]).toBe('working');
});
