import { listChecklist, type ChecklistItem } from '../release-loop/checklist.js';

export interface InterpretationCard {
  what: string;
  cell: string | null;
  unknowns: string[];
}

export type CellCandidate = Pick<ChecklistItem, 'id' | 'title'>;

/** The same SQLite-backed cells exposed by `elanous release checklist list --version <v>`. */
export function readCellCandidates(version: string): CellCandidate[] {
  return listChecklist(version).items.map(({ id, title }) => ({ id, title }));
}

/** Interpret a single directive without querying state or inventing a release cell. */
export function interpretDirective(line: string, candidates: readonly CellCandidate[]): InterpretationCard {
  if (/\r|\n/.test(line)) throw new Error('지시는 한 줄이어야 한다');
  const what = line.trim();
  if (!what) throw new Error('빈 지시는 해석할 수 없다');

  const matches = candidates.filter(({ id, title }) =>
    (id && new RegExp(`(^|[^\\p{L}\\p{N}])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}]|[을를은는이가에의와과])`, 'u').test(what)) ||
    (title && what.includes(title)));

  if (matches.length === 1) return { what, cell: matches[0]!.id, unknowns: [] };
  return {
    what,
    cell: null,
    unknowns: [matches.length ? `칸 후보가 여럿이다: ${matches.map(({ id }) => id).join(', ')}` : '연결할 칸을 확인해야 한다'],
  };
}

export function renderInterpretationCard(card: InterpretationCard): string {
  return `무엇: ${card.what}\n칸: ${card.cell ?? '확인 필요'}\n미확인: ${card.unknowns.join(', ') || '없음'}`;
}
