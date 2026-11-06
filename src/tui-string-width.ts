/** Strip ANSI escape codes from a string */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Return an ANSI SGR-preserving slice by terminal columns. Wide graphemes
 *  crossing a slice edge become spaces so the neighboring overlay keeps
 *  ownership of those cells. */
export function sliceAnsiByColumns(text: string, start: number, end: number): string {
  const lo = Math.max(0, start);
  const hi = Math.max(lo, end);
  const sgr = /\x1b\[[0-9;]*m/g;
  let out = '';
  let activeSgr = '';
  let offset = 0;
  let column = 0;
  let started = false;
  let match: RegExpExecArray | null;
  const appendText = (chunk: string): void => {
    for (const grapheme of graphemeSegments(chunk)) {
      const width = Math.max(0, visibleWidth(grapheme));
      const nextColumn = column + width;
      const overlapStart = Math.max(column, lo);
      const overlapEnd = Math.min(nextColumn, hi);
      if (overlapEnd > overlapStart) {
        if (!started) {
          out += activeSgr;
          started = true;
        }
        out += overlapStart === column && overlapEnd === nextColumn
          ? grapheme
          : ' '.repeat(overlapEnd - overlapStart);
      }
      column = nextColumn;
    }
  };
  while ((match = sgr.exec(text)) !== null) {
    if (column >= hi) break;
    if (match.index > offset) appendText(text.slice(offset, match.index));
    const sequence = match[0];
    if (sequence === '\x1b[m' || sequence === '\x1b[0m') activeSgr = '';
    else activeSgr += sequence;
    if (started) out += sequence;
    offset = match.index + sequence.length;
  }
  if (column < hi && offset < text.length) appendText(text.slice(offset));
  if (started && activeSgr) out += '\x1b[0m';
  return out;
}

/**
 * Handles ANSI codes (0 width), CJK / fullwidth chars (2 width),
 * Nerd Font PUA glyphs (2 width), and — via `Bun.stringWidth` when
 * available — emoji ZWJ sequences, combining marks, and flag
 * sequences (all grapheme-aware).
 *
 * Port notes: claude-code-fork's `ink/stringWidth.ts` uses
 * `Bun.stringWidth` as the preferred path and falls back to a
 * grapheme segmenter + east-asian-width table. We use the same
 * preference but the fallback keeps our existing Nerd-Font PUA
 * handling since codex / claude-code don't need it.
 */
export function visibleWidth(s: string): number {
  const plain = stripAnsi(s);

  // Bun runtime — Unicode-correct grapheme width including emoji
  // ZWJ, combining marks, and flag sequences. This is the hot path
  // under monad-agent's normal runtime.
  if (typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function') {
    const w = Bun.stringWidth(plain);
    // Bun.stringWidth does not know about Nerd Font PUA (E000-F8FF
    // etc.) which our theme assumes are double-width. Add the PUA
    // correction on top.
    return w + nerdFontPuaExtra(plain);
  }

  // Legacy fallback (non-Bun runtime — tests, sandboxed embedding):
  // original monad-agent behaviour, code-point oriented. Misses emoji
  // ZWJ and combining marks but matches what pre-Phase 3 did.
  let w = 0;
  for (let i = 0; i < plain.length; i++) {
    const cp = plain.codePointAt(i)!;
    if (cp > 0xFFFF) { i++; } // skip surrogate pair low half
    if (isWide(cp)) { w += 2; }
    else { w += 1; }
  }
  return w;
}

/** Count the extra columns Nerd Font PUA glyphs add on top of what
 *  `Bun.stringWidth` reports (it reports them as 1 — correct per
 *  Unicode, but our Nerd Font theme actually renders them double-
 *  wide). */
function nerdFontPuaExtra(s: string): number {
  let extra = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    if (cp > 0xFFFF) { i++; }
    if (isNerdFontPua(cp)) extra++;
  }
  return extra;
}

function isNerdFontPua(cp: number): boolean {
  if (cp >= 0xE000  && cp <= 0xF8FF)  return true;   // BMP PUA
  if (cp >= 0xF0000 && cp <= 0xFFFFF) return true;   // Supplementary PUA-A (Nerd Font v3)
  if (cp >= 0x100000 && cp <= 0x10FFFF) return true;  // Supplementary PUA-B
  return false;
}

/** Check if a codepoint renders as double-width in terminal */
function isWide(cp: number): boolean {
  // Nerd Font PUA ranges (most are double-width in patched fonts)
  if (cp >= 0xE000  && cp <= 0xF8FF)  return true;   // BMP PUA
  if (cp >= 0xF0000 && cp <= 0xFFFFF) return true;   // Supplementary PUA-A (Nerd Font v3)
  if (cp >= 0x100000 && cp <= 0x10FFFF) return true;  // Supplementary PUA-B
  // CJK / fullwidth
  if (cp >= 0x1100 && cp <= 0x115F) return true;
  if (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) return true;
  if (cp >= 0xAC00 && cp <= 0xD7AF) return true;
  if (cp >= 0xF900 && cp <= 0xFAFF) return true;
  if (cp >= 0xFE10 && cp <= 0xFE6F) return true;
  if (cp >= 0xFF01 && cp <= 0xFF60) return true;
  if (cp >= 0xFFE0 && cp <= 0xFFE6) return true;
  if (cp >= 0x20000 && cp <= 0x2FFFD) return true;
  if (cp >= 0x30000 && cp <= 0x3FFFD) return true;
  return false;
}

