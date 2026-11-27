// ELS-ZAXIS hardening sim — the popup under stress, seeds 1..5, read from what the person SEES: every composed frame goes
// through the real createAppFrameWriter (incremental diff writes) into an @xterm/headless terminal, and that emulated
// screen is checked cell by cell against (1) a reference composite (the same composed frame drawn alone, no diffs) and
// (2) a twin viewer on the same panes that never sees an overlay (the «pane only» screen). Expected boxes and cursor
// positions are literals (80% of the area above the status line; tab row 1 + side list 28 + 1 separator), never computed
// with the product's resolveRect.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenSpec, OverlayLayer } from '../../../els/overlay-stack.js';
import {
  createScriptedStack, createZaxisWorld, popupBox, prng, referenceOf, writeNotesVault,
  type EmuScreen, type ScriptedStack, type Viewer, type ZaxisWorld,
} from './zaxis-overlay-world.js';

const SEEDS = [1, 2, 3, 4, 5] as const;
const ESC = '\u001b';
const SYNC_BEGIN = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
// 120x30 with the side list: the pane's first cell is column 29 (0-based), its first row is row 1 (under the tab row).
const PANE_X = 29;
const PANE_Y = 1;
// obsidian at 120x30: rows 3..25, cols 12..107 (96 wide)
const OBS = { top: 3, bottom: 25, x: 12, w: 96 } as const;

let root = '';
let vault = '';
const worlds: ZaxisWorld[] = [];
/** case → seed → PASS/FAIL (printed after the run as the matrix). */
const matrix = new Map<string, Map<number, string>>();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'els-zaxis-harden-'));
  vault = writeNotesVault(join(root, 'SimVault'));
});
afterAll(() => {
  for (const world of worlds) world.dispose();
  rmSync(root, { recursive: true, force: true });
  const cols = SEEDS.map((seed) => `seed ${seed}`).join(' | ');
  const lines = [`| case | ${cols} |`, `|---|${SEEDS.map(() => '---').join('|')}|`];
  for (const [name, row] of matrix) lines.push(`| ${name} | ${SEEDS.map((seed) => row.get(seed) ?? '-').join(' | ')} |`);
  console.log(`\nZAXIS-HARDENING MATRIX\n${lines.join('\n')}`);
});

const world = (seed: number): ZaxisWorld => { const made = createZaxisWorld(seed, vault); worlds.push(made); return made; };
/** Run one seeded case and record it in the matrix. */
const cell = (name: string, seed: number, body: () => Promise<void>) => async (): Promise<void> => {
  const row = matrix.get(name) ?? new Map<number, string>();
  matrix.set(name, row);
  try { await body(); row.set(seed, 'PASS'); } catch (error) { row.set(seed, 'FAIL'); throw error; }
};

const header = (row: number, col: number): string => `[screen 91x28 cursor=(row ${row}, col ${col}, visible true)]\n`;
const screenOf = (lines: readonly string[], cursor = { row: 0, col: 0 }): string => `${header(cursor.row, cursor.col)}${lines.join('\n')}`;
const KOREAN = ['가나다라마바사', '😀 이모지 줄', '한글 출력 🚀 빠름', '아자차카타파하 😀😀', '빌드 진행중 ✅'];
/** One pane screen of 28 lines: Korean and emoji text that differs per frame index. */
const fastLines = (rand: ReturnType<typeof prng>, at: number): string[] => Array.from({ length: 28 }, (_, row) => `${at}:${row} ${KOREAN[rand.int(0, KOREAN.length - 1)]} ${KOREAN[(row + at) % KOREAN.length]}`);

