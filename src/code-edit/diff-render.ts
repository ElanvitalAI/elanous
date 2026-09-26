// ANSI diff renderer — Phase CE3.
//
// Adapted from codex-rs/tui/src/diff_render.rs (Apache 2.0) — same
// palette choice, same gutter shape, but written against Elanous's
// direct-ANSI paint model instead of ratatui.
//
// Output shape (screenshot-reference):
//
//   ●  Update(test/foo.test.ts)
//      Added 11 lines, removed 3 lines
//       60      expect(b.row).toBe(…);
//       61    });
//       62
//       63-   test('clamps to min on small terminals', () => {
//       63+   test('falls back to fullscreen on terminals smaller than min', () => {
//       …
//
// No syntax highlighting in this phase (CE6 layers shiki in). Colour
// for added/deleted lines uses truecolor bg pairs matched to the
// Catppuccin Mocha palette so it doesn't clash with the rest of the
// dashboard chrome.

import chalk, { ChalkInstance } from 'chalk';
import { C, stripAnsi } from '../tui.js';
import { normalizeTabs } from '../panes/syntax-color.js';
import { computeInlineWordDiff, hasIntraLineChange, type WordDiffPart } from '../panes/word-diff.js';
import type { EditResult, StructuredPatchHunk } from './types.js';
import {
  detectLanguage, highlightCode, type SyntaxToken,
} from './syntax-highlight.js';

export type DiffColorTier = 'auto' | 'truecolor' | '256' | 'ansi16';
export type DiffHeaderStyle = 'legacy' | 'edited';

/** Shared max visible width for code preview lines across diff render,
 *  tool-render, and preview-pane. 2000 chars balances "catch pathological
 *  10 KB single-line files" against "don't truncate legitimate long
 *  lines of minified code the user actually wants to see". */
export const CODE_PREVIEW_MAX_LINE_WIDTH = 2000;

export interface DiffRenderOptions {
  /** Terminal column count — used to right-pad/truncate overly long
   *  lines so the bg colour fills the row instead of wrapping. When
   *  omitted, no padding (the terminal handles wrapping). */
  cols?: number;
  /** Render everything without ANSI for tests / copy-to-clipboard. */
  noColor?: boolean;
  /** Truncate body lines that exceed this visible width, replacing
   *  the tail with "…" — protects against pathological 10KB single-
   *  line files. Default 2000. */
  maxLineWidth?: number;
  /** CE6 — opt in to shiki syntax highlighting. Default false for
   *  cheap renders; dashboard can turn it on for the live log pane
   *  without paying the cost on snapshot / copy-to-clipboard paths. */
  syntax?: boolean;
  /** R2 — palette selection. */
  colorTier?: DiffColorTier;
  /** R2 — explicit terminal background override. */
  isLight?: boolean;
  /** Source-delta presentation header style. */
  headerStyle?: DiffHeaderStyle;
  /** Phase 5 — when true AND `noColor=false`, adjacent `-`/`+` pairs
   *  within a hunk get intra-line word-diff emphasis (chalk.inverse
   *  on the changed spans). Mutually exclusive with shiki per line
   *  for the pair — the syntax tokens are SUPPRESSED on word-diff
   *  pairs so the emphasis reads cleanly. Default false to preserve
   *  existing output for cache/snapshot tests. */
  inlineWordDiff?: boolean;
}

export interface DiffRenderVariant {
  cols: number;
  noColor: boolean;
  maxLineWidth: number;
  syntax: boolean;
  colorTier: DiffColorTier;
  isLight: boolean;
  inlineWordDiff: boolean;
}

interface DiffPalette {
  addBody: ChalkInstance;
  delBody: ChalkInstance;
  addGutter: ChalkInstance;
  delGutter: ChalkInstance;
}

