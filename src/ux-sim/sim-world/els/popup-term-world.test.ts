// ELS-POPUP-TERM sim — the popup terminal over els, seeds 1..5, read from what the person SEES: the real overlay registry,
// real attach apps (fake socket deps), the popup pane's frames pushed into its own attach stream, every composed frame
// through the real frame writer into @xterm/headless and checked cell by cell (reference composite · a pane-only twin).
// Expected boxes, inner PTY sizes and cursor cells are literals (96% × 60% of the area above the status line, top, dy 1),
// never computed with the product's resolveRect.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElsRequest } from '../../../els/server.js';
import type { ElsResult } from '../../../els/core.js';
import { createZaxisWorld, paneRow, prng, referenceOf, writeNotesVault, type AttachmentLog, type EmuScreen, type Viewer, type ViewerOpts, type ZaxisWorld } from './zaxis-overlay-world.js';

const SEEDS = [1, 2, 3, 4, 5] as const;
const ESC = '\u001b';
const POP = 'ppop1';
// term box per terminal size: left cell, top row, width, height; inner = the PTY size (box minus the frame)
const BOX: Readonly<Record<string, { x: number; y: number; w: number; h: number }>> = {
  '120x30': { x: 2, y: 1, w: 115, h: 17 },
  '80x24': { x: 1, y: 1, w: 77, h: 14 },
  '180x56': { x: 3, y: 1, w: 173, h: 33 },
  '200x60': { x: 4, y: 1, w: 192, h: 35 },
};
const INNER: Readonly<Record<string, { cols: number; rows: number }>> = {
  '120x30': { cols: 113, rows: 15 }, '80x24': { cols: 75, rows: 12 }, '180x56': { cols: 171, rows: 31 }, '200x60': { cols: 190, rows: 33 },
};

let root = '';
let vault = '';
const worlds: ZaxisWorld[] = [];
const matrix = new Map<string, Map<number, string>>();
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'els-popterm-')); vault = writeNotesVault(join(root, 'SimVault')); });
afterAll(() => {
  for (const one of worlds) one.dispose();
  rmSync(root, { recursive: true, force: true });
  const lines = [`| case | ${SEEDS.map((s) => `seed ${s}`).join(' | ')} |`, `|---|${SEEDS.map(() => '---').join('|')}|`];
  for (const [name, row] of matrix) lines.push(`| ${name} | ${SEEDS.map((s) => row.get(s) ?? '-').join(' | ')} |`);
  console.log(`\nELS-POPUP-TERM MATRIX\n${lines.join('\n')}`);
});
const cell = (name: string, seed: number, body: () => Promise<void>) => async (): Promise<void> => {
  const row = matrix.get(name) ?? new Map<number, string>();
  matrix.set(name, row);
  try { await body(); row.set(seed, 'PASS'); } catch (error) { row.set(seed, 'FAIL'); throw error; }
};

