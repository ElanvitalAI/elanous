// ELS-ZAXIS sim world — seeded scenarios over a REAL overlay registry and REAL attach apps (see zaxis-overlay-world.ts).
// Every seed takes a different key path; the asserted invariants are the same for all of them. Expected numbers are
// literals (80% of the area above the status line), never computed with the product's own resolveRect.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseFrame } from '../../../els/elements/element.js';
import { obsidian } from '../../../els/elements/obsidian.js';
import type { ObsidianProps } from '../../../els/elements/obsidian-view.js';
import {
  createZaxisWorld, KEY, noteLine, noteName, NOTE_COUNT, popupBody, popupBox, writeKoreanVault, writeLargeVault, writeNotesVault, type Viewer, type ZaxisWorld,
} from './zaxis-overlay-world.js';

const SEEDS = [1, 2, 3] as const;
// Tab row coordinates of overlay-attach.test (120 cols, 28-cell side list): tab row = line 1.
const TAB_ROW_Y = 1;
const P2_TAB_X = 40;
// 출처: #40244 the large-vault device — 11,000 notes against the element's MAX_ENTRIES listing bound
const LARGE_VAULT_NOTES = 11_000;

let root = '';
let notesVault = '';
let largeVault = '';
let koreanVault = '';
const worlds: ZaxisWorld[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'els-zaxis-vaults-'));
  notesVault = writeNotesVault(join(root, 'SimVault'));
  largeVault = writeLargeVault(join(root, 'BigVault'), LARGE_VAULT_NOTES);
  koreanVault = writeKoreanVault(join(root, '한글볼트'));
});
afterAll(() => {
  for (const world of worlds) world.dispose();
  rmSync(root, { recursive: true, force: true });
});

const world = (seed: number, vault = notesVault): ZaxisWorld => { const made = createZaxisWorld(seed, vault); worlds.push(made); return made; };
const layerProps = (w: ZaxisWorld): ObsidianProps => w.registry.stack().layers.find((layer) => layer.kind === 'obsidian')!.props as ObsidianProps;
const frameText = (v: Viewer): string => v.last().join('\n');
const bottomRow = (v: Viewer): string => { const lines = v.last(); return lines[popupBox(lines)!.bottom]!; };

/** Move the list cursor from `from` to `to` with j/k presses. */
const moveCursor = (v: Viewer, from: number, to: number): void => { for (let at = from; at !== to; at += to > from ? 1 : -1) v.press(to > from ? KEY.down : KEY.up); };

describe('S1 · Obsidian popup over panes: list → note → scroll → back → Esc → tab click', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer();
    expect(frameText(v)).not.toContain('📓');
    const id = w.openObsidian();
    let lines = v.last();
    expect(lines).toHaveLength(30);
    expect(popupBox(lines)).toEqual({ top: 3, bottom: 25, x: 12, w: 96 });   // 80% of 120x29, centered
    expect(lines[3]).toContain('📓 SimVault · /');
    expect(popupBody(lines)[0]).toBe(`  ${noteName(0)}`);
    // Seeded scroll path over the note list; the test keeps its own model of the cursor.
    let cursor = 0;
    const steps = w.rand.int(3, 12);
    for (let at = 0; at < steps; at++) {
      const down = w.rand.next() < 0.7;
      v.press(down ? KEY.down : KEY.up);
      cursor = Math.max(0, Math.min(NOTE_COUNT - 1, cursor + (down ? 1 : -1)));
      expect(layerProps(w).cursor).toBe(cursor);
    }
    expect(bottomRow(v)).toContain(`${cursor + 1}/${NOTE_COUNT}`);
    const target = w.rand.int(0, NOTE_COUNT - 1);
    moveCursor(v, cursor, target);
    v.press(KEY.enter);
    expect(layerProps(w).note).toBe(`${noteName(target)}.md`);
    lines = v.last();
    expect(lines[3]).toContain(`📓 SimVault · ${noteName(target)}.md`);
    expect(popupBody(lines)[0]).toBe(noteName(target));                     // the heading row
    const lineSteps = w.rand.int(1, 8);
    for (let at = 0; at < lineSteps; at++) v.press(KEY.down);
    v.press(KEY.space);                                                      // a page is 10 rows
    expect(layerProps(w).scroll).toBe(lineSteps + 10);
    expect(popupBody(v.last())[0]).toBe(noteLine(target, lineSteps + 10));
    expect(bottomRow(v)).toContain(`${lineSteps + 10 + 21}/61`);             // 21 body rows of 61 (the note's trailing blank row is no longer rendered)
    v.press(KEY.back);
    expect(layerProps(w).note).toBeUndefined();
    expect(layerProps(w).cursor).toBe(target);
    expect(bottomRow(v)).toContain(`${target + 1}/${NOTE_COUNT}`);
    v.press(KEY.esc);
    expect(w.registry.stack().layers).toEqual([]);
    expect(v.acts.at(-1)).toEqual({ action: 'close', id });
    expect(frameText(v)).not.toContain('📓');
    expect(v.attachments[0]!.typed).toEqual([]);                             // no popup key leaked into the pane
    v.clickAt(P2_TAB_X, TAB_ROW_Y);
    expect(v.attachments.at(-1)!.pane).toBe('p2');
  });
});

