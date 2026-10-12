import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createBootTimer } from './boot-timing.js';
import { debug } from '../debug/log.js';
import { render, setFrameObserver } from '../tui.js';
import { renderDashboardFrame } from './index.js';

const dashboardFrame = (onFrameWriteComplete: (error?: Error | null) => void) =>
  renderDashboardFrame(['dashboard screen'], {
    overlay: '', force: true, cursorOwner: 'none', claimedCursor: null,
    promptCaret: null, suppressPromptArea: false, onFrameWriteComplete,
  });

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

  it('records a dashboard frame only after its own write settles and keeps self-report', () => {
    const flushes: Array<(error?: Error) => void> = [];
    const write = spyOn(process.stdout, 'write').mockImplementation((_chunk: any, callback?: any) => {
      if (typeof callback === 'function') flushes.push(callback);
      return true;
    });
    let firstFrames = 0;
    let selfReportFrames = 0;
    setFrameObserver(() => { selfReportFrames++; });
    try {
      dashboardFrame((error) => { if (!error) firstFrames++; });
      render(['unrelated screen'], { force: true });
      expect(firstFrames).toBe(0);
      expect(selfReportFrames).toBe(2);
      expect(flushes).toHaveLength(1);
      flushes[0]!();
      expect(firstFrames).toBe(1);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      setFrameObserver(null);
      write.mockRestore();
    }
  });

  it('ignores a failed dashboard write and lets a later successful dashboard frame finish', () => {
    const flushes: Array<(error?: Error) => void> = [];
    const write = spyOn(process.stdout, 'write').mockImplementation((_chunk: any, callback?: any) => {
      if (typeof callback === 'function') flushes.push(callback);
      return true;
    });
    let done = 0;
    const onFrameWriteComplete = (error?: Error | null) => { if (!error && done === 0) done++; };
    try {
      dashboardFrame(onFrameWriteComplete);
      dashboardFrame(onFrameWriteComplete);
      expect(done).toBe(0);
      flushes[0]!(new Error('stdout failed'));
      expect(done).toBe(0);
      flushes[1]!();
      expect(done).toBe(1);
    } finally {
      write.mockRestore();
    }
  });
});
