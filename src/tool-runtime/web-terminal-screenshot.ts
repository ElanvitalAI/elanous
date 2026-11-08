import type { LLMToolSpec } from '../llm/tool-spec.js';
// WT-C-2 — web-terminal screenshot LLM tool.
//
// Renders the visible buffer of a PreviewTerminal (xterm-headless) to
// PNG so an agent can inspect the terminal *visually* — cursor, color
// highlight, box-drawing layout — instead of only the ANSI string the
// existing WebTerminalSnapshot returns. Useful for debugging
// fullscreen TUIs (vim · htop · lazygit · tmux pane border) where
// stripped ANSI loses essential information.
//
// Pipeline:
//   1. Walk `term.buffer.active` cell-by-cell, emit a self-contained
//      SVG (one <rect> per non-default bg cell + one <text> per
//      non-blank glyph + bold/italic + cursor inversion).
//   2. Pipe the SVG through `sharp` (already in deps) to produce a
//      base64 PNG.
//   3. Tool result includes both the PNG bytes and a small metadata
//      block so the caller can place it / hand to vision input.
//
// Why not new dependencies: sharp 0.34 is already vendored for the
// daemon, and resvg-js / canvas would each add a native build step.
// The SVG → PNG conversion is the standard sharp use case.

import type { ToolRuntime } from './types.js';
import { lookupPreviewTerminal } from '../web-terminal/preview-tap-registry.js';

import { debug } from '../debug/log.js';
import type { WebTerminalDispatchOpts } from './web-terminal-runtimes.js';
import {
  isVisionCapableModel,
  brandLikelyVisionCapable,
  type LlmBrand,
} from '../llm-vision-capability.js';

interface ScreenshotArgs {
  /** Optional — auto-injected from the current chat session when
   *  omitted (Image-pipeline followup #1, 2026-05-05). */
  sessionId?: string;
  terminalId: string;
  /** Cell pixel scale. 1 = 8×16 per cell (small), 2 = 16×32 (default,
   *  reads well at 1× display), 3 = 24×48 (high-DPI / vision-clarity). */
  scale?: number;
  /** U21 (2026-05-18) — Optional row range to capture (visible
   *  viewport rows, 0-indexed, inclusive). Out-of-range values are
   *  clamped; rowEnd < rowStart returns the full viewport. Used by
   *  popup chat to narrow the screenshot to user-selected region —
   *  token cost ↓ + LLM 시선 narrow. */
  region?: {
    rowStart: number;
    rowEnd: number;
  };
}

interface ScreenshotResult {
  sessionId: string;
  terminalId: string;
  cols: number;
  rows: number;
  width: number;
  height: number;
  mediaType: 'image/png';
  dataB64: string;
}

// ── Color resolution ────────────────────────────────────────────────

// Standard 16 ANSI colors (Tango-ish · matches xterm default theme).
const PALETTE_16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00',
  '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00',
  '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];

// 256-color cube + grayscale ramp.
function palette256(idx: number): string {
  if (idx < 16) return PALETTE_16[idx]!;
  if (idx < 232) {
    // 6×6×6 cube starting at 16.
    const i = idx - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const map = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
    return rgbHex(map(r), map(g), map(b));
  }
  // Grayscale 232-255.
  const v = 8 + (idx - 232) * 10;
  return rgbHex(v, v, v);
}

