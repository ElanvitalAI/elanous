/**
 * SEAT-PULL-ON-IDLE-LIVE — the one idle chooser (PR-a, pure).
 *
 * Every rest branch (own cell, landed-but-yellow, ownerless) goes through
 * {@link chooseSeatPull} and nothing else. Order, owner ignored on the first:
 *   1. landed-but-yellow (a merged evidence PR, whoever owns the cell)
 *   2. this seat's own open cell
 *   3. an ownerless yellow claim
 * This file does not read a ledger, send mail, or write a checklist owner.
 * Landed means one gh view of a PR named in the cell's checklist evidence.
 * Without a lookup the landed state is unknown, so no rank is final (#38232).
 */
export type SeatPullKind = 'landed' | 'own' | 'claim';

export interface SeatPullCell {
  id: string;
  title: string;
  status: 'green' | 'yellow' | 'red' | 'done';
  /** Empty string and null are both ownerless. «TC/rel» names seat TC. */
  owner?: string | null;
  priority?: 'P0' | 'P1' | 'P2';
  /**
   * PR numbers named in the cell's checklist evidence (`#123`).
   * Landed means one of those PRs is MERGED on gh — not a second ledger.
   */
  evidencePrs?: readonly number[];
  /** The open version this cell was read from. The caller names it in mail. */
  version?: string;
}

export interface SeatPullChoice {
  kind: SeatPullKind;
  id: string;
  /** One line: the cell and why it was chosen. */
  line: string;
  /** Set for a landed ask and an ownerless claim. An own cell sends none. */
  mail?: { to: 'OP'; body: string };
}

const RANK: Record<NonNullable<SeatPullCell['priority']>, number> = { P0: 0, P1: 1, P2: 2 };

/** «TC/rel» → «TC». Empty is ownerless. */
function seatPullOwner(owner: string | null | undefined): string {
  const seat = owner?.split('/')[0]?.trim().toUpperCase();
  return seat ? seat : '';
}

/** One gh look-up. `null` means the call failed — that is not «not merged». */
export type SeatPullPrLookup = (number: number) => { merged: boolean; sha: string } | null;

/**
 * A cell is landed when its evidence names a PR and that one gh view says MERGED.
 * The first merged number wins. A failed look-up is skipped, never treated as landed.
 */
function landedEvidencePr(
  prs: readonly number[] | undefined,
  lookup: SeatPullPrLookup,
): { number: number; sha: string } | null {
  for (const number of prs ?? []) {
    const row = lookup(number);
    if (row?.merged && row.sha) return { number, sha: row.sha };
  }
  return null;
}

function byRankThenId(a: SeatPullCell, b: SeatPullCell): number {
  const rank = (cell: SeatPullCell) => (cell.priority ? RANK[cell.priority] : Number.POSITIVE_INFINITY);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * One choice. Landed-but-yellow wins whoever owns it, then this seat's own
 * open cell, then an ownerless yellow claim. Nothing else is chosen.
 * `lookup` is required: without it a yellow cell's landed state is unknown,
 * so this returns null instead of confirming own or claim (#38232).
 */
export function chooseSeatPull(
  seat: string,
  cells: readonly SeatPullCell[],
  version: string,
  lookup: SeatPullPrLookup,
): SeatPullChoice | null {
  const want = seat.trim().toUpperCase();
  if (!want || !lookup) return null;
  const named = (cell: SeatPullCell) => cell.version?.trim() || version;
  const yellow = cells.filter(cell => cell.status === 'yellow').slice().sort(byRankThenId);
  const landed = yellow
    .map(cell => ({ cell, pr: landedEvidencePr(cell.evidencePrs, lookup) }))
    .filter((row): row is { cell: SeatPullCell; pr: { number: number; sha: string } } => row.pr !== null);
  if (landed.length > 0) {
    const { cell, pr } = landed[0]!;
    const owner = seatPullOwner(cell.owner);
    const ownerNote = owner ? `owner stays ${owner}` : 'ownerless';
    return {
      kind: 'landed', id: cell.id,
      line: `${want} ${cell.id} landed-but-yellow #${pr.number} ${pr.sha} → JUD`,
      mail: { to: 'OP', body: `[JUD-ASK] ${named(cell)} ${cell.id} landed-but-yellow #${pr.number} ${pr.sha} — ${want} asks JUD (${ownerNote})` },
    };
  }
  const own = yellow.filter(cell => seatPullOwner(cell.owner) === want);
  if (own.length > 0) {
    const cell = own[0]!;
    return { kind: 'own', id: cell.id, line: `${want} ${cell.id} own ${cell.priority ?? 'unranked'} yellow` };
  }
  const ownerless = yellow.filter(cell => seatPullOwner(cell.owner) === '');
  if (ownerless.length > 0) {
    const cell = ownerless[0]!;
    const body = `[CELL-CLAIM-REQ] ${named(cell)} ${cell.id} · ${cell.title} — ${want} 선점 요청 (원장 변경은 OP 확인 뒤)`;
    return { kind: 'claim', id: cell.id, line: `${want} ${cell.id} ownerless yellow → claim-request`, mail: { to: 'OP', body } };
  }
  return null;
}
