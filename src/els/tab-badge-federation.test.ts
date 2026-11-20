// ELS-TAB-STATE-BADGE (federation + restart + precedence) — automatic assertions, no console output.
//
// SCOPE, stated plainly: every test here uses an IN-MEMORY els core (journal kept in a variable), a FAKE PTY and an
// INJECTED clock. The remote hop is the REAL `routeElsHttp` /els/ls router wired to `createFederation`'s `fetchJson`
// by an injected function (no socket, no network, not two real hosts). The reattach test hands the core a fake PTY
// whose `lastOutputAt` stands for a holder that outlived a server restart; a real holder/server restart is a separate
// scope (restart-survive.test.ts). Nothing sleeps: time is the injected clock.
import { expect, test } from 'bun:test';
import { paneListLines } from '../cli/els-cli.js';
import { elsRowsFromList } from '../tui/sidetab/els-rows.js';
import { parsePaneRows } from './attach-view.js';
import { createElsCore, type ElsPty } from './core.js';
import { createFederation } from './federation.js';
import { routeElsHttp } from './http.js';
import { emptyJournal, type SpaceJournal } from './space.js';
import { buildSpaceList, withCommands } from './space-tabs-view.js';

const T0 = 1_700_000_000_000;
const WINDOW_MS = 900_000; // 15 minutes, written as a literal on purpose (not STALLED_AFTER_MS_DEFAULT).

interface FakePty extends ElsPty { output: number | undefined }
const fakePty = (id: string, output?: number): FakePty => {
  const pty: FakePty = { id, output, isAlive: () => true, write: () => {}, renderScreen: async () => 'ready\n', onExit: () => {}, kill: () => {},
    lastOutputAt: () => pty.output };
  return pty;
};

interface Row { badge: string; badgeLabel: string; stalled: boolean; lastEventAtMs: number; state: string }
const rowsOf = (listJson: string): Row[] => (JSON.parse(listJson) as { panes: Row[] }).panes;
const pick = (row: Row) => ({ badge: row.badge, badgeLabel: row.badgeLabel, stalled: row.stalled, lastEventAtMs: row.lastEventAtMs });

/** One origin server (in-memory core, injected clock, fake PTY) and a federation that reads it through the real /els/ls router. */
function origin(remoteBodyOf?: (body: unknown) => unknown) {
  let stored: SpaceJournal = emptyJournal();
  const clock = { at: T0 };
  const pty = fakePty('pty_1');
  const core = createElsCore({ load: () => stored, save: (next) => { stored = next; }, spawn: () => pty, now: () => clock.at });
  core.start();
  expect(core.newPane({ ws: 'OP', cwd: '/work', command: ['sh'] }).exitCode).toBe(0);
  const fed = createFederation({
    localHost: 'mshq',
    askLocal: async () => ({ exitCode: 0, message: JSON.stringify({ workspaces: [], tabs: [], panes: [] }) }),
    registry: { hosts: [{ name: 'host-a', baseUrl: 'http://host-a.example:8790' }], rejected: [] },
    // Injected transport: the real router answers, the body is parsed as the HTTP client would. No network.
    fetchJson: async (_host, path) => {
      const answer = await routeElsHttp(core, 'host-a', 'GET', path);
      const body = JSON.parse(answer.body) as unknown;
      return { status: answer.status, body: remoteBodyOf ? remoteBodyOf(body) : body };
    },
  });
  return { clock, pty, core, federated: async () => (await fed.list()).message };
}

test('stall boundary: 0ms and exactly 900000ms are working, 900001ms is stalled; output clears it', () => {
  const { clock, pty, core } = origin();
  const at = (ms: number): Row => { clock.at = T0 + ms; return rowsOf(core.list().message)[0]!; };
  expect(pick(at(0))).toEqual({ badge: 'working', badgeLabel: '[▶ working]', stalled: false, lastEventAtMs: T0 });
  expect(pick(at(WINDOW_MS))).toEqual({ badge: 'working', badgeLabel: '[▶ working]', stalled: false, lastEventAtMs: T0 });
  expect(pick(at(WINDOW_MS + 1))).toEqual({ badge: 'stalled', badgeLabel: '[⏸ stalled]', stalled: true, lastEventAtMs: T0 });
  // Output at T0+900001 is an event: working again, the window restarts from that output.
  pty.output = T0 + WINDOW_MS + 1;
  expect(pick(at(WINDOW_MS + 1))).toEqual({ badge: 'working', badgeLabel: '[▶ working]', stalled: false, lastEventAtMs: T0 + WINDOW_MS + 1 });
  expect(pick(at(2 * WINDOW_MS + 1))).toEqual({ badge: 'working', badgeLabel: '[▶ working]', stalled: false, lastEventAtMs: T0 + WINDOW_MS + 1 });
  expect(pick(at(2 * WINDOW_MS + 2))).toEqual({ badge: 'stalled', badgeLabel: '[⏸ stalled]', stalled: true, lastEventAtMs: T0 + WINDOW_MS + 1 });
});