/** The texts of every row (cell chars joined: a wide glyph is one char followed by an empty continuation cell). */
const cellsOf = (screen: EmuScreen): string[] => screen.rows.map((row) => row.chars.map((char, x) => `${char}/${row.widths[x]}`).join('|'));
/** The emulated screen equals the reference composite of the last composed frame, cell by cell. */
async function expectMatchesReference(v: Viewer): Promise<EmuScreen> {
  const seen = await v.emulated();
  const reference = await referenceOf(v.writes.at(-1)!, v.size);
  expect(cellsOf(seen)).toEqual(cellsOf(reference));
  return seen;
}
/** Cells outside `boxes` (rows above the status line) equal the twin's (pane-only) cells. */
function expectOutsideEqual(seen: EmuScreen, twin: EmuScreen, boxes: readonly { x: number; y: number; w: number; h: number }[]): void {
  for (let y = 0; y < seen.rows.length - 1; y++) {
    for (let x = 0; x < seen.rows[y]!.chars.length; x++) {
      if (boxes.some((box) => y >= box.y && y < box.y + box.h && x >= box.x - 1 && x <= box.x + box.w)) continue;   // the edge cells may blank a straddling glyph
      if (seen.rows[y]!.chars[x] !== twin.rows[y]!.chars[x]) throw new Error(`cell (${x},${y}) = ${JSON.stringify(seen.rows[y]!.chars[x])}, pane-only = ${JSON.stringify(twin.rows[y]!.chars[x])}`);
    }
  }
}
/** Every emulated row is exactly `cols` cells: widths add up, no wide glyph starts in the last column. */
function expectExactWidth(seen: EmuScreen, cols: number): void {
  for (const row of seen.rows) {
    expect(row.widths.reduce((sum, w) => sum + w, 0)).toBe(cols);
    expect(row.widths[cols - 1]).not.toBe(2);
  }
}
const bodyRows = (seen: EmuScreen): string[] => seen.rows.slice(0, -1).map((row) => row.text);

/** The real Obsidian layer (hydrated by the registry: entries filled) copied into a scripted stack. */
function hydratedObsidian(w: ZaxisWorld): OpenSpec {
  const id = w.openObsidian();
  const layer = w.registry.stack().layers.find((one) => one.id === id)! as OverlayLayer;
  w.registry.apply({ action: 'close', id });
  return { kind: layer.kind, key: layer.key, band: layer.band, focus: layer.focus, rect: layer.rect, props: layer.props };
}
const stub = (kind: string, rect: OpenSpec['rect'], band: OpenSpec['band'] = 'float'): OpenSpec => ({ kind, key: kind, band, focus: 'owns', ...(rect ? { rect } : {}) });
const obsCursor = (stack: ScriptedStack | ZaxisWorld): number | undefined => {
  const layers = 'registry' in stack ? stack.registry.stack().layers : stack.stack().layers;
  return (layers.find((one) => one.kind === 'obsidian')?.props as { cursor?: number } | undefined)?.cursor;
};

// ---- 1 · fast pane output under the open popup ---------------------------------------------------------------------------
describe('H1 · hundreds of Korean/emoji pane frames under the open Obsidian popup', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('H1 fast output: border intact · Esc = pane only', seed, async () => {
    const w = world(seed);
    const v = await w.viewer();
    const twin = await w.viewer({ source: 'none' });
    w.openObsidian();
    // 출처: #40244 sim device — a few hundred frames is the «fast output» burst (seeded count)
    const frames = 200 + w.rand.int(0, 120);
    for (let at = 0; at < frames; at++) {
      const lines = fastLines(w.rand, at);
      v.paneFrame(screenOf(lines));
      twin.paneFrame(screenOf(lines));
      const seen = await v.emulated();
      const top = seen.rows[OBS.top]!;
      expect(top.chars[OBS.x]).toBe('┌');
      expect(top.chars[OBS.x + OBS.w - 1]).toBe('┐');
      expect(top.text).toContain('📓 SimVault · /');
      expect(seen.rows[OBS.bottom]!.chars[OBS.x]).toBe('└');
      if (at % 25 === 0) { const reference = await referenceOf(v.writes.at(-1)!, v.size); expect(cellsOf(seen)).toEqual(cellsOf(reference)); }
    }
    expect(v.attachments[0]!.typed).toEqual([]);
    v.press(ESC);
    expect(w.registry.stack().layers).toEqual([]);
    const after = await expectMatchesReference(v);
    const paneOnly = await twin.emulated();
    expect(bodyRows(after)).toEqual(bodyRows(paneOnly));                        // no ghost popup cell anywhere
    expect(after.rows.map((row) => row.text).join('\n')).not.toContain('📓');
  }));
});

