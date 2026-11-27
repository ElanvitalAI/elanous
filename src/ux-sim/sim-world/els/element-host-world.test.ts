// ELS-ELEMENT-HOST sim — one element, three hosts, seeds 1..5. A REAL overlay registry, a REAL attach app (120×30) and
// a REAL element host (the tab pane's controller) share the layer; every step is read from what the person sees: the
// composed frame goes through the real frame writer into @xterm/headless and is checked cell by cell against (1) the
// reference composite of that frame, (2) a twin viewer that never sees an overlay (cells outside the element boxes), and
// (3) literal boxes — popup rows 3..25 cols 12..107 · one tile cols 72..119 rows 0..28 · two tiles split at row 15.
// The seed picks how far the cursor moves, whether a second element joins as a tile, and how many host keys are sent.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElementHost, type HostAct } from '../../../els/element-host.js';
import type { OverlayLayer } from '../../../els/overlay-stack.js';
import { createZaxisWorld, noteName, referenceOf, writeNotesVault, type EmuScreen, type Viewer, type ZaxisWorld } from './zaxis-overlay-world.js';

const SEEDS = [1, 2, 3, 4, 5] as const;
const CTRL_T = '\u0014';
const POPUP = { x: 12, y: 3, w: 96, h: 23 } as const;
const TILE1 = { x: 72, y: 0, w: 48, h: 29 } as const;
const TILE2 = [{ x: 72, y: 0, w: 48, h: 15 }, { x: 72, y: 15, w: 48, h: 14 }] as const;

let root = '';
let vault = '';
const worlds: ZaxisWorld[] = [];
const matrix = new Map<number, string>();
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'els-host-sim-')); vault = writeNotesVault(join(root, 'SimVault')); });
afterAll(() => {
  for (const world of worlds) world.dispose();
  rmSync(root, { recursive: true, force: true });
  console.log(`\nELEMENT-HOST MATRIX\n| seed | ${SEEDS.join(' | ')} |\n|---|${SEEDS.map(() => '---').join('|')}|\n| popup→tile→tab→popup | ${SEEDS.map((s) => matrix.get(s) ?? '-').join(' | ')} |`);
});

const cellsOf = (screen: EmuScreen): string[] => screen.rows.map((row) => row.chars.map((char, x) => `${char}/${row.widths[x]}`).join('|'));
/** `under` = a box partly covered by a higher band (only its left corners are seen). */
type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly under?: boolean };
/** Every per-frame invariant: emulated = reference, rows exactly 120 cells, the boxes' corners where the literals say,
 *  every cell outside the boxes = the pane-only twin. */
async function frameInvariants(v: Viewer, twin: Viewer, boxes: readonly Box[]): Promise<EmuScreen> {
  const seen = await v.emulated();
  const reference = await referenceOf(v.writes.at(-1)!, v.size);
  expect(cellsOf(seen)).toEqual(cellsOf(reference));
  for (const row of seen.rows) expect(row.widths.reduce((sum, w) => sum + w, 0)).toBe(120);
  for (const box of boxes) {
    // square corners (Obsidian) or round ones (sidechat)
    expect(['┌', '╭']).toContain(seen.rows[box.y]!.chars[box.x]!);
    expect(['└', '╰']).toContain(seen.rows[box.y + box.h - 1]!.chars[box.x]!);
    if (box.under) continue;
    expect(['┐', '╮']).toContain(seen.rows[box.y]!.chars[box.x + box.w - 1]!);
    expect(['┘', '╯']).toContain(seen.rows[box.y + box.h - 1]!.chars[box.x + box.w - 1]!);
  }
  const other = await twin.emulated();
  for (let y = 0; y < 29; y++) for (let x = 0; x < 120; x++) {
    if (boxes.some((box) => y >= box.y && y < box.y + box.h && x >= box.x - 1 && x <= box.x + box.w)) continue;
    if (seen.rows[y]!.chars[x] !== other.rows[y]!.chars[x]) throw new Error(`cell (${x},${y}) = ${JSON.stringify(seen.rows[y]!.chars[x])}, pane-only = ${JSON.stringify(other.rows[y]!.chars[x])}`);
  }
  return seen;
}
const obs = (w: ZaxisWorld): OverlayLayer | undefined => w.registry.stack().layers.find((one) => one.kind === 'obsidian');
const cursorOf = (w: ZaxisWorld): number => (obs(w)?.props as { cursor: number }).cursor;
/** The selected row as drawn (reverse video) holds this note. */
const selected = (raw: string, note: number): boolean => raw.includes(`\u001b[7m  ${noteName(note)}`);

