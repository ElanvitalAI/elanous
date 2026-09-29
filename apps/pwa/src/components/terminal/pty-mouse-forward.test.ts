import { describe, expect, test } from 'bun:test';
import { cellFromPoint, isMouseModeOff, mouseButtonName } from './pty-mouse-forward';

describe('cellFromPoint — 화면 픽셀 → 1 기반 셀', () => {
  const rect = { left: 100, top: 50, width: 800, height: 480 }; // 80×24 → 셀 10×20px
  test('왼쪽 위 칸은 (1,1) · 가운데는 그 칸', () => {
    expect(cellFromPoint(100, 50, rect, 80, 24)).toEqual({ x: 1, y: 1 });
    expect(cellFromPoint(100 + 10 * 39 + 5, 50 + 20 * 11 + 5, rect, 80, 24)).toEqual({ x: 40, y: 12 });
  });
  test('밖이면 가장자리로 자른다', () => {
    expect(cellFromPoint(0, 0, rect, 80, 24)).toEqual({ x: 1, y: 1 });
    expect(cellFromPoint(5000, 5000, rect, 80, 24)).toEqual({ x: 80, y: 24 });
  });
  test('크기를 모르면 null', () => {
    expect(cellFromPoint(10, 10, { left: 0, top: 0, width: 0, height: 10 }, 80, 24)).toBeNull();
  });
});

describe('mouseButtonName · isMouseModeOff', () => {
  test('0·1·2 만 넘긴다', () => {
    expect([0, 1, 2, 3].map(mouseButtonName)).toEqual(['left', 'middle', 'right', null]);
  });
  test('서버 거절 문면(#21609 MOUSE_MODE_OFF_REASON)을 알아본다', () => {
    expect(isMouseModeOff('PTY mouse mode is off or SGR ?1006 is not enabled')).toBe(true);
    expect(isMouseModeOff('owner unreachable')).toBe(false);
  });
});
