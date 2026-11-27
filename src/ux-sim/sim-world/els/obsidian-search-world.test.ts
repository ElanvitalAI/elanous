// ELS-OBSIDIAN-SEARCH sim — the search line inside the Obsidian popup, seeds 1..5. A REAL registry (server hydrate does the
// bounded vault scan) + a REAL attach app at 120×30 + a pane-only twin. Every typed key, arrow, wheel and Enter is checked on
// what the person sees: the composed frame through the real frame writer into @xterm/headless, cell by cell against the
// reference composite, every row exactly 120 cells, the popup corners at literal cells (rows 3..25, cols 12..107), every
// cell outside the popup = the twin's. Expected hit lists are literals of the sim vault (30 notes note-00..note-29, each
// «# note-NN» + lines «Line LL of note-NN»), never computed with the product's search.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZaxisWorld, popupBody, referenceOf, rowsOf, writeNotesVault, type EmuScreen, type Viewer, type ZaxisWorld } from './zaxis-overlay-world.js';

const SEEDS = [1, 2, 3, 4, 5] as const;
const OBS = { x: 12, y: 3, w: 96, h: 23 } as const;
const DOWN = '\u001b[B';
const wheelDown = (x: number, y: number): string => `\u001b[<65;${x};${y}M`;

let root = '';
let vault = '';
const worlds: ZaxisWorld[] = [];
const matrix = new Map<string, Map<number, string>>();
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'els-search-sim-')); vault = writeNotesVault(join(root, 'SimVault')); });
afterAll(() => {
  for (const world of worlds) world.dispose();
  rmSync(root, { recursive: true, force: true });
  const lines = [`| case | ${SEEDS.map((s) => `seed ${s}`).join(' | ')} |`, `|---|${SEEDS.map(() => '---').join('|')}|`];
  for (const [name, row] of matrix) lines.push(`| ${name} | ${SEEDS.map((s) => row.get(s) ?? '-').join(' | ')} |`);
  console.log(`\nOBSIDIAN-SEARCH MATRIX\n${lines.join('\n')}`);
});
const cell = (name: string, seed: number, body: () => Promise<void>) => async (): Promise<void> => {
  const row = matrix.get(name) ?? new Map<number, string>();
  matrix.set(name, row);
  try { await body(); row.set(seed, 'PASS'); } catch (error) { row.set(seed, 'FAIL'); throw error; }
};

const cellsOf = (screen: EmuScreen): string[] => screen.rows.map((row) => row.chars.map((char, x) => `${char}/${row.widths[x]}`).join('|'));
async function frameInvariants(v: Viewer, twin: Viewer, popup: boolean): Promise<EmuScreen> {
  const seen = await v.emulated();
  expect(cellsOf(seen)).toEqual(cellsOf(await referenceOf(v.writes.at(-1)!, v.size)));
  for (const row of seen.rows) expect(row.widths.reduce((sum, w) => sum + w, 0)).toBe(120);
  if (popup) {
    expect(seen.rows[OBS.y]!.chars[OBS.x]).toBe('┌');
    expect(seen.rows[OBS.y]!.chars[OBS.x + OBS.w - 1]).toBe('┐');
    expect(seen.rows[OBS.y + OBS.h - 1]!.chars[OBS.x]).toBe('└');
    expect(seen.rows[OBS.y + OBS.h - 1]!.chars[OBS.x + OBS.w - 1]).toBe('┘');
  }
  const other = await twin.emulated();
  for (let y = 0; y < 29; y++) for (let x = 0; x < 120; x++) {
    if (popup && y >= OBS.y && y < OBS.y + OBS.h && x >= OBS.x - 1 && x <= OBS.x + OBS.w) continue;
    if (seen.rows[y]!.chars[x] !== other.rows[y]!.chars[x]) throw new Error(`cell (${x},${y}) = ${JSON.stringify(seen.rows[y]!.chars[x])}, pane-only = ${JSON.stringify(other.rows[y]!.chars[x])}`);
  }
  return seen;
}
const setup = async (seed: number) => {
  const w = createZaxisWorld(seed, vault);
  worlds.push(w);
  const v = await w.viewer();
  const twin = await w.viewer({ source: 'none' });
  const screen = `[screen 91x28 cursor=(row 0, col 0, visible true)]\n${Array.from({ length: 28 }, (_, row) => `${seed}:${row} 한글 😀 work`).join('\n')}`;
  v.paneFrame(screen); twin.paneFrame(screen);
  w.openObsidian();
  await frameInvariants(v, twin, true);
  return { w, v, twin };
};
const body = (v: Viewer): string[] => popupBody(rowsOf(v.writes.at(-1)!));
const obsProps = (w: ZaxisWorld) => w.registry.stack().layers.find((one) => one.kind === 'obsidian')?.props as { search?: string; note?: string; searchAt?: number } | undefined;

