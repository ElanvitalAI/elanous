// ── VW-term-infra Phase 1+2 — Pane contract sanity tests ──
//
// These tests exercise the substrate primitive without wiring into
// dashboard-virtual-windows.ts, just to prove every piece of the
// contract (kind discrimination · describe · snapshot · tap · mount
// /unmount) is invocable. Real per-kind behavior tests will land
// once the dashboard refactor wires the polymorphic dispatch.

import { describe, expect, test } from 'bun:test';

import {
  emptySnapshot,
  PaneTapNotSupportedError,
  PlaceholderPane,
  type Pane,
  type PaneContext,
  type PaneRef,
} from '../../src/panes/index.js';

function makeRef(paneId: string): PaneRef {
  return { windowId: 'w1', paneId };
}

function makeCtx(): PaneContext {
  return {
    bounds: { row: 0, col: 0, width: 80, height: 24 },
    onUnmount: () => {},
  };
}

describe('Phase 1 — PlaceholderPane implements full Pane contract', () => {
  test('kind reports placeholder + reason', () => {
    const pane: Pane = new PlaceholderPane(makeRef('p1'), 'empty');
    expect(pane.kind.kind).toBe('placeholder');
    if (pane.kind.kind === 'placeholder') {
      expect(pane.kind.reason).toBe('empty');
    }
  });

  test('describe returns title + summary + empty chords/tools/taps', () => {
    const pane = new PlaceholderPane(makeRef('p1'), 'loading');
    const d = pane.describe();
    expect(d.ref.paneId).toBe('p1');
    expect(d.kind.kind).toBe('placeholder');
    expect(d.title).toBe('Loading…');
    expect(d.summary).toContain('loading');
    expect(d.supportedTaps).toEqual([]);
    expect(d.chords).toEqual([]);
    expect(d.tools).toEqual([]);
  });

  test('render returns a single bounds-sized click region', () => {
    const pane = new PlaceholderPane(makeRef('p1'), 'empty');
    const regions = pane.render({ row: 1, col: 1, width: 40, height: 10 });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.kind).toBe('placeholder');
    expect(regions[0]!.rect.width).toBe(40);
    expect(regions[0]!.rect.height).toBe(10);
  });

  test('onKey + onMouse default to passthrough', async () => {
    const pane = new PlaceholderPane(makeRef('p1'), 'empty');
    expect(await pane.onKey({ key: 'a' })).toBe('passthrough');
    expect(await pane.onMouse({ kind: 'click', row: 0, col: 0 })).toBe('passthrough');
  });

  test('snapshot returns emptySnapshot shape', async () => {
    const pane = new PlaceholderPane(makeRef('p1'), 'empty');
    const snap = await pane.snapshot();
    expect(snap.ref.paneId).toBe('p1');
    expect(snap.kind.kind).toBe('placeholder');
    expect(snap.cells).toEqual([]);
    expect(snap.capturedAt).toBeGreaterThan(0);
  });

  test('addTap throws PaneTapNotSupportedError for every kind', () => {
    const pane = new PlaceholderPane(makeRef('p1'), 'empty');
    for (const kind of ['raw', 'frame', 'event'] as const) {
      expect(() => pane.addTap(kind, () => {})).toThrow(PaneTapNotSupportedError);
    }
  });

  test('mount + unmount are idempotent', () => {
    const pane = new PlaceholderPane(makeRef('p1'), 'empty');
    let registered = 0;
    const ctx: PaneContext = {
      ...makeCtx(),
      onUnmount: () => { registered++; },
    };
    pane.mount(ctx);
    pane.mount(ctx);  // second call should be a no-op
    expect(registered).toBe(1);
    pane.unmount();
    expect(() => pane.unmount()).not.toThrow();
  });
});

describe('Phase 2b — emptySnapshot helper returns structurally valid snapshot', () => {
  test('includes ref, kind, dims, empty cells, meta', () => {
    const ref = makeRef('x');
    const kind = { kind: 'placeholder', reason: 'empty' as const };
    const dims = { row: 0, col: 0, width: 10, height: 4 };
    const s = emptySnapshot(ref, kind, dims);
    expect(s.ref).toBe(ref);
    expect(s.kind).toBe(kind);
    expect(s.dims).toBe(dims);
    expect(s.cells).toEqual([]);
    expect(s.meta).toEqual({});
    expect(s.capturedAt).toBeGreaterThan(0);
  });
});

describe('Phase 2a — PaneTapNotSupportedError carries kind + pane label', () => {
  test('error includes tap kind and pane id in message', () => {
    const err = new PaneTapNotSupportedError('frame', 'my-pane');
    expect(err.message).toContain('frame');
    expect(err.message).toContain('my-pane');
    expect(err.kind).toBe('frame');
    expect(err.paneLabel).toBe('my-pane');
    expect(err.name).toBe('PaneTapNotSupportedError');
  });
});
