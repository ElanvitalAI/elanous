// ELS-FILES sim — the file browser element over els, seeds 1..5, read from what the person SEES: the real overlay registry
// (hydrate reads a real temp tree), real attach apps, every composed frame through the real frame writer into an
// @xterm/headless terminal, checked cell by cell against the reference composite and a pane-only twin. Expected boxes are
// literals (86% × 82% of the area above the status line, centered), never computed with the product's resolveRect.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElsRequest } from '../../../els/server.js';
import type { ElsResult } from '../../../els/core.js';
import { createZaxisWorld, fromCell, prng, referenceOf, writeNotesVault, type EmuScreen, type Viewer, type ViewerOpts, type ZaxisWorld } from './zaxis-overlay-world.js';

const SEEDS = [1, 2, 3, 4, 5] as const;
const ESC = '\u001b';
// files box per terminal size: top row, bottom row, left cell, width (86% x 82% of cols x rows-1, centered)
const BOX: Readonly<Record<string, { top: number; bottom: number; x: number; w: number }>> = {
  '120x30': { top: 2, bottom: 25, x: 8, w: 103 },
  '80x24': { top: 2, bottom: 20, x: 5, w: 69 },
  '180x56': { top: 5, bottom: 49, x: 12, w: 155 },
  '200x60': { top: 5, bottom: 52, x: 14, w: 172 },
};
// 출처: ELS-FILES sim device — 40 files is more than one page at 80x24 (17 body rows), 3000 is past the 2000-entry cap
const MANY = 40;
const HUGE = 3_000;

let root = '';
let tree = '';
let vault = '';
const worlds: ZaxisWorld[] = [];
const matrix = new Map<string, Map<number, string>>();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'els-files-sim-'));
  vault = writeNotesVault(join(root, 'SimVault'));
  tree = join(root, 'tree');
  mkdirSync(join(tree, '프로젝트'), { recursive: true });
  mkdirSync(join(tree, 'huge'));
  mkdirSync(join(tree, 'locked'));
  for (let at = 0; at < MANY; at++) writeFileSync(join(tree, `file-${String(at).padStart(2, '0')}.txt`), `contents of file ${at}\n`);
  for (let at = 0; at < HUGE; at++) writeFileSync(join(tree, 'huge', `h${String(at).padStart(4, '0')}`), '');
  writeFileSync(join(tree, 'README.md'), '# Sim Readme\n\nHello **files**.\n');
  writeFileSync(join(tree, '프로젝트', '계획 문서.md'), '# 계획\n\n- 하나 😀\n- 둘\n');
  writeFileSync(join(tree, '.hidden-note'), 'dot\n');
  chmodSync(join(tree, 'locked'), 0o000);
});
afterAll(() => {
  for (const world of worlds) world.dispose();
  chmodSync(join(tree, 'locked'), 0o755);
  rmSync(root, { recursive: true, force: true });
  const lines = [`| case | ${SEEDS.map((s) => `seed ${s}`).join(' | ')} |`, `|---|${SEEDS.map(() => '---').join('|')}|`];
  for (const [name, row] of matrix) lines.push(`| ${name} | ${SEEDS.map((s) => row.get(s) ?? '-').join(' | ')} |`);
  console.log(`\nELS-FILES MATRIX\n${lines.join('\n')}`);
});

const cell = (name: string, seed: number, body: () => Promise<void>) => async (): Promise<void> => {
  const row = matrix.get(name) ?? new Map<number, string>();
  matrix.set(name, row);
  try { await body(); row.set(seed, 'PASS'); } catch (error) { row.set(seed, 'FAIL'); throw error; }
};

interface FilesWorld { w: ZaxisWorld; requests: ElsRequest[]; viewer: (opts?: ViewerOpts) => Promise<Viewer> }
function filesWorld(seed: number): FilesWorld {
  const w = createZaxisWorld(seed, vault);
  worlds.push(w);
  w.listing.panes = w.listing.panes.map((row) => ({ ...row, cwd: tree }));
  const requests: ElsRequest[] = [];
  let made = 0;
  const request = (one: ElsRequest): ElsResult | undefined => {
    requests.push(one);
    if (one.op === 'overlay') { const { op: _op, ...rest } = one; return w.registry.apply(rest); }
    if (one.op === 'new') { const pane = `pn${++made}`; w.listing.panes.push({ ...w.listing.panes[0]!, pane, address: `w1/t-${pane}/${pane}`, tab: `t-${pane}`, title: one.title ?? pane }); return { exitCode: 0, message: JSON.stringify({ pane }) }; }
    return undefined;
  };
  return { w, requests, viewer: (opts = {}) => w.viewer({ ...opts, request }) };
}

