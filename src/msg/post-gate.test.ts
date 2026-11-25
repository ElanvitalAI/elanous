// MAIL-ANTI-FLOOD — the post gate on a real ledger ⊕ the diverted side ledgers ⊕ the TUI feed (independent literals).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from './msg-store.js';
import { gatePost, storeGateDeps, divertedRootForStore } from './post-gate.js';
import { appendDiverted, coachNoteLine, noteTurnStamp, pendingDiverted, takeDiverted, turnsLastHour } from './diverted-mail.js';
import { dispatchMsgPost } from '../skills/tools/ops-ledger.js';
import { createSelfWakeCoachFeed } from '../tui/self-wake-coach-feed.js';
import { buildFederationLadder } from './hand-raise-ladder.js';
import { senderAboveOnLadder } from '../tui/seat-mail-turn-policy.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'post-gate-')); dirs.push(d); return d; }

test('diverted root sits next to the mail ledger', () => {
  expect(divertedRootForStore('/x/state/msg/messages.db')).toBe('/x/state/msg/diverted');
});

test('gate: kind-less → passive info ⊕ warning · unknown kind refused · self-wake · coach-note · fold · post — and nothing is written as a row when diverted', () => {
  const dir = tmp();
  const store = new MsgStore(join(dir, 'messages.db'));
  const root = join(dir, 'diverted');
  const logs: string[] = [];
  const deps = { ...storeGateDeps(store, root), log: (e: string, d: Record<string, unknown>) => { logs.push(`${e} ${JSON.stringify(d)}`); } };
  const kindless = gatePost({ envelope: { from: 'TC', to: 'OP', body: 'x' }, entrance: 'cli' }, deps);
  expect(kindless.action === 'post' && [kindless.envelope.kind, kindless.envelope.needsAck, kindless.warning?.startsWith('msg post warning (no --kind): stored as --kind info')]).toEqual(['info', false, true]);
  expect(logs).toContain('msg.kindless {"from":"TC","to":"OP"}');
  expect(gatePost({ envelope: { from: 'TC', to: 'OP', body: 'x', kind: 'memo' }, entrance: 'cli' }, deps).action).toBe('refuse');
  const self = gatePost({ envelope: { from: 'OP', to: 'OP', body: '⏰ wake', kind: 'notice' }, entrance: 'cli' }, deps);
  expect(self.action).toBe('divert');
  expect(pendingDiverted('self-wake', 'OP', root).map((e) => e.body)).toEqual(['⏰ wake']);
  const coach = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'board', kind: 'info' }, entrance: 'tool' }, deps);
  expect(coach.action === 'divert' && coach.ledger).toBe('coach-note');
  const coachAsk = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'decide?', kind: 'decision' }, entrance: 'tool' }, deps);
  expect(coachAsk.action).toBe('post');
  // saturate OP: 31 unacked passive rows
  for (let i = 0; i < 31; i++) store.post({ from: 'TC', to: 'OP', body: `status ${i}`, kind: 'status', needsAck: false });
  const folded = gatePost({ envelope: { from: 'RES', to: 'OP', body: 'fyi', kind: 'info' }, entrance: 'cli' }, deps);
  expect(folded.action === 'divert' && folded.ledger).toBe('folded');
  expect(folded.action === 'divert' && folded.line.startsWith('receiver saturated — recorded to ledger/digest (OP · pending passive queue')).toBe(true);
  expect(logs.some((l) => l.startsWith('msg.backpressure {"to":"OP","folded":1'))).toBe(true);
  const urgent = gatePost({ envelope: { from: 'TC', to: 'OP', body: 'decide', kind: 'decision' }, entrance: 'cli' }, deps);
  expect(urgent.action).toBe('post');
  expect(urgent.action === 'post' && urgent.envelope.needsAck).toBe(true);
  expect(store.unreadCount('OP')).toBe(31);
  store.close();
});

test('turn stamps: the last hour only · unknown seat = null', () => {
  const root = join(tmp(), 'd');
  expect(turnsLastHour('OP', 10_000_000, root)).toBe(null);
  noteTurnStamp('OP', 1_000_000, root);
  noteTurnStamp('OP', 9_000_000, root);
  noteTurnStamp('OP', 9_500_000, root);
  expect(turnsLastHour('OP', 10_000_000, root)).toBe(2);
});

test('take: the cursor stops at the first entry that is not ready (a future wake holds the rest)', () => {
  const root = join(tmp(), 'd');
  for (const body of ['a', 'b', 'c']) appendDiverted('self-wake', { seat: 'OP', from: 'OP', kind: 'notice', body, at: '2026-11-25T01:00:00.000Z' }, root);
  expect(takeDiverted('self-wake', 'OP', (e) => e.body !== 'b', root).map((e) => e.body)).toEqual(['a']);
  expect(takeDiverted('self-wake', 'OP', () => true, root).map((e) => e.body)).toEqual(['b', 'c']);
  expect(pendingDiverted('self-wake', 'OP', root)).toEqual([]);
});

