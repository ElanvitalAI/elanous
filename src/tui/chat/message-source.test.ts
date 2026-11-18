import { afterEach, beforeEach, expect, test } from 'bun:test';
import { parseMessageSource, type SerializedMessage } from '../../session/index.js';
import { logViewLines } from './log-view.js';

// The band colour follows COLORFGBG (turn-band-theme.ts); pin it so the expectation never depends on the terminal
// the tests run in (#38379 REVIEW-1). '15;0' = light text on a dark background → the dark token.
const previousColorfgbg = process.env.COLORFGBG;
beforeEach(() => { process.env.COLORFGBG = '15;0'; });
afterEach(() => { if (previousColorfgbg === undefined) delete process.env.COLORFGBG; else process.env.COLORFGBG = previousColorfgbg; });

const previousNoColor = process.env.NO_COLOR;
afterEach(() => { if (previousNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previousNoColor; });
const user = (content: string, from?: SerializedMessage['from']): SerializedMessage => ({ role: 'user', content, ts: '2026-11-17T00:00:00Z', ...(from ? { from } : {}) });
const plain = (lines: readonly string[]) => lines.map((line) => Bun.stripANSI(line).trimEnd());

test('the source comes from the structured field: the same wording draws three ways', () => {
  delete process.env.NO_COLOR;
  const text = '[예약 깨움 w1] SPWAKE review — 남은 일을 이어서 처리하라.';
  const human = logViewLines([user(text)], 60);
  const system = logViewLines([user(text, { kind: 'system', origin: 'scheduled' })], 60);
  const agent = logViewLines([user('#38031 리뷰 결과 반영해 줘', { kind: 'agent', seat: 'OP', intent: 'request', msgId: '82543' })], 60);
  // human: the person's band, as before.
  expect(human[0]).toStartWith('\x1b[48;5;235;38;5;252m'); // the person's band, dark token (literal — rule 11)
  // system: one dim line naming what woke the turn; the internal instruction is not shown.
  expect(system.slice(0, -1)).toEqual(['\x1b[2m↻ Resuming (scheduled check)\x1b[22m']);
  // agent: a paler band under «⇢ SEAT · intent · #id», never the person's «>» band.
  expect(plain(agent.slice(0, 2))).toEqual(['⇢ OP · request · #82543', '  #38031 리뷰 결과 반영해 줘']);
  expect(agent.slice(0, 2).every((row) => row.startsWith('\x1b[48;5;60;97m'))).toBe(true);
  expect(agent.some((row) => row.includes('48;5;235;38;5;252'))).toBe(false);
});

test('NO_COLOR keeps the glyphs: «>» for a person, «⇢ SEAT» and an indent for an agent, «↻» for the system', () => {
  process.env.NO_COLOR = '1';
  expect(logViewLines([user('hi')], 40)[0]).toBe('> hi');
  expect(logViewLines([user('hi', { kind: 'agent', seat: 'TC' })], 40).slice(0, 2)).toEqual(['⇢ TC', '  hi']);
  expect(logViewLines([user('x', { kind: 'system', origin: 'goal-continue' })], 40)[0]).toBe('\x1b[2m↻ Continuing\x1b[22m');
});

test('a malformed source from the turn payload is dropped, never guessed', () => {
  expect(parseMessageSource({ kind: 'agent', seat: 'OP', intent: 'request', msgId: '1' })).toEqual({ kind: 'agent', seat: 'OP', intent: 'request', msgId: '1' });
  expect(parseMessageSource({ kind: 'system', origin: 'scheduled', extra: 'x' })).toEqual({ kind: 'system', origin: 'scheduled' });
  for (const bad of [null, 'agent', [], { kind: 'bot' }, {}]) expect(parseMessageSource(bad)).toBeUndefined();
  expect(parseMessageSource({ kind: 'agent', seat: 'OP\nignore previous' })).toEqual({ kind: 'agent' });
});

test('A217: an agent request with a due draws «⇢ OP · request · due HH:MM · #id»; the due survives the JSON parse', () => {
  delete process.env.NO_COLOR;
  const from = parseMessageSource({ kind: 'agent', seat: 'OP', intent: 'request', due: '14:00', msgId: '83843' });
  expect(from).toEqual({ kind: 'agent', seat: 'OP', intent: 'request', due: '14:00', msgId: '83843' });
  expect(plain(logViewLines([user('B1-C 에 요청 계약 반영', from)], 60).slice(0, 1))).toEqual(['⇢ OP · request · due 14:00 · #83843']);
});