function rgbHex(r: number, g: number, b: number): string {
  const h = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${h(r & 0xff)}${h(g & 0xff)}${h(b & 0xff)}`;
}

interface CellColors {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

const DEFAULT_FG = '#cccccc';
const DEFAULT_BG = '#000000';

function cellColors(cell: import('@xterm/headless').IBufferCell, inverse: boolean): CellColors {
  let fg: string | null = null;
  let bg: string | null = null;
  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    fg = rgbHex((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  } else if (cell.isFgPalette()) {
    fg = palette256(cell.getFgColor());
  }
  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    bg = rgbHex((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  } else if (cell.isBgPalette()) {
    bg = palette256(cell.getBgColor());
  }
  // Inverse / cursor cell — swap fg/bg, falling back to defaults so
  // the cell stays visible.
  const cellInverse = cell.isInverse() ? !inverse : inverse;
  if (cellInverse) {
    const tmp = fg ?? DEFAULT_FG;
    fg = bg ?? DEFAULT_BG;
    bg = tmp;
  }
  return {
    fg,
    bg,
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
  };
}

// ── SVG escape ──────────────────────────────────────────────────────

function svgEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Renderer ────────────────────────────────────────────────────────

const CELL_W_BASE = 8;
const CELL_H_BASE = 16;

interface TerminalLike {
  cols: number;
  rows: number;
  buffer: { active: import('@xterm/headless').IBuffer };
}

export interface RenderSvgOpts {
  scale?: number;
  /** Fallback fg color when cell has no explicit color. */
  defaultFg?: string;
  /** Fallback bg fill (whole-canvas <rect>). */
  defaultBg?: string;
  /** U21 — restrict render to row range (viewport-local · 0-indexed ·
   *  inclusive). Out-of-range clamped; invalid/empty → full viewport. */
  rowRange?: { start: number; end: number };
}

export function renderTerminalSvg(term: TerminalLike, opts: RenderSvgOpts = {}): {
  svg: string;
  cols: number;
  rows: number;
  width: number;
  height: number;
} {
  const scale = Math.max(1, Math.min(4, Math.floor(opts.scale ?? 2)));
  const cellW = CELL_W_BASE * scale;
  const cellH = CELL_H_BASE * scale;
  const cols = term.cols;
  const totalRows = term.rows;
  // Clamp row range — invalid/empty falls back to full viewport.
  const reqStart = opts.rowRange ? Math.floor(opts.rowRange.start) : 0;
  const reqEnd = opts.rowRange ? Math.floor(opts.rowRange.end) : totalRows - 1;
  const validRange = opts.rowRange && reqEnd >= reqStart;
  const startRow = validRange ? Math.max(0, Math.min(totalRows - 1, reqStart)) : 0;
  const endRow = validRange ? Math.max(0, Math.min(totalRows - 1, reqEnd)) : totalRows - 1;
  const renderRows = endRow - startRow + 1;
  const width = cols * cellW;
  const height = renderRows * cellH;
  const fontSize = cellH * 0.78; // monospace baseline-friendly ratio
  const baseY = cellH * 0.78;
  const fg = opts.defaultFg ?? DEFAULT_FG;
  const bg = opts.defaultBg ?? DEFAULT_BG;
  const active = term.buffer.active;
  const cellRef = active.getNullCell();
  const cursorX = active.cursorX;
  const cursorY = active.cursorY;

  const rectFrags: string[] = [];
  const textFrags: string[] = [];

  for (let y = startRow; y <= endRow; y++) {
    const line = active.getLine(active.viewportY + y);
    if (!line) continue;
    const renderY = (y - startRow) * cellH;
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x, cellRef);
      if (!cell) continue;
      const w = cell.getWidth();
      if (w === 0) continue;
      const ch = cell.getChars() || ' ';
      const isCursor = y === cursorY && x === cursorX;
      const colors = cellColors(cell, isCursor);

      // Background rect: emit only when non-default. Cursor cell with
      // no explicit bg also gets a fill so the user sees the cursor.
      const cellW2 = cellW * Math.max(1, w);
      if (colors.bg) {
        rectFrags.push(
          `<rect x="${x * cellW}" y="${renderY}" width="${cellW2}" height="${cellH}" fill="${colors.bg}"/>`,
        );
      } else if (isCursor) {
        rectFrags.push(
          `<rect x="${x * cellW}" y="${renderY}" width="${cellW2}" height="${cellH}" fill="${fg}"/>`,
        );
      }

      // Glyph: skip blank for compactness.
      if (ch.trim().length === 0) continue;
      const textColor = colors.fg ?? (isCursor ? bg : fg);
      const weight = colors.bold ? ' font-weight="bold"' : '';
      const style = colors.italic ? ' font-style="italic"' : '';
      const deco = colors.underline ? ' text-decoration="underline"' : '';
      textFrags.push(
        `<text x="${x * cellW}" y="${renderY + baseY}" fill="${textColor}"${weight}${style}${deco}>${svgEscape(ch)}</text>`,
      );
    }
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="JetBrainsMono Nerd Font,JetBrains Mono,Menlo,Consolas,monospace" font-size="${fontSize.toFixed(1)}">`,
    `<rect width="${width}" height="${height}" fill="${bg}"/>`,
    ...rectFrags,
    ...textFrags,
    '</svg>',
  ].join('');

  return { svg, cols, rows: renderRows, width, height };
}

