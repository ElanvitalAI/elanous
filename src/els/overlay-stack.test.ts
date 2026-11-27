import { describe, expect, test } from 'bun:test';
import {
  closeKind, closeLayer, closeWorkspace, compareLayers, emptyStack, escape, expireLayers, focusLayer, focusTop, hitTest, keyRoute,
  lowerLayer, nextExpiry, openLayer, paintOrder, parseLayer, parseRect, parseStack, raiseLayer, resolveRect, setBase, shownIn, updateLayer,
  visibleLayers, type OverlayStack,
} from './overlay-stack.js';

const VIEW = { cols: 100, rows: 40 };
const ids = (stack: OverlayStack): string[] => stack.layers.map((layer) => layer.id);
const open = (stack: OverlayStack, spec: Parameters<typeof openLayer>[1]) => openLayer(stack, spec);

describe('z order: bands and in-band seq', () => {
  test('six tiers bottom → top: float < popup < modal < toast < system, whatever the open order', () => {
    let s = emptyStack('pane:p1');
    s = open(s, { kind: 'toast', key: 't', band: 'toast', focus: 'none' }).stack;
    s = open(s, { kind: 'decision', key: 'd', band: 'modal' }).stack;
    s = open(s, { kind: 'memo', key: 'm', band: 'float' }).stack;
    s = open(s, { kind: 'menu', key: 'x', band: 'popup' }).stack;
    s = open(s, { kind: 'hud', key: 'h', band: 'system', focus: 'none' }).stack;
    expect(s.layers.map((layer) => layer.band)).toEqual(['float', 'popup', 'modal', 'toast', 'system']);
  });

  test('compareLayers: band first, then seq, then id for ties', () => {
    expect(Math.sign(compareLayers({ band: 'float', seq: 9, id: 'a' }, { band: 'modal', seq: 1, id: 'b' }))).toBe(-1);
    expect(Math.sign(compareLayers({ band: 'float', seq: 1, id: 'a' }, { band: 'float', seq: 2, id: 'b' }))).toBe(-1);
    expect(Math.sign(compareLayers({ band: 'float', seq: 1, id: 'b' }, { band: 'float', seq: 1, id: 'a' }))).toBe(1);
    expect(compareLayers({ band: 'float', seq: 1, id: 'a' }, { band: 'float', seq: 1, id: 'a' })).toBe(0);
  });

  test('a later float sits above an earlier float; both stay under a modal', () => {
    let s = emptyStack();
    s = open(s, { kind: 'decision', key: 'd', band: 'modal' }).stack;
    s = open(s, { kind: 'memo', key: 'a' }).stack;
    s = open(s, { kind: 'memo', key: 'b' }).stack;
    expect(s.layers.map((l) => l.key)).toEqual(['a', 'b', 'd']);
  });

  test('raise stays inside the band (a float never climbs over a modal) and does not move focus', () => {
    let s = emptyStack('pane:p');
    const a = open(s, { kind: 'memo', key: 'a' }); s = a.stack;
    s = open(s, { kind: 'memo', key: 'b' }).stack;
    s = open(s, { kind: 'decision', key: 'd', band: 'modal' }).stack;
    const focusBefore = s.focus;
    s = raiseLayer(s, a.id);
    expect(s.layers.map((l) => l.key)).toEqual(['b', 'a', 'd']);
    expect(s.focus).toEqual(focusBefore);
  });

  test('raise of the band top and of an unknown id change nothing (same rev)', () => {
    let s = emptyStack();
    const a = open(s, { kind: 'memo', key: 'a' }); s = a.stack;
    expect(raiseLayer(s, a.id)).toBe(s);
    expect(raiseLayer(s, 'nope')).toBe(s);
  });

  test('lower goes to the bottom of its band only', () => {
    let s = emptyStack();
    s = open(s, { kind: 'menu', key: 'p', band: 'popup' }).stack;
    s = open(s, { kind: 'memo', key: 'a' }).stack;
    const b = open(s, { kind: 'memo', key: 'b' }); s = b.stack;
    s = lowerLayer(s, b.id);
    expect(s.layers.map((l) => l.key)).toEqual(['b', 'a', 'p']);
    expect(lowerLayer(s, b.id)).toBe(s);
    expect(lowerLayer(s, 'nope')).toBe(s);
  });
});

