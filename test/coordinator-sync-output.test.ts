// DECSET 2026 (Synchronized Output) — coordinator wraps each frame
// flush with BSU (?2026h) + ESU (?2026l) so modern terminals apply
// the composite dashboard + modal + cursor paint atomically, killing
// the mid-frame flicker pattern the user hit on Ctrl+M B. See the
// PR tech report (TECH-REPORT-tablet-modal-fix.md §5-E) for the
// research that drove this (Textual · Ratatui · blessed consensus).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DisplayCoordinator, type DisplaySurface } from '../src/display/index.js';

function modal(id: string, paint: string): DisplaySurface {
  return {
    id,
    owner: 'dashboard',
    kind: 'modal',
    focus: 'owns',
    priority: 100,
    tier: 'popup',
    bounds: { row: 5, col: 5, width: 40, height: 10 },
    render: () => [],
    paint: () => paint,
  } as unknown as DisplaySurface;
}

function harnessWithTTY(tty: boolean) {
  // Stash + restore process.stdout.isTTY so parallel tests don't trip.
  const prevIsTTY = process.stdout.isTTY;
  (process.stdout as { isTTY?: boolean }).isTTY = tty;
  const restore = (): void => {
    (process.stdout as { isTTY?: boolean }).isTTY = prevIsTTY;
  };
  const overlayWrites: string[] = [];
  const scheduled: Array<() => void> = [];
  const c = new DisplayCoordinator({
    frameMs: 16,
    schedule: (fn) => { scheduled.push(fn); return 0 as any; },
    onRender: () => { /* dashboard paint — no-op in this test */ },
    writeOverlay: (s) => { overlayWrites.push(s); },
    termSize: () => ({ cols: 100, rows: 30 }),
    invalidateRow: () => { /* no-op */ },
  });
  const flush = (): void => { scheduled.forEach(fn => fn()); scheduled.length = 0; };
  return { c, overlayWrites, flush, restore };
}

describe('DECSET 2026 — synchronized output wrap', () => {
  const prevEnv = process.env.ELANOUS_SYNC_OUTPUT;
  beforeEach(() => { delete process.env.ELANOUS_SYNC_OUTPUT; });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.ELANOUS_SYNC_OUTPUT;
    else process.env.ELANOUS_SYNC_OUTPUT = prevEnv;
  });

  test('TTY on — flush emits BSU before the frame and ESU after', () => {
    const h = harnessWithTTY(true);
    try {
      h.c.pushModal(modal('m', 'PAYLOAD'));
      h.flush();
      // BSU first, then modal paint, then ESU. overlayWrites is in
      // the order they were pushed to process.stdout.
      expect(h.overlayWrites[0]).toBe('\x1b[?2026h');
      expect(h.overlayWrites[h.overlayWrites.length - 1]).toBe('\x1b[?2026l');
      expect(h.overlayWrites.some(s => s.includes('PAYLOAD'))).toBe(true);
    } finally {
      h.restore();
    }
  });

  test('an outer paint batch and its immediate coordinator frame emit one synchronized block', () => {
    const h = harnessWithTTY(true);
    try {
      h.c.withSynchronizedOutput(() => {
        h.c.pushModal(modal('m', 'PAYLOAD'));
        h.c.requestRenderNow({ force: true });
      });
      expect(h.overlayWrites.filter(write => write === '\x1b[?2026h' || write === '\x1b[?2026l'))
        .toEqual(['\x1b[?2026h', '\x1b[?2026l']);
      expect(h.overlayWrites).toContain('PAYLOAD');
      h.flush(); // The stale scheduled callback must not emit another frame.
      expect(h.overlayWrites.filter(write => write === '\x1b[?2026h' || write === '\x1b[?2026l'))
        .toEqual(['\x1b[?2026h', '\x1b[?2026l']);
    } finally {
      h.restore();
    }
  });

  test('non-TTY — BSU/ESU suppressed so test harnesses see clean overlay', () => {
    const h = harnessWithTTY(false);
    try {
      h.c.pushModal(modal('m', 'PAYLOAD'));
      h.flush();
      expect(h.overlayWrites.every(s => !s.includes('?2026'))).toBe(true);
    } finally {
      h.restore();
    }
  });

  test('ELANOUS_SYNC_OUTPUT=off — opt-out even on a real TTY', () => {
    process.env.ELANOUS_SYNC_OUTPUT = 'off';
    const h = harnessWithTTY(true);
    try {
      h.c.pushModal(modal('m', 'PAYLOAD'));
      h.flush();
      expect(h.overlayWrites.every(s => !s.includes('?2026'))).toBe(true);
    } finally {
      h.restore();
    }
  });
});
