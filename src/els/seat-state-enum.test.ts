// SEAT-STATE-ENUM — the els side: a pane's code report becomes pane.status = {state, reason, since} in the listing, the
// `els ls --state/--ws` filter keeps panes by that code, and the agents column marks it — no screen text is ever read
// (the fake PTY's screen says the opposite of the state on purpose). Expectations are literals.
import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';
import { parsePaneRows } from './attach-view.js';
import { layoutSpaceList, withCommands } from './space-tabs-view.js';
import { filterPanesBySeatState, parseStateFilter, statusBoardLines, viewerSpaces } from './seat-status.js';
import type { AgentEventFrame } from '../agent-events/protocol.js';

function world() {
  let journal = emptyJournal(), clock = 1_700_000_000_000, count = 0;
  const output = clock - 40_000;   // quiet for 40 s: past the 30 s output window (a pane with no report reads idle), far from the 15 min stall
  const core = createElsCore({ load: () => journal, save: (next) => { journal = next; }, now: () => clock,
    spawn: () => { const id = `pty${++count}`; return { id, isAlive: () => true, write: () => {}, renderScreen: async () => '⏸ Blocked: a person is needed', onExit: () => {}, kill: () => {}, lastOutputAt: () => output } as ElsPty; },
    mailBadges: () => new Map() });
  core.start();
  const make = (ws: string, title: string) => (JSON.parse(core.newPane({ ws, cwd: '/tmp', command: ['sh'], title }).message) as { pane: string }).pane;
  const blocked = make('HQ', 'TC-SEAT'), working = make('HQ', 'UX-SEAT'), other = make('JUD', 'JUD-SEAT');
  const fg = (pid: number) => ({ kind: 'eln' as const, pid, command: ['eln'] });
  core.setForegrounds(new Map([[blocked, fg(1)], [working, fg(2)], [other, fg(3)]]));
  let seq = 0;
  const send = (pane: string, event: AgentEventFrame['event']) => core.agentEvent(pane, { op: 'event', v: 1, ws: 'HQ', pane, sid: `s-${pane}`, seq: ++seq, at: clock, event });
  const list = () => JSON.parse(core.list().message) as { panes: { pane: string; workspace: string; status: unknown }[]; workspaces: { name: string; coordinatorSeat?: string }[] };
  return { core, blocked, working, other, send, list, tick: (ms: number) => { clock += ms; }, at: () => clock };
}

test('a BLOCKED report becomes pane.status {state, reason, since} and `els ls --state BLOCKED` returns that pane', () => {
  const w = world();
  const t0 = w.at();
  expect(w.send(w.blocked, { kind: 'state', state: 'blocked', code: 'BLOCKED', reason: 'OWNER_UNKNOWN', detail: 'plan-blocked' }).exitCode).toBe(0);
  expect(w.send(w.working, { kind: 'turn', phase: 'start', id: 't1' }).exitCode).toBe(0);
  expect(w.send(w.working, { kind: 'state', state: 'working' }).exitCode).toBe(0);
  const row = w.list().panes.find((p) => p.pane === w.blocked)!;
  expect(row.status).toEqual({ state: 'BLOCKED', reason: 'OWNER_UNKNOWN', detail: 'plan-blocked', since: t0, source: 'reported' });
  expect(w.list().panes.find((p) => p.pane === w.working)!.status).toEqual({ state: 'WORKING', since: t0, source: 'derived' });

  const states = parseStateFilter('BLOCKED');
  if (!states.ok) throw new Error(states.message);
  expect(filterPanesBySeatState(w.list().panes, { states: states.states }).map((p) => p.pane)).toEqual([w.blocked]);
  const several = parseStateFilter('blocked,WAITING_APPROVAL,STALLED,EXITED');
  if (!several.ok) throw new Error(several.message);
  expect(filterPanesBySeatState(w.list().panes, { states: several.states }).map((p) => p.pane)).toEqual([w.blocked]);
  expect(filterPanesBySeatState(w.list().panes, { states: states.states, ws: 'JUD' })).toEqual([]);
  expect(parseStateFilter('PERSON_NEEDED')).toEqual({ ok: false, message: 'els ls --state: unknown state PERSON_NEEDED; one of WORKING, IDLE, WAITING_REPLY, WAITING_APPROVAL, BLOCKED, STALLED, EXITED' });

  // since holds while the state and reason hold; a new turn clears the block.
  w.tick(60_000);
  expect((w.list().panes.find((p) => p.pane === w.blocked)!.status as { since: number }).since).toBe(t0);
  expect(w.send(w.blocked, { kind: 'turn', phase: 'start', id: 't2' }).exitCode).toBe(0);
  expect(w.list().panes.find((p) => p.pane === w.blocked)!.status).toEqual({ state: 'WORKING', since: t0 + 60_000, source: 'derived' });
});

