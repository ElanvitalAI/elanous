/**
 * Pure scorer for one extracted site.
 *
 * Tokens are only declarations whose line starts with `--name: value;`.
 * A `--name:` that lives inside a comment is not a token — the hand scorer
 * that began a regex at `/* ⚪ --font-display: … *\/` swallowed the next
 * line's `--fg`.
 *
 * Colors: `#hex`, `rgb()`, `rgba()`, and CSS named colors (`white`, `black`,
 * `transparent`, …).
 */
import { contrastRatio, type Rgb255 } from '../../src/design/web-contrast';

export const CORE_TOKENS = ['bg', 'fg', 'accent', 'font-display', 'font-body', 'text-base'] as const;

/** Painted text elements below this count are an empty (blank) capture, not a scoring defect. */
export const EMPTY_PAINTED_BELOW = 20;

/** Accent counts only when its alpha is at least this and it differs from the page background. */
export const ACCENT_MIN_ALPHA = 0.9;

export interface ScoreSiteInput {
  readonly tokensCss: string;
  readonly tokensJson: TokensJson | null | undefined;
}

export interface TokensJson {
  readonly roles?: Readonly<Record<string, string>>;
  readonly paintedColors?: {
    readonly backgrounds?: Readonly<Record<string, number>>;
    readonly text?: Readonly<Record<string, number>>;
    readonly strokes?: Readonly<Record<string, number>>;
  };
  readonly customProperties?: Readonly<Record<string, string>>;
}

export interface SiteScore {
  /** 0~6 — how many of bg·fg·accent·font-display·font-body·text-base were declared. */
  readonly core: number;
  /** WCAG contrast of fg on bg. `null` when either color cannot be read. */
  readonly contrast: number | null;
  /** Accent alpha ≥ 0.9 and the color is not the background. */
  readonly accentOk: boolean;
  /**
   * Count of painted text elements (`paintedColors.text`).
   * `null` when the capture did not report a count (timeout, missing file) —
   * that is not a blank screen.
   */
  readonly painted: number | null;
  /**
   * `true` only when a painted count was read and it is below 20.
   * `null` when the count is unknown. Unknown is not empty.
   */
  readonly empty: boolean | null;
}

export interface SummaryRow {
  readonly set: 'dev' | 'holdout';
  readonly category: string;
  readonly core: number;
  readonly contrast: number | null;
  readonly accentOk: boolean;
  /** `null` when the painted count was not reported. */
  readonly painted: number | null;
  /** `true` only for a known blank capture. `null` is unknown, not empty. */
  readonly empty: boolean | null;
  /** Wall seconds for this capture. Omitted rows do not enter the median. */
  readonly sec?: number;
  /** A row is ok when the call succeeded and every core token is present. */
  readonly ok: boolean;
}

export interface Summary {
  readonly n: number;
  readonly ok: number;
  readonly coreAvg: number;
  /** Contrast ≥ 4.5 among rows whose painted count is known, not empty, and readable. */
  readonly contrastPass: number;
  /** Rows in the contrast denominator (known paint, not empty, both colors read). */
  readonly contrastN: number;
  /** Accent ok among rows whose painted count is known and not empty. */
  readonly accentOk: number;
  /** Rows in the accent denominator (known paint, not empty). */
  readonly accentN: number;
  readonly medianSec: number | null;
  /** Known blank captures only. Unknown paint is not counted here. */
  readonly empty: number;
}

