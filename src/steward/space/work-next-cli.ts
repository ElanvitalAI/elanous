// `eln work next [--scope <space>] [--seat <seat>] [--json]` — live wiring for work-next.ts (ledger · ladder · activity clock).
import { readAllOpenPrs } from '../../kit/work-pull/open-pr-pages.js';
import { liveSeatFit } from '../../kit/seat-area/index.js';
import { recordFact } from '../../fed-state/ledger.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { loadDeclaredSeatRoles, loadFederationLadder } from '../../msg/hand-raise-ladder.js';
import { isJudgeRole } from '../../seat/hand-pool.js';
import { livePullRequiresDoneWhen } from '../../seat/seat-assign-wip1.js';
import { listChecklist, setWriterIf, swapOwnerIf } from '../../release-loop/checklist.js';
import { activeBoardVersion } from '../../ops-dashboard/current-version.js';
import { cellWaitOf, prDoneTodo, prNamesCell, type AuthorTree, type CellLanes, type CellWait, type WaitFacts } from './cell-wait.js';
import { hasCoordinatorAuthority, livePullPolicy, recentDeclaredPr, readRoster, rosterRank, type BlockResolve } from '../../kit/work-pull/index.js';
import { liveCellLanes, liveGhTargetDeps, liveSources, parsePanes, parsePrs, pullLedgerPath, resolveGhTarget } from './sources.js';
import { appendJsonl, workNext, type BoardCell, type WorkNextDeps } from './work-next.js';
import { blockState, cellBlocksPath, openBlocks, readCellBlockRows, workBlock, type CellBlockRow } from './cell-block.js';
import { defaultMsgStorePath, openMsgStore, openMsgStoreReadOnly } from '../../msg/msg-store.js';

/** Sender of the block exception mail — the steward's own address (tick.ts STEWARD_SENDER). */
const BLOCK_MAIL_SENDER = 'ORCHESTRATOR';

/** The msg_messages columns the reply rule reads. */
export interface BlockReplyRow { readonly id: number; readonly sender: string; readonly recipient: string; readonly reply_to: number | null; readonly created_at: string; readonly refs_json?: string | null }

const refsOf = (row: BlockReplyRow): string[] => { try { const r = JSON.parse(row.refs_json ?? '[]') as unknown; return Array.isArray(r) ? r.map(String) : []; } catch { return []; } };

/** One open block to resolve: the cell, its block row, and the holder's board coordinator. */
export interface BlockReplyQuery { readonly cell: string; readonly block: CellBlockRow; readonly board: string }

/**
 * When the awaited seat answered each open block (epoch ms), or undefined: the first mail FROM `on` after the block's
 * exception mail (id order) that answers it under `resolve` (graphs/policies/work-pull.yaml block.resolve_on): reply-to =
 * replies to the exception mail · cell-ref = its refs carry cell:<ID> · addressed-mail = goes to the holder / its board
 * coordinator (the pre-policy rule · default here). Structured (sender ⊕ id ⊕ reply_to ⊕ refs ⊕ recipient), over `rows`
 * already read. Pure; {@link blockRepliesAtMs} feeds it one query. (cell-touch reads the board, not mail — the caller.)
 */
export function firstBlockReplies(queries: readonly BlockReplyQuery[], rows: readonly BlockReplyRow[], resolve: readonly BlockResolve[] = ['reply-to', 'addressed-mail']): Map<string, number | undefined> {
  const bySender = new Map<string, BlockReplyRow[]>();
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    const k = String(row.sender ?? '').toUpperCase();
    const list = bySender.get(k);
    if (list) list.push(row); else bySender.set(k, [row]);
  }
  const out = new Map<string, number | undefined>();
  for (const { cell, block, board } of queries) {
    const since = block.mailId ?? 0;
    const to = new Set([block.by.toUpperCase(), board.toUpperCase()]);
    const hit = (bySender.get(block.on.toUpperCase()) ?? []).find((r) => r.id > since && r.created_at >= block.at
      && ((resolve.includes('reply-to') && block.mailId !== undefined && r.reply_to === block.mailId)
        || (resolve.includes('cell-ref') && refsOf(r).includes(`cell:${cell}`))
        || (resolve.includes('addressed-mail') && to.has(String(r.recipient ?? '').toUpperCase()))));
    const at = hit ? Date.parse(hit.created_at) : NaN;
    out.set(cell, Number.isFinite(at) ? at : undefined);
  }
  return out;
}

