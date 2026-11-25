// RESOURCE-OPT-HOURLY (OP trace 11-25 lever L1) — the matching table: idle seats × open work, from ledgers only (no LLM).
//
// S: on 11-25 OP's loop was a reply collector — 57 of 62 wakes collected replies, the retro read «30분마다 유휴 탭 가속»
//    ten times and ran it zero times, and idle seats stayed at 23–26 all day.
// C: nothing put «idle seat × open cell» in front of OP as a decision it had to close; the numbers sat in op-eval.
// Q: what does OP get every hour so that the only way out of the turn is to dispose of each idle seat and open item?
// A: this table — idle seats (els list · since), unowned / 2h-stalled 🟡 cells of the current release (P0 → P1 → rest),
//    open non-draft PRs without a pregate receipt for their CURRENT head (by author seat), and the judge queue with its
//    age. Each row carries an id (RO-n) that the assignment turn must close with an action or a reject reason
//    (assignment-gate.ts). Pure: every input is passed in, so fixtures decide the table.

export const RESOURCE_OPT_STALL_MS = 2 * 60 * 60_000;
export const RESOURCE_OPT_JUDGE_AGE_MS = 30 * 60_000;
export const RESOURCE_OPT_ROW_CAP = 20;

export interface PaneIn { seat?: string; state: string; since?: number }
export interface CellIn { id: string; title: string; status: string; owner?: string; priority?: string; updatedAt: string }
export interface PrIn { number: number; headSha: string; branch: string; title?: string; isDraft: boolean }
export interface JudgeIn { id: string; owner?: string | null; sinceMs: number; pr?: number }

export interface MatchingInput {
  now: number;
  version: string;
  /** The HQ coordinator seat — never matched to work itself. */
  hqSeat: string;
  panes: readonly PaneIn[];
  cells: readonly CellIn[];
  prs: readonly PrIn[];
  /** Pregate GREEN lane directory names `<PR>-<head12>-<host>`. */
  greenLanes: readonly string[];
  judgeQueue: readonly JudgeIn[];
  /** Sources that could not be read — shown in the prompt, never silently empty. */
  unmeasured?: readonly string[];
  /**
   * MATCHING-FALL-THROUGH (SIM-STEWARD-AB-1125 FU 8) — assignments the steward tried and SeatAssign refused. A pair
   * (`seat` set) is never offered again; a cell-wide refusal (no `seat` · e.g. a live writer holds the cell's paths) takes
   * the cell out of matching, so the idle seat falls through to the next candidate cell instead of idling all hour.
   */
  refused?: ReadonlyArray<{ readonly cell: string; readonly seat?: string }>;
}

export type MatchingRow =
  | { id: string; kind: 'assign'; seat: string; idleMin: number | null; cell: string; title: string; priority: string; why: 'unowned' | 'stalled' | 'owner-idle' }
  | { id: string; kind: 'pregate'; seat: string; branch: string; pr: number; head: string; title: string }
  | { id: string; kind: 'judge'; cell: string; owner: string | null; ageMin: number; pr: number | null }
  | { id: string; kind: 'idle'; seat: string; idleMin: number | null };

export interface MatchingSummary {
  idle: number;
  unowned: number;
  stalled: number;
  prsWithoutReceipt: number;
  judgeQueue: number;
  judgeOldestMin: number | null;
  /** Cells that got no idle seat (more work than idle seats). */
  unmatchedCells: number;
  /** Rows beyond RESOURCE_OPT_ROW_CAP (not in this table). */
  overflow: number;
}

export interface MatchingTable { at: number; version: string; hqSeat: string; rows: MatchingRow[]; summary: MatchingSummary; unmeasured: string[] }

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
const rank = (priority: string | undefined): number => PRIORITY_RANK[priority ?? ''] ?? 3;
const minutes = (ms: number): number => Math.max(0, Math.floor(ms / 60_000));

