// ── WidgetHost snapshotHash + describeSurface tests — Bundle 5W P2/P4 (WR-2) ──
//
// Covers:
//   - WidgetHost.snapshotHashFor: widget override path + default FNV-1a path
//   - WidgetHost.describeSurfaceFor: widget override path + fallback
//   - Error isolation (widget throws in override → fall through to default)
//   - Circular/unserializable state → stable "<unhashable:...>" placeholder
//   - defaultSnapshotHash determinism
//   - 5 built-in widget migrate integration (list · markdown · table ·
//     agent-detail · scratch)

import { describe, test, expect } from 'bun:test';
import { WidgetHost, defaultSnapshotHash } from '../src/widgets/host.js';
import type { Widget, WidgetContext } from '../src/widgets/types.js';

function makeHost(): WidgetHost {
  return new WidgetHost({ log: () => {}, requestRender: () => {} });
}

interface S { counter: number; label: string }

function makeBasicWidget(opts: {
  snapshotHash?: (s: S) => string;
  describeSurface?: (s: S, ctx: WidgetContext<S>) => string;
}): Widget<S> {
  return {
    type: 'sample',
    description: 'sample widget',
    initialState: () => ({ counter: 0, label: 'init' }),
    render: () => [''],
    ...(opts.snapshotHash ? { snapshotHash: opts.snapshotHash } : {}),
    ...(opts.describeSurface ? { describeSurface: opts.describeSurface } : {}),
  };
}

// ── snapshotHashFor ────────────────────────────────────

