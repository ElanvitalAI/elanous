// 추출 tokens.json 을 번들 시스템과 같은 모양으로 올린다.
// ⛔ 원본에서 못 읽은 값은 지어내지 않는다 — 빈 칸은 주석으로만 남긴다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDesignSystemsDir } from './design-systems.js';
import { BUNDLED_TOKEN_SCHEMA, DEFAULT_BASE_SYSTEM } from './system-schema.js';

export interface ExtractColorCount {
  readonly value: string;
  readonly count: number;
}

export interface ExtractTokensJson {
  readonly customProperties?: Readonly<Record<string, string>>;
  readonly paintedColors?: {
    readonly backgrounds?: readonly ExtractColorCount[];
    readonly text?: readonly ExtractColorCount[];
    readonly strokes?: readonly ExtractColorCount[];
  } | null;
  readonly roles?: Readonly<Record<string, Readonly<Record<string, string | null | undefined>>>>;
  readonly typeScale?: readonly { readonly size: number; readonly weight?: string; readonly count?: number }[];
}

export interface PromoteSystemOptions {
  readonly id: string;
  readonly name: string;
  readonly sourceUrl: string;
  readonly base?: string;
  readonly systemsDir?: string;
}

export interface PromotePaletteOptions {
  readonly id: string;
  readonly name: string;
  readonly base?: string;
  readonly systemsDir?: string;
}

export interface TokenProvenance {
  readonly token: string;
  readonly value: string;
  readonly from: string;
}

export interface TokenCoverage {
  /** 원본에서 잰 칸. */
  readonly measured: number;
  /** 잰 값으로 고른 칸(accent 위 흰/검). */
  readonly derived: number;
  /** base 시스템에서 채운 칸. */
  readonly base: number;
  /** base 에도 없어 비운 칸. */
  readonly missing: number;
}

export interface PromotedSystem {
  readonly manifest: { readonly id: string; readonly name: string; readonly category: 'Custom' };
  readonly designMd: string;
  readonly tokensCss: string;
  readonly provenance: readonly TokenProvenance[];
  /** 잰 값은 그대로 두고, 읽을 수 없는 조합만 알린다. */
  readonly warnings: readonly string[];
  /** 57칸이 어디서 왔나. 값은 지어내지 않는다. */
  readonly coverage: TokenCoverage;
}

const COLOR_SLOTS = ['bg', 'surface', 'fg', 'muted', 'border', 'accent'] as const;
const TYPE_SLOTS = ['font-display', 'font-body', 'text-base', 'leading-body'] as const;
const TEXT_BELOW = ['text-sm', 'text-xs'] as const;
const TEXT_ABOVE = ['text-lg', 'text-xl', 'text-2xl', 'text-3xl', 'text-4xl'] as const;

