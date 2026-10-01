import { expect, test } from 'bun:test';
import { ledgerLineToLogEvent } from './pod-ledger-events.js';

const runId = 'run-test';

test('review round keeps numbers and code values but no free text', () => {
  expect(ledgerLineToLogEvent(JSON.stringify({ event: 'review-round', round: 2, mustFix: 3, at: '2026-10-01', stage: 'review', outcome: 'fix', reason: 'required', pr: 123, runId: 'spoofed' }), runId)).toEqual({
    category: 'self-implement.pod.ledger', event: 'review-round',
    data: { runId, round: 2, mustFix: 3, stage: 'review', outcome: 'fix', pr: 123 },
  });
});

test('real writer envelope projects review metadata rather than just dataCount', () => {
  const event = ledgerLineToLogEvent(JSON.stringify({ timestamp: '2026-10-01T00:00:00Z', runId: 'remote', event: 'reviewed', data: {
    runId: 'remote', round: 3, mustFix: 2, stage: 'review', files: ['a', 'b'], reason: 'required', token: 'opaque123',
  } }), runId);
  expect(event).toEqual({ category: 'self-implement.pod.ledger', event: 'reviewed', data: { runId, round: 3, mustFix: 2, stage: 'review', filesCount: 2 } });
});

test('free text never reaches host logs — long strings and reasons are dropped, not truncated', () => {
  expect(ledgerLineToLogEvent(JSON.stringify({ event: 'reviewed', patch: 'a'.repeat(5000), reason: 'x' }), runId)?.data).toEqual({ runId });
  expect(ledgerLineToLogEvent(JSON.stringify({ event: 'reviewed', stage: 'has spaces in it' }), runId)?.data).toEqual({ runId });
});

test('arrays and objects yield counts, not their contents', () => {
  expect(ledgerLineToLogEvent(JSON.stringify({ event: 'reviewed', files: ['a', 'b'], details: { a: 'private', b: true } }), runId)?.data).toEqual({ runId, filesCount: 2, detailsCount: 2 });
});

test('secret-looking field names are omitted even when their values are collections', () => {
  const data = ledgerLineToLogEvent(JSON.stringify({ event: 'reviewed', token: 'abc', apiKey: ['a'], passwordHint: true, authorization: { a: 1 }, clientSecret: 'shh', keyboard: 'hidden', safe: false }), runId)?.data;
  expect(data).toEqual({ runId, safe: false });
});

test('only allow-listed lifecycle event names are emitted (review R2)', () => {
  expect(ledgerLineToLogEvent(JSON.stringify({ event: 'review-opaque123', data: { reason: 'opaque123' } }), runId)).toBeUndefined();
  expect(ledgerLineToLogEvent(JSON.stringify({ event: 'x' }), runId)).toBeUndefined();
  expect(ledgerLineToLogEvent(JSON.stringify({ event: 'Review Round #2' }), runId)).toBeUndefined();
  expect(ledgerLineToLogEvent(JSON.stringify({ event: 'review-sk-superSecret123456789' }), runId)).toBeUndefined();
  for (const name of ['gate-finished', 'reviewed', 'repair-finished', 'pipeline-node-entry', 'run-origin', 'human-stop', 'start']) {
    expect(ledgerLineToLogEvent(JSON.stringify({ event: name }), runId)?.event).toBe(name);
  }
});

test('a code value that carries a known secret is dropped', () => {
  expect(ledgerLineToLogEvent(JSON.stringify({ event: 'reviewed', token: 'opaque123', outcome: 'opaque123' }), runId)?.data).toEqual({ runId });
});

test('invalid or secret-looking field names and excessive fields cannot grow a log record', () => {
  const input = { event: 'reviewed', 'private key': 'bad', 'authorizationCode': 2, ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, i])) };
  const event = ledgerLineToLogEvent(JSON.stringify(input), runId);
  expect(event?.data).not.toHaveProperty('private key');
  expect(event?.data).not.toHaveProperty('authorizationCode');
  expect(Object.keys(event?.data ?? {})).toHaveLength(33);
});

test('non-JSON and JSON without a string event do not emit an event', () => {
  for (const line of ['not json', '{}', '{"event":null}', '{"event":123}', '[]', 'null']) {
    expect(ledgerLineToLogEvent(line, runId)).toBeUndefined();
  }
});
