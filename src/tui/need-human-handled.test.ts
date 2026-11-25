// NEED-HUMAN handled (11-25 06:18–06:25 incident) on a real mail ledger (temp file): UX blocks → mail to OP → OP handles it in its own
// process (reply mail / turn receipt / ack) → the 5-min check reads the ledger and stops the ladder; silence still reaches the CEO.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMsgStore } from '../msg/msg-store.js';
import { createNeedsHumanPush } from './needs-human-push.js';
import { needsHumanHandledOn } from './needs-human-wiring.js';
import { createLedgerReceiptWriter } from './seat-message-receipts.js';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'need-human-handled-'));
  const path = join(dir, 'messages.db');
  const store = openMsgStore(path);
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const logs: string[] = [];
  const cards: string[] = [];
  const push = createNeedsHumanPush({
    seat: () => 'UX', paneId: () => 'pane-ux', coordinatorOf: () => 'UX',
    postMail: (e) => store.post(e, { dedupe: true }).id,
    raiseDecision: (c) => { cards.push(c.seat); },
    resumeWith: () => {},
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
    newBlockId: () => 'blk-ux',
    log: (event, data) => { logs.push(`${event} ${JSON.stringify(data)}`); },
    handledBy: (q) => needsHumanHandledOn(store, q),
    ackFor: (rung, msgId) => { if (store.messageStatus(rung, msgId) === 'delivered') store.ackMessage(rung, msgId, 'acked'); },
  });
  const fire5m = () => { for (const t of timers.splice(0)) if (t.live && t.ms === 300_000) t.fn(); };
  const done = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { path, store, push, logs, cards, fire5m, done };
}

test('OP mails UX after the block mail → at 5 min no CEO card, handled by reply, the block mail acked for OP', () => {
  const r = rig();
  r.push.blocked('HUMAN_DECISION', 'which layout ships');
  const op = r.store.list('OP', 0, 100, { includeAcked: true });
  expect(op.length).toBe(1);
  const blockMail = op[0]!.id;
  r.store.post({ from: 'OP', to: 'UX', kind: 'request', body: 'tell me the failing step and the decision you need' });
  r.fire5m();
  expect(r.cards).toEqual([]);
  expect(r.logs.at(-1)).toBe(`seat.needs-human {"phase":"handled","rung":"OP","by":"reply","msgId":${blockMail},"seat":"UX","blockId":"blk-ux"}`);
  expect(r.store.messageStatus('OP', blockMail)).toBe('acked');
  expect(r.push.activeBlockId()).toBe('blk-ux');
  console.log(`[receipt] ${r.logs.join('\n[receipt] ')}`);
  r.done();
});

test('OP TUI turn took the mail in (seen receipt via the ledger writer) → handled by turn-ack', () => {
  const r = rig();
  r.push.blocked('HUMAN_DECISION', 'which layout ships');
  const blockMail = r.store.list('OP', 0, 100, { includeAcked: true })[0]!.id;
  createLedgerReceiptWriter(r.path).record({ messageId: blockMail, recipient: 'OP', state: 'seen', queueItemId: 'q1' });
  r.fire5m();
  expect(r.cards).toEqual([]);
  expect(r.logs.at(-1)).toBe(`seat.needs-human {"phase":"handled","rung":"OP","by":"turn-ack","msgId":${blockMail},"seat":"UX","blockId":"blk-ux"}`);
  r.done();
});

test('OP acked the row by hand → handled by ack', () => {
  const r = rig();
  r.push.blocked('HUMAN_DECISION', 'which layout ships');
  const blockMail = r.store.list('OP', 0, 100, { includeAcked: true })[0]!.id;
  r.store.ackMessage('OP', blockMail, 'acked');
  r.fire5m();
  expect(r.cards).toEqual([]);
  expect(r.logs.at(-1)).toBe(`seat.needs-human {"phase":"handled","rung":"OP","by":"ack","msgId":${blockMail},"seat":"UX","blockId":"blk-ux"}`);
  r.done();
});

test('nothing from OP (a mail from OP that predates the block does not count) → the CEO card at 5 min, unchanged', () => {
  const r = rig();
  r.store.post({ from: 'OP', to: 'UX', kind: 'request', body: 'older unrelated mail' });
  r.store.post({ from: 'TC', to: 'UX', kind: 'request', body: 'someone else' });
  r.push.blocked('HUMAN_DECISION', 'which layout ships');
  r.store.post({ from: 'TC', to: 'UX', kind: 'request', body: 'someone else again' });
  r.fire5m();
  expect(r.cards).toEqual(['UX']);
  expect(r.logs.at(-1)).toBe('seat.needs-human {"phase":"routed","rung":"CEO","seat":"UX","blockId":"blk-ux"}');
  r.done();
});