// ---- 2 · cursor hidden while focused, restored at the pane's cursor after Esc --------------------------------------------
describe('H2 · the pane cursor hides under a focused popup and comes back where the pane has it', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('H2 cursor: hidden while focused · restored after Esc', seed, async () => {
    const w = world(seed);
    const v = await w.viewer();
    w.openObsidian();
    let cursor = { row: 0, col: 0 };
    const frames = 20 + w.rand.int(0, 20);
    for (let at = 0; at < frames; at++) {
      cursor = { row: w.rand.int(0, 26), col: w.rand.int(0, 80) };
      v.paneFrame(screenOf(fastLines(w.rand, at), cursor));
      expect(v.writes.at(-1)!.endsWith(`${ESC}[?25l`)).toBe(true);
      expect(v.wire.at(-1)!.endsWith(`${ESC}[?25l${SYNC_END}`)).toBe(true);
    }
    v.press(ESC);
    // literal: row + 1 (tab row) + 1 (1-based) · col + 29 (side list + separator) + 1
    expect(v.writes.at(-1)!.endsWith(`${ESC}[${cursor.row + 2};${cursor.col + 30}H${ESC}[?25h`)).toBe(true);
    const seen = await expectMatchesReference(v);
    expect(seen.cursor).toEqual({ x: cursor.col + PANE_X, y: cursor.row + PANE_Y });
    expect(v.wire.at(-1)!.endsWith(`${ESC}[?25h${SYNC_END}`)).toBe(true);
  }));
});

// ---- 3 · no key leaks; ctrl+b still works; Esc closes the top layer only -------------------------------------------------
const wheelAt = (button: 64 | 65, x: number, y: number): string => `${ESC}[<${button};${x};${y}M`;
describe('H3 · a focused popup keeps every key; ctrl+b acts; Esc peels one layer at a time', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('H3 focus: no key leak · ctrl+b · Esc top only · focus restored', seed, async () => {
    const w = world(seed);
    const scripted = createScriptedStack();
    const v = await w.viewer({ source: scripted });
    const lower = scripted.open(hydratedObsidian(w));
    const upper = scripted.open(stub('memo-stub', { anchor: 'tl', w: 40, h: 10, dx: 50 + w.rand.int(0, 10), dy: 6 + w.rand.int(0, 4) }));
    expect(v.last().join('\n')).toContain('┌ memo-stub ');
    const leaks = [`${ESC}[A`, `${ESC}[B`, `${ESC}[C`, `${ESC}[D`, '\u0003', `${ESC}[200~pasted\nline${ESC}[201~`, '한글입력', '\t', '\r',
      wheelAt(64, 70, 12), wheelAt(65, 70, 12), wheelAt(64, 30, 10)];
    for (let round = 0; round < 3; round++) for (const one of [...leaks].sort(() => w.rand.next() - 0.5)) v.press(one);
    expect(v.attachments.every((one) => one.typed.length === 0)).toBe(true);
    expect(scripted.stack().layers.map((one) => one.id)).toEqual([lower, upper]);
    expect(obsCursor(scripted)).toBe(0);                                         // the lower popup saw none of them
    v.press('\u0002n');                                                          // ctrl+b n still switches the tab
    expect(v.attachments.at(-1)!.pane).toBe('p2');
    expect(scripted.stack().layers).toHaveLength(2);
    const before = v.attachments.at(-1)!;
    v.press(ESC);                                                                // closes the upper only
    expect(scripted.stack().layers.map((one) => one.id)).toEqual([lower]);
    expect(v.last().join('\n')).not.toContain('┌ memo-stub ');
    expect(v.last().join('\n')).toContain('📓 SimVault');
    v.press('j');                                                                // focus went to the lower popup
    expect(obsCursor(scripted)).toBe(1);
    v.press(ESC);
    expect(scripted.stack().layers).toEqual([]);
    expect(v.attachments.every((one) => one.typed.length === 0)).toBe(true);
    v.press('z');                                                                // keys reach the same pane again
    expect(v.attachments.at(-1)).toBe(before);
    expect(before.typed).toEqual(['z']);
    await expectMatchesReference(v);
  }));
});