test('coach note: one line per 30 minutes', () => {
  const e = [{ seat: 'OP', from: 'CLAUDE-OP', kind: 'info', body: 'board 08:00', at: '2026-11-25T08:00:00.000Z' },
    { seat: 'OP', from: 'CLAUDE-OP', kind: 'info', body: 'board 08:10', at: '2026-11-25T08:10:00.000Z' }];
  expect(coachNoteLine(e, 1_000_000_000, null)).toBe('[coach note · 2 since 08:00Z · no reply needed] board 08:10 (+1 earlier in the coach-note ledger)');
  expect(coachNoteLine(e, 1_000_000_000, 1_000_000_000 - 29 * 60_000)).toBe(null);
  expect(coachNoteLine(e, 1_000_000_000, 1_000_000_000 - 30 * 60_000)).not.toBe(null);
  expect(coachNoteLine([], 1_000_000_000, null)).toBe(null);
});

test('TUI feed: self-wakes arm the scheduler (refused stays) · coach note once per 30 min · folded digest · turn stamp', () => {
  const root = join(tmp(), 'd');
  // RAIL30 ④: the clock sits just after the fixtures' «at» (a self-wake > 2 h overdue is dropped, not armed).
  let now = Date.parse('2026-11-25T01:05:00.000Z');
  const armed: string[] = [];
  const passive: string[] = [];
  let accept = false;
  const feed = createSelfWakeCoachFeed({ seat: 'OP', root, now: () => now, schedule: (reason) => { if (accept) armed.push(reason); return accept; }, enqueuePassive: (l) => passive.push(l), log: () => {} });
  appendDiverted('self-wake', { seat: 'OP', from: 'OP', kind: 'notice', body: '⏰ fire w1', at: '2026-11-25T01:00:00.000Z' }, root);
  appendDiverted('coach-note', { seat: 'OP', from: 'CLAUDE-OP', kind: 'info', body: 'board A', at: '2026-11-25T01:00:00.000Z' }, root);
  appendDiverted('folded', { seat: 'OP', from: 'RES', kind: 'info', body: 'fyi', at: '2026-11-25T01:00:00.000Z' }, root);
  expect(feed.tick()).toEqual({ wakes: 0, coach: 1, folded: 1, retro: 0 });
  expect(armed).toEqual([]);
  accept = true;
  appendDiverted('coach-note', { seat: 'OP', from: 'CLAUDE-OP', kind: 'info', body: 'board B', at: '2026-11-25T01:10:00.000Z' }, root);
  now += 10 * 60_000;
  expect(feed.tick()).toEqual({ wakes: 1, coach: 0, folded: 0, retro: 0 });
  expect(armed).toEqual(['⏰ fire w1']);
  now += 20 * 60_000;
  expect(feed.tick()).toEqual({ wakes: 0, coach: 1, folded: 0, retro: 0 });
  expect(passive).toEqual(['[coach note · 1 since 01:00Z · no reply needed] board A', '[folded digest · 1 posts while saturated · RES×1] RES: fyi', '[coach note · 1 since 01:10Z · no reply needed] board B']);
  feed.noteTurnStarted();
  expect(turnsLastHour('OP', now, root)).toBe(1);
  feed.noteTurnStarted(false);
  expect(turnsLastHour('OP', now, root)).toBe(1);
});

test('RAIL30 ④ feed: a self-wake overdue > 2 h is dropped with one line, a fresh one is armed', () => {
  const root = join(tmp(), 'd');
  const now = Date.parse('2026-11-25T16:55:00.000Z');
  const armed: string[] = [];
  const passive: string[] = [];
  const feed = createSelfWakeCoachFeed({ seat: 'JUD', root, now: () => now, schedule: (reason) => { armed.push(reason); return true; }, enqueuePassive: (l) => passive.push(l), log: () => {} });
  appendDiverted('self-wake', { seat: 'JUD', from: 'JUD', kind: 'notice', body: 'check 00:01', at: '2026-11-25T00:01:00.000Z' }, root);
  appendDiverted('self-wake', { seat: 'JUD', from: 'JUD', kind: 'notice', body: 'check 05:23', at: '2026-11-25T05:00:00.000Z', dueAt: '2026-11-25T05:23:00.000Z' }, root);
  appendDiverted('self-wake', { seat: 'JUD', from: 'JUD', kind: 'notice', body: 'check 16:40', at: '2026-11-25T16:40:00.000Z' }, root);
  expect(feed.tick()).toEqual({ wakes: 1, coach: 0, folded: 0, retro: 0 });
  expect(armed).toEqual(['check 16:40']);
  expect(passive).toEqual(['[self-wake] dropped 2 stale wakes (overdue > 2 h)']);
});

