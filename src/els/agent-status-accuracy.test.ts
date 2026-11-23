import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';
import { parsePaneRows } from './attach-view.js';
import { layoutSpaceList, withCommands } from './space-tabs-view.js';
import type { AgentEventFrame } from '../agent-events/protocol.js';

test('agent status derives from turn events, output time and foreground process, never a read', async () => {
  let journal = emptyJournal(), clock = 100_000, output = 99_000, count = 0;
  const core = createElsCore({ load: () => journal, save: next => { journal = next; }, now: () => clock,
    spawn: () => { const id = `pty${++count}`; return { id, isAlive: () => true, write: () => {}, renderScreen: async () => 'irrelevant', onExit: () => {}, kill: () => {}, lastOutputAt: () => output } as ElsPty; }, mailBadges: () => new Map() });
  core.start();
  const make = (title: string) => (JSON.parse(core.newPane({ ws: 'HQ', cwd: '/tmp', command: ['sh'], title }).message) as { pane: string }).pane;
  const eln = make('ELN-SEAT'), shell = make('SHELL'), codex = make('CODEX');
  const fg = (kind: 'eln' | 'shell' | 'codex' | 'other', pid: number) => ({ kind, pid, command: [kind] });
  core.setForegrounds(new Map([[eln, fg('shell', 10)], [shell, fg('shell', 2)], [codex, fg('codex', 3)]]));
  const frame = (seq: number, phase: 'start' | 'end'): AgentEventFrame => ({ op: 'event', v: 1, ws: 'HQ', pane: eln, sid: 'session', seq, at: clock, event: { kind: 'turn', phase, id: 'turn1' } });
  expect(core.agentEvent(eln, frame(1, 'start')).exitCode).toBe(0);
  core.setForegrounds(new Map([[eln, fg('eln', 1)], [shell, fg('shell', 2)], [codex, fg('codex', 3)]]));
  const states = () => Object.fromEntries((JSON.parse(core.list().message) as { panes: { pane: string; activityState: string }[] }).panes.map(row => [row.pane, row.activityState]));
  expect(states()).toEqual({ [eln]: 'working', [shell]: 'idle', [codex]: 'working' });
  await core.read(eln);
  expect(states()[eln]).toBe('working');
  const json = core.list().message, rows = withCommands(parsePaneRows(json), json);
  const shown = layoutSpaceList(rows, eln, 28, 14).lines.join('\n');
  expect(shown).toContain('🟢 ELN-SEAT'); expect(shown).toContain('⚪ SHELL');
  clock += 31_000;
  expect(states()[codex]).toBe('idle');
  output = clock;
  expect(states()[codex]).toBe('working');
  expect(core.agentEvent(eln, frame(1, 'end')).exitCode).toBe(1);
  expect(states()[eln]).toBe('working');
  expect(core.agentEvent(eln, frame(2, 'end')).exitCode).toBe(0);
  expect(states()[eln]).toBe('idle');
  expect(core.agentEvent(eln, { ...frame(3, 'start'), event: { kind: 'state', state: 'waiting-input' } }).exitCode).toBe(0);
  expect(states()[eln]).toBe('blocked');
  core.setForegrounds(new Map([[eln, fg('eln', 1)], [shell, fg('other', 4)], [codex, fg('codex', 3)]]));
  expect(states()[shell]).toBe('working');
  core.setForegrounds(new Map([[eln, fg('shell', 10)], [shell, fg('shell', 2)], [codex, fg('codex', 3)]]));
  expect(states()[eln]).toBe('idle');
  core.setForegrounds(new Map([[eln, fg('eln', 11)], [shell, fg('shell', 2)], [codex, fg('codex', 3)]]));
  expect(states()[eln]).toBe('working');   // ELS-AGENT-STATUS-UNKNOWN: a new eln with no turn event yet reads its recent output, not «?»
});