describe('S2 · the same popup over the tile grid: keys and Esc go to the layer before tile Esc-levels', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer({ tile: {} });
    expect(frameText(v)).toContain('TILE');
    w.openObsidian();
    const lines = v.last();
    expect(popupBox(lines)).toEqual({ top: 3, bottom: 25, x: 12, w: 96 });
    const steps = w.rand.int(1, 6);
    for (let at = 0; at < steps; at++) v.press(KEY.down);
    expect(layerProps(w).cursor).toBe(steps);                                // j moved the list, not the tile focus
    v.press(KEY.esc);
    expect(w.registry.stack().layers).toEqual([]);
    expect(frameText(v)).not.toContain('📓');
    expect(frameText(v)).not.toContain('SPACES');                            // the first Esc was the layer's
    v.press(KEY.esc);
    expect(frameText(v)).toContain('SPACES');                                // the next one is tile's: space → spaces
  });
});

describe('S3 · narrow 80x24: the popup resolves inside and leaves the status line; chooseFrame by width', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer({ cols: 80, rows: 24 });
    const statusBefore = v.last()[23];
    w.openObsidian();
    const lines = v.last();
    expect(lines).toHaveLength(24);
    expect(popupBox(lines)).toEqual({ top: 2, bottom: 19, x: 8, w: 64 });    // 80% of 80x23
    expect(lines[23]).toBe(statusBefore!);
    expect(lines[23]).not.toContain('│');
    const pages = w.rand.int(1, 3);
    for (let at = 0; at < pages; at++) v.press(KEY.space);
    expect(layerProps(w).cursor).toBe(Math.min(NOTE_COUNT - 1, pages * 10));
    expect(v.last()[23]).toBe(statusBefore!);
    expect(chooseFrame(obsidian, { cols: 80, rows: 24 })).toBe('popup');
    expect(chooseFrame(obsidian, { cols: 50, rows: 24 })).toBe('tab');
    // ELS-ELEMENT-HOST: obsidian has a tile frame now — at 200 cols the size rule picks it.
    expect(chooseFrame(obsidian, { cols: 200, rows: 60 })).toBe('tile');
    expect(chooseFrame({ frames: ['popup', 'tile', 'tab'] }, { cols: 200, rows: 60 })).toBe('tile');
  });
});