const CUSTOM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  bg: ['--bg', '--background', '--color-bg', '--color-background', '--page-bg'],
  surface: ['--surface', '--color-surface', '--card', '--color-card'],
  fg: ['--fg', '--foreground', '--color-fg', '--color-foreground', '--text', '--color-text'],
  muted: ['--muted', '--color-muted', '--text-muted', '--color-text-muted'],
  border: ['--border', '--color-border', '--stroke', '--color-stroke'],
  accent: ['--accent', '--primary', '--color-accent', '--color-primary', '--brand'],
  'font-display': ['--font-display', '--font-heading', '--font-serif'],
  'font-body': ['--font-body', '--font-sans', '--font-text'],
  'text-base': ['--text-base', '--font-size-base', '--font-size'],
  'leading-body': ['--leading-body', '--line-height-body', '--line-height'],
  'font-mono': ['--font-mono', '--font-code'],
};

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseColor(raw: string | null | undefined): Rgb | null {
  if (raw == null) return null;
  const value = raw.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (hex) {
    const body = hex[1]!;
    const full = body.length === 3 ? body.split('').map((c) => c + c).join('') : body;
    const n = parseInt(full.slice(0, 6), 16);
    const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  }
  const fn = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((.*)\)$/i.exec(value);
  if (!fn) return null;
  const kind = fn[1]!.toLowerCase();
  const inner = fn[2]!;
  const alphaFrom = (parts: string[]): number => {
    const slash = inner.lastIndexOf('/');
    if (slash !== -1) {
      const a = inner.slice(slash + 1).trim();
      const n = a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a);
      return Number.isFinite(n) ? n : 1;
    }
    if (parts.length >= 4) {
      const n = parseFloat(parts[3]!);
      return Number.isFinite(n) ? n : 1;
    }
    return 1;
  };
  if (kind === 'rgb' || kind === 'rgba') {
    const parts = inner.split('/').slice(0, 1).join('/').split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part: string): number => part.endsWith('%') ? (parseFloat(part) / 100) * 255 : parseFloat(part);
    const r = channel(parts[0]!);
    const g = channel(parts[1]!);
    const b = channel(parts[2]!);
    if (![r, g, b].every(Number.isFinite)) return null;
    return { r, g, b, a: alphaFrom(parts) };
  }
  if (kind === 'hsl' || kind === 'hsla') {
    const parts = inner.split('/').slice(0, 1).join('/').split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]!) / 360;
    const s = parseFloat(parts[1]!) / 100;
    const l = parseFloat(parts[2]!) / 100;
    if (![h, s, l].every(Number.isFinite)) return null;
    const hue = ((h % 1) + 1) % 1;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const chan = (t: number): number => {
      let x = t;
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    return {
      r: clampByte(chan(hue + 1 / 3) * 255),
      g: clampByte(chan(hue) * 255),
      b: clampByte(chan(hue - 1 / 3) * 255),
      a: alphaFrom(parts),
    };
  }
  return null;
}

function luminance(color: Rgb): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

/** WCAG 2 상대 휘도. sRGB 채널은 0~255. */
function relativeLuminanceChannel(channel: number): number {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: Rgb): number {
  return 0.2126 * relativeLuminanceChannel(color.r)
    + 0.7152 * relativeLuminanceChannel(color.g)
    + 0.0722 * relativeLuminanceChannel(color.b);
}

