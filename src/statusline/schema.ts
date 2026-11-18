/** Declarative status-line definition (DESIGN §2, stage 1).
 *
 *  Three layers overwrite by id: bundled default, then seat, then user.
 *  Data-source subscriptions are stage 2 — this module only names sources.
 */

export const STATUSLINE_BREAKPOINTS = { xs: 40, sm: 80, md: 140 } as const;

export type StatuslineWidthBand = 'xs' | 'sm' | 'md' | 'lg';

/** Upper bounds (columns, inclusive) of the three narrow bands; lg is everything wider (STATUSLINE-CONTRACT-V1 `bands:`). */
export type StatuslineBandBreakpoints = { readonly xs: number; readonly sm: number; readonly md: number };

/** xs ≤40 · sm ≤80 · md ≤140 · lg is everything wider — or the definition's own `bands:`. */
export function statuslineWidthBand(columns: number, breakpoints: StatuslineBandBreakpoints = STATUSLINE_BREAKPOINTS): StatuslineWidthBand {
  const width = Number.isFinite(columns) ? Math.floor(columns) : 0;
  if (width <= breakpoints.xs) return 'xs';
  if (width <= breakpoints.sm) return 'sm';
  if (width <= breakpoints.md) return 'md';
  return 'lg';
}

export type StatuslineSourceName =
  | 'session' | 'provider' | 'machines' | 'seats' | 'loops' | 'git' | 'alerts' | 'build';

export interface StatuslineSegmentDef {
  readonly id: string;
  readonly source: StatuslineSourceName;
  /** Dotted path read from the source snapshot. Missing → «?». */
  readonly field: string;
  /** Shown before the value. Empty string is allowed. */
  readonly label?: string;
  readonly format?: 'text' | 'count' | 'ratio' | 'dot';
  /** Graph-runner overlay condition. False / unreadable → segment hidden. */
  readonly when?: string;
}

export interface StatuslineRuleDef {
  readonly id: string;
  /** Same condition grammar as graph-runner overlay conditions. */
  readonly when: string;
  readonly color?: string;
  readonly glyph?: string;
  readonly hide?: boolean;
  /** Rule applies to these segment ids. Empty = every visible segment. */
  readonly segments?: readonly string[];
  /** Rule applies only while the line is drawn in these width bands. Absent = every band. */
  readonly bands?: readonly StatuslineWidthBand[];
}

export interface StatuslineLayoutDef {
  readonly band: StatuslineWidthBand;
  /** 1 = one line, 2 = two lines (lg). */
  readonly lines: 1 | 2;
  readonly segments: readonly string[];
  /** Second line, only when lines = 2. */
  readonly secondLine?: readonly string[];
  /** When a line is wider than the terminal, these segments leave first, in this order (then the line is cut). */
  readonly drop?: readonly string[];
  /** Before a `drop` segment leaves, it is first replaced by its shorter form (segment id → shorter segment id). */
  readonly shorten?: Readonly<Record<string, string>>;
}

export interface StatuslineDefinition {
  readonly segments: readonly StatuslineSegmentDef[];
  readonly rules: readonly StatuslineRuleDef[];
  readonly layouts: readonly StatuslineLayoutDef[];
  /** User-defined band edges (any subset; the rest keep the defaults). Must increase xs < sm < md. */
  readonly bands?: Partial<StatuslineBandBreakpoints>;
  /** Where the line sits (absent = STATUSLINE_DEFAULT_POSITION). */
  readonly position?: StatuslinePosition;
}

/** DESIGN §2b: bottom = under the input, the last row (Claude Code's place · the default); above-input = the old place,
 *  between the conversation and the input. */
export type StatuslinePosition = 'bottom' | 'above-input';
export const STATUSLINE_DEFAULT_POSITION: StatuslinePosition = 'bottom';

/** The band edges a definition draws with: its own `bands:` over the defaults. */
export function statuslineBreakpoints(definition: Pick<StatuslineDefinition, 'bands'>): StatuslineBandBreakpoints {
  return { ...STATUSLINE_BREAKPOINTS, ...(definition.bands ?? {}) };
}

export type StatuslineLayerName = 'default' | 'seat' | 'user';
