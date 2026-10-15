import { describe, expect, test } from 'bun:test';

import { FoldStack } from '../src/fold-stack.js';
import { createDashboardRenderedToolRuntime } from '../src/dashboard/rendered-tool-runtime.js';
import { createDashboardTurnStreamRuntime } from '../src/dashboard/turn-stream-runtime.js';

describe('createDashboardTurnStreamRuntime', () => {
  test('renders streamed deltas (per-round accumulator)', () => {
    const chatLines = ['head'];
    const runtime = createDashboardTurnStreamRuntime({
      initialAssistantStart: 1,
      chatLines,
      thinking: {
        update: () => {},
        updateMetrics: () => {},
      },
      draw: () => {},
      pinChatTail: () => {},
      termCols: () => 80,
      wrapOpts: {},
      formatResponse: (full) => [full],
      text: (line) => `text:${line}`,
      muted: (text) => text,
      ptyCallLine: () => null,
      ptyResultLine: () => null,
      renderToolCallEvent: () => null,
      renderToolResultVariants: () => null,
      toolRendering: {},
      renderedToolRuntime: {
        setArgs: () => {},
        getArgs: () => undefined,
        deleteArgs: () => {},
        replaceBlock: () => 0,
        registerFold: () => {},
      },
      brainIcon: '[brain]',
    });

    // Streaming: each chunk extends per-round text. The second
    // `accumulated` parameter is the cross-turn fullText from
    // streamLLMWithTools and must be IGNORED for delta emits — it
    // would re-display prior turns' narration (the bug fix landing
    // on this branch — see runtime comment).
    runtime.onText('an', 'an');
    expect(chatLines).toEqual(['head', 'text:an']);
    runtime.onText('swer', 'answer');
    expect(chatLines).toEqual(['head', 'text:answer']);
  });

  test('regression — does NOT carry prior turn narration on next turn after tool round', () => {
    // Reproduces the codex "Analysis pipeline 선택: ... 요약하겠습니다.
    // 먼저 디버깅..." accumulation pattern reported by the user. Per-
    // turn codex stream is short (~50 chars) but the dashboard was
    // re-rendering `accumulated` (= cross-turn fullText) so each new
    // turn's narration line displayed ALL prior turns concatenated.
    const chatLines = ['head'];
    const runtime = createDashboardTurnStreamRuntime({
      initialAssistantStart: 1,
      chatLines,
      thinking: { update: () => {}, updateMetrics: () => {} },
      draw: () => {},
      pinChatTail: () => {},
      termCols: () => 80,
      wrapOpts: {},
      formatResponse: (full) => [full],
      text: (line) => line,
      muted: (text) => text,
      ptyCallLine: () => 'pty',
      ptyResultLine: () => 'pty-result',
      renderToolCallEvent: () => null,
      renderToolResultVariants: () => null,
      toolRendering: {},
      renderedToolRuntime: {
        setArgs: () => {},
        getArgs: () => undefined,
        deleteArgs: () => {},
        replaceBlock: () => 0,
        registerFold: () => {},
      },
      brainIcon: '[brain]',
    });

    // Turn 1 narration (codex emits ~57 chars).
    runtime.onText('Analysis pipeline 선택...', 'Analysis pipeline 선택...');
    expect(chatLines[chatLines.length - 1]).toBe('Analysis pipeline 선택...');

    // Tool round (Grep).
    runtime.onToolCall({ id: 't1', name: 'Grep', args: {} });
    runtime.onToolResult({ id: 't1', name: 'Grep', args: {}, result: {} });

    // Turn 2 narration — codex emits ~53 NEW chars but llm.ts'
    // accumulated parameter spans both turns. Pre-fix the dashboard
    // would render the entire concatenation; post-fix it must show
    // ONLY the new turn's text.
    runtime.onText(
      '먼저 디버깅 파이프라인 후보를 찾겠습니다.',
      'Analysis pipeline 선택...먼저 디버깅 파이프라인 후보를 찾겠습니다.',
    );
    expect(chatLines[chatLines.length - 1]).toBe('먼저 디버깅 파이프라인 후보를 찾겠습니다.');
    expect(chatLines[chatLines.length - 1]).not.toContain('Analysis pipeline 선택');
  });

  test('empty-chunk emits replace per-round text (force-synthesis / clear)', () => {
    // After all turns end, llm.ts emits handlers.onText('', finalText)
    // with the synthesized final answer (W5-E/W5-F/W5-G). The runtime
    // must REPLACE per-round text with this authoritative content so
    // the user sees the final synthesis instead of just whatever short
    // narration accumulated in the last partial turn.
    const chatLines = ['head'];
    const runtime = createDashboardTurnStreamRuntime({
      initialAssistantStart: 1,
      chatLines,
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
      renderToolCallEvent: () => null,
      renderToolResultVariants: () => null,
      toolRendering: {},
      renderedToolRuntime: {
        setArgs: () => {},
        getArgs: () => undefined,
        deleteArgs: () => {},
        replaceBlock: () => 0,
        registerFold: () => {},
      },
      brainIcon: '[brain]',
    });

    // Some short narration was streaming.
    runtime.onText('짧은 narration', '짧은 narration');
    expect(chatLines[chatLines.length - 1]).toBe('짧은 narration');

    // Force-synthesis emits the full substantive answer.
    runtime.onText('', 'FINAL substantive synthesized answer (3000 chars …)');
    expect(chatLines[chatLines.length - 1]).toBe('FINAL substantive synthesized answer (3000 chars …)');
  });

  test('clear-and-commit signal (empty chunk + empty accumulated) preserves committed narration', () => {
    // clearVisibleAssistantTextForToolRound (llm.ts:3383) emits
    // onText('', '') right before a tool round dispatches. The
    // narration that was streamed via prior deltas is ALREADY in
    // chatLines and should remain VISIBLE after the clear (it's the
    // committed turn record). Pre-fix the runtime called
    // renderPerRoundText with perRoundText='' which truncated chatLines
    // back to assistantStart and pushed [] = wiped the narration.
    // User-reported "narration shows then deletes" bug — see commit
    // log on this branch.
    const chatLines = ['head'];
    const runtime = createDashboardTurnStreamRuntime({
      initialAssistantStart: 1,
      chatLines,
      thinking: { update: () => {}, updateMetrics: () => {} },
      draw: () => {},
      pinChatTail: () => {},
      termCols: () => 80,
      wrapOpts: {},
      formatResponse: (full) => full.length === 0 ? [] : [full],
      text: (line) => line,
      muted: (text) => text,
      ptyCallLine: () => null,
      ptyResultLine: () => null,
      renderToolCallEvent: () => null,
      renderToolResultVariants: () => null,
      toolRendering: {},
      renderedToolRuntime: {
        setArgs: () => {},
        getArgs: () => undefined,
        deleteArgs: () => {},
        replaceBlock: () => 0,
        registerFold: () => {},
      },
      brainIcon: '[brain]',
    });

    runtime.onText('hello', 'hello');
    expect(chatLines).toEqual(['head', 'hello']);
    runtime.onText('', '');
    // Narration preserved (clear-and-commit semantic), assistantStart
    // advanced past it.
    expect(chatLines).toEqual(['head', 'hello']);
    expect(runtime.getAssistantStart()).toBe(2);
  });

  test('regression — narration survives multiple clear-and-commit cycles between tool calls', () => {
    // Reproduces user-reported pattern: 4-turn conversation with
    // narration "먼저..." between tool calls. Each turn emits narration
    // → tool dispatch. The clear-and-commit signal between turns must
    // NOT wipe the prior turn's narration from chatLines.
    const chatLines = ['head', 'user-prompt'];
    const runtime = createDashboardTurnStreamRuntime({
      initialAssistantStart: 2,
      chatLines,
      thinking: { update: () => {}, updateMetrics: () => {} },
      draw: () => {},
      pinChatTail: () => {},
      termCols: () => 80,
      wrapOpts: {},
      formatResponse: (full) => full.length === 0 ? [] : [full],
      text: (line) => line,
      muted: (text) => text,
      ptyCallLine: () => 'pty-tool',
      ptyResultLine: () => null,
      renderToolCallEvent: () => null,
      renderToolResultVariants: () => null,
      toolRendering: {},
      renderedToolRuntime: {
        setArgs: () => {},
        getArgs: () => undefined,
        deleteArgs: () => {},
        replaceBlock: () => 0,
        registerFold: () => {},
      },
      brainIcon: '[brain]',
    });

    // Turn 1: narration → clear → tool call → tool result.
    runtime.onText('narration1', 'narration1');
    expect(chatLines[chatLines.length - 1]).toBe('narration1');
    runtime.onText('', ''); // commit-on-clear (NOT wipe)
    runtime.onToolCall({ id: 't1', name: 'tool', args: {} });
    runtime.onToolResult({ id: 't1', name: 'tool', args: {}, result: {} });

    // Turn 2: narration → clear → tool call → tool result.
    runtime.onText('narration2', 'narration2');
    runtime.onText('', '');
    runtime.onToolCall({ id: 't2', name: 'tool', args: {} });
    runtime.onToolResult({ id: 't2', name: 'tool', args: {}, result: {} });

    // ALL narration + tool lines preserved.
    expect(chatLines).toContain('narration1');
    expect(chatLines).toContain('narration2');
    expect(chatLines.filter(l => l === 'pty-tool').length).toBe(2);
  });

  test('advances assistant start for pty tool events', () => {
    const chatLines = ['head'];
    const events: string[] = [];
    const runtime = createDashboardTurnStreamRuntime({
      initialAssistantStart: 1,
      chatLines,
      thinking: { update: () => {}, updateMetrics: () => {} },
      draw: () => { events.push('draw'); },
      pinChatTail: () => { events.push('pin'); },
      termCols: () => 80,
      wrapOpts: {},
      formatResponse: (full) => [full],
      text: (line) => line,
      muted: (text) => text,
      ptyCallLine: () => 'pty-call',
      ptyResultLine: () => 'pty-result',
      renderToolCallEvent: () => null,
      renderToolResultVariants: () => null,
      toolRendering: {},
      renderedToolRuntime: {
        setArgs: () => {},
        getArgs: () => undefined,
        deleteArgs: () => {},
        replaceBlock: () => 0,
        registerFold: () => {},
      },
      brainIcon: '[brain]',
    });

    runtime.onToolCall({ id: '1', name: 'pty', args: {} });
    runtime.onText('', 'answer');
    expect(chatLines).toEqual(['head', 'pty-call', 'answer']);

    runtime.onToolResult({ id: '1', name: 'pty', args: {}, result: {} });
    runtime.onText('', 'done');
    expect(chatLines).toEqual(['head', 'pty-call', 'answer', 'pty-result', 'done']);
    expect(events).toEqual(['pin', 'draw', 'draw', 'pin', 'draw', 'draw']);
  });

  test('generic tool result stays folded initially and exposes its details after toggle', () => {
    const chatLines: string[] = [];
    const foldStack = new FoldStack({ chatLines });
    const renderedToolRuntime = createDashboardRenderedToolRuntime({
      chatLines,
      foldStack,
      pinChatTail: () => {},
      draw: () => {},
    });
    const runtime = createDashboardTurnStreamRuntime({
      initialAssistantStart: 0,
      chatLines,
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
      renderToolCallEvent: () => null,
      renderToolResultVariants: () => null,
      toolRendering: {},
      renderedToolRuntime,
      brainIcon: '[brain]',
    });

    runtime.onToolCall({ id: 'generic', name: 'UnknownTool', args: { query: 'q' } });
    runtime.onToolResult({ id: 'generic', name: 'UnknownTool', args: {}, result: 'generic output' });

    expect(chatLines).toEqual(['[brain] tool: UnknownTool — result (16 chars)']);
    expect(foldStack.snapshot()).toMatchObject([{ kind: 'static', expanded: false }]);
    expect(foldStack.toggleTop()).toBe(true);
    expect(foldStack.snapshot()).toMatchObject([{ kind: 'static', expanded: true }]);
    expect(chatLines.join('\n')).toContain('generic output');
  });

  test('uses rendered tool runtime for structured tool events', () => {
    const setArgsCalls: Array<Record<string, unknown>> = [];
    const deleted: string[] = [];
    // The fake block writer appends like the real one — the applier now clamps assistantStart to chatLines.length (#27721).
    const chatLines: string[] = [];
    const runtime = createDashboardTurnStreamRuntime({
      initialAssistantStart: 0,
      chatLines,
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
      renderToolCallEvent: () => ['call-line'],
      renderToolResultVariants: () => ({ collapsed: ['result-line'], expanded: ['result-line', 'detail'] }),
      toolRendering: {},
      renderedToolRuntime: {
        setArgs: (_id, args) => { setArgsCalls.push(args); },
        getArgs: () => ({ q: 1 }),
        deleteArgs: (id) => { deleted.push(id); },
        replaceBlock: (_id, lines, assistantStart) => { chatLines.push(...lines.slice(0, 1)); return assistantStart + 1; },
        registerFold: () => {},
      },
      brainIcon: '[brain]',
    });

    runtime.onToolCall({ id: '1', name: 'tool', args: { q: 1 } });
    runtime.onToolResult({ id: '1', name: 'tool', args: {}, result: { ok: true } });

    expect(setArgsCalls).toEqual([{ q: 1 }]);
    expect(deleted).toEqual(['1']);
    expect(runtime.getAssistantStart()).toBe(2);
  });
});
