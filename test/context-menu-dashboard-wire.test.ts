// CMX-2 · context-menu-dashboard-wire tests.
// Validates right-click → provider.resolve → registry.showMenu →
// onPick pipeline + dispose cleanup.

import { describe, expect, test } from 'bun:test';
import {
  wireContextMenuToDashboard,
} from '../src/context-menu-dashboard-wire.js';
import {
  createContextMenuRegistry,
  type Menu,
  type MenuPresenter,
  type MenuResult,
} from '../src/ui/context-menu-registry.js';
import {
  createMenuProviderRegistry,
} from '../src/ui/context-menu-providers.js';
import type { DisplayMouseEvent, HitTarget } from '../src/display/types.js';

function makeSeqId(): () => string {
  let n = 0;
  return () => { n++; return `h-${n}`; };
}

function makeStubPresenter(): {
  presenter: MenuPresenter;
  pending: Array<{ resolve: (r: MenuResult) => void; menu: Menu; pos: { x: number; y: number }; opts?: { singleInstance?: boolean; ownerWorkspaceId?: string } }>;
} {
  const pending: Array<{ resolve: (r: MenuResult) => void; menu: Menu; pos: { x: number; y: number }; opts?: { singleInstance?: boolean; ownerWorkspaceId?: string } }> = [];
  return {
    pending,
    presenter: (menu, pos, opts) =>
      new Promise<MenuResult>((resolve) => {
        pending.push({ resolve, menu, pos, opts });
      }),
  };
}

function ev(
  type: DisplayMouseEvent['type'],
  row: number,
  col: number,
  hit?: HitTarget,
): DisplayMouseEvent {
  return { type, row, col, ...(hit ? { hitTarget: hit } : {}) };
}

const paneBody = (paneId: string): HitTarget => ({ kind: 'pane-body', paneId });
const pill = (name: string): HitTarget => ({ kind: 'pill', name: name as never });

function harness() {
  const stub = makeStubPresenter();
  const registry = createContextMenuRegistry({
    nextId: makeSeqId(),
    presenter: stub.presenter,
  });
  const providers = createMenuProviderRegistry();
  const pickCalls: Array<{ ev: DisplayMouseEvent; result: MenuResult }> = [];
  const wire = wireContextMenuToDashboard({
    registry,
    providers,
    onPick: (e, r) => { pickCalls.push({ ev: e, result: r }); },
  });
  return { stub, registry, providers, pickCalls, wire };
}

describe('CMX-2 · wire · onMouse routing', () => {
  test('non-right-click → passthrough (returns false)', () => {
    const h = harness();
    h.providers.register('pane-body:browser', () => ({
      items: [{ kind: 'command', id: 'x', label: 'X' }],
    }));

    expect(h.wire.onMouse(ev('click', 5, 10, paneBody('browser')))).toBe(false);
    expect(h.wire.onMouse(ev('drag',  5, 10, paneBody('browser')))).toBe(false);
    expect(h.wire.onMouse(ev('release', 5, 10, paneBody('browser')))).toBe(false);
    expect(h.stub.pending.length).toBe(0);
  });

  test('right-click without hitTarget → passthrough', () => {
    const h = harness();
    h.providers.register('pane-body:*', () => ({ items: [{ kind: 'command', id: 'x', label: 'X' }] }));
    expect(h.wire.onMouse(ev('right-click', 5, 10))).toBe(false);
    expect(h.stub.pending.length).toBe(0);
  });

  test('right-click with hit but no provider → passthrough', () => {
    const h = harness();
    expect(h.wire.onMouse(ev('right-click', 5, 10, paneBody('browser')))).toBe(false);
    expect(h.stub.pending.length).toBe(0);
  });

  test('right-click with provider → consumed + showMenu invoked', () => {
    const h = harness();
    h.providers.register('pane-body:browser', () => ({
      items: [{ kind: 'command', id: 'open', label: 'Open' }],
    }));
    const consumed = h.wire.onMouse(ev('right-click', 5, 10, paneBody('browser')));
    expect(consumed).toBe(true);
    expect(h.stub.pending.length).toBe(1);
    expect(h.stub.pending[0]!.pos).toEqual({ x: 9, y: 4 }); // 0-indexed
    expect(h.stub.pending[0]!.opts?.singleInstance).toBe(true);
  });

  test('ownerWorkspaceIdForEvent is forwarded into showMenu options', () => {
    const stub = makeStubPresenter();
    const registry = createContextMenuRegistry({
      nextId: makeSeqId(),
      presenter: stub.presenter,
    });
    const providers = createMenuProviderRegistry();
    providers.register('pane-body:browser', () => ({
      items: [{ kind: 'command', id: 'open', label: 'Open' }],
    }));
    const wire = wireContextMenuToDashboard({
      registry,
      providers,
      ownerWorkspaceIdForEvent: () => 'virtual-window:3',
      onPick: () => {},
    });
    expect(wire.onMouse(ev('right-click', 5, 10, paneBody('browser')))).toBe(true);
    expect(stub.pending[0]!.opts?.ownerWorkspaceId).toBe('virtual-window:3');
  });

  test('wildcard provider matches when specific absent', () => {
    const h = harness();
    h.providers.register('pane-body:*', () => ({
      items: [{ kind: 'command', id: 'generic', label: 'Generic' }],
    }));
    expect(h.wire.onMouse(ev('right-click', 5, 10, paneBody('scratch')))).toBe(true);
    expect(h.stub.pending.length).toBe(1);
    expect(h.stub.pending[0]!.menu.items[0]!.kind).toBe('command');
  });
});

