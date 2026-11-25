/** Width helpers shared by the widget kit — terminal cells via Bun.stringWidth, grapheme-safe cuts, no colour. */
import { redactSecretText } from '../../debug/log.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Terminal cells a string occupies. */
export const cells = (text: string): number => Bun.stringWidth(text);

/** Control/escape-free, secret-redacted, single-line text. */
export const clean = (text: string): string => redactSecretText(text
  .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));

/** Cut to at most `width` cells by whole graphemes (no marker). */
export function cut(text: string, width: number): string {
  let out = '';
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const w = cells(segment);
    if (used + w > width) break;
    out += segment;
    used += w;
  }
  return out;
}

/** Fit to `width` cells; a cut line ends with «…». */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (cells(text) <= width) return text;
  return width === 1 ? cut(text, 1) : `${cut(text, width - 1).trimEnd()}…`;
}

/** Fit, then right-pad with spaces to exactly `width` cells. */
export function pad(text: string, width: number): string {
  const fitted = fit(text, width);
  return fitted + ' '.repeat(Math.max(0, width - cells(fitted)));
}

/** Fit, then left-pad to exactly `width` cells. */
export function padStart(text: string, width: number): string {
  const fitted = fit(text, width);
  return ' '.repeat(Math.max(0, width - cells(fitted))) + fitted;
}

/** Greedy word wrap to `width` cells; a word longer than a line is split by graphemes. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  let line = '';
  for (const word of clean(text).split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (cells(rest) > w) {
      if (line) { lines.push(line); line = ''; }
      const head = cut(rest, w);
      lines.push(head);
      rest = rest.slice(head.length);
    }
    if (!line) line = rest;
    else if (cells(line) + 1 + cells(rest) <= w) line += ` ${rest}`;
    else { lines.push(line); line = rest; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** 12 → «12», 3.456 → «3.5». */
export const num = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/** 9_000 → «9s» · 65_000 → «1m05s» · 3_720_000 → «1h02m». */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** A `cellsWide` bar for a 0..1 ratio: █ filled · ░ empty. */
export function bar(ratio: number, cellsWide: number): string {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filled = Math.round(r * cellsWide);
  return '█'.repeat(filled) + '░'.repeat(cellsWide - filled);
}
