// ELS-POPUP-STYLE sim — the popup style layer over a REAL registry + hub and REAL attach apps (sidechat-world.ts), seeds 1–5.
// F1–F4 run with els.popupStyle = fancy (the dressed sidechat over the Obsidian float); F5 flips the style live. Checked:
//   F1 stacked over obsidian at 180x56: centered (left margin = right margin ± the shadow cell), title bar + model chip,
//      ▒ shadow right and bottom, the float still visible around it, every frame passes the frame invariants;
//   F2 resize 180x56 ↔ 80x24 while the answer streams: every size keeps the popup whole and centered (the shadow stays at
//      80x24 — 70% of 80 = 56 cells), the streamed tail in view;
//   F3 no flicker: while chunks stream, the rows outside the popup box never change, and a repaint with nothing new writes
//      the same screen;
//   F4 close restores focus: Esc closes the popup → keys go to the float (not the pane), Esc again → keys reach the pane;
//      nothing leaks to the pane while a layer has the keys;
//   F5 one switch flips every registered popup at once: simple (default) → fancy → simple on the next repaint, sidechat AND
//      obsidian together, the same words in both styles; an unknown value draws simple.
// Expected strings are literals, never built with the product's renderer.
import { afterAll, describe, expect, test } from 'bun:test';
import { popupStyleOf } from '../../../els/popup-style.js';
import { createSidechatWorld, type SidechatViewer, type SidechatWorld } from './sidechat-world.js';

const SEEDS = [1, 2, 3, 4, 5] as const;
const PREFIX = '\u0002';
const ESC = '\u001b';
const worlds: SidechatWorld[] = [];
afterAll(() => { for (const one of worlds) one.dispose(); });
let style: unknown = 'fancy';                                        // the config value the viewers read (els.popupStyle)
const world = (seed: number): SidechatWorld => { const made = createSidechatWorld(seed, () => ({}), (stream) => stream, { style: () => popupStyleOf(style) }); worlds.push(made); return made; };
const kinds = (w: SidechatWorld): string => w.registry.stack().layers.map((one) => one.kind).join('<');
const focusKind = (w: SidechatWorld): string | undefined => { const id = w.registry.stack().focus.at(-1); return w.registry.stack().layers.find((one) => one.id === id)?.kind; };

/** Cell columns (a wide glyph — ⚡, 한글 — is two cells): the column of a glyph, and a row cut by cell columns. */
const cellsOf = (row: string): string[] => Array.from(row).flatMap((ch) => Bun.stringWidth(ch) === 2 ? [ch, ''] : [ch]);
const cellOf = (row: string, ch: string, last: boolean): number => last ? cellsOf(row).lastIndexOf(ch) : cellsOf(row).indexOf(ch);
const cellAt = (row: string, col: number): string => cellsOf(row)[col] ?? '';
const cellSlice = (row: string, from: number, to: number): string => cellsOf(row).slice(from, to).join('');

/** The popup on screen: its title row, bottom row, left column and right edge (the ╮ column), from the plain rows. */
function popupBox(v: SidechatViewer): { top: number; bottom: number; left: number; right: number } | undefined {
  const rows = v.last();
  const top = rows.findIndex((row) => row.includes('╭ ✦ Sidechat'));
  if (top < 0) return undefined;
  const bottom = rows.findIndex((row, at) => at > top && row.includes('Esc close ╯'));
  const left = cellOf(rows[top]!, '╭', false);
  const right = cellOf(rows[top]!, '╮', true);
  return { top, bottom, left, right };
}

/** Centered on the view above the status line: margins equal within the shadow cell and rounding. The ▒ shadow is drawn
 *  only on a box of at least 56 x 20 cells (80x24 has none: its 16-row popup would cover the float's hint line). */
