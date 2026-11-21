import { describe, expect, test } from 'bun:test';
import { createPinchZoom } from './pinch-zoom';

const touches = (distance: number) => [{ clientX: 0, clientY: 0 }, { clientX: distance, clientY: 0 }];

describe('terminal pinch zoom', () => {
  test('each gesture changes at most one step, with a dead zone and bounds', () => {
    const pinch = createPinchZoom();
    expect(pinch.start(touches(100), 13)).toBe(true);
    expect(pinch.move(touches(103))).toBeNull();
    expect(pinch.move(touches(120))).toBe(14);
    expect(pinch.move(touches(400))).toBeNull();
    expect(pinch.start(touches(100), 13)).toBe(true);
    expect(pinch.move(touches(40))).toBe(12);
    expect(pinch.start(touches(100), 32)).toBe(true);
    expect(pinch.move(touches(200))).toBe(32);
    expect(pinch.start(touches(100), 9)).toBe(true);
    expect(pinch.move(touches(40))).toBe(9);
  });

  test('single finger, zero distance, cancellation and a third finger cannot zoom', () => {
    const pinch = createPinchZoom();
    expect(pinch.start(touches(0), 13)).toBe(false);
    expect(pinch.start([{ clientX: 0, clientY: 0 }], 13)).toBe(false);
    expect(pinch.start(touches(100), 13)).toBe(true);
    expect(pinch.move([...touches(200), { clientX: 0, clientY: 1 }])).toBeNull();
    expect(pinch.move(touches(200))).toBeNull();
    expect(pinch.start(touches(100), 13)).toBe(true);
    pinch.cancel();
    expect(pinch.move(touches(200))).toBeNull();
  });
});
