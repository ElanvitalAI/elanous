// ELS-POPUP-MOVE/RESIZE sim (대표 11-26 B2), seeds 1..5. A REAL registry + a REAL attach app (120×30) + a pane-only twin.
// The person drags the Obsidian popup by its title row, resizes it from its bottom-right corner, then nudges and resizes it
// in the ctrl+b r mode; every step is read from the emulated screen (the real frame writer into @xterm/headless): cell by
// cell = the reference composite, rows exactly 120 cells, the four corners where the expected box says, every cell outside
// the box = the twin. The expected box is a plain model of the rule (clamp inside 120×29, min 12×4), not the product code.
// Mouse input is only the SGR press/release the app already receives: no wire write may contain a mouse-mode escape.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { click, createZaxisWorld, referenceOf, release, writeNotesVault, type EmuScreen, type Viewer, type ZaxisWorld } from './zaxis-overlay-world.js';

const SEEDS = [1, 2, 3, 4, 5] as const;
type Box = { x: number; y: number; w: number; h: number };
const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

let root = '';
let vault = '';
const worlds: ZaxisWorld[] = [];
const matrix = new Map<number, string>();
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'els-move-sim-')); vault = writeNotesVault(join(root, 'SimVault')); });
afterAll(() => {
  for (const world of worlds) world.dispose();
  rmSync(root, { recursive: true, force: true });
  console.log(`\nPOPUP-MOVE MATRIX\n| seed | ${SEEDS.join(' | ')} |\n|---|${SEEDS.map(() => '---').join('|')}|\n| drag · corner · ctrl+b r | ${SEEDS.map((s) => matrix.get(s) ?? '-').join(' | ')} |`);
});

const cellsOf = (screen: EmuScreen): string[] => screen.rows.map((row) => row.chars.map((char, x) => `${char}/${row.widths[x]}`).join('|'));
async function frameInvariants(v: Viewer, twin: Viewer, box: Box | undefined): Promise<void> {
  const seen = await v.emulated();
  expect(cellsOf(seen)).toEqual(cellsOf(await referenceOf(v.writes.at(-1)!, v.size)));
  for (const row of seen.rows) expect(row.widths.reduce((sum, w) => sum + w, 0)).toBe(120);
  if (box) {
    expect(seen.rows[box.y]!.chars[box.x]).toBe('┌');
    expect(seen.rows[box.y]!.chars[box.x + box.w - 1]).toBe('┐');
    expect(seen.rows[box.y + box.h - 1]!.chars[box.x]).toBe('└');
    expect(seen.rows[box.y + box.h - 1]!.chars[box.x + box.w - 1]).toBe('┘');
  }
  const other = await twin.emulated();
  for (let y = 0; y < 29; y++) for (let x = 0; x < 120; x++) {
    if (box && y >= box.y && y < box.y + box.h && x >= box.x - 1 && x <= box.x + box.w) continue;
    if (seen.rows[y]!.chars[x] !== other.rows[y]!.chars[x]) throw new Error(`cell (${x},${y}) = ${JSON.stringify(seen.rows[y]!.chars[x])}, pane-only = ${JSON.stringify(other.rows[y]!.chars[x])}`);
  }
}
const moveBox = (box: Box, dx: number, dy: number): Box => ({ ...box, x: clamp(box.x + dx, 0, 120 - box.w), y: clamp(box.y + dy, 0, 29 - box.h) });
const resizeBox = (box: Box, dw: number, dh: number): Box => ({ ...box, w: clamp(box.w + dw, 12, 120 - box.x), h: clamp(box.h + dh, 4, 29 - box.y) });
/** A drag: press at a 0-based cell, release at another (SGR is 1-based). */
const drag = (v: Viewer, from: { x: number; y: number }, to: { x: number; y: number }): void => { v.app.key(click(from.x + 1, from.y + 1)); v.app.key(release(to.x + 1, to.y + 1)); };

