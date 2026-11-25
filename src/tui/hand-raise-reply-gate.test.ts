// HAND-RAISE-REPLY-GATE — literal expectations · injected clock · a real temp ledger for the reply check.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore, type MessageEnvelope } from '../msg/msg-store.js';
import { createHandRaiseReplyGate, handRaiseBulkLine, handRaiseClosedOn, handRaiseRepliedOn, handRaiseSurfaceLine, isHandRaiseMail } from './hand-raise-reply-gate.js';

const root = mkdtempSync(join(tmpdir(), 'hand-raise-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshStore = (): MsgStore => new MsgStore(join(root, `m${++n}.db`));

const T0 = Date.parse('2026-11-25T02:18:47.000Z');
const MIN = 60_000;
const handRaise = (to = 'OP'): MessageEnvelope => ({ from: 'JUD', to, kind: 'request', intent: 'decision', correlationId: 'blk-mwvhvnun-1',
  body: '[✋ NEED HUMAN · JUD] 약속 원장 상태 변경 수단을 찾지 못함',
  refs: ['block:blk-mwvhvnun-1', 'seat:JUD', 'pane:pbefa8f5f', 'reason:TOOL_DENIED'] });

test('isHandRaiseMail: block: and reason: refs together — never the body', () => {
  expect(isHandRaiseMail({ refs: ['block:blk-1', 'seat:JUD', 'reason:TOOL_DENIED'] })).toBe(true);
  expect(isHandRaiseMail({ refs: ['block:blk-1'] })).toBe(false);
  expect(isHandRaiseMail({ refs: ['reason:TOOL_DENIED'] })).toBe(false);
  expect(isHandRaiseMail({ refs: [] })).toBe(false);
  expect(isHandRaiseMail({})).toBe(false);
});

test('handRaiseRepliedOn: OP «will check next time» to someone else is not a reply; OP → JUD reply-to closes', () => {
  const store = freshStore();
  try {
    const raised = store.post(handRaise());
    const q = { msgId: raised.id, seat: 'OP', sender: 'JUD', correlationId: 'blk-mwvhvnun-1' };
    expect(handRaiseRepliedOn(store, q)).toBe(false);
    store.post({ from: 'OP', to: 'TC', body: '다음 점검에서 확인하겠습니다' });
    store.post({ from: 'OP', to: 'JUD', body: 'unrelated note' });
    expect(handRaiseRepliedOn(store, q)).toBe(false);
    store.post({ from: 'OP', to: 'JUD', body: '다른 방법으로 재개해 주세요.', replyTo: raised.id });
    expect(handRaiseRepliedOn(store, q)).toBe(true);
  } finally { store.close(); }
});

test('handRaiseRepliedOn: same correlation id counts; a CLAUDE-OP proxy reply counts; another seat does not', () => {
  const store = freshStore();
  try {
    const raised = store.post(handRaise());
    const q = { msgId: raised.id, seat: 'OP', sender: 'JUD', correlationId: 'blk-mwvhvnun-1' };
    store.post({ from: 'TC', to: 'JUD', body: 'I am not OP', replyTo: raised.id });
    expect(handRaiseRepliedOn(store, q)).toBe(false);
    store.post({ from: 'CLAUDE-OP', to: 'JUD', body: '[Claude OP 대행] 재개', correlationId: 'blk-mwvhvnun-1' });
    expect(handRaiseRepliedOn(store, q)).toBe(true);
  } finally { store.close(); }
});

function gateHarness(closed: () => boolean) {
  let now = T0;
  const surfaced: string[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const gate = createHandRaiseReplyGate({ now: () => now, closed, surface: (line) => { surfaced.push(line); }, log: (e, d) => { logs.push([e, d]); } });
  return { gate, surfaced, logs, at: (ms: number) => { now = T0 + ms; }, events: () => logs.map(([e]) => e) };
}

test('no outcome: 4m nothing · 5m one P0 reminder · never twice · no mail of its own (the ladder sweep climbs)', () => {
  const h = gateHarness(() => false);
  h.at(1 * MIN);
  h.gate.noteUnanswered({ msgId: 160695, seat: 'OP', sender: 'JUD', arrivedAt: T0 });
  h.at(4 * MIN); h.gate.tick();
  expect(h.surfaced).toEqual([]);
  h.at(5 * MIN); h.gate.tick();
  expect(h.surfaced).toEqual(['✋ JUD waiting 5m — give one outcome before it auto-escalates at 10m: eln msg hand 160695 resolve|reject|escalate "<text>"']);
  h.at(25 * MIN); h.gate.tick();
  expect(h.surfaced.length).toBe(1);
  expect(h.events()).toEqual(['needhuman.open', 'needhuman.unanswered']);
  expect(h.logs[1]![1]).toEqual({ msgId: 160695, seat: 'OP', sender: 'JUD', waitedMs: 300_000 });
  expect(h.gate.open().length).toBe(1);
});

test('an outcome before 5m closes it: no surface, needhuman.replied', () => {
  let closed = false;
  const h = gateHarness(() => closed);
  h.gate.noteUnanswered({ msgId: 7, seat: 'OP', sender: 'JUD', arrivedAt: T0 });
  h.at(3 * MIN); h.gate.tick();
  closed = true;
  h.at(4 * MIN); h.gate.tick();
  h.at(30 * MIN); h.gate.tick();
  expect(h.surfaced).toEqual([]);
  expect(h.events()).toEqual(['needhuman.open', 'needhuman.replied']);
  expect(h.gate.open()).toEqual([]);
});

test('arrival time is the ✋ mail time (an old ✋ found open at 7m surfaces at the first tick)', () => {
  const h = gateHarness(() => false);
  h.at(7 * MIN);
  h.gate.noteUnanswered({ msgId: 8, seat: 'OP', sender: 'UX', arrivedAt: T0 });
  h.gate.tick();
  expect(h.surfaced).toEqual(['✋ UX waiting 7m — give one outcome before it auto-escalates at 10m: eln msg hand 8 resolve|reject|escalate "<text>"']);
});

test('bulk: 3 open ✋ of the same reason → ONE «change the rule» item, no per-hand reminders; a 4th re-surfaces the group once', () => {
  const h = gateHarness(() => false);
  h.gate.noteUnanswered({ msgId: 161229, seat: 'TC', sender: 'TC-H-CC-2', reason: 'TOOL_DENIED', arrivedAt: T0 });
  h.gate.noteUnanswered({ msgId: 161319, seat: 'TC', sender: 'TC-H-CX-4', reason: 'TOOL_DENIED', arrivedAt: T0 });
  h.gate.noteUnanswered({ msgId: 161320, seat: 'TC', sender: 'TC-H-CC-1', reason: 'TOOL_DENIED', arrivedAt: T0 });
  h.gate.noteUnanswered({ msgId: 161312, seat: 'TC', sender: 'MVP-B', reason: 'HUMAN_DECISION', arrivedAt: T0 });
  h.at(1 * MIN); h.gate.tick();
  expect(h.surfaced).toEqual(['✋ 3 hands blocked on the same rule — change the rule (reason TOOL_DENIED · TC-H-CC-2 #161229, TC-H-CX-4 #161319, TC-H-CC-1 #161320)']);
  h.at(6 * MIN); h.gate.tick();
  expect(h.surfaced.slice(1)).toEqual(['✋ MVP-B waiting 6m — give one outcome before it auto-escalates at 10m: eln msg hand 161312 resolve|reject|escalate "<text>"']);
  h.gate.noteUnanswered({ msgId: 161333, seat: 'TC', sender: 'TC-H-CC-1', reason: 'TOOL_DENIED', arrivedAt: T0 + 6 * MIN });
  h.at(7 * MIN); h.gate.tick();
  h.at(8 * MIN); h.gate.tick();
  expect(h.surfaced.length).toBe(3);
  expect(h.surfaced[2]!.startsWith('✋ 4 hands blocked on the same rule — change the rule (reason TOOL_DENIED · ')).toBe(true);
  expect(h.events().filter((e) => e === 'needhuman.bulk').length).toBe(2);
});

test('a failing ledger check never surfaces a closed one by mistake (logged), and the same msg is tracked once', () => {
  const h = gateHarness(() => { throw new Error('database is locked'); });
  h.gate.noteUnanswered({ msgId: 9, seat: 'OP', sender: 'JUD', arrivedAt: T0 });
  h.gate.noteUnanswered({ msgId: 9, seat: 'OP', sender: 'JUD', arrivedAt: T0 });
  h.at(2 * MIN); h.gate.tick();
  expect(h.surfaced).toEqual([]);
  expect(h.events()).toEqual(['needhuman.open', 'needhuman.check-failed']);
});

test('surface line literals', () => {
  expect(handRaiseSurfaceLine('JUD', 5 * MIN + 59_000, 1)).toBe('✋ JUD waiting 5m — give one outcome before it auto-escalates at 10m: eln msg hand 1 resolve|reject|escalate "<text>"');
  expect(handRaiseBulkLine('TOOL_DENIED', [{ sender: 'A', msgId: 1 }, { sender: 'B', msgId: 2 }, { sender: 'C', msgId: 3 }]))
    .toBe('✋ 3 hands blocked on the same rule — change the rule (reason TOOL_DENIED · A #1, B #2, C #3)');
});

test('handRaiseClosedOn: a HandRaise resolve by OP on an escalated chain closes the sub-coordinator\'s copy too', () => {
  const store = freshStore();
  try {
    const raised = store.post({ ...handRaise('TC'), from: 'TC-H-CC-2', refs: ['block:blk-x', 'seat:TC-H-CC-2', 'reason:HUMAN_DECISION'] });
    const q = { msgId: raised.id, seat: 'TC', sender: 'TC-H-CC-2' };
    expect(handRaiseClosedOn(store, q)).toBe(false);
    store.post({ from: 'OP', to: 'TC-H-CC-2', body: '[✋ RESOLVED · OP] go', replyTo: raised.id, refs: ['hand-outcome:resolve', `hand-of:${raised.id}`] });
    expect(handRaiseClosedOn(store, q)).toBe(true);
  } finally { store.close(); }
});
