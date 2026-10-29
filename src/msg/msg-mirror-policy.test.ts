import { describe, expect, test } from 'bun:test';
import type { Message } from './msg-store.js';
import { buildMirrorSummary, isMirrorEvent, MIRROR_ROTATE_AT, selectMirrorEvents, shouldRotateMirrorChannel } from './msg-mirror-policy.js';

function message(id: number, kind: string | undefined, createdAt = '2026-10-28T00:00:00.000Z'): Message {
  return { id, from: 'OP', to: 'MK', body: `event ${id}`, createdAt, ...(kind ? { kind } : {}) };
}

describe('seat-message GitHub mirror policy', () => {
  test('admits only incidents, decisions, and corrections', () => {
    for (const kind of ['incident', 'decision', 'correction']) expect(isMirrorEvent(message(1, kind))).toBe(true);
    for (const kind of ['report', 'request', 'reply', 'context', undefined]) expect(isMirrorEvent(message(1, kind))).toBe(false);
  });

  test('selects eligible events after the durable mirror cursor in ledger order', () => {
    const input = [message(4, 'incident'), message(2, 'report'), message(3, 'correction'), message(1, 'decision')];
    expect(selectMirrorEvents(input, 1).map(({ id }) => id)).toEqual([3, 4]);
    expect(input.map(({ id }) => id)).toEqual([4, 2, 3, 1]);
  });

  test('summarizes only eligible messages in a half-open time window', () => {
    const start = '2026-10-28T00:00:00.000Z';
    const end = '2026-10-28T02:00:00.000Z';
    const summary = buildMirrorSummary([
      message(1, 'incident', start),
      message(2, 'report', '2026-10-28T01:00:00.000Z'),
      message(3, 'decision', '2026-10-28T01:59:59.999Z'),
      message(4, 'correction', end),
    ], start, end);
    expect(summary).toContain('2 mirrored events · incident 1 · decision 1');
    expect(summary).toContain('#1 **incident**');
    expect(summary).toContain('#3 **decision**');
    expect(summary).not.toContain('#2');
    expect(summary).not.toContain('#4');
    expect(buildMirrorSummary([message(5, 'report')], start, end)).toBeNull();
  });

  test('requests channel rotation at 2,300 comments and rejects unsafe thresholds', () => {
    expect(MIRROR_ROTATE_AT).toBe(2_300);
    expect(shouldRotateMirrorChannel(2_299)).toBe(false);
    expect(shouldRotateMirrorChannel(2_300)).toBe(true);
    expect(shouldRotateMirrorChannel(2_500)).toBe(true);
    expect(() => shouldRotateMirrorChannel(-1)).toThrow();
    expect(() => shouldRotateMirrorChannel(10, 2_500)).toThrow();
  });
});