interface TermWorld { w: ZaxisWorld; requests: ElsRequest[]; viewer: (opts?: ViewerOpts) => Promise<Viewer> }
function termWorld(seed: number): TermWorld {
  const w = createZaxisWorld(seed, vault);
  worlds.push(w);
  w.listing.panes.push({ ...paneRow('wpop', POP, 'popup'), workspace: 'els-popup' });
  const requests: ElsRequest[] = [];
  const request = (one: ElsRequest): ElsResult | undefined => {
    requests.push(one);
    if (one.op === 'overlay') { const { op: _op, ...rest } = one; return w.registry.apply(rest); }
    return undefined;
  };
  return { w, requests, viewer: (opts = {}) => w.viewer({ ...opts, request }) };
}
const settle = async (): Promise<void> => { for (let at = 0; at < 5; at++) await Promise.resolve(); await new Promise((done) => setImmediate(done)); };
const popAttach = (v: Viewer): AttachmentLog | undefined => [...v.attachments].reverse().find((one) => one.pane === POP && !one.detached);
const termLayer = (w: ZaxisWorld) => w.registry.stack().layers.find((one) => one.kind === 'term');
const cellsOf = (screen: EmuScreen): string[] => screen.rows.map((row) => row.chars.map((char, x) => `${char}/${row.widths[x]}`).join('|'));
async function exact(v: Viewer): Promise<EmuScreen> {
  const composed = v.writes.at(-1)!;
  const size = { ...v.size };
  const seen = await v.emulated();
  expect(cellsOf(seen)).toEqual(cellsOf(await referenceOf(composed, size)));
  for (const row of seen.rows) { expect(row.widths.reduce((sum, w) => sum + w, 0)).toBe(size.cols); expect(row.widths[size.cols - 1]).not.toBe(2); }
  return seen;
}
const KOREAN = ['가나다라마바사', '😀 이모지 줄', '한글 출력 🚀 빠름', '빌드 진행중 ✅', 'ｗｉｄｅ ＡＢＣ'];
const popFrame = (a: AttachmentLog, lines: readonly string[], cursor = { row: 0, col: 0 }, size = { cols: 113, rows: 15 }): void =>
  a.handlers.onFrame({ pane: POP, seq: 1, cols: size.cols, rows: size.rows, back: 0, screen: `[screen ${size.cols}x${size.rows} cursor=(row ${cursor.row}, col ${cursor.col}, visible true)]\n${lines.join('\n')}` });
async function openTerm(v: Viewer): Promise<AttachmentLog> {
  v.press('\u0002`');
  await settle();
  const a = popAttach(v);
  if (!a) throw new Error('popup pane not attached');
  return a;
}

describe('T1 · the terminal over a file-like float and under a toast: z order, frame exact', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('T1 overlap: popup band over float · toast on top', seed, async () => {
    const { w, viewer } = termWorld(seed);
    const v = await viewer();
    w.openObsidian();
    const a = await openTerm(v);
    expect(a.size).toEqual(INNER['120x30']);
    popFrame(a, [`$ echo seed ${seed}`, `seed ${seed}`, '$ ']);
    w.registry.apply({ action: 'open', kind: 'toast', props: { text: `토스트 ${seed}`, level: 'info' } });
    const seen = await exact(v);
    const box = BOX['120x30']!;
    expect(seen.rows[box.y]!.chars[box.x]).toBe('╭');
    expect(seen.rows[box.y + box.h - 1]!.chars[box.x]).toBe('╰');
    expect(seen.rows[box.y + 1]!.text.slice(box.x + 1, box.x + 1 + 14)).toBe(`$ echo seed ${seed}`.padEnd(14).slice(0, 14));
    expect(seen.rows.map((row) => row.text).join('\n')).toContain(`토스트 ${seed}`);
    // the Obsidian float below still draws where the terminal does not cover it
    expect(seen.rows.map((row) => row.text).join('\n')).toContain('└');
  }));
});

describe('T2 · resize: the popup PTY follows the box (literal inner sizes)', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('T2 resize: PTY = inner box · exact width', seed, async () => {
    const { w, viewer } = termWorld(seed);
    const v = await viewer();
    const a = await openTerm(v);
    const sizes = ['120x30', '80x24', '180x56', '200x60'];
    let last = '120x30';
    for (let at = 0; at < 8; at++) {
      const pick = sizes[w.rand.int(0, sizes.length - 1)]!;
      const [cols, rows] = pick.split('x').map(Number) as [number, number];
      v.size.cols = cols; v.size.rows = rows; v.app.resized();
      if (pick !== last) expect(a.resizes.at(-1)).toEqual(INNER[pick]);
      last = pick;
      popFrame(a, Array.from({ length: INNER[pick]!.rows }, (_, row) => `${row} ${KOREAN[row % KOREAN.length]}`), { row: 0, col: 0 }, INNER[pick]);
      const seen = await exact(v);
      const box = BOX[pick]!;
      expect(seen.rows[box.y]!.chars[box.x]).toBe('╭');
      expect(seen.rows[box.y]!.chars[box.x + box.w - 1]).toBe('╮');
      expect(seen.rows[box.y + box.h - 1]!.chars[box.x + box.w - 1]).toBe('╯');
    }
  }));
});

