import { describe, expect, test } from 'bun:test';
import {
  SYNCHRONIZED_OUTPUT_BEGIN,
  SYNCHRONIZED_OUTPUT_END,
  isSynchronizedOutputRegionOpen,
  openSynchronizedOutputRegion,
  synchronizedOutputDisabledByEnv,
} from './synchronized-output-region.js';
import { beginSynchronizedFrameOutput } from '../dashboard/synchronized-frame-output.js';

function sink(): { chunks: string[]; write: (chunk: string) => void; text: () => string } {
  const chunks: string[] = [];
  return {
    chunks,
    write: (chunk: string) => {
      chunks.push(chunk);
    },
    text: () => chunks.join(''),
  };
}

describe('synchronized output region registry', () => {
  test('nested opener does not own the byte pair', () => {
    expect(isSynchronizedOutputRegionOpen()).toBe(false);
    const outer = openSynchronizedOutputRegion();
    expect(outer.outermost).toBe(true);
    expect(isSynchronizedOutputRegionOpen()).toBe(true);
    const inner = openSynchronizedOutputRegion();
    expect(inner.outermost).toBe(false);
    inner.close();
    expect(isSynchronizedOutputRegionOpen()).toBe(true);
    outer.close();
    expect(isSynchronizedOutputRegionOpen()).toBe(false);
  });

  test('close is idempotent and never drives the depth negative', () => {
    const outer = openSynchronizedOutputRegion();
    outer.close();
    outer.close();
    expect(isSynchronizedOutputRegionOpen()).toBe(false);
    const next = openSynchronizedOutputRegion();
    expect(next.outermost).toBe(true);
    next.close();
  });

  test('env escape hatch reads off/0/false only', () => {
    expect(synchronizedOutputDisabledByEnv({})).toBe(false);
    expect(synchronizedOutputDisabledByEnv({ ELANOUS_SYNC_OUTPUT: 'on' })).toBe(false);
    expect(synchronizedOutputDisabledByEnv({ ELANOUS_SYNC_OUTPUT: 'off' })).toBe(true);
    expect(synchronizedOutputDisabledByEnv({ ELANOUS_SYNC_OUTPUT: '0' })).toBe(true);
    expect(synchronizedOutputDisabledByEnv({ ELANOUS_SYNC_OUTPUT: 'FALSE' })).toBe(true);
  });
});

describe('synchronized frame output seam', () => {
  test('emits BSU on open and ESU on close', () => {
    const out = sink();
    const frame = beginSynchronizedFrameOutput({ write: out.write, supported: true, env: {} });
    out.write('frame');
    frame.close();
    expect(out.chunks).toEqual([SYNCHRONIZED_OUTPUT_BEGIN, 'frame', SYNCHRONIZED_OUTPUT_END]);
  });

  test('close is idempotent — a double close emits one ESU', () => {
    const out = sink();
    const frame = beginSynchronizedFrameOutput({ write: out.write, supported: true, env: {} });
    frame.close();
    frame.close();
    expect(out.text()).toBe(`${SYNCHRONIZED_OUTPUT_BEGIN}${SYNCHRONIZED_OUTPUT_END}`);
  });

  test('unsupported sink and env opt-out emit no control sequences', () => {
    const unsupported = sink();
    beginSynchronizedFrameOutput({ write: unsupported.write, supported: false, env: {} }).close();
    expect(unsupported.chunks).toEqual([]);

    const optedOut = sink();
    beginSynchronizedFrameOutput({
      write: optedOut.write,
      supported: true,
      env: { ELANOUS_SYNC_OUTPUT: 'off' },
    }).close();
    expect(optedOut.chunks).toEqual([]);
  });

  test('nested region contributes no bytes and keeps the outer region open', () => {
    const out = sink();
    const coordinator = openSynchronizedOutputRegion();
    out.write(SYNCHRONIZED_OUTPUT_BEGIN);
    const frame = beginSynchronizedFrameOutput({ write: out.write, supported: true, env: {} });
    out.write('frame+overlay');
    frame.close();
    expect(isSynchronizedOutputRegionOpen()).toBe(true);
    out.write(SYNCHRONIZED_OUTPUT_END);
    coordinator.close();
    expect(out.text()).toBe(`${SYNCHRONIZED_OUTPUT_BEGIN}frame+overlay${SYNCHRONIZED_OUTPUT_END}`);
    expect(isSynchronizedOutputRegionOpen()).toBe(false);
  });

  test('a throwing draw still closes the region so the next frame is presentable', () => {
    const out = sink();
    expect(() => {
      const frame = beginSynchronizedFrameOutput({ write: out.write, supported: true, env: {} });
      try {
        out.write('partial');
        throw new Error('draw blew up');
      } finally {
        frame.close();
      }
    }).toThrow('draw blew up');
    expect(out.text()).toBe(`${SYNCHRONIZED_OUTPUT_BEGIN}partial${SYNCHRONIZED_OUTPUT_END}`);
    expect(isSynchronizedOutputRegionOpen()).toBe(false);

    const next = sink();
    const revived = beginSynchronizedFrameOutput({ write: next.write, supported: true, env: {} });
    expect(revived).toBeDefined();
    next.write('next frame');
    revived.close();
    expect(next.text()).toBe(
      `${SYNCHRONIZED_OUTPUT_BEGIN}next frame${SYNCHRONIZED_OUTPUT_END}`,
    );
  });

  test('a throwing BSU write releases the region without emitting ESU', () => {
    const writes: string[] = [];
    expect(() =>
      beginSynchronizedFrameOutput({
        write: (chunk: string) => {
          writes.push(chunk);
          throw new Error('stdout closed');
        },
        supported: true,
        env: {},
      }),
    ).toThrow('stdout closed');
    expect(writes).toEqual([SYNCHRONIZED_OUTPUT_BEGIN]);
    expect(isSynchronizedOutputRegionOpen()).toBe(false);
  });
});