// ---- 4 · tab switch, tile page keys and resize while the popup is open ---------------------------------------------------
const boxFor = (cols: number, rows: number): { top: number; bottom: number; x: number; w: number } => ({
  '120x30': OBS, '80x24': { top: 2, bottom: 19, x: 8, w: 64 }, '200x60': { top: 6, bottom: 52, x: 20, w: 160 }, '100x28': { top: 2, bottom: 23, x: 10, w: 80 },
} as Record<string, { top: number; bottom: number; x: number; w: number }>)[`${cols}x${rows}`]!;
describe('H4 · tab switch / tab click / tile [ ] / resize under the open popup', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('H4 tab·tile·resize: popup re-resolved · keys owned', seed, async () => {
    const w = world(seed);
    const v = await w.viewer();
    w.openObsidian();
    let cursor = 0;
    const sizes = [[80, 24], [200, 60], [100, 28], [120, 30]] as const;
    const ops = Array.from({ length: 12 }, () => w.rand.int(0, 2));
    for (const op of ops) {
      if (op === 0) v.press('\u0002n');
      else if (op === 1 && v.size.cols >= 120) v.clickAt(w.rand.int(0, 1) ? 40 : 32, 1);     // the TWO / ONE tab
      else { const [cols, rows] = sizes[w.rand.int(0, sizes.length - 1)]!; v.size.cols = cols; v.size.rows = rows; v.app.resized(); }
      expect(popupBox(v.last())).toEqual(boxFor(v.size.cols, v.size.rows));
      expect(v.last()).toHaveLength(v.size.rows);
      v.press('j');
      cursor++;
      expect(obsCursor(w)).toBe(cursor);
      expect(w.registry.stack().layers).toHaveLength(1);
      await expectMatchesReference(v);
    }
    expect(v.attachments.every((one) => one.typed.length === 0)).toBe(true);
    // over the tile grid: [ and ] belong to the focused popup (no page turn under it), resize re-resolves it
    const t = await w.viewer({ tile: {} });
    expect(popupBox(t.last())).toEqual(OBS);
    for (const key of ['[', ']', ']', '[']) t.press(key);
    expect(t.last().join('\n')).toContain('TILE');
    expect(popupBox(t.last())).toEqual(OBS);
    t.size.cols = 200; t.size.rows = 60; t.app.resized();
    expect(popupBox(t.last())).toEqual(boxFor(200, 60));
    t.press('j');
    expect(obsCursor(w)).toBe(cursor + 1);
  }));
});

// ---- 5 · two viewers, two sizes, one registry ----------------------------------------------------------------------------
describe('H5 · two viewers of different sizes on one registry', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('H5 two viewers: same layer · own boxes · Esc closes both', seed, async () => {
    const w = world(seed);
    const a = await w.viewer();
    const b = await w.viewer({ cols: 80, rows: 24, pane: 'p2' });
    w.openObsidian();
    expect(popupBox(a.last())).toEqual(OBS);
    expect(popupBox(b.last())).toEqual({ top: 2, bottom: 19, x: 8, w: 64 });
    const steps = w.rand.int(1, 9);
    for (let at = 0; at < steps; at++) (w.rand.next() < 0.5 ? a : b).press('j');
    expect(obsCursor(w)).toBe(steps);
    await expectMatchesReference(a);
    await expectMatchesReference(b);
    expect(a.last()[OBS.bottom]).toContain(`${steps + 1}/30`);
    expect(b.last()[19]).toContain(`${steps + 1}/30`);
    (w.rand.next() < 0.5 ? a : b).press(ESC);
    expect(w.registry.stack().layers).toEqual([]);
    for (const one of [a, b]) {
      expect(one.last().join('\n')).not.toContain('📓');
      expect((await expectMatchesReference(one)).rows.map((row) => row.text).join('')).not.toContain('📓');
    }
  }));
});