describe('T3 · two viewers: both draw the same terminal, each at its own size', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('T3 two viewers: one PTY · both exact', seed, async () => {
    const { viewer } = termWorld(seed);
    const a = await viewer();
    const b = await viewer({ cols: 80, rows: 24 });
    const pa = await openTerm(a);
    b.app.resized(); await settle();
    const pb = popAttach(b)!;
    expect(pb.size).toEqual(INNER['80x24']);
    const lines = Array.from({ length: 10 }, (_, row) => `row ${row} ${KOREAN[(row + seed) % KOREAN.length]}`);
    popFrame(pa, lines); popFrame(pb, lines);
    const sa = await exact(a); const sb = await exact(b);
    expect(sa.rows[BOX['120x30']!.y + 1]!.text).toContain('row 0');
    expect(sb.rows[BOX['80x24']!.y + 1]!.text).toContain('row 0');
    b.press('x');                                                       // B types: the focus stack is shared, the PTY gets it
    expect(pb.typed).toEqual(['x']);
  }));
});

describe('T4 · fast output in the pane underneath AND inside the popup', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('T4 fast output both: border intact · outside = pane only', seed, async () => {
    const { w, viewer } = termWorld(seed);
    const v = await viewer();
    const twin = await w.viewer({ source: 'none' });
    const a = await openTerm(v);
    const rand = prng(seed * 13);
    const box = BOX['120x30']!;
    const frames = 150 + rand.int(0, 100);
    for (let at = 0; at < frames; at++) {
      const pane = Array.from({ length: 28 }, (_, row) => `${at}:${row} ${KOREAN[rand.int(0, KOREAN.length - 1)]}`);
      v.paneFrame(`[screen 91x28 cursor=(row 0, col 0, visible true)]\n${pane.join('\n')}`);
      twin.paneFrame(`[screen 91x28 cursor=(row 0, col 0, visible true)]\n${pane.join('\n')}`);
      popFrame(a, Array.from({ length: 15 }, (_, row) => `pty ${at}.${row} ${KOREAN[(at + row) % KOREAN.length]}`), { row: rand.int(0, 14), col: rand.int(0, 60) });
      const seen = await v.emulated();
      expect(seen.rows[box.y]!.chars[box.x]).toBe('╭');
      expect(seen.rows[box.y + box.h - 1]!.chars[box.x + box.w - 1]).toBe('╯');
      if (at % 30 === 0) {
        const paneOnly = await twin.emulated();
        for (let y = 0; y < seen.rows.length - 1; y++) for (let x = 0; x < 120; x++) {
          if (y >= box.y && y < box.y + box.h && x >= box.x - 1 && x <= box.x + box.w) continue;
          expect(seen.rows[y]!.chars[x]).toBe(paneOnly.rows[y]!.chars[x]!);
        }
        expect(cellsOf(seen)).toEqual(cellsOf(await referenceOf(v.writes.at(-1)!, v.size)));
      }
    }
    expect(v.attachments.filter((one) => one.pane === 'p1').every((one) => one.typed.length === 0)).toBe(true);
  }));
});

describe('T5 · Ctrl-C, Esc and a paste go to the popup process — never to the pane below, Esc does not close', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('T5 keys: ctrl-c · Esc · paste → PTY · layer stays', seed, async () => {
    const { w, viewer } = termWorld(seed);
    const v = await viewer();
    const a = await openTerm(v);
    const keys = ['sleep 100\r', '\u0003', ESC, '\u001b[A', '한글', '\u001b[200~pasted\u001b[201~', 'q'];
    const sent = Array.from({ length: 6 }, () => keys[w.rand.int(0, keys.length - 1)]!);
    for (const one of sent) v.press(one);
    expect(a.typed.join('')).toBe(sent.join(''));
    expect(termLayer(w)).toBeDefined();
    expect(v.attachments.filter((one) => one.pane === 'p1').every((one) => one.typed.length === 0)).toBe(true);
  }));
});

