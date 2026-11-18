import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YamlNode } from 'yaml';
import { evaluateOverlayCondition } from '../self-implement/graph-overlay-condition.js';
import { STATUSLINE_BREAKPOINTS } from './schema.js';
import type {
  StatuslineBandBreakpoints,
  StatuslineDefinition,
  StatuslineLayoutDef,
  StatuslineRuleDef,
  StatuslineSegmentDef,
  StatuslineSourceName,
  StatuslineWidthBand,
} from './schema.js';

const SOURCES = new Set<StatuslineSourceName>([
  'session', 'provider', 'machines', 'seats', 'loops', 'git', 'alerts', 'build',
]);
const BANDS = new Set<StatuslineWidthBand>(['xs', 'sm', 'md', 'lg']);
const FORMATS = new Set(['text', 'count', 'ratio', 'dot']);

/** `line`: 1-based line in the YAML source the issue points at (STATUSLINE-CONTRACT-V1), when it can be found. */
export type StatuslineLoadIssue = { readonly path: string; readonly message: string; readonly line?: number };

/** The contract version this build reads. A file without `version:` is read as this version. */
export const STATUSLINE_CONTRACT_VERSION = 1;

export type StatuslineLoadResult =
  | { readonly ok: true; readonly definition: StatuslineDefinition }
  | { readonly ok: false; readonly issues: readonly StatuslineLoadIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(row: Record<string, unknown>, key: string, path: string, issues: StatuslineLoadIssue[], required = false): string | undefined {
  const value = row[key];
  if (value === undefined || value === null || value === '') {
    if (required) issues.push({ path, message: `${key} is required` });
    return undefined;
  }
  if (typeof value !== 'string') {
    issues.push({ path, message: `${key} must be a string` });
    return undefined;
  }
  return value;
}

function stringList(value: unknown, path: string, issues: StatuslineLoadIssue[]): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    issues.push({ path, message: 'expected a list of non-empty strings' });
    return undefined;
  }
  return value as string[];
}

/** YAML quotes are optional: `when: provider_usage > 0.85` parses as a string. */
function conditionField(value: unknown, path: string, issues: StatuslineLoadIssue[], required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) issues.push({ path, message: 'when is required' });
    return undefined;
  }
  if (typeof value !== 'string') {
    issues.push({ path, message: 'when must be a string' });
    return undefined;
  }
  checkCondition(value, path, issues);
  return value;
}

function checkCondition(source: string, path: string, issues: StatuslineLoadIssue[]): void {
  const verdict = evaluateOverlayCondition(source, {});
  if (verdict.kind === 'unparseable') issues.push({ path, message: `unreadable condition: ${source}` });
}

/**
 * A key a row does not know is an error with its line (#38316 REVIEW-2): the JSON Schema says
 * additionalProperties:false, so the loader refuses the same keys instead of dropping them quietly.
 */
function refuseUnknownKeys(row: Record<string, unknown>, known: readonly string[], path: string, issues: StatuslineLoadIssue[]): void {
  for (const key of Object.keys(row)) if (!known.includes(key)) issues.push({ path: `${path}.${key}`, message: 'unknown key' });
}