const NAMED: Readonly<Record<string, Rgb255 | 'transparent'>> = {
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
  transparent: 'transparent',
  red: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 128, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  yellow: { r: 255, g: 255, b: 0 },
  cyan: { r: 0, g: 255, b: 255 },
  magenta: { r: 255, g: 0, b: 255 },
  fuchsia: { r: 255, g: 0, b: 255 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
  silver: { r: 192, g: 192, b: 192 },
  maroon: { r: 128, g: 0, b: 0 },
  olive: { r: 128, g: 128, b: 0 },
  lime: { r: 0, g: 255, b: 0 },
  teal: { r: 0, g: 128, b: 128 },
  navy: { r: 0, g: 0, b: 128 },
  purple: { r: 128, g: 0, b: 128 },
  orange: { r: 255, g: 165, b: 0 },
  pink: { r: 255, g: 192, b: 203 },
  brown: { r: 165, g: 42, b: 42 },
  snow: { r: 255, g: 250, b: 250 },
  ivory: { r: 255, g: 255, b: 240 },
  beige: { r: 245, g: 245, b: 220 },
  wheat: { r: 245, g: 222, b: 179 },
  coral: { r: 255, g: 127, b: 80 },
  salmon: { r: 250, g: 128, b: 114 },
  gold: { r: 255, g: 215, b: 0 },
  khaki: { r: 240, g: 230, b: 140 },
  indigo: { r: 75, g: 0, b: 130 },
  violet: { r: 238, g: 130, b: 238 },
  plum: { r: 221, g: 160, b: 221 },
  orchid: { r: 218, g: 112, b: 214 },
  tan: { r: 210, g: 180, b: 140 },
  chocolate: { r: 210, g: 105, b: 30 },
  tomato: { r: 255, g: 99, b: 71 },
  crimson: { r: 220, g: 20, b: 60 },
  azure: { r: 240, g: 255, b: 255 },
  aliceblue: { r: 240, g: 248, b: 255 },
  antiquewhite: { r: 250, g: 235, b: 215 },
  aqua: { r: 0, g: 255, b: 255 },
  aquamarine: { r: 127, g: 255, b: 212 },
  bisque: { r: 255, g: 228, b: 196 },
  blanchedalmond: { r: 255, g: 235, b: 205 },
  blueviolet: { r: 138, g: 43, b: 226 },
  burlywood: { r: 222, g: 184, b: 135 },
  cadetblue: { r: 95, g: 158, b: 160 },
  chartreuse: { r: 127, g: 255, b: 0 },
  cornflowerblue: { r: 100, g: 149, b: 237 },
  cornsilk: { r: 255, g: 248, b: 220 },
  darkblue: { r: 0, g: 0, b: 139 },
  darkcyan: { r: 0, g: 139, b: 139 },
  darkgoldenrod: { r: 184, g: 134, b: 11 },
  darkgray: { r: 169, g: 169, b: 169 },
  darkgrey: { r: 169, g: 169, b: 169 },
  darkgreen: { r: 0, g: 100, b: 0 },
  darkkhaki: { r: 189, g: 183, b: 107 },
  darkmagenta: { r: 139, g: 0, b: 139 },
  darkolivegreen: { r: 85, g: 107, b: 47 },
  darkorange: { r: 255, g: 140, b: 0 },
  darkorchid: { r: 153, g: 50, b: 204 },
  darkred: { r: 139, g: 0, b: 0 },
  darksalmon: { r: 233, g: 150, b: 122 },
  darkseagreen: { r: 143, g: 188, b: 143 },
  darkslateblue: { r: 72, g: 61, b: 139 },
  darkslategray: { r: 47, g: 79, b: 79 },
  darkslategrey: { r: 47, g: 79, b: 79 },
  darkturquoise: { r: 0, g: 206, b: 209 },
  darkviolet: { r: 148, g: 0, b: 211 },
  deeppink: { r: 255, g: 20, b: 147 },
  deepskyblue: { r: 0, g: 191, b: 255 },
  dimgray: { r: 105, g: 105, b: 105 },
  dimgrey: { r: 105, g: 105, b: 105 },
  dodgerblue: { r: 30, g: 144, b: 255 },
  firebrick: { r: 178, g: 34, b: 34 },
  floralwhite: { r: 255, g: 250, b: 240 },
  forestgreen: { r: 34, g: 139, b: 34 },
  gainsboro: { r: 220, g: 220, b: 220 },
  ghostwhite: { r: 248, g: 248, b: 255 },
  goldenrod: { r: 218, g: 165, b: 32 },
  greenyellow: { r: 173, g: 255, b: 47 },
  honeydew: { r: 240, g: 255, b: 240 },
  hotpink: { r: 255, g: 105, b: 180 },
  indianred: { r: 205, g: 92, b: 92 },
  lavender: { r: 230, g: 230, b: 250 },
  lavenderblush: { r: 255, g: 240, b: 245 },
  lawngreen: { r: 124, g: 252, b: 0 },
  lemonchiffon: { r: 255, g: 250, b: 205 },
  lightblue: { r: 173, g: 216, b: 230 },
  lightcoral: { r: 240, g: 128, b: 128 },
  lightcyan: { r: 224, g: 255, b: 255 },
  lightgoldenrodyellow: { r: 250, g: 250, b: 210 },
  lightgray: { r: 211, g: 211, b: 211 },
  lightgrey: { r: 211, g: 211, b: 211 },
  lightgreen: { r: 144, g: 238, b: 144 },
  lightpink: { r: 255, g: 182, b: 193 },
  lightsalmon: { r: 255, g: 160, b: 122 },
  lightseagreen: { r: 32, g: 178, b: 170 },
  lightskyblue: { r: 135, g: 206, b: 250 },
  lightslategray: { r: 119, g: 136, b: 153 },
  lightslategrey: { r: 119, g: 136, b: 153 },
  lightsteelblue: { r: 176, g: 196, b: 222 },
  lightyellow: { r: 255, g: 255, b: 224 },
  limegreen: { r: 50, g: 205, b: 50 },
  linen: { r: 250, g: 240, b: 230 },
  mediumaquamarine: { r: 102, g: 205, b: 170 },
  mediumblue: { r: 0, g: 0, b: 205 },
  mediumorchid: { r: 186, g: 85, b: 211 },
  mediumpurple: { r: 147, g: 112, b: 219 },
  mediumseagreen: { r: 60, g: 179, b: 113 },
  mediumslateblue: { r: 123, g: 104, b: 238 },
  mediumspringgreen: { r: 0, g: 250, b: 154 },
  mediumturquoise: { r: 72, g: 209, b: 204 },
  mediumvioletred: { r: 199, g: 21, b: 133 },
  midnightblue: { r: 25, g: 25, b: 112 },
  mintcream: { r: 245, g: 255, b: 250 },
  mistyrose: { r: 255, g: 228, b: 225 },
  moccasin: { r: 255, g: 228, b: 181 },
  navajowhite: { r: 255, g: 222, b: 173 },
  oldlace: { r: 253, g: 245, b: 230 },
  olivedrab: { r: 107, g: 142, b: 35 },
  orangered: { r: 255, g: 69, b: 0 },
  palegoldenrod: { r: 238, g: 232, b: 170 },
  palegreen: { r: 152, g: 251, b: 152 },
  paleturquoise: { r: 175, g: 238, b: 238 },
  palevioletred: { r: 219, g: 112, b: 147 },
  papayawhip: { r: 255, g: 239, b: 213 },
  peachpuff: { r: 255, g: 218, b: 185 },
  peru: { r: 205, g: 133, b: 63 },
  powderblue: { r: 176, g: 224, b: 230 },
  rosybrown: { r: 188, g: 143, b: 143 },
  royalblue: { r: 65, g: 105, b: 225 },
  saddlebrown: { r: 139, g: 69, b: 19 },
  sandybrown: { r: 244, g: 164, b: 96 },
  seagreen: { r: 46, g: 139, b: 87 },
  seashell: { r: 255, g: 245, b: 238 },
  sienna: { r: 160, g: 82, b: 45 },
  skyblue: { r: 135, g: 206, b: 235 },
  slateblue: { r: 106, g: 90, b: 205 },
  slategray: { r: 112, g: 128, b: 144 },
  slategrey: { r: 112, g: 128, b: 144 },
  springgreen: { r: 0, g: 255, b: 127 },
  steelblue: { r: 70, g: 130, b: 180 },
  thistle: { r: 216, g: 191, b: 216 },
  turquoise: { r: 64, g: 224, b: 208 },
  whitesmoke: { r: 245, g: 245, b: 245 },
  yellowgreen: { r: 154, g: 205, b: 50 },
  rebeccapurple: { r: 102, g: 51, b: 153 },
};

export interface ParsedColor {
  readonly rgb: Rgb255;
  readonly alpha: number;
}

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hexByte(h: string): number {
  return Number.parseInt(h, 16);
}

/** Read one color at the start of `raw`. Named colors, #hex, rgb(), rgba(). */
export function parseColor(raw: string): ParsedColor | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const named = NAMED[s.split(/[\s,;/]/)[0] ?? ''];
  if (named === 'transparent') return { rgb: { r: 0, g: 0, b: 0 }, alpha: 0 };
  if (named) return { rgb: named, alpha: 1 };

  const hex = s.match(/^#([0-9a-f]{3,8})\b/);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3 || h.length === 4) {
      const r = hexByte(h[0]! + h[0]!);
      const g = hexByte(h[1]! + h[1]!);
      const b = hexByte(h[2]! + h[2]!);
      const alpha = h.length === 4 ? hexByte(h[3]! + h[3]!) / 255 : 1;
      return { rgb: { r, g, b }, alpha };
    }
    if (h.length === 6 || h.length === 8) {
      const r = hexByte(h.slice(0, 2));
      const g = hexByte(h.slice(2, 4));
      const b = hexByte(h.slice(4, 6));
      const alpha = h.length === 8 ? hexByte(h.slice(6, 8)) / 255 : 1;
      return { rgb: { r, g, b }, alpha };
    }
  }

  const fn = s.match(/^(rgba?|hsla?)\(/);
  if (!fn) return null;
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (close < open) return null;
  const inner = s.slice(open + 1, close);
  const kind = fn[1]!;
  if (kind.startsWith('rgb')) {
    const slash = inner.lastIndexOf('/');
    const body = slash === -1 ? inner : inner.slice(0, slash);
    const alphaRaw = slash === -1 ? null : inner.slice(slash + 1).trim();
    const parts = body.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (p: string): number => {
      if (p.endsWith('%')) return clampByte((Number.parseFloat(p) / 100) * 255);
      return clampByte(Number.parseFloat(p));
    };
    let alpha = 1;
    if (alphaRaw !== null) {
      alpha = alphaRaw.endsWith('%') ? Number.parseFloat(alphaRaw) / 100 : Number.parseFloat(alphaRaw);
    } else if (parts.length >= 4) {
      const a = parts[3]!;
      alpha = a.endsWith('%') ? Number.parseFloat(a) / 100 : Number.parseFloat(a);
    }
    if (!Number.isFinite(alpha)) alpha = 1;
    return { rgb: { r: channel(parts[0]!), g: channel(parts[1]!), b: channel(parts[2]!) }, alpha };
  }
  return null;
}

