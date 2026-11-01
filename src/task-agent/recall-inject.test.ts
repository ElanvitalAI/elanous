import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { handTask, readTaskCard, writeTaskCards, type TaskCard } from './task-hand.js';
import { priorLessonsFor, RECALL_MAX_CHARS, RECALL_MAX_ITEMS } from './recall-inject.js';

const HEAD = 'a'.repeat(40);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function card(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: 'ta-prior', text: 'same cell goal', checklistId: 'CELL-A', createdAt: '2026-10-31T10:00:00.000Z',
    status: 'failed', history: [{ at: '2026-10-31T10:01:00.000Z', event: 'run-failed', detail: 'focused test failed on empty input' }],
    ...overrides,
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ta-recall-inject-'));
  roots.push(root);
  return root;
}

describe('RECALL-INJECT — same-cell prior lessons', () => {
  test('second hand injects previous failure and captured must-fix into the new card and observes the fill', async () => {
    const root = tempRoot();
    const statePath = join(root, 'task-agent-actions.json');
    const resultPath = join(root, 'review.json');
    const first = await handTask({ id: 'ta-recall-first', text: 'first attempt', checklistId: 'CELL-A', statePath });
    const prior = { ...first.card,
      status: 'failed' as const,
      history: [...first.card.history, { at: '2026-10-31T10:01:00.000Z', event: 'run-failed', detail: 'focused test failed on empty input' }],
      reviewRequests: [{ pr: 51, head: HEAD, at: '2026-10-31T10:02:00.000Z', resultPath }],
    };
    writeTaskCards(statePath, [prior]);
    writeFileSync(resultPath, `${JSON.stringify({ pr: 51, headCommit: HEAD, verdict: 'fail', reviewed: true, mustFix: ['reject an empty recalled lesson'] })}\n`);

    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const second = await handTask({ id: 'ta-recall-second', text: 'second attempt', checklistId: 'CELL-A', statePath });
      expect(second.card.text).toContain('## 앞선 교훈(같은 칸 · 카드 ta-recall-first)');
      expect(second.card.text).toContain('focused test failed on empty input');
      expect(second.card.text).toContain('reject an empty recalled lesson');
      const event = log.mock.calls.find(([category, name, data]) => category === 'task-agent'
        && name === 'recall-inject-filled' && (data as Record<string, unknown>).card === 'ta-recall-second');
      expect(event?.[2]).toMatchObject({ checklistId: 'CELL-A', priorCards: 1, items: 2, truncated: false });
      expect((event?.[2] as Record<string, unknown> | undefined)?.chars).toBeGreaterThan(0);
    } finally { log.mockRestore(); }
    expect(readTaskCard('ta-recall-second', statePath)?.text).toContain('reject an empty recalled lesson');
  });

  test('different checklist and missing checklist preserve the goal text; zero prior cards is observed distinctly', async () => {
    const root = tempRoot();
    const statePath = join(root, 'task-agent-actions.json');
    writeTaskCards(statePath, [card()]);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const different = await handTask({ id: 'ta-recall-other-cell', text: 'unchanged text', checklistId: 'CELL-B', statePath });
      const unbound = await handTask({ id: 'ta-recall-unbound', text: 'plain text', statePath });
      expect(different.card.text).toBe('unchanged text');
      expect(unbound.card.text).toBe('plain text');
      expect(log.mock.calls.find(([category, name, data]) => category === 'task-agent'
        && name === 'recall-inject-filled' && (data as Record<string, unknown>).card === 'ta-recall-other-cell')?.[2])
        .toMatchObject({ checklistId: 'CELL-B', priorCards: 0, items: 0, chars: 0, truncated: false });
      expect(log.mock.calls.some(([category, name, data]) => category === 'task-agent'
        && name === 'recall-inject-filled' && (data as Record<string, unknown>).card === 'ta-recall-unbound')).toBe(false);
    } finally { log.mockRestore(); }
  });

  test('unreadable review output is labeled not recovered rather than zero must-fix', () => {
    const prior = card({ status: 'done', history: [], reviewRequests: [
      { pr: 51, head: HEAD, at: '2026-10-31T10:02:00.000Z', resultPath: '/missing/review.json' },
    ] });
    const result = priorLessonsFor('CELL-A', [prior]);
    expect(result.block).toContain('직전 결과 미회수');
    expect(result.block).not.toContain('must-fix: 0건');
  });

  test('failure lesson uses the latest failure event, not later observational history', () => {
    const prior = card({ history: [
      { at: '2026-10-31T10:01:00.000Z', event: 'failed', detail: 'real failure reason' },
      { at: '2026-10-31T10:02:00.000Z', event: 'run-bound', detail: 'later observation' },
    ] });
    const result = priorLessonsFor('CELL-A', [prior]);
    expect(result.block).toContain('real failure reason');
    expect(result.block).not.toContain('later observation');
  });

  test('closed-by-hand reason is not labeled as a failure lesson', () => {
    const prior = card({ history: [
      { at: '2026-10-31T10:01:00.000Z', event: 'failed', detail: 'actual run failure' },
      { at: '2026-10-31T10:02:00.000Z', event: 'closed-by-hand', detail: 'duplicate card' },
    ] });
    const result = priorLessonsFor('CELL-A', [prior]);
    expect(result.block).toContain('actual run failure');
    expect(result.block).not.toContain('duplicate card');
  });

  test('an oversized first lesson is omitted whole without implying its card id was included', () => {
    const prior = card({ id: 'ta-oversized', history: [
      { at: '2026-10-31T10:01:00.000Z', event: 'failed', detail: `reason ${'x'.repeat(RECALL_MAX_CHARS + 100)}` },
    ] });
    const result = priorLessonsFor('CELL-A', [prior]);
    expect(result.block).toContain('## 앞선 교훈(같은 칸)');
    expect(result.block).not.toContain('ta-oversized');
    expect(result.block?.length).toBeLessThanOrEqual(RECALL_MAX_CHARS);
  });

  test('re-hand with the same card id does not recall its own earlier text', async () => {
    const root = tempRoot();
    const statePath = join(root, 'task-agent-actions.json');
    await handTask({ id: 'ta-same-id', text: 'first pass', checklistId: 'CELL-A', statePath });
    const repeated = await handTask({ id: 'ta-same-id', text: 'second pass', checklistId: 'CELL-A', statePath });
    expect(repeated.card.text).toBe('second pass');
  });

  test('item and character budgets truncate explicitly', () => {
    const many = Array.from({ length: 12 }, (_, index) => card({
      id: `ta-prior-${index}`, createdAt: `2026-10-${String(31 - index).padStart(2, '0')}T10:00:00.000Z`,
      history: [{ at: '2026-10-31T10:01:00.000Z', event: 'run-failed', detail: `failed ${index}` }],
    }));
    const itemBound = priorLessonsFor('CELL-A', many);
    expect(itemBound.items).toBe(RECALL_MAX_ITEMS);
    expect(itemBound.block).toContain('항목 상한 8건 초과분 생략');
    expect(itemBound.truncated).toBe(true);

    const charBound = priorLessonsFor('CELL-A', [card({
      history: [{ at: '2026-10-31T10:01:00.000Z', event: 'run-failed', detail: `failed ${'x'.repeat(2500)}` }],
    })]);
    expect(charBound.block?.length).toBeLessThanOrEqual(RECALL_MAX_CHARS);
    expect(charBound.block).toContain('글자 상한 2000자에서 나머지 생략');
    expect(charBound.truncated).toBe(true);

    const bothBounds = priorLessonsFor('CELL-A', Array.from({ length: 12 }, (_, index) => card({
      id: `ta-long-${index}`, createdAt: `2026-10-${String(31 - index).padStart(2, '0')}T10:00:00.000Z`,
      history: [{ at: '2026-10-31T10:01:00.000Z', event: 'run-failed', detail: `failed ${'y'.repeat(500)}` }],
    })));
    expect(bothBounds.block?.length).toBeLessThanOrEqual(RECALL_MAX_CHARS);
    expect(bothBounds.block).toContain('항목 상한 8건 초과분 생략');
    expect(bothBounds.block).toContain('글자 상한 2000자에서 나머지 생략');
  });
});
