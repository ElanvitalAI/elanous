import { expect, test } from 'bun:test';
import { authorRepairGoal, repairInputsFromBody } from './helper-repair.js';

const originalRequest = 'Add src/harness/widget.ts — keep the original contract\n\nBoundary: keep the existing API.\n';
const mustFix = [
  '① Keep `widget.value` exactly as requested; do not rename it.',
  '② Restore the test design:\n  expect(widget.value).toBe("원문");',
];

for (const category of ['review-budget', 'review-oscillation'] as const) {
  test(`${category} keeps the original first line, full request and verbatim remaining must-fix list`, () => {
    const goal = authorRepairGoal({ pr: 42, category, originalRequest, mustFix });
    expect(goal).not.toBeNull();
    expect(goal!.split('\n')[0]).toBe(originalRequest.split('\n')[0]);
    expect(goal!.startsWith(originalRequest)).toBe(true);
    expect(goal).toContain(`## 남은 must-fix (원문)\n${mustFix.join('\n')}`);
    expect(goal).toContain('PR #42');
    expect(goal).toContain('기존 시험 설계');
  });
}

test('zero, missing or blank remaining must-fix items do not author a repair goal', () => {
  for (const items of [[], [''], ['fix it', '   ']]) {
    expect(authorRepairGoal({ pr: 42, category: 'review-budget', originalRequest, mustFix: items })).toBeNull();
  }
  expect(authorRepairGoal({ pr: 42, category: 'review-oscillation', originalRequest: '  ', mustFix })).toBeNull();
});

test('unrelated stopped PR categories do not author implementation repairs', () => {
  for (const category of ['no-progress', 'environment-gap', 'goal-revision', 'report-deficit', 'unknown'] as const) {
    expect(authorRepairGoal({ pr: 42, category, originalRequest, mustFix })).toBeNull();
  }
});

test('a request without a trailing newline retains its first line and the list exactly', () => {
  const request = 'One-line request: keep  whitespace  and punctuation!';
  const item = '  - must-fix: `x`   is required.  ';
  const goal = authorRepairGoal({ pr: 19, category: 'review-budget', originalRequest: request, mustFix: [item] });
  expect(goal!.split('\n')[0]).toBe(request);
  expect(goal).toContain(`## 남은 must-fix (원문)\n${item}`);
});

test('repair inputs keep the original request first-line indentation', () => {
  const request = '  Keep the leading spaces on this line.  \n    And preserve the next line.\n';
  const body = `## 요청\n${request}\n## 마지막 리뷰 must-fix\n- Keep the request verbatim.`;
  const inputs = repairInputsFromBody(body);
  expect(inputs.originalRequest).toBe(request);
  expect(authorRepairGoal({ pr: 42, category: 'review-budget', ...inputs })!.startsWith(request)).toBe(true);
});

test('repair inputs keep every continuation line of each must-fix item in both review sections', () => {
  const first = '- Restore the assertion:\n  expect(widget.value).toBe("원문");\n  and retain its context.';
  const second = '- Fix the other assertion:\n    expect(widget.ready).toBe(true);\n  including this last line.';
  const body = `## 요청\nKeep the API.\n\n## 마지막 리뷰 must-fix\n${first}\n\n## Follow-up must-fix\n${second}\n\n## 요청 끝`;
  const inputs = repairInputsFromBody(body);
  expect(inputs.mustFix).toEqual([first, second]);
  expect(authorRepairGoal({ pr: 42, category: 'review-budget', ...inputs })).toContain(`${first}\n${second}`);
});

test('repair inputs preserve leading tabs on the request and separate adjacent multi-line items', () => {
  const request = '\t  Preserve this first line.\nKeep the rest.\n';
  const first = '- First item\n  assertion one\n\n  assertion two';
  const second = '- Second item\n  assertion three';
  const body = `## 요청\n${request}\n\n## 마지막 리뷰 must-fix\n${first}\n${second}\n\n## 요청 끝`;
  const inputs = repairInputsFromBody(body);
  expect(inputs.originalRequest).toBe(request);
  expect(inputs.mustFix).toEqual([first, second]);
});

test('repair shadow records one authored goal per stopped review-budget PR and never launches', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { recordRepairShadows, repairInputsFromBody } = await import('./helper-repair.js');
  const root = mkdtempSync(join(tmpdir(), 'helper-repair-'));
  const body = '## 요청\n「하니스로 구현」 표 접기 — 대상 scripts/lessons/handbook-page.ts\n\n## 중단 사유\n- verdict: UNCONVERGEABLE\n\n## 마지막 리뷰 must-fix\n- `summaryText`는 첫 번째 표만 요약합니다.\n\n## 요청 끝';
  expect(repairInputsFromBody(body)).toEqual({ originalRequest: '「하니스로 구현」 표 접기 — 대상 scripts/lessons/handbook-page.ts', mustFix: ['- `summaryText`는 첫 번째 표만 요약합니다.'] });
  const calls: string[][] = [];
  const runGh = (args: readonly string[]) => { calls.push([...args]); return JSON.stringify({ body }); };
  const row = (pr: number, category: 'review-budget' | 'no-progress') => ({ pr, category, headRefName: 'self-impl/x', isDraft: true } as never);
  try {
    const first = await recordRepairShadows([row(23983, 'review-budget'), row(1, 'no-progress')], { runGh, root, now: new Date('2026-10-05T06:00:00Z') });
    expect(first.map((entry) => entry.pr)).toEqual([23983]);
    const again = await recordRepairShadows([row(23983, 'review-budget')], { runGh, root });
    expect(again).toEqual([]);
    const lines = readFileSync(join(root, 'helper', 'repairs.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const goal = JSON.parse(lines[0]!).goal as string;
    expect(goal).toContain('표 접기');
    expect(goal).toContain('`summaryText`는 첫 번째 표만 요약합니다.');
    expect(calls.every((args) => args[0] === 'pr' && args[1] === 'view')).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