/**
 * LAND10-SUPPLY (0.3.39 P0 · hands' `eln work next` hit the 30 s tool limit — ✋ #199671 · #199748): every open block's
 * reply in ONE msg-store read. It was one query per blocked cell, each a rowid range scan from the exception mail
 * (UPPER(sender) has no index) — ~100 ms × 263 open blocks = 12–26 s on a 201k-row store. Now: one created_at-indexed
 * read of the awaited seats' mails since the oldest block, the rule applied in memory ({@link firstBlockReplies}).
 */
export function blockRepliesAtMs(db: { query: (sql: string) => { all: (...params: Array<string | number>) => unknown[] } }, queries: readonly BlockReplyQuery[], resolve?: readonly BlockResolve[]): Map<string, number | undefined> {
  if (!queries.length) return new Map();
  const seats = [...new Set(queries.map((q) => q.block.on.toUpperCase()))];
  const oldest = queries.map((q) => q.block.at).reduce((a, b) => (b < a ? b : a));
  // refs_json only when the cell-ref rule reads it (a store without the column still answers reply-to / addressed-mail).
  const cols = `id, sender, recipient, reply_to, created_at${resolve?.includes('cell-ref') ? ', refs_json' : ''}`;
  const rows = db.query(`SELECT ${cols} FROM msg_messages WHERE created_at >= ?
    AND UPPER(sender) IN (${seats.map(() => '?').join(', ')})`).all(oldest, ...seats) as BlockReplyRow[]; // no ORDER BY id: it turns the created_at index search into a table scan · firstBlockReplies orders by id
  return firstBlockReplies(queries, rows, resolve);
}

/** One block's reply (the single-block form of {@link blockRepliesAtMs}). */
export function blockRepliedAtMs(block: CellBlockRow, board: string): number | undefined {
  const store = openMsgStoreReadOnly(defaultMsgStorePath());
  try { return blockRepliesAtMs(store.db, [{ cell: block.cell, block, board }]).get(block.cell); } finally { store.close(); }
}

/**
 * Per-child deadline for the two subprocess reads of `eln work next` (`eln side ls --json` · `gh pr list`). A read past it
 * fails like an unreadable source (panes → every owner counts as active, no lease is taken · PRs → every cell counts as
 * active, nothing is skipped) instead of holding a hand past its tool limit (the steward tick keeps the 60 s default).
 */
// 출처: #40619 — LAND10-SUPPLY: hands run `eln work next` under a 30 s tool limit; two reads stay well inside it.
export const WORK_NEXT_CHILD_TIMEOUT_MS = 8_000;

/**
 * The live deps of `eln work next` for `seat` — ONE wiring shared by the CLI and the TUI idle pull knock
 * (seat-work-pull.ts · KNOCK-USES-WORK-NEXT 11-25): ledger · ladder · activity clock · waits · blocks · priorityOrder.
 */
