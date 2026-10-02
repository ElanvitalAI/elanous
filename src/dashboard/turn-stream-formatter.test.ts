import { describe, expect, test } from 'bun:test';

import type { FoldMode } from '../log-entry.js';
import {
  createTurnStreamFormatter,
  type TurnStreamCall,
  type TurnStreamFormatterDeps,
} from './turn-stream-formatter.js';
import { createDashboardTurnStreamRuntime } from './turn-stream-runtime.js';
import type { TurnStreamPresentationEvent } from './turn-stream-presentation-applier.js';

type Branch = 'pty' | 'rendered' | 'generic';

function makeFormatter(
  branch: Branch,
  extra: Partial<TurnStreamFormatterDeps> = {},
): {
  formatter: ReturnType<typeof createTurnStreamFormatter>;
  events: TurnStreamPresentationEvent[];
  labels: string[];
} {
  const events: TurnStreamPresentationEvent[] = [];
  const labels: string[] = [];
  const formatter = createTurnStreamFormatter({
    emit: (event) => { events.push(event); },
    thinking: {
      update: (label) => { labels.push(label); },
      updateMetrics: () => {},
    },
    termCols: () => 80,
    wrapOpts: {},
    formatResponse: (text) => text ? [text] : [],
    text: (line) => line,
    muted: (line) => `mut:${line}`,
    ptyCallLine: (name) => branch === 'pty' ? `PTY:${name}` : null,
    ptyResultLine: () => null,
    renderToolCallEvent: (call) => branch === 'rendered' ? [`rendered:${call.name}`] : null,
    renderToolResultVariants: () => null,
    toolRendering: {},
    brainIcon: '[B]',
    ...extra,
  });
  return { formatter, events, labels };
}

function call(id: string, name: string): TurnStreamCall {
  return { id, name, args: {} };
}

describe('createTurnStreamFormatter activity labels', () => {
  test('shows each tool name and increments the per-formatter count', () => {
    const { formatter, labels } = makeFormatter('generic');

    formatter.onToolCall(call('first', 'FirstTool'));
    formatter.onToolCall(call('second', 'SecondTool'));

    expect(labels).toEqual([
      'Streaming FirstTool (1 tool)',
      'Streaming SecondTool (2 tools)',
    ]);
    expect(labels[0]).toContain('FirstTool');
    expect(labels[1]).toContain('SecondTool');
    expect(labels[0]).toContain('1 tool');
    expect(labels[1]).toContain('2 tools');
  });

  test('updates the label before each pty, rendered, and generic presentation branch', () => {
    const observed = (['pty', 'rendered', 'generic'] as const).map((branch) => {
      const { formatter, events, labels } = makeFormatter(branch);
      const name = `${branch}Tool`;
      formatter.onToolCall(call(branch, name));
      return { branch, events, labels, name };
    });

    expect(observed).toHaveLength(3);
    for (const { events, labels, name } of observed) {
      expect(labels).toEqual([`Streaming ${name} (1 tool)`]);
      expect(events).toHaveLength(1);
    }
    expect(observed.map(({ events }) => events[0]?.type)).toEqual([
      'tool.appendLine',
      'tool.appendBlock',
      'tool.appendBlock',
    ]);
    expect(observed[0]?.events[0]).toEqual({
      type: 'tool.appendLine',
      callId: 'pty',
      line: 'PTY:ptyTool',
    });
    expect(observed[1]?.events[0]).toEqual({
      type: 'tool.appendBlock',
      callId: 'rendered',
      lines: ['rendered:renderedTool'],
      args: {},
    });
    expect(observed[2]?.events[0]).toEqual({
      type: 'tool.appendBlock',
      callId: 'generic',
      lines: ['mut:[B] tool: genericTool — running'],
      args: {},
    });
  });

  test('text-only streaming continues to use the Streaming label', () => {
    const { formatter, labels } = makeFormatter('generic');

    formatter.onText('first', 'first');
    formatter.onText(' second', 'first second');

    expect(labels).toEqual(['Streaming', 'Streaming']);
  });
});