describe('open / close and the focus stack', () => {
  test('open is idempotent per kind+key: a second open raises and refreshes props, never duplicates', () => {
    let s = emptyStack();
    const first = open(s, { kind: 'memo', key: 'k', props: { v: 1 } }); s = first.stack;
    s = open(s, { kind: 'memo', key: 'other' }).stack;
    const again = open(s, { kind: 'memo', key: 'k', props: { v: 2 } });
    expect(again.raised).toBe(true);
    expect(again.id).toBe(first.id);
    expect(again.stack.layers).toHaveLength(2);
    expect(again.stack.layers.at(-1)!.id).toBe(first.id);
    expect(again.stack.layers.at(-1)!.props).toEqual({ v: 2 });
    expect(again.stack.focus.at(-1)).toBe(first.id);
  });

  test('a reopened minimized layer is shown again', () => {
    let s = emptyStack();
    const a = open(s, { kind: 'memo', key: 'k' }); s = updateLayer(a.stack, a.id, { minimized: true });
    expect(visibleLayers(s, undefined)).toHaveLength(0);
    s = open(s, { kind: 'memo', key: 'k' }).stack;
    expect(visibleLayers(s, undefined)).toHaveLength(1);
  });

  test('focus: none layers never enter the focus stack', () => {
    const s = open(emptyStack('pane:p'), { kind: 'toast', key: 't', band: 'toast', focus: 'none' }).stack;
    expect(s.focus).toEqual(['pane:p']);
    expect(focusTop(s, undefined)).toEqual({ kind: 'base', target: 'pane:p' });
  });

  test('close pops focus back to what was below — a stack, not one previous slot', () => {
    let s = emptyStack('pane:p');
    const a = open(s, { kind: 'memo', key: 'a' }); s = a.stack;
    const b = open(s, { kind: 'memo', key: 'b' }); s = b.stack;
    const c = open(s, { kind: 'memo', key: 'c' }); s = c.stack;
    expect(s.focus).toEqual(['pane:p', a.id, b.id, c.id]);
    s = closeLayer(s, c.id);
    expect(focusTop(s, undefined)).toMatchObject({ kind: 'layer', layer: { id: b.id } });
    s = closeLayer(s, b.id);
    expect(focusTop(s, undefined)).toMatchObject({ kind: 'layer', layer: { id: a.id } });
    s = closeLayer(s, a.id);
    expect(focusTop(s, undefined)).toEqual({ kind: 'base', target: 'pane:p' });
  });

  test('closing a layer in the middle of the focus stack keeps the order of the rest', () => {
    let s = emptyStack('pane:p');
    const a = open(s, { kind: 'memo', key: 'a' }); s = a.stack;
    const b = open(s, { kind: 'memo', key: 'b' }); s = b.stack;
    const c = open(s, { kind: 'memo', key: 'c' }); s = c.stack;
    s = closeLayer(s, b.id);
    expect(s.focus).toEqual(['pane:p', a.id, c.id]);
    expect(ids(s)).toEqual([a.id, c.id]);
  });

  test('closing an unknown id returns the same stack (no rev bump, no push)', () => {
    const s = open(emptyStack(), { kind: 'memo', key: 'a' }).stack;
    expect(closeLayer(s, 'missing')).toBe(s);
  });

  test('focusLayer moves a layer to the focus top without changing z; none-layers cannot take focus', () => {
    let s = emptyStack('pane:p');
    const a = open(s, { kind: 'memo', key: 'a' }); s = a.stack;
    const b = open(s, { kind: 'memo', key: 'b' }); s = b.stack;
    const t = open(s, { kind: 'toast', key: 't', band: 'toast', focus: 'none' }); s = t.stack;
    const z = ids(s);
    s = focusLayer(s, a.id);
    expect(s.focus).toEqual(['pane:p', b.id, a.id]);
    expect(ids(s)).toEqual(z);
    expect(focusLayer(s, t.id)).toBe(s);
    expect(focusLayer(s, a.id)).toBe(s);
  });

  test('tabs, tiles and popups share ONE focus stack: switching the base keeps the popups above it', () => {
    let s = emptyStack('pane:p1');
    const a = open(s, { kind: 'memo', key: 'a' }); s = a.stack;
    s = setBase(s, 'tile:p2');
    expect(s.focus).toEqual(['tile:p2', a.id]);
    s = closeLayer(s, a.id);
    expect(focusTop(s, undefined)).toEqual({ kind: 'base', target: 'tile:p2' });
    expect(setBase(s, 'tile:p2')).toBe(s);
  });

  test('closeKind closes every layer of that kind and nothing else', () => {
    let s = emptyStack();
    s = open(s, { kind: 'toast', key: '1', band: 'toast', focus: 'none' }).stack;
    s = open(s, { kind: 'toast', key: '2', band: 'toast', focus: 'none' }).stack;
    s = open(s, { kind: 'memo', key: 'm' }).stack;
    s = closeKind(s, 'toast');
    expect(s.layers.map((l) => l.kind)).toEqual(['memo']);
  });

  test('every change bumps rev exactly once', () => {
    let s = emptyStack();
    const a = open(s, { kind: 'memo', key: 'a' }); expect(a.stack.rev).toBe(1); s = a.stack;
    s = open(s, { kind: 'memo', key: 'b' }).stack; expect(s.rev).toBe(2);
    s = raiseLayer(s, a.id); expect(s.rev).toBe(3);
    s = closeLayer(s, a.id); expect(s.rev).toBe(4);
  });

  test('new floats cascade (2 right, 1 down per float) unless a rect is given', () => {
    let s = emptyStack();
    s = open(s, { kind: 'memo', key: 'a' }).stack;
    s = open(s, { kind: 'memo', key: 'b' }).stack;
    s = open(s, { kind: 'memo', key: 'c', rect: { anchor: 'tl', w: 10, h: 5 } }).stack;
    expect(s.layers.map((l) => [l.rect.dx ?? 0, l.rect.dy ?? 0])).toEqual([[0, 0], [2, 1], [0, 0]]);
  });
});