describe('CMX-2 · wire · onPick dispatch', () => {
  test('selected pick → onPick called with hit + result', async () => {
    const h = harness();
    h.providers.register('pill:model', () => ({
      items: [{ kind: 'command', id: 'switch', label: 'Switch' }],
    }));
    const rightClickEv = ev('right-click', 3, 7, pill('model'));
    h.wire.onMouse(rightClickEv);
    expect(h.stub.pending.length).toBe(1);

    h.stub.pending[0]!.resolve({ value: 'switch', reason: 'selected' });
    // Promise microtask flush
    await Promise.resolve();
    await Promise.resolve();

    expect(h.pickCalls.length).toBe(1);
    expect(h.pickCalls[0]!.ev).toBe(rightClickEv);
    expect(h.pickCalls[0]!.result.value).toBe('switch');
    expect(h.pickCalls[0]!.result.reason).toBe('selected');
  });

  test('escape dismissal → onPick called with reason=escape', async () => {
    const h = harness();
    h.providers.register('pane-body:browser', () => ({
      items: [{ kind: 'command', id: 'x', label: 'X' }],
    }));
    h.wire.onMouse(ev('right-click', 1, 1, paneBody('browser')));
    h.stub.pending[0]!.resolve({ value: null, reason: 'escape' });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.pickCalls.length).toBe(1);
    expect(h.pickCalls[0]!.result.reason).toBe('escape');
    expect(h.pickCalls[0]!.result.value).toBeNull();
  });

  test('payload surfaces through to onPick', async () => {
    const h = harness();
    const model = { absPath: '/tmp/x.ts' };
    h.providers.register('pane-body:browser', () => ({
      items: [{ kind: 'command', id: 'attach', label: 'Attach', payload: model }],
    }));
    h.wire.onMouse(ev('right-click', 1, 1, paneBody('browser')));
    h.stub.pending[0]!.resolve({
      value: 'attach',
      reason: 'selected',
      payload: model,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.pickCalls[0]!.result.payload).toEqual(model);
  });

  test('onPick async handler is fire-and-forget (no await in wire)', async () => {
    const h = harness();
    const providers2 = createMenuProviderRegistry();
    const stub2 = makeStubPresenter();
    const registry2 = createContextMenuRegistry({
      nextId: makeSeqId(),
      presenter: stub2.presenter,
    });
    let pickResolve: (() => void) | null = null;
    const wire2 = wireContextMenuToDashboard({
      registry: registry2,
      providers: providers2,
      onPick: () => new Promise<void>((res) => { pickResolve = res; }),
    });
    providers2.register('pane-body:browser', () => ({
      items: [{ kind: 'command', id: 'x', label: 'X' }],
    }));

    // Sync return even though onPick is async
    const consumed = wire2.onMouse(ev('right-click', 1, 1, paneBody('browser')));
    expect(consumed).toBe(true);

    stub2.pending[0]!.resolve({ value: 'x', reason: 'selected' });
    await Promise.resolve();
    // pickResolve is now a pending promise · handler was called but not awaited
    pickResolve?.();
  });
});

describe('CMX-2 · wire · transient handle cleanup', () => {
  test('menu handle unregistered after resolve', async () => {
    const h = harness();
    h.providers.register('pane-body:browser', () => ({
      items: [{ kind: 'command', id: 'x', label: 'X' }],
    }));
    h.wire.onMouse(ev('right-click', 1, 1, paneBody('browser')));

    // Count registered menus by inspecting registry via getMenu on
    // every known handle — here we rely on dispose side-effect.
    // Instead, trigger a second show to prove no handle collision.
    h.stub.pending[0]!.resolve({ value: 'x', reason: 'selected' });
    await Promise.resolve();
    await Promise.resolve();

    h.wire.onMouse(ev('right-click', 1, 1, paneBody('browser')));
    expect(h.stub.pending.length).toBe(2);
  });

  test('buildContext is passed to providers', () => {
    const stub = makeStubPresenter();
    const registry = createContextMenuRegistry({ nextId: makeSeqId(), presenter: stub.presenter });
    const providers = createMenuProviderRegistry();
    let captured: unknown = null;
    providers.register('pane-body:browser', (_hit, ctx) => {
      captured = ctx;
      return { items: [{ kind: 'command', id: 'x', label: 'X' }] };
    });
    const wire = wireContextMenuToDashboard({
      registry,
      providers,
      onPick: () => {},
      buildContext: () => ({ cwd: '/tmp', readonly: false }),
    });
    wire.onMouse(ev('right-click', 1, 1, paneBody('browser')));
    expect(captured).toEqual({ cwd: '/tmp', readonly: false });
  });

  test('dispose after open — handle cleaned up', () => {
    const h = harness();
    h.providers.register('pane-body:browser', () => ({
      items: [{ kind: 'command', id: 'x', label: 'X' }],
    }));
    h.wire.onMouse(ev('right-click', 1, 1, paneBody('browser')));
    // Before resolve, dispose wire — transientHandles should drop.
    h.wire.dispose();

    // Further onMouse → no-op (disposed)
    expect(h.wire.onMouse(ev('right-click', 1, 1, paneBody('browser')))).toBe(false);
  });

  test('dispose is idempotent', () => {
    const h = harness();
    h.wire.dispose();
    expect(() => h.wire.dispose()).not.toThrow();
  });

  test('provider returning null → no menu shown, not consumed', () => {
    const h = harness();
    h.providers.register('pane-body:browser', () => null);
    const consumed = h.wire.onMouse(ev('right-click', 5, 5, paneBody('browser')));
    expect(consumed).toBe(false);
    expect(h.stub.pending.length).toBe(0);
  });
});
