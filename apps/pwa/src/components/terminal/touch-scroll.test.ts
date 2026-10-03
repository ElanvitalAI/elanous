import { describe, expect, test } from 'bun:test';
import { dispatchTouchWheel, historyAction, touchScrollAction, touchScrollLines, touchWheelLines } from './touch-scroll';

test('history tap chooses tmux copy mode + Page Up in alternate buffer, regardless of mouse tracking', () => {
  for (const mouseTracking of ['none', 'any', 'x10']) {
    expect(historyAction({ bufferType: 'alternate', mouseTracking }))
      .toEqual({ kind: 'send', data: '\x02[\x1b[5~' });
  }
});

test('history tap scrolls a page locally in normal buffer', () => {
  for (const mouseTracking of ['none', 'any']) {
    expect(historyAction({ bufferType: 'normal', mouseTracking }))
      .toEqual({ kind: 'scroll-pages', pages: -1 });
  }
});

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

describe('touchScrollAction — buffer별 터치 스크롤', () => {
  test('normal은 기존 touchScrollLines 결과를 그대로 스크롤백에 준다', () => {
    const input = { startY: 300, currentY: 390, cellHeight: 15, startViewportY: 2960, currentViewportY: 2956 };
    expect(touchScrollAction({ bufferType: 'normal', mouseTracking: 'none', lines: touchScrollLines(input) }))
      .toEqual({ kind: 'scrollback', lines: -2 });
    expect(touchScrollAction({ bufferType: 'normal', mouseTracking: 'none', lines: 0 })).toEqual({ kind: 'none' });
  });

  test('alternate는 mouse tracking이 켜져도 꺼져도 wheel이다', () => {
    for (const mouseTracking of ['none', 'any', 'x10']) {
      expect(touchScrollAction({ bufferType: 'alternate', mouseTracking, lines: -3 }))
        .toEqual({ kind: 'wheel', steps: -3 });
    }
  });

  test('방향과 빈 이동: 아래로 끌면 음수(과거), 위로 끌면 양수(최근)', () => {
    expect(touchScrollAction({ bufferType: 'alternate', mouseTracking: 'none', lines: 2 }))
      .toEqual({ kind: 'wheel', steps: 2 });
    expect(touchScrollAction({ bufferType: 'alternate', mouseTracking: 'none', lines: 0 }))
      .toEqual({ kind: 'none' });
  });

  test('wheel 제스처에서 이미 보낸 칸을 빼고 남은 칸만 보낸다', () => {
    const gesture = { startY: 300, currentY: 390, cellHeight: 15 };
    const first = touchScrollAction({ bufferType: 'alternate', mouseTracking: 'none', lines: touchWheelLines({ ...gesture, sentSteps: 0 }) });
    expect(first).toEqual({ kind: 'wheel', steps: -6 });
    const sentSteps = first.kind === 'wheel' ? first.steps : 0;
    expect(touchScrollAction({ bufferType: 'alternate', mouseTracking: 'none', lines: touchWheelLines({ ...gesture, sentSteps }) }))
      .toEqual({ kind: 'none' });
    expect(touchScrollAction({ bufferType: 'alternate', mouseTracking: 'none', lines: touchWheelLines({ ...gesture, currentY: 420, sentSteps }) }))
      .toEqual({ kind: 'wheel', steps: -2 });
    expect(touchWheelLines({ ...gesture, currentY: 500, cellHeight: 0, sentSteps })).toBe(0);
  });
});

test('wheel touchmove dispatches one WheelEvent per step to the xterm target', () => {
  const originalWheelEvent = globalThis.WheelEvent;
  class TestWheelEvent extends Event {
    readonly deltaY: number;
    readonly deltaMode: number;
    readonly clientX: number;
    readonly clientY: number;
    constructor(type: string, init: WheelEventInit) {
      super(type, init);
      this.deltaY = init.deltaY ?? 0;
      this.deltaMode = init.deltaMode ?? 0;
      this.clientX = init.clientX ?? 0;
      this.clientY = init.clientY ?? 0;
    }
  }
  globalThis.WheelEvent = TestWheelEvent as unknown as typeof WheelEvent;
  try {
    const events: WheelEvent[] = [];
    const target = { dispatchEvent(event: Event) { events.push(event as WheelEvent); return true; } };
    dispatchTouchWheel(target, -3, 42, 135);
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event).toBeInstanceOf(WheelEvent);
      expect(event.type).toBe('wheel');
      expect(event.deltaY).toBeLessThan(0);
      expect(event.deltaMode).toBe(0);
      expect(event.clientX).toBe(42);
      expect(event.clientY).toBe(135);
      expect(event.bubbles).toBe(true);
      expect(event.cancelable).toBe(true);
    }
    dispatchTouchWheel(target, 2, 17, 82);
    expect(events).toHaveLength(5);
    expect(events.slice(3).map((event) => Math.sign(event.deltaY))).toEqual([1, 1]);
  } finally {
    globalThis.WheelEvent = originalWheelEvent;
  }
});
