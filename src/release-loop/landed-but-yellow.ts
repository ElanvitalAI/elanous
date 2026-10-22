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

export function evidencePlan(rows: readonly LandedButYellowRow[]): Array<{ id: string; ref: string }> {
  const seen = new Set<string>();
  return rows.flatMap((row) => row.prs.flatMap((pr, index) => {
    if (pr.basis === 'mention' || row.alreadyInEvidence[index]) return [];
    const ref = `#${pr.number}`;
    const key = JSON.stringify([row.id, ref]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: row.id, ref }];
  }));
}

interface PrIndex {
  /** Shape of the list when indexed — a mismatch means the caller changed the array in place. */
  length: number;
  firstNumber: number | undefined;
  lastNumber: number | undefined;
  /** PR positions per body `칸:` line id — the whole-line label the matcher accepts. */
  cellIds: Map<string, number[]>;
  /** PR positions per maximal ASCII-alphanumeric run in the title or body. */
  runs: Map<string, number[]>;
}

const ALNUM_RUN = /[A-Za-z0-9]+/g;
const CELL_LINE = /^[ \t]*칸(?:[ \t]*:[ \t]*|[ \t]+)([A-Za-z0-9_-]+(?:[ \t]*,[ \t]*[A-Za-z0-9_-]+)*)[ \t]*$/;
const prIndexes = new WeakMap<readonly MergedChecklistPr[], PrIndex>();

function push(map: Map<string, number[]>, key: string, position: number): void {
  const list = map.get(key);
  if (!list) map.set(key, [position]);
  else if (list[list.length - 1] !== position) list.push(position);
}

/**
 * Built once per PR list (the open audit reuses one list across every version). Contract: callers treat the list as
 * read-only after passing it. A cheap guard still re-indexes when the length or the first/last PR number changed;
 * an in-place edit that keeps all three is not detected.
 */
function prIndex(prs: readonly MergedChecklistPr[]): PrIndex {
  const cached = prIndexes.get(prs);
  if (cached && cached.length === prs.length && cached.firstNumber === prs[0]?.number && cached.lastNumber === prs[prs.length - 1]?.number) return cached;
  const index: PrIndex = { length: prs.length, firstNumber: prs[0]?.number, lastNumber: prs[prs.length - 1]?.number, cellIds: new Map(), runs: new Map() };
  prs.forEach((pr, position) => {
    const body = pr.body ?? '';
    for (const line of body.split('\n')) {
      const match = CELL_LINE.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
      for (const candidate of match?.[1]?.split(',') ?? []) push(index.cellIds, candidate.trim(), position);
    }
    for (const text of [pr.title, body]) for (const [run] of text.matchAll(ALNUM_RUN)) push(index.runs, run, position);
  });
  prIndexes.set(prs, index);
  return index;
}

/**
 * PRs that can match `id` at all — a necessary condition, never a verdict. Every non-cell-line basis needs `id`
 * in the title or body with no ASCII letter/digit on either side, so its leading alphanumeric run appears there
 * as a maximal run. Ids that do not start with a letter or digit fall back to every PR.
 */
function candidatePositions(index: PrIndex, id: string, total: number): number[] {
  const lead = /^[A-Za-z0-9]+/.exec(id)?.[0];
  if (!lead) return Array.from({ length: total }, (_, position) => position);
  const merged = new Set([...(index.cellIds.get(id) ?? []), ...(index.runs.get(lead) ?? [])]);
  return [...merged].sort((a, b) => a - b);
}