// ── PNG conversion via sharp ────────────────────────────────────────

let sharpModulePromise: Promise<typeof import('sharp')> | null = null;
async function loadSharp(): Promise<typeof import('sharp')> {
  if (!sharpModulePromise) {
    sharpModulePromise = import('sharp') as unknown as Promise<typeof import('sharp')>;
  }
  return sharpModulePromise;
}

export async function svgToPngBuffer(svg: string): Promise<Buffer> {
  const sharpMod = await loadSharp();
  const sharp = (sharpMod as unknown as { default?: typeof import('sharp') }).default
    ?? (sharpMod as unknown as typeof import('sharp'));
  return sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
}

// ── LLM tool ────────────────────────────────────────────────────────

export function buildWebTerminalScreenshotTool(): LLMToolSpec {
  return {
    name: 'WebTerminalScreenshot',
    description: [
      'Render the visible buffer of a web terminal to a PNG image.',
      'Use to inspect TUIs (vim, htop, lazygit, tmux) where the plain',
      'ANSI string from WebTerminalSnapshot loses cursor / color /',
      'box-drawing fidelity. Returns base64 PNG bytes — pair with a',
      'vision-capable model or a downstream image input.',
      'sessionId is auto-injected from the current chat session — leave',
      'it out of args. Override only when targeting a different session.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'OPTIONAL — auto-injected from the current chat session.',
        },
        terminalId: { type: 'string', description: 'terminalId from WebTerminalList.' },
        scale: {
          type: 'number',
          description: 'Cell pixel scale. 1 (8×16) · 2 (default) · 3 (high-DPI). Clamped to 1..4.',
          default: 2,
        },
        region: {
          type: 'object',
          description: 'OPTIONAL — restrict capture to viewport row range (0-indexed, inclusive). Out-of-range clamped.',
          properties: {
            rowStart: { type: 'number' },
            rowEnd: { type: 'number' },
          },
          required: ['rowStart', 'rowEnd'],
        },
      },
      required: ['terminalId'],
    },
  };
}

export async function dispatchWebTerminalScreenshot(
  args: Record<string, unknown>,
  opts?: WebTerminalDispatchOpts,
): Promise<ScreenshotResult> {
  const fromArgs = String(args.sessionId ?? '').trim();
  const fromOpts = String(opts?.sessionId ?? '').trim();
  const sessionId = fromArgs || fromOpts;
  const terminalId = String(args.terminalId ?? '').trim();
  if (!sessionId) {
    throw new Error('WebTerminalScreenshot: sessionId required (args.sessionId empty and no ctx.sessionId)');
  }
  if (!terminalId) throw new Error('WebTerminalScreenshot: terminalId required');
  const scale = typeof args.scale === 'number' ? args.scale : 2;
  const regionArg = args.region as { rowStart?: unknown; rowEnd?: unknown } | undefined;
  const rowRange = regionArg
    && typeof regionArg.rowStart === 'number'
    && typeof regionArg.rowEnd === 'number'
    ? { start: regionArg.rowStart, end: regionArg.rowEnd }
    : undefined;

  const pt = lookupPreviewTerminal(sessionId, terminalId);
  if (!pt) throw new Error(`WebTerminalScreenshot: unknown terminal ${terminalId}`);

  // PreviewTerminal exposes the underlying xterm-headless via .term
  // (used by render() etc internally). Using the same path keeps SGR /
  // cursor state consistent with WebTerminalSnapshot.
  const term = (pt as unknown as { term: TerminalLike }).term;
  const { svg, cols, rows, width, height } = renderTerminalSvg(term, { scale, rowRange });
  if (debug.enabled) {
    debug.log('webterm.tool.screenshot', 'render', { sessionId, terminalId, cols, rows, scale, rowRange });
  }
  const png = await svgToPngBuffer(svg);
  const dataB64 = png.toString('base64');
  if (debug.enabled) {
    debug.log('webterm.tool.screenshot', 'png', {
      sessionId, terminalId, bytes: png.length, b64Len: dataB64.length,
    });
  }
  return {
    sessionId,
    terminalId,
    cols,
    rows,
    width,
    height,
    mediaType: 'image/png',
    dataB64,
  };
}