export function liveWorkNextDeps(seatRaw: string, opts: { version?: string; now?: number } = {}): WorkNextDeps {
  const seat = seatRaw.trim().toUpperCase();
  const now = opts.now ?? Date.now();
  const version = opts.version ?? activeBoardVersion();
  const ladder = loadFederationLadder();
  const roles = loadDeclaredSeatRoles();
  const pull = livePullPolicy();
  if (pull.error) debug.log('pool', 'work-pull-policy-unreadable', { error: pull.error });
  // Owners' activity: the session clock (activity.ts). Panes unreadable → every owner counts as active (no lease is taken).
  let active: Map<string, number> | null = null;
  try {
    const sources = liveSources(undefined, now, { childTimeoutMs: WORK_NEXT_CHILD_TIMEOUT_MS });
    active = new Map(parsePanes(sources.panes(), now, sources.sessionActivity).flatMap((s) =>
      s.lastActiveMs !== undefined ? [[s.seat, s.lastActiveMs] as const] : s.activity === 'idle' && s.idleForMs !== null ? [[s.seat, now - s.idleForMs] as const] : s.activity === 'working' ? [[s.seat, now] as const] : []));
  } catch { active = null; }
  // Waiting facts (open PRs ⊕ same-head receipts ⊕ verdicts), read once on first use. Unreadable → every cell counts as
  // active (the pre-rail-30 behaviour: WIP 1 holds, nothing is skipped) — never a wrong claim.
  let openPrs: import('./model.js').PrView[] | null | undefined;
  const readOpenPrs = (): import('./model.js').PrView[] => {
    if (openPrs === null) throw new Error('open PR source unavailable');
    if (openPrs !== undefined) return openPrs;
    try {
      openPrs = parsePrs(readAllOpenPrs(resolveGhTarget(undefined, liveGhTargetDeps()), 20_000));
      return openPrs;
    } catch (error) { openPrs = null; throw error; }
  };
  let facts: WaitFacts | null | undefined;
  const waitFacts = (): WaitFacts | null => {
    if (facts !== undefined) return facts;
    try {
      const sources = liveSources(undefined, now, { childTimeoutMs: WORK_NEXT_CHILD_TIMEOUT_MS });
      facts = { prs: readOpenPrs(),
        receipts: sources.receipts(), verdicts: sources.verdicts() };
    } catch { facts = null; }
    return facts;
  };
  // The board, read once (claims re-read nothing: swapOwnerIf checks the owner it ranked on).
  let items: readonly BoardCell[] | undefined;
  const boardCells = (): readonly BoardCell[] => (items ??= listChecklist(version).items as readonly BoardCell[]);
  // STEWARD-READY-LANES — green-triage lanes (git log ⊕ receipt dirs · no network), independent of the PR read: an
  // unreadable gh still keeps lane a off the board. Unreadable lanes → none (the pre-lane board).
  let lanes: CellLanes | null | undefined;
  const laneMap = (): CellLanes | undefined => {
    if (lanes === undefined) { try { lanes = liveCellLanes(version, boardCells()); } catch { lanes = null; } }
    return lanes ?? undefined;
  };
  const waitOf = (cell: BoardCell): CellWait | null => {
    const f = waitFacts(); const l = laneMap();
    return f || l ? cellWaitOf(cell.id, { prs: f?.prs ?? [], receipts: f?.receipts ?? [], verdicts: f?.verdicts ?? [], ...(l ? { lanes: l } : {}) }) : null;
  };
  const prDone = (cell: BoardCell): string | null => { const f = waitFacts(); return f ? prDoneTodo(cell.id, f, authorTreeOf)?.line ?? null : null; };
  // HAND-PULL-ON-BLOCK — cells parked by `eln work block` (unreadable ledger/mail → no block facts: the cell is a plain board cell).
  const blocksFile = cellBlocksPath(effectiveInstanceRoot());
  let blocks: Map<string, CellBlockRow> = new Map();
  try { blocks = openBlocks(readCellBlockRows(blocksFile), version); } catch { blocks = new Map(); }
  // Replies of ALL open blocks, read once on the first blocked cell (LAND10-SUPPLY · blockRepliesAtMs). Unreadable store →
  // no replies: every open block stays 'blocked' (as a failed per-cell read did).
  let replied: Map<string, number | undefined> | null = null;
  const readReplies = (): Map<string, number | undefined> => {
    const queries: BlockReplyQuery[] = [];
    for (const [cell, block] of blocks) {
      try { queries.push({ cell, block, board: ladder.parentOf(block.by).toUpperCase() }); } catch { /* no board → that block stays open */ }
    }
    try {
      const store = openMsgStoreReadOnly(defaultMsgStorePath());
      try { return blockRepliesAtMs(store.db, queries, pull.policy.blockResolve); } finally { store.close(); }
    } catch { return new Map(); }
  };
  const blockOf = (cell: BoardCell) => {
    const block = blocks.get(cell.id);
    if (!block) return undefined;
    replied ??= readReplies();
    // cell-touch: the awaited seat changed the cell after the block (the board's updatedBy · no mail needed).
    const touched = pull.policy.blockResolve.includes('cell-touch') && (cell.updatedBy ?? '').split('/')[0]!.trim().toUpperCase() === block.on.toUpperCase()
      && cell.updatedAt > block.at ? Date.parse(cell.updatedAt) : undefined;
    const mailed = replied.get(cell.id);
    const at = [mailed, touched].filter((t): t is number => t !== undefined && Number.isFinite(t));
    return blockState(block, seat, at.length ? Math.min(...at) : undefined, now);
  };
  let hints: Record<string, PullHint> | undefined;
  // pr-update progress: the latest update of an open PR naming the cell (the PR read above · unreadable → none).
  const prUpdatedMs = (cell: BoardCell): number | undefined => {
    const f = waitFacts();
    const t = (f?.prs ?? []).filter((pr) => prNamesCell(pr, cell.id)).map((pr) => Date.parse((pr as { updatedAt?: string }).updatedAt ?? '')).filter((x) => Number.isFinite(x));
    return t.length ? Math.max(...t) : undefined;
  };
  return {
    now: () => now,
    version,
    cells: boardCells,
    lanes: laneMap,
    policy: () => pull.policy,
    rosterRank: () => rosterRank(readRoster(effectiveInstanceRoot()), version),
    setWriter: (id, input) => setWriterIf(version, id, input),
    prUpdatedMs,
    prProtected: (cell) => {
      try { return recentDeclaredPr(cell.id, readOpenPrs(), now, pull.policy); }
      catch { return false; } // Unreadable PRs retain the pre-existing pull policy, rather than aborting work next.
    },
    scopeOf: (s) => ladder.parentOf(s).toUpperCase(),
    lastActiveMs: (s) => (active ? active.get(s) : now),
    waitOf,
    prDone,
    swap: (id, input) => swapOwnerIf(version, id, input),
    record: (row) => appendJsonl(pullLedgerPath(effectiveInstanceRoot()), row),
    // WORK-PULL-REACHES-ROSTER — coordinator authority from the ladder × policy `coordinator_depths` (HQ ⊕ coordinators).
    isCoordinator: (s) => hasCoordinatorAuthority(ladder.depthOf(s), pull.policy),
    // SEAT-AREA-GUARD — seat roles ⊕ areas through the one reader (kit/seat-area · graphs/policies/seat-roles.yaml).
    seatFit: (s, cell) => liveSeatFit()(s, cell),
    isJudge: (s) => isJudgeRole(s, { parentOf: (x) => ladder.parentOf(x), roleOf: (x) => roles[x.toUpperCase()] }),
    priorityOrder: () => readPriorityOrder(effectiveInstanceRoot()).order,
    hintOf: (cell) => { hints ??= readPriorityOrder(effectiveInstanceRoot()).hints ?? {}; const h = hints[cell.id]; return h && Date.parse(h.until) > now ? h.seat : undefined; },
    lend: (row) => debug.log('pool', 'lend', row),
    blockOf,
    requireDoneWhen: livePullRequiresDoneWhen,
    resume: (cell, by) => {
      const block = blocks.get(cell.id);
      if (block) appendJsonl(blocksFile, { op: 'resume', at: new Date(now).toISOString(), version, cell: cell.id, by, on: block.on } satisfies CellBlockRow);
    },
  };
}

