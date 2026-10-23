import { describe, expect, spyOn, test } from 'bun:test';

import { debug } from '../../debug/log.js';
import { foldHint } from '../../log-entry.js';
import {
  DEFAULT_LONG_SLEEP_WARN_SECONDS,
  detectLongSleep,
  formatLongSleepWarning,
} from '../../skills/tools/shell.js';
import { renderToolBlock, toolBlockGrouping } from './block.js';
import { renderToolResultVariants } from './dispatch.js';
import type { ToolRenderConfig, ToolRenderModel, ToolRenderResult } from './types.js';

const model: ToolRenderModel = {
  kind: 'Read',
  status: 'success',
  summary: 'Read a.ts',
  collapsedSummary: '5 lines',
  bodyLines: ['1', '2', '3', '4', '5'],
  operationKind: 'Read',
};

describe('renderToolBlock fold modes', () => {
  test('line and unspecified stay on the line-budget path', () => {
    const line = renderToolBlock(model, 4, 'line');
    const unspecified = renderToolBlock(model, 4);
    expect(line).toEqual(unspecified);
    expect(line.join('\n')).toContain(foldHint('line', 2));
  });

  test('task-unit still collapses a multi-line body to one hint', () => {
    const task = renderToolBlock(model, 4, 'task-unit');
    expect(task.join('\n')).toContain(foldHint('line', 5));
    expect(task).not.toEqual(renderToolBlock(model, 4, 'line'));
  });

  test('kind-unit grouping is omitted unless foldMode is kind-unit', () => {
    expect(toolBlockGrouping(model, 'line')).toEqual({});
    expect(toolBlockGrouping(model, 'task-unit')).toEqual({});
    expect(toolBlockGrouping(model, 'kind-unit')).toEqual({ operationKind: 'Read' });
    expect(toolBlockGrouping({ ...model, operationKind: undefined }, 'kind-unit')).toEqual({});
  });

  test('five body lines at budget three: kind-unit reuses task-unit folding', () => {
    const line = renderToolBlock(model, 3, 'line');
    const task = renderToolBlock(model, 3, 'task-unit');
    const kind = renderToolBlock(model, 3, 'kind-unit');

    expect(line).toHaveLength(4);
    expect(line.join('\n')).toContain('1');
    expect(line.join('\n')).toContain('2');
    expect(line.join('\n')).toContain(foldHint('line', 3));

    expect(task).toHaveLength(2);
    expect(task.join('\n')).toContain(foldHint('line', 5));
    const taskBody = task.slice(1).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(taskBody.some((row) => /(^|\s)[12]$/.test(row.trim()))).toBe(false);
    expect(task).not.toEqual(line);

    expect(kind).toEqual(task);
    expect(kind).not.toEqual(line);
    expect(kind).toHaveLength(2);
    expect(kind.join('\n')).toContain(foldHint('line', 5));

    expect(toolBlockGrouping(model, 'kind-unit')).toEqual({ operationKind: 'Read' });
  });

  test('records fold-applied when task-unit or kind-unit folding is applied', () => {
    const applied: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'log.fold' && event === 'fold-applied') {
        applied.push({ ...data });
      }
    }) as typeof debug.log);

    try {
      renderToolBlock(model, 4, 'task-unit');
      expect(applied).toEqual([{
        mode: 'task-unit',
        preFoldLineCount: 5,
        postFoldLineCount: 1,
      }]);

      applied.length = 0;
      renderToolBlock(model, 4, 'kind-unit');
      expect(applied).toEqual([{
        mode: 'kind-unit',
        preFoldLineCount: 5,
        postFoldLineCount: 1,
      }]);

      applied.length = 0;
      renderToolBlock({ ...model, bodyLines: ['only line'] }, 4, 'task-unit');
      expect(applied).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  test('records fold-applied on the budget-mode default return path', () => {
    const applied: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'log.fold' && event === 'fold-applied') {
        applied.push({ ...data });
      }
    }) as typeof debug.log);

    try {
      renderToolBlock(model, 4, 'line');
      expect(applied).toEqual([{
        mode: 'line',
        preFoldLineCount: 5,
        postFoldLineCount: 4,
      }]);
    } finally {
      log.mockRestore();
    }
  });

  test('records fold-applied on the budget-mode persisted-ref return path', () => {
    const applied: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'log.fold' && event === 'fold-applied') {
        applied.push({ ...data });
      }
    }) as typeof debug.log);

    try {
      renderToolBlock({
        ...model,
        bodyLines: ['1', '2', '3', '4', '5', '... Full output saved to /tmp/out'],
      }, 4, 'line');
      expect(applied).toEqual([{
        mode: 'line',
        preFoldLineCount: 6,
        postFoldLineCount: 4,
      }]);
    } finally {
      log.mockRestore();
    }
  });

  test('does not record fold-applied when budget-mode input is too short to fold', () => {
    const applied: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'log.fold' && event === 'fold-applied') {
        applied.push({ ...data });
      }
    }) as typeof debug.log);

    try {
      renderToolBlock({ ...model, bodyLines: ['1', '2'] }, 4, 'line');
      expect(applied).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});