test('MsgPost tool: kind-less post is auto-tagged; self-mail is diverted (no row)', async () => {
  const dir = tmp();
  const path = join(dir, 'messages.db');
  const tagged = await dispatchMsgPost({ from: 'TC', to: 'OP', body: 'reply line', noReplyTo: true }, { openStore: () => new MsgStore(path), divertedRoot: join(dir, 'diverted') });
  expect(tagged.message?.kind).toBe('info');
  expect(tagged.message?.needsAck).toBe(false);
  const self = await dispatchMsgPost({ from: 'OP', to: 'OP', body: 'remind me', kind: 'notice' }, { openStore: () => new MsgStore(path), divertedRoot: join(dir, 'diverted') });
  expect(self.diverted).toBe('self-wake');
  expect(self.message).toBe(undefined);
  await expect(dispatchMsgPost({ from: 'TC', to: 'OP', body: 'x', kind: 'memo' }, { openStore: () => new MsgStore(path), divertedRoot: join(dir, 'diverted') }))
    .rejects.toThrow('msg post refused (unknown --kind "memo")');
});

test('G: an order from above on the ladder is never folded at a busy receiver · peer info and hand mail still fold', () => {
  const ladder = buildFederationLadder({ hq: 'OP', spaces: [{ coordinator: 'TC', seats: ['TC', 'TC-H1'] }, { coordinator: 'MK', seats: ['MK'] }] });
  const folded: string[] = [];
  // receiver at 25 turns in the last hour (cap 20) · empty queue
  const deps = { pendingPassive: () => 0, turnsLastHour: () => 25, config: { maxPendingPassive: 30, maxTurnsPerHour: 20 },
    append: (ledger: string, e: { seat: string; from: string }) => { folded.push(`${ledger}:${e.from}->${e.seat}`); }, log: () => {} };
  const gate = (from: string, to: string, extra: Record<string, unknown>) => {
    const above = senderAboveOnLadder(ladder, from, to);
    return gatePost({ envelope: { from, to, body: 'line', ...extra }, entrance: 'cli', ...(above === undefined ? {} : { senderAbove: above }) }, deps);
  };
  const order = gate('OP', 'TC', { kind: 'request' });
  expect([order.action, order.action === 'post' && order.urgent]).toEqual(['post', true]);
  const peer = gate('MK', 'TC', { kind: 'info' });
  expect([peer.action, peer.action === 'divert' && peer.ledger]).toEqual(['divert', 'folded']);
  const hand = gate('TC-H1', 'OP', { kind: 'request' });
  expect([hand.action, hand.action === 'divert' && hand.ledger]).toEqual(['divert', 'folded']);
  const handHq = gatePost({ envelope: { from: 'TC-H1', to: 'OP', body: 'line', kind: 'request', refs: ['reason:CROSS_SCOPE'] }, entrance: 'cli', needsReply: true, senderAbove: false }, deps);
  expect([handHq.action, handHq.action === 'post' && handHq.urgent]).toEqual(['post', true]);
  const alertFromHand = gatePost({ envelope: { from: 'TC-H1', to: 'OP', body: 'line', kind: 'alert' }, entrance: 'cli', senderAbove: false }, deps);
  expect(alertFromHand.action).toBe('post');
  const p0FromPeer = gatePost({ envelope: { from: 'MK', to: 'TC', body: 'line', kind: 'info', priority: 1 }, entrance: 'cli', senderAbove: false }, deps);
  expect(p0FromPeer.action).toBe('post');
  expect(folded).toEqual(['folded:MK->TC', 'folded:TC-H1->OP']);
});

test('RAIL30 ① on a real ledger: a reply to the receiver\'s own mail and a receipt for its cell pass G; a stranger\'s status line folds · self-started turns do not count', () => {
  const dir = tmp();
  const store = new MsgStore(join(dir, 'messages.db'));
  const root = join(dir, 'diverted');
  const now = Date.now();
  for (let i = 0; i < 25; i += 1) noteTurnStamp('OP', now - 50 * 60_000 + i * 60_000, root, false);
  expect(turnsLastHour('OP', now, root)).toBe(0);
  for (let i = 0; i < 21; i += 1) noteTurnStamp('OP', now - 40 * 60_000 + i * 60_000, root, true);
  expect(turnsLastHour('OP', now, root)).toBe(21);
  const ask = store.append({ from: 'OP', to: 'TC', body: 'land PR 7', kind: 'request', refs: ['cell:CELL-7'] });
  const deps = { ...storeGateDeps(store, root), log: () => {} };
  const reply = gatePost({ envelope: { from: 'TC', to: 'OP', body: 'PR 7 landed', kind: 'status', replyTo: ask.id }, entrance: 'cli' }, deps);
  expect(reply.action).toBe('post');
  const receipt = gatePost({ envelope: { from: 'TC', to: 'OP', body: 'pregate green', kind: 'receipt', refs: ['cell:CELL-7', 'receipt:7-abc'] }, entrance: 'cli' }, deps);
  expect(receipt.action).toBe('post');
  const other = gatePost({ envelope: { from: 'TC', to: 'OP', body: 'progress', kind: 'status', refs: ['cell:CELL-99', 'pr:99'] }, entrance: 'cli' }, deps);
  expect(other.action).toBe('divert');
  store.close();
});
