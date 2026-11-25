// FED-MAIL-WORK-ORDER — the structured trust fields ride the whole mid-turn chain:
// ledger arrival → on-arrived → steer offer → steer IPC (JSON) → steer inbox → pending drain → interjection frame.
import { expect, test } from 'bun:test';
import { seatMailOnArrived } from './seat-mail-on-arrived.js';
import { offerSeatMailSteer } from './seat-mail-midturn-steer.js';
import { createNextTuiSteerInbox, createNextTuiSteerRouter, NEXT_TUI_STEER_TYPE } from '../repl/next-tui-steer.js';
import { drainPendingInterjections } from '../session/pending-input.js';
import { buildInterjectionMessage } from '../chat/interjection.js';

function carry(arrival: Parameters<ReturnType<typeof seatMailOnArrived>>[0], wire: (m: Record<string, unknown>) => Record<string, unknown> = (m) => m): string {
  const sessionId = `chain-${Math.random()}`;
  const router = createNextTuiSteerRouter();
  const inbox = createNextTuiSteerInbox(sessionId, () => {});
  router.listen('turn-1', (request) => { if (request.kind === 'steer') inbox.push(request.steerId, request.text, request.urgent === true, request.seatMail); });
  let serial = 0;
  const onArrived = seatMailOnArrived({ busy: () => true, injectKey: () => {}, queueWake: null,
    enqueueMidTurn: (event) => offerSeatMailSteer(event, (steerId, text, urgent, seatMail) =>
      router.receive(JSON.parse(JSON.stringify(wire({ type: NEXT_TUI_STEER_TYPE, turnId: 'turn-1', steerId, text, urgent, ...(seatMail ? { seatMail } : {}) })))), () => ++serial) !== null });
  onArrived(arrival);
  return buildInterjectionMessage(drainPendingInterjections(sessionId), 'after-interrupt', new Set(['TC']))!;
}

test('declared ledger sender with agent origin arrives as a work order', () => {
  const text = carry([{ msgId: 501, seat: 'OP', sender: 'TC', text: 'do the review', intent: 'request', origin: { kind: 'agent', seat: 'TC' } }]);
  expect(text).toContain('<federation_work_order from="TC" intent="request" msg="501">\ndo the review\n</federation_work_order>');
});

test('crown directive id rides the chain (undeclared ledger sender → trusted, crown mark)', () => {
  const text = carry([{ msgId: 502, seat: 'OP', sender: 'CLAUDE-OP', text: 'relay', intent: 'request', crownDirective: '77' }]);
  expect(text).toContain('<federation_work_order from="CLAUDE-OP" intent="request" msg="502" crown="yes">');
});

test('system origin rides the chain and stays untrusted', () => {
  const text = carry([{ msgId: 503, seat: 'OP', sender: 'TC', text: 'hook', intent: 'request', origin: { kind: 'system', seat: 'TC' } }]);
  expect(text).toContain('<seat_mail_untrusted msg="503" from="TC" intent="request">');
});

test('a malformed originKind on the wire keeps a declared sender untrusted', () => {
  const text = carry([{ msgId: 504, seat: 'OP', sender: 'TC', text: 'x', intent: 'request' }],
    (m) => ({ ...m, seatMail: { ...(m.seatMail as object), originKind: 'a'.repeat(65) } }));
  expect(text).toContain('<seat_mail_untrusted msg="504" from="TC" intent="request">');
});
