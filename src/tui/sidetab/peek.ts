const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const ANSI_CONTROL = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[PX^_].*?\x1b\\|.)/gs;
const NON_TEXT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const MAX_PEEK_SOURCE_CHARS = 16_384;

function fitLine(value: string, width: number): string {
  if (width <= 0) return '';
  if (Bun.stringWidth(value) <= width) return value;
  const maxTextWidth = Math.max(0, width - 1);
  let result = '';
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const cells = Bun.stringWidth(segment);
    if (used + cells > maxTextWidth) break;
    result += segment;
    used += cells;
  }
  return `${result}…`;
}

/** Return up to three recent plain-text output lines for the selected sidebar row. */
export function formatSidetabPeekLines(
  source: string,
  width: number,
  maxLines = 3,
): string[] {
  if (!source || width < 5 || maxLines <= 0) return [];

  let start = Math.max(0, source.length - MAX_PEEK_SOURCE_CHARS);
  // Keep a surrogate pair intact when the bounded tail starts in its second code unit.
  const firstCodeUnit = source.charCodeAt(start);
  if (start > 0 && firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) start++;
  let bounded = source.slice(start);
  // The cut may land in an ANSI sequence or line. Drop that partial prefix; recent complete lines follow it.
  if (start > 0) {
    const firstLineBreak = bounded.search(/[\r\n]/);
    if (firstLineBreak >= 0) bounded = bounded.slice(firstLineBreak + 1);
  }

  const clean = bounded
    .replace(ANSI_CONTROL, '')
    .replace(NON_TEXT_CONTROL, '')
    .replace(/\r\n?/g, '\n');
  const recent = clean.split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-Math.min(3, Math.floor(maxLines)));
  const prefix = '   ↳ ';
  const textWidth = Math.max(1, width - Bun.stringWidth(prefix));
  return recent.map((line) => `${prefix}${fitLine(line, textWidth)}`);
}
