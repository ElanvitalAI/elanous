// HAND-RAISE-LADDER — independent literals · a real temp ledger · injected clock offsets (ledger created_at is wall time).
import { afterAll, afterEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore, type MessageEnvelope } from './msg-store.js';
import {
  applyHandOutcome, buildFederationLadder, bulkHandGroups, handBoardLevels, handBoardLine, handBulkLine, handClosedOn,
  loadFederationLadder, openHands, readHandMail, spacesOfElsJournal, sweepHandRaises, type CeoCard,
} from './hand-raise-ladder.js';

const root = mkdtempSync(join(tmpdir(), 'hand-ladder-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// The ledger stamps created_at with the wall clock — the tests move that clock (setSystemTime), never sleep.
afterEach(() => { setSystemTime(); });
const T0 = Date.parse('2026-11-25T02:57:00.000Z');
let n = 0;
const freshStore = (): MsgStore => new MsgStore(join(root, `m${++n}.db`));
const MIN = 60_000;

// The federation as the els journal declares it on 11-25: TC space (hands), OP space, HQ unset (root = OP).
const ladder = buildFederationLadder({ spaces: [
  { coordinator: 'TC', seats: ['TC', 'TC-H-CC-1', 'TC-H-CC-2', 'MVP-B', 'HAND-TUI-D'] },
  { coordinator: 'OP', seats: ['OP'] },
  { coordinator: 'JUD', seats: ['JUD', 'JUD-3'] },
] });

const hand = (from: string, to: string, block: string, reason = 'HUMAN_DECISION'): MessageEnvelope => ({
  from, to, kind: 'request', intent: 'decision', correlationId: block,
  body: `[✋ NEED HUMAN · ${from}] PR #40050 리뷰 결과를 어떻게 처리할지 결정 필요`,
  refs: [`block:${block}`, `seat:${from}`, 'pane:p1', `reason:${reason}`],
});

function harness(store: MsgStore) {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const cards: CeoCard[] = [];
  setSystemTime(new Date(T0));
  const deps = { ladder, now: () => Date.now(), raiseDecision: (c: CeoCard) => { cards.push(c); }, log: (e: string, d: Record<string, unknown>) => { logs.push([e, d]); } };
  return { deps, logs, cards, set: (ms: number) => { setSystemTime(new Date(ms)); }, events: () => logs.map(([e]) => e) };
}

test('ladder: hand → its space coordinator → OP → CEO; an unplaced seat goes to OP', () => {
  expect(ladder.parentOf('TC-H-CC-2')).toBe('TC');
  expect(ladder.parentOf('HAND-TUI-D')).toBe('TC');
  expect(ladder.parentOf('TC')).toBe('OP');
  expect(ladder.parentOf('JUD-3')).toBe('JUD');
  expect(ladder.parentOf('JUD')).toBe('OP');
  expect(ladder.parentOf('OP')).toBe('CEO');
  expect(ladder.parentOf('MK')).toBe('OP');
  expect(buildFederationLadder({ hq: 'HQ-1', spaces: [{ coordinator: 'OP', seats: ['OP'] }] }).parentOf('OP')).toBe('HQ-1');
});

test('ladder from the els journal file: workspace coordinator ⊕ pane seats (cwd or seatIdentity) ⊕ hqCoordinatorSeat', () => {
  const journal = {
    version: 1, hqCoordinatorSeat: 'OP',
    workspaces: [{ id: 'w1', name: 'TC', coordinatorSeat: 'TC' }, { id: 'w2', name: 'PRODUCT', coordinatorSeat: 'MVP-B' }, { id: 'w3', name: 'MK' }],
    tabs: [{ id: 't1', workspaceId: 'w1' }, { id: 't3', workspaceId: 'w3' }],
    panes: [{ tabId: 't1', cwd: '/Users/x/elanous-hq/seats/TC-H-CX-4' }, { tabId: 't1', cwd: '/tmp/anything', seatIdentity: 'MVP-B' },
      { tabId: 't1', cwd: '/Users/x/elanous-hq/seats/TC' }, { tabId: 't3', cwd: '/Users/x/elanous-hq/seats/MK' }],
  };
  expect(spacesOfElsJournal(journal)).toEqual({ hq: 'OP', spaces: [
    { coordinator: 'TC', seats: ['TC-H-CX-4', 'MVP-B', 'TC'] }, { coordinator: 'MVP-B', seats: [] }] });
  const path = join(root, 'journal.json');
  writeFileSync(path, JSON.stringify(journal));
  const live = loadFederationLadder({ journalPath: path, cwd: root, home: root });
  expect(live.parentOf('TC-H-CX-4')).toBe('TC');
  expect(live.parentOf('MVP-B')).toBe('OP'); // a coordinator reports to HQ even when its pane sits in another space
  expect(live.parentOf('OP')).toBe('CEO');
});

test('BEACON-FLOOD: the 10-min timer never mails OP — TC → OP climbs only through the steward beacon card', () => {
  const store = freshStore();
  try {
    const h = harness(store);
    const raised = store.post(hand('TC-H-CC-2', 'TC', 'blk-cc2-1'));
    const t0 = readHandMail(store, raised.id)!.createdAtMs;
    h.set(t0 + 10 * MIN);
    expect(sweepHandRaises(store, h.deps)).toEqual([]);
    expect(store.list('OP', 0, 100).length).toBe(0);
    expect(handClosedOn(store, readHandMail(store, raised.id)!)).toBe(null);
  } finally { store.close(); }
});

test('a hand-level receiver climbs to its coordinator first (TC-H-CC-1 → TC), not straight to OP', () => {
  const store = freshStore();
  try {
    const h = harness(store);
    const raised = store.post(hand('MVP-B', 'TC-H-CC-1', 'blk-mvp-1'));
    h.set(readHandMail(store, raised.id)!.createdAtMs + 10 * MIN);
    expect(sweepHandRaises(store, h.deps).map((d) => [d.from, d.to])).toEqual([['TC-H-CC-1', 'TC']]);
  } finally { store.close(); }
});

test('OP level: 10 more min → one CEO decision card ⊕ one copy to CLAUDE-OP (never twice)', () => {
  const store = freshStore();
  try {
    const h = harness(store);
    // (the TC → OP rung is the beacon card now; a ✋ held at OP climbs on the timer as before)
    const raised = store.post(hand('TC-H-CC-1', 'OP', 'blk-cc1-1', 'TOOL_DENIED'));
    const atOp = readHandMail(store, raised.id)!;
    h.set(atOp.createdAtMs + 9 * MIN);
    expect(sweepHandRaises(store, h.deps)).toEqual([]);
    expect(h.cards).toEqual([]);
    h.set(atOp.createdAtMs + 10 * MIN);
    const [second] = sweepHandRaises(store, h.deps);
    expect(second).toMatchObject({ msgId: atOp.id, from: 'OP', to: 'CEO', waitedMin: 10 });
    expect(h.cards.length).toBe(1);
    expect(h.cards[0]).toMatchObject({ seat: 'TC-H-CC-1', reason: 'TOOL_DENIED', blockId: 'blk-cc1-1', msgId: atOp.id,
      title: '[✋ NEED HUMAN · TC-H-CC-1] [✋ NEED HUMAN · TC-H-CC-1] PR #40050 리뷰 결과를 어떻게 처리할지 결정 필요' });
    const copy = store.getMessage(second!.mailId!)!;
    expect(copy.to).toBe('CLAUDE-OP');
    expect(copy.refs).toEqual([`needhuman:${atOp.id}`, `hand-of:${raised.id}`, `hand-escalated-from:${atOp.id}`, 'hand-ceo', 'block:blk-cc1-1', 'seat:TC-H-CC-1']);
    expect(h.events()).toContain('needhuman.ceo-card');
    h.set(atOp.createdAtMs + 30 * MIN);
    expect(sweepHandRaises(store, h.deps)).toEqual([]);
    expect(h.cards.length).toBe(1);
    // The board shows the CEO level holding it.
    expect(handBoardLine(handBoardLevels(store, { now: atOp.createdAtMs + 30 * MIN, ladder }))).toBe('✋ Open hands — OP 0 · CEO 1 (oldest 20m)');
  } finally { store.close(); }
});

test('resolve: one reply to the blocked seat (reply_to = root) closes the ✋; a second outcome is refused', () => {
  const store = freshStore();
  try {
    const h = harness(store);
    const raised = store.post(hand('HAND-TUI-D', 'TC', 'blk-tuid-1'));
    const result = applyHandOutcome(store, { msgId: raised.id, action: 'resolve', text: 'Take option 2 and keep going.' }, h.deps);
    const reply = store.getMessage(result.mailId!)!;
    expect([reply.from, reply.to, reply.replyTo, reply.body]).toEqual(['TC', 'HAND-TUI-D', raised.id, '[✋ RESOLVED · TC] Take option 2 and keep going.']);
    expect(reply.refs).toEqual(['hand-outcome:resolve', `hand-of:${raised.id}`, `hand-msg:${raised.id}`]);
    expect(handClosedOn(store, readHandMail(store, raised.id)!)).toBe('resolved');
    expect(() => applyHandOutcome(store, { msgId: raised.id, action: 'reject', text: 'no' }, h.deps)).toThrow(`#${raised.id} is already resolved`);
    expect(h.events()).toEqual(['needhuman.resolved']);
    h.set(T0 + 15 * MIN);
    expect(sweepHandRaises(store, h.deps)).toEqual([]);
  } finally { store.close(); }
});

test('reject: the reply carries the reason; another seat cannot close it; empty text is refused', () => {
  const store = freshStore();
  try {
    const h = harness(store);
    const raised = store.post(hand('TC-H-CC-2', 'TC', 'blk-cc2-2'));
    expect(() => applyHandOutcome(store, { msgId: raised.id, action: 'reject', text: '  ' }, h.deps)).toThrow('reject needs a reason');
    expect(() => applyHandOutcome(store, { msgId: raised.id, action: 'reject', text: 'x', actor: 'JUD' }, h.deps)).toThrow(`#${raised.id} is TC's ✋ — JUD cannot reject it`);
    const result = applyHandOutcome(store, { msgId: raised.id, action: 'reject', text: 'Out of scope for 0.3.36.' }, h.deps);
    expect(store.getMessage(result.mailId!)!.body).toBe('[✋ REJECTED · TC] reason: Out of scope for 0.3.36.');
    expect(handClosedOn(store, readHandMail(store, raised.id)!)).toBe('rejected');
  } finally { store.close(); }
});

test('escalate: forward to the parent with one line; the parent resolves and the whole chain closes', () => {
  const store = freshStore();
  try {
    const h = harness(store);
    const raised = store.post(hand('TC-H-CC-2', 'TC', 'blk-cc2-3'));
    const up = applyHandOutcome(store, { msgId: raised.id, action: 'escalate', text: 'Needs a release-scope call.' }, h.deps);
    expect([up.to, up.output]).toEqual(['OP', `✋ #${raised.id} escalated to OP as #${up.mailId}`]);
    const forward = store.getMessage(up.mailId!)!;
    expect(forward.body.startsWith('[✋ ESCALATED · TC → OP] Needs a release-scope call. · from TC-H-CC-2 #')).toBe(true);
    expect(forward.refs).toContain('hand-escalation:manual');
    expect(() => applyHandOutcome(store, { msgId: raised.id, action: 'escalate', text: 'again' }, h.deps)).toThrow(`#${raised.id} is already escalated`);
    const done = applyHandOutcome(store, { msgId: up.mailId!, action: 'resolve', text: 'Ship it in 0.3.36.' }, h.deps);
    const reply = store.getMessage(done.mailId!)!;
    expect([reply.from, reply.to, reply.replyTo]).toEqual(['OP', 'TC-H-CC-2', raised.id]);
    // The forwarding seat hears the outcome too.
    expect(store.list('TC', 0, 100).some((m) => m.body === `[✋ RESOLVED · OP] TC-H-CC-2's ✋ #${raised.id} (you forwarded #${up.mailId}): Ship it in 0.3.36.`)).toBe(true);
    expect(openHands(store, { now: Date.now() + 60 * MIN, ladder })).toEqual([]);
    expect(h.events()).toEqual(['needhuman.escalated', 'needhuman.resolved']);
  } finally { store.close(); }
});

test('OP may step in on a sub-coordinator ✋ (resolve) but cannot escalate it for TC', () => {
  const store = freshStore();
  try {
    const h = harness(store);
    const raised = store.post(hand('TC-H-CC-1', 'TC', 'blk-cc1-2'));
    expect(() => applyHandOutcome(store, { msgId: raised.id, action: 'escalate', text: 'x', actor: 'OP' }, h.deps)).toThrow(`#${raised.id} is TC's ✋ — OP cannot escalate it`);
    const done = applyHandOutcome(store, { msgId: raised.id, action: 'resolve', text: 'Resume with the light pregate.', actor: 'OP' }, h.deps);
    expect(store.getMessage(done.mailId!)!.body).toBe('[✋ RESOLVED · OP] Resume with the light pregate.');
  } finally { store.close(); }
});

test('the blocked seat\'s own 5-min push to OP (same block) counts as escalated — no second forward', () => {
  const store = freshStore();
  try {
    const h = harness(store);
    const raised = store.post(hand('TC-H-CC-2', 'TC', 'blk-cc2-4'));
    store.post({ ...hand('TC-H-CC-2', 'OP', 'blk-cc2-4'), body: '[✋ NEED HUMAN · TC-H-CC-2] escalated from TC after 5m' });
    h.set(readHandMail(store, raised.id)!.createdAtMs + 10 * MIN);
    expect(sweepHandRaises(store, h.deps).map((d) => d.msgId)).not.toContain(raised.id);
  } finally { store.close(); }
});

test('bulk: 3 open ✋ of one reason at one coordinator → one «change the rule» line', () => {
  const store = freshStore();
  try {
    const ids = ['TC-H-CC-1', 'TC-H-CC-2', 'MVP-B'].map((s, i) => store.post(hand(s, 'TC', `blk-b-${i}`, 'TOOL_DENIED')).id);
    store.post(hand('HAND-TUI-D', 'TC', 'blk-b-x', 'HUMAN_DECISION'));
    const groups = bulkHandGroups(openHands(store, { now: Date.now(), ladder }));
    expect(groups.length).toBe(1);
    expect(handBulkLine(groups[0]!)).toBe(`✋ 3 hands blocked on the same rule — change the rule (reason TOOL_DENIED · TC-H-CC-1 #${ids[0]}, TC-H-CC-2 #${ids[1]}, MVP-B #${ids[2]})`);
  } finally { store.close(); }
});

test('board line: open ✋ per level with age, deepest first; OP and CEO always shown', () => {
  const store = freshStore();
  try {
    store.post(hand('TC-H-CC-1', 'TC', 'blk-o-1'));
    const b = store.post(hand('JUD-3', 'JUD', 'blk-o-2'));
    const now = readHandMail(store, b.id)!.createdAtMs + 7 * MIN;
    expect(handBoardLine(handBoardLevels(store, { now, ladder }))).toBe('✋ Open hands — TC 1 (oldest 7m) · JUD 1 (oldest 7m) · OP 0 · CEO 0');
  } finally { store.close(); }
});