const TRUECOLOR_DARK: DiffPalette = {
  addBody: chalk.bgRgb(33, 58, 43),
  delBody: chalk.bgRgb(74, 34, 29),
  addGutter: chalk.bgRgb(24, 46, 34),
  delGutter: chalk.bgRgb(55, 26, 23),
};

const TRUECOLOR_LIGHT: DiffPalette = {
  addBody: chalk.bgRgb(220, 246, 228).hex('#1f5130'),
  delBody: chalk.bgRgb(252, 225, 221).hex('#7a2e25'),
  addGutter: chalk.bgRgb(203, 238, 214).hex('#1f5130'),
  delGutter: chalk.bgRgb(248, 206, 200).hex('#7a2e25'),
};

const ANSI256_DARK: DiffPalette = {
  addBody: chalk.bgAnsi256(22).ansi256(194),
  delBody: chalk.bgAnsi256(52).ansi256(224),
  addGutter: chalk.bgAnsi256(22).ansi256(194),
  delGutter: chalk.bgAnsi256(52).ansi256(224),
};

const ANSI256_LIGHT: DiffPalette = {
  addBody: chalk.bgAnsi256(194).ansi256(22),
  delBody: chalk.bgAnsi256(224).ansi256(52),
  addGutter: chalk.bgAnsi256(194).ansi256(22),
  delGutter: chalk.bgAnsi256(224).ansi256(52),
};

const ANSI16_DARK: DiffPalette = {
  addBody: chalk.green,
  delBody: chalk.red,
  addGutter: chalk.green,
  delGutter: chalk.red,
};

const ANSI16_LIGHT: DiffPalette = {
  addBody: chalk.green,
  delBody: chalk.red,
  addGutter: chalk.green,
  delGutter: chalk.red,
};

export function detectTerminalColorLevel(env: NodeJS.ProcessEnv = process.env): Exclude<DiffColorTier, 'auto'> {
  const colorTerm = String(env.COLORTERM ?? '').toLowerCase();
  if (colorTerm.includes('truecolor') || colorTerm.includes('24bit')) return 'truecolor';
  const term = String(env.TERM ?? '').toLowerCase();
  if (term.includes('256color')) return '256';
  return 'ansi16';
}

