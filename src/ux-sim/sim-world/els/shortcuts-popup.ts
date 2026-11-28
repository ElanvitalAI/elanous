// ELS-SHORTCUTS-POPUP sim (대표 11-28 19:2x «단축키를 한눈에 팝업으로») — E-SHORTCUTS-POPUP.
// A REAL overlay registry (the els server's one stack) + a REAL attach app, its frames fed through the real frame writer into
// @xterm/headless and read back as cells. The seed picks the terminal size (two columns · one scrolling column), the stray
// keys typed at the popup and how far it is scrolled. Every seed must see: ctrl+b ? opens the «Shortcuts» popup with the
// tab keys first; keys typed at it reach neither the pane nor anything else; ↓ scrolls the one-column list line by line;
// Esc closes it; over the tile grid ctrl+b ? opens it with the tile keys first and ctrl+b ? again closes it.
// Expected words are literals of the wording (not the product's table); the scroll check compares the screen with itself.
// Engine-agnostic (no engine-specific path): the kernel runs it once per engine with --engine both.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElsRequest } from '../../../els/server.js';
import type { OverlayRequest } from '../../../els/overlay-registry.js';
import { focusTop } from '../../../els/overlay-stack.js';
import type { SimWorldScenario } from '../types.js';
import { createZaxisWorld, type Viewer, type ZaxisWorld } from './zaxis-overlay-world.js';

// 출처: ELS-SHORTCUTS-POPUP sim device — a wide, the classic and a short terminal (two columns · one column · scroll).
const SIZES = [{ cols: 120, rows: 30 }, { cols: 80, rows: 24 }, { cols: 200, rows: 50 }, { cols: 100, rows: 20 }] as const;
// Keys a person might press at the popup that are not its scroll keys (j/k/space/arrows/PgUp/PgDn/Home/End scroll it).
const STRAY = ['x', 'q', 'ㅎ', '\u0003', 'Z', '\r', 'o'] as const;

const settle = async (): Promise<void> => { for (let at = 0; at < 5; at++) await Promise.resolve(); await new Promise((done) => setImmediate(done)); };

/** The popup as the person sees it, read cell by cell (a wide glyph left of it must not shift the columns): the title row,
 *  the body rows between the │ edges and the bottom row. */
async function popupOf(v: Viewer): Promise<{ title: string; body: string[]; foot: string } | undefined> {
  const rows = (await v.emulated()).rows;
  const cellsFrom = (row: { chars: string[] }, x: number, w: number): string => row.chars.slice(x, x + w).join('');
  for (let y = 0; y < rows.length; y++) {
    const x = rows[y]!.chars.findIndex((char, at) => (char === '╭' || char === '┌') && cellsFrom(rows[y]!, at + 1, 13) === '─ Shortcuts ·');
    if (x < 0) continue;
    const w = rows[y]!.chars.indexOf(rows[y]!.chars[x] === '╭' ? '╮' : '┐', x) - x + 1;
    const body: string[] = [];
    let at = y + 1;
    for (; at < rows.length && !'╰└'.includes(rows[at]!.chars[x] || ' '); at++) body.push(cellsFrom(rows[at]!, x + 1, w - 2).trimEnd());
    return { title: cellsFrom(rows[y]!, x, w), body, foot: at < rows.length ? cellsFrom(rows[at]!, x, w) : '' };
  }
  return undefined;
}

const fail = (message: string): never => { throw new Error(message); };
const layersOf = (w: ZaxisWorld) => w.registry.stack().layers.filter((layer) => layer.kind === 'shortcuts');

