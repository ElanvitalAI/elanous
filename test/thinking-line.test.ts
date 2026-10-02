// ── Thinking line tests ──
//
// Verifies the in-log animated progress indicator:
//   - pushes a single line into chatLines on start
//   - mutates in-place on tick (doesn't add more lines)
//   - stop(completed/interrupted/failed) freezes the line with the
//     right marker; the line STAYS in chatLines so the log keeps
//     history of prior turns
//   - updateMetrics reflects in the rendered parenthetical
//
// Uses intervalMs: 0 to disable the timer and drive ticks manually
// via metric/message updates.

import { describe, test, expect } from 'bun:test';
import { startPinnedThinking, startThinking, fmtTime } from '../src/thinking-line';

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('fmtTime', () => {
  test('sub-minute', () => { expect(fmtTime(7)).toBe('7s'); });
  test('minutes', () => { expect(fmtTime(135)).toBe('2m 15s'); });
  test('hours', () => { expect(fmtTime(3720)).toBe('1h 2m'); });
  test('rounds non-integer', () => { expect(fmtTime(7.4)).toBe('7s'); });
  test('clamps negatives to 0', () => { expect(fmtTime(-5)).toBe('0s'); });
});

describe('startThinking', () => {
  test('pushes one line on start', () => {
    const chatLines: string[] = ['first', 'second'];
    const frames: number[] = [];
    const h = startThinking({
      chatLines, onFrame: () => frames.push(chatLines.length),
      message: 'Thinking', intervalMs: 0,
    });
    expect(chatLines.length).toBe(3);
    expect(strip(chatLines[2])).toContain('Thinking…');
    h.stop();
  });

  test('update() changes the verb on next frame', () => {
    const chatLines: string[] = [];
    const h = startThinking({ chatLines, onFrame: () => {}, intervalMs: 0 });
    h.update('Streaming');
    h.reflow();
    expect(strip(chatLines[0])).toContain('Streaming…');
    h.stop({ status: 'completed' });
    expect(strip(chatLines[0])).toContain('✔ 완료');
    expect(strip(chatLines[0])).not.toContain('Streaming');
  });

  test('updateAnimated() derives the message from the animation frame', () => {
    const chatLines: string[] = [];
    const h = startThinking({ chatLines, onFrame: () => {}, intervalMs: 0 });
    h.updateAnimated(frame => `Agents frame ${frame}`);
    h.reflow();
    expect(strip(chatLines[0])).toContain('Agents frame 0');
    h.reflow();
    expect(strip(chatLines[0])).toContain('Agents frame 1');
  });

  test('stop(completed) freezes with tick + elapsed', async () => {
    const chatLines: string[] = [];
    const h = startThinking({
      chatLines, onFrame: () => {}, intervalMs: 0,
      metrics: { startedAt: Date.now() - 3000 },
    });
    h.stop({ status: 'completed' });
    expect(chatLines.length).toBe(1);
    expect(strip(chatLines[0])).toContain('✔ 완료');
    expect(strip(chatLines[0])).not.toContain('Thinking');
    expect(strip(chatLines[0])).toMatch(/3s|4s|2s/);   // tolerate ms jitter
  });

  test('stop(interrupted) freezes with cross + "중단됨"', () => {
    const chatLines: string[] = [];
    const h = startThinking({ chatLines, onFrame: () => {}, intervalMs: 0 });
    h.stop({ status: 'interrupted' });
    const s = strip(chatLines[0]);
    expect(s).toContain('✘ 중단됨');
    expect(s).not.toContain('interrupted');
    expect(s).not.toContain('Thinking');
  });

  test('stop(failed) with errorText', () => {
    const chatLines: string[] = [];
    const h = startThinking({ chatLines, onFrame: () => {}, intervalMs: 0 });
    h.stop({ status: 'failed', errorText: 'rate limit' });
    const s = strip(chatLines[0]);
    expect(s).toContain('✘ 실패 — rate limit');
    expect(s).not.toContain('Thinking');
  });

  test('stop(completed) keeps line in chatLines (does NOT splice)', () => {
    const chatLines: string[] = ['earlier', 'work'];
    const h = startThinking({ chatLines, onFrame: () => {}, intervalMs: 0 });
    expect(chatLines.length).toBe(3);
    h.stop({ status: 'completed' });
    // Line still present → log retains history of this turn.
    expect(chatLines.length).toBe(3);
  });

  test('updateMetrics surfaces in rendered detail', () => {
    const chatLines: string[] = [];
    const h = startThinking({
      chatLines, onFrame: () => {}, intervalMs: 0,
      metrics: { startedAt: Date.now() },
    });
    h.updateMetrics({ outputTokens: 1742 });
    h.stop({ status: 'completed' });
    expect(strip(chatLines[0])).toContain('1.7k tokens');
  });

  test('pinned live hint follows every detail and is omitted after interruption', () => {
    const target: { current: string | null } = { current: null };
    const h = startPinnedThinking({
      target,
      onFrame: () => {},
      intervalMs: 0,
      metrics: {
        startedAt: Date.now() - 5000,
        outputTokens: 91,
        thoughtSec: 2,
        engine: '🧠 terra',
        hint: 'esc 중단',
      },
    });
    const live = strip(target.current!);
    const elapsed = live.indexOf('5s');
    const tokens = live.indexOf('↓ 91 tokens');
    const thought = live.indexOf('thought for 2s');
    const engine = live.indexOf('🧠 terra');
    const hint = live.indexOf('esc 중단');
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(tokens).toBeGreaterThanOrEqual(0);
    expect(thought).toBeGreaterThanOrEqual(0);
    expect(engine).toBeGreaterThanOrEqual(0);
    expect(hint).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(tokens);
    expect(tokens).toBeLessThan(thought);
    expect(thought).toBeLessThan(engine);
    expect(engine).toBeLessThan(hint);
    expect(live.slice(hint + 'esc 중단'.length)).toBe(')');

    h.stop({ status: 'interrupted' });
    const stopped = strip(target.current!);
    expect(stopped).toContain('✘ 중단됨');
    expect(stopped).not.toContain('interrupted');
    expect(stopped).not.toContain('esc 중단');
    expect(stopped).toContain('(5s · ↓ 91 tokens · 🧠 terra)');
  });

  test('in-log stopped statuses preserve task name and metrics', () => {
    for (const [status, label] of [
      ['completed', '✔ Compacting 완료'],
      ['interrupted', '✘ Compacting 중단됨'],
      ['failed', '✘ Compacting 실패 — timeout'],
    ] as const) {
      const chatLines: string[] = [];
      const h = startThinking({
        chatLines, onFrame: () => {}, intervalMs: 0, message: 'Compacting',
        metrics: { startedAt: Date.now() - 5000, outputTokens: 28, engine: '🧠 terra' },
      });
      h.stop({ status, errorText: 'timeout' });
      expect(strip(chatLines[0])).toBe(`${label}  (5s · ↓ 28 tokens · 🧠 terra)`);
    }
  });

  test('pinned stopped statuses replace progress verbs and preserve task names', () => {
    for (const [status, message, label] of [
      ['completed', 'Streaming', '✔ 완료'],
      ['interrupted', 'Streaming', '✘ 중단됨'],
      ['failed', 'Thinking', '✘ 실패 — timeout'],
      ['completed', 'Compacting', '✔ Compacting 완료'],
      ['interrupted', 'Compacting', '✘ Compacting 중단됨'],
      ['failed', 'Compacting', '✘ Compacting 실패 — timeout'],
    ] as const) {
      const target: { current: string | null } = { current: null };
      const h = startPinnedThinking({
        target, onFrame: () => {}, intervalMs: 0, message,
        metrics: { startedAt: Date.now() - 5000, outputTokens: 28, engine: '🧠 terra' },
      });
      if (message === 'Streaming') expect(strip(target.current!)).toContain('Streaming…');
      h.stop({ status, errorText: 'timeout' });
      expect(strip(target.current!)).toBe(`${label}  (5s · ↓ 28 tokens · 🧠 terra)`);
    }
  });

  test('animated progress verbs lose the verb but keep the named work after stop', () => {
    const target: { current: string | null } = { current: null };
    const h = startPinnedThinking({ target, onFrame: () => {}, intervalMs: 0 });
    h.updateAnimated(() => 'Streaming Agent (2 tools)');
    expect(strip(target.current!)).toContain('Streaming Agent (2 tools)…');
    h.stop({ status: 'completed' });
    expect(strip(target.current!)).toContain('✔ Agent (2 tools) 완료');
    expect(strip(target.current!)).not.toContain('Streaming');
  });

  test('pinned finalText overrides outcome and metrics verbatim', () => {
    const target: { current: string | null } = { current: null };
    const h = startPinnedThinking({ target, onFrame: () => {}, intervalMs: 0 });
    h.stop({ status: 'failed', errorText: 'timeout', finalText: 'verbatim line' });
    expect(target.current).toBe('verbatim line');

    const empty = startPinnedThinking({ target, onFrame: () => {}, intervalMs: 0 });
    empty.stop({ finalText: '' });
    expect(target.current).toBe('');
  });

  test('onFrame fires on start and stop', () => {
    const chatLines: string[] = [];
    let frames = 0;
    const h = startThinking({
      chatLines, onFrame: () => { frames++; }, intervalMs: 0,
    });
    // Start path doesn't call onFrame (initial push is synchronous).
    // stop() triggers one final onFrame.
    h.stop({ status: 'completed' });
    expect(frames).toBeGreaterThanOrEqual(1);
  });

  test('double-stop is idempotent', () => {
    const chatLines: string[] = [];
    const h = startThinking({ chatLines, onFrame: () => {}, intervalMs: 0 });
    h.stop({ status: 'completed' });
    const snapshot = [...chatLines];
    h.stop({ status: 'failed' });
    expect(chatLines).toEqual(snapshot);
  });

  test('custom finalText overrides status styling', () => {
    const chatLines: string[] = [];
    const h = startThinking({ chatLines, onFrame: () => {}, intervalMs: 0 });
    h.stop({ status: 'completed', finalText: 'verbatim line' });
    expect(chatLines[0]).toBe('verbatim line');

    const empty = startThinking({ chatLines, onFrame: () => {}, intervalMs: 0 });
    empty.stop({ finalText: '' });
    expect(chatLines[1]).toBe('');
  });
});
