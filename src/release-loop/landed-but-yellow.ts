import { ownerMatches, type ChecklistItem } from './checklist.js';

export interface MergedChecklistPr { number: number; title: string; body: string | null; mergedAt: string }
type PrMatchBasis = 'cell-line' | 'title-strong' | 'mention';
export interface LandedButYellowRow {
  id: string;
  owner: string | undefined;
  status: 'yellow' | 'red';
  prs: Array<Pick<MergedChecklistPr, 'number' | 'title' | 'mergedAt'> & { basis: PrMatchBasis }>;
  alreadyInEvidence: boolean[];
  newer: boolean;
}

/** Prefer a dedicated body cell line over title evidence; incidental mentions only qualify for long ids. */
export function landedButYellow(items: readonly ChecklistItem[], prs: readonly MergedChecklistPr[], { owner }: { owner?: string } = {}): LandedButYellowRow[] {
  const rows: LandedButYellowRow[] = [];
  for (const item of items) {
    if (item.status !== 'yellow' && item.status !== 'red') continue;
    if (owner !== undefined && !ownerMatches(item.owner, owner)) continue;
    const id = item.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`(?<![A-Za-z0-9])${id}(?![A-Za-z0-9])`);
    const shortId = /^[A-Z]{1,2}\d{1,2}[a-z]?$/.test(item.id);
    const titleStart = shortId
      ? new RegExp(`^${id}(?:$|\\s+(?:수확|(?:첫|둘째|셋째)\\s*조각|fixed|new|old)(?=\\s|:|$))`)
      : new RegExp(`^${id}(?:\\s|$)`);
    const explicitTitle = new RegExp(`(?<![A-Za-z0-9])${id}\\s+(?:수확|(?:첫|둘째|셋째)\\s*조각)(?![A-Za-z0-9가-힣])|\\(${id}\\)`);
    const rank: Record<PrMatchBasis, number> = { 'cell-line': 0, 'title-strong': 1, mention: 2 };
    const matched = prs.flatMap((pr) => {
      const cellLine = (pr.body ?? '').split('\n').some((line) => {
        const match = /^[ \t]*칸(?:[ \t]*:[ \t]*|[ \t]+)([A-Za-z0-9_-]+(?:[ \t]*,[ \t]*[A-Za-z0-9_-]+)*)[ \t]*$/.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
        return match?.[1]?.split(',').some((candidate) => candidate.trim() === item.id) ?? false;
      });
      const basis: PrMatchBasis | undefined = cellLine ? 'cell-line'
        : titleStart.test(pr.title) || explicitTitle.test(pr.title) ? 'title-strong'
          : !shortId && (word.test(pr.title) || word.test(pr.body ?? '')) ? 'mention' : undefined;
      return basis ? [{ number: pr.number, title: pr.title, mergedAt: pr.mergedAt, basis }] : [];
    }).sort((a, b) => rank[a.basis] - rank[b.basis] || b.mergedAt.localeCompare(a.mergedAt) || b.number - a.number);
    if (!matched.length) continue;
    const shown = matched.slice(0, 5);
    rows.push({
      id: item.id, owner: item.owner, status: item.status,
      prs: shown,
      alreadyInEvidence: shown.map(({ number }) => new RegExp(`(?<![A-Za-z0-9_#])#${number}(?![A-Za-z0-9_])`).test(item.evidence ?? '')),
      newer: matched.some((pr) => pr.mergedAt > item.updatedAt),
    });
  }
  return rows.sort((a, b) => Number(b.newer) - Number(a.newer));
}