describe('workspaces, pins and expiry', () => {
  test('pin:space layers show only in their workspace; pin:all everywhere; no owner = everywhere', () => {
    let s = emptyStack();
    s = open(s, { kind: 'memo', key: 'a', ownerWorkspace: 'W1' }).stack;
    s = open(s, { kind: 'memo', key: 'b', ownerWorkspace: 'W1', pin: 'all' }).stack;
    s = open(s, { kind: 'memo', key: 'c' }).stack;
    expect(visibleLayers(s, 'W1').map((l) => l.key)).toEqual(['a', 'b', 'c']);
    expect(visibleLayers(s, 'W2').map((l) => l.key)).toEqual(['b', 'c']);
    expect(visibleLayers(s, undefined).map((l) => l.key)).toEqual(['b', 'c']);
    expect(shownIn({ ...s.layers[0]!, minimized: true }, 'W1')).toBe(false);
  });

  test('a layer of another space is hidden from focus while away and returns on coming back', () => {
    let s = emptyStack('pane:p');
    const a = open(s, { kind: 'memo', key: 'a', ownerWorkspace: 'W1' }); s = a.stack;
    expect(focusTop(s, 'W2')).toEqual({ kind: 'base', target: 'pane:p' });
    expect(focusTop(s, 'W1')).toMatchObject({ kind: 'layer', layer: { id: a.id } });
  });

  test('closing a workspace closes its pin:space layers (cascade) and keeps pin:all ones', () => {
    let s = emptyStack('pane:p');
    s = open(s, { kind: 'memo', key: 'a', ownerWorkspace: 'W1' }).stack;
    s = open(s, { kind: 'memo', key: 'b', ownerWorkspace: 'W1', pin: 'all' }).stack;
    s = open(s, { kind: 'memo', key: 'c', ownerWorkspace: 'W2' }).stack;
    s = closeWorkspace(s, 'W1');
    expect(s.layers.map((l) => l.key)).toEqual(['b', 'c']);
    expect(s.focus).toHaveLength(3);
  });

  test('nextExpiry is the earliest due time; expireLayers removes only what is due', () => {
    let s = emptyStack();
    expect(nextExpiry(s)).toBeUndefined();
    s = open(s, { kind: 'toast', key: '1', band: 'toast', focus: 'none', expiresAt: 5_000 }).stack;
    s = open(s, { kind: 'toast', key: '2', band: 'toast', focus: 'none', expiresAt: 3_000 }).stack;
    s = open(s, { kind: 'memo', key: 'm' }).stack;
    expect(nextExpiry(s)).toBe(3_000);
    s = expireLayers(s, 3_000);
    expect(s.layers.map((l) => l.key)).toEqual(['m', '1']);
    expect(nextExpiry(s)).toBe(5_000);
    expect(expireLayers(s, 4_999)).toBe(s);
  });

  test('re-opening a toast with a new expiry pushes its expiry out', () => {
    let s = open(emptyStack(), { kind: 'toast', key: 't', band: 'toast', focus: 'none', expiresAt: 1_000 }).stack;
    s = open(s, { kind: 'toast', key: 't', band: 'toast', focus: 'none', expiresAt: 9_000 }).stack;
    expect(nextExpiry(s)).toBe(9_000);
  });
});

