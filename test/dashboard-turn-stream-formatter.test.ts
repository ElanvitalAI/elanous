// Unit tests for the formatter — verifies it emits CORRECT events and
// NEVER mutates chatLines (architectural invariant). Sister tests in
// test/dashboard-turn-stream-presentation-applier.test.ts cover the
// chatLines mutation side.

import { describe, expect, test } from 'bun:test';

import {
  createTurnStreamFormatter,
  type TurnStreamCall,
} from '../src/dashboard/turn-stream-formatter.js';
import { debug } from '../src/debug/log.js';
import {
  renderToolCallEvent,
  renderToolResultVariants,
} from '../src/chat/tool-render/index.js';
import type { TurnStreamPresentationEvent } from '../src/dashboard/turn-stream-presentation-applier.js';

interface FormatterFixtureOpts {
  ptyCallLine?: () => string | null;
  ptyResultLine?: () => string | null;
  renderToolCallEvent?: (call: TurnStreamCall, rendering: unknown) => string[] | null;
  renderToolResultVariants?: (call: TurnStreamCall, rendering: unknown) => { collapsed: string[]; expanded: string[] | null } | null;
  formatResponse?: (full: string) => string[];
  toolRendering?: unknown;
}

function makeFormatter(opts: FormatterFixtureOpts = {}): {
  formatter: ReturnType<typeof createTurnStreamFormatter>;
  events: TurnStreamPresentationEvent[];
  metrics: number[];
} {
  const events: TurnStreamPresentationEvent[] = [];
  const metrics: number[] = [];
  const formatter = createTurnStreamFormatter({
    emit: (event) => { events.push(event); },
    thinking: { update: () => {}, updateMetrics: ({ outputTokens }) => { metrics.push(outputTokens); } },
    termCols: () => 80,
    wrapOpts: {},
    formatResponse: opts.formatResponse ?? ((full) => full.length === 0 ? [] : [full]),
    text: (line) => line,
    muted: (text) => `mut:${text}`,
    ptyCallLine: opts.ptyCallLine ?? (() => null),
    ptyResultLine: opts.ptyResultLine ?? (() => null),
    renderToolCallEvent: opts.renderToolCallEvent ?? (() => null),
    renderToolResultVariants: opts.renderToolResultVariants ?? (() => null),
    toolRendering: opts.toolRendering ?? {},
    brainIcon: '[B]',
  });
  return { formatter, events, metrics };
}

describe('createTurnStreamFormatter — onText 3-path semantic', () => {
  test('streaming delta — emits assistant.replaceBlock with formatted lines', () => {
    const { formatter, events } = makeFormatter();
    formatter.onText('hello', 'hello');
    expect(events).toEqual([{ type: 'assistant.replaceBlock', lines: ['hello'] }]);
    formatter.onText(' world', 'hello world');
    expect(events).toEqual([
      { type: 'assistant.replaceBlock', lines: ['hello'] },
      { type: 'assistant.replaceBlock', lines: ['hello world'] },
    ]);
  });

  test('clear-and-commit (chunk="" + accumulated="") — emits assistant.commit', () => {
    const { formatter, events } = makeFormatter();
    formatter.onText('narration', 'narration');
    formatter.onText('', '');
    expect(events).toEqual([
      { type: 'assistant.replaceBlock', lines: ['narration'] },
      { type: 'assistant.commit' },
    ]);
  });

  test('authoritative replacement (chunk="" + accumulated non-empty) — emits replaceBlock with accumulated', () => {
    const { formatter, events } = makeFormatter();
    formatter.onText('partial', 'partial');
    formatter.onText('', 'FULL synthesis text');
    expect(events).toEqual([
      { type: 'assistant.replaceBlock', lines: ['partial'] },
      { type: 'assistant.replaceBlock', lines: ['FULL synthesis text'] },
    ]);
  });

  test('cross-turn `accumulated` (delta path) is IGNORED — per-round only', () => {
    const { formatter, events } = makeFormatter();
    formatter.onText('turn2', 'turn1+turn2');
    // emit shows ONLY turn2 (the new chunk delta), NOT cross-turn
    // accumulated. This was the PR #1419 fix — verified at unit level.
    expect(events).toEqual([{ type: 'assistant.replaceBlock', lines: ['turn2'] }]);
  });

  test('multiple commit-then-narration cycles — narration2 starts fresh from empty', () => {
    const { formatter, events } = makeFormatter();
    formatter.onText('narration1', 'narration1');
    formatter.onText('', '');                 // commit
    formatter.onText('narration2', 'narration2');
    expect(events.map(e => e.type)).toEqual([
      'assistant.replaceBlock',  // narration1 streaming
      'assistant.commit',
      'assistant.replaceBlock',  // narration2 starts fresh
    ]);
    // The last event has narration2 only.
    expect(events[2]).toEqual({ type: 'assistant.replaceBlock', lines: ['narration2'] });
  });
});

