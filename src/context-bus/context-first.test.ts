import { expect, test } from 'bun:test';
import { createContextFirstGate, renderContextFirst } from './context-first.js';
import type { ContextNowAnswer } from './context-now.js';

test('first note is pending once; recent utterances do not re-arm; seven hours of silence re-arms', () => {
  let time = 0;
  const gate = createContextFirstGate({ now: () => time });
  gate.note('a');
  expect(gate.take('a')).toBe(true);
  expect(gate.take('a')).toBe(false);
  time += 5 * 60_000;
  gate.note('a');
  expect(gate.take('a')).toBe(false);
  time += 7 * 60 * 60_000;
  gate.note('a');
  expect(gate.take('a')).toBe(true);
  expect(gate.take('a')).toBe(false);
});

test('commands update the last utterance without consuming a pending summary; keys are independent', () => {
  let time = 0;
  const gate = createContextFirstGate({ now: () => time });
  gate.note('channel');
  time += 5 * 60_000;
  gate.note('channel');
  expect(gate.take('channel')).toBe(true);
  time += 5 * 60 * 60_000 + 56 * 60_000;
  gate.note('channel');
  expect(gate.take('channel')).toBe(false);
  gate.note('other');
  expect(gate.take('other')).toBe(true);
});

test('rendering failure yields the shared unreadable message', () => {
  const answer: ContextNowAnswer = { at: '', topic: null, facts: [], events: [], guide: [] };
  expect(renderContextFirst(() => answer, undefined, () => '요약')).toBe('요약');
  expect(renderContextFirst(() => { throw Error('ledger unavailable'); }, undefined, () => '요약')).toBe('맥락 못 읽음');
  expect(renderContextFirst(() => answer, undefined, () => { throw Error('renderer unavailable'); })).toBe('맥락 못 읽음');
});
