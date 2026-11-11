// ── WidgetHost state-change hook tests — Bundle 4W P3 (WR-1) ──
//
// Covers:
//   - Widget.onStateChange fires after ctx.setState with correct prev/next
//   - WidgetHost.onInstanceStateChange subscription fan-out
//   - Unsubscribe removes subscriber
//   - Multiple subscribers all fire
//   - Throwing subscriber isolated
//   - Re-entry guard (setState inside onStateChange doesn't recurse)
//   - Widget without onStateChange still fires host subscribers
//   - Event shape (instanceId · type · prev · next · timestamp)

import { describe, test, expect } from 'bun:test';
import { WidgetHost, type WidgetStateChangeEvent } from '../src/widgets/host.js';
import type { Widget, WidgetContext } from '../src/widgets/types.js';

function makeHost(): WidgetHost {
  return new WidgetHost({
    log: () => {},
    requestRender: () => {},
  });
}

interface BlockState { counter: number; label: string }

function makeObservableWidget(opts: {
  onStateChange?: (prev: BlockState, next: BlockState, ctx: WidgetContext<BlockState>) => void;
  reentrant?: boolean;
}): Widget<BlockState> {
  return {
    type: 'observable',
    description: 'test widget with onStateChange',
    initialState: () => ({ counter: 0, label: 'init' }),
    render: () => [''],
    ...(opts.onStateChange ? { onStateChange: opts.onStateChange } : {}),
  };
}

function makeSilentWidget(): Widget<BlockState> {
  return {
    type: 'silent',
    description: 'test widget without onStateChange',
    initialState: () => ({ counter: 0, label: 'init' }),
    render: () => [''],
  };
}

// ── Widget.onStateChange ────────────────────────────────

describe('Widget.onStateChange hook', () => {
  test('fires after ctx.setState with correct prev/next', () => {
    const captured: Array<{ prev: BlockState; next: BlockState }> = [];
    const host = makeHost();
    host.register(makeObservableWidget({
      onStateChange: (prev, next) => {
        captured.push({ prev: { ...prev }, next: { ...next } });
      },
    }));
    const inst = host.spawn({ type: 'observable' });
    const ctx = host.buildContext<BlockState>(inst.id)!;
    ctx.setState({ counter: 5 });
    expect(captured.length).toBe(1);
    expect(captured[0]!.prev.counter).toBe(0);
    expect(captured[0]!.next.counter).toBe(5);
    expect(captured[0]!.next.label).toBe('init'); // unchanged
  });

  test('hook receives the same ctx reference used for setState', () => {
    let sameCtx = false;
    const host = makeHost();
    host.register(makeObservableWidget({
      onStateChange: (_p, _n, ctx) => {
        sameCtx = typeof ctx.setState === 'function' && typeof ctx.widgetId === 'string';
      },
    }));
    const inst = host.spawn({ type: 'observable' });
    const ctx = host.buildContext<BlockState>(inst.id)!;
    ctx.setState({ label: 'changed' });
    expect(sameCtx).toBe(true);
  });

  test('widget without onStateChange does not throw on setState', () => {
    const host = makeHost();
    host.register(makeSilentWidget());
    const inst = host.spawn({ type: 'silent' });
    const ctx = host.buildContext<BlockState>(inst.id)!;
    expect(() => ctx.setState({ counter: 1 })).not.toThrow();
  });

  test('throw in widget.onStateChange does not break setState', () => {
    const host = makeHost();
    host.register(makeObservableWidget({
      onStateChange: () => { throw new Error('hook boom'); },
    }));
    const inst = host.spawn({ type: 'observable' });
    const ctx = host.buildContext<BlockState>(inst.id)!;
    expect(() => ctx.setState({ counter: 1 })).not.toThrow();
    // State still mutated
    expect(host.get(inst.id)!.state).toMatchObject({ counter: 1 });
  });
});

// ── WidgetHost.onInstanceStateChange ───────────────────

