// ELS-ELEMENT-HOST-FU sim (대표 11-26 «둘 다 고쳐주세요»), seeds 1..5.
// S1 · two viewers on one REAL registry wired to the REAL tab-host sync: viewer A presses ctrl+t until its Obsidian layer
//      is a tab — A (and only A) moves to the new host tab; B stays on its pane. Every frame of both viewers: emulated
//      screen = reference composite cell by cell, rows exactly as wide as the view.
// S2 · server restart: element tabs whose host panes lost their PTY (no holder survived) come back as those elements —
//      a NEW registry restored from overlays.json + restore() spawns fresh hosts, the plain shells (live or not) are the
//      same rows as before, and the restored Obsidian host draws the persisted cursor (host frame checked cell by cell).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElementHost, createTabHostSync } from '../../../els/element-host.js';
import { createOverlayRegistry } from '../../../els/overlay-registry.js';
import { createZaxisWorld, emulate, emulatorTerminal, noteName, paneRow, referenceOf, writeNotesVault, type EmuScreen, type Viewer, type ZaxisWorld } from './zaxis-overlay-world.js';

const SEEDS = [1, 2, 3, 4, 5] as const;
const CTRL_T = '\u0014';
type Row = ReturnType<typeof paneRow> & { command?: string[]; ptyId?: string };

let root = '';
let vault = '';
const worlds: ZaxisWorld[] = [];
const matrix = new Map<string, Map<number, string>>();
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'els-host-fu-sim-')); vault = writeNotesVault(join(root, 'SimVault')); });
afterAll(() => {
  for (const world of worlds) world.dispose();
  rmSync(root, { recursive: true, force: true });
  const lines = [`| case | ${SEEDS.map((s) => `seed ${s}`).join(' | ')} |`, `|---|${SEEDS.map(() => '---').join('|')}|`];
  for (const [name, row] of matrix) lines.push(`| ${name} | ${SEEDS.map((s) => row.get(s) ?? '-').join(' | ')} |`);
  console.log(`\nELEMENT-HOST-FU MATRIX\n${lines.join('\n')}`);
});
const cell = (name: string, seed: number, body: () => Promise<void>) => async (): Promise<void> => {
  const row = matrix.get(name) ?? new Map<number, string>();
  matrix.set(name, row);
  try { await body(); row.set(seed, 'PASS'); } catch (error) { row.set(seed, 'FAIL'); throw error; }
};
const settle = async (): Promise<void> => { for (let at = 0; at < 8; at++) { await Promise.resolve(); await new Promise((done) => setImmediate(done)); } };
const cellsOf = (screen: EmuScreen): string[] => screen.rows.map((row) => row.chars.map((char, x) => `${char}/${row.widths[x]}`).join('|'));
async function frameInvariants(v: Viewer): Promise<EmuScreen> {
  const seen = await v.emulated();
  expect(cellsOf(seen)).toEqual(cellsOf(await referenceOf(v.writes.at(-1)!, v.size)));
  for (const row of seen.rows) expect(row.widths.reduce((sum, w) => sum + w, 0)).toBe(v.size.cols);
  return seen;
}
const livePane = (v: Viewer): string => v.attachments.at(-1)!.pane;

describe('S1 · ctrl+t → tab: the pressing viewer moves to the new tab, the other viewer stays', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('pressing viewer follows · other stays', seed, async () => {
    const w = createZaxisWorld(seed, vault, undefined, { hostTabs: true });
    worlds.push(w);
    const a = await w.viewer();
    const b = await w.viewer({ cols: 100, rows: 28, pane: w.rand.int(0, 1) ? 'p2' : 'p1' });
    const bPane = livePane(b);
    w.openObsidian();
    await frameInvariants(a); await frameInvariants(b);
    const steps = w.rand.int(0, 6);
    for (let at = 0; at < steps; at++) { a.press('j'); await frameInvariants(a); }
    a.press(CTRL_T);                                                   // → tile
    await settle();
    expect(livePane(a)).toBe('p1');
    await frameInvariants(a); await frameInvariants(b);
    a.press(CTRL_T);                                                   // → tab: a host pane is spawned
    await settle();
    expect(w.listing.panes.map((row) => row.pane)).toEqual(['p1', 'p2', 'ph1']);
    expect((w.listing.panes[2] as Row).command?.slice(-5)).toEqual(['side', 'element', 'host', 'obsidian', 'default']);
    expect(livePane(a)).toBe('ph1');                                   // A followed its element
    expect(livePane(b)).toBe(bPane);                                   // B did not move
    expect(b.attachments).toHaveLength(1);
    await b.poll();                                                    // B's next listing poll shows the new tab, still no move
    expect(livePane(b)).toBe(bPane);
    const seenA = await frameInvariants(a);
    expect(seenA.rows[0]!.text).toContain('◫ OBSIDIAN');                // the tab row (titles are drawn upper-case)
    await frameInvariants(b);
    expect(((w.registry.stack().layers[0]!.props) as { cursor: number }).cursor).toBe(steps);
  }));
});