function parseSegment(value: unknown, index: number, issues: StatuslineLoadIssue[]): StatuslineSegmentDef | undefined {
  const path = `segments[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: 'segment must be a map' });
    return undefined;
  }
  refuseUnknownKeys(value, ['id', 'source', 'field', 'label', 'format', 'when'], path, issues);
  const id = stringField(value, 'id', path, issues, true);
  const source = stringField(value, 'source', path, issues, true);
  const field = stringField(value, 'field', path, issues, true);
  const label = stringField(value, 'label', path, issues);
  const format = stringField(value, 'format', path, issues);
  const when = conditionField(value.when, `${path}.when`, issues);
  if (source !== undefined && !SOURCES.has(source as StatuslineSourceName)) {
    issues.push({ path, message: `unknown source: ${source}` });
  }
  if (format !== undefined && !FORMATS.has(format)) issues.push({ path, message: `unknown format: ${format}` });
  if (!id || !source || !field || !SOURCES.has(source as StatuslineSourceName)) return undefined;
  if (format !== undefined && !FORMATS.has(format)) return undefined;
  return {
    id, source: source as StatuslineSourceName, field,
    ...(label !== undefined ? { label } : {}),
    ...(format !== undefined ? { format: format as StatuslineSegmentDef['format'] } : {}),
    ...(when !== undefined ? { when } : {}),
  };
}

function parseRule(value: unknown, index: number, issues: StatuslineLoadIssue[]): StatuslineRuleDef | undefined {
  const path = `rules[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: 'rule must be a map' });
    return undefined;
  }
  refuseUnknownKeys(value, ['id', 'when', 'color', 'glyph', 'hide', 'segments', 'bands'], path, issues);
  const id = stringField(value, 'id', path, issues, true);
  const when = conditionField(value.when, `${path}.when`, issues, true);
  const color = stringField(value, 'color', path, issues);
  const glyph = stringField(value, 'glyph', path, issues);
  const segments = stringList(value.segments, `${path}.segments`, issues);
  const bands = stringList(value.bands, `${path}.bands`, issues);
  if (bands?.some((band) => !BANDS.has(band as StatuslineWidthBand))) issues.push({ path: `${path}.bands`, message: `unknown band: ${bands.find((band) => !BANDS.has(band as StatuslineWidthBand))}` });
  if (value.hide !== undefined && typeof value.hide !== 'boolean') issues.push({ path, message: 'hide must be a boolean' });
  if (!id || !when) return undefined;
  return {
    id, when,
    ...(color !== undefined ? { color } : {}),
    ...(glyph !== undefined ? { glyph } : {}),
    ...(value.hide === true ? { hide: true } : {}),
    ...(segments !== undefined ? { segments } : {}),
    ...(bands !== undefined && bands.every((band) => BANDS.has(band as StatuslineWidthBand)) ? { bands: bands as StatuslineWidthBand[] } : {}),
  };
}

/** `bands: { xs: 40, sm: 80, md: 140 }` — any subset; whole columns ≥ 1; together with the defaults they increase. */
function parseBands(value: unknown, issues: StatuslineLoadIssue[]): Partial<StatuslineBandBreakpoints> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) { issues.push({ path: 'bands', message: 'bands must map xs/sm/md to a column count' }); return undefined; }
  const out: Record<string, number> = {};
  for (const [key, edge] of Object.entries(value)) {
    if (key !== 'xs' && key !== 'sm' && key !== 'md') { issues.push({ path: `bands.${key}`, message: 'unknown key' }); continue; }
    if (typeof edge !== 'number' || !Number.isInteger(edge) || edge < 1) { issues.push({ path: `bands.${key}`, message: 'must be a whole number of columns ≥ 1' }); continue; }
    out[key] = edge;
  }
  const merged = { ...STATUSLINE_BREAKPOINTS, ...out };
  if (!(merged.xs < merged.sm && merged.sm < merged.md)) issues.push({ path: 'bands', message: `bands must increase xs < sm < md (got ${merged.xs} · ${merged.sm} · ${merged.md})` });
  return out;
}