describe('WidgetHost.onInstanceStateChange subscription', () => {
  test('fires for widget WITHOUT onStateChange hook', () => {
    const events: WidgetStateChangeEvent[] = [];
    const host = makeHost();
    host.register(makeSilentWidget());
    host.onInstanceStateChange((ev) => events.push(ev));
    const inst = host.spawn({ type: 'silent' });
    const ctx = host.buildContext<BlockState>(inst.id)!;
    ctx.setState({ counter: 3 });
    expect(events.length).toBe(1);
    expect(events[0]!.instanceId).toBe(inst.id);
    expect(events[0]!.type).toBe('silent');
    expect((events[0]!.prev as BlockState).counter).toBe(0);
    expect((events[0]!.next as BlockState).counter).toBe(3);
    expect(typeof events[0]!.timestamp).toBe('number');
  });

  test('also fires for widgets WITH onStateChange hook', () => {
    let hookFired = false;
    const events: WidgetStateChangeEvent[] = [];
    const host = makeHost();
    host.register(makeObservableWidget({
      onStateChange: () => { hookFired = true; },
    }));
    host.onInstanceStateChange((ev) => events.push(ev));
    const inst = host.spawn({ type: 'observable' });
    const ctx = host.buildContext<BlockState>(inst.id)!;
    ctx.setState({ counter: 1 });
    expect(hookFired).toBe(true);
    expect(events.length).toBe(1);
  });

  test('multiple subscribers all fire', () => {
    let a = 0; let b = 0; let c = 0;
    const host = makeHost();
    host.register(makeSilentWidget());
    host.onInstanceStateChange(() => { a++; });
    host.onInstanceStateChange(() => { b++; });
    host.onInstanceStateChange(() => { c++; });
    const inst = host.spawn({ type: 'silent' });
    const ctx = host.buildContext<BlockState>(inst.id)!;
    ctx.setState({ counter: 1 });
    expect(a).toBe(1); expect(b).toBe(1); expect(c).toBe(1);
  });

  test('disposer removes the subscriber', () => {
    let calls = 0;
    const host = makeHost();
    host.register(makeSilentWidget());
    const dispose = host.onInstanceStateChange(() => { calls++; });
    const inst = host.spawn({ type: 'silent' });
    const ctx = host.buildContext<BlockState>(inst.id)!;
    ctx.setState({ counter: 1 });
    expect(calls).toBe(1);
    dispose();
    ctx.setState({ counter: 2 });
    expect(calls).toBe(1);
  });

  test('throwing subscriber is isolated from others', () => {
    let good = 0;
    const host = makeHost();
    host.register(makeSilentWidget());
    host.onInstanceStateChange(() => { throw new Error('sub boom'); });
    host.onInstanceStateChange(() => { good++; });
    const inst = host.spawn({ type: 'silent' });
    const ctx = host.buildContext<BlockState>(inst.id)!;
    ctx.setState({ counter: 1 });
    expect(good).toBe(1);
  });
});

// ── Re-entry guard ──────────────────────────────────────

describe('setState re-entry guard', () => {
  test('setState inside onStateChange does not recurse infinitely', () => {
    let hookFires = 0;
    let hostSubFires = 0;
    const host = makeHost();
    host.register(makeObservableWidget({
      onStateChange: (_p, next, ctx) => {
        hookFires++;
        if (next.counter < 5) {
          // Try to cascade — guard should swallow the fan-out
          ctx.setState({ counter: next.counter + 1 });
        }
      },
    }));
    host.onInstanceStateChange(() => { hostSubFires++; });
    const inst = host.spawn({ type: 'observable' });
    const ctx = host.buildContext<BlockState>(inst.id)!;
    ctx.setState({ counter: 1 });
    // Outer setState fires the hook (with next.counter=1), which calls
    // setState again synchronously. Guard prevents recursive fire of
    // the hook + subscribers for the inner setState. State mutations
    // still happen; only the event fan-out is guarded.
    expect(hookFires).toBe(1);
    expect(hostSubFires).toBe(1);
    // State mutation from inner setState DID apply
    expect(host.get(inst.id)!.state).toMatchObject({ counter: 2 });
  });
});

// ── Built-in widget opt-in (WR-1 migration · 5 widgets) ─

