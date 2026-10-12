import { expect, test } from 'bun:test';
import { CONTEXT_CARD_SCREEN_CHARS, serializeContextCard } from './index.js';
import { buildCellCard } from './cell.js';

const uuid = '123e4567-e89b-12d3-a456-426614174000';
const asOf = '2026-10-12T00:00:00Z';

test('buildCellCard derives unique ordered PR, run, and checklist pointers without embedding evidence', () => {
  const evidence = `Review #1234 completed in run-${uuid}; duplicate #1234`;
  const card = buildCellCard('0.2.26', {
    id: 'CTX-DIGEST', title: 'Digest #5678', status: 'yellow', owner: 'OP', disposition: 'defer', evidence,
  }, asOf);
  const output = serializeContextCard(card);
  expect(card.pointers).toEqual([`#1234`, `run-${uuid}`, '#5678', 'checklist:0.2.26/CTX-DIGEST']);
  expect(output).not.toContain(evidence);
  expect(card).toMatchObject({
    id: 'cell:0.2.26/CTX-DIGEST', kind: 'cell', conclusion: 'Digest #5678',
    why: '담당 OP · 처분 defer', verdict: 'yellow', remaining: [], source: 'release-checklist:0.2.26', updatedAt: asOf,
  });
});

test('buildCellCard keeps only the first title line and omits absent owner and disposition', () => {
  const card = buildCellCard('1.2.3', { id: 'cell-1', title: 'First line\nsecret second line', status: 'done' }, asOf);
  const output = serializeContextCard(card);
  expect(card.conclusion).toBe('First line');
  expect(card.why).toBe('');
  expect(output).not.toContain('secret second line');
});

test('buildCellCard serializes very long evidence within the default screen budget', () => {
  const card = buildCellCard('0.2.26', {
    id: 'CTX-DIGEST', title: 'Digest', status: 'green', evidence: `private evidence ${'x'.repeat(100_000)} #1234`,
  }, asOf);
  const output = serializeContextCard(card);
  expect([...output].length).toBeLessThanOrEqual(CONTEXT_CARD_SCREEN_CHARS);
  expect(output).not.toContain('private evidence');
});
