// ELS-TILE-MODE: core matrix (1/4/9/12 panes × 200×80 · 160×50 × seeds 3), literal width/border checks, stage feed,
// and the app loop (tile → zoom → type → back, pane exit, CJK output). Expectations are literals, never the renderer's own constants.
import { expect, test } from 'bun:test';
import type { AttachHandlers, Attached } from './attach-client.js';
import { createAttachApp } from './attach-app.js';
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';
import { assignSlots, captionRows, foldRows, modelOf, parseStageFeed, spaceTile, stageHeader, stageLane, stageRibbon, tileFrameRows, tileGrid, tileLayout, moveFocus, type TileInput } from './tile-view.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;:?]*[A-Za-z]/g, '');
const cells = (text: string): number => Bun.stringWidth(plain(text));

/** Deterministic PRNG (mulberry32) so every seed reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const SAMPLES = ['hello world', '한국어 출력 줄 넓은 글자', '🟢 done ✅ emoji 🌐', '\u001b[31mred\u001b[0m plain', '日本語テキスト混在 mixed', 'x'.repeat(300), '가'.repeat(150), ''];
function screenOf(next: () => number, lines: number): string {
  return `[screen 80x24 cursor=0,0]\n${Array.from({ length: lines }, () => SAMPLES[Math.floor(next() * SAMPLES.length)]).join('\n')}`;
}
function tilesOf(n: number, seed: number): TileInput[] {
  const next = rng(seed);
  const states = ['working', 'idle', 'blocked', 'exited'];
  return Array.from({ length: n }, (_, i) => {
    const state = states[Math.floor(next() * states.length)]!;
    const roll = next();
    return { pane: `p${i}`, title: i % 3 === 0 ? `분석가-${i} 탭` : `tab-${i}`, state, tag: i % 2 ? 'OP' : '🌐 seat',
      ...(state === 'exited' ? { closed: true } : roll < 0.15 ? {} : { screen: screenOf(next, 5 + Math.floor(next() * 60)) }) };
  });
}

test('auto grid: 1→1×1, 2→2×1, 4→2×2, 9→3×3, 12→4×3 at 200×80; 160×50 keeps 3×3 for 9', () => {
  expect([1, 2, 4, 5, 9, 12, 15].map((n) => tileGrid(n, 'auto', 200, 80))).toEqual([{ c: 1, r: 1 }, { c: 2, r: 1 }, { c: 2, r: 2 }, { c: 3, r: 2 }, { c: 3, r: 3 }, { c: 4, r: 3 }, { c: 4, r: 3 }]);
  expect(tileGrid(9, 'auto', 160, 50)).toEqual({ c: 3, r: 3 });
  expect(tileGrid(3, '2x2', 200, 80)).toEqual({ c: 2, r: 2 });
});

test('focus moves within the grid and never leaves it', () => {
  expect(moveFocus(0, 'left', 9, 3)).toBe(0);
  expect(moveFocus(0, 'right', 9, 3)).toBe(1);
  expect(moveFocus(2, 'right', 9, 3)).toBe(2);
  expect(moveFocus(1, 'down', 9, 3)).toBe(4);
  expect(moveFocus(7, 'down', 9, 3)).toBe(7);
  expect(moveFocus(4, 'right', 5, 3)).toBe(4);
  expect(moveFocus(3, 'up', 9, 3)).toBe(0);
});

for (const [cols, rows] of [[200, 80], [160, 50]] as const) {
  for (const n of [1, 4, 9, 12, 15]) {
    for (const seed of [1, 2, 3]) {
      test(`matrix ${cols}×${rows} · ${n} panes · seed ${seed}: every row is exactly ${cols} cells, ${rows} rows, borders align`, () => {
        const tiles = tilesOf(n, seed);
        const out = tileFrameRows({ cols, rows, tiles, focus: seed % Math.max(1, n) });
        expect(out.length).toBe(rows);
        for (const line of out) expect(cells(line)).toBe(cols);
        // Borders: the column of every vertical border is the same on every body row of one grid row.
        const { c } = tileGrid(Math.min(n, 12), 'auto', cols, rows);
        const width = Math.ceil(cols / c);   // the remainder cells go to the left columns
        const top = [...plain(out[0]!)];
        expect(top[0] === '┌' || top[0] === '┏').toBe(true);
        const edges = (line: string): number[] => {
          const at: number[] = []; let col = 0;
          for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(plain(line))) {
            if ('│┃'.includes(segment)) at.push(col);
            col += Bun.stringWidth(segment);
          }
          return at;
        };
        const firstBody = edges(out[1]!);
        expect(firstBody[0]).toBe(0);
        expect(firstBody).toContain(width - 1);
        for (let line = 2; line < 6; line++) expect(edges(out[line]!)).toEqual(firstBody);
        if (n > 12) expect(plain(out.at(-1)!)).toContain(" ◧ 1/2 ");                  // ① paging replaces «+N more»
      });
    }
  }
}

test('a closed pane says «closed», a pane with no screen says «waiting», remote without screen is title-only with 🌐', () => {
  const out = tileFrameRows({ cols: 120, rows: 20, focus: 0, tiles: [
    { pane: 'a', title: 'gone', state: 'exited', closed: true }, { pane: 'b', title: 'new', state: 'idle' },
    { pane: 'c', title: 'far', state: 'working', remote: true }] }).map(plain).join('\n');
  expect(out).toContain('closed');
  expect(out).toContain('waiting');
  expect(out).toContain('🌐');
  expect(out).toContain('remote · title only');
});

test('a tile shows the bottom of the screen and clips wide CJK at the edge without overflow', () => {
  const screen = `[screen 80x24 cursor=0,0]\n${Array.from({ length: 40 }, (_, i) => `line-${i} ${'한'.repeat(40)}`).join('\n')}\n\n`;
  const out = tileFrameRows({ cols: 41, rows: 8, focus: 0, tiles: [{ pane: 'a', title: '탭', state: 'working', screen }] });
  const text = out.map(plain);
  expect(text[0]).toBe('┏ 🟢 탭 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
  expect(text[1]).toBe('┃line-35 한한한한한한한한한한한한한한한 ┃');
  expect(text[5]).toBe('┃line-39 한한한한한한한한한한한한한한한 ┃');
  for (const line of out) expect(cells(line)).toBe(41);
});

test('stage: ribbon, lane, receipt and verdict solo keep every row at the terminal width', () => {
  const feed = parseStageFeed(`garbage\n{"phase":"vote","nodes":["gather","debate","vote","verdict"],"evidence":5,"votes":[{"vote":"buy"},{"vote":"sell"},{"vote":"hold"}],"consensus":{"label":"BUY","value":0.72},"receipt":"receipt ✅ 9 analysts · 한국어 영수"}\n{"phase":`);
  expect(feed?.phase).toBe('vote');
  expect(plain(stageRibbon(feed))).toBe(' ◆ conductor  ● gather ─ ● debate ─ ● vote ─ ○ verdict');
  for (const tick of [0, 3, 7, 20]) {
    const lane = stageLane(feed, tick, [tick, tick - 2, tick - 4].map((a) => Math.max(0, a)), 200);
    expect(cells(lane)).toBe(200);
    expect(plain(lane)).toContain('72% BUY');
  }
  expect(plain(stageLane(feed, 9, [9, 9, 9], 200))).toContain('3/3 votes');
  const tiles = tilesOf(9, 4);
  const base = { cols: 200, rows: 80, tiles, focus: 0 };
  const grid = tileFrameRows({ ...base, stage: { ribbon: stageRibbon(feed), lane: stageLane(feed, 1, [1, 0, 0], 200), receipt: feed!.receipt!, fresh: new Set(['p3']), pulse: true } });
  expect(grid.length).toBe(80);
  for (const line of grid) expect(cells(line)).toBe(200);
  expect(plain(grid.at(-2)!)).toContain('receipt ✅ 9 analysts');
  const solo = tileFrameRows({ ...base, stage: { solo: 'p5', ribbon: '' } });
  expect(plain(solo[1]!)).toContain('tab-5');
  expect(solo.filter((line) => plain(line).includes('┓')).length).toBe(1);   // one tile only
  for (const line of solo) expect(cells(line)).toBe(200);
});

function harness(listing: () => string, size: { cols: number; rows: number }, tile: Parameters<typeof createAttachApp>[0]['tile']) {
  const typed: string[] = [];
  const writes: string[] = [];
  const timers: (() => void)[] = [];
  const screens = new Map<string, string>();
  const attachments: string[] = [];
  const app = createAttachApp({
    request: async (request: ElsRequest): Promise<ElsResult> => {
      if (request.op === 'ls') return { exitCode: 0, message: listing() };
      if (request.op === 'tile-frame') return screens.has(request.pane) ? { exitCode: 0, message: screens.get(request.pane)! } : { exitCode: 1, message: 'unknown pane' };
      return { exitCode: 0, message: '' };
    },
    attach: (pane: string, _size, _handlers: AttachHandlers): Attached => { attachments.push(pane); return { input: (bytes) => { typed.push(`${pane}:${bytes}`); }, resize: () => {}, scroll: () => {}, detach: () => {} }; },
    write: (text) => { writes.push(text); },
    size: () => size,
    cwd: '/w', env: {}, pollMs: 1000, chatCommand: ['x'],
    setInterval: (callback: () => void) => { timers.push(callback); return timers.length - 1; },
    clearInterval: () => {},
    memory: { load: () => ({}), save: () => {} },
    tile,
  });
  return { app, typed, writes, screens, attachments, tick: async () => { for (const t of timers) t(); await Bun.sleep(10); }, last: () => plain(writes.at(-1) ?? '') };
}
const paneRow = (ws: string, pane: string, title: string, state = 'working') => ({ address: `${ws}/t/${pane}`, workspace: ws, pane, title, state });

for (const seed of [1, 2, 3]) {
  test(`app seed ${seed}: tile → arrows → Enter zoom → typing reaches only that pane → ctrl+b t back; pane exit shows closed; no crash`, async () => {
    const next = rng(seed);
    const n = [4, 9, 12][seed - 1]!;
    let panes = Array.from({ length: n }, (_, i) => paneRow('invest-demo', `p${i}`, `analyst-${i}`));
    const other = paneRow('elsewhere', 'z1', 'not-me');
    const h = harness(() => JSON.stringify({ panes: [...panes, other] }), { cols: 200, rows: 80 }, { ws: 'invest-demo' });
    for (const p of panes) h.screens.set(p.pane, screenOf(next, 30));
    h.screens.set('p1', '[screen 80x24 cursor=0,0]\n한국어 분석 결과 출력 🟢 BUY');
    await h.app.start();
    await h.tick();
    expect(h.last()).toContain('TILE invest-demo');
    expect(h.last()).toContain(`${n} panes`);
    expect(h.last()).not.toContain('not-me');
    expect(h.last()).toContain('한국어 분석 결과 출력');
    h.app.key('zzz 123 typed');                                // read-only: nothing reaches any pane
    h.app.key('\u001b[C');                                     // focus → p1
    h.app.key('\r');
    await Bun.sleep(10);
    expect(h.attachments.at(-1)).toBe('p1');
    h.app.key('ls\r');
    expect(h.typed).toEqual(['p1:ls\r']);
    h.app.key('\u0002t');
    await h.tick();
    expect(h.last()).toContain('TILE invest-demo');
    h.app.key('xyz');
    expect(h.typed).toEqual(['p1:ls\r']);
    // a pane exits, another disappears entirely
    panes = panes.map((p, i) => i === 2 ? { ...p, state: 'exited' } : p).filter((_, i) => i !== 3);
    h.screens.delete('p3');
    await h.tick(); await h.tick();
    expect(h.last()).toContain('closed');
    for (const row of (h.writes.at(-1) ?? '').replace(/^\u001b\[\?25l\u001b\[H/, '').replace(/\u001b\[\?25l$/, '').split('\r\n')) expect(cells(row)).toBe(200);
    h.app.key('\u0002q');
    expect((await h.app.done).code).toBe(0);
  });
}

test('stage app: the conductor feed drives ribbon, spotlight then verdict', async () => {
  let feed = '';
  const panes = Array.from({ length: 4 }, (_, i) => paneRow('invest-demo', `p${i}`, `analyst-${i}`));
  const h = harness(() => JSON.stringify({ panes }), { cols: 200, rows: 80 }, { ws: 'invest-demo', stage: { readFeed: () => feed } });
  await h.app.start();
  await h.tick();
  expect(h.last()).toContain('conductor · waiting');
  feed = '{"phase":"debate","nodes":["gather","debate","vote"],"spotlightPane":"analyst-2","spotlightMs":60000}\n';
  await h.tick();
  expect(h.last()).toContain('● debate');
  expect(h.last()).toContain('analyst-2');
  expect(h.last()).not.toContain('analyst-1');
  feed += '{"phase":"vote","nodes":["gather","debate","vote"],"verdictPane":"p0","receipt":"receipt: BUY 3/4"}\n';
  await h.tick();
  expect(h.last()).toContain('analyst-0');
  expect(h.last()).not.toContain('analyst-2');
  expect(h.last()).toContain('receipt: BUY 3/4');
  h.app.key('\u0002q');
  await h.app.done;
});

// ---- ELS-TILE-DEMO-QUICKWINS: pages · folding · stable identity · badges/counters · spotlight caption · ALL / SPACES.
for (const seed of [1, 2, 3]) {
  for (const [cols, rows] of [[200, 80], [160, 50]] as const) {
    test(`quickwins seed ${seed} ${cols}×${rows}: 21 panes on a 3×3 grid page 1/3 → 3/3, every row exactly ${cols} cells`, () => {
      const tiles = tilesOf(21, seed).map((tile, i) => ({ ...tile, model: ['eln', 'codex', 'claude'][i % 3]! }));
      for (const page of [0, 1, 2]) {
        const out = tileFrameRows({ cols, rows, tiles, focus: 0, grid: '3x3', page, stage: { header: stageHeader({ agents: 21, models: 3, toolCalls: 132, cited: 25, elapsedMs: 201_000 }), ribbon: ' ◆ conductor' } });
        expect(out.length).toBe(rows);
        for (const row of out) expect(cells(row)).toBe(cols);
        expect(plain(out.at(-1)!)).toContain(` ◧ ${page + 1}/3 `);
        expect(plain(out[1]!)).toContain('21 agents · 3 models · 132 tool calls · 25 cited · 3m21s');
      }
      expect(tileLayout({ cols, rows, tiles, focus: 0, grid: '3x3', page: 2 }, rows).visible.map((t) => t?.pane)).toEqual(['p18', 'p19', 'p20']);
      expect(tileLayout({ cols, rows, tiles, focus: 0, grid: '3x3', page: 9 }, rows).page).toBe(2);   // clamped
    });
  }
}

test('folding: idle/done/closed panes leave the grid for title rows in slot order; nothing folds when no pane is active', () => {
  const tiles: TileInput[] = [
    { pane: 'a', title: 'INV·Board', state: 'working' }, { pane: 'b', title: 'INV·Panel·Global macro', state: 'done', tag: 'HOLD 5' },
    { pane: 'c', title: '장우진 · 리스크', state: 'idle' }, { pane: 'd', title: 'INV·News', state: 'working' }, { pane: 'e', title: 'x', state: 'exited', closed: true },
  ];
  const layout = tileLayout({ cols: 200, rows: 80, tiles, focus: 0, fold: true }, 80);
  expect(layout.visible.map((t) => t?.pane)).toEqual(['a', 'd']);
  expect(layout.folded.map((t) => t.pane)).toEqual(['b', 'c', 'e']);
  const fold = foldRows(layout.folded, 200, 1);
  expect(cells(fold[0]!)).toBe(200);
  expect(plain(fold[0]!).replace(/ +/g, ' ')).toBe(' ✓ INV·Panel·Global macro · HOLD 5 ○ 장우진 · 리스크 ✕ x ');
  const quiet = tiles.map((t) => ({ ...t, state: 'idle' }));
  expect(tileLayout({ cols: 200, rows: 80, tiles: quiet, focus: 0, fold: true }, 80).folded).toEqual([]);
  for (const [cols, rows] of [[200, 80], [160, 50]] as const) for (const row of tileFrameRows({ cols, rows, tiles, focus: 0, fold: true })) expect(cells(row)).toBe(cols);
});

test('stable identity: a pane keeps its slot across spawn/close; holes refill; compaction only on a layout-table step', () => {
  const cap3x3 = (n: number): number => { const g = tileGrid(Math.max(1, Math.min(12, n)), 'auto', 200, 80); return g.c * g.r; };
  let slots = assignSlots([], ['a', 'b', 'c', 'd', 'e', 'f', 'g'], cap3x3);            // 7 → 3×3
  expect(slots).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  slots = assignSlots(slots, ['a', 'b', 'd', 'e', 'f', 'g'], cap3x3);                  // c closes: 6 → 3×2 step → compact
  expect(slots).toEqual(['a', 'b', 'd', 'e', 'f', 'g']);
  slots = assignSlots(slots, ['a', 'b', 'd', 'e', 'f', 'g', 'h'], cap3x3);             // h spawns: 3×3 again, appended
  expect(slots).toEqual(['a', 'b', 'd', 'e', 'f', 'g', 'h']);
  slots = assignSlots(slots, ['a', 'd', 'e', 'f', 'g', 'h', 'i'], cap3x3);             // b closes, i spawns, same 3×3: i fills b's cell
  expect(slots).toEqual(['a', 'i', 'd', 'e', 'f', 'g', 'h']);
  slots = assignSlots(slots, ['a', 'i', 'd', 'f', 'g', 'h', 'j', 'k'], cap3x3);        // e closes, j k spawn: e's hole → j, k appended
  expect(slots).toEqual(['a', 'i', 'd', 'j', 'f', 'g', 'h', 'k']);
  slots = assignSlots(slots, ['a', 'i', 'd', 'j', 'f', 'g', 'k'], cap3x3);             // h closes within 3×3: hole kept, nobody moves
  expect(slots).toEqual(['a', 'i', 'd', 'j', 'f', 'g', undefined, 'k']);
  for (const seed of [1, 2, 3]) {                                                     // random spawn/close: a surviving pane never moves within one table step
    const next = rng(seed);
    let panes = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
    let s = assignSlots([], panes, cap3x3);
    for (let step = 0; step < 40; step++) {
      const before = s.slice();
      if (next() < 0.5 && panes.length > 7) panes = panes.filter((_, i) => i !== Math.floor(next() * panes.length));
      else if (panes.length < 9) panes = [...panes, `n${seed}-${step}`];
      s = assignSlots(s, panes, cap3x3);
      if (cap3x3(before.filter(Boolean).length) === cap3x3(panes.length)) for (const p of panes) if (before.includes(p)) expect(s.indexOf(p)).toBe(before.indexOf(p));
    }
  }
});

test('badges and counters: model words, header literal, feed counters + spotlightCaption parse additively', () => {
  expect([modelOf('INV·Panel codex'), modelOf(undefined, 'Claude Code'), modelOf('eln · OP'), modelOf('bash')]).toEqual(['codex', 'claude', 'eln', undefined]);
  expect(stageHeader({ agents: 21, models: 3, toolCalls: 132, cited: 25, elapsedMs: 201_000 })).toBe(' ▣ 21 agents · 3 models · 132 tool calls · 25 cited · 3m21s');
  expect(stageHeader({ agents: 4, models: 1 })).toBe(' ▣ 4 agents · 1 models');
  const feed = parseStageFeed('{"phase":"spotlight","spotlightCaption":"장우진 · 리스크 / 비중 축소 · 지수 4,600–4,800","counters":{"toolCalls":132,"cited":25,"bogus":3,"agents":-1}}');
  expect(feed).toEqual({ phase: 'spotlight', spotlightCaption: '장우진 · 리스크 / 비중 축소 · 지수 4,600–4,800', counters: { toolCalls: 132, cited: 25 } });
  const out = tileFrameRows({ cols: 200, rows: 80, tiles: [{ pane: 'a', title: 'INV·Board', state: 'working', model: 'codex' }], focus: 0 });
  expect(plain(out[0]!)).toStartWith('┏ codex  🟢 INV·Board');
});

test('spotlight caption: two centered rows, CJK width exact at 200 and 160, shown only while solo', () => {
  const caption = '장우진 · 리스크 / 비중 축소 · 지수 4,600–4,800';
  for (const cols of [200, 160]) {
    const rows = captionRows(caption, cols);
    expect(rows.map((row) => plain(row).trim())).toEqual(['장우진 · 리스크', '비중 축소 · 지수 4,600–4,800']);
    for (const row of rows) expect(cells(row)).toBe(cols);
  }
  expect(captionRows('한 줄만', 20).map(plain)).toEqual(['      한 줄만       ']);
  const tiles: TileInput[] = [{ pane: 'a', title: '장우진', state: 'working' }, { pane: 'b', title: 'b', state: 'idle' }];
  const solo = tileFrameRows({ cols: 160, rows: 50, tiles, focus: 0, stage: { solo: 'a', caption } });
  expect(plain(solo[0]!).trim()).toBe('장우진 · 리스크');
  for (const row of solo) expect(cells(row)).toBe(160);
  expect(plain(tileFrameRows({ cols: 160, rows: 50, tiles, focus: 0, stage: { caption } }).join('\n'))).not.toContain('비중 축소');
});

test('ALL band and SPACES tile: literal title lead and summary lines, width exact', () => {
  const all = tileFrameRows({ cols: 200, rows: 80, tiles: [{ pane: 'a', title: 'INV·Board', state: 'working', space: 'invest', model: 'eln' }], focus: 0 });
  expect(plain(all[0]!)).toStartWith('┏▌invest  eln  🟢 INV·Board');
  const tile = spaceTile({ id: 'w1', name: '투자 데모', coordinator: 'OP', panes: [{ title: 'board', state: 'working' }, { title: 'p1', state: 'idle' }, { title: 'p2', state: 'blocked' }], line: '한국어 마지막 줄' });
  expect(tile).toEqual({ pane: 'space:w1', title: '투자 데모', state: 'working', tag: '3 panes',
    screen: 'coordinator OP · 3 hands\n●1 working  ○1 idle  ✋1 blocked\nactive: board\n› 한국어 마지막 줄' });
  for (const [cols, rows] of [[200, 80], [160, 50]] as const) for (const row of tileFrameRows({ cols, rows, tiles: [tile, tile, tile], focus: 0 })) expect(cells(row)).toBe(cols);
});

test('app: 21 panes page with ] and [, ALL orders space→tab, SPACES Enter drills in and Esc climbs back', async () => {
  const panes = [...Array.from({ length: 21 }, (_, i) => paneRow('invest-demo', `p${i}`, `panel-${i} codex`)), paneRow('ops', 'o1', 'ops-board')];
  const h = harness(() => JSON.stringify({ panes }), { cols: 200, rows: 80 }, { ws: 'invest-demo', grid: '3x3' });
  await h.app.start(); await h.tick();
  expect(h.last()).toContain(' ◧ 1/3 ');
  expect(h.last()).toContain(' codex ');
  h.app.key(']'); expect(h.last()).toContain(' ◧ 2/3 '); expect(h.last()).toContain('panel-9 codex');
  h.app.key('['); h.app.key('['); expect(h.last()).toContain(' ◧ 3/3 ');
  h.app.key('\u001b');                                          // space → spaces
  expect(h.last()).toContain('SPACES · 2 spaces');
  expect(h.last()).toContain('●21 working');
  h.app.key('\u001b');                                          // spaces → all
  expect(h.last()).toContain('ALL · 22 panes');
  expect(h.last()).toContain('▌invest-demo');
  h.app.key('\u001b'); expect(h.last()).toContain('ALL · 22 panes');   // top: stays
  const s = harness(() => JSON.stringify({ panes }), { cols: 160, rows: 50 }, { spaces: true });
  await s.app.start(); await s.tick();
  expect(s.last()).toContain('SPACES · 2 spaces');
  s.app.key('\u001b[C'); s.app.key('\r');                         // second space = ops
  expect(s.last()).toContain('TILE ops · 1 panes');
  for (const row of s.last().split('\r\n')) expect(Bun.stringWidth(row.replace(/^\u001b\[\?25l\u001b\[H/, ''))).toBeLessThanOrEqual(160);
});
