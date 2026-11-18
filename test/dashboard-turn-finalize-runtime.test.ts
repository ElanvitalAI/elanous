import { describe, expect, test } from 'bun:test';

import { finalizeDashboardTurn } from '../src/dashboard/turn-finalize-runtime.js';

describe('finalizeDashboardTurn', () => {
  test('commits the footer marker and drains quick-control when armed', () => {
    const lines: string[] = [];
    const events: string[] = [];
    const thinking = {
      stop: (opts: { status: string; errorText?: string }) => {
        events.push(`stop:${opts.status}:${opts.errorText ?? ''}`);
      },
    } as any;
    const footer = { current: 'done marker' };

    finalizeDashboardTurn({
      thinking,
      finalStatus: 'completed',
      turnStartedAt: Date.now() - 42_000,
      backgroundRunning: 2,
      engineBadge: '',
      chatFooterLine: footer,
      pushChatLine: (line) => { lines.push(line); },
      setChatScrollBottom: () => { events.push('scroll'); },
      consumeQuickControl: () => true,
      muted: (text) => `muted:${text}`,
      accent: (text) => `blue:${text}`,
      draw: () => { events.push('draw'); },
    });

    expect(lines).toEqual([
      expect.stringMatching(/^blue:✻ Worked for 42s · done \d{1,2}:\d{2} (AM|PM) · 2 background running$/),
      'muted:  (quick-control consumed — back to chat)',
    ]);
    expect(footer.current).toBe(lines[0]);
    expect(events).toEqual([
      'stop:completed:',
      'scroll',
      'scroll',
      'draw',
    ]);
  });

  test('handles missing footer and failed status', () => {
    const lines: string[] = [];
    const events: string[] = [];
    finalizeDashboardTurn({
      thinking: {
        stop: (opts: { status: string; errorText?: string }) => {
          events.push(`stop:${opts.status}:${opts.errorText}`);
        },
      } as any,
      finalStatus: 'failed',
      turnStartedAt: Date.now() - 182_000,
      engineBadge: '',
      finalError: 'boom',
      chatFooterLine: { current: null },
      pushChatLine: (line) => { lines.push(line); },
      setChatScrollBottom: () => { events.push('scroll'); },
      consumeQuickControl: () => false,
      muted: (text) => text,
      accent: (text) => `blue:${text}`,
      draw: () => { events.push('draw'); },
    });

    expect(lines).toEqual([expect.stringMatching(/^blue:✻ Stopped after 3m 2s · \d{1,2}:\d{2} (AM|PM)$/)]);
    expect(events).toEqual(['stop:failed:boom', 'scroll', 'draw']);
  });
});