export function webTerminalScreenshotRuntime(): ToolRuntime<ScreenshotArgs, { output: string }> {
  return {
    id: 'web_terminal_screenshot',
    spec: buildWebTerminalScreenshotTool(),
    async run(args, ctx) {
      const sessionId = (ctx as { sessionId?: string } | undefined)?.sessionId;
      const result = await dispatchWebTerminalScreenshot(
        args as unknown as Record<string, unknown>,
        sessionId ? { sessionId } : undefined,
      );
      return { output: JSON.stringify(result) };
    },
  };
}

// ── U22·a — text/image/auto LLM context dispatch ────────────────────
//
// `dispatchWebTerminalScreenshot` 가 image-only LLM context inject path 의
// 첫 cut (U20) 이었다면, `dispatchTerminalContext` 는 mode-aware unified
// entrypoint — image · text · auto 셋 다 처리. server.ts:1311 의 ACP hook
// 가 본 함수를 호출. iOS 측 `_meta.elanous.terminalContext.mode` 가
// requested mode (default 'image' · U22·b 에서 'auto' 으로 swap 예정).
//
// 왜 unified entrypoint:
//   - `lookupPreviewTerminal` + term reference 가 한 번만 (auto heuristic
//     이 같은 term.buffer.active.type 을 봐야 하므로).
//   - 'auto' 의 결정 reason (altScreen) 을 result 에 surface — debug 로그
//     + 향후 iOS 측 chip ("text mode 사용중 · TUI 자동 감지 시 image") 용.

export type TerminalContextMode = 'image' | 'text' | 'auto';

/**
 * U22·c (2026-05-18) — Optional caller hint about the active LLM (brand
 * + optional model id). When `mode === 'auto'`, daemon uses this for
 * vision capability check — vision-incapable provider 자동 text fallback.
 * brand 없거나 unknown → 휴리스틱 그대로 (alt-screen).
 */
export interface TerminalContextLlmHint {
  brand?: LlmBrand;
  model?: string;
}

export interface TerminalContextArgs {
  sessionId: string;
  terminalId: string;
  /** Requested mode. 'auto' 또는 missing → alt-screen 휴리스틱. */
  mode?: TerminalContextMode;
  /** Optional viewport row range (0-indexed, inclusive). U21 region. */
  region?: { rowStart: number; rowEnd: number };
  /** Image-mode cell pixel scale (clamped 1..4). */
  scale?: number;
  /** U22·c — LLM hint for auto-mode vision capability check. */
  llmHint?: TerminalContextLlmHint;
}

export type TerminalContextResult =
  | {
      kind: 'image';
      sessionId: string;
      terminalId: string;
      cols: number;
      rows: number;
      width: number;
      height: number;
      mediaType: 'image/png';
      dataB64: string;
      /** True if PTY is in alternate-screen (TUI like vim/btop/htop). */
      alternateScreen: boolean;
      /** Was the mode chosen by caller or by 'auto' heuristic? */
      autoDecided: boolean;
    }
  | {
      kind: 'text';
      sessionId: string;
      terminalId: string;
      cols: number;
      rows: number;
      /** Newline-joined rendered text (already de-ANSI'd by xterm.js). */
      text: string;
      alternateScreen: boolean;
      autoDecided: boolean;
    };

/**
 * Auto-mode heuristic — 우선순위:
 *   1. Vision capability check (U22·c) — caller 가 LLM hint 줬고 vision-
 *      incapable 면 alt-screen 무시하고 text 강제 (image 보내봐야 받지
 *      못하니 token 낭비 + 일부 provider 는 400 에러).
 *   2. Alt-screen 휴리스틱 (U22·a) — TUI (vim/btop/htop/lazygit 등 alt
 *      buffer 사용) 면 image (full fidelity 필요), normal buffer (plain
 *      shell output: ls·git log·build error 등) 면 text (token cost ↓).
 *
 * 향후 polish (U22·d 후속): foreground process name · ANSI density 임계.
 */