describe('createTurnStreamFormatter — token metrics', () => {
  test('accumulates text across tool call and result boundaries', () => {
    const { formatter, metrics } = makeFormatter();

    formatter.onText('a'.repeat(400), 'a'.repeat(400));
    formatter.onToolCall({ id: 'read', name: 'Read', args: {} });
    formatter.onToolResult({ id: 'read', name: 'Read', args: {}, result: 'ok' });
    formatter.onText('b'.repeat(8), 'a'.repeat(400) + 'b'.repeat(8));

    expect(metrics.at(-1)).toBe(102);
  });

  test('accumulates clear-and-commit text into the next round', () => {
    const { formatter, metrics } = makeFormatter();

    formatter.onText('x'.repeat(40), 'x'.repeat(40));
    formatter.onText('', '');
    formatter.onText('y'.repeat(40), 'x'.repeat(40) + 'y'.repeat(40));

    expect(metrics.at(-1)).toBe(20);
  });

  test('authoritative replacement does not commit the replaced round', () => {
    const { formatter, metrics } = makeFormatter();

    formatter.onText('x'.repeat(40), 'x'.repeat(40));
    formatter.onText('', 'z'.repeat(8));

    expect(metrics.at(-1)).toBe(2);
  });
});

describe('createTurnStreamFormatter — blank-edge trimming (codex spacing fix)', () => {
  // Codex-family models wrap inter-tool narration in blank lines and
  // formatResponse preserves them; committed once per tool round they
  // pile up into wide vertical gaps between tool calls. The formatter
  // must trim leading/trailing blank rows from the DISPLAY block while
  // preserving interior blank lines (paragraph breaks).
  const blankEdgeFormatResponse = (full: string): string[] =>
    full.split('\n').map(l => (l.trim() === '' ? '' : l));

  test('trims leading + trailing blank rows from assistant block', () => {
    const { formatter, events } = makeFormatter({ formatResponse: blankEdgeFormatResponse });
    formatter.onText('\n\nReading the file.\n\n', '\n\nReading the file.\n\n');
    expect(events).toEqual([
      { type: 'assistant.replaceBlock', lines: ['Reading the file.'] },
    ]);
  });

  test('preserves interior blank lines (paragraph breaks)', () => {
    const { formatter, events } = makeFormatter({ formatResponse: blankEdgeFormatResponse });
    formatter.onText('\nFirst para.\n\nSecond para.\n', '\nFirst para.\n\nSecond para.\n');
    expect(events).toEqual([
      { type: 'assistant.replaceBlock', lines: ['First para.', '', 'Second para.'] },
    ]);
  });

  test('all-blank block collapses to empty', () => {
    const { formatter, events } = makeFormatter({ formatResponse: blankEdgeFormatResponse });
    formatter.onText('\n\n\n', '\n\n\n');
    expect(events).toEqual([
      { type: 'assistant.replaceBlock', lines: [] },
    ]);
  });
});

