// MD4 — browseMode flag on SelectView.
//
// Collection widgets now share one contract:
// single-click selects, double-click submits/activates.
// Legacy browseMode flags may remain at call sites but no longer
// change the mouse contract for SelectView.

import { describe, expect, test } from 'bun:test';
import { Printer } from '../src/ui/printer.js';
import { SelectView } from '../src/ui/widgets/select-view.js';

function dispatch(p: Printer, ev: { type: 'click' | 'double-click' | 'scroll-up' | 'scroll-down'; x: number; y: number }) {
  const hit = p.registry.hit(ev.x, ev.y);
  if (!hit) return 'no-hit';
  hit.view.onMouse?.({
    type: ev.type,
    x: ev.x - hit.absX,
    y: ev.y - hit.absY,
    absX: ev.x,
    absY: ev.y,
    payload: hit.payload,
  });
  return 'hit';
}

describe('MD4 — SelectView browseMode', () => {
  test('default single-click only selects', () => {
    let picked: string | null = null;
    const sv = new SelectView<string>({
      options: [
        { value: 'a', label: 'Apple' },
        { value: 'b', label: 'Banana' },
      ],
      onSubmit: v => { picked = v as string; },
    });
    sv.layout({ width: 20, height: 5 });
    sv.takeFocus();
    const p = Printer.create({ width: 20, height: 5 });
    sv.draw(p);
    // Find the 2nd row's region and click it.
    const regions = p.registry.snapshot();
    const row = regions.find(r => (r.payload as any)?.filtIdx === 1);
    expect(row).toBeDefined();
    dispatch(p, { type: 'click', x: row!.absX, y: row!.absY });
    expect(picked).toBeNull();
    expect(sv._snapshot().cursor).toBe(1);
  });

  test('browseMode single-click only moves cursor', () => {
    let picked: string | null = null;
    const sv = new SelectView<string>({
      options: [
        { value: 'a', label: 'Apple' },
        { value: 'b', label: 'Banana' },
      ],
      browseMode: true,
      onSubmit: v => { picked = v as string; },
    });
    sv.layout({ width: 20, height: 5 });
    sv.takeFocus();
    const p = Printer.create({ width: 20, height: 5 });
    sv.draw(p);
    const row = p.registry.snapshot().find(r => (r.payload as any)?.filtIdx === 1);
    dispatch(p, { type: 'click', x: row!.absX, y: row!.absY });
    expect(picked).toBeNull();
  });

  test('browseMode double-click submits', () => {
    let picked: string | null = null;
    const sv = new SelectView<string>({
      options: [
        { value: 'a', label: 'Apple' },
        { value: 'b', label: 'Banana' },
      ],
      browseMode: true,
      onSubmit: v => { picked = v as string; },
    });
    sv.layout({ width: 20, height: 5 });
    sv.takeFocus();
    const p = Printer.create({ width: 20, height: 5 });
    sv.draw(p);
    const row = p.registry.snapshot().find(r => (r.payload as any)?.filtIdx === 1);
    dispatch(p, { type: 'double-click', x: row!.absX, y: row!.absY });
    expect(picked).toBe('b');
  });
});