describe('S1 · text search: «Line 0d» hits every note in name order with its line as the snippet; ↓ n then Enter opens note n', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('text search → open', seed, async () => {
    const { w, v, twin } = await setup(seed);
    const digit = w.rand.int(1, 9);
    const query = `Line 0${digit}`;
    v.press('/');
    await frameInvariants(v, twin, true);
    expect(body(v)[0]).toBe('/');
    let typed = '';
    for (const char of query) {
      v.press(char); typed += char;
      await frameInvariants(v, twin, true);
      expect(body(v)[0]).toBe(`/ ${typed}`.trimEnd());   // popupBody trims the row end
    }
    // 21 body rows: the filter line + 20 hits in view
    expect(body(v).slice(1, 4)).toEqual([`  note-00  Line 0${digit} of note-00`, `  note-01  Line 0${digit} of note-01`, `  note-02  Line 0${digit} of note-02`]);
    expect(rowsOf(v.writes.at(-1)!)[OBS.y + OBS.h - 1]).toContain('Esc leave search · 1/30');
    // a wheel over the popup moves the selection (arrows), it never types into the line
    v.press(wheelDown(60, 12));
    await frameInvariants(v, twin, true);
    expect(body(v)[0]).toBe(`/ ${query}`);
    const down = w.rand.int(0, 6);
    for (let at = 0; at < down; at++) { v.press(DOWN); await frameInvariants(v, twin, true); }
    const pick = 3 + down;
    expect(rowsOf(v.writes.at(-1)!)[OBS.y + OBS.h - 1]).toContain(`Esc leave search · ${pick + 1}/30`);
    v.press('\r');
    await frameInvariants(v, twin, true);
    const name = `note-${String(pick).padStart(2, '0')}`;
    expect(obsProps(w)?.note).toBe(`${name}.md`);
    expect(obsProps(w)?.search).toBeUndefined();
    expect(rowsOf(v.writes.at(-1)!)[OBS.y]).toContain(`📓 SimVault · ${name}.md`);
    expect(body(v)[0]).toContain(name);
    v.press('\u001b');
    await frameInvariants(v, twin, false);
    expect(w.registry.stack().layers).toHaveLength(0);
  }));
});

describe('S2 · name search: «note-1» = 10 names, no text hits; ⌫ edits; Esc leaves search (list again), Esc again closes', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('name search → leave → close', seed, async () => {
    const { w, v, twin } = await setup(seed);
    v.press('/');
    for (const char of 'note-1') { v.press(char); await frameInvariants(v, twin, true); }
    expect(body(v).slice(1, 12)).toEqual([...Array.from({ length: 10 }, (_, at) => `  note-1${at}`), '']);
    // seeded edits: ⌫ k times then retype — the line and the hits follow every key
    const back = w.rand.int(1, 3);
    for (let at = 0; at < back; at++) { v.press('\u007f'); await frameInvariants(v, twin, true); }
    expect(body(v)[0]).toBe(`/ ${'note-1'.slice(0, 6 - back)}`);
    for (const char of 'note-1'.slice(6 - back)) { v.press(char); await frameInvariants(v, twin, true); }
    expect(body(v)[0]).toBe('/ note-1');
    expect(rowsOf(v.writes.at(-1)!)[OBS.y + OBS.h - 1]).toContain('1/10');
    v.press('\u001b');
    await frameInvariants(v, twin, true);
    expect(obsProps(w)?.search).toBeUndefined();
    expect(body(v)[0]).toBe('  note-00');
    v.press('\u001b');
    await frameInvariants(v, twin, false);
    expect(w.registry.stack().layers).toHaveLength(0);
    expect(v.attachments.flatMap((one) => one.typed).join('')).toBe('');   // nothing reached the pane under the popup
  }));
});
