import { evaluateOverlayCondition } from '../self-implement/graph-overlay-condition.js';
import { statuslineBreakpoints, statuslineWidthBand, type StatuslineDefinition, type StatuslineRuleDef, type StatuslineSegmentDef, type StatuslineWidthBand } from './schema.js';

/** Read-only snapshot. A missing source or field renders as «?»; it never throws. */
export type StatuslineSnapshot = Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>;

export interface StatuslineRenderedSegment {
  readonly id: string;
  readonly text: string;
  readonly color?: string;
  readonly glyph?: string;
}

export interface StatuslineFrame {
  readonly band: ReturnType<typeof statuslineWidthBand>;
  readonly lines: readonly (readonly StatuslineRenderedSegment[])[];
  readonly text: string;
}

const MISSING = '?';

function readField(snapshot: StatuslineSnapshot, segment: StatuslineSegmentDef): unknown {
  const source = snapshot[segment.source];
  if (source === undefined) return undefined;
  const parts = segment.field.split('.');
  let cursor: unknown = source;
  for (const part of parts) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
    if (!Object.hasOwn(cursor, part)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function formatValue(value: unknown, format: StatuslineSegmentDef['format']): string {
  if (value === undefined || value === null || value === '') return MISSING;
  if (format === 'count') {
    return typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : MISSING;
  }
  if (format === 'ratio') {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : MISSING;
  }
  if (format === 'dot') {
    if (value === 'green' || value === 'yellow' || value === 'red') return value;
    return MISSING;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return MISSING;
}

function applies(when: string | undefined, snapshot: StatuslineSnapshot): boolean {
  if (when === undefined) return true;
  const flat: Record<string, unknown> = {};
  for (const [source, fields] of Object.entries(snapshot)) {
    if (fields === undefined) continue;
    for (const [key, value] of Object.entries(fields)) flat[`${source}_${key}`] = value;
  }
  const verdict = evaluateOverlayCondition(when, flat);
  return verdict.kind === 'applies';
}

function matchingRules(rules: readonly StatuslineRuleDef[], segmentId: string, snapshot: StatuslineSnapshot, band?: StatuslineWidthBand): readonly StatuslineRuleDef[] {
  return rules.filter((rule) => {
    if (rule.segments !== undefined && rule.segments.length > 0 && !rule.segments.includes(segmentId)) return false;
    if (rule.bands !== undefined && band !== undefined && !rule.bands.includes(band)) return false;
    return applies(rule.when, snapshot);
  });
}

function renderSegment(segment: StatuslineSegmentDef, rules: readonly StatuslineRuleDef[], snapshot: StatuslineSnapshot, band?: StatuslineWidthBand): StatuslineRenderedSegment | undefined {
  if (!applies(segment.when, snapshot)) return undefined;
  const matched = matchingRules(rules, segment.id, snapshot, band);
  if (matched.some((rule) => rule.hide === true)) return undefined;
  const value = formatValue(readField(snapshot, segment), segment.format);
  const label = segment.label ? `${segment.label} ` : '';
  const glyph = [...matched].reverse().find((rule) => rule.glyph !== undefined)?.glyph;
  const color = [...matched].reverse().find((rule) => rule.color !== undefined)?.color;
  const marked = glyph ? `${glyph} ${label}${value}` : `${label}${value}`;
  return { id: segment.id, text: marked, ...(color !== undefined ? { color } : {}), ...(glyph !== undefined ? { glyph } : {}) };
}

function lineOf(ids: readonly string[], definition: StatuslineDefinition, snapshot: StatuslineSnapshot, band?: StatuslineWidthBand): readonly StatuslineRenderedSegment[] {
  const byId = new Map(definition.segments.map((segment) => [segment.id, segment]));
  const rendered: StatuslineRenderedSegment[] = [];
  for (const id of ids) {
    const segment = byId.get(id);
    if (!segment) continue;
    const row = renderSegment(segment, definition.rules, snapshot, band);
    if (row) rendered.push(row);
  }
  return rendered;
}

export const STATUSLINE_SEPARATOR = ' · ';

const lineWidth = (line: readonly StatuslineRenderedSegment[]): number => Bun.stringWidth(line.map((segment) => segment.text).join(STATUSLINE_SEPARATOR));

/**
 * Make the line fit `columns`: for each `drop` segment in order, first swap it for its shorter form (`shorter`), then,
 * if the line is still too wide, take it out. What is left may still need cutting by the caller.
 */
function fitLine(line: readonly StatuslineRenderedSegment[], drop: readonly string[], shorter: ReadonlyMap<string, StatuslineRenderedSegment>, columns: number): readonly StatuslineRenderedSegment[] {
  let fitted = line;
  for (const id of drop) {
    if (lineWidth(fitted) <= columns) break;
    const short = shorter.get(id);
    if (short && fitted.some((segment) => segment.id === id)) {
      fitted = fitted.map((segment) => segment.id === id ? short : segment);
      if (lineWidth(fitted) <= columns) break;
      fitted = fitted.filter((segment) => segment !== short);
    } else {
      fitted = fitted.filter((segment) => segment.id !== id);
    }
  }
  return fitted;
}

/** Render one frame. Width picks the layout; a band with no layout falls back to the next narrower one. */
export function renderStatusline(definition: StatuslineDefinition, snapshot: StatuslineSnapshot, columns: number,
  forcedBand?: ReturnType<typeof statuslineWidthBand>): StatuslineFrame {
  const band = forcedBand ?? statuslineWidthBand(columns, statuslineBreakpoints(definition));
  const order: readonly (typeof band)[] = band === 'lg' ? ['lg', 'md', 'sm', 'xs']
    : band === 'md' ? ['md', 'sm', 'xs']
      : band === 'sm' ? ['sm', 'xs']
        : ['xs'];
  const layout = order.map((name) => definition.layouts.find((row) => row.band === name)).find((row) => row !== undefined);
  const drop = layout?.drop ?? [];
  const shorter = new Map<string, StatuslineRenderedSegment>();
  for (const [id, shortId] of Object.entries(layout?.shorten ?? {})) {
    const rendered = lineOf([shortId], definition, snapshot, band)[0];
    if (rendered) shorter.set(id, rendered);
  }
  const lines = layout === undefined ? [] : [
    lineOf(layout.segments, definition, snapshot, band),
    ...(layout.lines === 2 && layout.secondLine ? [lineOf(layout.secondLine, definition, snapshot, band)] : []),
  ].map((line) => fitLine(line, drop, shorter, columns));
  return {
    band,
    lines,
    text: lines.map((line) => line.map((segment) => segment.text).join(STATUSLINE_SEPARATOR)).join('\n'),
  };
}