// ---- 6 · wide glyphs straddling the popup's edges ------------------------------------------------------------------------
/** Pane lines of 가나다/😀 only; odd rows start one cell later, so every box edge cuts a wide glyph on half the rows. */
const wideLines = (): string[] => Array.from({ length: 28 }, (_, row) => `${row % 2 ? ' ' : ''}${'가나다😀'.repeat(14)}`);
describe('H6 · wide glyphs straddle the popup edges: every row is the width, borders where expected, no half glyph', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('H6 wide chars at the border', seed, async () => {
    const w = world(seed);
    const scripted = createScriptedStack();
    const v = await w.viewer({ source: scripted });
    const twin = await w.viewer({ source: 'none' });
    v.paneFrame(screenOf(wideLines()));
    twin.paneFrame(screenOf(wideLines()));
    const paneOnly = await twin.emulated();
    let id: string | undefined;
    let straddles = 0;
    for (let round = 0; round < 4; round++) {
      const box = { w: w.rand.int(12, 50), h: w.rand.int(4, 12), x: 0, y: 0 };
      box.x = w.rand.int(PANE_X + 1, 119 - box.w);
      box.y = w.rand.int(2, 28 - box.h);
      const rect = { anchor: 'tl' as const, w: box.w, h: box.h, dx: box.x, dy: box.y };
      if (id === undefined) id = scripted.open(stub('memo-stub', rect)); else scripted.setRect(id, rect);
      const seen = await expectMatchesReference(v);
      expectExactWidth(seen, 120);
      for (let y = box.y; y < box.y + box.h; y++) {
        const row = seen.rows[y]!;
        const [left, right] = y === box.y ? ['┌', '┐'] : y === box.y + box.h - 1 ? ['└', '┘'] : ['│', '│'];
        expect([row.chars[box.x], row.widths[box.x]]).toEqual([left, 1]);
        expect([row.chars[box.x + box.w - 1], row.widths[box.x + box.w - 1]]).toEqual([right, 1]);
        expect(row.widths[box.x - 1]).not.toBe(2);                               // no glyph half under the left border
        expect(row.widths[box.x + box.w]).not.toBe(0);                           // no orphan half right of the right border
        // the cut glyph on either edge became a space; uncut cells beside the edge are the pane's
        if (paneOnly.rows[y]!.widths[box.x] === 0) { straddles++; expect(row.chars[box.x - 1]).toBe(' '); } else expect(row.chars[box.x - 1]).toBe(paneOnly.rows[y]!.chars[box.x - 1]);
        if (paneOnly.rows[y]!.widths[box.x + box.w] === 0) { straddles++; expect(row.chars[box.x + box.w]).toBe(' '); }
      }
      expectOutsideEqual(seen, paneOnly, [box]);
    }
    expect(straddles).not.toBe(0);
  }));
});