export function detectTerminalBgLightness(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const raw = String(env.COLORFGBG ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(';').map((part) => Number.parseInt(part, 10)).filter(Number.isFinite);
  const bg = parts.length > 0 ? parts[parts.length - 1]! : NaN;
  if (!Number.isFinite(bg)) return null;
  if (bg >= 0 && bg <= 6) return false;
  if (bg >= 7) return true;
  return null;
}

export function resolveDiffPalette(
  colorTier: DiffColorTier = 'auto',
  isLight = false,
  env: NodeJS.ProcessEnv = process.env,
): DiffPalette {
  const tier = colorTier === 'auto' ? detectTerminalColorLevel(env) : colorTier;
  if (tier === 'truecolor') return isLight ? TRUECOLOR_LIGHT : TRUECOLOR_DARK;
  if (tier === '256') return isLight ? ANSI256_LIGHT : ANSI256_DARK;
  return isLight ? ANSI16_LIGHT : ANSI16_DARK;
}

type HighlightLineMap = Map<number, SyntaxToken[]>;
type HunkRenderCache = Map<string, string[]>;

interface ResolvedDiffRenderOptions {
  variant: DiffRenderVariant;
  headerStyle: DiffHeaderStyle;
}

interface DiffRenderCacheStats {
  hits: number;
  misses: number;
  evictions: number;
}

let HUNK_RENDER_CACHE = new WeakMap<StructuredPatchHunk, HunkRenderCache>();
const MAX_HUNK_RENDER_VARIANTS = 4;
const DIFF_RENDER_CACHE_STATS: DiffRenderCacheStats = {
  hits: 0,
  misses: 0,
  evictions: 0,
};

/** Pretty-printed render of an EditResult. Returns string[] — one
 *  entry per rendered row, ready for chatLines.push.
 *
 *  Synchronous on purpose: the hot path (CE3 log-pane subscribe) calls
 *  this during a draw tick, so we don't want to await. Syntax support
 *  is async by nature (shiki load), so opts.syntax triggers the async
 *  sibling renderEditBlockAsync — callers that want highlighting use
 *  that one. */
export function renderEditBlock(result: EditResult, opts: DiffRenderOptions = {}): string[] {
  return renderEditBlockCore(result, resolveDiffRenderOptions(opts), null, null);
}

/** Same as renderEditBlock but resolves shiki tokens first when
 *  opts.syntax is true. Falls back to the plain path when the
 *  language can't be detected or shiki fails. */
export async function renderEditBlockAsync(result: EditResult, opts: DiffRenderOptions = {}): Promise<string[]> {
  const resolved = resolveDiffRenderOptions(opts);
  if (!resolved.variant.syntax) return renderEditBlock(result, opts);
  const lang = detectLanguage(result.file_path);
  if (!lang) return renderEditBlock(result, opts);
  let newHL: HighlightLineMap | null = null;
  let oldHL: HighlightLineMap | null = null;
  try {
    const maps = await highlightHunks(result.structuredPatch, lang);
    newHL = maps.newLines;
    oldHL = maps.oldLines;
  } catch {
    newHL = null;
    oldHL = null;
  }
  return renderEditBlockCore(result, resolved, newHL, oldHL);
}

function renderEditBlockCore(
  result: EditResult,
  opts: ResolvedDiffRenderOptions,
  newHL: HighlightLineMap | null,
  oldHL: HighlightLineMap | null,
): string[] {
  const out: string[] = [];
  const { variant } = opts;
  const cols = variant.cols;
  const no = variant.noColor;
  const palette = resolveDiffPalette(variant.colorTier, variant.isLight);

  const verb = result.originalContent === '' ? 'Create' : 'Update';
  const dotChar = '●';
  const headerPath = no ? result.file_path : C.muted(result.file_path);

  const added = result.linesAdded;
  const removed = result.linesRemoved;
  if (opts.headerStyle === 'edited') {
    const verb = result.originalContent === '' ? 'Created' : 'Edited';
    const delta = no
      ? `(+${added} -${removed})`
      : `${C.success(`+${added}`)} ${C.error(`-${removed}`)}`;
    out.push(`${no ? verb : C.bold(verb)} ${headerPath} ${no ? delta : C.muted(`(${delta})`)}`);
  } else {
    const headerDot = no ? dotChar : C.success(dotChar);
    const headerVerb = no ? verb : C.accent(verb);
    out.push(`${headerDot}  ${headerVerb}(${headerPath})`);
    const addedStr = no ? String(added) : C.bold(String(added));
    const removedStr = no ? String(removed) : C.bold(String(removed));
    const sub = no
      ? `  Added ${added} lines, removed ${removed} lines`
      : C.muted(`  Added ${addedStr} lines, removed ${removedStr} lines`);
    out.push(sub);
  }

  const gutterW = computeGutterWidth(result.structuredPatch);

  for (let hi = 0; hi < result.structuredPatch.length; hi++) {
    const hunk = result.structuredPatch[hi]!;
    out.push(hunkHeader(hunk, gutterW, no, hi > 0));
    renderHunkCached(hunk, {
      gutterW, cols, no,
      maxLineWidth: variant.maxLineWidth,
      palette,
      newHL, oldHL,
      cacheKey: buildDiffRenderCacheKey(variant),
      syntax: variant.syntax,
      inlineWordDiff: variant.inlineWordDiff,
    }, out);
  }

  return out;
}

interface HunkCtx {
  gutterW: number;
  cols: number;
  no: boolean;
  maxLineWidth: number;
  palette: DiffPalette;
  newHL: HighlightLineMap | null;
  oldHL: HighlightLineMap | null;
  cacheKey: string;
  syntax: boolean;
  inlineWordDiff: boolean;
}

function renderHunkCached(hunk: StructuredPatchHunk, ctx: HunkCtx, out: string[]): void {
  if (ctx.syntax && !hasHighlightCoverage(hunk, ctx.newHL, ctx.oldHL)) {
    renderHunk(hunk, ctx, out);
    return;
  }
  let variants = HUNK_RENDER_CACHE.get(hunk);
  const cached = variants?.get(ctx.cacheKey);
  if (cached) {
    DIFF_RENDER_CACHE_STATS.hits++;
    out.push(...cached);
    return;
  }
  DIFF_RENDER_CACHE_STATS.misses++;
  const rows: string[] = [];
  renderHunk(hunk, ctx, rows);
  if (!variants) {
    variants = new Map<string, string[]>();
    HUNK_RENDER_CACHE.set(hunk, variants);
  }
  if (!variants.has(ctx.cacheKey) && variants.size >= MAX_HUNK_RENDER_VARIANTS) {
    const oldest = variants.keys().next().value;
    if (oldest !== undefined) {
      variants.delete(oldest);
      DIFF_RENDER_CACHE_STATS.evictions++;
    }
  }
  variants.set(ctx.cacheKey, rows);
  out.push(...rows);
}

function renderHunk(hunk: StructuredPatchHunk, ctx: HunkCtx, out: string[]): void {
  let oldN = hunk.oldStart;
  let newN = hunk.newStart;
  for (let i = 0; i < hunk.lines.length; i++) {
    const raw = hunk.lines[i]!;
    const marker = raw[0] ?? ' ';
    const body = raw.slice(1);

    // Phase 5 — word-diff lookahead. When the caller opted in, a
    // removed line immediately followed by an added line is rendered
    // with intra-line emphasis (chalk.inverse on the differing spans)
    // instead of the shiki path. Only fires on TRUE pairs; an
    // unpaired `-` or `+` falls through to the existing renderer.
    if (
      ctx.inlineWordDiff
      && !ctx.no
      && marker === '-'
      && i + 1 < hunk.lines.length
      && hunk.lines[i + 1]!.startsWith('+')
    ) {
      const nextBody = hunk.lines[i + 1]!.slice(1);
      const wd = computeInlineWordDiff(body, nextBody);
      if (hasIntraLineChange(wd)) {
        emitWordDiffPair(
          { body, parts: wd.oldParts, lineNum: oldN, kind: 'del' },
          { body: nextBody, parts: wd.newParts, lineNum: newN, kind: 'add' },
          ctx,
          out,
        );
        oldN++;
        newN++;
        i++;   // consume the `+` line as part of this pair
        continue;
      }
    }

    let lineNumStr: string;
    let markerStr: string;
    let bgBody: ChalkInstance | null = null;
    let bgGutter: ChalkInstance | null = null;
    // 1-indexed source line the syntax map is keyed by. For add/context
    // rows we look up the NEW file; for delete rows we look up the OLD.
    let hlLineIdx = -1;
    let hlSource: HighlightLineMap | null = null;

    if (marker === '+') {
      lineNumStr = padNum(newN, ctx.gutterW - 2);
      hlLineIdx = newN - 1;
      hlSource = ctx.newHL;
      newN++;
      markerStr = '+';
      bgBody = ctx.palette.addBody;
      bgGutter = ctx.palette.addGutter;
    } else if (marker === '-') {
      lineNumStr = padNum(oldN, ctx.gutterW - 2);
      hlLineIdx = oldN - 1;
      hlSource = ctx.oldHL;
      oldN++;
      markerStr = '-';
      bgBody = ctx.palette.delBody;
      bgGutter = ctx.palette.delGutter;
    } else {
      lineNumStr = padNum(oldN, ctx.gutterW - 2);
      hlLineIdx = newN - 1;
      hlSource = ctx.newHL;
      oldN++; newN++;
      markerStr = ' ';
    }

    const clipped = clipLine(normalizeTabs(body), ctx.maxLineWidth);
    const lineTokens = !ctx.no && hlSource ? hlSource.get(hlLineIdx) : undefined;
    const styledBody = lineTokens
      ? tokensToAnsi(lineTokens, clipped, bgBody)
      : null;
    const paddedBody = ctx.cols > 0 ? padBodyToCols(clipped, ctx.gutterW + 2, ctx.cols) : clipped;

    if (ctx.no) {
      out.push(`  ${lineNumStr} ${markerStr} ${paddedBody}`);
      continue;
    }

    const gutter = bgGutter
      ? bgGutter(`  ${lineNumStr} ${markerStr} `)
      : C.muted(`  ${lineNumStr} ${markerStr} `);
    const bodyOut = styledBody
      ? styledBody + paintTailPad(clipped, paddedBody, bgBody)
      : bgBody ? bgBody(paddedBody) : paddedBody;
    out.push(gutter + bodyOut);
  }
}

/** Build an ANSI string for one source line by applying per-token fg
 *  colours on top of an optional bg wash. We emit each token via
 *  chalk so the bg persists through the line even when tokens have
 *  per-char fg colour. Shiki tokens for whitespace typically have no
 *  colour; we keep the bg for those too so the row stays uniform. */
function tokensToAnsi(
  tokens: SyntaxToken[],
  rawBody: string,
  bg: ChalkInstance | null,
): string {
  // Shiki's token output sometimes reflects a slightly different line
  // (e.g. full-file view). Clamp to the actual body to avoid mis-
  // renders — if the token concat doesn't look like rawBody, bail.
  let joined = '';
  for (const t of tokens) joined += t.content;
  if (joined.trimEnd() !== rawBody.trimEnd() && joined !== rawBody) {
    return bg ? bg(rawBody) : rawBody;
  }
  let out = '';
  for (const t of tokens) {
    const fg = t.color ? chalk.hex(t.color) : null;
    const styled = fg ? fg(t.content) : t.content;
    out += bg ? bg(styled) : styled;
  }
  return out;
}

/** If the cols-padded body is wider than the styled version (because
 *  bg was applied per-token not to the trailing spaces), paint the
 *  trailing space block with bg so the row fills uniformly. */
function paintTailPad(raw: string, padded: string, bg: typeof chalk | null): string {
  const extra = padded.length - raw.length;
  if (extra <= 0) return '';
  const pad = ' '.repeat(extra);
  return bg ? bg(pad) : pad;
}

async function highlightHunks(
  hunks: readonly StructuredPatchHunk[],
  lang: string,
): Promise<{ newLines: HighlightLineMap; oldLines: HighlightLineMap }> {
  const newLines = new Map<number, SyntaxToken[]>();
  const oldLines = new Map<number, SyntaxToken[]>();
  for (const hunk of hunks) {
    const oldBodies = hunk.lines.filter((line) => !line.startsWith('+')).map((line) => line.slice(1));
    const newBodies = hunk.lines.filter((line) => !line.startsWith('-')).map((line) => line.slice(1));
    const [oldHL, newHL] = await Promise.all([
      highlightCode(oldBodies.join('\n'), lang),
      highlightCode(newBodies.join('\n'), lang),
    ]);
    let oldIdx = hunk.oldStart - 1;
    let newIdx = hunk.newStart - 1;
    let oldPos = 0;
    let newPos = 0;
    for (const raw of hunk.lines) {
      const marker = raw[0] ?? ' ';
      if (marker !== '+') {
        const tokens = oldHL[oldPos++] ?? [{ content: raw.slice(1) }];
        oldLines.set(oldIdx++, tokens);
      }
      if (marker !== '-') {
        const tokens = newHL[newPos++] ?? [{ content: raw.slice(1) }];
        newLines.set(newIdx++, tokens);
      }
    }
  }
  return { newLines, oldLines };
}

export function resolveDiffRenderVariant(opts: DiffRenderOptions): DiffRenderVariant {
  return {
    cols: opts.cols ?? 0,
    noColor: opts.noColor === true,
    maxLineWidth: opts.maxLineWidth ?? CODE_PREVIEW_MAX_LINE_WIDTH,
    syntax: opts.syntax === true,
    colorTier: opts.colorTier ?? 'auto',
    isLight: opts.isLight ?? (detectTerminalBgLightness() ?? false),
    inlineWordDiff: opts.inlineWordDiff === true,
  };
}

function resolveDiffRenderOptions(opts: DiffRenderOptions): ResolvedDiffRenderOptions {
  return {
    variant: resolveDiffRenderVariant(opts),
    headerStyle: opts.headerStyle ?? 'legacy',
  };
}

export function buildDiffRenderCacheKey(opts: DiffRenderVariant): string {
  return [
    `cols:${opts.cols}`,
    `no:${opts.noColor ? 1 : 0}`,
    `max:${opts.maxLineWidth}`,
    `syn:${opts.syntax ? 1 : 0}`,
    `tier:${opts.colorTier}`,
    `light:${opts.isLight ? 1 : 0}`,
    `wd:${opts.inlineWordDiff ? 1 : 0}`,
  ].join('|');
}

function hasHighlightCoverage(
  hunk: StructuredPatchHunk,
  newHL: HighlightLineMap | null,
  oldHL: HighlightLineMap | null,
): boolean {
  if (!newHL || !oldHL) return false;
  let oldIdx = hunk.oldStart - 1;
  let newIdx = hunk.newStart - 1;
  for (const raw of hunk.lines) {
    const marker = raw[0] ?? ' ';
    if (marker !== '+') {
      if (!oldHL.has(oldIdx)) return false;
      oldIdx++;
    }
    if (marker !== '-') {
      if (!newHL.has(newIdx)) return false;
      newIdx++;
    }
  }
  return true;
}

export function _clearDiffRenderCacheForTesting(): void {
  HUNK_RENDER_CACHE = new WeakMap<StructuredPatchHunk, HunkRenderCache>();
  DIFF_RENDER_CACHE_STATS.hits = 0;
  DIFF_RENDER_CACHE_STATS.misses = 0;
  DIFF_RENDER_CACHE_STATS.evictions = 0;
}

export function _getDiffRenderCacheStatsForTesting(): DiffRenderCacheStats {
  return { ...DIFF_RENDER_CACHE_STATS };
}

/** Emit a hunk header line in unified-diff style. The `⋮` glyph is
 *  retained as the gap indicator between hunks (matches the prior
 *  visual shorthand) and the `@@ -old,n +new,n @@` range provides the
 *  line-number context that the old separator omitted.
 *
 *  Layout: `  <gutter pad> ⋮ @@ -5,3 +5,4 @@`
 *   - On the first hunk we still emit a header (range only, no `⋮`
 *     since there is nothing to "gap" from).
 *   - Subsequent hunks get `⋮ @@ …` so the visual separator remains
 *     for callers grepping for `⋮`. */
function hunkHeader(
  hunk: StructuredPatchHunk,
  gutterW: number,
  noColor: boolean,
  isFollowup: boolean,
): string {
  const spec = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const gap = isFollowup ? '⋮ ' : '  ';
  const raw = `  ${' '.repeat(Math.max(0, gutterW - 2))} ${gap}${spec}`;
  return noColor ? raw : C.muted(raw);
}

function computeGutterWidth(hunks: readonly StructuredPatchHunk[]): number {
  let max = 1;
  for (const h of hunks) {
    const oldMax = h.oldStart + h.oldLines - 1;
    const newMax = h.newStart + h.newLines - 1;
    if (oldMax > max) max = oldMax;
    if (newMax > max) max = newMax;
  }
  // "2 spaces + line number" — we add the marker + trailing space
  // separately (via renderHunk), so gutterW here is just the numeric
  // column budget.
  return Math.max(3, String(max).length + 2);
}

/** Emit a `-`/`+` pair with intra-line word-diff emphasis. Wraps the
 *  changed spans in `chalk.inverse` so they visually pop on top of
 *  the row's delete/add bg. Skips the shiki tokenizer on purpose — mixing
 *  shiki tokens with word-level emphasis produces overlapping ANSI
 *  that fights with the palette. Phase 5 convention: syntax and
 *  inlineWordDiff are MUTUALLY EXCLUSIVE per paired line. */
function emitWordDiffPair(
  del: { body: string; parts: WordDiffPart[]; lineNum: number; kind: 'del' },
  add: { body: string; parts: WordDiffPart[]; lineNum: number; kind: 'add' },
  ctx: HunkCtx,
  out: string[],
): void {
  out.push(renderWordDiffLine(del, ctx));
  out.push(renderWordDiffLine(add, ctx));
}

function renderWordDiffLine(
  side: { body: string; parts: WordDiffPart[]; lineNum: number; kind: 'del' | 'add' },
  ctx: HunkCtx,
): string {
  const lineNumStr = padNum(side.lineNum, ctx.gutterW - 2);
  const markerStr = side.kind === 'del' ? '-' : '+';
  const bgBody = side.kind === 'del' ? ctx.palette.delBody : ctx.palette.addBody;
  const bgGutter = side.kind === 'del' ? ctx.palette.delGutter : ctx.palette.addGutter;

  // Stitch the styled body by walking the word-diff parts. Each part
  // gets the row's bg colour; the `del`/`add` parts ALSO get
  // chalk.inverse flipped on top so the change stands out.
  let styled = '';
  for (const p of side.parts) {
    // `same` parts that belong to the other side appear in del.parts
    // as `same` too (oldParts never has `add`, newParts never has
    // `del` — see word-diff.ts), so this walk is safe.
    const raw = normalizeTabs(p.text);
    if (p.kind === 'same') {
      styled += bgBody(raw);
    } else {
      // Emphasise changed span. Bold + inverse gives a clear pop on
      // both light- and dark-bg palette variants.
      styled += bgBody(chalk.bold.inverse(raw));
    }
  }

  // Clip / pad to column budget using the visible length, not the
  // styled length.
  const visible = stripAnsi(styled);
  const clippedVisLen = Math.min(visible.length, ctx.maxLineWidth);
  const trailingPad = ctx.cols > 0
    ? Math.max(0, ctx.cols - (ctx.gutterW + 2) - clippedVisLen)
    : 0;

  const gutter = bgGutter(`  ${lineNumStr} ${markerStr} `);
  const tail = trailingPad > 0 ? bgBody(' '.repeat(trailingPad)) : '';
  return gutter + styled + tail;
}

function padNum(n: number, width: number): string {
  const s = String(n);
  if (s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}

/** Right-pad the body so the bg colour fills the full row. Cols is
 *  the terminal width; offset is the gutter glyph count already
 *  emitted so the remaining budget = cols - offset. When cols ≤
 *  offset (tiny terminal) returns the body unchanged. */
function padBodyToCols(body: string, offset: number, cols: number): string {
  if (cols <= offset) return body;
  const vis = visibleLength(body);
  const budget = cols - offset;
  if (vis >= budget) return body;
  return body + ' '.repeat(budget - vis);
}

/** Truncate to max width, appending … when cut. Treats the string
 *  as Unicode code points (close enough for diff lines — real width
 *  math via wcwidth is overkill here). */
function clipLine(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** Visible length heuristic — strips ANSI SGR before counting.
 *  Imperfect for combining marks but good enough for padding. */
function visibleLength(s: string): number {
  return stripAnsi(s).length;
}
