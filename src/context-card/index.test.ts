import { expect, test } from 'bun:test';
import { CONTEXT_CARD_SCREEN_CHARS, serializeContextCard, type ContextCard } from './index.js';

const card: ContextCard = {
  id: 'task:42', kind: 'task', conclusion: 'Fix parser', why: 'Review found a defect',
  verdict: 'Focused test passes', remaining: ['first', 'second', 'third'],
  pointers: ['docs/goal.md', 'run-1', 'PR #2'], source: 'run-ledger', updatedAt: '2026-10-05T00:00:00Z',
  supersedes: 'task:41',
};

test('schema serializes all requested fields without folding when within the screen', () => {
  expect(JSON.parse(serializeContextCard(card))).toEqual(card);
  expect([...serializeContextCard(card)].length).toBeLessThanOrEqual(CONTEXT_CARD_SCREEN_CHARS);
});

test('overlong lists fold with accurate remaining and pointer counts and leave input intact', () => {
  const long = { ...card, remaining: Array.from({ length: 8 }, (_, i) => `remaining-${i}-${'r'.repeat(40)}`), pointers: Array.from({ length: 8 }, (_, i) => `pointer-${i}-${'p'.repeat(40)}`) };
  const before = structuredClone(long);
  const output = serializeContextCard(long, 320);
  const parsed = JSON.parse(output) as ContextCard;
  expect([...output].length).toBeLessThanOrEqual(320);
  for (const field of ['remaining', 'pointers'] as const) {
    const kept = parsed[field].filter((value) => !/^외 \d+개$/.test(value));
    expect(kept).toEqual(long[field].slice(0, kept.length));
    expect(parsed[field].at(-1)).toBe(`외 ${long[field].length - kept.length}개`);
  }
  expect(parsed.verdict).toBe(card.verdict);
  expect(long).toEqual(before);
  expect(serializeContextCard(long, 320)).toBe(output);
});

test('default screen budget folds a long card without losing its verdict', () => {
  const long = { ...card, remaining: Array.from({ length: 40 }, (_, i) => `item-${i}-${'x'.repeat(80)}`), pointers: Array.from({ length: 20 }, (_, i) => `path-${i}-${'y'.repeat(80)}`) };
  const output = serializeContextCard(long);
  const parsed = JSON.parse(output) as ContextCard;
  expect([...output].length).toBeLessThanOrEqual(CONTEXT_CARD_SCREEN_CHARS);
  expect(parsed.remaining.at(-1)).toMatch(/^외 \d+개$/);
  expect(parsed.pointers.at(-1)).toMatch(/^외 \d+개$/);
  expect(parsed.verdict).toBe(long.verdict);
});

test('impossible budget refuses to silently truncate the core, and conclusion must be one line', () => {
  expect(() => serializeContextCard(card, 5)).toThrow('card core and omission counts exceed maxChars');
  expect(() => serializeContextCard({ ...card, conclusion: 'two\nlines' })).toThrow('conclusion must be one line');
});