// ---- a · three overlapping popups: z-order, raise, close the middle -------------------------------------------------------
describe('Ha · Obsidian + memo stub + toast overlapping: z-order, raise, close the middle, top-only input', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('Ha three popups: z · raise · close middle · top-only input', seed, async () => {
    const w = world(seed);
    const scripted = createScriptedStack();
    const v = await w.viewer({ source: scripted });
    const twin = await w.viewer({ source: 'none' });
    const lines = fastLines(w.rand, 0);
    v.paneFrame(screenOf(lines));
    twin.paneFrame(screenOf(lines));
    const obs = scripted.open(hydratedObsidian(w));
    const memoBox = { x: 60 + w.rand.int(0, 6), y: 8 + w.rand.int(0, 3), w: 50, h: 12 };   // over obsidian's right edge (col 107)
    const memo = scripted.open(stub('memo-stub', { anchor: 'tl', w: memoBox.w, h: memoBox.h, dx: memoBox.x, dy: memoBox.y }));
    const toastBox = { x: 89, y: 1, w: 30, h: 3 };                                         // over obsidian's top-right corner
    scripted.open({ kind: 'toast', key: 't1', band: 'toast', focus: 'none', rect: { anchor: 'tr', w: 30, h: 3, dx: -1, dy: 1 }, props: { text: `toast ${seed}`, level: 'info' } });
    let seen = await expectMatchesReference(v);
    const midRow = memoBox.y + 3;
    expect(seen.rows[memoBox.y]!.chars[memoBox.x]).toBe('┌');                               // memo over obsidian
    expect(seen.rows[midRow]!.chars[OBS.x + OBS.w - 1]).toBe(' ');                          // obsidian's right border is under memo
    expect(seen.rows[3]!.chars[89]).toBe('╰');                                              // toast over obsidian's top border
    expect(seen.rows[2]!.text).toContain(`toast ${seed}`);
    // a click on obsidian's visible part raises and focuses it (it becomes the middle: memo < obsidian < toast)
    v.clickAt(31, 16);
    expect(v.acts.slice(-2)).toEqual([{ action: 'raise', id: obs }, { action: 'focus', id: obs }]);
    seen = await expectMatchesReference(v);
    expect(seen.rows[midRow]!.chars[OBS.x + OBS.w - 1]).toBe('│');
    expect(seen.rows[memoBox.y]!.chars[memoBox.x]).not.toBe('┌');
    expect(seen.rows[3]!.chars[89]).toBe('╰');                                              // the toast band stays on top
    v.press('j', 'j');                                                                      // keys: the focused top popup only
    expect(obsCursor(scripted)).toBe(2);
    expect(v.attachments.every((one) => one.typed.length === 0)).toBe(true);
    v.press(ESC);                                                                           // close the middle (obsidian)
    expect(scripted.stack().layers.map((one) => one.kind)).toEqual(['memo-stub', 'toast']);
    seen = await expectMatchesReference(v);
    expect(seen.rows[memoBox.y]!.chars[memoBox.x]).toBe('┌');                               // memo revealed whole
    expect(seen.rows[midRow]!.chars[memoBox.x + memoBox.w - 1]).toBe('│');
    expectOutsideEqual(seen, await twin.emulated(), [memoBox, toastBox]);                  // the pane revealed where obsidian was
    v.press(ESC);                                                                           // focus fell to memo: Esc closes it
    expect(scripted.stack().layers.map((one) => one.id)).not.toContain(memo);
    expect(scripted.stack().layers.map((one) => one.kind)).toEqual(['toast']);              // a focus:none toast never takes Esc
    v.press('x');
    expect(v.attachments.at(-1)!.typed).toEqual(['x']);
    await expectMatchesReference(v);
  }));
});