describe('rects', () => {
  test('anchors place the box; percentages follow the view size', () => {
    expect(resolveRect({ anchor: 'center', w: '50%', h: '50%' }, VIEW)).toEqual({ x: 25, y: 10, w: 50, h: 20 });
    expect(resolveRect({ anchor: 'tl', w: 10, h: 4 }, VIEW)).toEqual({ x: 0, y: 0, w: 10, h: 4 });
    expect(resolveRect({ anchor: 'tr', w: 10, h: 4 }, VIEW)).toEqual({ x: 90, y: 0, w: 10, h: 4 });
    expect(resolveRect({ anchor: 'bl', w: 10, h: 4 }, VIEW)).toEqual({ x: 0, y: 36, w: 10, h: 4 });
    expect(resolveRect({ anchor: 'br', w: 10, h: 4 }, VIEW)).toEqual({ x: 90, y: 36, w: 10, h: 4 });
    expect(resolveRect({ anchor: 'top', w: 10, h: 4 }, VIEW)).toEqual({ x: 45, y: 0, w: 10, h: 4 });
    expect(resolveRect({ anchor: 'bottom', w: 10, h: 4 }, VIEW)).toEqual({ x: 45, y: 36, w: 10, h: 4 });
  });

  test('offsets apply and the box is clamped inside the view; an oversized box shrinks to the view', () => {
    expect(resolveRect({ anchor: 'tr', w: 10, h: 4, dx: -2, dy: 1 }, VIEW)).toEqual({ x: 88, y: 1, w: 10, h: 4 });
    expect(resolveRect({ anchor: 'tr', w: 10, h: 4, dx: 50 }, VIEW)).toEqual({ x: 90, y: 0, w: 10, h: 4 });
    expect(resolveRect({ anchor: 'center', w: 500, h: 500 }, { cols: 80, rows: 24 })).toEqual({ x: 0, y: 0, w: 80, h: 24 });
    expect(resolveRect({ anchor: 'center', w: 0, h: 0 }, { cols: 80, rows: 24 })).toMatchObject({ w: 1, h: 1 });
  });

  test('the same relative rect re-resolves for a small and a large view', () => {
    const rect = { anchor: 'br' as const, w: '40%' as const, h: 3, dx: -1, dy: -1 };
    expect(resolveRect(rect, { cols: 200, rows: 80 })).toEqual({ x: 119, y: 76, w: 80, h: 3 });
    expect(resolveRect(rect, { cols: 80, rows: 24 })).toEqual({ x: 47, y: 20, w: 32, h: 3 });
  });
});