/** The seat part of an owner (`TC-H-CX-3`, `TC/golden`, `OP:sub` → `TC-H-CX-3`, `TC`, `OP`). */
export function ownerSeat(owner: string | undefined | null): string | null {
  const seat = (owner ?? '').trim().split(/[/:\s]/u)[0]?.toUpperCase() ?? '';
  return seat ? seat : null;
}

/** Author seat of a PR from its branch prefix (`tc-h-cx-2/x` → `TC-H-CX-2` · `cc2/x` → `CC2` · no prefix → null). */
export function seatFromBranch(branch: string): string | null {
  const slash = branch.indexOf('/');
  if (slash <= 0) return null;
  const head = branch.slice(0, slash);
  return /^[a-z][a-z0-9-]{0,31}$/u.test(head) ? head.toUpperCase() : null;
}

/** A pregate receipt for this exact head: a GREEN lane `<PR>-<head12>-<host>`. */
export function hasSameHeadReceipt(pr: number, headSha: string, lanes: readonly string[]): boolean {
  const prefix = `${pr}-${headSha.slice(0, 12).toLowerCase()}-`;
  return headSha.length >= 12 && lanes.some((lane) => lane.startsWith(prefix));
}

export function buildMatchingTable(input: MatchingInput): MatchingTable {
  const hq = input.hqSeat.toUpperCase();
  // Idle seats: one per seat (oldest idle since wins), never the HQ coordinator itself; oldest idle first.
  const idleBySeat = new Map<string, number | null>();
  for (const pane of input.panes) {
    const seat = pane.seat?.trim().toUpperCase();
    if (!seat || seat === hq || pane.state !== 'IDLE') continue;
    const since = typeof pane.since === 'number' && Number.isFinite(pane.since) ? pane.since : null;
    const prior = idleBySeat.get(seat);
    if (prior === undefined || (since !== null && (prior === null || since < prior))) idleBySeat.set(seat, since);
  }
  const idle = [...idleBySeat.entries()]
    .sort((a, b) => (a[1] ?? Infinity) - (b[1] ?? Infinity) || a[0].localeCompare(b[0]))
    .map(([seat, since]) => ({ seat, idleMin: since === null ? null : minutes(input.now - since) }));

  // Open work: 🟡 cells with no owner, or with no movement for 2h. P0 → P1 → P2 → none; unowned before stalled; oldest first.
  const open = input.cells.filter((cell) => cell.status === 'yellow').flatMap((cell) => {
    const owner = ownerSeat(cell.owner);
    const updated = Date.parse(cell.updatedAt);
    const stalled = Number.isFinite(updated) && input.now - updated >= RESOURCE_OPT_STALL_MS;
    if (owner && !stalled) return [];
    return [{ cell, owner, updated: Number.isFinite(updated) ? updated : 0 }];
  }).sort((a, b) => rank(a.cell.priority) - rank(b.cell.priority) || Number(a.owner !== null) - Number(b.owner !== null) || a.updated - b.updated);

  const free = new Map(idle.map((row) => [row.seat, row] as const));
  const picked = new Map<string, { seat: string; idleMin: number | null }>();
  const refusedCells = new Set((input.refused ?? []).filter((r) => !r.seat).map((r) => r.cell.toUpperCase()));
  const refusedPairs = new Set((input.refused ?? []).filter((r) => r.seat).map((r) => `${r.cell.toUpperCase()}|${r.seat!.toUpperCase()}`));
  const allowed = (cellId: string, seat: string): boolean => !refusedCells.has(cellId.toUpperCase()) && !refusedPairs.has(`${cellId.toUpperCase()}|${seat}`);
  // Pass 1: a stalled cell whose owner sits idle goes back to that owner (no hand-over cost, the owner knows the cell).
  for (const { cell, owner } of open) {
    if (owner && free.has(owner) && allowed(cell.id, owner)) { picked.set(cell.id, free.get(owner)!); free.delete(owner); }
  }
  // Pass 2: the rest in priority order to the longest-idle seat this cell was not refused for.
  for (const { cell } of open) {
    if (picked.has(cell.id)) continue;
    const next = [...free.values()].find((row) => allowed(cell.id, row.seat));
    if (!next) continue;
    picked.set(cell.id, next);
    free.delete(next.seat);
  }
  const assign: Array<Omit<Extract<MatchingRow, { kind: 'assign' }>, 'id'>> = [];
  let unmatchedCells = 0;
  for (const { cell, owner } of open) {
    const pick = picked.get(cell.id);
    if (!pick) { unmatchedCells += 1; continue; }
    assign.push({ kind: 'assign', seat: pick.seat, idleMin: pick.idleMin, cell: cell.id, title: cell.title.split(/\r?\n/u)[0]!.slice(0, 80),
      priority: cell.priority ?? '-', why: owner === null ? 'unowned' : owner === pick.seat ? 'owner-idle' : 'stalled' });
  }

  // Author seat = the branch prefix when it names a seat seen in the ledgers (a pane or a cell owner); else UNKNOWN.
  const knownSeats = new Set([...input.panes.flatMap((pane) => (pane.seat ? [pane.seat.trim().toUpperCase()] : [])),
    ...input.cells.flatMap((cell) => { const seat = ownerSeat(cell.owner); return seat ? [seat] : []; })]);
  const pregate = input.prs.filter((pr) => !pr.isDraft && !hasSameHeadReceipt(pr.number, pr.headSha, input.greenLanes))
    .sort((a, b) => a.number - b.number)
    .map((pr) => {
      const author = seatFromBranch(pr.branch);
      return { kind: 'pregate' as const, seat: author && knownSeats.has(author) ? author : 'UNKNOWN', branch: pr.branch, pr: pr.number, head: pr.headSha.slice(0, 12), title: (pr.title ?? '').slice(0, 80) };
    });

  const judgeAll = input.judgeQueue.map((item) => ({ item, ageMin: minutes(input.now - item.sinceMs) }));
  const judge = judgeAll.filter((row) => row.ageMin * 60_000 >= RESOURCE_OPT_JUDGE_AGE_MS).sort((a, b) => b.ageMin - a.ageMin)
    .map(({ item, ageMin }) => ({ kind: 'judge' as const, cell: item.id, owner: item.owner ?? null, ageMin, pr: item.pr ?? null }));

  const idleLeft = [...free.values()].map((row) => ({ kind: 'idle' as const, seat: row.seat, idleMin: row.idleMin }));

  const all = [...assign, ...pregate, ...judge, ...idleLeft];
  const rows = all.slice(0, RESOURCE_OPT_ROW_CAP).map((row, index) => ({ ...row, id: `RO-${index + 1}` }) as MatchingRow);
  return {
    at: input.now, version: input.version, hqSeat: hq, rows, unmeasured: [...(input.unmeasured ?? [])],
    summary: {
      idle: idle.length,
      unowned: open.filter((row) => row.owner === null).length,
      stalled: open.filter((row) => row.owner !== null).length,
      prsWithoutReceipt: pregate.length,
      judgeQueue: input.judgeQueue.length,
      judgeOldestMin: judgeAll.length ? Math.max(...judgeAll.map((row) => row.ageMin)) : null,
      unmatchedCells,
      overflow: Math.max(0, all.length - RESOURCE_OPT_ROW_CAP),
    },
  };
}

