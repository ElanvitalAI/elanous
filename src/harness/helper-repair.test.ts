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
    expect(JSON.parse(lines[0]!)).toMatchObject({ mode: 'shadow', result: 'shadow' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('live with an injected queue and a cap of 2 launches two, records the third as capped, labels only launched PRs, holds a release-path PR, and shadow launches nothing', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { recordRepairShadows } = await import('./helper-repair.js');
  const root = mkdtempSync(join(tmpdir(), 'helper-repair-live-'));
  const bodyFor = (request: string) => `## 요청\n${request}\n\n## 마지막 리뷰 must-fix\n- Keep the assertion.`;
  const filesFor = (pr: number) => pr === 30
    ? [{ filename: 'graphs/release/loop.yaml' }]
    : [{ filename: 'src/harness/widget.ts' }];
  const calls: string[][] = [];
  const runGh = (args: readonly string[]) => {
    calls.push([...args]);
    const pr = Number(args[2] ?? /pulls\/(\d+)/.exec(args.join('\n'))?.[1]);
    if (args[0] === 'api') return JSON.stringify(filesFor(Number(/pulls\/(\d+)/.exec(args.join('\n'))?.[1])));
    if (args[1] === 'view' && args.includes('labels')) return JSON.stringify({ labels: pr === 11 ? [{ name: 'elanous:seat-TC' }] : [] });
    if (args[1] === 'view') return JSON.stringify({ body: bodyFor(`request ${pr}`) });
    return '';
  };
  const row = (pr: number) => ({ pr, category: 'review-budget' as const, headRefName: 'self-impl/x', isDraft: true } as never);
  const enqueued: { seat: string; say: string }[] = [];
  const enqueue = async (input: { seat: string; say: string }) => {
    enqueued.push(input);
    return { id: `hq-repair-${enqueued.length}` };
  };
  const live = { repair: 'live' as const, repairPerDay: 2 };
  try {
    await recordRepairShadows([row(10), row(11), row(12), row(30)], {
      runGh, root, now: new Date('2026-10-05T06:00:00Z'), enqueue,
      config: { harness: { helper: live } } as never,
    });
    const lines = readFileSync(join(root, 'helper', 'repairs.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.pr, line.mode, line.result, line.queueId, line.reason])).toEqual([
      [10, 'live', 'launched', 'hq-repair-1', undefined],
      [11, 'live', 'launched', 'hq-repair-2', undefined],
      [12, 'live', 'cap', undefined, '상한'],
      [30, 'live', 'needs-human', undefined, '사람 승인 필요'],
    ]);
    expect(enqueued.map((item) => item.seat)).toEqual(['MK', 'TC']);
    expect(enqueued).toHaveLength(2);
    const labelled = calls.filter((args) => args[1] === 'edit' || args[1] === 'comment').map((args) => [args[1], args[2], args.at(-1)]);
    expect(labelled).toEqual([
      ['edit', '10', 'elanous:superseded'],
      ['comment', '10', '수리 대기열 항목 hq-repair-1 로 대체(런은 대기열 틱에서 시작)'],
      ['edit', '11', 'elanous:superseded'],
      ['comment', '11', '수리 대기열 항목 hq-repair-2 로 대체(런은 대기열 틱에서 시작)'],
    ]);
    expect(calls.some((args) => args.includes('30') && (args[1] === 'edit' || args[1] === 'comment'))).toBe(false);

    const shadowRoot = mkdtempSync(join(tmpdir(), 'helper-repair-shadow-'));
    const shadowCalls: string[][] = [];
    try {
      const written = await recordRepairShadows([row(10)], {
        runGh: (args) => { shadowCalls.push([...args]); return JSON.stringify({ body: bodyFor('request 10') }); },
        root: shadowRoot, enqueue, config: { harness: { helper: { repair: 'shadow', repairPerDay: 2 } } } as never,
      });
      expect(written).toHaveLength(1);
      expect(enqueued).toHaveLength(2);
      expect(shadowCalls.every((args) => args[1] === 'view')).toBe(true);
      expect(JSON.parse(readFileSync(join(shadowRoot, 'helper', 'repairs.jsonl'), 'utf8'))).toMatchObject({ mode: 'shadow', result: 'shadow' });
    } finally { rmSync(shadowRoot, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed launch writes the failure reason and never labels or comments the PR', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { recordRepairShadows } = await import('./helper-repair.js');
  const root = mkdtempSync(join(tmpdir(), 'helper-repair-fail-'));
  const calls: string[][] = [];
  const body = '## 요청\nrequest\n\n## 마지막 리뷰 must-fix\n- Keep it.';
  try {
    await recordRepairShadows([{ pr: 7, category: 'review-budget', headRefName: 'self-impl/x', isDraft: true } as never], {
      runGh: (args) => {
        calls.push([...args]);
        if (args[1] === 'view' && args.includes('labels')) return JSON.stringify({ labels: [] });
        if (args[1] === 'view') return JSON.stringify({ body });
        if (args[0] === 'api') return JSON.stringify([{ filename: 'src/x.ts' }]);
        return '';
      },
      root, enqueue: () => { throw new Error('queue down'); },
      config: { harness: { helper: { repair: 'live', repairPerDay: 3 } } } as never,
    });
    const line = JSON.parse(readFileSync(join(root, 'helper', 'repairs.jsonl'), 'utf8'));
    expect(line).toMatchObject({ pr: 7, mode: 'live', result: 'launch-failed' });
    expect(line.reason).toContain('발사 실패');
    expect(line.reason).toContain('queue down');
    expect(calls.some((args) => args[1] === 'edit' || args[1] === 'comment')).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ACP must-fix: a label failure after enqueue stays launched (no second enqueue); shadow then live launches; a cap retries the next day', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { recordRepairShadows } = await import('./helper-repair.js');
  const body = '## 요청\nrequest\n\n## 마지막 리뷰 must-fix\n- Keep it.';
  const row = (pr: number) => ({ pr, category: 'review-budget' as const, headRefName: 'self-impl/x', isDraft: true } as never);
  const gh = (failEdit: boolean) => (args: readonly string[]) => {
    if (args[1] === 'view' && args.includes('labels')) return JSON.stringify({ labels: [] });
    if (args[1] === 'view') return JSON.stringify({ body });
    if (args[0] === 'api') return JSON.stringify([{ filename: 'src/x.ts' }]);
    if (failEdit && args[1] === 'edit') throw new Error('label api down');
    return '';
  };
  const lines = (root: string) => readFileSync(join(root, 'helper', 'repairs.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const live = (perDay: number) => ({ harness: { helper: { repair: 'live', repairPerDay: perDay } } }) as never;

  const a = mkdtempSync(join(tmpdir(), 'helper-repair-mf-a-'));
  let enqueued = 0;
  const enqueue = async () => ({ id: `hq-${++enqueued}` });
  try {
    await recordRepairShadows([row(1)], { runGh: gh(true), root: a, enqueue, config: live(3), now: new Date('2026-10-05T06:00:00Z') });
    await recordRepairShadows([row(1)], { runGh: gh(false), root: a, enqueue, config: live(3), now: new Date('2026-10-05T07:00:00Z') });
    expect(enqueued).toBe(1);
    expect(lines(a)[0]).toMatchObject({ pr: 1, result: 'launched', queueId: 'hq-1' });
    expect(lines(a)[0].reason).toContain('label api down');
    // The second (live) scan repairs the failed label without a second enqueue.
    expect(lines(a).at(-1)).toMatchObject({ pr: 1, result: 'launched', queueId: 'hq-1', reason: '후속 복구' });
  } finally { rmSync(a, { recursive: true, force: true }); }

  const legacy = mkdtempSync(join(tmpdir(), 'helper-repair-mf-legacy-'));
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(legacy, 'helper'), { recursive: true });
    writeFileSync(join(legacy, 'helper', 'repairs.jsonl'), JSON.stringify({ pr: 4, category: 'review-budget', goalHash: 'x', at: '2026-10-04T00:00:00Z', mode: 'shadow', goal: 'g' }) + '\n');
    const written = await recordRepairShadows([row(4)], { runGh: gh(false), root: legacy, enqueue, config: { harness: { helper: { repair: 'shadow' } } } as never });
    expect(written).toHaveLength(0);
  } finally { rmSync(legacy, { recursive: true, force: true }); }

  const b = mkdtempSync(join(tmpdir(), 'helper-repair-mf-b-'));
  enqueued = 0;
  try {
    await recordRepairShadows([row(2)], { runGh: gh(false), root: b, enqueue, config: { harness: { helper: { repair: 'shadow' } } } as never });
    await recordRepairShadows([row(2)], { runGh: gh(false), root: b, enqueue, config: live(3) });
    expect(lines(b).map((line) => line.result)).toEqual(['shadow', 'launched']);
  } finally { rmSync(b, { recursive: true, force: true }); }

  const c = mkdtempSync(join(tmpdir(), 'helper-repair-mf-c-'));
  enqueued = 0;
  try {
    await recordRepairShadows([row(3)], { runGh: gh(false), root: c, enqueue, config: live(0), now: new Date('2026-10-05T06:00:00Z') });
    await recordRepairShadows([row(3)], { runGh: gh(false), root: c, enqueue, config: live(0), now: new Date('2026-10-05T09:00:00Z') });
    await recordRepairShadows([row(3)], { runGh: gh(false), root: c, enqueue, config: live(3), now: new Date('2026-10-06T06:00:00Z') });
    expect(lines(c).map((line) => [line.result, line.at.slice(0, 10)])).toEqual([['cap', '2026-10-05'], ['launched', '2026-10-06']]);
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test('ACP must-fix: an unreadable PR file list holds for the day and is retried the next day, never a permanent needs-human', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { recordRepairShadows } = await import('./helper-repair.js');
  const root = mkdtempSync(join(tmpdir(), 'helper-repair-files-'));
  const body = '## 요청\nrequest\n\n## 마지막 리뷰 must-fix\n- Keep it.';
  const gh = (filesDown: boolean) => (args: readonly string[]) => {
    if (args[1] === 'view' && args.includes('labels')) return JSON.stringify({ labels: [] });
    if (args[1] === 'view') return JSON.stringify({ body });
    if (args[0] === 'api') { if (filesDown) throw new Error('502'); return JSON.stringify([{ filename: 'src/x.ts' }]); }
    return '';
  };
  const row = { pr: 9, category: 'review-budget', headRefName: 'self-impl/x', isDraft: true } as never;
  const config = { harness: { helper: { repair: 'live', repairPerDay: 3 } } } as never;
  let n = 0;
  const enqueue = async () => ({ id: `hq-${++n}` });
  try {
    await recordRepairShadows([row], { runGh: gh(true), root, enqueue, config, now: new Date('2026-10-05T06:00:00Z') });
    await recordRepairShadows([row], { runGh: gh(false), root, enqueue, config, now: new Date('2026-10-06T06:00:00Z') });
    const lines = readFileSync(join(root, 'helper', 'repairs.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.result)).toEqual(['launch-failed', 'launched']);
    expect(lines[0].reason).toContain('변경 파일 조회 실패');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