describe('hit test: top → down, click-through, blocking', () => {
  const base = (): { s: OverlayStack; lower: string; upper: string } => {
    let s = emptyStack('pane:p');
    const lower = open(s, { kind: 'memo', key: 'lower', rect: { anchor: 'tl', w: 20, h: 10 } }); s = lower.stack;
    const upper = open(s, { kind: 'memo', key: 'upper', rect: { anchor: 'tl', w: 10, h: 5, dx: 5, dy: 2 } }); s = upper.stack;
    return { s, lower: lower.id, upper: upper.id };
  };

  test('the topmost layer under the point wins, with layer-local coordinates', () => {
    const { s, upper } = base();
    expect(hitTest(s, VIEW, 6, 3, undefined)).toMatchObject({ kind: 'layer', layer: { id: upper }, local: { x: 1, y: 1 } });
  });

  test('a point outside the upper layer goes DOWN to the lower one (classic hit only the top)', () => {
    const { s, lower } = base();
    expect(hitTest(s, VIEW, 1, 8, undefined)).toMatchObject({ kind: 'layer', layer: { id: lower }, local: { x: 1, y: 8 } });
  });

  test('outside every layer = the base (pane / tile)', () => {
    const { s } = base();
    expect(hitTest(s, VIEW, 50, 30, undefined)).toEqual({ kind: 'base' });
    expect(hitTest(emptyStack(), VIEW, 0, 0, undefined)).toEqual({ kind: 'base' });
  });

  test('focus:none (toast) and participates layers are clicked through', () => {
    let { s, upper } = base();
    s = open(s, { kind: 'toast', key: 't', band: 'toast', focus: 'none', rect: { anchor: 'tl', w: 100, h: 40 } }).stack;
    expect(hitTest(s, VIEW, 6, 3, undefined)).toMatchObject({ kind: 'layer', layer: { id: upper } });
    s = open(s, { kind: 'hint', key: 'h', band: 'popup', focus: 'participates', rect: { anchor: 'tl', w: 100, h: 40 } }).stack;
    expect(hitTest(s, VIEW, 60, 30, undefined)).toEqual({ kind: 'base' });
  });

  test('a blocking modal swallows a click outside it; nothing below is reached', () => {
    let { s } = base();
    const modal = open(s, { kind: 'decision', key: 'd', band: 'modal', blocking: true, rect: { anchor: 'br', w: 10, h: 4 } }); s = modal.stack;
    expect(hitTest(s, VIEW, 6, 3, undefined)).toEqual({ kind: 'blocked', layer: s.layers.at(-1)! });
    expect(hitTest(s, VIEW, 95, 38, undefined)).toMatchObject({ kind: 'layer', layer: { id: modal.id } });
  });

  test('a non-blocking modal lets an outside click through', () => {
    let { s, upper } = base();
    s = open(s, { kind: 'decision', key: 'd', band: 'modal', rect: { anchor: 'br', w: 10, h: 4 } }).stack;
    expect(hitTest(s, VIEW, 6, 3, undefined)).toMatchObject({ kind: 'layer', layer: { id: upper } });
  });

  test('layers of another workspace are not hit', () => {
    let s = emptyStack();
    s = open(s, { kind: 'memo', key: 'a', ownerWorkspace: 'W1', rect: { anchor: 'tl', w: 10, h: 10 } }).stack;
    expect(hitTest(s, VIEW, 1, 1, 'W2')).toEqual({ kind: 'base' });
    expect(hitTest(s, VIEW, 1, 1, 'W1')).toMatchObject({ kind: 'layer' });
  });

  test('after a raise the hit follows the new z order (no drift between paint order and hit order)', () => {
    let { s, lower } = base();
    s = raiseLayer(s, lower);
    expect(hitTest(s, VIEW, 6, 3, undefined)).toMatchObject({ kind: 'layer', layer: { id: lower } });
    expect(paintOrder(s, VIEW, undefined).at(-1)!.layer.id).toBe(lower);
  });
});

