// HAND-NAME-NEUTRAL-DYNAMIC ① — els side: a pane's own `meta { title }` becomes its tab label only when the pane is a seat
// pane, the tab's one pane, and the title starts with that seat's id. Expectations are literals.
import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';
import type { AgentEventFrame } from '../agent-events/protocol.js';

function world() {
  let journal = emptyJournal(), count = 0, saves = 0;
  const clock = 1_700_000_000_000;
  const core = createElsCore({ load: () => journal, save: (next) => { journal = next; saves++; }, now: () => clock,
    spawn: () => { const id = `pty${++count}`; return { id, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {}, lastOutputAt: () => clock } as ElsPty; },
    mailBadges: () => new Map() });
  core.start();
  const make = (cwd: string, title: string) => (JSON.parse(core.newPane({ ws: 'TC', cwd, command: ['sh'], title }).message) as { pane: string }).pane;
  let seq = 0;
  const send = (pane: string, event: AgentEventFrame['event']) => core.agentEvent(pane, { op: 'event', v: 1, ws: 'TC', pane, sid: `s-${pane}`, seq: ++seq, at: clock, event });
  const labelOf = (pane: string) => { const tab = journal.panes.find((p) => p.id === pane)!.tabId; return journal.tabs.find((t) => t.id === tab)!.label; };
  return { core, make, send, labelOf, saves: () => saves };
}

test('a hand pane retitles its own tab; the same title again writes nothing', () => {
  const w = world();
  const hand = w.make('/hq/seats/TC-H-CX-2', 'TC-H-CX-2');
  expect(w.send(hand, { kind: 'meta', title: 'TC-H-CX-2 · UX · DEMO-TABS-SCEN… · terra' }).exitCode).toBe(0);
  expect(w.labelOf(hand)).toBe('TC-H-CX-2 · UX · DEMO-TABS-SCEN… · terra');
  const before = w.saves();
  w.send(hand, { kind: 'meta', title: 'TC-H-CX-2 · UX · DEMO-TABS-SCEN… · terra' });
  expect(w.saves()).toBe(before);
  w.send(hand, { kind: 'meta', title: 'TC-H-CX-2 · idle · terra' });
  expect(w.labelOf(hand)).toBe('TC-H-CX-2 · idle · terra');
});

test('a title naming another seat, or a pane with no seat folder, leaves the label as it was', () => {
  const w = world();
  const hand = w.make('/hq/seats/TC-H-CX-2', 'TC-H-CX-2');
  w.send(hand, { kind: 'meta', title: 'OP · HQ · anything · terra' });
  expect(w.labelOf(hand)).toBe('TC-H-CX-2');
  w.send(hand, { kind: 'meta', title: 'TC-H-CX-22 · idle' });
  expect(w.labelOf(hand)).toBe('TC-H-CX-2');
  const plain = w.make('/tmp/work', 'scratch');
  w.send(plain, { kind: 'meta', title: 'scratch · new' });
  expect(w.labelOf(plain)).toBe('scratch');
});

test('a meta report without a title (model only) never touches the label', () => {
  const w = world();
  const hand = w.make('/hq/seats/UX-H-POOL-3', 'UX-H-POOL-3');
  w.send(hand, { kind: 'meta', model: 'gpt-6.1-terra' });
  expect(w.labelOf(hand)).toBe('UX-H-POOL-3');
});