export async function runWorkNextCli(opts: { scope?: string; seat?: string; version?: string; json?: boolean }): Promise<number> {
  const { resolveSeatId } = await import('../../tui/seat-mail-boot.js');
  const seat = (opts.seat ?? process.env.ELANOUS_TRACK ?? resolveSeatId(process.cwd()) ?? '').trim().toUpperCase();
  if (!seat) { console.error('work next: no seat (run from seats/<SEAT>, set ELANOUS_TRACK, or pass --seat)'); return 2; }
  const deps = liveWorkNextDeps(seat, opts.version ? { version: opts.version } : {});
  const result = workNext(seat, deps, opts.scope ? { scope: opts.scope } : {});
  recordFact({ type: 'work', seat, state: result.code === 3 ? 'empty' : result.code === 0 ? 'claimed' : 'continue', ...('cell' in result ? { cell: result.cell.id } : {}), source: 'work-next' });
  // DEV-REVIEW-COMMON: a claim starts cell-review@1 ⊕ pre-impl@1 on the claimed cell — detached, the hand never waits for it
  // (graphs/policies/dev-review.yaml cell_review.max_block_ms · once per criterion text · results on the board ⊕ dev-review ledger).
  try { (await import('../../kit/dev-review/live.js')).onWorkClaimed(result, deps.version); } catch { /* review never blocks a claim */ }
  // MODEL-BY-DIFFICULTY: a claim sets the hand's model for the cell (applied at its next turn start · same tab).
  let modelLine: string | null = null;
  if (result.code === 0) {
    try {
      const m = await import('../../seat/model-by-difficulty.js');
      const { cellTargetPaths } = await import('../../seat/seat-assign.js');
      const { priorAttempts } = await import('../../seat/seat-assign-live.js');
      const paths = cellTargetPaths(result.cell as unknown as Parameters<typeof cellTargetPaths>[0]);
      const d = m.directiveFor({ seat, cell: result.cell.id, facts: { cellId: result.cell.id, paths, priorAttempts: priorAttempts(result.cell.id) }, usedShare: m.liveUsedShare, by: 'work-next', now: new Date() });
      if (!d) { m.noModelFallback({ root: effectiveInstanceRoot(), seat, cell: result.cell.id, note: 'no acceptable model under the budget', by: 'work-next', now: new Date() }); modelLine = 'model: no acceptable model under the budget — your tab returns to its default model (no paid bypass)'; }
      if (d) {
        m.writeSeatModelDirective(effectiveInstanceRoot(), d);
        debug.log('seat', 'seat.model-directive', { seat: d.seat, cell: d.cell, tier: d.tier, model: `${d.provider}/${d.model}`, score: d.score, reasons: d.reasons, ...(d.note ? { note: d.note } : {}), via: 'work-next' });
        modelLine = m.directiveLine(d);
      }
    } catch { /* routing never blocks a claim */ }
  }
  if (opts.json) console.log(JSON.stringify(result));
  else {
    console.log(result.line);
    if (modelLine) console.log(modelLine);
    if (result.code === 3 && result.breakdown) console.log(`(${result.breakdown})`);
    if (result.code === 0 && result.lentTo) console.log(`(pool.lend — borrowed into ${result.lentTo}; you return to the pool when the cell closes)`);
    if (result.code === 0 && result.waiting?.length) console.log(`(handed to land line: ${result.waiting.join(' · ')} — the land line takes the receipt and the main merge; you come back only if it is refused)`);
  }
  return result.code;
}