const cellsOf = (screen: EmuScreen): string[] => screen.rows.map((row) => row.chars.map((char, x) => `${char}/${row.widths[x]}`).join('|'));
async function expectMatchesReference(v: Viewer): Promise<EmuScreen> {
  const seen = await v.emulated();
  const reference = await referenceOf(v.writes.at(-1)!, v.size);
  expect(cellsOf(seen)).toEqual(cellsOf(reference));
  return seen;
}
function expectExactWidth(seen: EmuScreen, cols: number): void {
  for (const row of seen.rows) { expect(row.widths.reduce((sum, w) => sum + w, 0)).toBe(cols); expect(row.widths[cols - 1]).not.toBe(2); }
}
/** The files box as drawn (plain frame lines). */
function filesBox(lines: readonly string[]): { top: number; bottom: number; x: number; w: number } | undefined {
  const top = lines.findIndex((line) => line.includes('┌ 📁'));
  if (top < 0) return undefined;
  const at = lines[top]!.indexOf('┌ 📁');
  const x = Bun.stringWidth(lines[top]!.slice(0, at));
  let bottom = top + 1;
  while (bottom < lines.length && !fromCell(lines[bottom]!, x).startsWith('└')) bottom++;
  // width from the bottom edge (a toast in the top-right corner may cover the top-right ┐)
  const edge = fromCell(lines[bottom] ?? '', x);
  const w = Bun.stringWidth(edge.slice(0, edge.indexOf('┘') + 1));
  return { top, bottom, x, w };
}
const filesLayer = (w: ZaxisWorld) => w.registry.stack().layers.find((one) => one.kind === 'files');
const filesProps = (w: ZaxisWorld) => filesLayer(w)?.props as { dir: string; cursor: number; entries: { name: string; dir: boolean }[]; total: number; error?: string; filter: string } | undefined;
const selected = (w: ZaxisWorld): string | undefined => { const p = filesProps(w); return p?.entries[p.cursor]?.name; };
const KOREAN = ['가나다라마바사', '😀 이모지 줄', '한글 출력 🚀 빠름', '빌드 진행중 ✅'];
const screenOf = (lines: readonly string[]): string => `[screen 91x28 cursor=(row 0, col 0, visible true)]\n${lines.join('\n')}`;

// ---- F1 · overlap with other popups ---------------------------------------------------------------------------------------
describe('F1 · files over Obsidian with a toast on top: z order, focus stack, Esc falls back', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('F1 overlap: z order · focus falls back on Esc', seed, async () => {
    const { w, viewer } = filesWorld(seed);
    const v = await viewer();
    w.openObsidian();
    v.press('\u0002f');                                                  // ctrl+b f: files over the Obsidian float
    expect(filesProps(w)?.dir).toBe(tree);
    w.registry.apply({ action: 'open', kind: 'toast', props: { text: `seed ${seed} 토스트`, level: 'info' } });
    const seen = await expectMatchesReference(v);
    expectExactWidth(seen, 120);
    expect(filesBox(v.last())).toEqual(BOX['120x30']);
    expect(seen.rows[BOX['120x30']!.top]!.chars[BOX['120x30']!.x]).toBe('┌');
    expect(seen.rows.map((row) => row.text).join('\n')).toContain(`seed ${seed} 토스트`);
    const steps = w.rand.int(1, 6);
    for (let at = 0; at < steps; at++) v.press('j');
    expect(filesProps(w)?.cursor).toBe(steps);
    const obsBefore = (w.registry.stack().layers.find((one) => one.kind === 'obsidian')!.props as { cursor: number }).cursor;
    expect(obsBefore).toBe(0);
    v.press(ESC);                                                        // files closes; Obsidian has the keys again
    expect(filesLayer(w)).toBeUndefined();
    v.press('j');
    expect((w.registry.stack().layers.find((one) => one.kind === 'obsidian')!.props as { cursor: number }).cursor).toBe(1);
    await expectMatchesReference(v);
    expect(v.attachments.every((one) => one.typed.length === 0)).toBe(true);
  }));
});