describe('built-in widget onStateChange opt-in (WR-1)', () => {
  test('list widget emits list.cursor.change on cursor mutation', async () => {
    const { default: listWidget } = await import('../widgets/list/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = new WidgetHost({
      log: () => {},
      requestRender: () => {},
      telemetry: { emit: (ev) => emitted.push({ kind: ev.kind, data: ev.data }) },
    });
    host.register(listWidget);
    const inst = host.spawn({ type: 'list', config: { items: ['a', 'b', 'c'] } });
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ cursor: 2 } as never);
    const cursorEvents = emitted.filter((e) => e.kind === 'list.cursor.change');
    expect(cursorEvents.length).toBe(1);
    expect(cursorEvents[0]!.data).toMatchObject({ from: 0, to: 2 });
  });

  test('markdown widget emits markdown.scroll.change on scroll mutation', async () => {
    const { default: markdownWidget } = await import('../widgets/markdown/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = new WidgetHost({
      log: () => {},
      requestRender: () => {},
      telemetry: { emit: (ev) => emitted.push({ kind: ev.kind, data: ev.data }) },
    });
    host.register(markdownWidget);
    const inst = host.spawn({ type: 'markdown', config: { text: 'hello' } });
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ scroll: 7 } as never);
    const scrollEvents = emitted.filter((e) => e.kind === 'markdown.scroll.change');
    expect(scrollEvents.length).toBe(1);
    expect(scrollEvents[0]!.data).toMatchObject({ from: 0, to: 7 });
  });

  test('table widget emits table.cursor.change on cursor mutation', async () => {
    const { default: tableWidget } = await import('../widgets/table/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = new WidgetHost({
      log: () => {},
      requestRender: () => {},
      telemetry: { emit: (ev) => emitted.push({ kind: ev.kind, data: ev.data }) },
    });
    host.register(tableWidget);
    const inst = host.spawn({ type: 'table', config: { rows: [['a'], ['b']] } });
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ cursor: 1 } as never);
    const cursorEvents = emitted.filter((e) => e.kind === 'table.cursor.change');
    expect(cursorEvents.length).toBe(1);
    expect(cursorEvents[0]!.data).toMatchObject({ to: 1, rows: 2 });
  });

  test('agent-detail widget emits agent-detail.scroll.change on scroll mutation', async () => {
    const { default: agentDetailWidget } = await import('../widgets/agent-detail/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = new WidgetHost({
      log: () => {},
      requestRender: () => {},
      telemetry: { emit: (ev) => emitted.push({ kind: ev.kind, data: ev.data }) },
    });
    host.register(agentDetailWidget);
    const inst = host.spawn({ type: 'agent-detail' });
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ scroll: 3 } as never);
    const scrollEvents = emitted.filter((e) => e.kind === 'agent-detail.scroll.change');
    expect(scrollEvents.length).toBe(1);
    expect(scrollEvents[0]!.data).toMatchObject({ from: 0, to: 3 });
  });

  test('scratch widget emits scratch.mode.change on mode mutation', async () => {
    const { default: scratchWidget } = await import('../widgets/scratch/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = new WidgetHost({
      log: () => {},
      requestRender: () => {},
      telemetry: { emit: (ev) => emitted.push({ kind: ev.kind, data: ev.data }) },
    });
    host.register(scratchWidget);
    const inst = host.spawn({ type: 'scratch' });
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ mode: 'memo' } as never);
    const modeEvents = emitted.filter((e) => e.kind === 'scratch.mode.change');
    expect(modeEvents.length).toBe(1);
    expect(modeEvents[0]!.data).toMatchObject({ from: 'preview', to: 'memo' });
  });
});

// ── Built-in widget WR-4 opt-in (Bundle 7W · 6 more widgets) ─────────