describe('S2 · server restart: element tabs come back as elements, plain shells unchanged', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, cell('restart restores elements · shells untouched', seed, async () => {
    const w = createZaxisWorld(seed, vault, undefined, { hostTabs: true });
    worlds.push(w);
    const kinds = ['obsidian', ...(w.rand.int(0, 1) ? ['sidechat'] : []), ...(w.rand.int(0, 1) ? ['files'] : [])];
    const cursor = w.rand.int(0, 9);
    for (const kind of kinds) {
      const id = (JSON.parse(w.registry.apply({ action: 'open', kind, props: kind === 'files' ? { dir: vault } : {} }).message) as { id: string }).id;
      if (kind === 'obsidian') w.registry.apply({ action: 'update', id, props: { dir: '', cursor, scroll: 0 } });
      expect(w.registry.apply({ action: 'frame', id, frame: 'tab' }).exitCode).toBe(0);
    }
    const listing = w.listing as { panes: Row[] };
    const hostsBefore = listing.panes.filter((row) => row.command).map((row) => row.pane);
    expect(hostsBefore).toHaveLength(kinds.length);
    // the restart: no holder survived — every pane lost its PTY (host panes and one plain shell); one shell kept its holder
    listing.panes = listing.panes.map((row) => row.command || row.pane === 'p1' ? { ...row, ptyId: '', state: 'idle' } : row);
    const shellsBefore = JSON.stringify(listing.panes.filter((row) => !row.command));
    w.registry.dispose();
    let seq = 0;
    const sync = createTabHostSync({ cwd: '/work',
      panes: () => listing.panes.map((row) => ({ id: row.pane, command: row.command, state: row.state, ptyId: row.ptyId ?? `h:${row.pane}` })),
      newPane: (input) => { const pane = `pr${++seq}`; listing.panes.push({ ...paneRow('w1', pane, input.title), command: input.command }); return { exitCode: 0, message: JSON.stringify({ pane }) }; },
      close: (pane) => { listing.panes = listing.panes.filter((row) => row.pane !== pane); } });
    const restarted = createOverlayRegistry({ dir: join(w.root, 'els'), context: () => ({ vault }), setTimer: () => 0, clearTimer: () => {}, onTabHosts: sync });
    // the stack is z-ordered (band first: sidechat's popup band sits above the float band) — hosts are restored in that order
    const order = restarted.stack().layers.map((layer) => layer.kind);
    expect([...order].sort()).toEqual([...kinds].sort());
    expect(restarted.stack().layers.every((layer) => layer.frame === 'tab')).toBe(true);
    const hosts = sync.restore(restarted.stack().layers);
    expect([...hosts.values()]).toEqual(order.map((_, at) => `pr${at + 1}`));
    expect(listing.panes.filter((row) => row.command).map((row) => `${row.pane}:${row.command!.slice(-5).join(' ')}`))
      .toEqual(order.map((kind, at) => `pr${at + 1}:side element host ${kind} default`));
    expect(listing.panes.some((row) => hostsBefore.includes(row.pane))).toBe(false);
    expect(JSON.stringify(listing.panes.filter((row) => !row.command))).toBe(shellsBefore);   // shells: same rows, same order

    // the restored Obsidian host draws the persisted state, frame checked cell by cell
    const writes: string[] = [];
    const size = { cols: 91, rows: 28 };
    const host = createElementHost({ kind: 'obsidian', key: 'default', write: (text) => { writes.push(text); }, size: () => size, act: () => {} });
    expect(host.stack(restarted.stack())).toBe(false);
    const term = emulatorTerminal(size.cols, size.rows);
    try {
      const seen = await emulate(term, writes);
      for (const row of seen.rows) expect(row.widths.reduce((sum, width) => sum + width, 0)).toBe(size.cols);
      expect(seen.rows[0]!.text).toContain('📓 SimVault · /');
      expect(writes.at(-1)!).toContain(`\u001b[7m  ${noteName(cursor)}`);
      expect(seen.rows[size.rows - 1]!.text).toContain(`${cursor + 1}/30`);
    } finally { term.dispose(); }
    restarted.dispose();
  }));
});