/** Pad string to exact visible width with spaces */
export function pad(s: string, len: number): string {
  const vw = visibleWidth(s);
  return s + ' '.repeat(Math.max(0, len - vw));
}

/** Truncate string to max visible width. Always appends a full ANSI
 *  reset (`\x1b[0m`) so a cut that lands inside a styled region can't
 *  leak attributes (color, dim, bold) into the rest of the frame. */
export function truncate(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s + '\x1b[0m';
  let w = 0;
  let cutIdx = 0;
  let inEsc = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\x1b') { inEsc = true; continue; }
    if (inEsc) { if (s[i] === 'm') inEsc = false; continue; }
    const cp = s.codePointAt(i)!;
    const cw = isWide(cp) ? 2 : 1;
    if (cp > 0xFFFF) i++; // surrogate pair
    if (w + cw >= max) { cutIdx = i; break; }
    w += cw;
    cutIdx = i + 1;
  }
  return s.slice(0, cutIdx) + '…' + '\x1b[0m';
}

export interface WrapSegment {
  text: string;
  kind?: string;
}

export interface WrapOpts {
  cols: number;
  mode?: 'soft' | 'block-aware';
  tablePolicy?: 'overflow' | 'wrap';
  segments?: ReadonlyArray<WrapSegment>;
}

function ansiSgrIsReset(seq: string): boolean {
  return seq === '\x1b[m' || seq === '\x1b[0m';
}

function graphemeSegments(s: string): string[] {
  const SegmenterCtor = globalThis.Intl?.Segmenter;
  if (typeof SegmenterCtor === 'function') {
    const seg = new SegmenterCtor(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(s), (part) => part.segment);
  }
  return Array.from(s);
}

/** Soft-wrap text by visible terminal columns while preserving ANSI
 *  SGR sequences and grapheme boundaries. Each returned line is at
 *  most `cols` cells wide. Active SGR state is reset at the end of a
 *  wrapped line and re-opened on the next line so styles survive
 *  across wraps without leaking into adjacent frame content. */
export function wrapAnsiByWidth(text: string, opts: WrapOpts | number): string[] {
  const resolved: WrapOpts = typeof opts === 'number'
    ? { cols: opts }
    : opts;
  const width = Math.max(1, resolved.cols);
  if (resolved.segments && resolved.segments.length > 0) {
    const lines: string[] = [];
    for (const segment of resolved.segments) {
      const atomic = segment.kind === 'gfm-table' || segment.kind === 'code';
      if (resolved.mode === 'block-aware' && atomic && (resolved.tablePolicy ?? 'overflow') === 'overflow') {
        lines.push(...overflowAnsiBlock(segment.text, width));
        continue;
      }
      lines.push(...softWrapAnsiByWidth(segment.text, width));
    }
    return lines;
  }
  return softWrapAnsiByWidth(text, width);
}

function softWrapAnsiByWidth(text: string, width: number): string[] {
  const lines: string[] = [];
  const ansiRe = /\x1b\[[0-9;]*m/g;

  const pushLine = (line: string, activeSgr: string): void => {
    lines.push(activeSgr ? line + '\x1b[0m' : line);
  };

  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    let currentWidth = 0;
    let activeSgr = '';
    let idx = 0;
    let match: RegExpExecArray | null;
    ansiRe.lastIndex = 0;

    const appendPlain = (plain: string): void => {
      for (const seg of graphemeSegments(plain)) {
        const segWidth = Math.max(0, visibleWidth(seg));
        if (currentWidth > 0 && currentWidth + segWidth > width) {
          pushLine(current, activeSgr);
          current = activeSgr;
          currentWidth = 0;
        }
        current += seg;
        currentWidth += segWidth;
      }
    };

    while ((match = ansiRe.exec(rawLine)) !== null) {
      if (match.index > idx) appendPlain(rawLine.slice(idx, match.index));
      const seq = match[0];
      current += seq;
      if (ansiSgrIsReset(seq)) activeSgr = '';
      else activeSgr += seq;
      idx = match.index + seq.length;
    }
    if (idx < rawLine.length) appendPlain(rawLine.slice(idx));
    pushLine(current, activeSgr);
  }

  return lines;
}

function overflowAnsiBlock(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      out.push('');
      continue;
    }
    out.push(visibleWidth(rawLine) <= width ? rawLine : truncate(rawLine, width));
  }
  return out;
}

/** Repeat char to exact width (accounts for wide chars) */
export function repeatToWidth(ch: string, w: number): string {
  const cw = visibleWidth(ch);
  if (cw === 0) return '';
  return ch.repeat(Math.max(0, Math.floor(w / cw)));
}