// PR-DONE — the author's local worktree of a PR branch (pregate's AUTHOR_TREE_DIRTY lookup: repo.git worktree list).
let worktrees: Map<string, string> | null = null;
function authorTreeOf(branch: string): AuthorTree | null {
  const repo = join(homedir(), 'elanous-hq', 'repo.git');
  if (!worktrees) {
    worktrees = new Map();
    const r = spawnSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 10_000 });
    let cur: string | null = null;
    for (const l of (r.status === 0 ? r.stdout : '').split('\n')) {
      if (l.startsWith('worktree ')) cur = l.slice(9);
      else if (l.startsWith('branch ') && cur) worktrees.set(l.slice(7).replace('refs/heads/', ''), cur);
    }
  }
  const path = worktrees.get(branch);
  if (!path || !existsSync(path)) return null;
  const status = spawnSync('git', ['-C', path, 'status', '--porcelain'], { encoding: 'utf8', timeout: 10_000 });
  if (status.status !== 0) return null;
  const ahead = spawnSync('git', ['-C', path, 'rev-list', '--count', `origin/${branch}..HEAD`], { encoding: 'utf8', timeout: 10_000 });
  return { path, dirty: status.stdout.trim().length > 0, unpushed: ahead.status === 0 ? Number(ahead.stdout.trim()) || 0 : 0 };
}