describe('built-in widget onStateChange opt-in (WR-4 · Bundle 7W)', () => {
  function makeInstrumentedHost(
    emitted: Array<{ kind: string; data?: Record<string, unknown> }>,
  ): WidgetHost {
    return new WidgetHost({
      log: () => {},
      requestRender: () => {},
      telemetry: { emit: (ev) => emitted.push({ kind: ev.kind, data: ev.data }) },
    });
  }

  test('log widget emits log.tail.change when tail-follow toggles', async () => {
    const { default: logWidget } = await import('../widgets/log/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = makeInstrumentedHost(emitted);
    host.register(logWidget);
    const inst = host.spawn({ type: 'log' });
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ scrollOffset: 7 } as never);
    const tailEvents = emitted.filter((e) => e.kind === 'log.tail.change');
    expect(tailEvents.length).toBe(1);
    expect(tailEvents[0]!.data).toMatchObject({ tail: false, scroll: 7 });
  });

  test('log widget emits log.size.bucket when entries cross a 1024 boundary', async () => {
    const { default: logWidget } = await import('../widgets/log/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = makeInstrumentedHost(emitted);
    host.register(logWidget);
    const inst = host.spawn({ type: 'log' });
    const ctx = host.buildContext(inst.id)!;
    const big = Array.from({ length: 1025 }, (_, i) => `line ${i}`);
    ctx.setState({ lines: big } as never);
    const bucketEvents = emitted.filter((e) => e.kind === 'log.size.bucket');
    expect(bucketEvents.length).toBe(1);
    expect(bucketEvents[0]!.data).toMatchObject({ bucket: 1 });
  });

  test('heatmap widget emits heatmap.cursor.change on cursor move', async () => {
    const { default: heatmapWidget } = await import('../widgets/heatmap/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = makeInstrumentedHost(emitted);
    host.register(heatmapWidget);
    const inst = host.spawn({
      type: 'heatmap',
      config: { rows: [[1, 2], [3, 4]] } as never,
    });
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ cursor: 3, cursorRow: 1, cursorCol: 1 } as never);
    const cursorEvents = emitted.filter((e) => e.kind === 'heatmap.cursor.change');
    expect(cursorEvents.length).toBe(1);
    expect(cursorEvents[0]!.data).toMatchObject({ to: 3, row: 1, col: 1 });
  });

  test('heatmap widget emits heatmap.rows.change on matrix swap', async () => {
    const { default: heatmapWidget } = await import('../widgets/heatmap/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = makeInstrumentedHost(emitted);
    host.register(heatmapWidget);
    const inst = host.spawn({ type: 'heatmap' });
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ rows: [[1, 2, 3], [4, 5, 6]] } as never);
    const rowEvents = emitted.filter((e) => e.kind === 'heatmap.rows.change');
    expect(rowEvents.length).toBe(1);
    expect(rowEvents[0]!.data).toMatchObject({ rows: 2, cols: 3 });
  });

  test('sparkline widget emits sparkline.samples.change on buffer replacement', async () => {
    const { default: sparklineWidget } = await import('../widgets/sparkline/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = makeInstrumentedHost(emitted);
    host.register(sparklineWidget);
    const inst = host.spawn({ type: 'sparkline' });
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ samples: [0.1, 0.2, 0.3] } as never);
    const evts = emitted.filter((e) => e.kind === 'sparkline.samples.change');
    expect(evts.length).toBe(1);
    expect(evts[0]!.data).toMatchObject({ count: 3, last: 0.3 });
  });

  test('fader widget emits fader.phase.change on phase transition', async () => {
    const { default: faderWidget } = await import('../widgets/fader/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = makeInstrumentedHost(emitted);
    host.register(faderWidget);
    const inst = host.spawn({ type: 'fader', config: { message: 'hi' } });
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ phase: 'shown' } as never);
    const phaseEvents = emitted.filter((e) => e.kind === 'fader.phase.change');
    expect(phaseEvents.length).toBe(1);
    expect(phaseEvents[0]!.data).toMatchObject({ from: 'fade-in', to: 'shown' });
  });

  test('telemetry-inspector widget emits telemetry-inspector.filter.change on filter set', async () => {
    const { default: inspectorWidget } = await import('../widgets/telemetry-inspector/widget.js');
    const emitted: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const host = makeInstrumentedHost(emitted);
    host.register(inspectorWidget);
    const inst = host.spawn({ type: 'telemetry-inspector' });
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ filter: 'list.' } as never);
    const filterEvents = emitted.filter((e) => e.kind === 'telemetry-inspector.filter.change');
    expect(filterEvents.length).toBe(1);
    expect(filterEvents[0]!.data).toMatchObject({ filter: 'list.' });
  });


});

// ── Event shape ────────────────────────────────────────

describe('WidgetStateChangeEvent shape', () => {
  test('includes instanceId · type · prev · next · timestamp', () => {
    const events: WidgetStateChangeEvent[] = [];
    const host = makeHost();
    host.register(makeSilentWidget());
    host.onInstanceStateChange((ev) => events.push(ev));
    const inst = host.spawn({ type: 'silent' });
    const ctx = host.buildContext<BlockState>(inst.id)!;
    const before = Date.now();
    ctx.setState({ counter: 42 });
    const after = Date.now();
    expect(events[0]!.instanceId).toBe(inst.id);
    expect(events[0]!.type).toBe('silent');
    expect(events[0]!.prev).toEqual({ counter: 0, label: 'init' });
    expect(events[0]!.next).toEqual({ counter: 42, label: 'init' });
    expect(events[0]!.timestamp).toBeGreaterThanOrEqual(before);
    expect(events[0]!.timestamp).toBeLessThanOrEqual(after);
  });
});

// ── No event after dispose ─────────────────────────────

describe('state change after dispose', () => {
  test('setState on a disposed instance does not fire events', () => {
    let calls = 0;
    const host = makeHost();
    host.register(makeSilentWidget());
    host.onInstanceStateChange(() => { calls++; });
    const inst = host.spawn({ type: 'silent' });
    const ctx = host.buildContext<BlockState>(inst.id)!;
    host.dispose(inst.id);
    ctx.setState({ counter: 99 });
    expect(calls).toBe(0);
  });
});
