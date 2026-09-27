import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  composeDashboardFrameWithCoordinatorModal,
  renderDashboardFrame,
  type DashboardFrameInput,
} from '../src/dashboard/index.js';
import { createEscAbortGate } from '../src/esc-abort-gate.js';
import { DisplayCoordinator } from '../src/display/coordinator.js';
import { DEFAULT_THEME_TOKENS } from '../src/theme/tokens.js';
import type { RenderOptions } from '../src/tui.js';

const frameInput: DashboardFrameInput = {
  overlay: '',
  force: false,
  cursorOwner: 'none',
  claimedCursor: null,
  coordinatorCursor: null,
  promptCaret: null,
  suppressPromptArea: false,
};

function createStreamingDashboard(running: () => number, waitingTargets: readonly string[] = []) {
  const abortCtrl = new AbortController();
  const display = new DisplayCoordinator();
  const chatLines = ['streaming answer', 'running task'];
  const frames: Array<{ lines: string[]; options: RenderOptions }> = [];
  const redraws: number[] = [];
  const draw = () => {
    renderDashboardFrame(chatLines, composeDashboardFrameWithCoordinatorModal(display, {
      ...frameInput,
      force: redraws.length > 0,
    }), (lines, options) => { frames.push({ lines, options }); });
  };
  const formatTargets = (targets: readonly string[]) => targets.length > 0 ? targets.join(', ') : 'the running turn';
  const gate = createEscAbortGate({
    abortCtrl,
    getRunningCount: running,
    mountModal: surface => display.pushModal(surface).dispose,
    getViewport: () => ({ cols: 100, rows: 30 }),
    requestRedraw: () => {
      redraws.push(frames.length);
      draw();
    },
    getTheme: () => DEFAULT_THEME_TOKENS,
    getWaitingTargetNames: () => waitingTargets,
    onAbortPending: ({ targets }) => {
      chatLines.push(`abort requested; waiting for ${formatTargets(targets)}`);
    },
    onAbortRepeat: ({ repeat, targets }) => {
      chatLines.push(`ESC repeat ${repeat}; waiting for ${formatTargets(targets)}`);
    },
  });
  return { abortCtrl, draw, frames, gate, redraws };
}

function latestFrameText(ctx: ReturnType<typeof createStreamingDashboard>): string {
  const frame = ctx.frames.at(-1);
  expect(frame).toBeDefined();
  return `${frame!.lines.join('\n')}\n${frame!.options.overlay}`;
}

describe('ESC abort confirmation composed-screen visibility', () => {
  test('streaming ESC redraws the final dashboard frame, persists across frames, and clears after Keep', async () => {
    const ctx = createStreamingDashboard(() => 1);

    ctx.draw();
    ctx.gate.handleEscape();

    expect(ctx.abortCtrl.signal.aborted).toBe(false);
    expect(ctx.gate.isGateOpen()).toBe(true);
    expect(ctx.redraws).toEqual([1]);
    expect(latestFrameText(ctx)).toContain('Stop this turn?');

    for (let redraw = 0; redraw < 3; redraw++) {
      ctx.draw();
      expect(latestFrameText(ctx)).toContain('Stop this turn?');
    }

    expect(ctx.gate.handleKey({ name: 'n' })).toBe(true);
    await Promise.resolve();
    expect(ctx.gate.isGateOpen()).toBe(false);
    expect(ctx.abortCtrl.signal.aborted).toBe(false);
    expect(ctx.redraws).toEqual([1, 5]);
    expect(latestFrameText(ctx)).not.toContain('Stop this turn?');
    expect(latestFrameText(ctx)).toContain('streaming answer');
  });

  test('no running sub-agent work aborts immediately and redraws a pending wait message with the tool name', () => {
    const ctx = createStreamingDashboard(() => 0, ['Read']);

    ctx.draw();
    ctx.gate.handleEscape();

    expect(ctx.abortCtrl.signal.aborted).toBe(true);
    expect(ctx.gate.isGateOpen()).toBe(false);
    expect(ctx.redraws).toEqual([1]);
    expect(latestFrameText(ctx)).not.toContain('Stop this turn?');
    expect(latestFrameText(ctx)).toContain('abort requested; waiting for Read');
  });

  test('repeated Escape after an abort request redraws a distinct waiting message with the target name', async () => {
    const ctx = createStreamingDashboard(() => 0, ['Read']);

    ctx.draw();
    ctx.gate.handleEscape();
    ctx.gate.handleEscape();

    expect(ctx.abortCtrl.signal.aborted).toBe(true);
    expect(ctx.redraws).toEqual([1, 2]);
    expect(latestFrameText(ctx)).toContain('abort requested; waiting for Read');
    expect(latestFrameText(ctx)).toContain('ESC repeat 1; waiting for Read');
  });

  test('showDashboard frame flush composes coordinator modals before rendering', () => {
    const source = readFileSync(new URL('../src/dashboard/index.ts', import.meta.url), 'utf8');
    const showDashboardAt = source.indexOf('export async function showDashboard(');
    const frameFlush = source.indexOf('renderDashboardFrame(baseLines, composeDashboardFrameWithCoordinatorModal(display, {', showDashboardAt);

    expect(showDashboardAt).toBeGreaterThan(-1);
    expect(frameFlush).toBeGreaterThan(showDashboardAt);
  });
});