// ── federation.priorityOrder — the OP pulse's ranking of pool P0 work (demo P0 · main red · landing bottleneck …) ──
// A small ledger the OP pulse rewrites each pulse; `eln work next` reads it on every call. Unreadable/absent = [] (P0 by
// version then age) — a broken ledger never blocks a claim.
export const priorityOrderPath = (root: string): string => join(root, 'steward', 'priority-order.json');

export interface PullHint { readonly seat: string; readonly until: string; readonly by?: string }

export function readPriorityOrder(root: string): { order: string[]; at?: string; by?: string; hints?: Record<string, PullHint> } {
  try {
    const path = priorityOrderPath(root);
    if (!existsSync(path)) return { order: [] };
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { order?: unknown; at?: unknown; by?: unknown; hints?: unknown };
    const order = Array.isArray(raw.order) ? raw.order.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()).slice(0, 32) : [];
    const hints: Record<string, PullHint> = {};
    if (raw.hints && typeof raw.hints === 'object') {
      for (const [cell, h] of Object.entries(raw.hints as Record<string, unknown>)) {
        const v = h as { seat?: unknown; until?: unknown; by?: unknown };
        if (typeof v?.seat === 'string' && typeof v.until === 'string') hints[cell] = { seat: v.seat, until: v.until, ...(typeof v.by === 'string' ? { by: v.by } : {}) };
      }
    }
    return { order, ...(typeof raw.at === 'string' ? { at: raw.at } : {}), ...(typeof raw.by === 'string' ? { by: raw.by } : {}), ...(Object.keys(hints).length ? { hints } : {}) };
  } catch { return { order: [] }; }
}

// OP-PULL-HINT (11-27 · OP-PUSH-BUDGET: the OP planner sent 27 [SEAT-ASSIGN] mails in one burst at 15:24Z — CEO: «OP stops
// direct-assign; reorder with eln work priority»). The planner raises a cell in priorityOrder and hints it to an idle hand;
// the hand claims it on its next `eln work next`. A hint lives one work-pull lease.
// 출처: LEASE_MINUTES (45 · work-next.ts) — a hint older than one lease is stale.
export const PULL_HINT_TTL_MIN = 45;

/** Raise `entries` to the front of priorityOrder (deduped, ≤32) and hint each cell to its seat. Expired hints drop. */
export function addPullHints(root: string, entries: readonly { cell: string; seat: string }[], by: string, nowMs: number): { order: string[]; hints: Record<string, PullHint> } {
  const cur = readPriorityOrder(root);
  const until = new Date(nowMs + PULL_HINT_TTL_MIN * 60_000).toISOString();
  const hints: Record<string, PullHint> = {};
  for (const [cell, h] of Object.entries(cur.hints ?? {})) if (Date.parse(h.until) > nowMs) hints[cell] = h;
  for (const e of entries) hints[e.cell] = { seat: e.seat.toUpperCase(), until, by: by.toUpperCase() };
  const order = [...new Set([...entries.map((e) => e.cell), ...cur.order])].slice(0, 32);
  const row = { order, at: new Date(nowMs).toISOString(), by: by.toUpperCase(), hints };
  const path = priorityOrderPath(root);
  mkdirSync(join(root, 'steward'), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(row)}\n`);
  renameSync(`${path}.tmp`, path);
  debug.log('pool', 'pull-hint', { by: row.by, cells: entries.map((e) => `${e.cell}→${e.seat}`) });
  return { order, hints };
}

export function runWorkPriorityCli(entries: readonly string[], opts: { clear?: boolean; by?: string; json?: boolean }): number {
  const root = effectiveInstanceRoot();
  const path = priorityOrderPath(root);
  if (entries.length || opts.clear) {
    const order = opts.clear ? [] : entries.flatMap((e) => e.split(',')).map((e) => e.trim()).filter(Boolean).slice(0, 32);
    const prior = readPriorityOrder(root).hints; // a manual reorder keeps the planner's pull hints
    const row = { order, at: new Date().toISOString(), by: (opts.by ?? process.env.ELANOUS_TRACK ?? 'OP').toUpperCase(), ...(prior ? { hints: prior } : {}) };
    mkdirSync(join(root, 'steward'), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(row)}\n`);
    renameSync(`${path}.tmp`, path);
    debug.log('pool', 'priority-order', row);
  }
  const now = readPriorityOrder(root);
  if (opts.json) console.log(JSON.stringify(now));
  else console.log(now.order.length ? `priorityOrder (${now.by ?? '?'} · ${now.at ?? '?'}): ${now.order.map((e, i) => `${i + 1}. ${e}`).join(' · ')}` : 'priorityOrder: (default) P0 by version then age');
  return 0;
}