test('federation: badge, badgeLabel, stalled and lastEventAtMs survive core -> /els/ls -> fetchJson -> federated list -> CLI line and sidetab row', async () => {
  const { clock, core, federated } = origin();
  for (const [ms, badge, label, stalled, agent, mark] of [
    [0, 'working', '[▶ working]', false, 'working', ' ●'],
    [WINDOW_MS, 'working', '[▶ working]', false, 'working', ' ●'],
    [WINDOW_MS + 1, 'stalled', '[⏸ stalled]', true, 'stalled', ' ⏸'],
  ] as const) {
    clock.at = T0 + ms;
    const originRow = pick(rowsOf(core.list().message)[0]!);
    expect(originRow).toEqual({ badge, badgeLabel: label, stalled, lastEventAtMs: T0 });
    // boundary 1: the real /els/ls router
    const http = JSON.parse((await routeElsHttp(core, 'host-a', 'GET', '/els/ls')).body) as { panes: Record<string, unknown>[] };
    expect({ badge: http.panes[0]!.badge, badgeLabel: http.panes[0]!.badgeLabel, stalled: http.panes[0]!.stalled, lastEventAtMs: http.panes[0]!.lastEventAtMs }).toEqual(originRow);
    // boundary 2: the federated list (remote row rebuild)
    const list = await federated();
    const remote = rowsOf(list)[0]!;
    expect(pick(remote)).toEqual(originRow);
    // surfaces read the origin's decision: the CLI line is asked with the origin's own T0 as «now», so a client-side
    // recomputation could never say stalled — the label can only come from the carried field.
    expect(paneListLines(list, T0)[0]).toContain(label);
    // The remote subtree is host → workspace → tab → pane: the pane and every header above it read the carried state.
    expect(elsRowsFromList(list, 'mshq').map((row) => [row.badge, row.agentState])).toEqual(Array(4).fill(['busy', agent]));
    // (a remote row carries no workspace name, so only the mark is compared; line 0 is the «spaces» head)
    expect(buildSpaceList(withCommands(parsePaneRows(list), list), undefined, 40, 4)[1]!.replace(/\u001b\[[0-9;]*m/g, '').startsWith(mark)).toBe(true);
  }
});

test('an old server whose /els/ls has none of the new fields still works: no stalled, state as before', async () => {
  const strip = (body: unknown): unknown => ({ ...(body as object), panes: (body as { panes: Record<string, unknown>[] }).panes
    .map(({ badge: _b, badgeLabel: _l, stalled: _s, lastEventAtMs: _e, ...old }) => old) });
  const { clock, federated } = origin(strip);
  clock.at = T0 + 10 * WINDOW_MS;
  const list = await federated();
  const row = rowsOf(list)[0]! as unknown as Record<string, unknown>;
  expect(Object.keys(row).filter((key) => ['badge', 'badgeLabel', 'stalled', 'lastEventAtMs'].includes(key))).toEqual([]);
  expect(row.state).toBe('working');
  expect(paneListLines(list, clock.at)[0]).toContain('[▶ working]');
  expect(elsRowsFromList(list, 'mshq').map((r) => [r.badge, r.agentState])).toEqual(Array(4).fill(['busy', 'working']));
});

test('malformed new fields from a remote are dropped, not carried', async () => {
  const { federated } = origin((body) => ({ ...(body as object), panes: (body as { panes: object[] }).panes
    .map((pane) => ({ ...pane, badge: 7, badgeLabel: null, stalled: 'yes', lastEventAtMs: 'soon' })) }));
  const row = rowsOf(await federated())[0]! as unknown as Record<string, unknown>;
  expect(['badge', 'badgeLabel', 'stalled', 'lastEventAtMs'].map((key) => key in row)).toEqual([false, false, false, false]);
});

test('restart: a reattached pane keeps the PTY\'s real last output time; first sight is only the floor for a pane with no timestamp', () => {
  // First server run: pane printed at T0, then 900001ms of silence -> stalled.
  let stored: SpaceJournal = emptyJournal();
  const clock = { at: T0 };
  const holderPty = fakePty('pty_1', T0);
  const first = createElsCore({ load: () => stored, save: (next) => { stored = next; }, spawn: () => holderPty, now: () => clock.at });
  first.start();
  expect(first.newPane({ ws: 'OP', cwd: '/work', command: ['sh'] }).exitCode).toBe(0);
  clock.at = T0 + WINDOW_MS + 1;
  expect(pick(rowsOf(first.list().message)[0]!)).toEqual({ badge: 'stalled', badgeLabel: '[⏸ stalled]', stalled: true, lastEventAtMs: T0 });

  // Server restarts; the holder still owns the SAME PTY, whose own lastOutputAt is still T0. First list comes now.
  const second = createElsCore({ load: () => stored, save: (next) => { stored = next; }, spawn: () => { throw new Error('no spawn'); },
    reattach: () => holderPty, now: () => clock.at });
  expect(second.start()).toBeUndefined();
  expect(holderPty.lastOutputAt!()).toBe(T0);
  expect(pick(rowsOf(second.list().message)[0]!)).toEqual({ badge: 'stalled', badgeLabel: '[⏸ stalled]', stalled: true, lastEventAtMs: T0 });

  // A reattached PTY that reports no timestamp has no real event: this run's first sight is the floor (working, not stalled).
  const quietPty = fakePty('pty_1', undefined);
  const third = createElsCore({ load: () => stored, save: (next) => { stored = next; }, spawn: () => { throw new Error('no spawn'); },
    reattach: () => quietPty, now: () => clock.at });
  third.start();
  expect(pick(rowsOf(third.list().message)[0]!)).toEqual({ badge: 'working', badgeLabel: '[▶ working]', stalled: false, lastEventAtMs: T0 + WINDOW_MS + 1 });
});

test('space mark: failed and blocked (approval) outrank stalled; stalled outranks working; stalled alone is ⏸', () => {
  const list = (panes: { pane: string; state: string; stalled?: boolean }[]): string => JSON.stringify({ panes: panes.map((p) => ({ address: `w1/t1/${p.pane}`,
    workspace: 'OP', title: p.pane, command: ['sh'], ...p })) });
  const mark = (panes: { pane: string; state: string; stalled?: boolean }[]): string => {
    const json = list(panes);
    return buildSpaceList(withCommands(parsePaneRows(json), json), undefined, 40, 3)[1]!.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
  };
  // `blocked` is the approval wait; `failed` is the contract's failure word. Both outrank stalled, in either pane order.
  expect(mark([{ pane: 'a', state: 'failed' }, { pane: 'b', state: 'working', stalled: true }])).toBe(' ✕ OP');
  expect(mark([{ pane: 'b', state: 'working', stalled: true }, { pane: 'a', state: 'failed' }])).toBe(' ✕ OP');
  expect(mark([{ pane: 'a', state: 'failed' }, { pane: 'c', state: 'blocked' }, { pane: 'b', state: 'working', stalled: true }])).toBe(' ✕ OP');
  expect(mark([{ pane: 'a', state: 'blocked' }, { pane: 'b', state: 'working', stalled: true }])).toBe(' ◐ OP');
  expect(mark([{ pane: 'b', state: 'working', stalled: true }, { pane: 'a', state: 'blocked' }])).toBe(' ◐ OP');
  expect(mark([{ pane: 'a', state: 'working' }, { pane: 'b', state: 'working', stalled: true }])).toBe(' ⏸ OP');
  expect(mark([{ pane: 'b', state: 'working', stalled: true }])).toBe(' ⏸ OP');
  expect(mark([{ pane: 'a', state: 'working' }, { pane: 'b', state: 'idle' }])).toBe(' ● OP');
});
