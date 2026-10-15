// ── Claude Code-style rendering engine ──
// Ported from claude-code-fork: spinner, figures, theme, markdown, task status
// Adapted for raw ANSI TUI (no React/Ink dependency)

import chalk from 'chalk';
import { FILE_REF_RE } from './file-ref.js';

// ═══════════════════════════════════════════════════════════
// 1. FIGURES — Unicode status indicators (from constants/figures.ts)
// ═══════════════════════════════════════════════════════════

export const FIGURES = {
  // Primary status circle (macOS ⏺, fallback ●)
  BLACK_CIRCLE:    process.platform === 'darwin' ? '\u23FA' : '\u25CF', // ⏺ / ●
  BULLET_OPERATOR: '\u2219', // ∙
  TEARDROP:        '\u273B', // ✻

  // Arrows
  UP_ARROW:        '\u2191', // ↑
  DOWN_ARROW:      '\u2193', // ↓
  LIGHTNING:       '\u21AF', // ↯

  // Effort levels
  EFFORT_LOW:      '\u25CB', // ○
  EFFORT_MEDIUM:   '\u25D0', // ◐
  EFFORT_HIGH:     '\u25CF', // ●
  EFFORT_MAX:      '\u25C9', // ◉

  // Media/control
  PLAY:            '\u25B6', // ▶
  PAUSE:           '\u23F8', // ⏸

  // Diamonds (task states)
  DIAMOND_OPEN:    '\u25C7', // ◇ — running
  DIAMOND_FILLED:  '\u25C6', // ◆ — completed/failed

  // Separators & borders
  BLOCKQUOTE_BAR:  '\u258E', // ▎
  HEAVY_H:         '\u2501', // ━

  // Standard figures (cross-platform)
  TICK:            '\u2714', // ✔
  CROSS:           '\u2718', // ✘
  WARNING:         '\u26A0', // ⚠
  ELLIPSIS:        '\u2026', // …
  BULLET:          '\u2022', // •
  QUESTION:        '\u003F', // ?

  // Result bracket (tool result gutter)
  RESULT_BRACKET:  '\u23BF', // ⎿

  // Bridge spinner
  BRIDGE_FRAMES: ['\u00B7|\u00B7', '\u00B7/\u00B7', '\u00B7\u2014\u00B7', '\u00B7\\\u00B7'],
} as const;

// ═══════════════════════════════════════════════════════════
// 2. SPINNER — Claude Code animated spinner (from Spinner/)
// ═══════════════════════════════════════════════════════════

function getDefaultSpinnerChars(): string[] {
  if (process.env.TERM === 'xterm-ghostty') {
    return ['\u00B7', '\u2722', '\u2733', '\u2736', '\u273B', '*'];
  }
  return process.platform === 'darwin'
    ? ['\u00B7', '\u2722', '\u2733', '\u2736', '\u273B', '\u273D']
    // ·  ✢  ✳  ✶  ✻  ✽
    : ['\u00B7', '\u2722', '*', '\u2736', '\u273B', '\u273D'];
}

const SPINNER_CHARS = getDefaultSpinnerChars();
// Forward + reverse for ping-pong animation
const SPINNER_FRAMES = [...SPINNER_CHARS, ...[...SPINNER_CHARS].reverse()];
const REDUCED_MOTION_DOT = '\u25CF'; // ●

export interface SpinnerState {
  frame: number;
  intervalId: ReturnType<typeof setInterval> | null;
  startTime: number;
}

/**
 * Create a new spinner that animates Claude Code-style glyphs.
 * Call spinner.start() to begin, spinner.stop() to end.
 * spinner.render() returns the current frame character.
 */
export function createSpinner(intervalMs = 120) {
  const state: SpinnerState = { frame: 0, intervalId: null, startTime: 0 };

  return {
    start() {
      state.frame = 0;
      state.startTime = Date.now();
      state.intervalId = setInterval(() => { state.frame++; }, intervalMs);
    },
    stop() {
      if (state.intervalId) clearInterval(state.intervalId);
      state.intervalId = null;
    },
    /** Current spinner glyph */
    char(): string {
      return SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length]!;
    },
    /** Full rendered spinner with color */
    render(color: StatusColor = 'claude'): string {
      const ch = SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length]!;
      return applyColor(ch, color);
    },
    /** Elapsed ms since start */
    elapsed(): number {
      return Date.now() - state.startTime;
    },
    isRunning(): boolean {
      return state.intervalId !== null;
    },
    frame(): number {
      return state.frame;
    },
  };
}

