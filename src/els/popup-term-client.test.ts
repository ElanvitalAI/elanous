import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOverlayRegistry } from './overlay-registry.js';
import type { AttachHandlers } from './attach-client.js';
import type { ElsRequest } from './server.js';
import { createPopupTerm, isPopupRow, type PopupRow } from './popup-term-client.js';
import { term, termProps } from './elements/term.js';
import type { OverlayLayer } from './overlay-stack.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const layer = (pane?: string): OverlayLayer => ({ id: 'ov1', kind: 'term', key: 'default', band: 'popup', seq: 1, rect: term.rect({}, 0), focus: 'owns', pin: 'all', props: pane ? { pane } : {} });

function harness(rows: PopupRow[], named?: string) {
  const attached: { pane: string; size: { cols: number; rows: number }; handlers: AttachHandlers; resizes: number[][]; detached: boolean; typed: string[] }[] = [];
  const acts: unknown[] = [];
  const requests: ElsRequest[] = [];
  const pt = createPopupTerm({
    attach: (pane, size, handlers) => { const one = { pane, size, handlers, resizes: [] as number[][], detached: false, typed: [] as string[] }; attached.push(one); return { input: (b) => one.typed.push(b), resize: (c, r) => one.resizes.push([c, r]), scroll: () => {}, detach: () => { one.detached = true; } }; },
    request: async (request) => { requests.push(request); return { exitCode: 0, message: '' }; },
    render: () => {}, popupRows: () => rows, act: (one) => { acts.push(one); }, create: async () => 'pnew1', note: () => {}, layerPane: () => named,
  });
  return { pt, attached, acts, requests };
}

test('term props carry a pane id at most — never a command', () => {
  expect(termProps({})).toEqual({});
  expect(termProps({ pane: 'pabc12' })).toEqual({ pane: 'pabc12' });
  expect(termProps({ pane: '../x' })).toBeUndefined();
  expect(termProps({ pane: 'pabc12', command: ['rm', '-rf', '/'] })).toEqual({ pane: 'pabc12' });
  expect(isPopupRow({ workspace: 'els-popup' })).toBe(true);
  expect(isPopupRow({ workspace: 'main' })).toBe(false);
});

test('only a pane of the popup workspace is attached; size = the inner box; resize only on change', () => {
  const h = harness([{ pane: 'ppop1', workspace: 'els-popup', state: 'idle' }]);
  h.pt.sync(layer('pother'), { w: 50, h: 12 });
  expect(h.attached).toHaveLength(0);                                    // a layer naming any other pane is never attached
  h.pt.sync(layer('ppop1'), { w: 50, h: 12 });
  expect(h.attached[0]).toMatchObject({ pane: 'ppop1', size: { cols: 48, rows: 10 } });
  h.pt.sync(layer('ppop1'), { w: 50, h: 12 });
  h.pt.sync(layer('ppop1'), { w: 60, h: 20 });
  expect(h.attached[0]!.resizes).toEqual([[58, 18]]);
  h.pt.input('\u0003');
  expect(h.attached[0]!.typed).toEqual(['\u0003']);
  h.pt.sync(undefined, undefined);
  expect(h.attached[0]!.detached).toBe(true);
});

test('frames draw inside the frame cell-exact (wide glyphs clipped); the cursor is box-relative; the shell ending closes the popup', () => {
  const h = harness([{ pane: 'ppop1', workspace: 'els-popup', state: 'idle' }]);
  h.pt.sync(layer('ppop1'), { w: 20, h: 6 });
  h.attached[0]!.handlers.onFrame({ pane: 'ppop1', seq: 1, cols: 18, rows: 4, back: 0, screen: '[screen 18x4 cursor=(row 1, col 3, visible true)]\n$$ 한글한글한글한글한글\nok' });
  const rows = h.pt.render(layer('ppop1'), { w: 20, h: 6 }, true).map(plain);
  expect(rows).toHaveLength(6);
  for (const row of rows) expect(Bun.stringWidth(row)).toBe(20);
  expect(rows[1]).toBe('│$$ 한글한글한글한 │');
  expect(rows[2]).toBe('│ok                │');
  expect(h.pt.cursor()).toEqual({ x: 4, y: 2 });
  h.attached[0]!.handlers.onEnd(0, 'exited');
  expect(h.acts).toEqual([{ action: 'close', id: 'ov1' }]);
  expect(h.requests).toEqual([]);                                        // nothing else closed (another popup pane may run)
});

test('a layer without a pane is materialized: the live popup pane is reused, else a new one is made', async () => {
  const reuse = harness([{ pane: 'ppop1', workspace: 'els-popup', state: 'idle' }]);
  reuse.pt.materialize(layer());
  await Bun.sleep(1);
  expect(reuse.acts).toEqual([{ action: 'update', id: 'ov1', props: { pane: 'ppop1' } }]);
  const fresh = harness([]);
  fresh.pt.materialize(layer());
  await Bun.sleep(1);
  expect(fresh.acts).toEqual([{ action: 'update', id: 'ov1', props: { pane: 'pnew1' } }]);
  // two viewers start at once: the other one named the layer first — ours closes the pane it just made, names nothing
  const raced = harness([], 'pother1');
  raced.pt.materialize(layer());
  await Bun.sleep(1);
  expect(raced.acts).toEqual([]);
  expect(raced.requests).toEqual([{ op: 'close', pane: 'pnew1', confirmed: true }]);
});

test('server side: a term layer opened without a pane gets the server popup pane in one step (two opens → one shell)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-popterm-reg-'));
  try {
    let created = 0;
    let live: string | undefined;
    const registry = createOverlayRegistry({ dir, context: () => ({ popupPane: () => live ?? (live = `pnew${++created}`) }) });
    const first = registry.apply({ action: 'open', kind: 'term', props: {} });
    const second = registry.apply({ action: 'open', kind: 'term', props: { command: ['sh', '-c', 'evil'] } });
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(created).toBe(1);
    expect(registry.stack().layers.map((one) => one.props)).toEqual([{ pane: 'pnew1' }]);
    registry.dispose();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
