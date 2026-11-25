// SEAT-MAIL-PASSIVE-DEFAULT — one row per rule: which mail opens a turn and which rides the 10-min digest.
// Expected values are independent literals (no product constants reused).
import { describe, expect, test } from 'bun:test';
import { buildFederationLadder } from '../msg/hand-raise-ladder.js';
import { isPassiveSeatMail, seatMailRoute, senderAboveOnLadder, type SeatMailRouteInput, type SeatMailRouteReason } from './seat-mail-turn-policy.js';

describe('seatMailRoute — turn only for ✋ · crown · question · P0 alert · failed result · from above', () => {
  const rows: Array<[string, SeatMailRouteInput, 'turn' | 'passive', SeatMailRouteReason]> = [
    ['crown directive', { kind: 'info', crownDirective: 'TG-OP' }, 'turn', 'crown'],
    ['crown delegation', { origin: { kind: 'agent', delegatedByCrown: true } }, 'turn', 'crown'],
    ['a person', { origin: { kind: 'human' } }, 'turn', 'human'],
    ['✋ hand raise', { kind: 'request', refs: ['block:B-1', 'reason:BUDGET'], senderAbove: false }, 'turn', 'hand'],
    ['question kind', { kind: 'question', senderAbove: false }, 'turn', 'question'],
    ['decision kind', { kind: 'decision', senderAbove: false }, 'turn', 'question'],
    ['decision intent, no kind', { intent: 'decision', senderAbove: false }, 'turn', 'question'],
    ['needs-reply flag', { kind: 'notice', needsAck: true, senderAbove: false }, 'turn', 'needs-reply'],
    ['failed result', { kind: 'report', resultState: 'failed', senderAbove: false }, 'turn', 'failed-result'],
    ['alert intent', { kind: 'notice', intent: 'alert', senderAbove: false }, 'turn', 'alert'],
    ['urgent kind', { kind: 'urgent', senderAbove: false }, 'turn', 'alert'],
    ['p0 priority', { kind: 'status', priority: 1, senderAbove: false }, 'turn', 'alert'],
    ['urgent mark', { body: '🔴 node-b down', senderAbove: false }, 'turn', 'alert'],
    ['kind-less from the coordinator above', { senderAbove: true }, 'turn', 'order'],
    ['request from above', { kind: 'request', senderAbove: true }, 'turn', 'order'],
    ['request, ladder unknown', { kind: 'request' }, 'turn', 'order-unknown-ladder'],
    ['request from below naming BUDGET', { kind: 'request', refs: ['reason:budget'], senderAbove: false }, 'turn', 'hq-reason'],
    ['wait-cancel notice (intent alert)', { kind: 'notice', intent: 'alert', refs: ['wait-cancelled-of:77', 'wait-counterpart:TC'] }, 'passive', 'wait-cancel'],
    ['routine request from below', { kind: 'request', senderAbove: false }, 'passive', 'routine-request'],
    ['routine request intent from a peer', { intent: 'request', senderAbove: false }, 'passive', 'routine-request'],
    ['done-condition from below', { doneWhen: 'PR merged', senderAbove: false }, 'passive', 'routine-request'],
    ['reply to my ask', { replyTo: 501, senderAbove: false }, 'passive', 'reply'],
    ['kind-less', { senderAbove: false }, 'passive', 'no-kind'],
    ['kind-less, ladder unknown', {}, 'passive', 'no-kind'],
    ['notice', { kind: 'notice', senderAbove: false }, 'passive', 'info'],
    ['status', { kind: 'status', senderAbove: false }, 'passive', 'info'],
    ['report (done)', { kind: 'report', resultState: 'done', senderAbove: false }, 'passive', 'info'],
    ['coord', { kind: 'coord', senderAbove: false }, 'passive', 'info'],
    ['announce', { kind: 'announce', refs: ['announce:A-1'], senderAbove: false }, 'passive', 'info'],
    ['self-timer fire (kind notice)', { kind: 'notice', senderAbove: false }, 'passive', 'info'],
  ];
  for (const [name, input, route, reason] of rows) {
    test(name, () => {
      expect(seatMailRoute(input)).toEqual({ route, reason });
      expect(isPassiveSeatMail(input)).toBe(route === 'passive');
    });
  }
  test('the body is never parsed beyond the leading urgent glyph', () => {
    expect(seatMailRoute({ body: '요청: 결정 필요 · 질문 · urgent', senderAbove: false })).toEqual({ route: 'passive', reason: 'no-kind' });
  });
});