// ═══════════════════════════════════════════════════════════
// 3. THEME — Color system (from utils/theme.ts)
// ═══════════════════════════════════════════════════════════

export type StatusColor =
  | 'claude'     // peach — branding, main spinner
  | 'success'    // green — completed, synced
  | 'error'      // red — failed, destructive
  | 'warning'    // yellow — caution, approval
  | 'permission' // blue — tool names, code
  | 'inactive'   // overlay1 — idle, dimmed
  | 'info'       // teal — paths, links
  | 'highlight'  // pink — services, grok
  | 'diffAdded' // green — additions
  | 'diffRemoved'; // red — removals

/** RGB color definitions — Catppuccin Mocha palette (matching Yazi theme) */
export const THEME = {
  // Core semantic
  claude:       { r: 250, g: 179, b: 135 }, // Peach #fab387
  claudeShimmer:{ r: 245, g: 194, b: 167 }, // Lighter peach
  success:      { r: 166, g: 227, b: 161 }, // Green #a6e3a1
  error:        { r: 243, g: 139, b: 168 }, // Red #f38ba8
  warning:      { r: 249, g: 226, b: 175 }, // Yellow #f9e2af
  permission:   { r: 137, g: 180, b: 250 }, // Blue #89b4fa
  inactive:     { r: 127, g: 132, b: 156 }, // Overlay1 #7f849c
  inactiveShim: { r: 147, g: 153, b: 178 }, // Overlay2 #9399b2
  info:         { r: 148, g: 226, b: 213 }, // Teal #94e2d5
  highlight:    { r: 245, g: 194, b: 231 }, // Pink #f5c2e7
  // Diff
  diffAdded:    { r: 166, g: 227, b: 161 }, // Green #a6e3a1
  diffRemoved:  { r: 243, g: 139, b: 168 }, // Red #f38ba8
  // Accent
  bashBorder:   { r: 203, g: 166, b: 247 }, // Mauve #cba6f7
  fastMode:     { r: 250, g: 179, b: 135 }, // Peach #fab387
  // Extended Catppuccin
  mauve:        { r: 203, g: 166, b: 247 }, // #cba6f7
  sky:          { r: 137, g: 220, b: 235 }, // #89dceb
  lavender:     { r: 180, g: 190, b: 254 }, // #b4befe
  text:         { r: 205, g: 214, b: 244 }, // #cdd6f4
  surface0:     { r:  49, g:  50, b:  68 }, // #313244
  surface1:     { r:  69, g:  71, b:  90 }, // #45475a
  base:         { r:  30, g:  30, b:  46 }, // #1e1e2e
} as const;

type RGB = { r: number; g: number; b: number };

/** Apply named semantic color via chalk RGB */
export function applyColor(text: string, color: StatusColor): string {
  const rgb = THEME[color] as RGB | undefined;
  if (!rgb) return text;
  return chalk.rgb(rgb.r, rgb.g, rgb.b)(text);
}

/** Interpolate between two RGB colors (0..1) */
export function interpolateColor(c1: RGB, c2: RGB, t: number): RGB {
  return {
    r: Math.round(c1.r + (c2.r - c1.r) * t),
    g: Math.round(c1.g + (c2.g - c1.g) * t),
    b: Math.round(c1.b + (c2.b - c1.b) * t),
  };
}

/** Apply RGB object to text via chalk */
export function rgbColor(text: string, rgb: RGB): string {
  return chalk.rgb(rgb.r, rgb.g, rgb.b)(text);
}

// ═══════════════════════════════════════════════════════════
// 4. TASK STATUS — Icons & colors (from tasks/taskStatusUtils.tsx)
// ═══════════════════════════════════════════════════════════

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed';

export interface TaskStatusOptions {
  isIdle?: boolean;
  awaitingApproval?: boolean;
  hasError?: boolean;
  shutdownRequested?: boolean;
}

/** Get status icon for a task (ported from taskStatusUtils) */
export function getTaskIcon(status: TaskStatus, opts?: TaskStatusOptions): string {
  const { isIdle, awaitingApproval, hasError, shutdownRequested } = opts ?? {};
  if (hasError)            return FIGURES.CROSS;
  if (awaitingApproval)    return FIGURES.QUESTION;
  if (shutdownRequested)   return FIGURES.WARNING;
  if (status === 'running') {
    if (isIdle) return FIGURES.ELLIPSIS;
    return FIGURES.PLAY;
  }
  if (status === 'completed')               return FIGURES.TICK;
  if (status === 'failed' || status === 'killed') return FIGURES.CROSS;
  return FIGURES.BULLET;
}