function parseLayout(value: unknown, index: number, issues: StatuslineLoadIssue[]): StatuslineLayoutDef | undefined {
  const path = `layouts[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: 'layout must be a map' });
    return undefined;
  }
  refuseUnknownKeys(value, ['band', 'lines', 'segments', 'secondLine', 'drop', 'shorten'], path, issues);
  const band = stringField(value, 'band', path, issues, true);
  const segments = stringList(value.segments, `${path}.segments`, issues);
  const secondLine = stringList(value.secondLine, `${path}.secondLine`, issues);
  const drop = stringList(value.drop, `${path}.drop`, issues);
  let shorten: Record<string, string> | undefined;
  if (value.shorten !== undefined) {
    if (!isRecord(value.shorten) || Object.values(value.shorten).some((id) => typeof id !== 'string' || id === '')) {
      issues.push({ path: `${path}.shorten`, message: 'shorten must map a segment id to a shorter segment id' });
    } else shorten = value.shorten as Record<string, string>;
  }
  if (drop && segments && drop.some((id) => !segments.includes(id) && !(secondLine ?? []).includes(id))) {
    issues.push({ path: `${path}.drop`, message: 'drop may only name segments of this layout' });
  }
  if (band !== undefined && !BANDS.has(band as StatuslineWidthBand)) issues.push({ path, message: `unknown band: ${band}` });
  if (value.lines !== 1 && value.lines !== 2) issues.push({ path, message: 'lines must be 1 or 2' });
  if (value.lines === 2 && secondLine === undefined) issues.push({ path, message: 'two-line layout needs secondLine' });
  if (value.lines === 1 && secondLine !== undefined) issues.push({ path, message: 'one-line layout cannot have secondLine' });
  if (!band || !BANDS.has(band as StatuslineWidthBand) || !segments || (value.lines !== 1 && value.lines !== 2)) return undefined;
  return {
    band: band as StatuslineWidthBand,
    lines: value.lines,
    segments,
    ...(secondLine !== undefined ? { secondLine } : {}),
    ...(drop !== undefined ? { drop } : {}),
    ...(shorten !== undefined ? { shorten } : {}),
  };
}

/** Parse one YAML document into a definition. Unknown keys are rejected, not ignored. */
export function parseStatuslineYaml(source: string, options?: { readonly partial?: boolean }): StatuslineLoadResult {
  const issues: StatuslineLoadIssue[] = [];
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, prettyErrors: false });
  if (doc.errors.length > 0) {
    const error = doc.errors[0]!;
    const line = error.pos?.[0] !== undefined ? lineCounter.linePos(error.pos[0]).line : undefined;
    return { ok: false, issues: [{ path: '', message: `YAML parse failed: ${error.message.split('\n')[0]}`, ...(line ? { line } : {}) }] };
  }
  const raw: unknown = doc.toJS();
  if (!isRecord(raw)) return { ok: false, issues: [{ path: '', message: 'definition must be a map', line: 1 }] };
  const known = new Set(['version', '$schema', 'segments', 'rules', 'layouts', 'bands', 'position']);
  if (raw.position !== undefined && raw.position !== 'bottom' && raw.position !== 'above-input') {
    issues.push({ path: 'position', message: `position must be bottom or above-input (got ${String(raw.position)})` });
  }
  const bands = parseBands(raw.bands, issues);
  if (raw.version !== undefined && raw.version !== STATUSLINE_CONTRACT_VERSION) {
    issues.push({ path: 'version', message: `unsupported version: ${String(raw.version)} (this build reads ${STATUSLINE_CONTRACT_VERSION})` });
  }
  if (raw.$schema !== undefined && typeof raw.$schema !== 'string') issues.push({ path: '$schema', message: '$schema must be a string' });
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) issues.push({ path: key, message: 'unknown key' });
  }
  const segments = Array.isArray(raw.segments) ? raw.segments.map((row, index) => parseSegment(row, index, issues)) : [];
  const rules = Array.isArray(raw.rules) ? raw.rules.map((row, index) => parseRule(row, index, issues)) : [];
  const layouts = Array.isArray(raw.layouts) ? raw.layouts.map((row, index) => parseLayout(row, index, issues)) : [];
  if (raw.segments !== undefined && !Array.isArray(raw.segments)) issues.push({ path: 'segments', message: 'segments must be a list' });
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) issues.push({ path: 'rules', message: 'rules must be a list' });
  if (raw.layouts !== undefined && !Array.isArray(raw.layouts)) issues.push({ path: 'layouts', message: 'layouts must be a list' });
  const ids = new Set<string>();
  for (const segment of segments) {
    if (!segment) continue;
    if (ids.has(segment.id)) issues.push({ path: `segments.${segment.id}`, message: 'duplicate segment id' });
    ids.add(segment.id);
  }
  if (options?.partial !== true) {
    for (const layout of layouts) {
      if (!layout) continue;
      for (const id of [...layout.segments, ...(layout.secondLine ?? []), ...Object.entries(layout.shorten ?? {}).flat()]) {
        if (!ids.has(id)) issues.push({ path: `layouts.${layout.band}`, message: `unknown segment: ${id}` });
      }
    }
  }
  const seenBands = new Set<string>();
  for (const layout of layouts) {
    if (!layout) continue;
    if (seenBands.has(layout.band)) issues.push({ path: `layouts.${layout.band}`, message: 'duplicate band' });
    seenBands.add(layout.band);
  }
  if (issues.length > 0 || segments.some((row) => !row) || rules.some((row) => !row) || layouts.some((row) => !row)) {
    return { ok: false, issues: issues.map((issue) => withLine(issue, doc.contents, lineCounter)) };
  }
  return {
    ok: true,
    definition: {
      segments: segments as StatuslineSegmentDef[],
      rules: rules as StatuslineRuleDef[],
      layouts: layouts as StatuslineLayoutDef[],
      ...(raw.position === 'bottom' || raw.position === 'above-input' ? { position: raw.position } : {}),
      ...(bands !== undefined && Object.keys(bands).length > 0 ? { bands } : {}),
    },
  };
}

/**
 * The source line an issue path points at: `segments[2].when`, `layouts[0].drop`, `layouts.md` (a band),
 * `segments.fleet` (an id) or a top-level key. The deepest node that exists wins; no node → no line.
 */
function withLine(issue: StatuslineLoadIssue, root: unknown, counter: LineCounter): StatuslineLoadIssue {
  // Where the issue is (OP 11-18, #38329 REVIEW-1):
  //   • every step found → that node's line;
  //   • only the LAST step is a key the found map does not have (a required key left out: `rules[0].when`) → the line
  //     of that map, the row the person must edit;
  //   • any other step not found (a row only the default has, an index past the list, an empty path) → no line: the
  //     place is not in this file, and the nearest ancestor or line 1 would send the person to the wrong place.
  const steps = [...issue.path.matchAll(/([^.[\]]+)|\[(\d+)\]/gu)];
  if (steps.length === 0) return issue;
  let node: unknown = root;
  let at: number | undefined;
  for (const [position, [, name, index]] of steps.entries()) {
    let next: unknown;
    let keyAt: number | undefined;
    if (index !== undefined && isSeq(node)) next = node.items[Number(index)];
    else if (name !== undefined && isMap(node)) {
      const pair = node.items.find((item) => isScalar(item.key) && item.key.value === name);
      if (pair) { keyAt = (pair.key as YamlNode).range?.[0]; next = pair.value ?? pair.key; }
      else if (position === steps.length - 1) {
        // The row is here; its key is missing → the row.
        const rowAt = (node as YamlNode).range?.[0];
        return rowAt === undefined ? issue : { ...issue, line: counter.linePos(rowAt).line };
      }
    } else if (name !== undefined && isSeq(node)) {
      // `segments.<id>` / `layouts.<band>`: the list row whose id or band is that name.
      next = node.items.find((item) => isMap(item) && (item.get('id') === name || item.get('band') === name));
    }
    if (next === undefined || next === null) return issue;
    at = keyAt ?? (next as YamlNode).range?.[0];
    node = next;
  }
  return at === undefined ? issue : { ...issue, line: counter.linePos(at).line };
}

/** The line `issue.path` points at in `source` (for checks made after parsing, e.g. the merge over the default). */
export function locateStatuslineIssue(source: string, issue: StatuslineLoadIssue): StatuslineLoadIssue {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, prettyErrors: false });
  return doc.errors.length > 0 ? issue : withLine(issue, doc.contents, lineCounter);
}

function indexById<T extends { readonly id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/** Later layer wins per id. Seat overwrites default; user overwrites both.
 *  An empty later list does not delete earlier rows — omission keeps the lower layer. */
export function mergeStatuslineLayers(
  base: StatuslineDefinition,
  seat?: StatuslineDefinition,
  user?: StatuslineDefinition,
): StatuslineDefinition {
  const layers = [base, seat, user].filter((layer): layer is StatuslineDefinition => layer !== undefined);
  const segments = new Map<string, StatuslineSegmentDef>();
  const rules = new Map<string, StatuslineRuleDef>();
  const layouts = new Map<string, StatuslineLayoutDef>();
  for (const layer of layers) {
    for (const [id, row] of indexById(layer.segments)) segments.set(id, row);
    for (const [id, row] of indexById(layer.rules)) rules.set(id, row);
    for (const row of layer.layouts) layouts.set(row.band, row);
  }
  const known = new Set([...segments.keys()]);
  for (const layout of layouts.values()) {
    for (const id of [...layout.segments, ...(layout.secondLine ?? [])]) {
      if (!known.has(id)) throw new Error(`merged layout ${layout.band} references unknown segment ${id}`);
    }
  }
  // Band edges: later layer wins per key (an empty map changes nothing). Each file is checked against the defaults
  // when it is read; the merged edges are checked again here (#38349 REVIEW-1: seat sm 100 + user md 90 would leave md
  // never drawn, silently).
  const bands = Object.assign({}, ...layers.map((layer) => layer.bands ?? {})) as Partial<StatuslineBandBreakpoints>;
  const edges = { ...STATUSLINE_BREAKPOINTS, ...bands };
  if (!(edges.xs < edges.sm && edges.sm < edges.md)) {
    throw new Error(`merged bands must increase xs < sm < md (got ${edges.xs} · ${edges.sm} · ${edges.md})`);
  }
  return {
    segments: [...segments.values()],
    rules: [...rules.values()],
    layouts: [...layouts.values()],
    ...(Object.keys(bands).length > 0 ? { bands } : {}),
    // Position: the last layer that says one wins.
    ...(() => { const position = [...layers].reverse().find((layer) => layer.position !== undefined)?.position;
      return position !== undefined ? { position } : {}; })(),
  };
}