function expectCentered(v: SidechatViewer): void {
  const box = popupBox(v)!;
  expect(box).toBeDefined();
  expect(box.bottom).toBeGreaterThan(box.top);
  const rows = v.last();
  const shadow = cellAt(rows[box.top + 1]!, box.right + 1) === '▒';
  const width = box.right - box.left + 1 + (shadow ? 1 : 0);
  const height = box.bottom - box.top + 1 + (shadow ? 1 : 0);
  expect(shadow).toBe(height >= 20 && width >= 56);
  expect([0, 1]).toContain(Math.abs(box.left - (v.size.cols - (box.left + width))));          // odd leftovers round to one side
  expect([0, 1]).toContain(Math.abs(box.top - ((v.size.rows - 1) - (box.top + height))));
  if (shadow) expect(cellSlice(rows[box.bottom + 1]!, box.left + 1, box.right + 2)).toBe('▒'.repeat(box.right - box.left + 1));
}
const boxWidth = (v: SidechatViewer): number => { const box = popupBox(v)!; return box.right - box.left + 1 + (cellAt(v.last()[box.top + 1]!, box.right + 1) === '▒' ? 1 : 0); };

async function openStacked(w: SidechatWorld, v: SidechatViewer): Promise<void> {
  expect(w.registry.apply({ action: 'open', kind: 'obsidian', props: { dir: '' } }).exitCode).toBe(0);
  await w.flush();
  v.press(`${PREFIX}/`);
  await w.flush();
  expect(kinds(w)).toBe('obsidian<sidechat');
  expect(focusKind(w)).toBe('sidechat');
}

describe('F1 · stacked over obsidian at 180x56: centered, title bar + chip, shadow, the float visible around it', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer({ cols: 180, rows: 56 });
    await openStacked(w, v);
    const screen = v.last().join('\n');
    expect(screen).toContain('╭ ✦ Sidechat ');
    expect(screen).toContain(' ⚡ fast model ╮ ');
    expect(screen).toContain('Enter send · Esc close ╯▒');
    expect(screen).toContain('Ask anything');
    expectCentered(v);
    // 70% x 70% of 180 x 55: a 126-cell box (frame 125 + shadow 1).
    const box = popupBox(v)!;
    expect(boxWidth(v)).toBe(126);
    // The float (80%) shows around the popup: its frame rows above the popup's title row.
    expect(v.last().slice(0, box.top).some((row) => /[╭┌]/.test(row))).toBe(true);
    expect(v.violations).toEqual([]);
  });
});

describe('F2 · resize 180x56 ↔ 80x24 while the answer streams: whole, centered, the tail in view', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed + 10);
    const v = await w.viewer({ cols: 180, rows: 56 });
    await openStacked(w, v);
    for (const ch of Array.from('resize me')) v.press(ch);
    v.press('\r');
    await w.flush();
    const words = Array.from({ length: w.rand.int(8, 16) }, (_, at) => `w${at}`);
    for (let at = 0; at < words.length; at++) {
      await w.calls[0]!.say(`${words[at]} `);
      if (w.rand.int(0, 1) === 0) { const small = v.size.cols === 180; v.resize(small ? 80 : 180, small ? 24 : 56); }
      await w.flush();
      expect(v.last()).toHaveLength(v.size.rows);
      expect(v.last().join('\n')).toContain('✦ Sidechat · answering…');
      expectCentered(v);
    }
    v.resize(80, 24);
    await w.flush();
    expectCentered(v);
    expect(boxWidth(v)).toBe(56);
    expect(v.last().join('\n')).not.toContain('▒');                // 80x24: no shadow over the float's hint line
    await w.calls[0]!.end();
    await w.flush();
    expect(v.last().join('\n')).toContain(words.at(-1)!);
    expect(v.last().join('\n')).not.toContain('answering…');
    v.resize(180, 56);
    await w.flush();
    expectCentered(v);
    expect(v.violations).toEqual([]);
  });
});

