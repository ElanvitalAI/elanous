// els tile mode (ELS-TILE-MODE, 대표 11-26): many panes of one workspace at once, as a live grid. Pure functions only —
// the app (attach-app.ts) feeds the rows and each pane's last ANSI screen; this file lays out and draws the frame.
// Every drawn row is exactly `cols` terminal cells wide (CJK/emoji measured by the same fitAnsi/fitCells as the pane view).

import { fitAnsi, fitCells, wordOfState } from './attach-view.js';
import { STATUS } from './status-vocab.js';

const ESC = '\u001b';
export type TileGridSpec = 'auto' | '2x2' | '3x3' | '4x3';
export const TILE_GRIDS: readonly TileGridSpec[] = ['auto', '2x2', '3x3', '4x3'];
/** The most tiles one frame shows (4×3); further panes are counted in the status line. */
export const MAX_TILES = 12;
/** The tile refresh period: ~2 fps (memory read of each pane's screen, damage-only paint by the frame writer). */
export const TILE_REFRESH_MS = 500;
export const TILE_HELP = 'TILE · arrows/hjkl focus · Enter zoom · ctrl+b t back to tile · ctrl+b q quit';

export interface TileInput {
  readonly pane: string;
  readonly title: string;
  readonly state: string;
  /** Short right-hand tag in the title bar (seat or command tail). */
  readonly tag?: string;
  readonly remote?: boolean;
  /** The pane's last ANSI screen (`[screen …]` header allowed); undefined = nothing yet. */
  readonly screen?: string;
  readonly closed?: boolean;
  /** ELS-TILE-DEMO-QUICKWINS ④: model family shown as a colored badge (eln · codex · claude). */
  readonly model?: string;
  /** ALL mode: the pane's space (workspace), drawn as a color band + label in the title. */
  readonly space?: string;
  /** ③ an empty slot kept for identity (a closed pane's cell until the next layout step). */
  readonly hole?: boolean;
}

/** Columns × rows of the grid for `n` tiles. `auto` = the smallest of 1×1 … 4×3 that holds them (200×80 → 3×3 for 9). */
export function tileGrid(n: number, spec: TileGridSpec = 'auto', cols = 200, rows = 80): { c: number; r: number } {
  if (spec !== 'auto') { const [c, r] = spec.split('x').map(Number) as [number, number]; return { c, r }; }
  const ladder: readonly [number, number][] = [[1, 1], [2, 1], [2, 2], [3, 2], [3, 3], [4, 3]];
  const fit = ladder.find(([c, r]) => c * r >= n) ?? [4, 3];
  // A short, wide terminal (e.g. 160×50) reads better with more columns than rows: 3×2 → 3×2, 2×2 stays.
  let [c, r] = fit;
  while (c > 1 && Math.floor(cols / c) < 24) c--;              // a tile narrower than 24 cells shows nothing useful
  while (r > 1 && Math.floor((rows - 1) / r) < 5) r--;
  return { c, r };
}

/** Index of the focused tile after moving one step `dir` in a c×r grid holding `n` tiles (clamped, never wraps out). */
export function moveFocus(focus: number, dir: 'left' | 'right' | 'up' | 'down', n: number, c: number): number {
  if (n <= 0) return 0;
  const at = Math.min(Math.max(0, focus), n - 1);
  const next = dir === 'left' ? (at % c > 0 ? at - 1 : at) : dir === 'right' ? (at % c < c - 1 && at + 1 < n ? at + 1 : at)
    : dir === 'up' ? (at - c >= 0 ? at - c : at) : (at + c < n ? at + c : at);
  return next;
}

