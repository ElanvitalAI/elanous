import type { ContextCard } from './index.js';

export interface CellCardItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly owner?: string | null;
  readonly disposition?: string;
  readonly evidence?: string;
}

const POINTER_PATTERN = /#\d+|run-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;

function extractPointers(text: string): string[] {
  return [...text.matchAll(POINTER_PATTERN)].map(([pointer]) => pointer);
}

/** Build a compact checklist-cell card; evidence is used only to derive stable source pointers. */
export function buildCellCard(version: string, item: CellCardItem, asOf: string): ContextCard {
  const pointers = [...new Set([
    ...extractPointers(item.evidence ?? ''),
    ...extractPointers(item.title),
    `checklist:${version}/${item.id}`,
  ])];
  const reasons = [
    item.owner ? `담당 ${item.owner}` : undefined,
    item.disposition ? `처분 ${item.disposition}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return {
    id: `cell:${version}/${item.id}`,
    kind: 'cell',
    conclusion: (item.title.split(/[\r\n\u2028\u2029]/u, 1)[0] ?? '').trim(),
    why: reasons.join(' · '),
    verdict: item.status,
    remaining: [],
    pointers,
    source: `release-checklist:${version}`,
    updatedAt: asOf,
  };
}