/** Get semantic color for a task status */
export function getTaskColor(status: TaskStatus, opts?: TaskStatusOptions): StatusColor {
  const { isIdle, awaitingApproval, hasError, shutdownRequested } = opts ?? {};
  if (hasError)          return 'error';
  if (awaitingApproval)  return 'warning';
  if (shutdownRequested) return 'warning';
  if (isIdle)            return 'inactive';
  if (status === 'completed') return 'success';
  if (status === 'failed')    return 'error';
  if (status === 'killed')    return 'warning';
  return 'inactive';
}

/** Render a task status line: "⏺ Task Name" with appropriate color */
export function renderTaskStatus(
  label: string,
  status: TaskStatus,
  opts?: TaskStatusOptions & { animate?: boolean },
): string {
  const icon = getTaskIcon(status, opts);
  const color = getTaskColor(status, opts);
  return `${applyColor(icon, color)} ${applyColor(label, status === 'running' ? 'claude' : color)}`;
}

// ═══════════════════════════════════════════════════════════
// 5. TOOL USE LOADER — Blinking circle indicator
// ═══════════════════════════════════════════════════════════

export interface ToolLoaderState {
  blinkOn: boolean;
  intervalId: ReturnType<typeof setInterval> | null;
}

/**
 * Claude Code-style tool status indicator:
 * - Unresolved (running): ⏺ blinks (dim white)
 * - Success: ⏺ solid green
 * - Error: ⏺ solid red
 */
