// Unit test for the terminal resize listener — fills the documented
// "readKey / mouse / resize" coordinator entry triplet
// (CAPABILITIES-display.md §1.3) that previously had no SIGWINCH /
// stdout resize handler attached.

import { afterEach, describe, expect, test } from 'bun:test';
import { installResizeListener } from '../src/display/resize-listener.js';

describe('installResizeListener', () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) {
      const d = disposers.pop();
      if (d) d();
    }
  });

  test('forwards stdout resize events to draw({force:true}) and promptCtl.repaint', () => {
    let drawCalls = 0;
    let drawForce: boolean | undefined;
    let repaintCalls = 0;
    const dispose = installResizeListener({
      draw: (opts) => {
        drawCalls++;
        drawForce = opts?.force;
      },
      promptCtl: { repaint: () => { repaintCalls++; } },
    });
    disposers.push(dispose);

    process.stdout.emit('resize');
    expect(drawCalls).toBe(1);
    expect(drawForce).toBe(true);
    expect(repaintCalls).toBe(1);

    process.stdout.emit('resize');
    expect(drawCalls).toBe(2);
    expect(repaintCalls).toBe(2);
  });

  test('dispose detaches the listener so later resize events are ignored', () => {
    let drawCalls = 0;
    const dispose = installResizeListener({
      draw: () => { drawCalls++; },
      promptCtl: { repaint: () => {} },
    });

    process.stdout.emit('resize');
    expect(drawCalls).toBe(1);

    dispose();
    process.stdout.emit('resize');
    expect(drawCalls).toBe(1);
  });

  test('swallows draw errors so a transient paint failure does not kill the listener', () => {
    let drawCalls = 0;
    let repaintCalls = 0;
    const dispose = installResizeListener({
      draw: () => { drawCalls++; throw new Error('boom'); },
      promptCtl: { repaint: () => { repaintCalls++; } },
    });
    disposers.push(dispose);

    expect(() => process.stdout.emit('resize')).not.toThrow();
    // draw threw but promptCtl.repaint still ran
    expect(drawCalls).toBe(1);
    expect(repaintCalls).toBe(1);
  });

  test('swallows promptCtl.repaint errors independently', () => {
    let drawCalls = 0;
    let repaintCalls = 0;
    const dispose = installResizeListener({
      draw: () => { drawCalls++; },
      promptCtl: { repaint: () => { repaintCalls++; throw new Error('repaint-boom'); } },
    });
    disposers.push(dispose);

    expect(() => process.stdout.emit('resize')).not.toThrow();
    expect(drawCalls).toBe(1);
    expect(repaintCalls).toBe(1);
  });

  test('requestOverlayFrame runs LAST so modal overlays land on top of the prompt chrome (TUI-PICKER-RESIZE-SHRINK)', () => {
    const order: string[] = [];
    const dispose = installResizeListener({
      draw: () => { order.push('draw'); },
      promptCtl: { repaint: () => { order.push('repaint'); } },
      requestOverlayFrame: () => { order.push('overlay-frame'); },
    });
    disposers.push(dispose);

    process.stdout.emit('resize');
    expect(order).toEqual(['draw', 'repaint', 'overlay-frame']);
  });

  test('swallows requestOverlayFrame errors so the listener survives', () => {
    let overlayCalls = 0;
    const dispose = installResizeListener({
      draw: () => {},
      promptCtl: { repaint: () => {} },
      requestOverlayFrame: () => { overlayCalls++; throw new Error('frame-boom'); },
    });
    disposers.push(dispose);

    expect(() => process.stdout.emit('resize')).not.toThrow();
    expect(() => process.stdout.emit('resize')).not.toThrow();
    expect(overlayCalls).toBe(2);
  });
});
