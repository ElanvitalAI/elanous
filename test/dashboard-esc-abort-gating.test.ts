import { describe, expect, test } from 'bun:test';

import {
  clearEscAbortToolState,
  createDashboardTurnStreamRuntimeEscBoundary,
  createEscAbortToolState,
  getEscAbortRunningCount,
  getEscAbortWaitingToolNames,
  formatEscAbortWaitingTargets,
  settleEscAbortPendingLines,
  settleEscAbortToolCall,
  trackEscAbortToolCall,
  type EscAbortToolState,
} from '../src/dashboard/index.js';
import { SELF_IMPLEMENT_TOOL_NAMES } from '../src/boot/daemon-tools/self-implement-names.js';
import { createEscAbortGate } from '../src/esc-abort-gate.js';
import type { ModalSurface } from '../src/display/modal-stack.js';
import { DEFAULT_THEME_TOKENS } from '../src/theme/tokens.js';
import { tuiSourceText } from './helpers/dashboard-source.js';

function toolCall(id: string, name: string) {
  return { id, name };
}

function gateFor(toolState: EscAbortToolState, registeredRunning = 0) {
  const abortCtrl = new AbortController();
  const modals: ModalSurface[] = [];
  const gate = createEscAbortGate({
    abortCtrl,
    getRunningCount: () => getEscAbortRunningCount(toolState, registeredRunning),
    mountModal: (modal) => { modals.push(modal); return () => {}; },
    getViewport: () => ({ cols: 80, rows: 24 }),
    requestRedraw: () => {},
    getTheme: () => DEFAULT_THEME_TOKENS,
  });
  return { abortCtrl, modals, gate };
}

function extractCallbackBlock(source: string, callbackStart: string): string | null {
  const callbackIndex = source.indexOf(callbackStart);
  if (callbackIndex < 0) return null;

  const blockStart = source.indexOf('{', callbackIndex + callbackStart.length);
  if (blockStart < 0) return null;

  let depth = 0;
  for (let index = blockStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(blockStart, index + 1);
  }

  return null;
}

function finalizeTurnClearsEscAbortToolState(source: string): boolean {
  const finalizeTurnBlock = extractCallbackBlock(source, 'finalizeTurn: (finalStatus, finalError) =>');
  return finalizeTurnBlock?.includes('clearEscAbortToolState(escAbortToolState);') ?? false;
}