describe('one element through popup → tile → tab → popup, state kept, every frame cell-checked', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    try {
      const w = createZaxisWorld(seed, vault);
      worlds.push(w);
      const v = await w.viewer();
      const twin = await w.viewer({ source: 'none' });
      const screen = `[screen 91x28 cursor=(row 0, col 0, visible true)]\n${Array.from({ length: 28 }, (_, row) => `${seed}:${row} 한글 출력 😀 work line`).join('\n')}`;
      v.paneFrame(screen); twin.paneFrame(screen);
      w.registry.apply({ action: 'open', kind: 'obsidian', props: {}, view: { cols: 120, rows: 30 } });   // 120 cols → popup
      await frameInvariants(v, twin, [POPUP]);
      const steps = w.rand.int(1, 9);
      for (let at = 0; at < steps; at++) { v.press('j'); await frameInvariants(v, twin, [POPUP]); }
      expect(cursorOf(w)).toBe(steps);

      // ctrl+t → tile: the right column, the work on the left is the pane-only screen.
      v.press(CTRL_T);
      expect(obs(w)?.frame).toBe('tile');
      let seen = await frameInvariants(v, twin, [TILE1]);
      expect(seen.rows[0]!.text).toContain('📓 SimVault');
      expect(selected(v.writes.at(-1)!, steps)).toBe(true);
      const second = w.rand.int(0, 1) === 1;
      if (second) {
        w.registry.apply({ action: 'open', kind: 'sidechat', props: {}, frame: 'tile' });
        seen = await frameInvariants(v, twin, [...TILE2]);
        expect(seen.rows[15]!.text).toContain('Sidechat');
        v.clickAt(TILE2[0].x + 5, TILE2[0].y + 5);                // focus the Obsidian tile again (a click = raise + focus)
        await frameInvariants(v, twin, [...TILE2]);
      }

      // ctrl+t → tab: gone from the view (only the other tile, if any, remains), a host pane draws the same state.
      v.press(CTRL_T);
      expect(obs(w)?.frame).toBe('tab');
      await frameInvariants(v, twin, second ? [TILE1] : []);
      const writes: string[] = [];
      const host = createElementHost({ kind: 'obsidian', key: 'default', write: (text) => { writes.push(text); }, size: () => ({ cols: 91, rows: 28 }),
        act: (act: HostAct) => { w.registry.apply({ ...act }); } });
      const sub = w.registry.onChange((stack) => { host.stack(stack); });
      expect(host.stack(w.registry.stack())).toBe(false);
      expect(selected(writes.at(-1)!, steps)).toBe(true);
      const hostKeys = w.rand.int(1, 4);
      for (let at = 0; at < hostKeys; at++) host.key('j');
      expect(cursorOf(w)).toBe(steps + hostKeys);
      expect(selected(writes.at(-1)!, steps + hostKeys)).toBe(true);
      await frameInvariants(v, twin, second ? [TILE1] : []);       // keys in the host never touch the attach view

      // ctrl+t in the host → popup: the attach view shows it again with the host's cursor; the host ends.
      host.key(CTRL_T);
      expect(obs(w)?.frame).toBeUndefined();
      expect(host.layer()).toBeUndefined();
      sub.dispose();
      // The sidechat tile lives in the popup band, above the Obsidian float: it covers the popup's right part.
      await frameInvariants(v, twin, second ? [{ ...POPUP, under: true }, TILE1] : [POPUP]);
      expect(cursorOf(w)).toBe(steps + hostKeys);
      if (!second) expect(selected(v.writes.at(-1)!, steps + hostKeys)).toBe(true);
      v.press('\u001b');
      expect(obs(w)).toBeUndefined();
      await frameInvariants(v, twin, second ? [TILE1] : []);
      matrix.set(seed, 'PASS');
    } catch (error) { matrix.set(seed, 'FAIL'); throw error; }
  });
});