describe('createTurnStreamFormatter foldMode forwarding', () => {
  const toolRendering = {
    displayMode: 'inline-to-block' as const,
    blockMaxLines: 8,
  };

  test('omitted foldMode leaves collapsed tool-render config identity and default line behavior', () => {
    const captured: unknown[] = [];
    const { formatter } = makeFormatter('rendered', {
      toolRendering,
      renderToolResultVariants: (_call, rendering) => {
        captured.push(rendering);
        return { collapsed: ['c'], expanded: ['e'] };
      },
    });

    formatter.onToolCall(call('id', 'Bash'));
    formatter.onToolResult({ ...call('id', 'Bash'), result: 'ok' });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(toolRendering);
    expect((captured[0] as { foldMode?: FoldMode }).foldMode).toBeUndefined();
    expect((captured[0] as { blockMaxLines: number }).blockMaxLines).toBe(8);
  });

  test('task-unit foldMode is merged into collapsed tool-render config without changing blockMaxLines', () => {
    const captured: unknown[] = [];
    const { formatter } = makeFormatter('rendered', {
      toolRendering,
      foldMode: 'task-unit',
      renderToolResultVariants: (_call, rendering) => {
        captured.push(rendering);
        return { collapsed: ['c'], expanded: ['e'] };
      },
    });

    formatter.onToolCall(call('id', 'Bash'));
    formatter.onToolResult({ ...call('id', 'Bash'), result: 'ok' });

    expect(captured[0]).toEqual({ ...toolRendering, foldMode: 'task-unit' });
    expect((captured[0] as { blockMaxLines: number }).blockMaxLines).toBe(8);
  });

  test('generic expanded render still uses the finite blockMaxLines path when foldMode is set', () => {
    const { formatter, events } = makeFormatter('generic', {
      toolRendering: { blockMaxLines: 4 },
      foldMode: 'task-unit',
    });
    formatter.onToolCall(call('generic', 'UnknownTool'));
    formatter.onToolResult({
      ...call('generic', 'UnknownTool'),
      result: Array.from({ length: 20 }, (_, index) => index),
    });
    const replacement = events[1] as Extract<TurnStreamPresentationEvent, { type: 'tool.replaceBlock' }>;
    // Expanded generic path is renderToolBlock(model, blockMaxLines) — mode-independent.
    expect(replacement.expandedLines).toHaveLength(5);
    expect(replacement.expandedLines?.join('\n')).toContain('22 more lines folded');
  });

  test('kind-unit append/replace events carry operationKind; line and task-unit omit it', () => {
    const kindUnit = makeFormatter('generic', { foldMode: 'kind-unit' });
    kindUnit.formatter.onToolCall(call('r1', 'Read'));
    kindUnit.formatter.onToolResult({ ...call('r1', 'Read'), result: 'ok' });
    const kindAppend = kindUnit.events.find((event) => event.type === 'tool.appendBlock');
    const kindReplace = kindUnit.events.find((event) => event.type === 'tool.replaceBlock');
    expect(kindAppend).toMatchObject({ type: 'tool.appendBlock', operationKind: 'Read' });
    expect(kindReplace).toMatchObject({ type: 'tool.replaceBlock', operationKind: 'Read' });

    const line = makeFormatter('generic', { foldMode: 'line' });
    line.formatter.onToolCall(call('r2', 'Read'));
    line.formatter.onToolResult({ ...call('r2', 'Read'), result: 'ok' });
    expect(line.events.find((event) => event.type === 'tool.appendBlock')).not.toHaveProperty('operationKind');
    expect(line.events.find((event) => event.type === 'tool.replaceBlock')).not.toHaveProperty('operationKind');

    const task = makeFormatter('generic', { foldMode: 'task-unit' });
    task.formatter.onToolCall(call('r3', 'Read'));
    task.formatter.onToolResult({ ...call('r3', 'Read'), result: 'ok' });
    expect(task.events.find((event) => event.type === 'tool.appendBlock')).not.toHaveProperty('operationKind');
    expect(task.events.find((event) => event.type === 'tool.replaceBlock')).not.toHaveProperty('operationKind');
  });
});

describe('createDashboardTurnStreamRuntime foldMode forwarding', () => {
  function makeRuntime(foldMode?: FoldMode): { captured: unknown[] } {
    const captured: unknown[] = [];
    const runtime = createDashboardTurnStreamRuntime({
      initialAssistantStart: 0,
      chatLines: [],
      thinking: { update: () => {}, updateMetrics: () => {} },
      draw: () => {},
      pinChatTail: () => {},
      termCols: () => 80,
      wrapOpts: {},
      formatResponse: (full) => [full],
      text: (line) => line,
      muted: (text) => text,
      ptyCallLine: () => null,
      ptyResultLine: () => null,
      renderToolCallEvent: () => ['call'],
      renderToolResultVariants: (_call, rendering) => {
        captured.push(rendering);
        return { collapsed: ['c'], expanded: ['e'] };
      },
      toolRendering: { blockMaxLines: 8 },
      ...(foldMode !== undefined ? { foldMode } : {}),
      renderedToolRuntime: {
        setArgs: () => {},
        getArgs: () => undefined,
        deleteArgs: () => {},
        replaceBlock: () => 0,
        registerFold: () => {},
      },
      brainIcon: '[B]',
    });
    runtime.onToolCall(call('id', 'Bash'));
    runtime.onToolResult({ ...call('id', 'Bash'), result: 'ok' });
    return { captured };
  }

  test('production caller forwards foldMode into collapsed tool-render config', () => {
    const { captured } = makeRuntime('task-unit');
    expect(captured[0]).toEqual({ blockMaxLines: 8, foldMode: 'task-unit' });
  });

  test('production caller omits foldMode so collapsed config stays the original toolRendering', () => {
    const { captured } = makeRuntime();
    expect(captured[0]).toEqual({ blockMaxLines: 8 });
    expect((captured[0] as { foldMode?: FoldMode }).foldMode).toBeUndefined();
  });

  test('kind-unit is forwarded into collapsed tool-render config without changing the default omit path', () => {
    const { captured } = makeRuntime('kind-unit');
    expect(captured[0]).toEqual({ blockMaxLines: 8, foldMode: 'kind-unit' });
  });
});
