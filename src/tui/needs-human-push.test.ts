// NEED-HUMAN-PUSH — literal expectations: one mail per block, the escalation ladder, reply-to-block resume, OP → CEO card.
import { expect, test } from 'bun:test';
import { createNeedsHumanPush, ESCALATE_AFTER_MS, type NeedsHumanDeps } from './needs-human-push.js';

function rig(seat: string, coordinator: string | null, fail?: 'undefined' | 'throw') {
  const mails: { to: string; body: string; intent?: string; refs?: string[]; correlationId?: string; from: string }[] = [];
  const cards: { title: string; seat: string; blockId: string }[] = [];
  const resumed: string[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let nextId = 100;
  const deps: NeedsHumanDeps = {
    seat: () => seat, paneId: () => 'pane-7', coordinatorOf: () => coordinator,
    postMail: (e) => { if (e.to === coordinator && fail) { if (fail === 'throw') throw new Error('injected post failure'); return undefined; } mails.push({ to: e.to, body: e.body, from: e.from, ...(e.intent ? { intent: e.intent } : {}), ...(e.refs ? { refs: e.refs } : {}), ...(e.correlationId ? { correlationId: e.correlationId } : {}) }); return ++nextId; },
    raiseDecision: (c) => { cards.push({ title: c.title, seat: c.seat, blockId: c.blockId }); },
    resumeWith: (t) => { resumed.push(t); },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
    newBlockId: () => 'blk-1',
    log: (event, data) => { logs.push({ event, data }); },
  };
  const push = createNeedsHumanPush(deps);
  const fire = (): void => { const t = timers.filter((x) => x.live).at(-1); if (t) { t.live = false; t.fn(); } };
  return { push, mails, cards, resumed, logs, fire, timers };
}

test('block with no coordinator → exactly 1 decision mail to OP with the machine fields; the same block re-rendered stays 1', () => {
  const r = rig('JUD-B', null);
  r.push.blocked('HUMAN_DECISION', 'plan needs a choice');
  r.push.blocked('HUMAN_DECISION', 'plan needs a choice');
  expect(r.mails.length).toBe(1);
  expect(r.mails[0]).toEqual({ from: 'JUD-B', to: 'OP', intent: 'decision', correlationId: 'blk-1',
    refs: ['block:blk-1', 'seat:JUD-B', 'pane:pane-7', 'reason:HUMAN_DECISION', 'hand-ask:design-decision:*'],
    body: '[✋ NEED HUMAN · JUD-B] plan needs a choice · 원하는 것: 이 막힘을 풀 결정·입력 (답장하면 그대로 재개) · 선택지: 재개/중단/다른 방법' });
  expect(r.logs[0]).toEqual({ event: 'seat.needs-human', data: { phase: 'routed', rung: 'OP', msgId: 101, seat: 'JUD-B', blockId: 'blk-1' } });
});

test('seat in a space with a coordinator → mail to the coordinator only; no reply in 5 min → still no mail to OP (the steward watcher climbs)', () => {
  const r = rig('JUD-B', 'JUD');
  r.push.blocked('HUMAN_DECISION', 'x');
  expect(r.mails.map((m) => m.to)).toEqual(['JUD']);
  expect(r.timers[0]!.ms).toBe(ESCALATE_AFTER_MS);
  r.fire();
  expect(r.mails.map((m) => m.to)).toEqual(['JUD']);
  expect(r.cards).toEqual([]);
  expect(r.logs.at(-1)!.data).toMatchObject({ phase: 'held-at-leader', rung: 'JUD', seat: 'JUD-B' });
});

test('coordinator post failures never mail OP directly — the CEO card is the only rung left', () => {
  for (const fail of ['undefined', 'throw'] as const) {
    const r = rig('JUD-B', 'JUD', fail);
    r.push.blocked('HUMAN_DECISION', 'x');
    expect(r.mails.map((m) => m.to)).toEqual([]);
    expect(r.logs[0]!.data).toMatchObject({ phase: 'route-failed', rung: 'JUD', error: fail === 'throw' ? 'postMail threw' : 'postMail returned no valid message id' });
    expect(r.cards.map((c) => c.seat)).toEqual(['JUD-B']);
  }
});

test('the coordinator replies (replyTo = the mail id) → the seat resumes with the reply text, no forward', () => {
  const r = rig('JUD-B', 'JUD');
  r.push.blocked('HUMAN_DECISION', 'x');
  expect(r.push.noteArrivals([{ msgId: 900, text: 'unrelated', replyTo: 55 }])).toBe(false);
  expect(r.push.noteArrivals([{ msgId: 901, text: 'go with option A', replyTo: 101 }])).toBe(true);
  expect(r.resumed).toEqual(['go with option A']);
  r.fire();
  expect(r.mails.length).toBe(1);
  expect(r.push.activeBlockId()).toBeNull();
});

test('a keystroke resume cancels the ladder', () => {
  const r = rig('JUD-B', 'JUD');
  r.push.blocked('HUMAN_DECISION', 'x');
  r.push.resumed();
  r.fire();
  expect(r.mails.length).toBe(1);
});

test('OP blocked → decisions raise called, no OP self-mail; a coordinator that IS the seat is skipped', () => {
  const op = rig('OP', null);
  op.push.blocked('HUMAN_DECISION', 'choose direction');
  expect(op.mails.length).toBe(0);
  expect(op.cards.length).toBe(1);
  expect(op.cards[0]!.title).toBe('[✋ NEED HUMAN · OP] choose direction');
  const self = rig('JUD', 'JUD');
  self.push.blocked('HUMAN_DECISION', 'x');
  expect(self.mails.map((m) => m.to)).toEqual(['OP']);
});

// 11-25 06:18 incident: UX (a coordinator, so its first rung is OP) blocked; OP answered in 19 s; at 06:25 the CEO still got the card.
function handledRig(answer: () => 'turn-ack' | 'reply' | 'ack' | null) {
  const r = rig('UX', 'UX');
  const asked: { msgId: number; rung: string; seat: string }[] = [];
  const acked: string[] = [];
  const push = createNeedsHumanPush({
    seat: () => 'UX', paneId: () => 'pane-7', coordinatorOf: () => 'UX',
    postMail: () => 155903,
    raiseDecision: (c) => { r.cards.push({ title: c.title, seat: c.seat, blockId: c.blockId }); },
    resumeWith: (t) => { r.resumed.push(t); },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; r.timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
    newBlockId: () => 'blk-9',
    log: (event, data) => { r.logs.push({ event, data }); },
    handledBy: (q) => { asked.push(q); return answer(); },
    ackFor: (rung, msgId) => { acked.push(`${rung}#${msgId}`); },
  });
  return { ...r, push, asked, acked };
}

test('OP replied to UX within 5 min → no CEO card at 5 min, logged handled by reply, the mail acked for OP, ✋ block still open', () => {
  const r = handledRig(() => 'reply');
  r.push.blocked('HUMAN_DECISION', 'need the design call');
  expect(r.logs[0]!.data).toEqual({ phase: 'routed', rung: 'OP', msgId: 155903, seat: 'UX', blockId: 'blk-9' });
  r.fire();
  expect(r.asked).toEqual([{ msgId: 155903, rung: 'OP', seat: 'UX' }]);
  expect(r.cards).toEqual([]);
  expect(r.logs.at(-1)).toEqual({ event: 'seat.needs-human', data: { phase: 'handled', rung: 'OP', by: 'reply', msgId: 155903, seat: 'UX', blockId: 'blk-9' } });
  expect(r.acked).toEqual(['OP#155903']);
  expect(r.push.activeBlockId()).toBe('blk-9');
  expect(r.timers.filter((t) => t.live).length).toBe(0);
});

test('OP turn took the mail in (turn-ack) → handled by turn-ack, no CEO card', () => {
  const r = handledRig(() => 'turn-ack');
  r.push.blocked('HUMAN_DECISION', 'need the design call');
  r.fire();
  expect(r.cards).toEqual([]);
  expect(r.logs.at(-1)!.data).toMatchObject({ phase: 'handled', rung: 'OP', by: 'turn-ack' });
});

test('nothing from OP in 5 min → the CEO card as before; a failing check also escalates', () => {
  const quiet = handledRig(() => null);
  quiet.push.blocked('HUMAN_DECISION', 'need the design call');
  quiet.fire();
  expect(quiet.cards.map((c) => c.seat)).toEqual(['UX']);
  expect(quiet.acked).toEqual([]);
  expect(quiet.logs.at(-1)!.data).toEqual({ phase: 'routed', rung: 'CEO', seat: 'UX', blockId: 'blk-9' });
  const broken = handledRig(() => { throw new Error('ledger locked'); });
  broken.push.blocked('HUMAN_DECISION', 'need the design call');
  broken.fire();
  expect(broken.cards.map((c) => c.seat)).toEqual(['UX']);
});

// HAND-RAISE-DOMAIN-ROUTING (0.3.38) — the ✋ ask identity rides every first rung; an already-answered same ask resumes the
// seat with that answer by reference (the post layer returned the first row's id).
test('first rung carries hand-ask:<root>:<cell>; a by-reference first row that has an answer resumes the seat at once', () => {
  const posted: { to: string; refs?: string[] }[] = [];
  const resumed: string[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const push = createNeedsHumanPush({
    seat: () => 'TC-H-POOL-1', paneId: () => 'p', coordinatorOf: () => 'TC',
    cellOf: () => 'CELL-A',
    postMail: (e) => { posted.push({ to: e.to, ...(e.refs ? { refs: e.refs } : {}) }); return 4242; },
    answerOf: (id) => (id === 4242 ? 'run 77 exited 0' : null),
    raiseDecision: () => {}, resumeWith: (t) => { resumed.push(t); }, setTimer: () => null, clearTimer: () => {},
    newBlockId: () => 'blk-9', log: (event, data) => { logs.push({ event, data }); },
  });
  push.blocked('TOOL_DENIED', 'RES run record for node-c?');
  expect(posted).toEqual([{ to: 'GUARDIAN', refs: ['block:blk-9', 'seat:TC-H-POOL-1', 'pane:p', 'reason:TOOL_DENIED', 'hand-root:env', 'hand-routed-from:TC', 'hand-ask:env:CELL-A'] }]);
  expect(resumed).toEqual(['[✋ answered by reference #4242] run 77 exited 0']);
  expect(push.activeBlockId()).toBeNull();
  expect(logs.at(-1)).toEqual({ event: 'seat.needs-human', data: { phase: 'answered-by-reference', seat: 'TC-H-POOL-1', blockId: 'blk-9', msgId: 4242, ask: 'hand-ask:env:CELL-A' } });
  // the same ask again after that answer is a NEW ask to the owner (no second by-reference resume — no loop)
  push.blocked('TOOL_DENIED', 'RES run record for node-c — still missing');
  expect(posted.length).toBe(2);
  expect(posted[1]!.refs!.at(-1)).toBe('hand-ask:env:CELL-A:after-4242');
  expect(resumed.length).toBe(1);
});