describe('key routing', () => {
  test('focus stack top first, then down, ending at the base', () => {
    let s = emptyStack('pane:p');
    const a = open(s, { kind: 'memo', key: 'a' }); s = a.stack;
    const b = open(s, { kind: 'hint', key: 'b', band: 'popup', focus: 'participates' }); s = b.stack;
    s = open(s, { kind: 'toast', key: 't', band: 'toast', focus: 'none' }).stack;
    expect(keyRoute(s, undefined).map((r) => r.kind === 'layer' ? r.layer.id : r.target)).toEqual([b.id, a.id, 'pane:p']);
  });

  test('a blocking layer owns every key: the route is that layer alone', () => {
    let s = emptyStack('pane:p');
    const m = open(s, { kind: 'decision', key: 'd', band: 'modal', blocking: true }); s = m.stack;
    const a = open(s, { kind: 'memo', key: 'a' }); s = a.stack;
    s = focusLayer(s, a.id);
    expect(keyRoute(s, undefined).map((r) => r.kind === 'layer' ? r.layer.id : r.target)).toEqual([m.id]);
  });

  test('Esc closes the focused layer; at the base Esc changes nothing', () => {
    let s = emptyStack('pane:p');
    const a = open(s, { kind: 'memo', key: 'a' }); s = a.stack;
    const out = escape(s, undefined);
    expect(out.closed).toBe(a.id);
    expect(out.stack.layers).toHaveLength(0);
    const again = escape(out.stack, undefined);
    expect(again.closed).toBeUndefined();
    expect(again.stack).toBe(out.stack);
  });
});

describe('paint order and occlusion', () => {
  test('bottom → top; a layer fully under an opaque layer is skipped; a transparent one does not occlude', () => {
    let s = emptyStack();
    s = open(s, { kind: 'memo', key: 'small', rect: { anchor: 'tl', w: 5, h: 2 } }).stack;
    s = open(s, { kind: 'memo', key: 'big', rect: { anchor: 'tl', w: 20, h: 10 } }).stack;
    expect(paintOrder(s, VIEW, undefined).map((p) => p.layer.key)).toEqual(['big']);
    let t = emptyStack();
    t = open(t, { kind: 'memo', key: 'small', rect: { anchor: 'tl', w: 5, h: 2 } }).stack;
    t = open(t, { kind: 'veil', key: 'v', opaque: false, rect: { anchor: 'tl', w: 20, h: 10 } }).stack;
    expect(paintOrder(t, VIEW, undefined).map((p) => p.layer.key)).toEqual(['small', 'v']);
  });

  test('partly covered layers are painted', () => {
    let s = emptyStack();
    s = open(s, { kind: 'memo', key: 'a', rect: { anchor: 'tl', w: 10, h: 5 } }).stack;
    s = open(s, { kind: 'memo', key: 'b', rect: { anchor: 'tl', w: 10, h: 5, dx: 3 } }).stack;
    expect(paintOrder(s, VIEW, undefined).map((p) => [p.layer.key, p.box.x])).toEqual([['a', 0], ['b', 3]]);
  });
});