test('the agents column marks BLOCKED 🟡 from the code, while the screen text is never consulted', () => {
  const w = world();
  w.send(w.blocked, { kind: 'state', state: 'blocked', code: 'BLOCKED', reason: 'OWNER_UNKNOWN' });
  w.send(w.working, { kind: 'turn', phase: 'start', id: 't1' });
  w.send(w.working, { kind: 'state', state: 'waiting-input', code: 'WAITING_APPROVAL', reason: 'APPROVAL_PENDING' });
  const json = w.core.list().message;
  const shown = layoutSpaceList(withCommands(parsePaneRows(json), json), w.blocked, 28, 20).lines.join('\n');
  expect(shown).toContain('🟡 TC-SEAT');
  expect(shown).toContain('🟡 UX-SEAT');
  expect(shown).toContain('⚪ JUD-SEAT');   // its screen says «Blocked» too; with no code it is idle
});

test('a different detail wording with the same code keeps the same state and since', () => {
  const w = world();
  const t0 = w.at();
  w.send(w.blocked, { kind: 'state', state: 'blocked', code: 'BLOCKED', reason: 'OWNER_UNKNOWN', detail: 'first wording' });
  w.tick(5_000);
  w.send(w.blocked, { kind: 'state', state: 'blocked', code: 'BLOCKED', reason: 'OWNER_UNKNOWN', detail: 'completely different words' });
  const status = w.list().panes.find((p) => p.pane === w.blocked)!.status as { state: string; reason: string; since: number };
  expect([status.state, status.reason, status.since]).toEqual(['BLOCKED', 'OWNER_UNKNOWN', t0]);
});

test('coordinator scope: OP and the HQ seat see every space, a sub-coordinator its own spaces', () => {
  const listed = { hqCoordinatorSeat: 'OP', workspaces: [{ name: 'HQ', coordinatorSeat: 'OP' }, { name: 'JUD', coordinatorSeat: 'JUD' }] };
  expect(viewerSpaces('OP', listed)).toBeUndefined();
  expect(viewerSpaces(null, listed)).toBeUndefined();
  expect(viewerSpaces('JUD', listed)).toEqual(['JUD']);
  expect(viewerSpaces('TC', listed)).toBeUndefined();
  const panes = [{ pane: 'a', workspace: 'HQ', status: { state: 'BLOCKED', reason: 'NO_WORK', since: 1 } }, { pane: 'b', workspace: 'JUD', status: { state: 'BLOCKED', reason: 'NO_WORK', since: 1 } }];
  expect(filterPanesBySeatState(panes, { states: ['BLOCKED'], scope: ['JUD'] }).map((p) => p.pane)).toEqual(['b']);
  // A status without its reason is not a valid BLOCKED (exactly one reason) and never matches.
  expect(filterPanesBySeatState([{ pane: 'c', workspace: 'HQ', status: { state: 'BLOCKED', since: 1 } }], { states: ['BLOCKED'] })).toEqual([]);
});

test('status-board: one line per seat from the codes, and the reported model', () => {
  const w = world();
  w.send(w.blocked, { kind: 'meta', model: 'gpt-6.1-terra' });
  w.send(w.blocked, { kind: 'state', state: 'blocked', code: 'BLOCKED', reason: 'OWNER_UNKNOWN' });
  w.tick(120_000);
  const panes = w.list().panes.filter((p) => p.pane === w.blocked).map((p) => ({ ...p, address: 'HQ/t/p', seat: 'TC' }));
  expect(statusBoardLines(panes, w.at())).toEqual([
    'SEAT  STATE    REASON         SINCE  MODEL          ADDRESS',
    'TC    BLOCKED  OWNER_UNKNOWN  2m     gpt-6.1-terra  HQ/t/p',
  ]);
});