const stripHeader = (screen: string): string => screen.replace(/^\u001b\[\d+;\d+H(?:\u001b\[\?25[hl])?/, '').replace(/^\[screen [^\]]*\]\n/, '');

/** The last `height` non-blank-tail rows of a screen (the bottom region — where a CLI's latest output lives). */
export function bottomRows(screen: string, height: number): string[] {
  const lines = stripHeader(screen).replace(/\r/g, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.replace(/\u001b\[[0-9;:?]*[A-Za-z]/g, '').trim() === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - height));
}

function tileLines(tile: TileInput | undefined, w: number, h: number, focused: boolean, accent?: 'new' | 'pulse'): string[] {
  const heavy = focused || accent === 'new';
  const [tl, tr, bl, br, hz, vt] = heavy ? ['┏', '┓', '┗', '┛', '━', '┃'] : ['┌', '┐', '└', '┘', '─', '│'];
  const on = accent === 'new' ? `${ESC}[1;33m` : focused ? `${ESC}[1;36m` : accent === 'pulse' ? `${ESC}[32m` : `${ESC}[2m`;
  const off = `${ESC}[0m`;
  const inner = Math.max(0, w - 2);
  if (w < 2 || h < 2) return Array.from({ length: h }, () => ' '.repeat(Math.max(0, w)));
  let head = '';
  if (tile) {
    const mark = tile.closed ? '✕' : STATUS[wordOfState(tile.state)].mark;
    head = ` ${tile.remote ? '🌐 ' : ''}${mark} ${tile.title}${tile.tag ? ` · ${tile.tag}` : ''} `;
  }
  const lead = tile && !tile.hole ? titleLead(tile) : '';
  const leadWidth = Math.min(Math.floor(inner / 2), Bun.stringWidth(lead.replace(/\u001b\[[0-9;]*m/g, '')));
  const title = fitCells(tile?.hole ? '' : head, inner - leadWidth).replace(/ ( *)$/, (_all, rest: string) => ` ${hz.repeat(rest.length)}`);
  const out = [`${on}${tl}${off}${leadWidth > 0 ? fitAnsi(lead, leadWidth) : ''}${focused ? `${ESC}[1m` : ''}${title}${off}${on}${tr}${off}`];
  const body = h - 2;
  let content: string[] = [];
  if (tile?.hole) content = [];
  else if (tile?.closed) content = ['closed'];
  else if (tile?.remote && tile.screen === undefined) content = ['remote · title only'];
  else if (tile && (tile.screen === undefined || stripHeader(tile.screen).trim() === '')) content = ['waiting'];
  else if (tile) content = bottomRows(tile.screen!, body);
  // GOAL-ORCHESTRATION-NL: a short screen in a tall tile (the spotlit reduce/publish tile) reads from the top, not
  // as a few lines stuck to the bottom edge; a screen that fills most of the tile keeps its newest lines at the bottom.
  const pad = content.length * 2 < body ? 0 : Math.max(0, body - content.length);
  for (let i = 0; i < body; i++) out.push(`${on}${vt}${off}${fitAnsi(i >= pad ? content[i - pad] ?? '' : '', inner)}${on}${vt}${off}`);
  out.push(`${on}${bl}${hz.repeat(inner)}${br}${off}`);
  return out;
}

export interface TileFrameInput {
  readonly cols: number;
  readonly rows: number;
  readonly tiles: readonly TileInput[];
  readonly focus: number;
  readonly grid?: TileGridSpec;
  readonly status?: string;
  /** ELS-TILE-STAGE: the conductor ribbon (top row), panes that just appeared, pulse phase, one pane shown alone, a receipt line. */
  readonly stage?: { readonly lane?: string; readonly ribbon?: string; readonly fresh?: ReadonlySet<string>; readonly pulse?: boolean; readonly solo?: string; readonly receipt?: string;
    /** ④ live counter header; ⑤ spotlight caption (≤2 rows, while `solo`); ① page indicator flash (a spawn off-page); ⑥ just-finished panes. */
    readonly header?: string; readonly caption?: string; readonly pageFlash?: boolean; readonly flashDone?: ReadonlySet<string> };
  /** ① the page shown (0-based, clamped). ② fold idle/done panes into one-line rows at the bottom (stage default). */
  readonly page?: number;
  readonly fold?: boolean;
}

const MODEL_SGR: Readonly<Record<string, string>> = { eln: `${ESC}[1;97;45m`, codex: `${ESC}[1;30;46m`, claude: `${ESC}[1;30;43m` };
const SPACE_SGR = ['44', '45', '46', '42', '43', '41'] as const;

/** ④ the model family of a pane from its title/tag/screen words (display only): eln · codex · claude, else undefined. */
export function modelOf(...texts: readonly (string | undefined)[]): string | undefined {
  for (const text of texts) { const hit = /\b(claude|codex|eln)\b/i.exec(text ?? ''); if (hit) return hit[1]!.toLowerCase(); }
  return undefined;
}

/** The colored lead of a tile title: ALL mode's space band «▌space» then the model badge « codex ». */
export function titleLead(tile: TileInput): string {
  let lead = '';
  if (tile.space !== undefined) {
    let hash = 0; for (const ch of tile.space) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
    lead += `${ESC}[30;${SPACE_SGR[hash % SPACE_SGR.length]}m▌${tile.space} ${ESC}[0m`;
  }
  if (tile.model) lead += `${MODEL_SGR[tile.model] ?? `${ESC}[7m`} ${tile.model} ${ESC}[0m`;
  return lead;
}

/** ③ stable pane identity (tmux layout rule): a pane keeps its slot when others spawn or close; a closed pane leaves a
 *  hole the next new pane fills; slots compact only when the layout table steps (`capacityOf(n)` changes). */
export function assignSlots(prev: readonly (string | undefined)[], panes: readonly string[], capacityOf: (n: number) => number): (string | undefined)[] {
  const live = new Set(panes);
  const next = prev.map((pane) => pane !== undefined && live.has(pane) ? pane : undefined);
  const placed = new Set(next.filter((pane): pane is string => pane !== undefined));
  for (const pane of panes) {
    if (placed.has(pane)) continue;
    const hole = next.indexOf(undefined);
    if (hole >= 0) next[hole] = pane; else next.push(pane);
    placed.add(pane);
  }
  const before = prev.filter((pane) => pane !== undefined).length;
  const compact = capacityOf(before) !== capacityOf(panes.length) ? next.filter((pane) => pane !== undefined) : next;
  while (compact.length > 0 && compact[compact.length - 1] === undefined) compact.pop();
  return compact;
}

/** ④ the live counter header «21 agents · 3 models · 132 tool calls · 25 cited · 3m21s» (absent counters are left out). */
export function stageHeader(c: { readonly agents: number; readonly models: number; readonly toolCalls?: number; readonly cited?: number; readonly elapsedMs?: number }): string {
  const parts = [`${c.agents} agents`, `${c.models} models`];
  if (c.toolCalls !== undefined) parts.push(`${c.toolCalls} tool calls`);
  if (c.cited !== undefined) parts.push(`${c.cited} cited`);
  if (c.elapsedMs !== undefined) { const s = Math.max(0, Math.floor(c.elapsedMs / 1000)); parts.push(`${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`); }
  return ` ▣ ${parts.join(' · ')}`;
}

/** SPACES mode: one synthetic tile per workspace — coordinator, hand count, status-dot spread, active cells, one live line. */
export function spaceTile(ws: { readonly id: string; readonly name: string; readonly coordinator?: string; readonly panes: readonly { readonly title: string; readonly state: string }[]; readonly line?: string }): TileInput {
  const working = ws.panes.filter((p) => p.state === 'working');
  const blocked = ws.panes.filter((p) => p.state === 'blocked').length;
  const idle = ws.panes.length - working.length - blocked;
  const lines = [
    `coordinator ${ws.coordinator ?? '—'} · ${ws.panes.length} hands`,
    `●${working.length} working  ○${idle} idle  ✋${blocked} blocked`,
    `active: ${working.length > 0 ? working.map((p) => p.title).join(', ') : '—'}`,
    `› ${ws.line ?? ''}`,
  ];
  return { pane: `space:${ws.id}`, title: ws.name, state: working.length > 0 ? 'working' : blocked > 0 ? 'blocked' : 'idle', tag: `${ws.panes.length} panes`, screen: lines.join('\n') };
}

const foldable = (tile: TileInput): boolean => tile.closed === true || ['idle', 'done'].includes(wordOfState(tile.state));

export interface TileLayout { readonly visible: readonly (TileInput | undefined)[]; readonly folded: readonly TileInput[]; readonly page: number; readonly pages: number; readonly c: number; readonly r: number; readonly solo: boolean }

/** The tiles a frame shows: ② folding (idle/done panes leave the grid for title rows, while any pane is active), then ① paging
 *  of what remains by the grid capacity. Holes (`hole: true`) keep their cell (③). The app uses the same answer for focus and zoom. */
export function tileLayout(view: TileFrameInput, gridHeight: number): TileLayout {
  const cols = Math.max(1, view.cols);
  const soloTile = view.stage?.solo !== undefined ? view.tiles.find((tile) => tile.pane === view.stage!.solo) : undefined;
  if (soloTile) return { visible: [soloTile], folded: [], page: 0, pages: 1, c: 1, r: 1, solo: true };
  const live = view.tiles.filter((tile) => !tile.hole);
  const fold = view.fold === true && live.some((tile) => !foldable(tile));
  const main = fold ? view.tiles.filter((tile) => tile.hole || !foldable(tile)) : [...view.tiles];
  while (main.length > 0 && main[main.length - 1]!.hole) main.pop();
  const folded = fold ? live.filter(foldable) : [];
  const { c, r } = tileGrid(Math.max(1, Math.min(MAX_TILES, main.length)), view.grid ?? 'auto', cols, gridHeight - foldHeight(folded.length, cols, gridHeight));
  const capacity = c * r;
  const pages = Math.max(1, Math.ceil(main.length / capacity));
  const page = Math.min(Math.max(0, view.page ?? 0), pages - 1);
  return { visible: main.slice(page * capacity, (page + 1) * capacity).map((tile) => tile.hole ? undefined : tile), folded, page, pages, c, r, solo: false };
}

const FOLD_CELL = 40;
function foldHeight(n: number, cols: number, gridHeight: number): number {
  if (n === 0) return 0;
  return Math.min(Math.ceil(n / Math.max(1, Math.floor(cols / FOLD_CELL))), Math.max(1, Math.floor(gridHeight / 4)));
}

/** ② the folded title rows: «✓ title · tag» cells packed FOLD_CELL wide, in slot order; overflow ends with «+N». */
export function foldRows(folded: readonly TileInput[], cols: number, height: number): string[] {
  if (folded.length === 0 || height <= 0) return [];
  const per = Math.max(1, Math.floor(cols / FOLD_CELL));
  const widths = Array.from({ length: per }, (_, i) => Math.floor(cols / per) + (i < cols % per ? 1 : 0));
  const out: string[] = [];
  for (let row = 0; row < height; row++) {
    const chunk = folded.slice(row * per, (row + 1) * per);
    const last = row === height - 1 && folded.length > height * per;
    out.push(`${ESC}[2m${widths.map((w, i) => {
      if (last && i === per - 1) return fitCells(` +${folded.length - (height * per - 1)} more`, w);
      const tile = chunk[i];
      if (!tile) return ' '.repeat(w);
      const mark = tile.closed ? '✕' : wordOfState(tile.state) === 'done' ? '✓' : '○';
      return fitCells(` ${mark} ${tile.title}${tile.tag ? ` · ${tile.tag}` : ''}`, w);
    }).join('')}${ESC}[0m`);
  }
  return out;
}

/** ⑤ the spotlight caption: up to 2 centered bold rows (split at a newline or the first « / »), CJK-safe width. */
export function captionRows(caption: string, cols: number): string[] {
  const parts = (caption.includes('\n') ? caption.split('\n') : caption.split(' / ')).map((part) => part.trim()).filter(Boolean);
  const two = parts.length > 2 ? [parts[0]!, parts.slice(1).join(' / ')] : parts;
  return two.map((text) => {
    const fitted = fitCells(text, Math.max(0, cols - 4)).trimEnd();
    const pad = Math.max(0, Math.floor((cols - Bun.stringWidth(fitted)) / 2));
    return `${ESC}[1;30;43m${fitCells(`${' '.repeat(pad)}${fitted}`, cols)}${ESC}[0m`;
  });
}

/** The whole tile frame as rows (each exactly `cols` cells): top lines, the grid, folded rows, receipt, one reverse-video status line. */
export function tileFrameRows(view: TileFrameInput): string[] {
  const cols = Math.max(1, view.cols);
  const height = Math.max(2, view.rows);
  const stage = view.stage;
  const top: string[] = [];
  if (stage?.ribbon !== undefined) top.push(`${ESC}[1m${fitAnsi(stage.ribbon, cols)}${ESC}[0m`);
  if (stage?.header !== undefined) top.push(`${ESC}[1;36m${fitCells(stage.header, cols)}${ESC}[0m`);
  if (stage?.lane !== undefined) top.push(fitAnsi(stage.lane, cols));
  const soloOn = stage?.solo !== undefined && view.tiles.some((tile) => tile.pane === stage.solo);
  if (soloOn && stage?.caption) top.push(...captionRows(stage.caption, cols));
  const bottom: string[] = [];
  if (stage?.receipt) bottom.push(`${ESC}[1;30;42m${fitCells(` ${stage.receipt} `, cols)}${ESC}[0m`);
  const gridHeight = Math.max(2, height - top.length - bottom.length);
  const layout = tileLayout(view, gridHeight);
  const fh = foldHeight(layout.folded.length, cols, gridHeight);
  const { c, r, visible } = layout;
  const area = Math.max(r * 2, gridHeight - 1 - fh);
  const widths = Array.from({ length: c }, (_, i) => Math.floor(cols / c) + (i < cols % c ? 1 : 0));
  const heights = Array.from({ length: r }, (_, i) => Math.floor(area / r) + (i < area % r ? 1 : 0));
  const out: string[] = [...top];
  const accentOf = (tile: TileInput | undefined): 'new' | 'pulse' | undefined => !tile || !stage ? undefined
    : stage.fresh?.has(tile.pane) || stage.flashDone?.has(tile.pane) ? 'new' : stage.pulse && tile.state === 'working' ? 'pulse' : undefined;
  for (let gr = 0; gr < r; gr++) {
    const cells = widths.map((w, gc) => { const index = gr * c + gc; const tile = visible[index]; return tileLines(tile ?? (index < visible.length ? { pane: '', title: '', state: 'idle', hole: true } : undefined), w, heights[gr]!, (layout.solo ? true : index === view.focus) && tile !== undefined, accentOf(tile)); });
    for (let line = 0; line < heights[gr]!; line++) out.push(cells.map((cell) => cell[line]!).join(''));
  }
  out.push(...foldRows(layout.folded, cols, fh));
  out.push(...bottom);
  const pageMark = layout.pages > 1 ? `${stage?.pageFlash ? `${ESC}[1;30;43m` : `${ESC}[1m`} ◧ ${layout.page + 1}/${layout.pages} ${ESC}[0m${ESC}[7m` : '';
  const status = ` ${view.status ?? TILE_HELP}${layout.pages > 1 ? ' · [ ] page' : ''} `;
  out.push(`${ESC}[7m${fitAnsi(`${pageMark}${status}`, cols)}${ESC}[0m`);
  return out;
}

/** The frame as one paint in the app frame writer's composed format (cursor hidden, home, rows) — damage-only repaint. */
export function drawTileFrame(view: TileFrameInput): string {
  return `${ESC}[?25l${ESC}[H${tileFrameRows(view).join('\r\n')}${ESC}[?25l`;
}

export function parseTileGrid(value: string | undefined): TileGridSpec | undefined {
  return value === undefined ? 'auto' : (TILE_GRIDS as readonly string[]).includes(value) ? value as TileGridSpec : undefined;
}

/** ELS-TILE-STAGE feed: one JSON object per line, appended by the demo conductor; the last valid line is the state.
 *  { phase?: string, nodes?: string[], spotlightPane?: string, spotlightMs?: number, verdictPane?: string, receipt?: string } */
export interface StageFeed {
  readonly phase?: string; readonly nodes?: readonly string[]; readonly spotlightPane?: string; readonly spotlightMs?: number;
  readonly verdictPane?: string; readonly receipt?: string;
  /** ③ evidence dots in flight toward the conductor (0–12). ⑤ votes cast (chips fly into the gauge) and the gauge itself. */
  readonly evidence?: number; readonly votes?: readonly { readonly pane?: string; readonly vote: string }[];
  readonly consensus?: { readonly label: string; readonly value: number };
  /** ELS-TILE-DEMO-QUICKWINS (additive, optional): ⑤ the 2-line spotlight caption («name · role / call · range»), ④ live counters. */
  readonly spotlightCaption?: string;
  readonly counters?: { readonly agents?: number; readonly models?: number; readonly toolCalls?: number; readonly cited?: number; readonly elapsedMs?: number };
  /** GOAL-ORCHESTRATION-NL: layout command by voice/text (grid · page · level · zoom); applied once per new seq. */
  readonly layout?: StageLayout;
}
export interface StageLayout { readonly seq: number; readonly grid?: TileGridSpec; readonly page?: 'next' | 'prev' | number; readonly level?: 'all' | 'spaces' | 'space'; readonly zoom?: string }

function parseStageLayout(raw: unknown): StageLayout | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.seq !== 'number' || !Number.isFinite(r.seq)) return undefined;
  return { seq: r.seq,
    ...(typeof r.grid === 'string' && (TILE_GRIDS as readonly string[]).includes(r.grid) ? { grid: r.grid as TileGridSpec } : {}),
    ...(r.page === 'next' || r.page === 'prev' || (typeof r.page === 'number' && r.page >= 0) ? { page: r.page as StageLayout['page'] } : {}),
    ...(r.level === 'all' || r.level === 'spaces' || r.level === 'space' ? { level: r.level } : {}),
    ...(typeof r.zoom === 'string' ? { zoom: r.zoom.slice(0, 80) } : {}) };
}

export function parseStageFeed(text: string | undefined): StageFeed | undefined {
  if (!text) return undefined;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const str = (key: string): string | undefined => typeof raw[key] === 'string' ? raw[key] as string : undefined;
      return { ...(str('phase') ? { phase: str('phase') } : {}), ...(str('spotlightPane') ? { spotlightPane: str('spotlightPane') } : {}),
        ...(str('verdictPane') ? { verdictPane: str('verdictPane') } : {}), ...(str('receipt') ? { receipt: str('receipt') } : {}),
        ...(typeof raw.spotlightMs === 'number' && raw.spotlightMs > 0 ? { spotlightMs: raw.spotlightMs } : {}),
        ...(typeof raw.evidence === 'number' && raw.evidence > 0 ? { evidence: Math.min(12, Math.floor(raw.evidence)) } : {}),
        ...(Array.isArray(raw.votes) ? { votes: raw.votes.flatMap((v): { pane?: string; vote: string }[] => v && typeof v === 'object' && typeof (v as { vote?: unknown }).vote === 'string'
          ? [{ vote: ((v as { vote: string }).vote).slice(0, 8), ...(typeof (v as { pane?: unknown }).pane === 'string' ? { pane: (v as { pane: string }).pane } : {}) }] : []).slice(0, 15) } : {}),
        ...(raw.consensus && typeof raw.consensus === 'object' && typeof (raw.consensus as { value?: unknown }).value === 'number'
          ? { consensus: { label: String((raw.consensus as { label?: unknown }).label ?? '').slice(0, 12), value: Math.max(0, Math.min(1, (raw.consensus as { value: number }).value)) } } : {}),
        ...(str('spotlightCaption') ? { spotlightCaption: str('spotlightCaption')!.slice(0, 160) } : {}),
        ...(raw.counters && typeof raw.counters === 'object' && !Array.isArray(raw.counters) ? { counters: Object.fromEntries((['agents', 'models', 'toolCalls', 'cited', 'elapsedMs'] as const)
          .flatMap((key) => { const v = (raw.counters as Record<string, unknown>)[key]; return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? [[key, Math.floor(v)]] : []; })) } : {}),
        ...(parseStageLayout(raw.layout) ? { layout: parseStageLayout(raw.layout)! } : {}),
        ...(Array.isArray(raw.nodes) ? { nodes: raw.nodes.filter((n): n is string => typeof n === 'string').slice(0, 24) } : {}) };
    } catch { /* a half-written line: the previous one stands */ }
  }
  return undefined;
}

/** The conductor ribbon: nodes in order, lit (green ●) up to and including the current phase, the rest dim ○. */
export function stageRibbon(feed: StageFeed | undefined): string {
  const nodes = feed?.nodes ?? (feed?.phase ? [feed.phase] : []);
  if (nodes.length === 0) return ' ◆ conductor · waiting';
  const at = feed?.phase !== undefined ? nodes.indexOf(feed.phase) : -1;
  return ` ◆ conductor  ${nodes.map((node, i) => i <= at ? `${ESC}[32m● ${node}${ESC}[0m${ESC}[1m` : `${ESC}[2m○ ${node}${ESC}[0m${ESC}[1m`).join(' ─ ')}`;
}

const CHIP_SGR: Readonly<Record<string, string>> = { BUY: `${ESC}[30;42m`, SELL: `${ESC}[30;41m`, HOLD: `${ESC}[30;43m` };

/** ③ ⑤ the motion lane under the ribbon (exactly `cols` cells): evidence dots drift right toward the conductor; each vote
 *  chip flies from the left into the consensus gauge on the right, `ages[i]` ticks after it was first seen (landed chips
 *  stack inside the gauge). Pure: the same feed, ages and tick always draw the same row. */
export function stageLane(feed: StageFeed | undefined, tick: number, ages: readonly number[], cols: number): string {
  const consensus = feed?.consensus;
  const votes = feed?.votes ?? [];
  const pct = consensus ? Math.round(consensus.value * 100) : undefined;
  const barCells = 12;
  const filled = consensus ? Math.round(consensus.value * barCells) : 0;
  const landed = votes.filter((_, i) => (ages[i] ?? 0) >= 8);
  const gauge = consensus || votes.length > 0
    ? ` ⟦ ${'█'.repeat(filled)}${'░'.repeat(barCells - filled)} ${pct !== undefined ? `${pct}%` : ''} ${consensus?.label ?? ''} · ${landed.length}/${votes.length} votes ⟧ ` : '';
  const gaugeWidth = Bun.stringWidth(gauge);
  const laneWidth = Math.max(0, cols - gaugeWidth);
  // Cells of the lane: one character (width 1) or a chip string occupying several cells.
  const cells: string[] = Array.from({ length: laneWidth }, () => ' ');
  const n = feed?.evidence ?? 0;
  for (let k = 0; k < n && laneWidth > 0; k++) {
    const at = (tick * 3 + Math.floor((k * laneWidth) / Math.max(1, n))) % laneWidth;
    cells[at] = `${ESC}[33m•${ESC}[0m`;
  }
  votes.forEach((vote, i) => {
    const age = ages[i] ?? 0;
    if (age >= 8) return;                                        // landed in the gauge
    const label = vote.vote.toUpperCase();
    const chip = ` ${label} `;
    const width = chip.length;
    if (laneWidth < width) return;
    const at = Math.min(laneWidth - width, Math.floor(((laneWidth - width) * age) / 8));
    if (cells.slice(at, at + width).some((cell) => cell === '' || cell.length > 12)) return;   // another chip holds these cells this frame
    cells[at] = `${CHIP_SGR[label] ?? `${ESC}[30;47m`}${chip}${ESC}[0m`;
    for (let c = 1; c < width; c++) cells[at + c] = '';
  });
  const gaugeOut = gauge ? `${ESC}[1m${gauge}${ESC}[0m` : '';
  return fitAnsi(`${cells.join('')}${gaugeOut}`, cols);
}
