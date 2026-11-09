import { describe, expect, test } from 'bun:test';
import { visibleWidth } from '../src/tui.js';
import { fitStatusSegments, statusSegmentKind, truncateToVisibleWidth, clampPillsToWidth } from '../src/dashboard/input/mouse-status-line.js';

describe('mouse status line leaf', () => {
  test('필수 «⧗» 는 폭이 빠듯해도 남고 앞의 선택 세그먼트가 대신 빠진다', () => {
    // 첫 칸 10 · 선택 30 · 필수 8 · 구분자 3 · 폭 25 → 선택(30)은 필수 몫(3+8)을 남길 수 없어 빠진다.
    const width = 25;
    const fit = fitStatusSegments([10, 30, 8], 3, width, [false, false, true]);
    expect(fit.placed.map((p) => p.index)).toEqual([0, 2]);
    expect(fit.dropped).toEqual([1]);
    expect(fit.width).toBeLessThanOrEqual(width);
    // 반증: 필수 표시가 없으면 같은 폭에서 «⧗» 자리(2)가 빠질 수 있다.
    expect(fitStatusSegments([10, 10, 8], 3, 25).dropped).toEqual([2]);
    expect(fitStatusSegments([10, 10, 8], 3, 25, [false, false, true]).placed.map((p) => p.index)).toEqual([0, 2]);
  });


  test('truncateToVisibleWidth — 실폭이 예산 이하가 될 때까지 · 0 이면 빈 문자열', () => {
    const wide = '📁🐚📁🐚📁🐚📁🐚 백그라운드 백그라운드';
    // ⚡ 는 truncate(코드포인트 폭)가 1칸으로 세지만 실폭 2칸 — truncate(…, 5) 가 9칸을 낸다(재시도 상한이 있으면 못 맞춘다).
    const bolts = '⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡';
    for (const budget of [1, 2, 3, 5, 9, 17]) {
      expect(visibleWidth(truncateToVisibleWidth(wide, budget))).toBeLessThanOrEqual(budget);
      expect(visibleWidth(truncateToVisibleWidth(bolts, budget))).toBeLessThanOrEqual(budget);
    }
    expect(truncateToVisibleWidth(wide, 0)).toBe('');
    expect(truncateToVisibleWidth('abc', 10)).toBe('abc');
  });


  test('clampPillsToWidth — 보이는 폭 밖 pill 은 빼고 걸친 pill 은 줄인다', () => {
    const pills = [
      { name: 'workingDir' as const, startCol: 0, endCol: 8 },
      { name: 'model' as const, startCol: 6, endCol: 14 },
      { name: 'mode' as const, startCol: 12, endCol: 16 },
    ];
    expect(clampPillsToWidth(pills, 10)).toEqual([
      { name: 'workingDir', startCol: 0, endCol: 8 },
      { name: 'model', startCol: 6, endCol: 10 },
    ]);
  });


  test('statusSegmentKind — 첫 낱말만', () => {
    expect(statusSegmentKind('\x1b[33mctx 15k\x1b[0m')).toBe('ctx');
    expect(statusSegmentKind('🐚 1⏸')).toBe('🐚');
  });


  test('fitStatusSegments — 넘치는 것만 건너뛰고 뒤의 작은 것은 넣는다 · 첫 칸은 늘 둔다', () => {
    const fit = fitStatusSegments([10, 20, 3], 3, 20);
    expect(fit.placed.map((p) => p.index)).toEqual([0, 2]);
    expect(fit.dropped).toEqual([1]);
    expect(fit.placed[1]).toEqual({ index: 2, startCol: 13, width: 3 });
    expect(fit.width).toBe(16);
    expect(fitStatusSegments([30], 3, 10).placed.map((p) => p.index)).toEqual([0]);
  });
});