export async function runShortcutsPopup(seed: number, record: (event: string, data: Record<string, unknown>) => void): Promise<void> {
  const vault = mkdtempSync(join(tmpdir(), 'els-shortcuts-vault-'));
  const w = createZaxisWorld(seed, vault);
  try {
    const size = SIZES[w.rand.int(0, SIZES.length - 1)]!;
    const request = (one: ElsRequest) => one.op === 'overlay' ? w.registry.apply(one as unknown as OverlayRequest) : undefined;
    const v = await w.viewer({ ...size, request });
    v.paneFrame(`[screen ${size.cols}x${size.rows - 2} cursor=(row 0, col 0, visible true)]\n${Array.from({ length: size.rows - 2 }, (_, row) => `${seed}:${row} pane line`).join('\n')}`);
    record('shortcuts.size', size);

    // 1 · the status line says how to find it
    const status = (await v.emulated()).rows.at(-1)!.text;
    if (!status.includes('? shortcuts')) fail(`status line has no «? shortcuts»: ${JSON.stringify(status)}`);

    // 2 · ctrl+b ? opens the popup, focused, tab keys first
    v.press('\u0002?'); await settle();
    const opened = layersOf(w);
    if (opened.length !== 1) fail(`ctrl+b ? opened ${opened.length} shortcuts layers`);
    if ((opened[0]!.props as { context?: string }).context !== 'normal') fail(`context ${JSON.stringify(opened[0]!.props)}`);
    const top = focusTop(w.registry.stack(), opened[0]!.ownerWorkspace);
    if (top.kind !== 'layer' || top.layer.kind !== 'shortcuts') fail('the shortcuts popup does not have the keys');
    let seen = await popupOf(v) ?? fail('no «Shortcuts» popup on the screen');
    record('shortcuts.open', { title: seen.title.trim(), first: seen.body[0], rows: seen.body.length, foot: seen.foot.trim() });
    if (!seen.title.includes('press ctrl+b, then the key')) fail(`title ${JSON.stringify(seen.title)}`);
    if (!seen.body[0]?.startsWith('Panes & tabs')) fail(`first row ${JSON.stringify(seen.body[0])}`);
    for (const words of ['ctrl+b j / l / n', 'Next tab', 'ctrl+b c', 'New tab (shell)']) if (!seen.body.some((row) => row.includes(words))) fail(`popup lacks ${JSON.stringify(words)}`);

    // 3 · stray keys stay in the popup (nothing reaches the pane; it stays open)
    const strays = Array.from({ length: w.rand.int(2, 6) }, () => STRAY[w.rand.int(0, STRAY.length - 1)]!);
    for (const key of strays) v.press(key);
    await settle();
    if (v.attachments.flatMap((one) => one.typed).join('') !== '') fail(`keys reached the pane: ${JSON.stringify(v.attachments.flatMap((one) => one.typed))}`);
    if (layersOf(w).length !== 1) fail(`a stray key closed the popup (${JSON.stringify(strays)})`);

    // 4 · ↓ scrolls a list taller than the box, line by line (compared with the screen before)
    if (/\d+-\d+\/\d+/.test(seen.foot)) {
      const before = seen.body;
      const steps = w.rand.int(1, Math.min(6, before.length - 1));
      for (let at = 0; at < steps; at++) v.press('\u001b[B');
      await settle();
      seen = await popupOf(v) ?? fail('popup gone after scrolling');
      record('shortcuts.scroll', { steps, first: seen.body[0] });
      if (seen.body[0] !== before[steps]) fail(`after ${steps}× ↓ the first row is ${JSON.stringify(seen.body[0])}, expected ${JSON.stringify(before[steps])}`);
      for (let at = 0; at < steps; at++) v.press('\u001b[A');
      await settle();
      seen = await popupOf(v) ?? fail('popup gone after scrolling back');
      if (seen.body[0] !== before[0]) fail(`↑ did not scroll back: ${JSON.stringify(seen.body[0])}`);
    }

    // 5 · Esc closes it
    v.press('\u001b'); await settle();
    if (layersOf(w).length) fail('Esc left the shortcuts layer open');
    if (await popupOf(v)) fail('Esc left the popup on the screen');

    // 6 · over the tile grid: tile keys first, ctrl+b ? closes
    v.press('\u0002t'); await settle();
    v.press('\u0002?'); await settle();
    const tiled = layersOf(w);
    if (tiled.length !== 1 || (tiled[0]!.props as { context?: string }).context !== 'tile') fail(`over the grid: ${JSON.stringify(tiled.map((one) => one.props))}`);
    seen = await popupOf(v) ?? fail('no popup over the tile grid');
    record('shortcuts.tile', { title: seen.title.trim(), first: seen.body[0], second: seen.body[1] });
    if (!seen.title.includes('Tile view: Enter = back to the pane')) fail(`tile title ${JSON.stringify(seen.title)}`);
    if (!seen.body[0]?.startsWith('Tile view')) fail(`tile first row ${JSON.stringify(seen.body[0])}`);
    if (!seen.body.some((row) => /Enter\s+Back to the pane/.test(row))) fail('tile popup lacks «Enter  Back to the pane»');
    v.press('\u0002?'); await settle();
    if (layersOf(w).length) fail('ctrl+b ? over the grid did not close the popup');
    if (await popupOf(v)) fail('the popup stayed on the grid');
  } finally {
    w.dispose();
    rmSync(vault, { recursive: true, force: true });
  }
}

const scenario: SimWorldScenario = {
  id: 'E-SHORTCUTS-POPUP',
  title: 'ctrl+b ? opens the shortcuts popup over a tab and over the tile grid; it scrolls, keeps stray keys, Esc closes it',
  async run(ctx) {
    const seed = Math.floor(ctx.random() * 1_000_000) + ctx.seed;   // not-policy: a seed mix, not a knob
    try {
      await runShortcutsPopup(seed, (event, data) => ctx.recorder.event(event, { synthetic: true, ...data }));
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: 'shortcuts popup differs from expected', diff: message };
    }
  },
};
export const simWorldScenarios: readonly SimWorldScenario[] = [scenario];