describe('S4 · synthetic events', () => {
  for (const seed of SEEDS) test(`resize mid-popup re-resolves the rect · seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer();
    w.openObsidian();
    expect(popupBox(v.last())).toEqual({ top: 3, bottom: 25, x: 12, w: 96 });
    const sizes = w.rand.int(0, 99) % 2 === 0 ? (['narrow', 'wide'] as const) : (['wide', 'narrow'] as const);
    for (const one of sizes) {
      if (one === 'narrow') { v.size.cols = 80; v.size.rows = 24; } else { v.size.cols = 200; v.size.rows = 60; }
      v.app.resized();
      const lines = v.last();
      expect(lines).toHaveLength(v.size.rows);
      expect(popupBox(lines)).toEqual(one === 'narrow' ? { top: 2, bottom: 19, x: 8, w: 64 } : { top: 6, bottom: 52, x: 20, w: 160 });
    }
    expect(w.registry.stack().layers).toHaveLength(1);                       // a resize is a client affair
  });

  for (const seed of SEEDS) test(`a second viewer sees the same layer; Esc in B closes it for A · seed ${seed}`, async () => {
    const w = world(seed);
    const a = await w.viewer();
    const b = await w.viewer({ pane: 'p2' });
    w.openObsidian();
    expect(frameText(a)).toContain('📓 SimVault');
    expect(frameText(b)).toContain('📓 SimVault');
    const steps = w.rand.int(1, 9);
    for (let at = 0; at < steps; at++) (at % 2 === 0 ? b : a).press(KEY.down);
    expect(layerProps(w).cursor).toBe(steps);
    expect(bottomRow(a)).toContain(`${steps + 1}/${NOTE_COUNT}`);
    expect(bottomRow(b)).toContain(`${steps + 1}/${NOTE_COUNT}`);
    b.press(KEY.esc);
    expect(w.registry.stack().layers).toEqual([]);
    expect(frameText(a)).not.toContain('📓');
    expect(frameText(b)).not.toContain('📓');
    a.press('x');                                                            // A's keys reach its pane again
    expect(a.attachments.at(-1)!.typed).toEqual(['x']);
  });

  for (const seed of SEEDS) test(`a pane exits under the popup: the popup stays, clicks still route · seed ${seed}`, async () => {
    const w = world(seed);
    w.listing.panes.push({ address: 'w1/t-p3/p3', workspace: 'name-w1', pane: 'p3', title: 'three', state: 'idle', tab: 't-p3' });
    const v = await w.viewer();
    const id = w.openObsidian();
    w.listing.panes.splice(2, 1);
    await v.poll();
    expect(frameText(v)).toContain('📓 SimVault');
    expect(w.registry.stack().layers).toHaveLength(1);
    const inside = { x: w.rand.int(14, 106), y: w.rand.int(5, 25) };         // 1-based SGR cell inside the 96x23 box at (12,3)
    v.clickAt(inside.x, inside.y);
    expect(v.acts.slice(-2)).toEqual([{ action: 'raise', id }, { action: 'focus', id }]);
    v.press(KEY.down);
    expect(layerProps(w).cursor).toBe(1);
    v.clickAt(P2_TAB_X, TAB_ROW_Y);                                          // the tab row is outside the box
    expect(v.attachments.at(-1)!.pane).toBe('p2');
    expect(v.attachments.every((one) => one.typed.length === 0)).toBe(true);
  });

  for (const seed of SEEDS) test(`rapid open/close: the stack ends empty, no timer leaks · seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer();
    const cycles = 50 + w.rand.int(0, 10);
    let lastRev = w.registry.stack().rev;
    for (let at = 0; at < cycles; at++) {
      const pick = w.rand.int(0, 2);
      if (pick === 0) {                                                     // obsidian: open, Esc from the keyboard
        w.openObsidian({ cursor: w.rand.int(0, 5) });
        expect(frameText(v)).toContain('📓');
        v.press(KEY.esc);
      } else {                                                              // toast (ttl timer): closed by the server or expired
        const opened = w.registry.apply({ action: 'open', kind: 'toast', props: { text: `cycle ${at}` } });
        expect(opened.exitCode).toBe(0);
        expect(w.timers.active()).toBe(1);
        if (pick === 1) w.registry.apply({ action: 'close', id: (JSON.parse(opened.message) as { id: string }).id });
        else w.timers.advance(5_000);
      }
      expect(w.registry.stack().layers).toEqual([]);
      expect(w.registry.stack().rev).toBeGreaterThan(lastRev);
      lastRev = w.registry.stack().rev;
    }
    expect(w.timers.active()).toBe(0);
    expect(frameText(v)).not.toContain('📓');
    expect(frameText(v)).not.toContain('cycle');
    expect(v.attachments[0]!.typed).toEqual([]);
  });

  for (const seed of SEEDS) test(`a large vault (11,000 notes) lists 500 and stays bounded · seed ${seed}`, async () => {
    const w = world(seed, largeVault);
    const v = await w.viewer();
    w.openObsidian();
    expect(layerProps(w).entries).toHaveLength(500);
    expect(v.last()).toHaveLength(30);
    expect(bottomRow(v)).toContain('1/500');
    const pages = w.rand.int(1, 4);
    for (let at = 0; at < pages; at++) v.press(KEY.space);
    expect(layerProps(w).cursor).toBe(pages * 10);
    expect(popupBody(v.last())).toHaveLength(21);
    v.press('G');
    expect(layerProps(w).cursor).toBe(499);
    expect(bottomRow(v)).toContain('500/500');
    expect(popupBody(v.last()).at(-1)).toBe('  n00499');
  });

  for (const seed of SEEDS) test(`Korean names list, open and render · seed ${seed}`, async () => {
    const w = world(seed, koreanVault);
    const v = await w.viewer();
    w.openObsidian();
    expect(v.last()[3]).toContain('📓 한글볼트 · /');
    expect(popupBody(v.last()).slice(0, 2)).toEqual(['▸ 프로젝트/', '  가나다']);   // folders first
    const visit = (which: 'folder' | 'note'): void => {
      if (which === 'folder') {
        moveCursor(v, layerProps(w).cursor, 0);
        v.press(KEY.enter);
        expect(layerProps(w).dir).toBe('프로젝트');
        expect(popupBody(v.last())[0]).toBe('  계획');
        v.press(KEY.enter);
        expect(layerProps(w).note).toBe('프로젝트/계획.md');
        expect(v.last()[3]).toContain('📓 한글볼트 · 프로젝트/계획.md');
        expect(popupBody(v.last()).slice(0, 4)).toEqual(['계획', '', '• 하나', '• 둘']);
        v.press(KEY.back, KEY.back);
        expect(layerProps(w).dir).toBe('');
      } else {
        moveCursor(v, layerProps(w).cursor, 1);
        v.press(KEY.enter);
        expect(layerProps(w).note).toBe('가나다.md');
        expect(popupBody(v.last()).slice(0, 3)).toEqual(['가나다 노트', '', '첫째 줄 한글 본문']);
        v.press(KEY.back);
      }
      // wide glyphs never shift the frame: every row is exactly the terminal width
      for (const line of v.last().slice(0, 29)) expect(Bun.stringWidth(line)).toBe(120);
    };
    const order = w.rand.int(0, 99) % 2 === 0 ? (['folder', 'note'] as const) : (['note', 'folder'] as const);
    for (const one of order) visit(one);
    v.press(KEY.esc);
    expect(w.registry.stack().layers).toEqual([]);
  });
});