const strip = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, '');

// ❗ 실물: 생산 경로가 만드는 RunShell long-sleep 경고 한 줄(`detectLongSleep` 판정 →
// `formatLongSleepWarning` 문면)을 손으로 적지 않고 그대로 되살린다. filler 는
// `sleep 70` 이 돌려준 출력(yield 줄)을 대신한다.
const LONG_SLEEP_WARNING = formatLongSleepWarning(
  detectLongSleep(['sleep', '70'], DEFAULT_LONG_SLEEP_WARN_SECONDS)!,
  false,
  'generic',
);
const filler = Array.from({ length: 14 }, (_, index) => `tick ${index + 1}`);
const runShellCall: ToolRenderResult = {
  id: 'call-sleep-70',
  name: 'RunShell',
  args: { command: 'sleep 70' },
  result: { command: 'sleep 70', exitCode: 0, output: [LONG_SLEEP_WARNING, ...filler].join('\n') },
};

const BLOCK_PREFIX = /^(?: {2}⎿ {2}| {5})/;

/** 헤더를 떼고 toolResult 프리픽스까지 벗긴 본문 줄. */
function bodyText(rows: string[]): string[] {
  return rows.slice(1).map((row) => row.replace(BLOCK_PREFIX, ''));
}

function collapsedRows(config: ToolRenderConfig): string[] {
  const variants = renderToolResultVariants(runShellCall, config);
  if (!variants) throw new Error('RunShell must enter the inline-to-block renderer');
  return variants.collapsed.map(strip);
}

describe('renderToolBlock keeps ⚠ warning lines outside the fold', () => {
  test('task-unit fold: sleep 70 long-sleep warning sits above the fold hint', () => {
    const rows = collapsedRows({ displayMode: 'inline-to-block', blockMaxLines: 8, foldMode: 'task-unit' });

    const warningIndex = rows.findIndex((row) => row.includes(LONG_SLEEP_WARNING));
    const hintIndex = rows.findIndex((row) => row.includes(foldHint('line', filler.length)));

    expect(warningIndex).toBe(1);
    expect(hintIndex).toBeGreaterThan(warningIndex);
    expect(rows.join('\n')).not.toContain(foldHint('line', filler.length + 1));
  });

  test('kind-unit fold: sleep 70 long-sleep warning sits above the fold hint', () => {
    const rows = collapsedRows({ displayMode: 'inline-to-block', blockMaxLines: 8, foldMode: 'kind-unit' });

    const warningIndex = rows.findIndex((row) => row.includes(LONG_SLEEP_WARNING));
    const hintIndex = rows.findIndex((row) => row.includes(foldHint('line', filler.length)));

    expect(warningIndex).toBe(1);
    expect(hintIndex).toBeGreaterThan(warningIndex);
  });

  test('line budget: pinned warning is excluded from the folded line count', () => {
    const rows = collapsedRows({ displayMode: 'inline-to-block', blockMaxLines: 8, foldMode: 'line' });

    expect(rows[1]).toContain(LONG_SLEEP_WARNING);
    // 예산 8 = 고정 경고 1 + 본문 6 + 힌트 1 ⇒ 접힌 줄은 filler 14 - 6 = 8.
    expect(rows).toHaveLength(9);
    expect(rows[8]).toContain(foldHint('line', filler.length - 6));
  });

  test('a warning mid-body is hoisted to the top of the block body', () => {
    const rows = renderToolBlock({
      ...model,
      bodyLines: ['alpha', LONG_SLEEP_WARNING, 'beta'],
      collapsedSummary: '3 lines',
    }, 10, 'line').map(strip);

    expect(bodyText(rows)).toEqual([LONG_SLEEP_WARNING, 'alpha', 'beta']);
  });

  test('an all-warning body renders as-is without a fold hint', () => {
    const warnings = [LONG_SLEEP_WARNING, '⚠ second warning', '⚠ third warning'];

    const line = renderToolBlock({ ...model, bodyLines: warnings }, 2, 'line').map(strip);
    const task = renderToolBlock({ ...model, bodyLines: warnings }, 2, 'task-unit').map(strip);

    expect(bodyText(line)).toEqual(warnings);
    expect(bodyText(task)).toEqual(warnings);
    expect(line.join('\n')).not.toContain('more lines folded');
    expect(task.join('\n')).not.toContain('more lines folded');
  });

  test('bodies without warning lines keep the current fold output', () => {
    const full = renderToolBlock(model, Number.POSITIVE_INFINITY, 'line').map(strip);
    const folded = renderToolBlock(model, 4, 'line').map(strip);

    expect(bodyText(folded)).toEqual([...bodyText(full).slice(0, 3), foldHint('line', 2)]);
    expect(bodyText(folded)).toHaveLength(4);
    expect(folded.join('\n')).not.toContain('⚠');
  });
});