describe('parsing untrusted JSON', () => {
  test('a stack survives a JSON round trip unchanged', () => {
    let s = emptyStack('pane:p');
    s = open(s, { kind: 'memo', key: 'a', pin: 'all', ownerWorkspace: 'W', props: { text: 'x' } }).stack;
    s = open(s, { kind: 'toast', key: 't', band: 'toast', focus: 'none', expiresAt: 10, opaque: false }).stack;
    s = open(s, { kind: 'decision', key: 'd', band: 'modal', blocking: true, rect: { anchor: 'br', w: '30%', h: 5, dx: -1, dy: -1 } }).stack;
    expect(parseStack(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  test('malformed layers are dropped, duplicates dropped, focus kept only for live focusable ids', () => {
    const good = { id: 'ov1', kind: 'memo', key: 'a', band: 'float', seq: 1, rect: { anchor: 'tl', w: 5, h: 5 }, focus: 'owns' };
    const parsed = parseStack({ rev: 3, counter: 1, layers: [good, { ...good }, { ...good, id: 'ov2', band: 'layout' }, { ...good, id: 'ov3', kind: 'Bad Kind' }, null],
      focus: ['pane:p', 'ov1', 'ov2', 'ghost', 7] });
    expect(parsed?.layers.map((l) => l.id)).toEqual(['ov1']);
    expect(parsed?.focus).toEqual(['pane:p', 'ov1']);
  });

  test('a stack without layers or rev is refused; a bad base falls back to empty', () => {
    expect(parseStack({ layers: [] })).toBeUndefined();
    expect(parseStack(null)).toBeUndefined();
    expect(parseStack([])).toBeUndefined();
    expect(parseStack({ rev: 0, counter: 0, layers: [], focus: ['evil'] })?.focus).toEqual(['']);
  });

  test('counter never falls behind the largest seq (no id or seq reuse after restore)', () => {
    const layer = { id: 'ov9', kind: 'memo', key: 'a', band: 'float', seq: 9, rect: { anchor: 'tl', w: 5, h: 5 }, focus: 'owns' };
    const s = parseStack({ rev: 1, counter: 2, layers: [layer], focus: [''] })!;
    expect(s.counter).toBe(9);
    expect(openLayer(s, { kind: 'memo', key: 'b' }).id).toBe('ov10');
  });

  test('parseLayer refuses bad bands, focus, pins, expiry and rects', () => {
    const good = { id: 'ov1', kind: 'memo', key: 'a', band: 'float', seq: 1, rect: { anchor: 'tl', w: 5, h: 5 }, focus: 'owns' };
    expect(parseLayer(good)).toMatchObject({ id: 'ov1' });
    expect(parseLayer({ ...good, focus: 'all' })).toBeUndefined();
    expect(parseLayer({ ...good, pin: 'forever' })).toBeUndefined();
    expect(parseLayer({ ...good, expiresAt: 'soon' })).toBeUndefined();
    expect(parseLayer({ ...good, seq: 1.5 })).toBeUndefined();
    expect(parseLayer({ ...good, ownerWorkspace: 3 })).toBeUndefined();
    expect(parseLayer({ ...good, key: 'x'.repeat(200) })).toBeUndefined();
  });

  test('parseRect: anchors, lengths and integer offsets only', () => {
    expect(parseRect({ anchor: 'tl', w: '50%', h: 3 })).toEqual({ anchor: 'tl', w: '50%', h: 3 });
    expect(parseRect({ anchor: 'middle', w: 1, h: 1 })).toBeUndefined();
    expect(parseRect({ anchor: 'tl', w: '150%', h: 1 })).toBeUndefined();
    expect(parseRect({ anchor: 'tl', w: -1, h: 1 })).toBeUndefined();
    expect(parseRect({ anchor: 'tl', w: 1, h: 1, dx: 0.5 })).toBeUndefined();
    expect(parseRect({ anchor: 'tl', w: 'wide', h: 1 })).toBeUndefined();
  });
});