describe('T6 · hide / show keeps the process; close kills it', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('T6 hide/show keeps the pane · ctrl+b x closes it', seed, async () => {
    const { w, requests, viewer } = termWorld(seed);
    const v = await viewer();
    const cycles = 2 + w.rand.int(0, 3);
    for (let at = 0; at < cycles; at++) {
      const a = await openTerm(v);
      expect(termLayer(w)?.props).toEqual({ pane: POP });
      v.press(w.rand.int(0, 1) ? '\u0002\u001b' : '\u0002q');           // ctrl+b Esc / ctrl+b q: hide, the app keeps running
      await settle();
      expect(termLayer(w)).toBeUndefined();
      expect(a.detached).toBe(true);
      expect(requests.some((one) => one.op === 'close')).toBe(false);
      await exact(v);
    }
    await openTerm(v);
    v.press('\u0002x');
    await settle();
    expect(termLayer(w)).toBeUndefined();
    expect(requests.find((one) => one.op === 'close')).toEqual({ op: 'close', pane: POP, confirmed: true });
  }));
});

describe('T7 · the terminal cursor sits on the PTY cursor inside the box; wheel scrolls the popup scrollback', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('T7 cursor in box · wheel → popup scrollback', seed, async () => {
    const { w, viewer } = termWorld(seed);
    const v = await viewer();
    const a = await openTerm(v);
    const box = BOX['120x30']!;
    for (let at = 0; at < 10; at++) {
      const cursor = { row: w.rand.int(0, 14), col: w.rand.int(0, 100) };
      popFrame(a, ['$ '], cursor);
      // 1-based terminal cell: row = box top + frame + cursor row + 1, col = box left + frame + cursor col + 1
      expect(v.writes.at(-1)!.endsWith(`${ESC}[${box.y + 1 + cursor.row + 1};${box.x + 1 + cursor.col + 1}H${ESC}[?25h`)).toBe(true);
      const seen = await exact(v);
      expect(seen.cursor).toEqual({ x: box.x + 1 + cursor.col, y: box.y + 1 + cursor.row });
    }
    v.app.key(`\u001b[<64;${box.x + 10};${box.y + 5}M`);              // wheel up over the popup
    v.app.key(`\u001b[<65;${box.x + 10};${box.y + 5}M`);              // wheel down
    expect(a.scrolls).toEqual([3, -3]);
    expect(v.attachments.filter((one) => one.pane === 'p1').every((one) => one.scrolls.length === 0 && one.typed.length === 0)).toBe(true);
  }));
});

describe('T8 · a term layer opened without a pane (ElsControl «팝업 터미널 띄워줘») with two viewers starting at once: one shell survives', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('T8 concurrent start: one pane named · the loser closed', seed, async () => {
    const w = createZaxisWorld(seed, vault);
    worlds.push(w);
    const requests: ElsRequest[] = [];
    let made = 0;
    const request = (one: ElsRequest): ElsResult | undefined => {
      requests.push(one);
      if (one.op === 'overlay') { const { op: _op, ...rest } = one; return w.registry.apply(rest); }
      if (one.op === 'new') {
        const pane = `pnew${++made}${seed}`;
        w.listing.panes.push({ ...paneRow('wpop', pane, 'popup'), workspace: 'els-popup' });
        return { exitCode: 0, message: JSON.stringify({ pane }) };
      }
      return undefined;
    };
    const a = await w.viewer({ request });
    const b = await w.viewer({ request, cols: 80, rows: 24 });
    w.registry.apply({ action: 'open', kind: 'term', props: {} });          // what ElsControl sends: no pane, no command
    for (let at = 0; at < 10; at++) await settle();
    const named = (termLayer(w)?.props as { pane?: string } | undefined)?.pane;
    expect(named).toMatch(/^pnew\d+$/);
    const created = requests.filter((one) => one.op === 'new').length;
    const closed = requests.filter((one) => one.op === 'close').map((one) => (one as { pane: string }).pane);
    expect(closed).not.toContain(named);
    expect(created - closed.length).toBe(1);                                 // exactly one popup shell is left running
    for (const v of [a, b]) { await v.poll(); v.app.resized(); await settle(); expect(v.attachments.some((one) => one.pane === named && !one.detached)).toBe(true); }   // each viewer lists it, then attaches
  }));
});