describe('F3 · no flicker: streaming repaints only the popup; an idle repaint writes the same screen', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed + 20);
    const cols = [180, 120, 80][w.rand.int(0, 2)]!;
    const rows = cols === 80 ? 24 : 40;
    const v = await w.viewer({ cols, rows });
    await openStacked(w, v);
    for (const ch of Array.from('stream')) v.press(ch);
    v.press('\r');
    await w.flush();
    await w.calls[0]!.say('first ');
    await w.flush();
    const box = popupBox(v)!;
    const outside = (screen: readonly string[]): string[] => screen.map((row, at) => at >= box.top && at <= box.bottom + 1
      ? cellsOf(row).filter((_, x) => x < box.left || x > box.right + 1).join('') : row);
    const before = outside(v.last());
    for (let at = 0; at < w.rand.int(4, 10); at++) {
      await w.calls[0]!.say(`chunk${at} `);
      await w.flush();
      expect(popupBox(v)).toEqual(box);
      expect(outside(v.last())).toEqual(before);
    }
    await w.calls[0]!.end();
    await w.flush();
    const settled = v.last().join('\n');
    const frames = v.frames();
    v.resize(cols, rows);                                            // same size: a repaint with nothing new
    await w.flush();
    expect(v.frames()).toBeGreaterThanOrEqual(frames);
    expect(v.last().join('\n')).toBe(settled);
    expect(v.violations).toEqual([]);
  });
});

describe('F4 · close restores focus: Esc → the float has the keys, Esc → the pane; nothing leaks while a layer has them', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed + 30);
    const v = await w.viewer({ cols: [180, 80][w.rand.int(0, 1)]!, rows: [56, 24][w.rand.int(0, 1)]! });
    await openStacked(w, v);
    for (const ch of Array.from('abc')) v.press(ch);
    expect(w.layer()!.props.input).toBe('abc');
    expect(v.typed()).toEqual([]);
    v.press(ESC);
    await w.flush();
    expect(kinds(w)).toBe('obsidian');
    expect(focusKind(w)).toBe('obsidian');
    expect(v.last().join('\n')).not.toContain('✦ Sidechat');
    // The popup's shadow leaves with it: the shadow rows left are the float's (one ▒ row, at its bottom).
    expect(v.last().filter((row) => /▒{8,}/.test(row)).length).toBe(v.size.rows === 56 ? 1 : 0);
    expect(v.last().join('\n')).toContain('✦ 📓');
    v.press('j');                                                    // a key for the float, not the pane
    await w.flush();
    expect(v.typed()).toEqual([]);
    v.press(ESC);
    await w.flush();
    expect(kinds(w)).toBe('');
    v.press('z');
    await w.flush();
    expect(v.typed().join('')).toBe('z');                            // the pane has the keys again
    v.press(`${PREFIX}/`);                                           // reopen: the dress comes back, focused
    await w.flush();
    expect(focusKind(w)).toBe('sidechat');
    expect(v.last().join('\n')).toContain('╭ ✦ Sidechat');
    expect(v.violations).toEqual([]);
  });
});

describe('F5 · one switch flips every popup at once (simple → fancy → simple · unknown = simple), live on the next repaint', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed + 40);
    const cols = [180, 80][w.rand.int(0, 1)]!;
    const rows = cols === 80 ? 24 : 56;
    const v = await w.viewer({ cols, rows });
    style = undefined;                                               // no config key: the default
    try {
      await openStacked(w, v);
      const words = (screen: string): string => screen.replace(/[✦▒▌▏╌]/g, ' ').replace(/[╭╮╰╯┌┐└┘─├┤│]/g, ' ').replace(/\s+/g, ' ');
      const simple = v.last().join('\n');
      expect(simple).not.toContain('✦');
      expect(simple).not.toContain('▒');
      expect(simple).toContain('╭─ Sidechat');
      expect(simple).toContain('┌ 📓');                                // the float keeps its own square frame
      style = 'fancy';
      v.resize(cols, rows);                                          // the next repaint (the attach app's 1 s poll in production)
      await w.flush();
      const fancy = v.last().join('\n');
      expect(fancy).toContain('╭ ✦ Sidechat');
      expect(fancy).toContain('✦ 📓 Obsidian');                         // the float flipped in the same repaint
      if (rows === 56) expect(fancy).toContain('▒');
      expect(fancy).not.toContain('╭─ Sidechat');
      for (const one of ['Ask anything', 'Enter send · Esc close']) { expect(simple).toContain(one); expect(fancy).toContain(one); }
      expect(words(fancy)).toContain('fast model');
      style = ['neon', 'Fancy', 42][w.rand.int(0, 2)];               // an unknown value reads as simple
      v.resize(cols, rows);
      await w.flush();
      expect(v.last().join('\n')).toBe(simple);
      expect(v.violations).toEqual([]);
    } finally { style = 'fancy'; }
  });
});