describe('createTurnStreamFormatter — onToolCall', () => {
  test('pty path — emits tool.appendLine with pty line', () => {
    const { formatter, events } = makeFormatter({
      ptyCallLine: () => 'PTY:run',
    });
    const call: TurnStreamCall = { id: 'c1', name: 'pty.run', args: { cmd: 'ls' } };
    formatter.onToolCall(call);
    expect(events).toEqual([
      { type: 'tool.appendLine', callId: 'c1', line: 'PTY:run' },
    ]);
  });

  test('rendered path — emits tool.appendBlock with lines + args', () => {
    const { formatter, events } = makeFormatter({
      renderToolCallEvent: () => ['● tool', '  details'],
    });
    const call: TurnStreamCall = { id: 'c1', name: 'tool', args: { x: 1 } };
    formatter.onToolCall(call);
    expect(events).toEqual([
      {
        type: 'tool.appendBlock',
        callId: 'c1',
        lines: ['● tool', '  details'],
        args: { x: 1 },
      },
    ]);
  });

  test('generic call fallback emits a replaceable block without serializing arguments into its line', () => {
    const { formatter, events } = makeFormatter();
    const call: TurnStreamCall = { id: 'c1', name: 'UnknownTool', args: { payload: 'x'.repeat(1_000) } };
    formatter.onToolCall(call);
    expect(events).toEqual([{
      type: 'tool.appendBlock',
      callId: 'c1',
      lines: ['mut:[B] tool: UnknownTool — running'],
      args: call.args,
    }]);
    expect((events[0] as Extract<TurnStreamPresentationEvent, { type: 'tool.appendBlock' }>).lines.join('\n'))
      .not.toContain(call.args.payload as string);
  });

  test('tool call resets per-round narration (so next render starts fresh)', () => {
    const { formatter, events } = makeFormatter({
      renderToolCallEvent: () => ['● tool'],
    });
    formatter.onText('narration', 'narration');
    formatter.onToolCall({ id: 'c1', name: 'tool', args: {} });
    formatter.onText('post-tool narration', 'narration post-tool narration');
    // post-tool emit is JUST 'post-tool narration' — narration was
    // committed on tool call (perRoundText reset) so cross-turn
    // accumulated is ignored.
    const lastEvent = events[events.length - 1];
    expect(lastEvent).toEqual({
      type: 'assistant.replaceBlock',
      lines: ['post-tool narration'],
    });
  });
});

describe('createTurnStreamFormatter — onToolResult', () => {
  test('pty result — emits tool.appendLine with pty summary', () => {
    const { formatter, events } = makeFormatter({
      ptyResultLine: () => 'pty-summary',
    });
    formatter.onToolResult({ id: 'c1', name: 'pty.run', args: {}, result: {} });
    expect(events).toEqual([
      { type: 'tool.appendLine', callId: 'c1', line: 'pty-summary' },
    ]);
  });

  test('rendered result — emits tool.replaceBlock with collapsed + expanded', () => {
    const { formatter, events } = makeFormatter({
      renderToolCallEvent: () => ['● call'],
      renderToolResultVariants: () => ({
        collapsed: ['● call result-summary'],
        expanded: ['● call result-summary', '  detail-line'],
      }),
    });
    // Setup — call first so args is tracked.
    formatter.onToolCall({ id: 'c1', name: 'tool', args: { q: 1 } });
    formatter.onToolResult({ id: 'c1', name: 'tool', args: {}, result: { ok: true } });
    expect(events.map(e => e.type)).toEqual(['tool.appendBlock', 'tool.replaceBlock']);
    const replaceEvent = events[1] as Extract<TurnStreamPresentationEvent, { type: 'tool.replaceBlock' }>;
    expect(replaceEvent.callId).toBe('c1');
    expect(replaceEvent.collapsedLines).toEqual(['● call result-summary']);
    expect(replaceEvent.expandedLines).toEqual(['● call result-summary', '  detail-line']);
  });

  test('generic result applies the existing finite blockMaxLines budget', () => {
    const { formatter, events } = makeFormatter({
      toolRendering: { blockMaxLines: 4 },
    });
    formatter.onToolCall({ id: 'generic', name: 'UnknownTool', args: {} });
    formatter.onToolResult({
      id: 'generic',
      name: 'UnknownTool',
      args: {},
      result: Array.from({ length: 20 }, (_, index) => index),
    });
    const replacement = events[1] as Extract<TurnStreamPresentationEvent, { type: 'tool.replaceBlock' }>;
    expect(replacement.expandedLines).toHaveLength(5);
    expect(replacement.expandedLines?.join('\n')).toContain('22 more lines folded');
  });

  test('generic result fallback emits a folded replacement and records its tool name while a supported renderer bypasses it', () => {
    const records: Array<{ category: string; event: string; data: unknown }> = [];
    const off = debug.registerSink({
      name: 'generic-tool-render-test',
      emit: (record) => records.push({ category: record.category, event: record.event, data: record.data }),
    });
    const wasEnabled = debug.enabled;
    if (!wasEnabled) debug.enable();
    const generic = makeFormatter();
    try {
      generic.formatter.onToolCall({ id: 'generic', name: 'UnknownTool', args: { query: 'q' } });
      generic.formatter.onToolResult({ id: 'generic', name: 'UnknownTool', args: {}, result: 'generic output' });
    } finally {
      off?.();
      if (!wasEnabled) debug.disable();
    }
    const genericResult = generic.events[1] as Extract<TurnStreamPresentationEvent, { type: 'tool.replaceBlock' }>;
    expect(genericResult).toMatchObject({
      type: 'tool.replaceBlock',
      callId: 'generic',
      collapsedLines: ['mut:[B] tool: UnknownTool — result (16 chars)'],
    });
    expect(genericResult.expandedLines?.join('\n')).toContain('generic output');
    expect(records).toEqual(expect.arrayContaining([
      { category: 'dashboard.chat.generic-tool', event: 'formatter.genericCall', data: { toolName: 'UnknownTool' } },
      { category: 'dashboard.chat.generic-tool', event: 'formatter.genericResult', data: { toolName: 'UnknownTool' } },
    ]));

    const supported = makeFormatter({
      renderToolCallEvent: () => ['supported call'],
      renderToolResultVariants: () => ({ collapsed: ['supported result'], expanded: ['supported detail'] }),
    });
    supported.formatter.onToolCall({ id: 'supported', name: 'Bash', args: {} });
    supported.formatter.onToolResult({ id: 'supported', name: 'Bash', args: {}, result: 'ignored by renderer' });
    expect(supported.events[1]).toEqual({
      type: 'tool.replaceBlock',
      callId: 'supported',
      collapsedLines: ['supported result'],
      expandedLines: ['supported detail'],
    });
  });
});

