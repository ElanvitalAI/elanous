import { describe, expect, test } from 'bun:test';
import { touchScrollLines } from './touch-scroll';

describe('touchScrollLines — 손가락 끌기 → 스크롤백 줄 수', () => {
  const base = { startY: 300, cellHeight: 15, startViewportY: 2960, currentViewportY: 2960 };

  test('아래로 끌면 과거(위)로 간다 — 45px = 3줄', () => {
    expect(touchScrollLines({ ...base, currentY: 345 })).toBe(-3);
  });

  test('위로 끌면 최근(아래)으로 간다', () => {
    expect(touchScrollLines({ ...base, currentY: 270 })).toBe(2);
  });

  test('한 줄이 안 되는 끌기는 아무것도 안 한다', () => {
    expect(touchScrollLines({ ...base, currentY: 310 })).toBe(0);
  });

  test('이미 민 만큼은 빼고 모자란 만큼만 민다 — 네이티브 스크롤과 두 번 밀지 않는다', () => {
    expect(touchScrollLines({ ...base, currentY: 390, currentViewportY: 2956 })).toBe(-2);
    expect(touchScrollLines({ ...base, currentY: 390, currentViewportY: 2954 })).toBe(0);
  });

  test('줄 높이를 모르면 움직이지 않는다', () => {
    expect(touchScrollLines({ ...base, currentY: 500, cellHeight: 0 })).toBe(0);
  });
});
