// Unit tests for the applier — verifies it's the SOLE chatLines
// mutation site. Each event type → exact mutation pattern.

import { describe, expect, test } from 'bun:test';

import {
  createTurnStreamPresentationApplier,
  type TurnStreamRenderedToolRuntime,
} from '../src/dashboard/turn-stream-presentation-applier.js';
import { createDashboardRenderedToolRuntime } from '../src/dashboard/rendered-tool-runtime.js';
import { FoldStack } from '../src/fold-stack.js';
import { foldKindHint } from '../src/log-entry.js';

interface ApplierFixture {
  chatLines: string[];
  renderedToolRuntime: TurnStreamRenderedToolRuntime;
  toolCalls: Array<['setArgs' | 'getArgs' | 'deleteArgs' | 'replaceBlock' | 'registerFold', ...unknown[]]>;
  applier: ReturnType<typeof createTurnStreamPresentationApplier>;
  draws: number;
  pins: number;
}

function makeFixture(initial: { chatLines?: string[]; assistantStart?: number } = {}): ApplierFixture {
  const chatLines = initial.chatLines ?? ['head'];
  const toolCalls: ApplierFixture['toolCalls'] = [];
  const renderedToolRuntime: TurnStreamRenderedToolRuntime = {
    setArgs: (id, args) => { toolCalls.push(['setArgs', id, args]); },
    getArgs: (id) => { toolCalls.push(['getArgs', id]); return undefined; },
    deleteArgs: (id) => { toolCalls.push(['deleteArgs', id]); },
    replaceBlock: (id, lines, start) => {
      toolCalls.push(['replaceBlock', id, lines, start]);
      // Simulate splice — replace assistantStart..end with lines.
      chatLines.length = start;
      chatLines.push(...lines);
      return chatLines.length;
    },
    registerFold: (id, c, e) => { toolCalls.push(['registerFold', id, c, e]); },
  };
  let draws = 0;
  let pins = 0;
  const applier = createTurnStreamPresentationApplier({
    chatLines,
    renderedToolRuntime,
    initialAssistantStart: initial.assistantStart ?? 1,
    draw: () => { draws++; },
    pinChatTail: () => { pins++; },
  });
  return {
    chatLines,
    renderedToolRuntime,
    toolCalls,
    applier,
    get draws() { return draws; },
    get pins() { return pins; },
  } as ApplierFixture;
}

describe('createTurnStreamPresentationApplier — assistant.replaceBlock', () => {
  test('truncates to assistantStart + pushes new lines', () => {
    const fx = makeFixture({ chatLines: ['head', 'old1', 'old2'], assistantStart: 1 });
    fx.applier.apply({ type: 'assistant.replaceBlock', lines: ['new1', 'new2', 'new3'] });
    expect(fx.chatLines).toEqual(['head', 'new1', 'new2', 'new3']);
    expect(fx.applier.getAssistantStart()).toBe(1); // not advanced
  });

  test('empty lines = clear back to assistantStart', () => {
    const fx = makeFixture({ chatLines: ['head', 'old'], assistantStart: 1 });
    fx.applier.apply({ type: 'assistant.replaceBlock', lines: [] });
    expect(fx.chatLines).toEqual(['head']);
  });

  test('triggers draw', () => {
    const fx = makeFixture();
    fx.applier.apply({ type: 'assistant.replaceBlock', lines: ['x'] });
    expect(fx.draws).toBe(1);
  });
});

describe('createTurnStreamPresentationApplier — assistant.commit', () => {
  test('advances assistantStart to chatLines.length when narration present', () => {
    const fx = makeFixture({ chatLines: ['head', 'narration'], assistantStart: 1 });
    fx.applier.apply({ type: 'assistant.commit' });
    expect(fx.chatLines).toEqual(['head', 'narration']); // unchanged
    expect(fx.applier.getAssistantStart()).toBe(2);
  });

  test('no-op when chatLines.length === assistantStart (nothing committed)', () => {
    const fx = makeFixture({ chatLines: ['head'], assistantStart: 1 });
    fx.applier.apply({ type: 'assistant.commit' });
    expect(fx.applier.getAssistantStart()).toBe(1);
  });

  test('does NOT trigger draw or pin (commit is silent)', () => {
    const fx = makeFixture({ chatLines: ['head', 'n'], assistantStart: 1 });
    fx.applier.apply({ type: 'assistant.commit' });
    expect(fx.draws).toBe(0);
    expect(fx.pins).toBe(0);
  });
});

