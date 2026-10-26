import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderToolCallEvent, renderToolResultVariants } from './dispatch.js';
import type { ToolRenderConfig } from './types.js';
import { dispatchMsgPost } from '../../skills/tools/ops-ledger.js';
import { MsgStore } from '../../msg/msg-store.js';
import { createTurnStreamFormatter } from '../../dashboard/turn-stream-formatter.js';
import { msgPostRuntime } from '../../tool-runtime/ops-ledger-runtimes.js';

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

describe('MsgPost collapsed result summary (first slice)', () => {
  const BODY_ONE = 'BODY-ONE routing memo for the receiving seat';
  const BODY_FIVE = 'BODY-FIVE routing memo for the receiving seat';
  const longBody = [BODY_ONE, 'BODY-TWO line', 'BODY-THREE line', 'BODY-FOUR line', BODY_FIVE].join('\n');

  const successResult = {
    ok: true,
    output: 'MsgPost #42 OP → TC',
    message: { id: 42, from: 'OP', to: 'TC', body: longBody },
  };

  const callFor = (result: unknown) => ({
    id: 'msgpost-1',
    name: 'MsgPost',
    args: { from: 'OP', to: 'TC', body: longBody },
    result,
  });

  /** Production dashboard wires `(call, rendering)` (`src/dashboard/index.ts`). */
  const tuiEventsFor = (call: { id: string; name: string; args: Record<string, unknown>; result?: unknown }, legacy: boolean) => {
    const config = { ...baseConfig, blockMaxLines: 20 };
    const events: unknown[] = [];
    const formatter = createTurnStreamFormatter({
      emit: (event) => { events.push(event); },
      thinking: { update: () => {}, updateMetrics: () => {} },
      termCols: () => 80,
      wrapOpts: {},
      formatResponse: (text) => [text],
      text: (text) => text,
      muted: (text) => text,
      ptyCallLine: () => null,
      ptyResultLine: () => null,
      renderToolCallEvent: (item, rendering) => legacy
        ? null
        : renderToolCallEvent(item, rendering as ToolRenderConfig),
      renderToolResultVariants: (item, rendering) => legacy
        ? null
        : renderToolResultVariants({ ...item, result: item.result }, rendering as ToolRenderConfig),
      toolRendering: config,
      brainIcon: '[B]',
    });
    formatter.onToolCall(call);
    formatter.onToolResult(call);
    return events;
  };

  const replaceBlock = (events: unknown[]) => events.find((event) =>
    !!event && typeof event === 'object' && (event as { type?: unknown }).type === 'tool.replaceBlock',
  ) as { type: 'tool.replaceBlock'; collapsedLines: string[]; expandedLines: string[] | null } | undefined;

  test('success — the folded row carries act, recipient and id', () => {
    const variants = renderToolResultVariants(callFor(successResult), baseConfig);
    const collapsed = variants?.collapsed.join('\n') ?? '';
    expect(collapsed).toContain('post');
    expect(collapsed).toContain('TC');
    expect(collapsed).toContain('#42');
  });

  test('success — the folded row holds neither the body nor the whole result JSON', () => {
    const variants = renderToolResultVariants(callFor(successResult), baseConfig);
    const collapsed = variants?.collapsed.join('\n') ?? '';
    expect(collapsed).not.toContain(BODY_ONE);
    expect(collapsed).not.toContain(BODY_FIVE);
    expect(collapsed).not.toContain('"message"');
    expect(collapsed).not.toContain('{');
  });

  test('expanded — the full body shows once and nowhere else', () => {
    const call = callFor(successResult);
    const variants = renderToolResultVariants(call, baseConfig);
    const expanded = variants?.expanded?.join('\n') ?? '';
    expect(expanded).toContain(BODY_ONE);
    expect(expanded).toContain(BODY_FIVE);
    expect(expanded.split(BODY_ONE).length - 1).toBe(1);

    const callRow = renderToolCallEvent(call, baseConfig)?.join('\n') ?? '';
    // The generic running row remains in charge, so an eventual error can
    // retain the same generic result display as before MsgPost support.
    expect(callRow).toBe('');
    expect(callRow).not.toContain(BODY_ONE);
  });

  test('real MsgPost dispatcher result preserves output, sender and body exactly once when expanded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'msgpost-render-'));
    try {
      const result = await dispatchMsgPost(
        { from: 'OP', to: 'TC', body: longBody },
        { openStore: () => new MsgStore(join(dir, 'messages.db')) },
      );
      const call = { id: 'msgpost-live', name: 'MsgPost', args: { from: 'OP', to: 'TC', body: longBody }, result };
      const variants = renderToolResultVariants(call, baseConfig);
      const collapsed = variants?.collapsed.join('\n') ?? '';
      const expanded = variants?.expanded?.join('\n') ?? '';
      const callRow = renderToolCallEvent(call, baseConfig)?.join('\n') ?? '';
      expect(collapsed).toContain(`#${result.message.id}`);
      expect(collapsed).not.toContain(BODY_ONE);
      expect(callRow).not.toContain(BODY_ONE);
      expect(expanded).toContain(result.output);
      expect(expanded).toContain('"from": "OP"');
      expect(expanded).toContain('"to": "TC"');
      expect(expanded).toContain(BODY_ONE);
      expect(expanded).toContain(BODY_FIVE);
      expect(expanded.split(BODY_ONE)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('error regression — the production turn formatter emits the same generic result as before MsgPost support', () => {
    const call = callFor({ error: 'msg.post failed: recipient offline' });
    const baseline = tuiEventsFor(call, true);
    const current = tuiEventsFor(call, false);
    expect(current).toEqual(baseline);
    expect(JSON.stringify(current)).toContain('msg.post failed: recipient offline');
    expect(renderToolResultVariants(call, baseConfig)).toBeNull();
  });

  test('real MsgPost dispatcher throw is wrapped like llm.ts and keeps the generic TUI result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'msgpost-render-error-'));
    try {
      const args = { from: 'ALL', to: 'OP', body: longBody };
      let thrown: unknown;
      try {
        await dispatchMsgPost(args, { openStore: () => new MsgStore(join(dir, 'messages.db')) });
      } catch (err: unknown) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      // Production tool-loop (`src/llm.ts`) wraps a dispatcher throw as `{ error }`.
      const result = { error: (thrown as Error)?.message || String(thrown) };
      const call = { id: 'msgpost-live-error', name: 'MsgPost', args, result };
      const baseline = tuiEventsFor(call, true);
      const current = tuiEventsFor(call, false);
      expect(current).toEqual(baseline);
      expect(JSON.stringify(current)).toContain('ALL cannot send messages');
      expect(JSON.stringify(current)).not.toContain('post →');
      expect(renderToolResultVariants(call, baseConfig)).toBeNull();
      expect(renderToolCallEvent(call, baseConfig)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('production msgPostRuntime throw is wrapped like llm.ts and keeps the generic TUI result', async () => {
    const args = { from: 'ALL', to: 'OP', body: longBody };
    let thrown: unknown;
    try {
      await msgPostRuntime.run(args, { surface: 'dashboard' });
    } catch (err: unknown) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const result = { error: (thrown as Error)?.message || String(thrown) };
    const call = { id: 'msgpost-runtime-error', name: 'MsgPost', args, result };
    const baseline = tuiEventsFor(call, true);
    const current = tuiEventsFor(call, false);
    expect(current).toEqual(baseline);
    expect(JSON.stringify(current)).toContain('ALL cannot send messages');
    expect(renderToolResultVariants(call, baseConfig)).toBeNull();
  });

  test('real MsgPost success through the production formatter uses the folded summary, not the generic result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'msgpost-render-success-tui-'));
    try {
      const result = await dispatchMsgPost(
        { from: 'OP', to: 'TC', body: longBody },
        { openStore: () => new MsgStore(join(dir, 'messages.db')) },
      );
      const call = { id: 'msgpost-live-success-tui', name: 'MsgPost', args: { from: 'OP', to: 'TC', body: longBody }, result };
      const generic = tuiEventsFor(call, true);
      const current = tuiEventsFor(call, false);
      expect(current).not.toEqual(generic);
      const collapsed = replaceBlock(current)?.collapsedLines.join('\n') ?? '';
      const genericCollapsed = replaceBlock(generic)?.collapsedLines.join('\n') ?? '';
      expect(collapsed).toContain(`#${result.message.id}`);
      expect(collapsed).toContain('post');
      expect(collapsed).toContain('TC');
      expect(collapsed).not.toContain(BODY_ONE);
      expect(genericCollapsed).toContain('result (');
      expect(genericCollapsed).not.toContain(`#${result.message.id}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ok:false MsgPost result keeps the generic TUI fallback even without an error string', () => {
    const call = callFor({ ok: false, output: 'MsgPost refused' });
    const baseline = tuiEventsFor(call, true);
    const current = tuiEventsFor(call, false);
    expect(current).toEqual(baseline);
    expect(JSON.stringify(current)).toContain('MsgPost refused');
    expect(replaceBlock(current)?.collapsedLines.join('\n') ?? '').toContain('result (');
    expect(renderToolResultVariants(call, baseConfig)).toBeNull();
  });
});