describe('dashboard ESC abort gating', () => {
  test('production dashboard wiring tracks stream callbacks and clears at turn boundaries', () => {
    const source = tuiSourceText();
    const start = source.indexOf('const attachChatStreamingKeys =');
    const end = source.indexOf('// Scroll the log pane', start);
    const gateCallback = source.slice(start, end);

    expect(gateCallback).toContain('getRunningCount: () => getEscAbortRunningCount(escAbortToolState)');
    expect(gateCallback).toContain('getWaitingTargetNames: () => getEscAbortWaitingToolNames(escAbortToolState)');
    expect(gateCallback).toContain('onAbortPending: ({ targets }) => {');
    expect(gateCallback).toContain('onAbortRepeat: ({ repeat, targets }) => {');
    expect(source).toContain('createTurnStreamRuntime: (initialAssistantStart) => {\n              latestTurnUsage = undefined;\n              createDashboardTurnStreamRuntimeEscBoundary(escAbortToolState);');
    expect(source).toContain('trackEscAbortToolCall(escAbortToolState, toolCall);');
    expect(source).toContain('settleEscAbortToolCall(escAbortToolState, toolCall);');
    expect(finalizeTurnClearsEscAbortToolState(source)).toBe(true);
    expect(source).toContain('const attachChatStreamingKeys = (abortCtrl: AbortController): () => void => {\n    const chatLinesStartIndex = chatLines.length;');
    expect(source).toContain('settleEscAbortPendingLines(chatLines, chatLinesStartIndex);');
    expect(source).toContain('escGate.dispose();');
    const plainTurnIndicators = source.match(/startPinnedThinking\(\{[\s\S]*?message: '(?:Routing|Thinking)',[\s\S]*?metrics: \{ startedAt: [^}]+, hint: 'esc 중단' \},/g) ?? [];
    // 첫 표시 ⊕ 자동 라우팅 취소 재무장 둘 ⊕ /goal 반복마다 재무장(#5) — 모두 esc 중단 안내를 단다.
    expect(plainTurnIndicators).toHaveLength(4);
  });

  test('rejects finalizeTurn sources that omit the clear call or contain it only outside the callback', () => {
    const withoutClearCall = `
      finalizeTurn: (finalStatus, finalError) => {
        lastTurnFinalStatus = finalStatus;
      },
    `;
    const clearCallOutsideCallback = `
      clearEscAbortToolState(escAbortToolState);
      finalizeTurn: (finalStatus, finalError) => {
        lastTurnFinalStatus = finalStatus;
      },
    `;

    expect(finalizeTurnClearsEscAbortToolState(withoutClearCall)).toBe(false);
    expect(finalizeTurnClearsEscAbortToolState(clearCallOutsideCallback)).toBe(false);
  });

  test('settles this turn pending and repeat lines into one completed abort marker', () => {
    const lines = [
      'a',
      '  ⏳ 중단 요청됨 — Bash 종료를 기다리는 중입니다.',
      'b',
      '  ⏳ ESC 재시도 2회 — Bash 종료를 기다리는 중입니다.',
      '  ✘ interrupted',
    ];

    settleEscAbortPendingLines(lines, 0);

    expect(lines).toEqual(['a', '  ⏹ 중단됨', 'b', '  ✘ interrupted']);
  });

  test('does not settle pending lines from an earlier turn or change arrays without pending lines', () => {
    const priorTurnLines = ['  ⏳ 중단 요청됨 — Bash 종료를 기다리는 중입니다.', 'next turn'];
    const noPendingLines = ['a', '  ✘ interrupted'];

    settleEscAbortPendingLines(priorTurnLines, 1);
    settleEscAbortPendingLines(noPendingLines, 0);

    expect(priorTurnLines).toEqual(['  ⏳ 중단 요청됨 — Bash 종료를 기다리는 중입니다.', 'next turn']);
    expect(noPendingLines).toEqual(['a', '  ✘ interrupted']);
  });

  test('does not throw when chatLines has holes', () => {
    const lines: string[] = ['a', '  ⏳ 중단 요청됨 — Bash 종료를 기다리는 중입니다.'];
    lines.length = 4;
    expect(() => settleEscAbortPendingLines(lines, 0)).not.toThrow();
    expect(lines[1]).toBe('  ⏹ 중단됨');
  });

  test('cleanup still clears turn activity when settle throws', () => {
    const source = tuiSourceText();
    const start = source.indexOf('const attachChatStreamingKeys =');
    const end = source.indexOf('// ── Working-directory workspace widgets', start);
    const body = source.slice(start, end);
    const cleanupStart = body.lastIndexOf('return () => {');
    const cleanup = body.slice(cleanupStart);
    const settleAt = cleanup.indexOf('settleEscAbortPendingLines(chatLines, chatLinesStartIndex);');
    const idleAt = cleanup.indexOf("reportTuiTurn('idle');");
    const inFlightAt = cleanup.indexOf('streamingInFlight = false;');
    const finallyAt = cleanup.indexOf('} finally {');
    const catchAt = cleanup.indexOf("debug.log('dashboard.turn', 'settle-failed'");
    expect(settleAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(settleAt);
    expect(finallyAt).toBeGreaterThan(settleAt);
    expect(inFlightAt).toBeGreaterThan(finallyAt);
    expect(idleAt).toBeGreaterThan(finallyAt);
    expect(cleanup.indexOf('userScrolledDuringStream = false;')).toBeGreaterThan(finallyAt);
  });

  test('stream runtime creation clears tracked tool state before the next ESC decision', () => {
    const toolState = createEscAbortToolState();
    trackEscAbortToolCall(toolState, toolCall('self', SELF_IMPLEMENT_TOOL_NAMES[0]));
    trackEscAbortToolCall(toolState, toolCall('read', 'Read'));
    expect(getEscAbortWaitingToolNames(toolState)).toEqual(['Read', SELF_IMPLEMENT_TOOL_NAMES[0]]);

    createDashboardTurnStreamRuntimeEscBoundary(toolState);

    expect(getEscAbortRunningCount(toolState)).toBe(0);
    expect(getEscAbortWaitingToolNames(toolState)).toEqual([]);
  });

  test('two concurrent self-implementation calls remain gated after one completes', () => {
    const toolState = createEscAbortToolState();
    const first = toolCall('self-1', SELF_IMPLEMENT_TOOL_NAMES[0]);
    const second = toolCall('self-2', SELF_IMPLEMENT_TOOL_NAMES[0]);
    trackEscAbortToolCall(toolState, first);
    trackEscAbortToolCall(toolState, second);
    settleEscAbortToolCall(toolState, first);

    expect(getEscAbortRunningCount(toolState)).toBe(1);
    const ctx = gateFor(toolState);
    ctx.gate.handleEscape();
    expect(ctx.abortCtrl.signal.aborted).toBe(false);
    expect(ctx.modals).toHaveLength(1);
  });

  test('a non-self tool does not hide an active self-implementation call', () => {
    const toolState = createEscAbortToolState();
    trackEscAbortToolCall(toolState, toolCall('self', SELF_IMPLEMENT_TOOL_NAMES[0]));
    trackEscAbortToolCall(toolState, toolCall('read', 'Read'));

    expect(getEscAbortRunningCount(toolState)).toBe(1);
    const ctx = gateFor(toolState);
    ctx.gate.handleEscape();
    expect(ctx.abortCtrl.signal.aborted).toBe(false);
    expect(ctx.modals).toHaveLength(1);
  });

  test('a non-self tool alone aborts immediately', () => {
    const toolState = createEscAbortToolState();
    trackEscAbortToolCall(toolState, toolCall('read', 'Read'));

    expect(getEscAbortRunningCount(toolState)).toBe(0);
    const ctx = gateFor(toolState);
    ctx.gate.handleEscape();
    expect(ctx.abortCtrl.signal.aborted).toBe(true);
    expect(ctx.modals).toHaveLength(0);
  });

  test('waiting target names include ordinary active tools without changing confirmation counts', () => {
    const toolState = createEscAbortToolState();
    trackEscAbortToolCall(toolState, toolCall('read-1', 'Read'));
    trackEscAbortToolCall(toolState, toolCall('bash-1', 'Bash'));
    trackEscAbortToolCall(toolState, toolCall('read-2', 'Read'));

    expect(getEscAbortRunningCount(toolState)).toBe(0);
    expect(getEscAbortWaitingToolNames(toolState)).toEqual(['Bash', 'Read']);
    expect(formatEscAbortWaitingTargets(getEscAbortWaitingToolNames(toolState))).toBe('Bash, Read');
  });

  test('waiting target label is Korean when omitted and preserves named targets', () => {
    expect(formatEscAbortWaitingTargets([])).toBe('응답');
    expect(formatEscAbortWaitingTargets(['A'])).toBe('A');
    expect(formatEscAbortWaitingTargets(['A', 'B'])).toBe('A, B');
    expect(formatEscAbortWaitingTargets(['A', 'B', 'C'])).toBe('A, B, C');
    expect(formatEscAbortWaitingTargets(['A', 'B', 'C', 'D'])).toBe('A, B, C +1 more');
  });

  test('settled and cancelled turns clear self-implementation state before ESC', () => {
    const toolState = createEscAbortToolState();
    const selfCall = toolCall('self', SELF_IMPLEMENT_TOOL_NAMES[0]);
    trackEscAbortToolCall(toolState, selfCall);
    expect(getEscAbortRunningCount(toolState)).toBe(1);

    settleEscAbortToolCall(toolState, selfCall);
    expect(getEscAbortRunningCount(toolState)).toBe(0);

    trackEscAbortToolCall(toolState, selfCall);
    clearEscAbortToolState(toolState);
    expect(getEscAbortRunningCount(toolState)).toBe(0);
    const ctx = gateFor(toolState);
    ctx.gate.handleEscape();
    expect(ctx.abortCtrl.signal.aborted).toBe(true);
    expect(ctx.modals).toHaveLength(0);
  });

  test('preserves registered-agent confirmation when no dashboard tool is running', () => {
    const toolState = createEscAbortToolState();
    expect(getEscAbortRunningCount(toolState, 1)).toBe(1);

    const ctx = gateFor(toolState, 1);
    ctx.gate.handleEscape();
    expect(ctx.abortCtrl.signal.aborted).toBe(false);
    expect(ctx.modals).toHaveLength(1);
  });

  test('an unreadable tool state fails safe through the production ESC gate without registered agents', () => {
    const toolState = Object.defineProperty({}, 'activeToolNamesByCallId', {
      get: () => { throw new Error('state unavailable'); },
    }) as EscAbortToolState;

    expect(() => getEscAbortRunningCount(toolState, 0)).not.toThrow();
    expect(getEscAbortRunningCount(toolState, 0)).toBe(1);
    const ctx = gateFor(toolState, 0);
    ctx.gate.handleEscape();
    expect(ctx.abortCtrl.signal.aborted).toBe(false);
    expect(ctx.modals).toHaveLength(1);
  });
});
