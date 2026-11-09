// IDX-F5b — HitTarget synthesis in dashboard-mouse-wiring.
//
// Covers:
//   1. getPaneHitTarget delegate attaches pane-nav-tab / pane-title /
//      pane-body HitTargets before modal forwarding.
//   2. Modal forward branch attaches modal-body when a click lands
//      inside a modal's bounds and no finer hit target is set.
//   3. lastClickHitKind derives legacy strings from the rich
//      HitTarget without re-running pill / pane lookups (the
//      hitTargetToLastClickKind path).
//
// F5a already covered the pill + status-bar classifier; these tests
// extend to the pane + modal kinds added by F5b.

import { describe, expect, test } from 'bun:test';
import { createDashboardMouseWiring } from '../src/dashboard/input/mouse-wiring.js';
import { createContextKeyService } from '../src/input-core/context-keys.js';
import type { RotationEntry } from '../src/user-config/types.js';
import type { ActiveProviderInfo } from '../src/provider-summary.js';
import type { ModalSurface } from '../src/display/modal-stack.js';
import type { DisplayMouseEvent, HitTarget } from '../src/display/types.js';

const PROVIDER: ActiveProviderInfo = { provider: 'anthropic', model: 'Opus 4.7' };

function makeModal(opts: { id?: string; onMouse?: (ev: DisplayMouseEvent) => void } = {}): ModalSurface {
  return {
    kind: 'modal',
    id: opts.id ?? 'test-modal',
    owner: 'dashboard',
    focus: 'owns',
    priority: 10,
    bounds: { row: 5, col: 10, width: 40, height: 8 },
    render: () => [],
    onMouse: opts.onMouse,
  } as unknown as ModalSurface;
}

function paneHarness(opts: {
  paneRegion?: (row: number, col: number) => 'pane-body' | 'pane-title' | 'pane-nav' | null;
  paneHitTarget?: (row: number, col: number) => HitTarget | null;
  topModal?: ModalSurface | null;
}) {
  const rotation: RotationEntry[] = [
    { label: 'Opus 4.7', provider: 'anthropic', model: 'claude-opus-4-7' },
  ];
  const pushed: ModalSurface[] = [];
  const ctx = createContextKeyService();
  const wiring = createDashboardMouseWiring({
    termSize: () => ({ rows: 24, cols: 120 }),
    getRotation: () => rotation,
    setActiveModel: () => {},
    getRecentWds: () => [],
    setSessionWd: () => {},
    pushModalSurface: surface => {
      pushed.push(surface);
      return { dispose: () => { const i = pushed.indexOf(surface); if (i >= 0) pushed.splice(i, 1); } };
    },
    redraw: () => {},
    ctx,
    getPaneRegionKind: opts.paneRegion,
    getPaneHitTarget: opts.paneHitTarget,
    getTopModalSurface: opts.topModal !== undefined ? () => opts.topModal ?? null : undefined,
  });
  wiring.buildStatusLine({ swd: '/Users/test/project', providerInfo: PROVIDER });
  wiring.setStatusRow(23);
  return { wiring, ctx, pushed };
}

function mouse(type: DisplayMouseEvent['type'], row: number, col: number): DisplayMouseEvent {
  return { type, row, col };
}

describe('getPaneHitTarget · pane kinds attached to ev.hitTarget', () => {
  test('pane-body hit target reaches modal.onMouse via hitTarget', () => {
    // Use a modal as the spy — we pass a fake top modal whose bounds
    // are far from the click, so handleMouse will NOT forward the
    // click to the modal and we observe hitTarget via a custom probe.
    let seen: HitTarget | undefined;
    const probeModal = makeModal({
      id: 'probe',
      onMouse: ev => { seen = ev.hitTarget; },
    });
    // Point modal bounds to the exact click so the modal branch fires
    // WITH a pane-body classification taking precedence.
    probeModal.bounds = { row: 10, col: 40, width: 30, height: 6 };
    const { wiring } = paneHarness({
      paneHitTarget: (row, col) => (row === 10 && col === 50
        ? { kind: 'pane-body', paneId: 'chat', widgetInstanceId: 'chat' }
        : null),
      topModal: probeModal,
    });
    wiring.handleMouse(mouse('click', 10, 50));
    // pane classification wins over modal synthesis: F5b sets hit
    // target BEFORE the modal forward branch, so the same rich
    // HitTarget reaches modal.onMouse.
    expect(seen).toEqual({ kind: 'pane-body', paneId: 'chat', widgetInstanceId: 'chat' });
  });

  test('pane-title hit target attached and propagated to modal.onMouse', () => {
    let seen: HitTarget | undefined;
    const probeModal = makeModal({
      onMouse: ev => { seen = ev.hitTarget; },
    });
    probeModal.bounds = { row: 4, col: 0, width: 120, height: 1 };
    const { wiring } = paneHarness({
      paneHitTarget: () => ({ kind: 'pane-title', paneId: 'preview', widgetInstanceId: 'preview' }),
      topModal: probeModal,
    });
    wiring.handleMouse(mouse('click', 4, 20));
    expect(seen).toEqual({ kind: 'pane-title', paneId: 'preview', widgetInstanceId: 'preview' });
  });

  test('pane-nav-tab hit target attached', () => {
    let seen: HitTarget | undefined;
    const probeModal = makeModal({
      onMouse: ev => { seen = ev.hitTarget; },
    });
    probeModal.bounds = { row: 3, col: 0, width: 120, height: 1 };
    const { wiring } = paneHarness({
      paneHitTarget: () => ({ kind: 'pane-nav-tab', paneId: 'log' }),
      topModal: probeModal,
    });
    wiring.handleMouse(mouse('click', 3, 5));
    expect(seen).toEqual({ kind: 'pane-nav-tab', paneId: 'log' });
  });

  test('getPaneHitTarget throwing does not crash; hitTarget stays absent', () => {
    const { wiring } = paneHarness({
      paneHitTarget: () => { throw new Error('boom'); },
    });
    expect(() => wiring.handleMouse(mouse('click', 10, 50))).not.toThrow();
  });
});

