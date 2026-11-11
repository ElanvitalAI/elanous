// ── WidgetHost WR-3 tests — Bundle 6W ──
//
// Covers:
//   - `WidgetContext.zTier` + `zIndex` populated from zInfoFor hook
//   - No hook / undefined / throw → fields absent in ctx
//   - `WidgetHost.replayState(id, state)` — default path via ctx.setState
//   - Widget `replayState` override — called with live ctx
//   - Override throw → fall through to default setState
//   - Scratch widget opt-in emits telemetry + applies state
//   - replayState on unknown id returns false

import { describe, test, expect } from 'bun:test';
import { WidgetHost, type WidgetStateChangeEvent } from '../src/widgets/host.js';
import { debug } from '../src/debug/log.js';
import type { Widget, WidgetContext } from '../src/widgets/types.js';

interface S { n: number; label: string; flag?: boolean }

function makeWidget(opts: {
  replayState?: (s: S, c: WidgetContext<S>) => void;
} = {}): Widget<S> {
  return {
    type: 'demo',
    description: 'demo widget',
    initialState: () => ({ n: 0, label: 'init' }),
    render: () => [''],
    ...(opts.replayState ? { replayState: opts.replayState } : {}),
  };
}

// ── ctx.zTier + ctx.zIndex from zInfoFor hook ────────────

describe('WidgetContext.zTier / zIndex', () => {
  test('populated when host wires zInfoFor', () => {
    const host = new WidgetHost({
      log: () => {},
      requestRender: () => {},
      zInfoFor: () => ({ tier: 'vw', zIndex: 3 }),
    });
    host.register(makeWidget());
    const inst = host.spawn({ type: 'demo' });
    const ctx = host.buildContext<S>(inst.id)!;
    expect(ctx.zTier).toBe('vw');
    expect(ctx.zIndex).toBe(3);
  });

  test('undefined when host has no zInfoFor hook', () => {
    const host = new WidgetHost({ log: () => {}, requestRender: () => {} });
    host.register(makeWidget());
    const inst = host.spawn({ type: 'demo' });
    const ctx = host.buildContext<S>(inst.id)!;
    expect(ctx.zTier).toBeUndefined();
    expect(ctx.zIndex).toBeUndefined();
  });

  test('zInfoFor returning undefined → fields absent', () => {
    const host = new WidgetHost({
      log: () => {},
      requestRender: () => {},
      zInfoFor: () => undefined,
    });
    host.register(makeWidget());
    const inst = host.spawn({ type: 'demo' });
    const ctx = host.buildContext<S>(inst.id)!;
    expect(ctx.zTier).toBeUndefined();
    expect(ctx.zIndex).toBeUndefined();
  });

  test('zInfoFor returning partial info populates only present fields', () => {
    const host = new WidgetHost({
      log: () => {},
      requestRender: () => {},
      zInfoFor: () => ({ tier: 'modal' }),  // zIndex absent
    });
    host.register(makeWidget());
    const inst = host.spawn({ type: 'demo' });
    const ctx = host.buildContext<S>(inst.id)!;
    expect(ctx.zTier).toBe('modal');
    expect(ctx.zIndex).toBeUndefined();
  });

  test('zInfoFor throw is isolated → fields absent, ctx still builds', () => {
    const host = new WidgetHost({
      log: () => {},
      requestRender: () => {},
      zInfoFor: () => { throw new Error('z-lookup boom'); },
    });
    host.register(makeWidget());
    const inst = host.spawn({ type: 'demo' });
    const ctx = host.buildContext<S>(inst.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.zTier).toBeUndefined();
    expect(ctx!.zIndex).toBeUndefined();
    expect(typeof ctx!.setState).toBe('function');
  });

  test('ctx reflects latest zInfoFor result per buildContext call', () => {
    let tier: string = 'vw';
    const host = new WidgetHost({
      log: () => {},
      requestRender: () => {},
      zInfoFor: () => ({ tier }),
    });
    host.register(makeWidget());
    const inst = host.spawn({ type: 'demo' });
    expect(host.buildContext<S>(inst.id)!.zTier).toBe('vw');
    tier = 'modal';
    expect(host.buildContext<S>(inst.id)!.zTier).toBe('modal');
  });
});

// ── WidgetHost.replayState default path ──────────────────

describe('WidgetHost.replayState — default path', () => {
  test('no override → applies state via ctx.setState (fires state-change event)', () => {
    const events: WidgetStateChangeEvent[] = [];
    const host = new WidgetHost({ log: () => {}, requestRender: () => {} });
    host.register(makeWidget());
    host.onInstanceStateChange((ev) => events.push(ev));
    const inst = host.spawn({ type: 'demo' });
    const ok = host.replayState<S>(inst.id, { n: 99, label: 'replayed' });
    expect(ok).toBe(true);
    // setState merge — next has recorded fields
    expect(host.get(inst.id)!.state).toMatchObject({ n: 99, label: 'replayed' });
    expect(events.length).toBe(1);
    expect((events[0]!.next as S).n).toBe(99);
  });

  test('unknown id returns false, no state change', () => {
    const host = new WidgetHost({ log: () => {}, requestRender: () => {} });
    host.register(makeWidget());
    const ok = host.replayState('no-such-widget', { n: 1 } as never);
    expect(ok).toBe(false);
  });
});