// ---- b · no flicker: only changed rows are written, always synchronized --------------------------------------------------
const TAIL = /(?:\u001b\[\d+;\d+H\u001b\[\?25h|\u001b\[\?25l)$/;
const composedRows = (composed: string): string[] => { const rows = composed.slice(`${ESC}[?25l${ESC}[H`.length).split('\r\n'); rows[rows.length - 1] = rows[rows.length - 1]!.replace(TAIL, ''); return rows; };
describe('Hb · the pane updates under the popup: only changed rows are written, every write synchronized, no clear', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('Hb no flicker: changed rows only · 2026 sync · no 2J', seed, async () => {
    const w = world(seed);
    const v = await w.viewer();
    w.openObsidian();
    let lines = fastLines(w.rand, 0);
    v.paneFrame(screenOf(lines));
    const frames = 60 + w.rand.int(0, 60);
    for (let at = 1; at <= frames; at++) {
      lines = lines.map((line, row) => w.rand.next() < 0.2 ? `${at}:${row} ${KOREAN[w.rand.int(0, KOREAN.length - 1)]}` : line);
      const writesBefore = v.wire.length;
      const composedBefore = v.writes.at(-1)!;
      v.paneFrame(screenOf(lines));
      const prev = composedRows(composedBefore);
      const next = composedRows(v.writes.at(-1)!);
      const changed = next.flatMap((row, y) => row !== prev[y] ? [y + 1] : []);
      if (!changed.length) { expect(v.wire.length).toBe(writesBefore); continue; }                 // nothing changed: nothing written
      expect(v.wire.length).toBe(writesBefore + 1);
      const out = v.wire.at(-1)!;
      expect(out.startsWith(SYNC_BEGIN)).toBe(true);
      expect(out.endsWith(SYNC_END)).toBe(true);
      expect(out).not.toContain(`${ESC}[2J`);
      expect(out).not.toContain(`${ESC}[H`);                                                     // never a full repaint from home
      expect([...out.matchAll(/\u001b\[(\d+);1H/g)].map((m) => Number(m[1]))).toEqual(changed);
    }
    v.paneFrame(screenOf(lines));                                                                // the same frame again: no write
    const quiet = v.wire.length;
    v.paneFrame(screenOf(lines));
    expect(v.wire.length).toBe(quiet);
    for (const out of v.wire) { expect(out.startsWith(SYNC_BEGIN)).toBe(true); expect(out.endsWith(SYNC_END)).toBe(true); expect(out).not.toContain(`${ESC}[2J`); }
    expect(v.wire.filter((out) => out.includes(`${ESC}[H`))).toHaveLength(1);                   // the very first paint only
    const seen = await expectMatchesReference(v);
    expect(seen.rows[OBS.top]!.text).toContain('📓 SimVault');
  }));
});

// ---- c · closing a popup over the top region restores the pane's CURRENT state -------------------------------------------
describe('Hc · a popup over the top region closes onto the pane as it is now (it scrolled meanwhile)', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('Hc reveal from current pane state (scrolled while covered)', seed, async () => {
    const w = world(seed);
    const scripted = createScriptedStack();
    const v = await w.viewer({ source: scripted });
    const twin = await w.viewer({ source: 'none' });
    const history = Array.from({ length: 400 }, (_, at) => `log ${String(at).padStart(3, '0')} ${KOREAN[at % KOREAN.length]}`);
    const view = (offset: number): string[] => history.slice(offset, offset + 28);
    v.paneFrame(screenOf(view(0)));
    twin.paneFrame(screenOf(view(0)));
    scripted.open(stub('banner', { anchor: 'tl', w: '100%', h: 12 }));
    const scrolls = 30 + w.rand.int(0, 100);
    let offset = 0;
    for (let at = 0; at < scrolls; at++) {
      offset += w.rand.int(1, 3);
      v.paneFrame(screenOf(view(offset)));
      twin.paneFrame(screenOf(view(offset)));
    }
    expect((await v.emulated()).rows[0]!.chars[0]).toBe('┌');
    v.press(ESC);
    expect(scripted.stack().layers).toEqual([]);
    const seen = await expectMatchesReference(v);
    expect(bodyRows(seen)).toEqual(bodyRows(await twin.emulated()));
    expect(seen.rows[PANE_Y]!.text.slice(PANE_X)).toContain(`log ${String(offset).padStart(3, '0')}`);   // the row under the tab row is now
  }));
});

// ---- d · moving / resizing a popup leaves no trails ----------------------------------------------------------------------
describe('Hd · a server rect update (move / resize) leaves no trail: cells outside the new box are the pane', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('Hd rect update leaves no trails', seed, async () => {
    const w = world(seed);
    const scripted = createScriptedStack();
    const v = await w.viewer({ source: scripted });
    const twin = await w.viewer({ source: 'none' });
    const lines = fastLines(w.rand, 7);
    v.paneFrame(screenOf(lines));
    twin.paneFrame(screenOf(lines));
    const paneOnly = await twin.emulated();
    let id: string | undefined;
    const moves = 8 + w.rand.int(0, 8);
    for (let at = 0; at < moves; at++) {
      const box = { w: w.rand.int(8, 70), h: w.rand.int(3, 20), x: 0, y: 0 };
      box.x = w.rand.int(0, 120 - box.w);
      box.y = w.rand.int(0, 29 - box.h);
      const rect = { anchor: 'tl' as const, w: box.w, h: box.h, dx: box.x, dy: box.y };
      if (id === undefined || w.rand.next() < 0.8) { if (id === undefined) id = scripted.open(stub('memo-stub', rect)); else scripted.setRect(id, rect); }
      else { scripted.close(id); id = scripted.open(stub('memo-stub', rect)); }                       // or reopened at another rect
      const seen = await expectMatchesReference(v);
      expect(seen.rows[box.y]!.chars[box.x]).toBe('┌');
      expectOutsideEqual(seen, paneOnly, [box]);
    }
    v.press(ESC);
    expect(bodyRows(await expectMatchesReference(v))).toEqual(bodyRows(paneOnly));
  }));
});