// ---- F2 · resize -----------------------------------------------------------------------------------------------------------
describe('F2 · resize while open: the box re-resolves, rows stay exact, keys still drive it', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('F2 resize: literal boxes · exact width · cursor kept', seed, async () => {
    const { w, viewer } = filesWorld(seed);
    const v = await viewer();
    v.press('\u0002f');
    const sizes = ['120x30', '80x24', '180x56', '200x60'];
    let cursor = 0;
    for (let at = 0; at < 10; at++) {
      const pick = sizes[w.rand.int(0, sizes.length - 1)]!;
      const [cols, rows] = pick.split('x').map(Number) as [number, number];
      v.size.cols = cols; v.size.rows = rows; v.app.resized();
      expect(filesBox(v.last())).toEqual(BOX[pick]);
      expect(v.last()).toHaveLength(rows);
      const seen = await expectMatchesReference(v);
      expectExactWidth(seen, cols);
      v.press('j'); cursor++;
      expect(filesProps(w)?.cursor).toBe(cursor);
      expect(v.last().join('\n')).toContain(selected(w)!.replace(/\.txt$/, ''));
    }
  }));
});

// ---- F3 · two viewers ------------------------------------------------------------------------------------------------------
describe('F3 · two viewers of different sizes see the same browser state', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('F3 two viewers: one state · both exact', seed, async () => {
    const { w, viewer } = filesWorld(seed);
    const a = await viewer();
    const b = await viewer({ cols: 80, rows: 24 });
    a.press('\u0002f');
    const moves = w.rand.int(2, 12);
    for (let at = 0; at < moves; at++) a.press('j');
    if (w.rand.int(0, 1)) { b.press('\r'); }                              // B goes into the selected entry (a folder or a file)
    const pick = selected(w);
    for (const v of [a, b]) {
      const seen = await expectMatchesReference(v);
      expectExactWidth(seen, v.size.cols);
      if (filesLayer(w)) expect(filesBox(v.last())).toEqual(BOX[`${v.size.cols}x${v.size.rows}`]);
    }
    if (filesLayer(w) && pick) for (const v of [a, b]) expect(v.last().join('\n')).toContain(pick.slice(0, 12));
    expect([a, b].every((v) => v.attachments.every((one) => one.typed.length === 0))).toBe(true);
  }));
});

// ---- F4 · fast pane output underneath --------------------------------------------------------------------------------------
describe('F4 · hundreds of Korean/emoji pane frames under the open browser', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('F4 fast output: border intact · outside = pane only', seed, async () => {
    const { w, viewer } = filesWorld(seed);
    const v = await viewer();
    const twin = await w.viewer({ source: 'none' });
    v.press('\u0002f');
    const rand = prng(seed * 7);
    const frames = 150 + rand.int(0, 100);
    const box = BOX['120x30']!;
    for (let at = 0; at < frames; at++) {
      const lines = Array.from({ length: 28 }, (_, row) => `${at}:${row} ${KOREAN[rand.int(0, KOREAN.length - 1)]}`);
      v.paneFrame(screenOf(lines));
      twin.paneFrame(screenOf(lines));
      if (at % 10 === 0) v.press(rand.int(0, 1) ? 'j' : 'k');
      const seen = await v.emulated();
      expect(seen.rows[box.top]!.chars[box.x]).toBe('┌');
      expect(seen.rows[box.top]!.chars[box.x + box.w - 1]).toBe('┐');
      expect(seen.rows[box.bottom]!.chars[box.x]).toBe('└');
      if (at % 30 === 0) {
        const paneOnly = await twin.emulated();
        for (let y = 0; y < seen.rows.length - 1; y++) for (let x = 0; x < 120; x++) {
          if (y >= box.top && y <= box.bottom && x >= box.x - 1 && x <= box.x + box.w) continue;
          expect(seen.rows[y]!.chars[x]).toBe(paneOnly.rows[y]!.chars[x]!);
        }
        const reference = await referenceOf(v.writes.at(-1)!, v.size);
        expect(cellsOf(seen)).toEqual(cellsOf(reference));
      }
    }
    expect(v.attachments[0]!.typed).toEqual([]);
  }));
});

