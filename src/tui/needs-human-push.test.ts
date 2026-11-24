// NEED-HUMAN-PUSH — literal expectations: one mail per block, the escalation ladder, reply-to-block resume, OP → CEO card.
import { expect, test } from 'bun:test';
import { createNeedsHumanPush, ESCALATE_AFTER_MS, type NeedsHumanDeps } from './needs-human-push.js';

function rig(seat: string, coordinator: string | null) {
  const mails: { to: string; body: string; intent?: string; refs?: string[]; correlationId?: string; from: string }[] = [];
  const cards: { title: string; seat: string; blockId: string }[] = [];
  const resumed: string[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let nextId = 100;
  const deps: NeedsHumanDeps = {
    seat: () => seat, paneId: () => 'pane-7', coordinatorOf: () => coordinator,
    postMail: (e) => { mails.push({ to: e.to, body: e.body, from: e.from, ...(e.intent ? { intent: e.intent } : {}), ...(e.refs ? { refs: e.refs } : {}), ...(e.correlationId ? { correlationId: e.correlationId } : {}) }); return ++nextId; },
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
    refs: ['block:blk-1', 'seat:JUD-B', 'pane:pane-7', 'reason:HUMAN_DECISION'],
    body: '[✋ NEED HUMAN · JUD-B] plan needs a choice · 원하는 것: 이 막힘을 풀 결정·입력 (답장하면 그대로 재개) · 선택지: 재개/중단/다른 방법' });
  expect(r.logs[0]).toEqual({ event: 'seat.needs-human', data: { phase: 'routed', rung: 'OP', seat: 'JUD-B', blockId: 'blk-1' } });
});

test('seat in a space with a coordinator → mail to the coordinator only; no reply in 5 min → ONE forward to OP', () => {
  const r = rig('JUD-B', 'JUD');
  r.push.blocked('HUMAN_DECISION', 'x');
  expect(r.mails.map((m) => m.to)).toEqual(['JUD']);
  expect(r.timers[0]!.ms).toBe(ESCALATE_AFTER_MS);
  r.fire();
  expect(r.mails.map((m) => m.to)).toEqual(['JUD', 'OP']);
  expect(r.mails[1]!.body).toContain('escalated from JUD after 5m');
  expect(r.logs.at(-1)!.data).toMatchObject({ phase: 'escalated', from: 'JUD', to: 'OP', afterMs: 300000 });
  r.fire();   // OP unanswered too: HUMAN_DECISION reaches the CEO as a card, no further mail
  expect(r.mails.length).toBe(2);
  expect(r.cards.map((c) => c.seat)).toEqual(['JUD-B']);
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