describe('modal-body synthesis · modal forward branch', () => {
  test('click inside modal bounds with no pane hit → modal-body attached before onMouse', () => {
    let seen: HitTarget | undefined;
    const probeModal = makeModal({
      id: 'recipe:model',
      onMouse: ev => { seen = ev.hitTarget; },
    });
    const { wiring } = paneHarness({
      // No pane hit target supplied — pane classifier absent.
      topModal: probeModal,
    });
    // Click inside the default modal bounds (row 5-12, col 10-49).
    wiring.handleMouse(mouse('click', 7, 20));
    expect(seen).toEqual({ kind: 'modal-body', modalId: 'recipe:model' });
  });

  test('click outside modal bounds does NOT synthesize modal-body', () => {
    let seen: HitTarget | undefined;
    const probeModal = makeModal({
      onMouse: ev => { seen = ev.hitTarget; },
    });
    const { wiring } = paneHarness({
      topModal: probeModal,
    });
    // Click outside modal (bounds are row 5-12, col 10-49) and not on
    // a pane / status bar → hitTarget stays absent and the modal
    // branch is skipped for non-passthrough event types.
    wiring.handleMouse(mouse('click', 20, 80));
    // Modal onMouse is not invoked for outside-click non-always events,
    // so `seen` remains undefined.
    expect(seen).toBeUndefined();
  });

  test('pane hit target wins when click also lands inside modal bounds', () => {
    let seen: HitTarget | undefined;
    const probeModal = makeModal({
      id: 'some-modal',
      onMouse: ev => { seen = ev.hitTarget; },
    });
    const { wiring } = paneHarness({
      paneHitTarget: () => ({ kind: 'pane-body', paneId: 'chat', widgetInstanceId: 'chat' }),
      topModal: probeModal,
    });
    // Default modal bounds row 5-12 col 10-49; click at row 7 col 20
    // is inside. Pane classifier still wins because F5b classifies
    // the pane BEFORE the modal forward branch.
    wiring.handleMouse(mouse('click', 7, 20));
    expect(seen).toEqual({ kind: 'pane-body', paneId: 'chat', widgetInstanceId: 'chat' });
  });

  test('drag event inside modal bounds receives modal-body hit target', () => {
    let seen: HitTarget | undefined;
    const probeModal = makeModal({
      id: 'vw-host',
      onMouse: ev => { seen = ev.hitTarget; },
    });
    const { wiring } = paneHarness({
      topModal: probeModal,
    });
    wiring.handleMouse(mouse('drag', 7, 20));
    expect(seen).toEqual({ kind: 'modal-body', modalId: 'vw-host' });
  });
});

describe('lastClickHitKind · derives from HitTarget', () => {
  test('pane-body HitTarget → lastClickHitKind="pane-body"', () => {
    const { wiring, ctx } = paneHarness({
      paneHitTarget: () => ({ kind: 'pane-body', paneId: 'chat' }),
    });
    wiring.handleMouse(mouse('click', 10, 50));
    expect(ctx.keys.lastClickHitKind).toBe('pane-body');
  });

  test('pane-title HitTarget → lastClickHitKind="pane-title"', () => {
    const { wiring, ctx } = paneHarness({
      paneHitTarget: () => ({ kind: 'pane-title', paneId: 'preview' }),
    });
    wiring.handleMouse(mouse('click', 5, 20));
    expect(ctx.keys.lastClickHitKind).toBe('pane-title');
  });

  test('pane-nav-tab HitTarget → lastClickHitKind="pane-nav" (legacy key)', () => {
    const { wiring, ctx } = paneHarness({
      paneHitTarget: () => ({ kind: 'pane-nav-tab', paneId: 'log' }),
    });
    wiring.handleMouse(mouse('click', 4, 15));
    expect(ctx.keys.lastClickHitKind).toBe('pane-nav');
  });

  test('pill hit still derives to "status-bar-pill"', () => {
    const { wiring, ctx } = paneHarness({
      paneHitTarget: () => ({ kind: 'pane-body', paneId: 'chat' }),
    });
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse(mouse('click', 23, pill.startCol + 2));
    expect(ctx.keys.lastClickHitKind).toBe('status-bar-pill');
  });

  test('bare status-bar HitTarget (off-pill) yields null via derivation', () => {
    const { wiring, ctx } = paneHarness({});
    // Click on status row but far right, no pill — classifier emits
    // {kind:'status-bar'}, which maps to null in the legacy string.
    wiring.handleMouse(mouse('click', 23, 200));
    expect(ctx.keys.lastClickHitKind).toBeNull();
  });
});