function decideAutoMode(term: TerminalLike, llmHint?: TerminalContextLlmHint): 'image' | 'text' {
  // 1) Vision capability check
  if (llmHint && llmHint.brand) {
    const visionOk = llmHint.model
      ? isVisionCapableModel(llmHint.brand, llmHint.model, 'userMessage')
      : brandLikelyVisionCapable(llmHint.brand);
    if (!visionOk) return 'text';
  }
  // 2) Alt-screen 휴리스틱
  try {
    return term.buffer.active.type === 'alternate' ? 'image' : 'text';
  } catch {
    return 'image'; // 안전 default — 정보 누락보다 image
  }
}

export async function dispatchTerminalContext(args: TerminalContextArgs): Promise<TerminalContextResult> {
  const sessionId = String(args.sessionId ?? '').trim();
  const terminalId = String(args.terminalId ?? '').trim();
  if (!sessionId) throw new Error('TerminalContext: sessionId required');
  if (!terminalId) throw new Error('TerminalContext: terminalId required');
  const pt = lookupPreviewTerminal(sessionId, terminalId);
  if (!pt) throw new Error(`TerminalContext: unknown terminal ${terminalId}`);
  const term = (pt as unknown as { term: TerminalLike }).term;
  const altScreen = (() => {
    try { return term.buffer.active.type === 'alternate'; } catch { return false; }
  })();

  const requested = args.mode;
  const autoDecided = requested !== 'image' && requested !== 'text';
  const mode: 'image' | 'text' = autoDecided ? decideAutoMode(term, args.llmHint) : requested;

  const rowRange = args.region
    && typeof args.region.rowStart === 'number'
    && typeof args.region.rowEnd === 'number'
    ? { start: args.region.rowStart, end: args.region.rowEnd }
    : undefined;

  if (mode === 'image') {
    const scale = typeof args.scale === 'number' ? args.scale : 2;
    const { svg, cols, rows, width, height } = renderTerminalSvg(term, { scale, rowRange });
    const png = await svgToPngBuffer(svg);
    const dataB64 = png.toString('base64');
    if (debug.enabled) {
      debug.log('webterm.context', 'image', {
        sessionId, terminalId, cols, rows, scale, rowRange,
        altScreen, autoDecided, b64Len: dataB64.length,
      });
    }
    return {
      kind: 'image',
      sessionId, terminalId,
      cols, rows, width, height,
      mediaType: 'image/png',
      dataB64,
      alternateScreen: altScreen,
      autoDecided,
    };
  }

  // text mode — translateToString(true) 로 trailing-trimmed rendered text
  // 추출. xterm.js 가 이미 ANSI escape (color · cursor positioning) 모두
  // processed → plain string 만 나옴. 추가 strip 불필요.
  const active = term.buffer.active;
  const totalRows = term.rows;
  const reqStart = rowRange ? Math.floor(rowRange.start) : 0;
  const reqEnd = rowRange ? Math.floor(rowRange.end) : totalRows - 1;
  const validRange = rowRange != null && reqEnd >= reqStart;
  const startRow = validRange ? Math.max(0, Math.min(totalRows - 1, reqStart)) : 0;
  const endRow = validRange ? Math.max(0, Math.min(totalRows - 1, reqEnd)) : totalRows - 1;
  const lines: string[] = [];
  for (let y = startRow; y <= endRow; y++) {
    const line = active.getLine(active.viewportY + y);
    lines.push(line ? line.translateToString(true) : '');
  }
  // Trailing blank lines 제거 (prompt 만 있는 화면의 빈 줄 절약).
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const text = lines.join('\n');
  if (debug.enabled) {
    debug.log('webterm.context', 'text', {
      sessionId, terminalId,
      cols: term.cols, rows: lines.length,
      bytes: text.length,
      altScreen, autoDecided, rowRange,
    });
  }
  return {
    kind: 'text',
    sessionId, terminalId,
    cols: term.cols,
    rows: lines.length,
    text,
    alternateScreen: altScreen,
    autoDecided,
  };
}
