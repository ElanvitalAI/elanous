import { formatSidetabLines as formatCoreSidetabLines, type SidetabRow } from '../../sidetab-core/model.js';
import { formatSidetabPeekLines } from './peek.js';

export type SidetabSectionId = 'sessions' | 'harness' | 'pods' | 'herdr' | 'remote';
export interface SidetabSection {
  readonly id: SidetabSectionId;
  readonly label: string;
  readonly rows: readonly SidetabRow[];
}

const SECTION_LABELS: Readonly<Record<SidetabSectionId, string>> = {
  sessions: 'Sessions', harness: 'Harness runs', pods: 'Pods', herdr: 'Herdr', remote: 'Remote',
};
export const DEFAULT_SIDETAB_SECTION_ORDER: readonly SidetabSectionId[] =
  ['sessions', 'harness', 'pods', 'herdr', 'remote'];

export function normalizeSidetabSectionOrder(value: unknown): SidetabSectionId[] {
  const requested = Array.isArray(value) ? value.filter((id): id is SidetabSectionId =>
    DEFAULT_SIDETAB_SECTION_ORDER.includes(id as SidetabSectionId)) : [];
  return [...new Set([...requested, ...DEFAULT_SIDETAB_SECTION_ORDER])];
}

export function sidetabSectionForRow(row: SidetabRow): SidetabSectionId {
  if (row.remoteHost) return 'remote';
  if (row.kind === 'herdr') return 'herdr';
  if (row.kind === 'pod') return 'pods';
  if (row.kind === 'tui' && row.sessionId) return 'sessions';
  if (row.kind === 'workspace' || row.runId) return 'harness';
  return 'sessions';
}

/** Stable ordering within each section; absent sections consume no screen rows. */
export function groupSidetabSections(
  rows: readonly SidetabRow[],
  order: readonly SidetabSectionId[] = DEFAULT_SIDETAB_SECTION_ORDER,
): SidetabSection[] {
  const buckets = new Map<SidetabSectionId, SidetabRow[]>(DEFAULT_SIDETAB_SECTION_ORDER.map((id) => [id, []]));
  for (const row of rows) buckets.get(sidetabSectionForRow(row))!.push(row);
  const ordered = normalizeSidetabSectionOrder(order);
  return ordered.filter((id) => buckets.get(id)!.length > 0).map((id) => ({
    id, label: SECTION_LABELS[id], rows: buckets.get(id)!,
  }));
}

/** A drag moves one section before another or after the last section. */
export function reorderSidetabSections(
  order: readonly SidetabSectionId[],
  dragged: SidetabSectionId,
  before: SidetabSectionId | 'end',
): SidetabSectionId[] {
  const full = normalizeSidetabSectionOrder(order);
  if (dragged === before || !full.includes(dragged) || (before !== 'end' && !full.includes(before))) return full;
  const without = full.filter((id) => id !== dragged);
  without.splice(before === 'end' ? without.length : without.indexOf(before), 0, dragged);
  return without;
}

export type SidetabSectionTarget =
  | { readonly kind: 'section'; readonly id: SidetabSectionId }
  | { readonly kind: 'row'; readonly index: number }
  | { readonly kind: 'end' };

export interface SidetabSectionFrame {
  readonly lines: readonly string[];
  readonly start: number;
  readonly maxStart: number;
  /** One-based terminal rows, matching SGR mouse coordinates. */
  readonly targets: ReadonlyMap<number, SidetabSectionTarget>;
}

type SectionItem = { readonly text: string; readonly target?: SidetabSectionTarget };
const cells = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function fit(value: string, width: number): string {
  let result = '';
  let used = 0;
  const cut = Bun.stringWidth(value) > width;
  const limit = Math.max(0, width - (cut ? 1 : 0));
  for (const { segment } of cells.segment(value)) {
    const size = Bun.stringWidth(segment);
    if (used + size > limit) break;
    result += segment;
    used += size;
  }
  if (cut && width > 0) { result += '…'; used++; }
  return result + ' '.repeat(Math.max(0, width - used));
}

/** The same row renderer is used for every group; only headings and viewport projection differ. */
export function formatSidetabSectionFrame(
  rows: readonly SidetabRow[], selected: number, width: number, height: number,
  order: readonly SidetabSectionId[] = DEFAULT_SIDETAB_SECTION_ORDER,
  scrollStart?: number,
): SidetabSectionFrame {
  const normalized = normalizeSidetabSectionOrder(order);
  const base = formatCoreSidetabLines(rows, selected, width, 3);
  const items: SectionItem[] = [];
  for (const id of normalized) {
    const indexed = rows.map((row, index) => ({ row, index })).filter(({ row }) => sidetabSectionForRow(row) === id);
    items.push({ text: fit(` ${SECTION_LABELS[id]} · ${indexed.length}`, width), target: { kind: 'section', id } });
    for (const { row, index } of indexed) {
      const line = formatCoreSidetabLines([row], index === selected ? 0 : -1, width, 4)[2] ?? fit(row.label, width);
      items.push({ text: line, target: { kind: 'row', index } });
      if (index === selected) {
        const source = (row as SidetabRow & { readonly previewSource?: string }).previewSource ?? '';
        const preview = formatSidetabPeekLines(source, width);
        if (preview.length > 0) items.push({ text: fit('', width) }, ...preview.map((text) => ({ text })));
      }
    }
  }
  const capacity = Math.max(0, Math.floor(height) - 3);
  const selectedAt = items.findIndex((item) => item.target?.kind === 'row' && item.target.index === selected);
  const maxStart = Math.max(0, items.length - capacity);
  const autoStart = selectedAt < 0 ? 0 : Math.max(0, selectedAt - capacity + 1);
  const start = scrollStart === undefined ? autoStart : Math.max(0, Math.min(maxStart, Math.floor(scrollStart)));
  const visible = items.slice(start, start + capacity);
  const targets = new Map<number, SidetabSectionTarget>();
  visible.forEach((item, index) => { if (item.target) targets.set(index + 3, item.target); });
  targets.set(visible.length + 3, { kind: 'end' });
  const lines = [base[0] ?? fit(' 세션 · PTY', width), base[1] ?? fit(' ↑↓ 전환 · 클릭 선택', width),
    ...visible.map((item) => item.text), fit(' + new · /side new', width)];
  return { lines, targets, start, maxStart };
}

export function sidetabSectionTargetAt(
  frame: SidetabSectionFrame, terminalRow: number, terminalCol: number, width: number,
): SidetabSectionTarget | undefined {
  return terminalCol >= 1 && terminalCol <= width ? frame.targets.get(terminalRow) : undefined;
}