/** `eln work block <cell> --on <seat> --reason <text>` — park my cell on the board as blocked-on:<seat>, then `work next`. */
export async function runWorkBlockCli(cellId: string, opts: { on?: string; reason?: string; seat?: string; version?: string; json?: boolean }): Promise<number> {
  const { resolveSeatId } = await import('../../tui/seat-mail-boot.js');
  const seat = (opts.seat ?? process.env.ELANOUS_TRACK ?? resolveSeatId(process.cwd()) ?? '').trim().toUpperCase();
  if (!seat) { console.error('work block: no seat (run from seats/<SEAT>, set ELANOUS_TRACK, or pass --seat)'); return 2; }
  const version = opts.version ?? activeBoardVersion();
  const ladder = loadFederationLadder();
  const blocksFile = cellBlocksPath(effectiveInstanceRoot());
  const result = workBlock(seat, cellId, { on: opts.on ?? '', reason: opts.reason ?? '' }, {
    hq: ladder.hq,
    now: () => Date.now(),
    version,
    cells: () => listChecklist(version).items as readonly BoardCell[],
    scopeOf: (s) => ladder.parentOf(s).toUpperCase(),
    blocks: () => readCellBlockRows(blocksFile),
    swap: (id, input) => swapOwnerIf(version, id, input),
    setWriter: (id, input) => setWriterIf(version, id, input),
    mail: ({ to, body, refs }) => {
      const store = openMsgStore(defaultMsgStorePath());
      try { return store.append({ from: BLOCK_MAIL_SENDER, to, body, kind: 'steward-exception', intent: 'request', refs }).id; } finally { store.close(); }
    },
    record: (row) => appendJsonl(blocksFile, row),
  });
  if (result.code === 0) recordFact({ type: 'work', seat, cell: cellId, state: 'block', to: (opts.on ?? '').toUpperCase(), kind: (opts.reason ?? '').slice(0, 120), source: 'work-block' });
  // HOLD-AUTO-REGISTER (rail 80 · the HOLD ledger stayed empty 4 cycles): a block that names a HOLD by another seat registers
  // it on that cell (owner = the seat it waits on · 2 h · fail-open) unless a registered HOLD of that owner already covers it.
  if (result.code === 0 && opts.on?.trim() && /\bHOLD\b/u.test(opts.reason ?? '')) {
    try {
      const hl = await import('../../hold-ledger/hold-ledger.js');
      const { effectiveInstanceRoot } = await import('../../instance/resolve.js');
      const root = effectiveInstanceRoot(); const owner = opts.on.trim().toUpperCase(); const now = new Date();
      if (!hl.holdsCovering(hl.readHolds(root, now), cellId, now).some(h => h.owner === owner)) {
        const h = hl.addHold(root, { owner, cells: [cellId], reason: `auto from work block by ${seat}: ${(opts.reason ?? '').slice(0, 160)}`, unlock: `${owner} lifts it (eln hold lift)`, by: 'HOLD-AUTO' }, { now });
        if (!opts.json) console.log(`HOLD registered ${h.id} (${owner} · ${cellId} · until ${h.expiresAt.slice(11, 16)}Z) — eln hold ls --cell ${cellId}`);
      }
    } catch { /* fail-open: the block stands */ }
  }
  if (opts.json) console.log(JSON.stringify(result));
  else (result.code === 0 ? console.log : console.error)(result.line);
  return result.code;
}
