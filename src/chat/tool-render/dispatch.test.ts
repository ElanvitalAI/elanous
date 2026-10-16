import { describe, expect, test } from 'bun:test';

import { renderToolResultVariants } from './dispatch.js';
import type { ToolRenderConfig } from './types.js';

const baseConfig: ToolRenderConfig = {
  displayMode: 'inline-to-block',
  blockMaxLines: 4,
};

const readCall = {
  id: 'read-1',
  name: 'Read',
  args: { file_path: '/tmp/a.ts' },
  result: { output: 'line 1\nline 2\nline 3\nline 4\nline 5' },
};

describe('renderToolResultVariants kind-unit grouping', () => {
  test('kind-unit attaches the classified operation kind', () => {
    const variants = renderToolResultVariants(readCall, { ...baseConfig, foldMode: 'kind-unit' });
    expect(variants?.operationKind).toBe('Read');
  });

  test('unknown tools fall back to the tool name only in kind-unit', () => {
    const variants = renderToolResultVariants({
      id: 'custom-1',
      name: 'CustomProbe',
      args: { q: 1 },
      result: { output: 'ok' },
    }, { ...baseConfig, foldMode: 'kind-unit' });
    expect(variants).toBeNull();
  });

  test('line and task-unit omit operationKind and keep identical collapsed text', () => {
    const line = renderToolResultVariants(readCall, { ...baseConfig, foldMode: 'line' });
    const task = renderToolResultVariants(readCall, { ...baseConfig, foldMode: 'task-unit' });
    const unspecified = renderToolResultVariants(readCall, baseConfig);

    expect(line?.operationKind).toBeUndefined();
    expect(task?.operationKind).toBeUndefined();
    expect(unspecified?.operationKind).toBeUndefined();
    expect(line?.collapsed).toEqual(unspecified?.collapsed);
    expect(line?.collapsed.join('\n')).not.toEqual(task?.collapsed.join('\n'));
  });
});

describe('phase rejection label (#67)', () => {
  const render = (output: string) => renderToolResultVariants(
    { id: 'b', name: 'Bash', args: { command: 'x' }, result: { output } },
    baseConfig,
  )?.collapsed?.join('\n') ?? '';

  test('a phase guard reads as «tool call rejected — <reason>», not a budget', () => {
    const text = render('TOOL CALL REJECTED — Bash did NOT run. Nothing they would have changed has changed.  VERIFY ACTION REQUIRED — edits already happened. Stop …');
    expect(text).toContain('tool call rejected — verify action required');
    expect(text).not.toContain('budget');
  });

  test('the real turn-budget stub keeps the budget label', () => {
    const text = render('TOOL CALL REJECTED — tool-loop budget exhausted at 30/30 turns. Your next assistant turn must be plain text final synthesis');
    expect(text).toContain('tool budget exhausted — final answer required');
  });
});