// ---- F5 · seeded navigation walk: Korean names, huge folder, permission denied, hidden, filter -----------------------------
describe('F5 · a seeded key walk never breaks the frame and always shows the selected entry', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('F5 walk: Korean · huge cap · denied · filter', seed, async () => {
    const { w, viewer } = filesWorld(seed);
    const v = await viewer({ cols: 180, rows: 56 });
    v.press('\u0002f');
    const keys = ['j', 'j', 'k', 'l', '\u007f', '.', 'G', 'g', 'J', ' '];             // l: into a folder (a file stays put)
    for (let at = 0; at < 40; at++) {
      v.press(keys[w.rand.int(0, keys.length - 1)]!);
      if (!filesLayer(w)) v.press('\u0002f');                            // a file Enter opened a tab and closed the popup
      const p = filesProps(w)!;
      expect(p.cursor).toBeLessThanOrEqual(Math.max(0, p.entries.length - 1));
      const seen = await expectMatchesReference(v);
      expectExactWidth(seen, 180);
      if (p.entries.length) expect(v.last().join('\n')).toContain(p.entries[p.cursor]!.name.slice(0, 10));
    }
    // fixed visits: the Korean folder, the huge folder (cap), the locked folder (denied), a filter
    const visit = (name: string): void => { w.registry.apply({ action: 'update', id: filesLayer(w)!.id, props: { dir: tree, cursor: filesProps(w)!.entries.findIndex((e) => e.name === name) } }); };
    w.registry.apply({ action: 'update', id: filesLayer(w)!.id, props: { dir: tree } });
    visit('프로젝트'); v.press('\r');
    expect(filesProps(w)!.dir).toBe(join(tree, '프로젝트'));
    expect(v.last().join('\n')).toContain('계획 문서.md');
    expectExactWidth(await expectMatchesReference(v), 180);
    v.press('\u007f'); visit('huge'); v.press('\r');
    expect(filesProps(w)!.entries).toHaveLength(2_000);
    expect(filesProps(w)!.total).toBe(HUGE);
    expect(v.last().join('\n')).toContain('1/3000 (first 2000)');
    v.press('\u007f'); visit('locked'); v.press('\r');
    if (process.getuid?.() !== 0) { expect(filesProps(w)!.error).toBe(`${join(tree, 'locked')}: permission denied`); const box = filesBox(v.last())!; const listCol = v.last().slice(box.top + 1, box.bottom).map((line) => fromCell(line, box.x + 1).split('│')[0]!.trim()).join(''); expect(listCol).toContain('permission denied'.slice(0, 4)); expect(listCol.replace(/\s/g, '')).toContain('permissiondenied'); }
    v.press('\u007f');
    v.press('/', 'f', 'i', 'l', 'e', '-', '1');
    expect(filesProps(w)!.entries.map((e) => e.name)).toEqual(Array.from({ length: 10 }, (_, at) => `file-1${at}.txt`));
    v.press('\r');
    expect(v.attachments.every((one) => one.typed.length === 0)).toBe(true);
  }));
});

// ---- F6 · open elsewhere ---------------------------------------------------------------------------------------------------
describe('F6 · Enter opens a pager tab (argv), t a tile, a types the path into the pane, s hands it to sidechat', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('F6 open: tab argv · tile · eln attach typed not sent · sidechat', seed, async () => {
    const { w, requests, viewer } = filesWorld(seed);
    const v = await viewer();
    const pickFile = (): string => {
      const n = w.rand.int(0, MANY - 1);
      const name = `file-${String(n).padStart(2, '0')}.txt`;
      w.registry.apply({ action: 'update', id: filesLayer(w)!.id, props: { dir: tree, cursor: filesProps(w)!.entries.findIndex((e) => e.name === name) } });
      return name;
    };
    v.press('\u0002f');
    let name = pickFile();
    v.press('\r');
    await new Promise((done) => setImmediate(done));
    expect(filesLayer(w)).toBeUndefined();
    expect(requests.find((one) => one.op === 'new')).toMatchObject({ op: 'new', command: ['less', '-R', join(tree, name)], title: `📄 ${name}` });
    v.press('\u0002f');
    name = pickFile();
    v.press('a');
    await new Promise((done) => setImmediate(done));
    const typed = v.attachments.at(-1)!.typed.join('');
    expect(typed).toBe(`\u001b[200~${join(tree, name)} \u001b[201~`);
    expect(typed).not.toContain('\r');
    v.press('\u0002f');
    name = pickFile();
    v.press('s');
    await new Promise((done) => setImmediate(done));
    expect(requests.filter((one) => one.op === 'overlay' && one.action === 'open').at(-1)).toMatchObject({ kind: 'sidechat', props: { edit: { kind: 'type', text: `[file ${join(tree, name)}] contents of file ${Number(name.slice(5, 7))}` } } });
    w.registry.apply({ action: 'close', kind: 'sidechat' });
    v.press('\u0002f');
    pickFile();
    v.press('t');
    for (let at = 0; at < 5; at++) await new Promise((done) => setImmediate(done));
    expect(requests.filter((one) => one.op === 'new')).toHaveLength(2);
  }));
});
