// ELS-SIDECHAT-EDGE A2 sim — the sidechat popup with the Obsidian float and toasts on the z axis, over a REAL registry + hub
// and REAL attach apps (sidechat-world.ts). Seeded: random view sizes, random toasts, a random number of ctrl+b Tab presses.
// Checked: ctrl+b Tab goes round sidechat (popup) → obsidian (float) → the pane → sidechat, skipping toasts; the layer z order
// NEVER changes on focus; keys land only where the ring says (sidechat input / obsidian / the pane under them); a click on the
// float raises + focuses it but it stays below the popup (band); a newly opened layer takes the keys back from the pane.
// Every frame each viewer writes passes the frame invariants. Literal expectations.
import { afterAll, describe, expect, test } from 'bun:test';
import { paintOrder } from '../../../els/overlay-stack.js';
import { createSidechatWorld, type SidechatViewer, type SidechatWorld } from './sidechat-world.js';

const SEEDS = [51, 52, 53, 54, 55, 56] as const;
const PREFIX = '\u0002';
const TAB = `${PREFIX}\t`;
const worlds: SidechatWorld[] = [];
afterAll(() => { for (const one of worlds) one.dispose(); });
const world = (seed: number): SidechatWorld => { const made = createSidechatWorld(seed); worlds.push(made); return made; };
const order = (w: SidechatWorld): string => w.registry.stack().layers.map((one) => one.kind).join('<');
const kindsOrder = (w: SidechatWorld): string[] => w.registry.stack().layers.map((one) => one.id);
const focusTopKind = (w: SidechatWorld): string | undefined => { const id = w.registry.stack().focus.at(-1); return w.registry.stack().layers.find((one) => one.id === id)?.kind; };
const input = (w: SidechatWorld): unknown => w.layer()?.props.input;

describe('A2 · ctrl+b Tab focus ring over sidechat · obsidian · pane, toasts skipped, z never changes', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const v: SidechatViewer = await w.viewer({ cols: w.rand.int(90, 170), rows: w.rand.int(26, 44) });
    expect(w.registry.apply({ action: 'open', kind: 'obsidian', props: { dir: '' } }).exitCode).toBe(0);
    v.press(`${PREFIX}/`);
    await w.flush();
    const toasts = w.rand.int(0, 2);
    for (let at = 0; at < toasts; at++) w.registry.apply({ action: 'open', kind: 'toast', props: { text: `Build ${at} done` } });
    await w.flush();
    expect(order(w)).toBe(['obsidian', 'sidechat', ...Array.from({ length: toasts }, () => 'toast')].join('<'));
    const z = kindsOrder(w);
    expect(focusTopKind(w)).toBe('sidechat');
    // The ring: sidechat → obsidian → pane → sidechat …, a random number of steps; z is the same after every step.
    const ring = ['obsidian', 'pane', 'sidechat'] as const;
    const steps = w.rand.int(3, 10);
    let typedBefore = v.typed().length;
    for (let step = 0; step < steps; step++) {
      v.press(TAB);
      await w.flush();
      expect(kindsOrder(w)).toEqual(z);
      const want = ring[step % 3]!;
      const before = input(w);
      v.press('q');                                                           // a probe key: where does it land?
      await w.flush();
      if (want === 'sidechat') { expect(input(w)).toBe(`${before}q`); expect(v.typed().length).toBe(typedBefore); }
      if (want === 'obsidian') { expect(focusTopKind(w)).toBe('obsidian'); expect(input(w)).toBe(before); expect(v.typed().length).toBe(typedBefore); }
      if (want === 'pane') { expect(input(w)).toBe(before); expect(v.typed().slice(typedBefore).join('')).toBe('q'); typedBefore = v.typed().length; }
      if (want !== 'pane') expect(v.typed().length).toBe(typedBefore);
      expect(v.last().join('\n')).toContain('Sidechat');                    // the popup is still painted over the float
    }
    expect(v.violations).toEqual([]);
  });
});

describe('A2 · click the float: raised + focused inside its band, still under the popup; a new layer takes keys back from the pane', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed + 100);
    const cols = w.rand.int(100, 170);
    const rows = w.rand.int(28, 44);
    const v = await w.viewer({ cols, rows });
    w.registry.apply({ action: 'open', kind: 'obsidian', props: { dir: '' } });
    v.press(`${PREFIX}/`);
    await w.flush();
    // A cell of the obsidian box not covered by the sidechat box (or by nothing above it).
    const boxes = paintOrder(w.registry.stack(), { cols, rows: rows - 1 }, undefined);
    const obs = boxes.find((one) => one.layer.kind === 'obsidian')!.box;
    const above = boxes.filter((one) => one.layer.kind !== 'obsidian').map((one) => one.box);
    let cell: { x: number; y: number } | undefined;
    for (let y = obs.y; y < obs.y + obs.h && !cell; y++) for (let x = obs.x; x < obs.x + obs.w && !cell; x++) {
      if (!above.some((box) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h)) cell = { x, y };
    }
    expect(cell).toBeDefined();
    v.press(`\u001b[<0;${cell!.x + 1};${cell!.y + 1}M`, `\u001b[<0;${cell!.x + 1};${cell!.y + 1}m`);
    await w.flush();
    expect(focusTopKind(w)).toBe('obsidian');
    expect(order(w)).toBe('obsidian<sidechat');                              // band rule: a float never rises over a popup
    // Tab from obsidian → pane; then a toast (focus none) does not take the keys, a new sidechat question layer does.
    v.press(TAB);
    await w.flush();
    v.press('z');
    await w.flush();
    expect(v.typed().join('')).toBe('z');
    w.registry.apply({ action: 'open', kind: 'toast', props: { text: 'Saved' } });
    await w.flush();
    v.press('y');
    await w.flush();
    expect(v.typed().join('')).toBe('zy');
    w.registry.apply({ action: 'close', kind: 'sidechat' });
    await w.flush();
    v.press(`${PREFIX}/`);                                                    // reopen: the new popup takes the keys
    await w.flush();
    v.press('k');
    await w.flush();
    expect(input(w)).toBe('k');
    expect(v.typed().join('')).toBe('zy');
    expect(v.violations).toEqual([]);
  });
});
