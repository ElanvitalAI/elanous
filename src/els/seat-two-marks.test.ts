// SIDETAB-TWO-MARKS (대표 11-24 14:0x defect: JUD-B showed ⚪ idle while its eln screen said «a person is needed»).
// Every seat row has two marks: slot 1 activity, slot 2 attention. Expectations are literals; the chain under test is
// eln bridge (publisher) → els core (agentEvent) → list JSON → sidebar rows / `els --list` lines.
import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';
import { parsePaneRows } from './attach-view.js';
import { layoutSpaceList, withCommands } from './space-tabs-view.js';
import { createAgentEventBridge, type AgentEventSink } from '../tui/agent-event-bridge.js';
import { paneListLines } from '../cli/els-cli.js';
import type { AgentEventFrame } from '../agent-events/protocol.js';

function world() {
  let journal = emptyJournal(); const clock = 1_700_000_000_000; let count = 0;
  const core = createElsCore({ load: () => journal, save: (next) => { journal = next; }, now: () => clock,
    spawn: () => { const id = `pty${++count}`; return { id, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {}, lastOutputAt: () => clock - 40_000 } as ElsPty; },
    mailBadges: () => new Map() });
  core.start();
  const make = (title: string) => (JSON.parse(core.newPane({ ws: 'JUD', cwd: '/tmp', command: ['sh'], title }).message) as { pane: string }).pane;
  const calm = make('JUD-A'), stuck = make('JUD-B');
  core.setForegrounds(new Map([[calm, { kind: 'eln' as const, pid: 1, command: ['eln'] }], [stuck, { kind: 'eln' as const, pid: 2, command: ['eln'] }]]));
  let seq = 0;
  const sinkFor = (pane: string): AgentEventSink => {
    const send = (event: AgentEventFrame['event']) => { core.agentEvent(pane, { op: 'event', v: 1, ws: 'JUD', pane, sid: `s-${pane}`, seq: ++seq, at: clock, event }); };
    return { state: (state) => send({ kind: 'state', state }), turn: (phase, id) => send({ kind: 'turn', phase, id }), notice: () => {},
      seatState: (input) => send({ kind: 'state', state: input.state === 'BLOCKED' ? 'blocked' : input.state === 'WAITING_APPROVAL' ? 'waiting-input' : 'idle', code: input.state, ...(input.reason ? { reason: input.reason } : {}) }) };
  };
  const json = () => core.list().message;
  const sidebar = () => { const j = json(); return layoutSpaceList(withCommands(parsePaneRows(j), j), calm, 40, 24).lines.join('\n'); };
  return { calm, stuck, sinkFor, json, sidebar };
}

test('TUI enters the needs-person block: published BLOCKED(HUMAN_DECISION), row shows ⚪✋ first in its group, header ✋1; resume clears it', () => {
  const w = world();
  const calm = createAgentEventBridge(w.sinkFor(w.calm), () => 'c1');
  const stuck = createAgentEventBridge(w.sinkFor(w.stuck), () => 'b1');
  calm.busy(true); calm.busy(false);
  stuck.busy(true);
  stuck.blocked('HUMAN_DECISION', 'plan-blocked');
  stuck.busy(false);
  const status = (JSON.parse(w.json()) as { panes: { title: string; status: { state: string; reason?: string } }[] }).panes.find((p) => p.title === 'JUD-B')!.status;
  expect([status.state, status.reason]).toEqual(['BLOCKED', 'HUMAN_DECISION']);
  const shown = w.sidebar().split('\n');
  const agentRows = shown.filter((line) => /JUD-[AB]/.test(line) && !line.includes('agent'));
  expect(shown.some((line) => line.includes('⚪✋ JUD-B'))).toBe(true);
  expect(shown.findIndex((line) => line.includes('JUD-B'))).toBeLessThan(shown.findIndex((line) => line.includes('JUD-A')));
  expect(agentRows.length).toBeGreaterThan(0);
  expect(shown.some((line) => line.includes('JUD ✋1'))).toBe(true);
  // A later turn of the seat's own (mail wake) must not overwrite the block with idle.
  stuck.busy(true); stuck.busy(false);
  expect(w.sidebar()).toContain('⚪✋ JUD-B');
  // A person resumes.
  stuck.resume();
  const after = w.sidebar();
  expect(after).not.toContain('✋');
  expect(after).toContain('⚪ JUD-B');
});

test('a person-needed WAITING_APPROVAL reads ✋ too, and closing the prompt on a latched block returns to the block', () => {
  const w = world();
  const stuck = createAgentEventBridge(w.sinkFor(w.stuck), () => 'b1');
  stuck.approval(true);
  expect(w.sidebar()).toContain('⚪✋ JUD-B');
  stuck.approval(false);
  expect(w.sidebar()).not.toContain('✋');
});

const listWith = (status: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ workspaces: [], tabs: [], panes: [
  { pane: 'p1', address: 'JUD/t1/p1', tab: 't1', workspace: 'JUD', title: 'JUD-B', state: 'idle', activityState: 'idle', cwd: '/tmp', status, ...extra }] });
const rowsOf = (json: string) => layoutSpaceList(withCommands(parsePaneRows(json), json), 'p1', 40, 24).lines.join('\n');

test('unread mail 3 reads ✉3 in slot 2', () => {
  expect(rowsOf(listWith({ state: 'IDLE', since: 1, source: 'derived' }, { unreadMail: { count: 3 } }))).toContain('⚪✉3 JUD-B');
});

test('idle with a timer wait reads ⚪⏳', () => {
  expect(rowsOf(listWith({ state: 'WAITING_REPLY', reason: 'DEPENDENCY_WAIT', since: 1, source: 'reported' }))).toContain('⚪⏳ JUD-B');
});

test('working with no attention shows slot 1 only, stalled shows 🟤', () => {
  expect(rowsOf(listWith({ state: 'WORKING', since: 1, source: 'reported' }, { state: 'working', activityState: 'working' }))).toContain('🟢 JUD-B');
  expect(rowsOf(listWith({ state: 'STALLED', since: 1, source: 'derived' }, { state: 'working', activityState: 'working', stalled: true }))).toContain('🟤 JUD-B');
});

test('`els --list` carries the two marks and lists the person-needed seat first', () => {
  const json = JSON.stringify({ panes: [
    { address: 'JUD/t1/p1', title: 'JUD-A', state: 'idle', cwd: '/tmp', badgeLabel: '[· idle]', status: { state: 'IDLE', since: 1, source: 'derived' } },
    { address: 'JUD/t2/p2', title: 'JUD-B', state: 'idle', cwd: '/tmp', badgeLabel: '[· idle]', status: { state: 'BLOCKED', reason: 'HUMAN_DECISION', since: 1, source: 'reported' } }] });
  const lines = paneListLines(json, 0);
  expect(lines[0]).toContain('⚪✋ JUD-B');
  expect(lines[1]).toContain('⚪ JUD-A');
});