export function createToolLoader(blinkIntervalMs = 500) {
  const state: ToolLoaderState = { blinkOn: true, intervalId: null };

  return {
    start() {
      state.blinkOn = true;
      state.intervalId = setInterval(() => { state.blinkOn = !state.blinkOn; }, blinkIntervalMs);
    },
    stop() {
      if (state.intervalId) clearInterval(state.intervalId);
      state.intervalId = null;
      state.blinkOn = true;
    },
    render(status: 'running' | 'success' | 'error'): string {
      const circle = FIGURES.BLACK_CIRCLE;
      switch (status) {
        case 'running':
          return state.blinkOn ? chalk.dim(circle) : ' ';
        case 'success':
          return applyColor(circle, 'success');
        case 'error':
          return applyColor(circle, 'error');
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════
// 6. MARKDOWN RENDERER — Terminal markdown (from utils/markdown.ts)
// ═══════════════════════════════════════════════════════════

/** Visible width accounting for CJK and ANSI codes */
function visibleWidth(str: string): number {
  // Strip ANSI
  const clean = str.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0)!;
    // CJK ranges
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0x2E80 && cp <= 0x303E) ||
      (cp >= 0x3040 && cp <= 0x33BF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x4E00 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE6F) ||
      (cp >= 0xFF01 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x20000 && cp <= 0x2FA1F)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** Pad string to target width accounting for ANSI codes */
function padEnd(str: string, targetWidth: number): string {
  const diff = targetWidth - visibleWidth(str);
  return diff > 0 ? str + ' '.repeat(diff) : str;
}

/** Pad with alignment (left/center/right) */
function padAligned(content: string, displayWidth: number, targetWidth: number, align?: string | null): string {
  const padding = Math.max(0, targetWidth - displayWidth);
  if (align === 'center') {
    const left = Math.floor(padding / 2);
    return ' '.repeat(left) + content + ' '.repeat(padding - left);
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content;
  }
  return content + ' '.repeat(padding);
}

/**
 * Render markdown table to ANSI terminal output.
 *
 * Sprint 5C follow-up (2026-04-28) — switched from ASCII `| - |` to
 * Unicode box-drawing characters so adjacent cells share continuous
 * vertical/horizontal strokes instead of looking like a sparse grid:
 *
 *     ┌──────┬────────┬───────────┐
 *     │ 번호 │   왕   │ 재위 기간 │
 *     ├──────┼────────┼───────────┤
 *     │  1   │  태조  │ 1392-1398 │
 *     └──────┴────────┴───────────┘
 *
 * Box-drawing chars (U+2500..U+257F) are width-1 in `visibleWidth`,
 * so column padding stays accurate.
 */
export function renderTable(headers: string[], rows: string[][], opts?: {
  align?: (string | null)[];
  headerStyle?: (s: string) => string;
}): string {
  const headerStyle = opts?.headerStyle ?? chalk.bold;

  // Calculate column widths
  const colWidths = headers.map((h, i) => {
    let max = visibleWidth(h);
    for (const row of rows) {
      max = Math.max(max, visibleWidth(row[i] ?? ''));
    }
    return Math.max(max, 3);
  });

  // Build a horizontal border using the supplied corner/junction chars.
  // Each segment spans `colWidth + 2` (1-cell gutter on each side of
  // the cell content) so it lines up with the data rows rendered below.
  const buildBorder = (left: string, mid: string, right: string): string => {
    let out = left;
    colWidths.forEach((w, i) => {
      out += '─'.repeat(w + 2);
      out += i < colWidths.length - 1 ? mid : right;
    });
    return out;
  };

  const lines: string[] = [];
  lines.push(buildBorder('┌', '┬', '┐'));

  // Header
  let headerLine = '│ ';
  headers.forEach((h, i) => {
    const styled = headerStyle(h);
    const display = visibleWidth(h);
    headerLine += padAligned(styled, display, colWidths[i]!, opts?.align?.[i]) + ' │ ';
  });
  lines.push(headerLine.trimEnd());

  lines.push(buildBorder('├', '┼', '┤'));

  // Data rows
  for (const row of rows) {
    let line = '│ ';
    row.forEach((cell, i) => {
      const display = visibleWidth(cell);
      line += padAligned(cell, display, colWidths[i]!, opts?.align?.[i]) + ' │ ';
    });
    lines.push(line.trimEnd());
  }

  lines.push(buildBorder('└', '┴', '┘'));

  return lines.join('\n');
}

/**
 * Simple markdown-to-ANSI converter.
 * Handles: **bold**, *italic*, `code`, headings, lists, blockquotes, tables.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;

    // Headings
    if (line.startsWith('### ')) {
      result.push(chalk.bold(line.slice(4)));
      continue;
    }
    if (line.startsWith('## ')) {
      result.push(chalk.bold(line.slice(3)));
      continue;
    }
    if (line.startsWith('# ')) {
      result.push(chalk.bold.italic.underline(line.slice(2)));
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const bar = chalk.dim(FIGURES.BLOCKQUOTE_BAR);
      result.push(`${bar} ${chalk.italic(applyInlineStyles(line.slice(2)))}`);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|={3,}|\*{3,})$/.test(line.trim())) {
      result.push(chalk.dim(FIGURES.HEAVY_H.repeat(40)));
      continue;
    }

    // List items
    if (/^\s*[-*]\s/.test(line)) {
      const indent = line.match(/^(\s*)/)?.[1] ?? '';
      const content = line.replace(/^\s*[-*]\s/, '');
      result.push(`${indent}${chalk.dim('-')} ${applyInlineStyles(content)}`);
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s/.test(line)) {
      const match = line.match(/^(\s*)(\d+)\.\s(.*)/);
      if (match) {
        result.push(`${match[1]}${chalk.dim(match[2] + '.')} ${applyInlineStyles(match[3]!)}`);
        continue;
      }
    }

    // Table detection — tolerate leading whitespace so tables nested
    // inside lists (LLM output often indents them) still render instead
    // of leaking literal `|` pipes into the log.
    const isTableRow = (l?: string) => !!l && /^\s*\|/.test(l);
    if (isTableRow(line) && isTableRow(lines[i + 1])) {
      const tableLines: string[] = [line.trimStart()];
      while (isTableRow(lines[i + 1])) {
        i++;
        tableLines.push(lines[i]!.trimStart());
      }
      result.push(parseAndRenderTable(tableLines));
      continue;
    }

    // Regular line with inline styles
    result.push(applyInlineStyles(line));
  }

  return result.join('\n');
}

/** Apply inline markdown styles: **bold**, *italic*, `code`, plus
 *  underscore variants (`__bold__`, `_italic_`) and bare file refs
 *  (`src/foo.ts`). File refs are styled like inline code spans so the
 *  two are visually interchangeable — writing `src/foo.ts` in
 *  backticks or as bare prose looks the same, which matches how a
 *  Telegram/openclaw-style renderer wraps them in <code>.
 *
 *  Inline code stashed up front as placeholders so later passes (bold,
 *  italic, file-ref) don't mangle things like `foo_bar` or `**literal**`
 *  that are intentionally inside a code span. */
function applyInlineStyles(text: string): string {
  const stash: string[] = [];
  const saveCode = (rendered: string): string => {
    stash.push(rendered);
    return `\u0000C${stash.length - 1}\u0000`;
  };

  // 1. Inline code spans — stash their rendered form so subsequent
  //    passes can't touch the contents.
  text = text.replace(/`([^`]+)`/g, (_, code) =>
    saveCode(applyColor(code, 'permission'))
  );

  // 2. Bare file references (README.md, src/server.py, etc.) get the
  //    same treatment as inline code. FILE_REF_RE has the `g` flag so
  //    lastIndex must be reset before each call — defensive since
  //    `.replace` resets it but exported module-level regexes can
  //    leak state if anyone calls `.exec()` on them elsewhere.
  FILE_REF_RE.lastIndex = 0;
  text = text.replace(FILE_REF_RE, (_m, prefix: string, filename: string) =>
    `${prefix}${saveCode(applyColor(filename, 'permission'))}`);

  // 3. Emphasis. Order matters — double-marker first so **x** doesn't
  //    get eaten as nested italic. Underscore variants mirror asterisk
  //    variants so `_italic_` and `__bold__` also render.
  text = text.replace(/\*\*([^*]+)\*\*/g, (_, bold) => chalk.bold(bold));
  text = text.replace(/__([^_]+)__/g, (_, bold) => chalk.bold(bold));
  text = text.replace(/\*([^*]+)\*/g, (_, italic) => chalk.italic(italic));
  // For `_italic_` we require a non-word boundary so `foo_bar_baz`
  // stays intact — identifiers with underscores are everywhere in
  // the kinds of text this module renders.
  text = text.replace(/(^|[^_\w])_([^_\n]+?)_(?!_|\w)/g,
    (_m, prefix: string, italic: string) => `${prefix}${chalk.italic(italic)}`);
  text = text.replace(/~~([^~]+)~~/g, (_, s) => chalk.strikethrough(s));

  // 4. Restore stashed code/file-ref renders.
  text = text.replace(/\u0000C(\d+)\u0000/g, (_m, idx: string) =>
    stash[Number(idx)] ?? '');

  return text;
}

/** Parse markdown table lines and render */
function parseAndRenderTable(lines: string[]): string {
  const parseRow = (line: string) =>
    line.split('|').slice(1, -1).map(cell => cell.trim());

  if (lines.length < 2) return lines.join('\n');

  const headers = parseRow(lines[0]!);
  // Skip separator line (line[1])
  const rows = lines.slice(2).map(parseRow);

  // Detect alignment from separator
  const sepCells = parseRow(lines[1]!);
  const align = sepCells.map(cell => {
    const trimmed = cell.trim();
    if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
    if (trimmed.endsWith(':')) return 'right';
    return 'left';
  });

  return renderTable(
    headers.map(h => applyInlineStyles(h)),
    rows.map(r => r.map(c => applyInlineStyles(c))),
    { align },
  );
}

// ═══════════════════════════════════════════════════════════
// 7. TOOL OUTPUT GROUPING — Visual separators for tool calls
// ═══════════════════════════════════════════════════════════

/**
 * Render a tool call header like Claude Code:
 * ⏺ ToolName(description)
 */
export function singleLineToolHeaderText(text: string): string {
  return text.replace(/[ \t]*(?:\r\n|\r|\n|\u2028|\u2029)[ \t]*/g, ' ↵ ');
}

export function toolHeader(
  toolName: string,
  description: string,
  status: 'running' | 'success' | 'error' = 'running',
): string {
  const circle = FIGURES.BLACK_CIRCLE;
  let icon: string;
  switch (status) {
    case 'running': icon = chalk.dim(circle); break;
    case 'success': icon = applyColor(circle, 'success'); break;
    case 'error':   icon = applyColor(circle, 'error'); break;
  }
  const name = chalk.bold(toolName);
  const desc = description ? chalk.dim(`(${singleLineToolHeaderText(description)})`) : '';
  return `${icon} ${name}${desc}`;
}

/**
 * Render tool result with indented gutter bracket like Claude Code:
 *   ⎿  result content
 */
export function toolResult(content: string, indent = 2): string {
  const prefix = ' '.repeat(indent) + chalk.dim(FIGURES.RESULT_BRACKET) + '  ';
  return content
    .split('\n')
    .map((line, i) => i === 0 ? `${prefix}${line}` : `${' '.repeat(indent + 3)}${line}`)
    .join('\n');
}

/**
 * Render a complete tool block (header + result):
 * ⏺ Bash(ls -la)
 *   ⎿  file1.txt
 *      file2.txt
 */
export function toolBlock(
  toolName: string,
  description: string,
  resultContent: string,
  status: 'success' | 'error' = 'success',
): string {
  return [
    toolHeader(toolName, description, status),
    toolResult(resultContent),
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// 8. SPINNER VERBS — Creative loading messages
// ═══════════════════════════════════════════════════════════

export const SPINNER_VERBS = [
  'Accomplishing', 'Architecting', 'Baking', 'Boogieing',
  'Calculating', 'Clauding', 'Cogitating', 'Composing',
  'Computing', 'Concocting', 'Cooking', 'Crafting',
  'Creating', 'Crunching', 'Crystallizing', 'Deciphering',
  'Deliberating', 'Doing', 'Enchanting', 'Fermenting',
  'Forging', 'Generating', 'Harmonizing', 'Hashing',
  'Hatching', 'Ideating', 'Imagining', 'Inferring',
  'Manifesting', 'Mulling', 'Musing', 'Noodling',
  'Orchestrating', 'Percolating', 'Pondering', 'Processing',
  'Puzzling', 'Ruminating', 'Simmering', 'Sketching',
  'Spinning', 'Synthesizing', 'Thinking', 'Tinkering',
  'Transmuting', 'Vibing', 'Working', 'Wrangling',
];

/** Pick a random spinner verb */
export function randomVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!;
}

/**
 * Render animated loading line: "✢ Thinking…"
 * Returns a function that produces the current frame string.
 */
export function loadingMessage(verb?: string): string {
  const v = verb ?? randomVerb();
  return `${chalk.bold(v)}${chalk.dim('\u2026')}`; // verb…
}

// ═══════════════════════════════════════════════════════════
// 9. STALLED ANIMATION — Color transitions
// ═══════════════════════════════════════════════════════════

const STALL_DETECT_MS = 3000;
const STALL_RAMP_MS = 2000;
const ERROR_RED: RGB = { r: 171, g: 43, b: 63 };

/**
 * Compute stalled intensity (0..1) based on time since last token.
 * After 3s of no tokens, ramps to red over 2s.
 */
export function stalledIntensity(lastTokenMs: number, nowMs: number): number {
  const idle = nowMs - lastTokenMs;
  if (idle < STALL_DETECT_MS) return 0;
  return Math.min(1, (idle - STALL_DETECT_MS) / STALL_RAMP_MS);
}

/** Get stalled-aware color for spinner */
export function stalledColor(baseColor: StatusColor, intensity: number): string {
  if (intensity <= 0) return '';
  const base = THEME[baseColor] as RGB;
  if (!base) return '';
  const interp = interpolateColor(base, ERROR_RED, intensity);
  return `\x1b[38;2;${interp.r};${interp.g};${interp.b}m`;
}

// ═══════════════════════════════════════════════════════════
// 10. CONVENIENCE EXPORTS — Pre-built rendering helpers
// ═══════════════════════════════════════════════════════════

/** Render success line: ✔ message (green) */
export function successLine(msg: string): string {
  return `${applyColor(FIGURES.TICK, 'success')} ${applyColor(msg, 'success')}`;
}

/** Render error line: ✘ message (red) */
export function errorLine(msg: string): string {
  return `${applyColor(FIGURES.CROSS, 'error')} ${applyColor(msg, 'error')}`;
}

/** Render warning line: ⚠ message (amber) */
export function warningLine(msg: string): string {
  return `${applyColor(FIGURES.WARNING, 'warning')} ${applyColor(msg, 'warning')}`;
}

/** Render info line: ▶ message */
export function infoLine(msg: string): string {
  return `${applyColor(FIGURES.PLAY, 'info')} ${msg}`;
}

/** Render a section header with heavy horizontal line */
export function sectionHeader(title: string, width = 60): string {
  const line = chalk.dim(FIGURES.HEAVY_H.repeat(width));
  return `${line}\n  ${chalk.bold(title)}\n${line}`;
}

/** Render progress indicator: ⏺ label (with blink state) */
export function progressIndicator(label: string, blinkOn = true): string {
  const circle = blinkOn ? chalk.dim(FIGURES.BLACK_CIRCLE) : ' ';
  return `${circle} ${chalk.dim(label)}`;
}