describe('createTurnStreamPresentationApplier — tool.appendLine', () => {
  test('pushes line + advances assistantStart + pin + draw', () => {
    const fx = makeFixture();
    fx.applier.apply({ type: 'tool.appendLine', callId: 'c1', line: 'tool-line' });
    expect(fx.chatLines).toEqual(['head', 'tool-line']);
    expect(fx.applier.getAssistantStart()).toBe(2);
    expect(fx.draws).toBe(1);
    expect(fx.pins).toBe(1);
  });
});

describe('createTurnStreamPresentationApplier — tool.appendBlock', () => {
  test('setArgs + replaceBlock — assistantStart advances to replaceBlock return', () => {
    const fx = makeFixture();
    fx.applier.apply({
      type: 'tool.appendBlock',
      callId: 'c1',
      lines: ['● tool', '  d1'],
      args: { x: 1 },
    });
    expect(fx.toolCalls[0]).toEqual(['setArgs', 'c1', { x: 1 }]);
    expect(fx.toolCalls[1]).toEqual(['replaceBlock', 'c1', ['● tool', '  d1'], 1]);
    expect(fx.chatLines).toEqual(['head', '● tool', '  d1']);
    expect(fx.applier.getAssistantStart()).toBe(3);
  });
});

describe('createTurnStreamPresentationApplier — tool.replaceBlock', () => {
  test('replaceBlock + registerFold + deleteArgs', () => {
    const fx = makeFixture({ chatLines: ['head', '● tool'], assistantStart: 1 });
    fx.applier.apply({
      type: 'tool.replaceBlock',
      callId: 'c1',
      collapsedLines: ['● tool ✓'],
      expandedLines: ['● tool ✓', '  result detail'],
    });
    expect(fx.toolCalls.map(c => c[0])).toEqual(['replaceBlock', 'registerFold', 'deleteArgs']);
    expect(fx.chatLines).toEqual(['head', '● tool ✓']);
  });

  test('kind-unit coalesce shrinks chatLines then assistant.replaceBlock leaves zero undefined slots', () => {
    // Real rendered-tool-runtime: three adjacent RunShell results go through
    // registerFold's kind-unit coalesce, which splices chatLines shorter.
    const chatLines: string[] = ['head'];
    const renderedToolRuntime = createDashboardRenderedToolRuntime({
      chatLines,
      foldStack: new FoldStack({ chatLines }),
      pinChatTail: () => {},
      draw: () => {},
    });
    const applier = createTurnStreamPresentationApplier({
      chatLines,
      renderedToolRuntime,
      initialAssistantStart: 1,
      draw: () => {},
      pinChatTail: () => {},
    });
    for (let i = 0; i < 3; i++) {
      applier.apply({ type: 'assistant.commit' });
      applier.apply({
        type: 'tool.appendBlock',
        callId: `c${i}`,
        lines: ['● RunShell', '  running'],
        args: { command: `echo ${i}` },
        operationKind: 'RunShell',
      });
      applier.apply({
        type: 'tool.replaceBlock',
        callId: `c${i}`,
        collapsedLines: ['● RunShell ✓', `  out ${i}`],
        expandedLines: null,
        operationKind: 'RunShell',
      });
    }
    expect(chatLines).toEqual(['head', foldKindHint('RunShell', 3)]);
    applier.apply({ type: 'assistant.replaceBlock', lines: ['after fold'] });
    expect(Array.from(chatLines).every((line) => typeof line === 'string')).toBe(true);
    expect(chatLines).toHaveLength(3);
    expect(Array.from(chatLines)).toEqual(['head', foldKindHint('RunShell', 3), 'after fold']);
  });
});

describe('createTurnStreamPresentationApplier — full turn cycle', () => {
  test('narration → commit → tool call → tool result → next narration (no wipe)', () => {
    const fx = makeFixture({ chatLines: ['head'], assistantStart: 1 });

    // Turn 1 narration streaming.
    fx.applier.apply({ type: 'assistant.replaceBlock', lines: ['narration1-line1'] });
    expect(fx.chatLines).toEqual(['head', 'narration1-line1']);

    // commit-on-clear before tool round.
    fx.applier.apply({ type: 'assistant.commit' });
    expect(fx.chatLines).toEqual(['head', 'narration1-line1']); // PRESERVED
    expect(fx.applier.getAssistantStart()).toBe(2);

    // Tool call — pushes after narration.
    fx.applier.apply({ type: 'tool.appendLine', callId: 'c1', line: 'tool-line' });
    expect(fx.chatLines).toEqual(['head', 'narration1-line1', 'tool-line']);
    expect(fx.applier.getAssistantStart()).toBe(3);

    // Turn 2 narration streaming — fresh slot, doesn't truncate prior.
    fx.applier.apply({ type: 'assistant.replaceBlock', lines: ['narration2'] });
    expect(fx.chatLines).toEqual(['head', 'narration1-line1', 'tool-line', 'narration2']);
  });
});