function sameRgb(a: Rgb255, b: Rgb255): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/**
 * Declarations whose line starts with `--name:`.
 * Comment-only lines and `--name` that appear after other text are ignored,
 * so a comment `/* ⚪ --font-display: … *\/` cannot swallow the next `--fg`.
 */
export function readLineHeadTokens(tokensCss: string): Map<string, string> {
  const out = new Map<string, string>();
  let inBlock = false;
  for (const rawLine of tokensCss.split(/\r?\n/)) {
    let line = rawLine;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      inBlock = false;
      line = line.slice(end + 2);
    }
    let rest = line;
    while (rest.includes('/*')) {
      const start = rest.indexOf('/*');
      const end = rest.indexOf('*/', start + 2);
      if (end === -1) {
        rest = rest.slice(0, start);
        inBlock = true;
        break;
      }
      rest = rest.slice(0, start) + rest.slice(end + 2);
    }
    const trimmed = rest.trim();
    const m = trimmed.match(/^--([a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (!m) continue;
    out.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  return out;
}

function countMap(map: Readonly<Record<string, number>> | undefined): number {
  if (!map) return 0;
  let n = 0;
  for (const v of Object.values(map)) {
    if (typeof v === 'number' && Number.isFinite(v)) n += v;
  }
  return n;
}

/**
 * Painted text count, or `null` when the capture did not report one.
 * A missing `tokens.json` (timeout, absent file) is unknown — not zero.
 * An object that has `paintedColors` but no `text` map is a known zero.
 */
export function paintedTextCount(tokensJson: TokensJson | null | undefined): number | null {
  if (tokensJson == null || tokensJson.paintedColors == null) return null;
  return countMap(tokensJson.paintedColors.text);
}

/**
 * Fill a missing core declaration from the extract's own maps.
 * `roles` wins, then `customProperties` (`--name` or `name`).
 * Line-head CSS still wins when it already declared the token.
 */
export function tokenFromExtract(tokensJson: TokensJson | null | undefined, name: string): string | undefined {
  if (!tokensJson) return undefined;
  const role = tokensJson.roles?.[name];
  if (typeof role === 'string' && role.trim() !== '') return role.trim();
  const props = tokensJson.customProperties;
  if (!props) return undefined;
  const dashed = props[`--${name}`];
  if (typeof dashed === 'string' && dashed.trim() !== '') return dashed.trim();
  const plain = props[name];
  if (typeof plain === 'string' && plain.trim() !== '') return plain.trim();
  return undefined;
}

/** Background mass from `paintedColors.backgrounds`, used when `--bg` was not declared. */
export function dominantBackground(tokensJson: TokensJson | null | undefined): string | undefined {
  const map = tokensJson?.paintedColors?.backgrounds;
  if (!map) return undefined;
  let best: string | undefined;
  let bestN = 0;
  for (const [color, n] of Object.entries(map)) {
    if (typeof n === 'number' && n > bestN) {
      best = color;
      bestN = n;
    }
  }
  return best;
}

/** Stroke mass. A non-zero stroke count marks the capture as painted even with no text map. */
export function strokeCount(tokensJson: TokensJson | null | undefined): number {
  return countMap(tokensJson?.paintedColors?.strokes);
}

function resolvedToken(
  tokens: ReadonlyMap<string, string>,
  name: string,
  tokensJson: TokensJson | null | undefined,
): string | undefined {
  const fromCss = tokens.get(name);
  if (fromCss !== undefined && fromCss !== '') return fromCss;
  return tokenFromExtract(tokensJson, name);
}

export function scoreSite(input: ScoreSiteInput): SiteScore {
  const tokens = readLineHeadTokens(input.tokensCss ?? '');
  const json = input.tokensJson;
  const values = new Map<string, string>();
  for (const name of CORE_TOKENS) {
    const value = resolvedToken(tokens, name, json);
    if (value !== undefined && value !== '') values.set(name, value);
  }
  if (!values.has('bg')) {
    const paintedBg = dominantBackground(json);
    if (paintedBg) values.set('bg', paintedBg);
  }
  const core = CORE_TOKENS.filter((name) => values.has(name)).length;
  const bg = values.has('bg') ? parseColor(values.get('bg')!) : null;
  const fg = values.has('fg') ? parseColor(values.get('fg')!) : null;
  const accent = values.has('accent') ? parseColor(values.get('accent')!) : null;
  const contrast = bg && fg && bg.alpha > 0 && fg.alpha > 0
    ? contrastRatio(fg.rgb, bg.rgb)
    : null;
  const accentOk = Boolean(
    accent
    && accent.alpha >= ACCENT_MIN_ALPHA
    && bg
    && !sameRgb(accent.rgb, bg.rgb),
  );
  const painted = paintedTextCount(json);
  const strokes = strokeCount(json);
  // Text count is the corpus definition. Strokes count only when the text
  // map was present and empty, so a border-only capture is not a blank page
  // and a missing file stays unknown.
  const paintedForEmpty = painted === null ? null : painted > 0 ? painted : painted + strokes;
  const empty = paintedForEmpty === null ? null : paintedForEmpty < EMPTY_PAINTED_BELOW;
  return { core, contrast, accentOk, painted, empty };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function groupKey(row: SummaryRow, by: 'set' | 'category'): string {
  return by === 'set' ? row.set : row.category;
}

/**
 * Summaries keyed by `by`. One table row is one group (`set` or `category`).
 * Unknown paint (`empty === null`) stays out of the empty count and out of
 * the contrast/accent denominators — a timeout is not a blank screen.
 */
export function summarizeBy(rows: readonly SummaryRow[], by: 'set' | 'category'): Map<string, Summary> {
  const buckets = new Map<string, SummaryRow[]>();
  for (const row of rows) {
    const key = groupKey(row, by);
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }
  const out = new Map<string, Summary>();
  for (const [key, list] of buckets) out.set(key, summarize(list, by));
  return out;
}

/**
 * One summary of the rows already selected as a group.
 * `by` is the grouping axis those rows share; mixed keys still count,
 * and `summarizeBy` is what splits them.
 */
export function summarize(rows: readonly SummaryRow[], by: 'set' | 'category'): Summary {
  const onAxis = rows.filter((row) => groupKey(row, by) !== '');
  const n = onAxis.length;
  const ok = onAxis.filter((r) => r.ok).length;
  const coreAvg = n === 0 ? 0 : onAxis.reduce((s, r) => s + r.core, 0) / n;
  const known = onAxis.filter((r) => r.empty === false);
  const contrastRows = known.filter((r) => r.contrast !== null);
  const contrastPass = contrastRows.filter((r) => (r.contrast ?? 0) >= 4.5).length;
  const accentOk = known.filter((r) => r.accentOk).length;
  const secs = onAxis.map((r) => r.sec).filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
  return {
    n,
    ok,
    coreAvg,
    contrastPass,
    contrastN: contrastRows.length,
    accentOk,
    accentN: known.length,
    medianSec: median(secs),
    empty: onAxis.filter((r) => r.empty === true).length,
  };
}