/** Prefer a dedicated body cell line over title evidence; incidental mentions only qualify for long ids. */
export function landedButYellow(items: readonly ChecklistItem[], prs: readonly MergedChecklistPr[], { owner }: { owner?: string } = {}): LandedButYellowRow[] {
  const rows: LandedButYellowRow[] = [];
  const index = prIndex(prs);
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
    const cellLines = new Set(index.cellIds.get(item.id) ?? []);
    const matched = candidatePositions(index, item.id, prs.length).flatMap((position) => {
      const pr = prs[position]!;
      const cellLine = cellLines.has(position);
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

export interface MergedPrRunResult { status: number | null; stdout: string; stderr: string }
/** One `gh` invocation; resolves when the process exits. */
export type MergedPrRunner = (command: string, args: readonly string[], cwd: string) => Promise<MergedPrRunResult>;

export const MERGED_PR_LIMIT = 400;
/** Concurrent `gh pr list` calls once the first page is full (LANDED-YELLOW-FAST · 10-21 prod: 24 sequential calls ≈ 145s). */
export const MERGED_PR_CONCURRENCY = 6;
const DAY_MS = 86_400_000;

/**
 * Merged PRs since `since` (UTC date). One call answers when it returns fewer than the cap. Otherwise the range
 * splits into UTC-day windows fetched with a concurrency cap; a full window is halved down to one second as before,
 * and a full one-second window probes one extra row to tell exactly 400 from truncation.
 * The returned set and the truncation flag match the former sequential bisection; only call shape and time differ.
 */
export async function fetchMergedChecklistPrs(since: string, now: Date, run: MergedPrRunner, cwd: string,
  { concurrency = MERGED_PR_CONCURRENCY }: { concurrency?: number } = {}): Promise<{ prs: MergedChecklistPr[]; truncated: boolean; calls: number }> {
  let calls = 0;
  const fetch = async (lower: string, upper?: string, limit = MERGED_PR_LIMIT): Promise<MergedChecklistPr[]> => {
    const search = `merged:>=${lower}${upper ? ` merged:<${upper}` : ''}`;
    calls++;
    const r = await run('gh', ['pr', 'list', '--state', 'merged', '--search', search, '--limit', String(limit), '--json', 'number,title,body,mergedAt'], cwd);
    if (r.status !== 0) throw new Error(`병합 PR 조회(gh) 실패 rc=${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    const page = JSON.parse(r.stdout.trim()) as MergedChecklistPr[];
    if (!Array.isArray(page)) throw new Error('병합 PR 조회(gh): 배열이 아니다');
    return page;
  };
  const first = await fetch(since);
  if (first.length < MERGED_PR_LIMIT) return { prs: first, truncated: false, calls };
  // Bounded pool: at most `concurrency` gh processes at once; a failure stops new calls and rejects.
  let active = 0;
  let failed: unknown;
  const waiting: Array<() => void> = [];
  const limited = async <T>(task: () => Promise<T>): Promise<T> => {
    while (active >= Math.max(1, concurrency) && failed === undefined) await new Promise<void>((resolve) => waiting.push(resolve));
    if (failed !== undefined) throw failed;
    active++;
    try { return await task(); }
    catch (error) { failed ??= error; throw error; }
    finally { active--; if (failed !== undefined) for (const wake of waiting.splice(0)) wake(); else waiting.shift()?.(); }
  };
  let truncated = false;
  const visit = async (start: number, end: number): Promise<MergedChecklistPr[]> => {
    const from = new Date(start).toISOString();
    const to = new Date(end).toISOString();
    const page = await limited(() => fetch(from, to));
    if (page.length < MERGED_PR_LIMIT) return page;
    if (end - start <= 1000) {
      // The second-precision search cannot be subdivided; probe one extra row to distinguish exactly 400 from a real truncation.
      const probe = await limited(() => fetch(from, to, MERGED_PR_LIMIT + 1));
      if (probe.length > MERGED_PR_LIMIT) truncated = true;
      return probe.slice(0, MERGED_PR_LIMIT);
    }
    const middle = start + Math.floor((end - start) / 2000) * 1000;
    const [left, right] = await Promise.all([visit(start, middle), visit(middle, end)]);
    return [...left, ...right];
  };
  const lower = Date.parse(`${since}T00:00:00Z`);
  const upper = Math.max(lower + 1000, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const windows: Array<[number, number]> = [];
  for (let start = lower; start < upper; start += DAY_MS) windows.push([start, Math.min(start + DAY_MS, upper)]);
  const settled = await Promise.allSettled(windows.map(([start, end]) => visit(start, end)));
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw failed ?? rejected.reason;
  // Chronological window order, first occurrence wins — the same de-duplication as before.
  const unique = new Map<number, MergedChecklistPr>();
  for (const result of settled) for (const pr of (result as PromiseFulfilledResult<MergedChecklistPr[]>).value) if (!unique.has(pr.number)) unique.set(pr.number, pr);
  return { prs: [...unique.values()], truncated, calls };
}