// ── Widget.replayState override ─────────────────────────

describe('Widget.replayState override', () => {
  test('called with recorded state + live ctx (has setState, widgetId)', () => {
    let seen: { state: S; widgetId: string } | null = null;
    const host = new WidgetHost({ log: () => {}, requestRender: () => {} });
    host.register(makeWidget({
      replayState: (s, ctx) => {
        seen = { state: { ...s }, widgetId: ctx.widgetId };
        ctx.setState(s);
      },
    }));
    const inst = host.spawn({ type: 'demo' });
    host.replayState<S>(inst.id, { n: 5, label: 'via-override' });
    expect(seen).not.toBeNull();
    expect(seen!.state.n).toBe(5);
    expect(seen!.widgetId).toBe(inst.id);
  });

  test('override is responsible for state application (no auto-setState)', () => {
    // Override that deliberately doesn't apply state — host should trust
    // widget's decision (not fall back to setState).
    let overrideCalled = false;
    const host = new WidgetHost({ log: () => {}, requestRender: () => {} });
    host.register(makeWidget({
      replayState: () => { overrideCalled = true; /* no setState */ },
    }));
    const inst = host.spawn({ type: 'demo' });
    host.replayState<S>(inst.id, { n: 99, label: 'NEVER' });
    expect(overrideCalled).toBe(true);
    // State stayed at initial because override didn't setState
    expect(host.get(inst.id)!.state).toMatchObject({ n: 0, label: 'init' });
  });

  test('override throw emits an error and falls through to default ctx.setState', () => {
    const seen: Array<{ category: string; event: string; data?: unknown }> = [];
    const off = debug.registerSink({
      name: 'widget-replay-override-error',
      emit: (record) => seen.push({ category: record.category, event: record.event, data: record.data }),
    });
    try {
      const host = new WidgetHost({ log: () => {}, requestRender: () => {} });
      host.register(makeWidget({
        replayState: () => { throw new Error('replay boom'); },
      }));
      const inst = host.spawn({ type: 'demo' });
      const ok = host.replayState<S>(inst.id, { n: 42, label: 'fallback' });
      expect(ok).toBe(true);
      expect(host.get(inst.id)!.state).toMatchObject({ n: 42, label: 'fallback' });
      expect(seen).toContainEqual(expect.objectContaining({
        category: 'widget.replay-state.override.error',
        event: inst.id,
        data: expect.objectContaining({ err: 'replay boom' }),
      }));
    } finally {
      off();
    }
  });
});

// ── Fader built-in opt-in (Bundle 7W · WR-3) ────────────

describe('fader widget WR-3 opt-in', () => {
  test('replayState transplants phase + message + tone and emits telemetry', async () => {
    const { default: faderWidget } = await import('../widgets/fader/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = new WidgetHost({
      log: () => {},
      requestRender: () => {},
      telemetry: { emit: (ev) => emitted.push({ kind: ev.kind, data: ev.data }) },
    });
    host.register(faderWidget);
    const inst = host.spawn({ type: 'fader', config: { message: 'hello' } });
    host.replayState(inst.id, {
      message: 'replayed',
      phase: 'fade-out' as const,
      tone: 'warning' as const,
      autoDismissMs: 0,
    } as never);
    const replayEvents = emitted.filter((e) => e.kind === 'fader.replay');
    expect(replayEvents.length).toBe(1);
    expect(replayEvents[0]!.data).toMatchObject({ phase: 'fade-out', tone: 'warning' });
    expect(host.get(inst.id)!.state).toMatchObject({
      message: 'replayed',
      phase: 'fade-out',
      tone: 'warning',
    });
  });
});

// ── Scratch built-in opt-in ─────────────────────────────

describe('scratch widget WR-3 opt-in', () => {
  test('replayState emits scratch.replay telemetry + applies state', async () => {
    const { default: scratchWidget } = await import('../widgets/scratch/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = new WidgetHost({
      log: () => {},
      requestRender: () => {},
      telemetry: { emit: (ev) => emitted.push({ kind: ev.kind, data: ev.data }) },
    });
    host.register(scratchWidget);
    const inst = host.spawn({ type: 'scratch' });
    host.replayState(inst.id, {
      mode: 'clipboard' as const,
      previewLines: [],
      previewPath: null,
      scroll: 0,
      memoLines: ['restored'],
      memoLineIdx: 0,
      memoColIdx: 0,
      memoDirty: false,
      clipHistory: [{ id: 'c-1', text: 'restored clip' }],
      clipCursor: 0,
      focused: false,
    } as never);
    const replayEvents = emitted.filter((e) => e.kind === 'scratch.replay');
    expect(replayEvents.length).toBe(1);
    expect(replayEvents[0]!.data).toMatchObject({
      toMode: 'clipboard',
      clipHistory: 1,
      memoDirty: false,
    });
    // State actually applied
    expect(host.get(inst.id)!.state).toMatchObject({
      mode: 'clipboard',
      clipHistory: [{ id: 'c-1', text: 'restored clip' }],
    });
  });
});