describe('createTurnStreamFormatter — supported renderer regression', () => {
  test('all 14 supported tools preserve dispatch variants and never invoke generic rendering', () => {
    const toolRendering = {
      displayMode: 'inline-to-block' as const,
      blockMaxLines: 4,
    };
    const supportedTools = [
      'Bash', 'Glob', 'Grep', 'Read', 'ListDir', 'Edit', 'Write',
      'Agent', 'UpdatePlan', 'Lsp', 'RunShell', 'WebSearch', 'WebFetch', 'GetDashboardState',
    ];
    const records: Array<{ category: string; data: unknown }> = [];
    const off = debug.registerSink({
      name: 'supported-tool-render-test',
      emit: (record) => records.push({ category: record.category, data: record.data }),
    });
    const wasEnabled = debug.enabled;
    if (!wasEnabled) debug.enable();
    try {
      for (const name of supportedTools) {
        const args = {};
        const result = { output: 'renderer output' };
        const expected = renderToolResultVariants({ id: name, name, args, result }, toolRendering);
        expect(expected).not.toBeNull();
        const { formatter, events } = makeFormatter({
          toolRendering,
          renderToolCallEvent: (call) => renderToolCallEvent(call, toolRendering),
          renderToolResultVariants: (call) => renderToolResultVariants({
            ...call,
            result: call.result,
          }, toolRendering),
        });
        formatter.onToolCall({ id: name, name, args });
        formatter.onToolResult({ id: name, name, args: {}, result });
        expect(events[1]).toEqual({
          type: 'tool.replaceBlock',
          callId: name,
          collapsedLines: expected!.collapsed,
          expandedLines: expected!.expanded,
        });
      }
    } finally {
      off?.();
      if (!wasEnabled) debug.disable();
    }
    expect(records.filter((record) => record.category === 'dashboard.chat.generic-tool')).toEqual([]);
  });
});

describe('createTurnStreamFormatter — architectural invariant', () => {
  test('formatter never references chatLines — only emit() side-effect', () => {
    // The formatter type signature has no chatLines field. Compile-time
    // guarantee. This test asserts the runtime path executes WITHOUT
    // accessing any external mutable state.
    const events: TurnStreamPresentationEvent[] = [];
    const formatter = createTurnStreamFormatter({
      emit: (e) => { events.push(e); },
      thinking: { update: () => {}, updateMetrics: () => {} },
      termCols: () => 80,
      wrapOpts: {},
      formatResponse: (full) => [full],
      text: (line) => line,
      muted: (text) => text,
      ptyCallLine: () => null,
      ptyResultLine: () => null,
      renderToolCallEvent: () => null,
      renderToolResultVariants: () => null,
      toolRendering: {},
      brainIcon: '[B]',
    });
    formatter.onText('a', 'a');
    formatter.onText('', '');
    formatter.onToolCall({ id: 'c', name: 'n', args: {} });
    formatter.onText('b', 'b');
    formatter.onToolResult({ id: 'c', name: 'n', args: {}, result: {} });
    // 4 events emitted (no replaceBlock for null renderToolResultVariants).
    expect(events.length).toBeGreaterThan(0);
    // All events are presentation events (not chatLines mutations).
    for (const ev of events) {
      expect(['assistant.replaceBlock', 'assistant.commit', 'tool.appendLine', 'tool.appendBlock', 'tool.replaceBlock']).toContain(ev.type);
    }
  });
});