const idleText = (min: number | null): string => (min === null ? 'idle' : `idle ${min}m`);

/** One table row as the prompt shows it. */
export function rowLine(row: MatchingRow): string {
  switch (row.kind) {
    case 'assign': return `${row.id} assign · ${row.seat} (${idleText(row.idleMin)}) ← ${row.priority} ${row.cell} «${row.title}» (${row.why})`;
    case 'pregate': return `${row.id} pregate · #${row.pr} head ${row.head} by ${row.seat} (${row.branch}) — no same-head receipt «${row.title}»`;
    case 'judge': return `${row.id} judge · ${row.cell}${row.pr ? ` #${row.pr}` : ''} waiting ${row.ageMin}m${row.owner ? ` (owner ${row.owner})` : ''}`;
    case 'idle': return `${row.id} idle · ${row.seat} (${idleText(row.idleMin)}) — no matching cell in this table`;
  }
}

/** The summary as one log/board line: «idle 7 · unowned 4 · stalled 2 · PR no receipt 5 · judge 2 (oldest 74m)». */
export function summaryLine(s: MatchingSummary): string {
  return `idle ${s.idle} · unowned ${s.unowned} · stalled ${s.stalled} · PR no receipt ${s.prsWithoutReceipt} · judge ${s.judgeQueue}${s.judgeOldestMin !== null ? ` (oldest ${s.judgeOldestMin}m)` : ''}`;
}