describe('WidgetHost.snapshotHashFor', () => {
  test('uses widget override when present', () => {
    const host = makeHost();
    host.register(makeBasicWidget({
      snapshotHash: (s) => `override:${s.counter}`,
    }));
    const inst = host.spawn({ type: 'sample' });
    expect(host.snapshotHashFor(inst.id)).toBe('override:0');
    const ctx = host.buildContext<S>(inst.id)!;
    ctx.setState({ counter: 7 });
    expect(host.snapshotHashFor(inst.id)).toBe('override:7');
  });

  test('falls back to default FNV-1a when widget omits snapshotHash', () => {
    const host = makeHost();
    host.register(makeBasicWidget({}));
    const inst = host.spawn({ type: 'sample' });
    const hash = host.snapshotHashFor(inst.id);
    expect(typeof hash).toBe('string');
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  test('returns null for unknown instance id', () => {
    const host = makeHost();
    expect(host.snapshotHashFor('no-such-widget')).toBeNull();
  });

  test('widget override throw → fall through to default (no error)', () => {
    const host = makeHost();
    host.register(makeBasicWidget({
      snapshotHash: () => { throw new Error('hash boom'); },
    }));
    const inst = host.spawn({ type: 'sample' });
    const hash = host.snapshotHashFor(inst.id);
    expect(typeof hash).toBe('string');
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  test('circular state → <unhashable:type> placeholder (no throw)', () => {
    const host = makeHost();
    // Circular state built after spawn — initialState returns the seed,
    // then we mutate via raw host.instances path to inject a cycle (the
    // "anti-pattern" row in WR-2 contract).
    host.register(makeBasicWidget({}));
    const inst = host.spawn({ type: 'sample' });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    (host.get(inst.id)!).state = cycle;
    expect(host.snapshotHashFor(inst.id)).toBe('<unhashable:sample>');
  });

  test('equal state references yield equal hashes (cache-friendly)', () => {
    const host = makeHost();
    host.register(makeBasicWidget({}));
    const inst = host.spawn({ type: 'sample' });
    const h1 = host.snapshotHashFor(inst.id);
    const h2 = host.snapshotHashFor(inst.id);
    expect(h1).toBe(h2);
  });

  test('structurally-equal states with default hash yield equal hashes', () => {
    const host = makeHost();
    host.register(makeBasicWidget({}));
    const a = host.spawn({ type: 'sample' });
    const b = host.spawn({ type: 'sample' });
    expect(host.snapshotHashFor(a.id)).toBe(host.snapshotHashFor(b.id));
  });
});

// ── defaultSnapshotHash unit ───────────────────────────

describe('defaultSnapshotHash', () => {
  test('deterministic — same input ⇒ same output', () => {
    expect(defaultSnapshotHash({ a: 1, b: 'hi' }, 'x'))
      .toBe(defaultSnapshotHash({ a: 1, b: 'hi' }, 'x'));
  });

  test('different input ⇒ different output', () => {
    expect(defaultSnapshotHash({ x: 1 }, 'sample'))
      .not.toBe(defaultSnapshotHash({ x: 2 }, 'sample'));
  });

  test('8-hex-char format', () => {
    const h = defaultSnapshotHash({ a: 'something' }, 'sample');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  test('unserializable input → stable <unhashable:type> placeholder', () => {
    const cyc: { s?: unknown } = {};
    cyc.s = cyc;
    expect(defaultSnapshotHash(cyc, 'foo')).toBe('<unhashable:foo>');
    expect(defaultSnapshotHash(cyc, 'bar')).toBe('<unhashable:bar>');
  });
});

// ── describeSurfaceFor ─────────────────────────────────

describe('WidgetHost.describeSurfaceFor', () => {
  test('uses widget override when present', () => {
    const host = makeHost();
    host.register(makeBasicWidget({
      describeSurface: (s, ctx) => `override · ${ctx.character} · counter=${s.counter}`,
    }));
    const inst = host.spawn({ type: 'sample', character: 'MyWidget' });
    const out = host.describeSurfaceFor(inst.id);
    expect(out).toContain('MyWidget');
    expect(out).toContain('counter=0');
  });

  test('falls back to <type>(<id>) · <character> when no override', () => {
    const host = makeHost();
    host.register(makeBasicWidget({}));
    const inst = host.spawn({ type: 'sample', character: 'Sample' });
    const out = host.describeSurfaceFor(inst.id);
    expect(out).toBe(`sample(${inst.id}) · Sample`);
  });

  test('returns null for unknown instance id', () => {
    const host = makeHost();
    expect(host.describeSurfaceFor('no-such-widget')).toBeNull();
  });

  test('widget override throw → fall through to default', () => {
    const host = makeHost();
    host.register(makeBasicWidget({
      describeSurface: () => { throw new Error('describe boom'); },
    }));
    const inst = host.spawn({ type: 'sample', character: 'Sample' });
    const out = host.describeSurfaceFor(inst.id);
    expect(out).toBe(`sample(${inst.id}) · Sample`);
  });

  test('widget override empty-string → fall through to default', () => {
    const host = makeHost();
    host.register(makeBasicWidget({
      describeSurface: () => '',
    }));
    const inst = host.spawn({ type: 'sample', character: 'Sample' });
    expect(host.describeSurfaceFor(inst.id))
      .toBe(`sample(${inst.id}) · Sample`);
  });
});

// ── 5 widget migrate integration ──────────────────────

describe('built-in widget WR-2 opt-in (5 widgets)', () => {
  test('list widget — snapshotHash covers cursor + selection + items', async () => {
    const { default: listWidget } = await import('../widgets/list/widget.js');
    const host = makeHost();
    host.register(listWidget);
    const inst = host.spawn({ type: 'list', config: { items: ['a', 'b', 'c'] } });
    const h0 = host.snapshotHashFor(inst.id);
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ cursor: 2 } as never);
    const h1 = host.snapshotHashFor(inst.id);
    expect(h0).not.toBe(h1);
    ctx.setState({ selected: new Set([1, 2]) } as never);
    const h2 = host.snapshotHashFor(inst.id);
    expect(h2).not.toBe(h1);
  });

  test('list widget — describeSurface includes cursor + item count', async () => {
    const { default: listWidget } = await import('../widgets/list/widget.js');
    const host = makeHost();
    host.register(listWidget);
    const inst = host.spawn({ type: 'list', config: { items: ['a', 'b', 'c'] } });
    const desc = host.describeSurfaceFor(inst.id)!;
    expect(desc).toContain('3 items');
    expect(desc).toContain('cursor 0');
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ selected: new Set([0, 1]) } as never);
    const desc2 = host.describeSurfaceFor(inst.id)!;
    expect(desc2).toContain('2 selected');
  });

  test('markdown widget — scroll bumps hash + appears in describe', async () => {
    const { default: markdownWidget } = await import('../widgets/markdown/widget.js');
    const host = makeHost();
    host.register(markdownWidget);
    const inst = host.spawn({ type: 'markdown', config: { text: 'some text' } });
    const h0 = host.snapshotHashFor(inst.id);
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ scroll: 7 } as never);
    expect(host.snapshotHashFor(inst.id)).not.toBe(h0);
    expect(host.describeSurfaceFor(inst.id)!).toContain('scroll 7');
  });

  test('table widget — cursor + rows length in hash + describe', async () => {
    const { default: tableWidget } = await import('../widgets/table/widget.js');
    const host = makeHost();
    host.register(tableWidget);
    const inst = host.spawn({ type: 'table', config: {
      columns: [{ key: 'x', label: 'X' }],
      rows: [['a'], ['b']],
    } as never });
    const h0 = host.snapshotHashFor(inst.id);
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ cursor: 1 } as never);
    expect(host.snapshotHashFor(inst.id)).not.toBe(h0);
    const desc = host.describeSurfaceFor(inst.id)!;
    expect(desc).toContain('2 rows');
    expect(desc).toContain('1 cols');
    expect(desc).toContain('cursor row 1');
  });

  test('agent-detail widget — agent id + scroll in hash + describe', async () => {
    const { default: agentDetailWidget } = await import('../widgets/agent-detail/widget.js');
    const host = makeHost();
    host.register(agentDetailWidget);
    const inst = host.spawn({ type: 'agent-detail' });
    const h0 = host.snapshotHashFor(inst.id);
    expect(host.describeSurfaceFor(inst.id)!).toContain('no agent selected');
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({
      agent: { id: 'agent-1', name: 'parse-repo' },
      scroll: 3,
    } as never);
    expect(host.snapshotHashFor(inst.id)).not.toBe(h0);
    const desc = host.describeSurfaceFor(inst.id)!;
    expect(desc).toContain('parse-repo');
    expect(desc).toContain('scroll 3');
  });

  test('scratch widget — mode + memo cursor + dirty in hash, rich describe per mode', async () => {
    const { default: scratchWidget } = await import('../widgets/scratch/widget.js');
    const host = makeHost();
    host.register(scratchWidget);
    const inst = host.spawn({ type: 'scratch' });
    const h0 = host.snapshotHashFor(inst.id);
    const desc0 = host.describeSurfaceFor(inst.id)!;
    expect(desc0).toContain('mode=preview');

    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ mode: 'memo' } as never);
    const h1 = host.snapshotHashFor(inst.id);
    expect(h1).not.toBe(h0);
    const desc1 = host.describeSurfaceFor(inst.id)!;
    expect(desc1).toContain('mode=memo');
    expect(desc1).toMatch(/\d+ lines/);
    expect(desc1).toMatch(/cursor 0:0/);

    ctx.setState({ memoDirty: true, memoLineIdx: 5, memoColIdx: 3 } as never);
    const desc2 = host.describeSurfaceFor(inst.id)!;
    expect(desc2).toContain('cursor 5:3');
    expect(desc2).toContain('dirty');
  });
});

