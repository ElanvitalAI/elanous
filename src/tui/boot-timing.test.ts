import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createBootTimer } from './boot-timing.js';
import { debug } from '../debug/log.js';

// 출처: #38819 src/dashboard/boot-timing.test.ts createBootTimer 블록 그대로 이동(숫자 기대값 불변 · dashboard retire r3)
describe('createBootTimer', () => {
  afterEach(() => { spyOn(debug, 'log').mockRestore(); });
  it('records exact phase durations and one summary with the slowest phase', () => {
    const entries: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    spyOn(debug, 'log').mockImplementation((category, event, data) => {
      entries.push({ category, event, data: data as Record<string, unknown> });
    });

    let time = 100;
    const timer = createBootTimer(() => time);
    time = 105;
    timer.begin();
    time = 115;
    timer.phase('log-sink');
    time = 120;
    timer.begin();
    time = 140;
    timer.phase('self-report');
    time = 145;
    timer.begin();
    time = 150;
    timer.phase('dashboard');
    time = 160;
    timer.done();
    timer.done();

    expect(entries.filter((entry) => entry.event === 'phase').map((entry) => entry.data)).toEqual([
      { phase: 'log-sink', ms: 10 },
      { phase: 'self-report', ms: 20 },
      { phase: 'dashboard', ms: 5 },
    ]);
    const summaries = entries.filter((entry) => entry.event === 'summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.category).toBe('tui.boot');
    expect(summaries[0]?.data).toEqual({ totalMs: 60, slowest: { phase: 'self-report', ms: 20 } });
  });

  it('does not let logging exceptions escape phase or done', () => {
    spyOn(debug, 'log').mockImplementation(() => { throw new Error('logging failed'); });
    let time = 0;
    const timer = createBootTimer(() => time);
    time = 10;
    expect(() => timer.phase('log-sink')).not.toThrow();
    time = 20;
    expect(() => timer.done()).not.toThrow();
  });
});