const hhmm = (ms: number): string => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

/** How to act on a row. SeatAssign (L2) is not on main yet — the mail + checklist owner pair is the action until it lands. */
// TODO(L2 SeatAssign): when `eln seat assign` / the SeatAssign tool lands, name it first here and in the gate's tool list.
export const RESOURCE_OPT_ACTIONS = [
  'assign: `eln msg post --from OP --to <SEAT> --kind assign --body "[RO-n] <cell> — <what> · done when <criterion>"` and `ELANOUS_TRACK=OP eln release checklist set <CELL> --version <v> --owner <SEAT>` (SeatAssign tool when present)',
  'pregate: `eln msg post --from OP --to <SEAT> --kind request --body "[RO-n] pregate #<PR> on its current head (light)"`',
  'judge / reassign: mail the judge seat or the new owner with "[RO-n]" in the body',
] as const;

/** The assignment turn's input: the table is the prompt; the contract says how the turn may end. */
export function formatAssignmentPrompt(table: MatchingTable, opts: { reopen?: { unhandled: readonly string[]; round: number; cap: number } } = {}): string {
  const head = opts.reopen
    ? `[resource-opt] assignment turn reopened (${opts.reopen.round}/${opts.reopen.cap}) — rows without an action or reject reason: ${opts.reopen.unhandled.join(', ')}`
    : `[resource-opt] ${hhmm(table.at)} hourly resource optimization — matching table from ledgers (no LLM) · release ${table.version}`;
  const rows = opts.reopen ? table.rows.filter((row) => opts.reopen!.unhandled.includes(row.id)) : table.rows;
  return [
    head,
    summaryLine(table.summary) + (table.summary.unmatchedCells ? ` · cells without an idle seat ${table.summary.unmatchedCells}` : '') + (table.summary.overflow ? ` · ${table.summary.overflow} more rows next hour` : ''),
    ...(table.unmeasured.length ? [`unmeasured: ${table.unmeasured.join(' · ')}`] : []),
    'Contract — every row ends this turn with exactly one of:',
    '  (a) an action whose tool call carries the row id (e.g. "[RO-3]" in the mail body): assignment, pregate request, reassignment;',
    '  (b) a reply line "RO-3 reject: <reason>".',
    'The turn reopens until every row has one (rows still open after the reopen cap are logged as unhandled).',
    ...RESOURCE_OPT_ACTIONS.map((line) => `- ${line}`),
    'Rows:',
    ...rows.map(rowLine),
  ].join('\n');
}

/**
 * LOOP-TRAFFIC R1 hand-off: the graph node auto-assigns what it can (`eln seat assign`) and passes on only the rows it
 * could not — the exception rows. Ids are kept so the node's run ledger and the assignment turn name the same rows.
 */
export function exceptionTable(table: MatchingTable, rowIds: readonly string[]): MatchingTable {
  const keep = new Set(rowIds);
  return { ...table, rows: table.rows.filter((row) => keep.has(row.id)) };
}