describe('drag the title row, drag the corner, then ctrl+b r: hjkl move · HJKL resize — every frame cell-checked', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    try {
      const w = createZaxisWorld(seed, vault);
      worlds.push(w);
      const v = await w.viewer();
      const twin = await w.viewer({ source: 'none' });
      const screen = `[screen 91x28 cursor=(row 0, col 0, visible true)]\n${Array.from({ length: 28 }, (_, row) => `${seed}:${row} 한글 출력 😀 work line`).join('\n')}`;
      v.paneFrame(screen); twin.paneFrame(screen);
      const startWire = v.wire.length;
      w.openObsidian();
      let box: Box = { x: 12, y: 3, w: 96, h: 23 };                // 80% of 120×29, centered
      await frameInvariants(v, twin, box);

      // 1 · title-row drags (seeded deltas, some past the edges)
      for (let at = 0; at < 3; at++) {
        const dx = w.rand.int(-40, 40);
        const dy = w.rand.int(-8, 8);
        const grab = { x: box.x + w.rand.int(2, box.w - 3), y: box.y };
        drag(v, grab, { x: clamp(grab.x + dx, 0, 119), y: clamp(grab.y + dy, 0, 28) });
        box = moveBox(box, clamp(grab.x + dx, 0, 119) - grab.x, clamp(grab.y + dy, 0, 28) - grab.y);
        await frameInvariants(v, twin, box);
      }
      // a press in the body and a release elsewhere is a click, not a drag
      drag(v, { x: box.x + 3, y: box.y + 2 }, { x: box.x + 9, y: box.y + 5 });
      await frameInvariants(v, twin, box);

      // 2 · corner drag: shrink then grow (seeded)
      const corner = (): { x: number; y: number } => ({ x: box.x + box.w - 1, y: box.y + box.h - 1 });
      const shrink = { dw: -w.rand.int(10, 60), dh: -w.rand.int(3, 15) };
      const from = corner();
      const to = { x: clamp(from.x + shrink.dw, 0, 119), y: clamp(from.y + shrink.dh, 0, 28) };
      drag(v, from, to);
      box = resizeBox(box, to.x - from.x, to.y - from.y);
      await frameInvariants(v, twin, box);
      const from2 = corner();
      const to2 = { x: clamp(from2.x + w.rand.int(1, 30), 0, 119), y: clamp(from2.y + w.rand.int(1, 6), 0, 28) };
      drag(v, from2, to2);
      box = resizeBox(box, to2.x - from2.x, to2.y - from2.y);
      await frameInvariants(v, twin, box);

      // 3 · keyboard: ctrl+b r, seeded hjkl / HJKL / arrows, Enter ends the mode
      v.press('\u0002', 'r');
      expect(v.last().at(-1)).toContain('Move: ←↑↓→/hjkl move');
      const keys = ['h', 'j', 'k', 'l', 'H', 'J', 'K', 'L', '\u001b[A', '\u001b[B', '\u001b[C', '\u001b[D', '\u001b[1;2C', '\u001b[1;2B'];
      const steps = w.rand.int(6, 14);
      for (let at = 0; at < steps; at++) {
        const key = keys[w.rand.int(0, keys.length - 1)]!;
        v.press(key);
        const arrow = { h: [-1, 0], l: [1, 0], j: [0, 1], k: [0, -1], H: [-1, 0], L: [1, 0], J: [0, 1], K: [0, -1],
          '\u001b[A': [0, -1], '\u001b[B': [0, 1], '\u001b[C': [1, 0], '\u001b[D': [-1, 0], '\u001b[1;2C': [1, 0], '\u001b[1;2B': [0, 1] }[key]!;
        box = /^[HJKL]$/.test(key) || key.startsWith('\u001b[1;2') ? resizeBox(box, arrow[0]!, arrow[1]!) : moveBox(box, arrow[0]!, arrow[1]!);
        await frameInvariants(v, twin, box);
      }
      const cursor = (w.registry.stack().layers[0]!.props as { cursor: number }).cursor;
      expect(cursor).toBe(0);                                         // mode keys never reached the element
      v.press('\r');
      v.press('j');                                                   // the mode is over: j is the viewer's again
      expect((w.registry.stack().layers[0]!.props as { cursor: number }).cursor).toBe(1);
      await frameInvariants(v, twin, box);
      expect(v.attachments.flatMap((one) => one.typed).join('')).toBe('');   // nothing reached the pane under it
      for (const write of v.wire.slice(startWire)) expect(write).not.toMatch(/\u001b\[\?100[0-6][hl]/);
      v.press('\u001b');
      await frameInvariants(v, twin, undefined);
      matrix.set(seed, 'PASS');
    } catch (error) { matrix.set(seed, 'FAIL'); throw error; }
  });
});