describe('senderAboveOnLadder', () => {
  const ladder = buildFederationLadder({ hq: 'OP', spaces: [{ coordinator: 'TC', seats: ['TC', 'TC-H1', 'TC-H2'] }, { coordinator: 'JUD', seats: ['JUD', 'JUD-H1'] }] });
  test('coordinator → its hand · HQ → anyone below · hand → OP is not above', () => {
    expect(senderAboveOnLadder(ladder, 'TC', 'TC-H1')).toBe(true);
    expect(senderAboveOnLadder(ladder, 'OP', 'JUD-H1')).toBe(true);
    expect(senderAboveOnLadder(ladder, 'OP', 'TC')).toBe(true);
    expect(senderAboveOnLadder(ladder, 'TC-H1', 'OP')).toBe(false);
    expect(senderAboveOnLadder(ladder, 'TC', 'OP')).toBe(false);
    expect(senderAboveOnLadder(ladder, 'TC-H2', 'TC-H1')).toBe(false);
    expect(senderAboveOnLadder(ladder, 'OP', 'OP')).toBe(false);
  });
  test('no ladder or no names → unknown', () => {
    expect(senderAboveOnLadder(null, 'TC', 'TC-H1')).toBe(undefined);
    expect(senderAboveOnLadder(ladder, '', 'TC-H1')).toBe(undefined);
  });
});

describe('SEAT-TURN-FOLLOWUPS ② — a delegated result wakes the delegator', () => {
  test('a reply from below to a mail this seat sent → turn(delegated-result)', () => {
    expect(seatMailRoute({ kind: 'status', replyTo: 169900, replyToOwn: true, senderAbove: false })).toEqual({ route: 'turn', reason: 'delegated-result' });
  });
  test('a reply to someone else\'s mail stays passive(reply)', () => {
    expect(seatMailRoute({ kind: 'status', replyTo: 169900, replyToOwn: false, senderAbove: false })).toEqual({ route: 'passive', reason: 'reply' });
  });
  test('pr: / receipt: / result: ref on a cell this seat owns or assigned → turn; on a foreign cell → passive', () => {
    expect(seatMailRoute({ kind: 'result', refs: ['cell:SEAT-TURN-FOLLOWUPS', 'pr:40101'], cellDelegated: true, senderAbove: false }).reason).toBe('delegated-result');
    expect(seatMailRoute({ kind: 'notice', refs: ['cell:LAND-QUEUE-1', 'receipt:minim5-0712'], cellDelegated: true, senderAbove: false }).reason).toBe('delegated-result');
    expect(seatMailRoute({ kind: 'notice', refs: ['cell:LAND-QUEUE-1', 'result:green'], cellDelegated: true }).reason).toBe('delegated-result');
    expect(seatMailRoute({ kind: 'result', refs: ['cell:OTHER-1', 'pr:40101'], cellDelegated: false, senderAbove: false })).toEqual({ route: 'passive', reason: 'info' });
  });
  test('an owned cell ref with no result ref and no done envelope stays passive · done envelope counts', () => {
    expect(seatMailRoute({ kind: 'status', refs: ['cell:LAND-QUEUE-1'], cellDelegated: true, senderAbove: false })).toEqual({ route: 'passive', reason: 'info' });
    expect(seatMailRoute({ kind: 'status', refs: ['cell:LAND-QUEUE-1'], cellDelegated: true, resultState: 'done', senderAbove: false }).reason).toBe('delegated-result');
  });
  test('from above it is still an order (the ladder rule wins)', () => {
    expect(seatMailRoute({ kind: 'status', replyTo: 5, replyToOwn: true, senderAbove: true }).reason).toBe('order');
  });
});