// ── 6 widget WR-4 migrate integration (Bundle 7W) ─────────

describe('built-in widget WR-2 opt-in (WR-4 · 6 more widgets)', () => {
  test('log widget — tail-follow + scroll + entry count in hash + describe', async () => {
    const { default: logWidget } = await import('../widgets/log/widget.js');
    const host = makeHost();
    host.register(logWidget);
    const inst = host.spawn({ type: 'log' });
    const h0 = host.snapshotHashFor(inst.id);
    expect(host.describeSurfaceFor(inst.id)!).toContain('0 entries');
    expect(host.describeSurfaceFor(inst.id)!).toContain('tail');
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ scrollOffset: 3 } as never);
    expect(host.snapshotHashFor(inst.id)).not.toBe(h0);
    expect(host.describeSurfaceFor(inst.id)!).toContain('scroll 3');
  });

  test('heatmap widget — cursor + dims in hash + describe', async () => {
    const { default: heatmapWidget } = await import('../widgets/heatmap/widget.js');
    const host = makeHost();
    host.register(heatmapWidget);
    const inst = host.spawn({ type: 'heatmap', config: { rows: [[1, 2], [3, 4]] } as never });
    const h0 = host.snapshotHashFor(inst.id);
    const desc0 = host.describeSurfaceFor(inst.id)!;
    expect(desc0).toContain('2×2');
    expect(desc0).toContain('cursor (0,0)');
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ cursor: 3, cursorRow: 1, cursorCol: 1 } as never);
    expect(host.snapshotHashFor(inst.id)).not.toBe(h0);
    expect(host.describeSurfaceFor(inst.id)!).toContain('cursor (1,1)');
  });

  test('sparkline widget — count + last-bucket + describe', async () => {
    const { default: sparklineWidget } = await import('../widgets/sparkline/widget.js');
    const host = makeHost();
    host.register(sparklineWidget);
    const inst = host.spawn({ type: 'sparkline' });
    const h0 = host.snapshotHashFor(inst.id);
    expect(host.describeSurfaceFor(inst.id)!).toContain('0 points');
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ samples: [1, 2, 3, 4] } as never);
    expect(host.snapshotHashFor(inst.id)).not.toBe(h0);
    const desc = host.describeSurfaceFor(inst.id)!;
    expect(desc).toContain('4 points');
    expect(desc).toContain('avg 2.50');
    expect(desc).toContain('last 4.00');
  });

  test('fader widget — phase + tone + message length in hash + describe', async () => {
    const { default: faderWidget } = await import('../widgets/fader/widget.js');
    const host = makeHost();
    host.register(faderWidget);
    const inst = host.spawn({
      type: 'fader',
      config: { message: 'hello', tone: 'warning' as const },
    });
    const h0 = host.snapshotHashFor(inst.id);
    const desc0 = host.describeSurfaceFor(inst.id)!;
    expect(desc0).toContain('fade-in');
    expect(desc0).toContain('warning');
    expect(desc0).toContain('5 chars');
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ phase: 'shown' } as never);
    expect(host.snapshotHashFor(inst.id)).not.toBe(h0);
    expect(host.describeSurfaceFor(inst.id)!).toContain('shown');
  });

  test('telemetry-inspector widget — filter + cursor + sink size in hash + describe', async () => {
    const { default: inspectorWidget } = await import('../widgets/telemetry-inspector/widget.js');
    const host = makeHost();
    host.register(inspectorWidget);
    const inst = host.spawn({ type: 'telemetry-inspector' });
    const h0 = host.snapshotHashFor(inst.id);
    expect(host.describeSurfaceFor(inst.id)!).toContain('sink 0');
    const ctx = host.buildContext(inst.id)!;
    ctx.setState({ filter: 'agent', sinkSize: 7 } as never);
    expect(host.snapshotHashFor(inst.id)).not.toBe(h0);
    const desc = host.describeSurfaceFor(inst.id)!;
    expect(desc).toContain('filter "agent"');
    expect(desc).toContain('sink 7');
  });


});
