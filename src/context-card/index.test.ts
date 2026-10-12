import { expect, test } from 'bun:test';
import {
  CONTEXT_CARD_SCREEN_CHARS, PR_CONCLUSION_NONE, PR_CONCLUSION_UNREADABLE,
  buildPrConclusionCard, firstParagraphOf, prConclusionCardHeader, serializeContextCard, type ContextCard,
} from './index.js';

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

const prBase = {
  id: 'pr:9001', pointers: ['docs/goal.md'], source: 'test', updatedAt: '2026-10-11T00:00:00Z',
} as const;

test('kind-pr conclusion card: 결론 있음 — header front-loads the one-line conclusion with pointer', () => {
  const built = buildPrConclusionCard({ ...prBase, firstParagraph: 'Fix parser crash\non empty input' });
  expect(built.kind).toBe('pr');
  expect(built.conclusion).toBe('Fix parser crash on empty input');
  expect(prConclusionCardHeader(built)).toBe('결론: Fix parser crash on empty input · 포인터: docs/goal.md');
});

test('kind-pr conclusion card: 결론 없음 — verbatim fallback header', () => {
  const built = buildPrConclusionCard({ ...prBase, firstParagraph: '' });
  expect(built.conclusion).toBe(PR_CONCLUSION_NONE);
  expect(prConclusionCardHeader(built)).toBe('결론: 없음(원문에 결론 없음)');
});

test('kind-pr conclusion card: 확인 불가 — verbatim fallback wins over the first paragraph', () => {
  const built = buildPrConclusionCard({ ...prBase, firstParagraph: '부분적으로 읽힌 단락', unreadable: true });
  expect(built.conclusion).toBe(PR_CONCLUSION_UNREADABLE);
  expect(prConclusionCardHeader(built)).toBe('결론: 확인 불가');
});

test('원문 보존 — firstParagraphOf never consumes the body and the header leaves it verbatim below', () => {
  const body = '첫 단락 한 줄\n둘째 줄\n\n둘째 단락 원문';
  const extracted = firstParagraphOf(body);
  expect(extracted).toBe('첫 단락 한 줄\n둘째 줄');
  expect(body).toBe('첫 단락 한 줄\n둘째 줄\n\n둘째 단락 원문');
  const built = buildPrConclusionCard({ ...prBase, firstParagraph: extracted });
  const rendered = `${prConclusionCardHeader(built)}\n\n${body}`;
  expect(rendered.startsWith('결론: 첫 단락 한 줄 둘째 줄 · 포인터: docs/goal.md\n\n')).toBe(true);
  expect(rendered.endsWith(body)).toBe(true);
});