/** CIE76. sRGB 채널을 Lab 으로 바꿔 두 불투명색의 거리를 잰다. */
function cie76(a: Rgb, b: Rgb): number {
  const linear = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116));
  const lab = (color: Rgb): [number, number, number] => {
    const r = linear(color.r);
    const g = linear(color.g);
    const bl = linear(color.b);
    const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * bl) / 0.95047);
    const y = f(0.2126729 * r + 0.7151522 * g + 0.0721750 * bl);
    const z = f((0.0193339 * r + 0.1191920 * g + 0.9503041 * bl) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function compositeOver(foreground: Rgb, background: Rgb): Rgb {
  const a = Math.max(0, Math.min(1, foreground.a));
  return {
    r: foreground.r * a + background.r * (1 - a),
    g: foreground.g * a + background.g * (1 - a),
    b: foreground.b * a + background.b * (1 - a),
    a: 1,
  };
}

/**
 * WCAG 2 대비비. 알파는 `background` 위에 합성한 뒤 잰다.
 * 배경을 안 주면 불투명으로 본다(알파를 1로 둔다).
 */
export function contrastRatio(a: string, b: string, background?: string): number | null {
  const left = parseColor(a);
  const right = parseColor(b);
  if (!left || !right) return null;
  const backdrop = background ? parseColor(background) : null;
  const paint = (color: Rgb): Rgb => {
    if (color.a >= 1) return color;
    if (backdrop && backdrop.a > 0) return compositeOver(color, backdrop.a >= 1 ? backdrop : compositeOver(backdrop, { r: 255, g: 255, b: 255, a: 1 }));
    return { ...color, a: 1 };
  };
  const la = relativeLuminance(paint(left));
  const lb = relativeLuminance(paint(right));
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function sameColor(a: string, b: string): boolean {
  const left = parseColor(a);
  const right = parseColor(b);
  if (!left || !right) return a.trim().toLowerCase() === b.trim().toLowerCase();
  return clampByte(left.r) === clampByte(right.r)
    && clampByte(left.g) === clampByte(right.g)
    && clampByte(left.b) === clampByte(right.b)
    && Math.abs(left.a - right.a) < 0.001;
}

function contrastAgainst(value: string, background: string): number {
  return contrastRatio(value, background) ?? 0;
}

const BODY_CONTRAST_FLOOR = 4.5;
const MUTED_CONTRAST_FLOOR = 3;

function contrastWarning(ratio: number): string {
  const shown = Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(1).replace(/\\.0$/, '');
  return `⚠️ 본문 대비 ${shown}:1 — WCAG AA(4.5:1) 미만`;
}

function saturation(color: Rgb): number {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  if (max === 0) return 0;
  return (max - min) / 255;
}

function opaque(entry: ExtractColorCount | undefined): boolean {
  if (!entry) return false;
  const color = parseColor(entry.value);
  return color !== null && color.a >= 1;
}

function roleValue(tokens: ExtractTokensJson, role: string, prop: string): string | null {
  const value = tokens.roles?.[role]?.[prop];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function customHit(tokens: ExtractTokensJson, slot: string): { value: string; from: string } | null {
  const props = tokens.customProperties ?? {};
  const wanted = new Map(Object.keys(props).map((name) => [name.toLowerCase(), name]));
  for (const alias of CUSTOM_ALIASES[slot] ?? []) {
    const actual = wanted.get(alias.toLowerCase());
    if (!actual) continue;
    const value = props[actual]?.trim();
    if (value) return { value, from: actual };
  }
  return null;
}

function readBaseTokens(base: string | undefined, systemsDir: string | undefined): Map<string, string> {
  const found = new Map<string, string>();
  if (!base) return found;
  let css = '';
  try {
    css = readFileSync(join(systemsDir ?? defaultDesignSystemsDir(), base, 'tokens.css'), 'utf8');
  } catch {
    return found;
  }
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const root = /:root\s*\{([\s\S]*?)\}/.exec(stripped)?.[1] ?? '';
  for (const match of root.matchAll(/(?:^|\n)\s*(--[a-z0-9-]+)\s*:\s*([^;\n]+)\s*;/gi)) {
    found.set(match[1]!.slice(2), match[2]!.trim());
  }
  return found;
}

function cssString(value: string): string {
  return value.replace(/\*\//g, '* /');
}

function renderTokens(
  rows: readonly { token: string; value: string | null; from: string | null; base?: boolean }[],
  warnings: readonly string[] = [],
): string {
  const lines = rows.map((row) => {
    if (row.value === null) return `  /* ⚪ --${row.token}: 원본에서 못 읽었다 */`;
    const note = row.base && row.from && !row.from.startsWith('base:') ? `base:${row.from}` : row.from;
    return `  --${row.token}: ${cssString(row.value)}; /* ${note} */`;
  });
  const head = warnings.map((warning) => `/* ${warning} */`).join('\n');
  return `${head ? `${head}\n` : ''}:root {\n${lines.join('\n')}\n}\n`;
}

function coverageLine(coverage: TokenCoverage, baseId: string): string {
  return `잰 칸 ${coverage.measured} · 파생 ${coverage.derived} · base ${coverage.base}(${baseId})`;
}

function designDocument(
  name: string,
  sourceLine: string,
  palette: readonly TokenProvenance[],
  type: readonly TokenProvenance[],
  unread: readonly string[],
  warnings: readonly string[] = [],
  coverage?: { readonly counts: TokenCoverage; readonly baseId: string },
): string {
  const table = (rows: readonly TokenProvenance[]): string => rows.length === 0
    ? '_없음_'
    : ['| 토큰 | 값 | 출처 |', '| --- | --- | --- |', ...rows.map((row) => `| \`--${row.token}\` | \`${row.value.replace(/\|/g, '\\|')}\` | ${row.from} |`)].join('\n');
  const unreadLine = unread.length
    ? `\n못 읽은 칸: ${unread.map((token) => `\`--${token}\``).join(' · ')}\n`
    : '\n';
  const warningBlock = warnings.length ? ['', ...warnings, ''] : [];
  const head = coverage ? [coverageLine(coverage.counts, coverage.baseId), ''] : [];
  return [
    `# ${name}`,
    '',
    ...head,
    '> Category: Custom',
    `> ${sourceLine}`,
    ...warningBlock,
    '',
    '## Palette',
    '',
    table(palette),
    '',
    '## Typography',
    '',
    table(type),
    unreadLine,
    '참고이지 복제가 아니다.',
    '',
  ].join('\n');
}

function labeled(entries: readonly ExtractColorCount[] | undefined, label: string): Array<{ value: string; from: string; score: number }> {
  const out: Array<{ value: string; from: string; score: number }> = [];
  for (const [index, entry] of (entries ?? []).entries()) {
    const color = parseColor(entry.value);
    if (!color || color.a <= 0) continue;
    out.push({ value: entry.value, from: `${label} #${index + 1} · 채도`, score: saturation(color) });
  }
  return out;
}

function mostSaturated(candidates: readonly { value: string; from: string; score: number }[]): { value: string; from: string; score: number } | null {
  let best: { value: string; from: string; score: number } | null = null;
  for (const candidate of candidates) {
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

function provenanceOf(rows: readonly { token: string; value: string | null; from: string | null }[]): TokenProvenance[] {
  return rows.filter((row): row is { token: string; value: string; from: string } => row.value !== null && row.from !== null)
    .map((row) => ({ token: row.token, value: row.value, from: row.from }));
}

type SlotFill = { value: string; from: string; kind: 'measured' | 'derived' };

const SURFACE_WARM_DELTA = 5;

function pxSize(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** typeScale 크기를 body 기준으로 xs…4xl 에 가까운 순으로 놓는다. 같은 크기는 한 칸만. */
function mapTypeScale(
  steps: readonly { readonly size: number; readonly weight?: string; readonly count?: number }[],
  bodyPx: number | null,
): Map<string, SlotFill> {
  const grouped = new Map<number, { size: number; count: number; weights: number }>();
  for (const step of steps) {
    if (!Number.isFinite(step.size) || step.size <= 0) continue;
    const count = step.count ?? 0;
    const prev = grouped.get(step.size);
    if (!prev) {
      grouped.set(step.size, { size: step.size, count, weights: 1 });
      continue;
    }
    prev.weights += 1;
    if (count > prev.count) prev.count = count;
  }
  const sizes = [...grouped.values()].sort((a, b) => b.size - a.size);
  const mostUsed = sizes.reduce<{ size: number; count: number } | null>((best, step) => (
    best === null || step.count > best.count ? step : best
  ), null);
  const anchor = bodyPx ?? mostUsed?.size ?? null;
  const below = sizes.filter((step) => anchor === null || step.size < anchor - 0.01).sort((a, b) => b.size - a.size);
  const above = sizes.filter((step) => anchor !== null && step.size > anchor + 0.01).sort((a, b) => a.size - b.size);
  const placed = new Map<string, SlotFill>();
  const note = (step: { size: number; weights: number }, rank: number): string => {
    const weightNote = step.weights > 1 ? ` · 굵기 ${step.weights}` : '';
    return `typeScale #${rank}${weightNote}`;
  };
  const rankOf = (size: number): number => sizes.findIndex((step) => step.size === size) + 1;
  for (const [index, token] of TEXT_BELOW.entries()) {
    const step = below[index];
    if (!step) break;
    placed.set(token, { value: `${step.size}px`, from: note(step, rankOf(step.size)), kind: 'measured' });
  }
  for (const [index, token] of TEXT_ABOVE.entries()) {
    const step = above[index];
    if (!step) break;
    placed.set(token, { value: `${step.size}px`, from: note(step, rankOf(step.size)), kind: 'measured' });
  }
  return placed;
}

function pickSurfaceWarm(
  backgrounds: readonly ExtractColorCount[],
  bg: string | undefined,
  surface: string | undefined,
): SlotFill | null {
  const anchors = [bg, surface].filter((value): value is string => Boolean(value));
  const anchorColors = anchors.map((value) => parseColor(value)).filter((color): color is Rgb => color !== null);
  for (const [index, entry] of backgrounds.entries()) {
    if (!opaque(entry)) continue;
    const color = parseColor(entry.value);
    if (!color) continue;
    if (anchors.some((anchor) => sameColor(entry.value, anchor))) continue;
    // 한쪽이라도 ΔE≤5 이면 bg·surface 와 다른 면이 아니다. 양쪽 모두 >5 일 때만 통과.
    if (anchorColors.some((anchor) => cie76(color, anchor) <= SURFACE_WARM_DELTA)) continue;
    return { value: entry.value, from: `painted bg #${index + 1} · ΔE>5 · ${entry.count}회`, kind: 'measured' };
  }
  return null;
}

function pickFg2(text: readonly ExtractColorCount[], fg: string | undefined, bg: string | undefined): SlotFill | null {
  if (!fg || !bg) return null;
  let best: ExtractColorCount | undefined;
  let bestCount = -1;
  for (const candidate of text) {
    if (sameColor(candidate.value, fg)) continue;
    if (!parseColor(candidate.value)) continue;
    if (contrastAgainst(candidate.value, bg) < BODY_CONTRAST_FLOOR) continue;
    if (candidate.count > bestCount) {
      bestCount = candidate.count;
      best = candidate;
    }
  }
  if (!best) return null;
  return { value: best.value, from: `painted text · fg 와 다름 · 대비≥4.5 · ${best.count}회`, kind: 'measured' };
}

function pickMeta(text: readonly ExtractColorCount[], bg: string | undefined): SlotFill | null {
  if (!bg) return null;
  let best: ExtractColorCount | undefined;
  let bestLum = Number.NEGATIVE_INFINITY;
  const bgColor = parseColor(bg);
  if (!bgColor) return null;
  const bgLum = luminance(bgColor);
  const lightPage = bgLum >= 128;
  for (const candidate of text) {
    const color = parseColor(candidate.value);
    if (!color) continue;
    if (contrastAgainst(candidate.value, bg) < MUTED_CONTRAST_FLOOR) continue;
    const lum = luminance(color);
    const fainter = lightPage ? lum > bestLum : lum < bestLum || bestLum === Number.NEGATIVE_INFINITY;
    if (!best || fainter) {
      best = candidate;
      bestLum = lum;
    }
  }
  if (!best) return null;
  return { value: best.value, from: `painted text · 가장 옅음 · 대비≥3 · ${best.count}회`, kind: 'measured' };
}

function pickBorderSoft(strokes: readonly ExtractColorCount[], border: string | undefined): SlotFill | null {
  for (const [index, entry] of strokes.entries()) {
    if (!parseColor(entry.value)) continue;
    if (border && sameColor(entry.value, border)) continue;
    return { value: entry.value, from: `painted stroke #${index + 1} · border 와 다름 · ${entry.count}회`, kind: 'measured' };
  }
  return null;
}

function pickAccentOn(accent: string | undefined): SlotFill | null {
  if (!accent || !parseColor(accent)) return null;
  const onWhite = contrastRatio('#ffffff', accent) ?? 0;
  const onBlack = contrastRatio('#000000', accent) ?? 0;
  const value = onWhite >= onBlack ? '#ffffff' : '#000000';
  return { value, from: 'derived:contrast(accent)', kind: 'derived' };
}

interface AssembledTokens {
  readonly rows: readonly { token: string; value: string | null; from: string | null; base: boolean; kind: 'measured' | 'derived' | 'base' | 'missing' }[];
  readonly coverage: TokenCoverage;
  readonly baseId: string;
}

function assembleSchema(
  measured: ReadonlyMap<string, SlotFill>,
  baseId: string,
  baseTokens: ReadonlyMap<string, string>,
): AssembledTokens {
  let measuredCount = 0;
  let derivedCount = 0;
  let baseCount = 0;
  let missingCount = 0;
  const rows = BUNDLED_TOKEN_SCHEMA.map((token) => {
    const got = measured.get(token);
    if (got) {
      if (got.kind === 'derived') derivedCount += 1;
      else measuredCount += 1;
      return { token, value: got.value, from: got.from, base: false, kind: got.kind };
    }
    const filled = baseTokens.get(token);
    if (filled) {
      baseCount += 1;
      return { token, value: filled, from: `base:${baseId}`, base: false, kind: 'base' as const };
    }
    missingCount += 1;
    return { token, value: null, from: null, base: false, kind: 'missing' as const };
  });
  return {
    rows,
    coverage: { measured: measuredCount, derived: derivedCount, base: baseCount, missing: missingCount },
    baseId,
  };
}

export function promoteExtractToSystem(tokensJson: ExtractTokensJson, options: PromoteSystemOptions): PromotedSystem {
  const painted = tokensJson.paintedColors ?? null;
  const backgrounds = painted?.backgrounds ?? [];
  const text = painted?.text ?? [];
  const strokes = painted?.strokes ?? [];
  const opaqueBackgrounds = backgrounds.filter(opaque);

  const measured = new Map<string, { value: string; from: string }>();
  const bg = opaqueBackgrounds[0];
  if (bg) measured.set('bg', { value: bg.value, from: `painted bg #1 · ${bg.count}회` });
  const surface = opaqueBackgrounds[1];
  if (surface) measured.set('surface', { value: surface.value, from: `painted bg #2 · ${surface.count}회` });
  let bgValue = measured.get('bg')?.value ?? null;
  const bodyColor = roleValue(tokensJson, 'body', 'color');
  const h1Color = roleValue(tokensJson, 'h1', 'color');
  const opaqueRole = (value: string | null): boolean => {
    const color = value ? parseColor(value) : null;
    return color !== null && color.a >= 1;
  };
  if (opaqueRole(bodyColor)) {
    measured.set('fg', { value: bodyColor!, from: 'roles.body' });
  } else if (opaqueRole(h1Color)) {
    measured.set('fg', { value: h1Color!, from: 'roles.h1' });
  } else if (bgValue) {
    let bestText: ExtractColorCount | undefined;
    let bestRatio = 0;
    for (const candidate of text) {
      if (!parseColor(candidate.value)) continue;
      const ratio = contrastAgainst(candidate.value, bgValue);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestText = candidate;
      }
    }
    if (bestText) measured.set('fg', { value: bestText.value, from: 'painted text · 대비 최대' });
  } else {
    const fg = text[0];
    if (fg && parseColor(fg.value)) measured.set('fg', { value: fg.value, from: `painted text #1 · ${fg.count}회` });
  }

  // 바탕 = «가장 많이 칠해진 배경»이지만, 본문 역할 글자색과 읽히지 않으면(4.5:1 미만 · 또는 못 읽었으면)
  // 그 글자가 실제로 놓인 바탕이 아니다 — 작은 칩·배지가 많은 사이트(09-28 MDN · bbc · mit · airbnb).
  // ⇒ 브라우저 캔버스(흰색 · body 가 투명할 때 보이는 바탕)와 칠해진 배경 상위 3 중 대비가 가장 큰 것.
  //    잘 되던 사이트는 건드리지 않는다(코퍼스 32 · 개발 셋으로 고르고 보류 셋 10/15→15/15 로 판정).
  const roleFg = measured.get('fg');
  if (roleFg && (roleFg.from === 'roles.body' || roleFg.from === 'roles.h1')) {
    const readable = bgValue !== null && contrastAgainst(roleFg.value, bgValue) >= 4.5;
    if (!readable) {
      const candidates: Array<{ value: string; from: string }> = [
        { value: 'rgb(255, 255, 255)', from: 'canvas · 브라우저 기본 바탕' },
        ...opaqueBackgrounds.slice(0, 3).map((entry, index) => ({ value: entry.value, from: `painted bg #${index + 1} · ${roleFg.from} 과 대비 최대` })),
      ];
      let best: { value: string; from: string } | null = null;
      let bestRatio = 0;
      for (const candidate of candidates) {
        const ratio = contrastAgainst(roleFg.value, candidate.value);
        if (ratio > bestRatio) { bestRatio = ratio; best = candidate; }
      }
      if (best && best.value !== bgValue) {
        measured.set('bg', best);
        bgValue = best.value;
        if (measured.get('surface')?.value === best.value) measured.delete('surface');
      }
    }
  }

  const fgPick = measured.get('fg');
  if (fgPick && bgValue) {
    const fgColor = parseColor(fgPick.value);
    let muted: ExtractColorCount | undefined;
    let best = Number.POSITIVE_INFINITY;
    if (fgColor) {
      for (const candidate of text) {
        if (sameColor(candidate.value, fgPick.value)) continue;
        const color = parseColor(candidate.value);
        if (!color) continue;
        if (contrastAgainst(candidate.value, bgValue) < MUTED_CONTRAST_FLOOR) continue;
        const delta = Math.abs(luminance(color) - luminance(fgColor));
        if (delta < best) {
          best = delta;
          muted = candidate;
        }
      }
    }
    if (muted) measured.set('muted', { value: muted.value, from: `painted text · 명도차 최소 · ${muted.count}회` });
  }
  const border = strokes[0];
  if (border) measured.set('border', { value: border.value, from: `painted stroke #1 · ${border.count}회` });

  const button = roleValue(tokensJson, 'button', 'background-color');
  const link = roleValue(tokensJson, 'link', 'color');
  // 투명·반투명 버튼 배경(`rgba(0,0,0,0)` — 09-28 bluebottle 실측)이나 바탕과 같은 색은 «강조»가 아니다.
  const bgColor = parseColor(measured.get('bg')?.value);
  const usableAccent = (value: string | null | undefined): boolean => {
    const color = parseColor(value);
    if (!color || color.a < 0.9) return false;
    return !bgColor || color.r !== bgColor.r || color.g !== bgColor.g || color.b !== bgColor.b;
  };
  if (button && usableAccent(button)) {
    measured.set('accent', { value: button, from: 'roles.button.background-color' });
  } else if (link && usableAccent(link)) {
    measured.set('accent', { value: link, from: 'roles.link.color' });
  } else {
    const picked = mostSaturated([
      ...labeled(backgrounds, 'painted bg'),
      ...labeled(text, 'painted text'),
      ...labeled(strokes, 'painted stroke'),
    ].filter((candidate) => usableAccent(candidate.value)));
    if (picked && picked.score > 0.05) measured.set('accent', { value: picked.value, from: picked.from });
  }

  const display = roleValue(tokensJson, 'h1', 'font-family');
  if (display) measured.set('font-display', { value: display, from: 'roles.h1' });
  const body = roleValue(tokensJson, 'body', 'font-family');
  if (body) measured.set('font-body', { value: body, from: 'roles.body' });
  const textBase = roleValue(tokensJson, 'body', 'font-size');
  if (textBase) measured.set('text-base', { value: textBase, from: 'roles.body' });
  const leading = roleValue(tokensJson, 'body', 'line-height');
  if (leading) measured.set('leading-body', { value: leading, from: 'roles.body' });

  for (const slot of [...COLOR_SLOTS, ...TYPE_SLOTS, 'font-mono']) {
    const hit = customHit(tokensJson, slot);
    if (hit) measured.set(slot, hit);
  }

  const slots: Map<string, SlotFill> = new Map(
    [...measured.entries()].map(([token, got]) => [token, { ...got, kind: 'measured' as const }]),
  );
  const bgValueNow = slots.get('bg')?.value;
  const surfaceValue = slots.get('surface')?.value;
  const warm = pickSurfaceWarm(backgrounds, bgValueNow, surfaceValue);
  if (warm) slots.set('surface-warm', warm);
  const fg2 = pickFg2(text, slots.get('fg')?.value, bgValueNow);
  if (fg2) slots.set('fg-2', fg2);
  const meta = pickMeta(text, bgValueNow);
  if (meta) slots.set('meta', meta);
  const borderSoft = pickBorderSoft(strokes, slots.get('border')?.value);
  if (borderSoft) slots.set('border-soft', borderSoft);
  const accentOn = pickAccentOn(slots.get('accent')?.value);
  if (accentOn) slots.set('accent-on', accentOn);
  const bodyPx = pxSize(slots.get('text-base')?.value);
  for (const [token, fill] of mapTypeScale(tokensJson.typeScale ?? [], bodyPx)) {
    if (!slots.has(token)) slots.set(token, fill);
  }

  const baseId = options.base ?? DEFAULT_BASE_SYSTEM;
  const baseTokens = readBaseTokens(baseId, options.systemsDir);
  const assembled = assembleSchema(slots, baseId, baseTokens);
  const { rows } = assembled;
  const provenance = provenanceOf(rows);
  const unread = rows.filter((row) => row.value === null).map((row) => row.token);
  const warnings: string[] = [];
  const fgValue = rows.find((row) => row.token === 'fg')?.value ?? null;
  const bgRow = rows.find((row) => row.token === 'bg')?.value ?? null;
  if (fgValue && bgRow) {
    const ratio = contrastRatio(fgValue, bgRow);
    if (ratio !== null && ratio < BODY_CONTRAST_FLOOR) warnings.push(contrastWarning(ratio));
  }
  const paletteNames = new Set<string>(['bg', 'surface', 'surface-warm', 'fg', 'fg-2', 'muted', 'meta', 'border', 'border-soft', 'accent', 'accent-on', 'accent-hover', 'accent-active', 'success', 'warn', 'danger']);
  return {
    manifest: { id: options.id, name: options.name, category: 'Custom' },
    designMd: designDocument(
      options.name,
      `${options.sourceUrl} 에서 잰 값으로 만든 시스템 — 원본의 브랜드(로고·이름·그림)는 담지 않는다.`,
      provenance.filter((row) => paletteNames.has(row.token)),
      provenance.filter((row) => !paletteNames.has(row.token)),
      unread,
      warnings,
      { counts: assembled.coverage, baseId },
    ),
    tokensCss: renderTokens(rows, warnings),
    provenance,
    warnings,
    coverage: assembled.coverage,
  };
}

export function promotePaletteToSystem(hexes: readonly string[], options: PromotePaletteOptions): PromotedSystem {
  const parsed = hexes.map((hex) => ({ hex: hex.trim(), color: parseColor(hex.trim()) })).filter((entry) => entry.color !== null) as Array<{ hex: string; color: Rgb }>;
  const byLight = [...parsed].sort((a, b) => luminance(b.color) - luminance(a.color));
  const bySat = [...parsed].sort((a, b) => saturation(b.color) - saturation(a.color) || luminance(b.color) - luminance(a.color));
  const measured = new Map<string, { value: string; from: string }>();
  if (byLight[0]) measured.set('bg', { value: byLight[0].hex, from: 'palette · 가장 밝음' });
  if (byLight.length > 1) measured.set('fg', { value: byLight[byLight.length - 1]!.hex, from: 'palette · 가장 어두움' });
  const accent = bySat.find((entry) => saturation(entry.color) > 0 && entry.hex !== measured.get('bg')?.value);
  if (accent) measured.set('accent', { value: accent.hex, from: 'palette · 채도 최고' });

  const slots: Map<string, SlotFill> = new Map(
    [...measured.entries()].map(([token, got]) => [token, { ...got, kind: 'measured' as const }]),
  );
  const accentOn = pickAccentOn(slots.get('accent')?.value);
  if (accentOn) slots.set('accent-on', accentOn);
  const baseId = options.base ?? DEFAULT_BASE_SYSTEM;
  const baseTokens = readBaseTokens(baseId, options.systemsDir);
  const assembled = assembleSchema(slots, baseId, baseTokens);
  const { rows } = assembled;
  const provenance = provenanceOf(rows);
  const unread = rows.filter((row) => row.value === null).map((row) => row.token);
  const paletteNames = new Set<string>(COLOR_SLOTS);
  return {
    manifest: { id: options.id, name: options.name, category: 'Custom' },
    designMd: designDocument(
      options.name,
      '준 색만으로 만든 시스템 — 원본의 브랜드(로고·이름·그림)는 담지 않는다.',
      provenance.filter((row) => paletteNames.has(row.token)),
      provenance.filter((row) => !paletteNames.has(row.token)),
      unread,
      [],
      { counts: assembled.coverage, baseId },
    ),
    tokensCss: renderTokens(rows),
    provenance,
    warnings: [],
    coverage: assembled.coverage,
  };
}
