import { describe, expect, test } from 'bun:test';

import { foldKindHint, type FoldMode } from '../log-entry.js';
import { FoldStack } from '../fold-stack.js';
import { createDashboardRenderedToolRuntime } from './rendered-tool-runtime.js';
import {
  BOOKKEEPING_KIND,
  createTurnStreamFormatter,
  isBookkeepingTool,
  type TurnStreamCall,
  type TurnStreamFormatterDeps,
} from './turn-stream-formatter.js';
import { createDashboardTurnStreamRuntime } from './turn-stream-runtime.js';
import { join } from 'node:path';
import { toolResultsRoot } from '../tool-runtime/truncation-store.js';
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

describe('no-synthesis authoritative replacement', () => {
  const finalText = '사람 줄\n\n[NO FINAL SYNTHESIS] The model used …\n\nExplored: a, b';

  test('emits a committed lead and one folded tool block with the marker only in its expanded lines', () => {
    const { formatter, events } = makeFormatter('generic', {
      formatResponse: (full) => full.split('\n'),
    });
    formatter.onText('', finalText);

    expect(events.map((event) => event.type)).toEqual([
      'assistant.replaceBlock', 'assistant.commit', 'tool.appendBlock', 'tool.replaceBlock',
    ]);
    const lead = events[0] as Extract<TurnStreamPresentationEvent, { type: 'assistant.replaceBlock' }>;
    const append = events[2] as Extract<TurnStreamPresentationEvent, { type: 'tool.appendBlock' }>;
    const replacement = events[3] as Extract<TurnStreamPresentationEvent, { type: 'tool.replaceBlock' }>;
    expect(lead.lines).toEqual(['사람 줄']);
    expect(lead.lines.join('\n')).not.toContain('[NO FINAL SYNTHESIS]');
    expect(append.callId).toBe('no-synthesis-tail-1');
    expect(append.args).toEqual({});
    expect(append.lines).toEqual(replacement.collapsedLines);
    expect(replacement.collapsedLines).toHaveLength(1);
    expect(replacement.collapsedLines[0]).toMatch(/^● /);
    expect(replacement.expandedLines).toHaveLength(3);
    expect(replacement.collapsedLines[0]).toContain('3');
    expect(replacement.expandedLines?.join('\n')).toContain('[NO FINAL SYNTHESIS]');
  });

  test('streaming and marker-free authoritative replacement retain their event sequences', () => {
    const { formatter, events } = makeFormatter('generic');
    formatter.onText('부분', '부분');
    formatter.onText('', '그냥 답');
    expect(events).toEqual([
      { type: 'assistant.replaceBlock', lines: ['부분'] },
      { type: 'assistant.replaceBlock', lines: ['그냥 답'] },
    ]);
  });

  test('real rendered tool runtime and FoldStack expand and recollapse the hidden marker', () => {
    const chatLines: string[] = [];
    const foldStack = new FoldStack({ chatLines });
    const renderedToolRuntime = createDashboardRenderedToolRuntime({
      chatLines, foldStack, draw: () => {}, pinChatTail: () => {},
    });
    const runtime = createDashboardTurnStreamRuntime({
      initialAssistantStart: 0,
      chatLines,
      thinking: { update: () => {}, updateMetrics: () => {} },
      draw: () => {},
      pinChatTail: () => {},
      termCols: () => 80,
      wrapOpts: {},
      formatResponse: (full) => full.split('\n'),
      text: (line) => line,
      muted: (line) => line,
      ptyCallLine: () => null,
      ptyResultLine: () => null,
      renderToolCallEvent: () => null,
      renderToolResultVariants: () => null,
      toolRendering: {},
      renderedToolRuntime,
      brainIcon: '[B]',
    });

    runtime.onText('', finalText);
    expect(chatLines[0]).toBe('사람 줄');
    expect(chatLines[1]).toMatch(/^● /);
    expect(chatLines.join('\n')).not.toContain('[NO FINAL SYNTHESIS]');
    expect(foldStack.size()).toBe(1);
    expect(foldStack.toggleTop()).toBe(true);
    expect(chatLines.join('\n')).toContain('[NO FINAL SYNTHESIS]');
    expect(foldStack.toggleTop()).toBe(true);
    expect(chatLines.join('\n')).not.toContain('[NO FINAL SYNTHESIS]');
    expect(chatLines[1]).toMatch(/^● /);
    expect(foldStack.toggleAtLine(1)).toBe(true);
    expect(chatLines.join('\n')).toContain('[NO FINAL SYNTHESIS]');
  });
});

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

  test('kind-unit and task-unit RunShell carry grouping kind; other task-unit tools do not', () => {
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

    task.formatter.onToolCall(call('s1', 'RunShell'));
    task.formatter.onToolResult({ ...call('s1', 'RunShell'), result: 'ok' });
    expect(task.events.find((event) => event.type === 'tool.appendBlock' && event.callId === 's1')).toMatchObject({ operationKind: 'RunShell' });
    expect(task.events.find((event) => event.type === 'tool.replaceBlock' && event.callId === 's1')).toMatchObject({ operationKind: 'RunShell' });
  });

  test('task-unit combines adjacent RunShell results and expands both details', () => {
    const chatLines: string[] = [];
    const foldStack = new FoldStack({ chatLines });
    const renderedToolRuntime = createDashboardRenderedToolRuntime({
      chatLines, foldStack, draw: () => {}, pinChatTail: () => {},
    });
    const runtime = createDashboardTurnStreamRuntime({
      initialAssistantStart: 0,
      chatLines,
      thinking: { update: () => {}, updateMetrics: () => {} },
      draw: () => {}, pinChatTail: () => {}, termCols: () => 80, wrapOpts: {},
      formatResponse: (full) => full.split('\n'), text: (line) => line, muted: (line) => line,
      ptyCallLine: () => null, ptyResultLine: () => null,
      renderToolCallEvent: (item) => [`running ${item.id}`],
      renderToolResultVariants: (item) => ({
        collapsed: [`${item.name} ${item.id}`],
        expanded: [`${item.name} ${item.id}`, `detail ${item.id}`],
      }),
      toolRendering: {}, foldMode: 'task-unit', renderedToolRuntime, brainIcon: '[B]',
    });
    for (const id of ['s1', 's2']) {
      runtime.onToolCall(call(id, 'RunShell'));
      runtime.onToolResult({ ...call(id, 'RunShell'), result: 'ok' });
    }
    expect(chatLines).toEqual([foldKindHint('RunShell', 2)]);
    expect(foldStack.toggleAtLine(0)).toBe(true);
    expect(chatLines.join('\n')).toContain('detail s1');
    expect(chatLines.join('\n')).toContain('detail s2');
    expect(foldStack.toggleAtLine(0)).toBe(true);
    runtime.onToolCall(call('r1', 'Read'));
    runtime.onToolResult({ ...call('r1', 'Read'), result: 'ok' });
    runtime.onToolCall(call('s3', 'RunShell'));
    runtime.onToolResult({ ...call('s3', 'RunShell'), result: 'ok' });
    expect(chatLines).toEqual([foldKindHint('RunShell', 2), 'Read r1', 'RunShell s3']);
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

describe('TUI-TURN-NARRATION — 추론 요약 💭 줄', () => {
  test('생각 문단은 흐린 💭 한 줄로 붙고 공백은 한 칸으로 접힌다', () => {
    const { formatter, events } = makeFormatter('generic');
    formatter.onThought!('**파일 목록을\n  확인합니다**');
    expect(events).toEqual([
      { type: 'tool.appendLine', callId: 'thought-1', line: 'mut:💭 **파일 목록을 확인합니다**' },
    ]);
  });

  test('빈 생각은 줄을 만들지 않는다 · 줄마다 다른 callId', () => {
    const { formatter, events } = makeFormatter('generic');
    formatter.onThought!('   ');
    formatter.onThought!('a');
    formatter.onThought!('b');
    expect(events.map((e) => (e as { callId?: string }).callId)).toEqual(['thought-1', 'thought-2']);
  });
});

describe('TUI-TURN-NARRATION 조각 3 — 잡무 도구는 «내부» 로 묶는다', () => {
  const kindOf = (f: ReturnType<typeof makeFormatter>, name: string, args: Record<string, unknown>) => {
    f.formatter.onToolCall({ id: `${name}-1`, name, args });
    return (f.events.at(-1) as { operationKind?: string }).operationKind;
  };

  test('task-unit 에서 MsgList·MsgAck·ScheduleWakeup·넘침 파일 Read 는 «내부»', () => {
    for (const [name, args] of [
      ['MsgList', {}], ['MsgAck', {}], ['ScheduleWakeup', {}],
      ['Read', { file_path: join(toolResultsRoot(), '67142', 'Read-2026.txt') }],
    ] as const) {
      expect(kindOf(makeFormatter('rendered', { foldMode: 'task-unit' }), name, args)).toBe(BOOKKEEPING_KIND);
    }
  });

  test('보통 Read·MsgPost 는 묶지 않고 · line 모드는 기존대로 아무것도 안 묶는다', () => {
    expect(kindOf(makeFormatter('rendered', { foldMode: 'task-unit' }), 'Read', { file_path: 'src/a.ts' })).toBeUndefined();
    expect(kindOf(makeFormatter('rendered', { foldMode: 'task-unit' }), 'MsgPost', {})).toBeUndefined();
    expect(kindOf(makeFormatter('rendered', { foldMode: 'line' }), 'MsgList', {})).toBeUndefined();
    expect(kindOf(makeFormatter('rendered'), 'MsgList', {})).toBeUndefined();
  });

  test('결과 단계도 «내부» 를 지킨다 — task-unit 의 RunShell 덮어쓰기에 섞이지 않는다', () => {
    // generic 분기 — 렌더러가 없는 도구가 결과 단계(tool.replaceBlock)를 실제로 탄다.
    const f = makeFormatter('generic', { foldMode: 'task-unit' });
    f.formatter.onToolCall({ id: 'm1', name: 'MsgList', args: {} });
    f.formatter.onToolResult({ id: 'm1', name: 'MsgList', args: {}, result: 'ok' });
    const replace = f.events.find((e) => e.type === 'tool.replaceBlock') as { operationKind?: string };
    expect(replace.operationKind).toBe(BOOKKEEPING_KIND);
  });

  test('isBookkeepingTool — path 인자 이름 둘 다 · 실제 넘침 뿌리 아래만 (FU-5)', () => {
    const root = '/h/.elanous/tool-results';
    expect(isBookkeepingTool('Read', { path: '/h/.elanous/tool-results/1/x.txt' }, root)).toBe(true);
    expect(isBookkeepingTool('Read', { file_path: '/h/.elanous/tool-results/1/x.txt' }, root)).toBe(true);
    // 같은 이름 조각이 다른 뿌리에 있으면 접지 않는다.
    expect(isBookkeepingTool('Read', { path: '/repo/fixtures/.elanous/tool-results/1/x.txt' }, root)).toBe(false);
    expect(isBookkeepingTool('Read', { path: '/h/.elanous/tool-results-old/x.txt' }, root)).toBe(false);
    expect(isBookkeepingTool('Read', {}, root)).toBe(false);
    expect(isBookkeepingTool('Grep', { path: '/h/.elanous/tool-results/1/x.txt' }, root)).toBe(false);
  });
});
