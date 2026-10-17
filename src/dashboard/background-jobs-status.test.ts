import { describe, expect, test } from 'bun:test';

import { createBackgroundJobsStatus } from './background-jobs-status.js';
import { createBackgroundSurface } from '../shell-runner/background-surface.js';
import type { ShellHandle, ShellResult, ShellStatus } from '../shell-runner/types.js';
import { backgroundJobsSegment } from '../status/bar.js';

function fakeHandle(id: string, mode: ShellHandle['mode'] = 'bg'): ShellHandle & { emitStatus: (s: ShellStatus) => void } {
  const statusSubs = new Set<(s: ShellStatus) => void>();
  let status: ShellStatus = 'running';
  return {
    id,
    mode,
    get status() { return status; },
    bookmark: { row: 0, col: 0, ts: 0, bytes: 0 },
    kill() {},
    background() { return false; },
    promote() { return false; },
    write() {},
    resize() {},
    onChunk() { return () => {}; },
    onStatus(cb) { statusSubs.add(cb); return () => { statusSubs.delete(cb); }; },
    onBoundary() { return () => {}; },
    result: new Promise<ShellResult>(() => {}),
    emitStatus(s) { status = s; for (const cb of statusSubs) cb(s); },
  };
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function wired() {
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const redraws: number[] = [];
  const status = createBackgroundJobsStatus({ log: (event, data) => { logs.push({ event, data }); } });
  const surf = createBackgroundSurface({
    retainCompletedMs: 0,
    // 대시보드 배선과 같은 꼴: 집계 → noteRollup → 바뀌었으면 다시 그림.
    onUpdate: (r) => {
      if (status.noteRollup({ running: r.running, backgrounded: r.backgrounded, background: r.background })) {
        redraws.push(status.summary().background);
      }
    },
  });
  return { logs, redraws, status, surf };
}

describe('background-jobs-status — TUI-BG-JOB-VISIBILITY (#71)', () => {
  test('bg 1 ∧ 턴 idle → «⧗ 백그라운드 1» · 끝나면 사라짐 · 관측 bg-jobs 두 줄', () => {
    const { logs, redraws, status, surf } = wired();
    const job = fakeHandle('job', 'bg');
    surf.track(job);
    expect(strip(backgroundJobsSegment(status.summary()))).toBe('⧗ 백그라운드 1');
    job.emitStatus('completed');
    expect(backgroundJobsSegment(status.summary())).toBe('');
    expect(redraws).toEqual([1, 0]);
    expect(logs.map((l) => l.data)).toEqual([
      { running: 1, backgrounded: 0, background: 1, trigger: 'rollup' },
      { running: 0, backgrounded: 0, background: 0, trigger: 'rollup' },
    ]);
    expect(logs.every((l) => l.event === 'bg-jobs')).toBe(true);
  });

  test('반증: 인라인(전경) 실행만 있으면 세그먼트 없음 · 관측도 없음(첫 집계 0 = 변화 없음)', () => {
    const { logs, redraws, status, surf } = wired();
    const inline = fakeHandle('in', 'inline');
    surf.track(inline);
    inline.emitStatus('completed');
    expect(backgroundJobsSegment(status.summary())).toBe('');
    expect(logs).toEqual([]);
    expect(redraws).toEqual([]);
  });

  test('같은 수의 집계 반복(출력 조각 등)은 관측·다시 그림을 남기지 않는다', () => {
    const status = createBackgroundJobsStatus({ log: () => {} });
    expect(status.noteRollup({ running: 1, backgrounded: 0, background: 1 })).toBe(true);
    expect(status.noteRollup({ running: 1, backgrounded: 0, background: 1 })).toBe(false);
    expect(status.noteRollup({ running: 2, backgrounded: 0, background: 1 })).toBe(false);
  });

  test('인라인을 뒤로 보내면(backgrounded) 센다', () => {
    const { status, surf } = wired();
    const h = fakeHandle('in', 'inline');
    surf.track(h);
    h.emitStatus('backgrounded');
    expect(status.summary()).toEqual({ background: 1 });
  });

  test('관측 실패는 상태줄을 막지 않는다', () => {
    const status = createBackgroundJobsStatus({ log: () => { throw new Error('log'); } });
    expect(status.noteRollup({ running: 1, backgrounded: 0, background: 1 })).toBe(true);
    expect(status.summary()).toEqual({ background: 1 });
  });

  test('반증: 깨우기 없음 — 모듈은 턴을 여는 길을 갖지 않는다', () => {
    expect(Object.keys(createBackgroundJobsStatus()).sort()).toEqual(['noteRollup', 'summary']);
  });
});
