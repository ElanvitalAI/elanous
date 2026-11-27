// `eln work next [--scope <space>] [--seat <seat>] [--json]` — live wiring for work-next.ts (ledger · ladder · activity clock).
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
import { listChecklist, swapOwnerIf } from '../../release-loop/checklist.js';
import { activeBoardVersion } from '../../ops-dashboard/current-version.js';
import { cellWaitOf, prDoneTodo, type AuthorTree, type CellWait, type WaitFacts } from './cell-wait.js';
import { ghJson, liveGhTargetDeps, liveSources, parsePanes, parsePrs, pullLedgerPath, resolveGhTarget } from './sources.js';
import { appendJsonl, workNext, type BoardCell, type WorkNextDeps } from './work-next.js';
import { blockState, cellBlocksPath, openBlocks, readCellBlockRows, workBlock, type CellBlockRow } from './cell-block.js';
import { defaultMsgStorePath, openMsgStore, openMsgStoreReadOnly } from '../../msg/msg-store.js';

/** Sender of the block exception mail — the steward's own address (tick.ts STEWARD_SENDER). */
const BLOCK_MAIL_SENDER = 'ORCHESTRATOR';

/**
 * When the awaited seat answered an open block (epoch ms), or undefined: the first mail FROM `on` after the block's
 * exception mail that replies to it or goes to the holder / its board coordinator. Structured (sender ⊕ id ⊕ recipient).
 */
export function blockRepliedAtMs(block: CellBlockRow, board: string): number | undefined {
  const store = openMsgStoreReadOnly(defaultMsgStorePath());
  try {
    const since = block.mailId ?? 0;
    const row = store.db.query(`SELECT created_at AS at FROM msg_messages WHERE UPPER(sender) = ? AND id > ? AND created_at >= ?
      AND (reply_to = ? OR UPPER(recipient) IN (?, ?)) ORDER BY id ASC LIMIT 1`)
      .get(block.on.toUpperCase(), since, block.at, since, block.by.toUpperCase(), board.toUpperCase()) as { at?: string } | null;
    const at = row?.at ? Date.parse(row.at) : NaN;
    return Number.isFinite(at) ? at : undefined;
  } finally { store.close(); }
}

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
  // Owners' activity: the session clock (activity.ts). Panes unreadable → every owner counts as active (no lease is taken).
  let active: Map<string, number> | null = null;
  try {
    const sources = liveSources(undefined, now);
    active = new Map(parsePanes(sources.panes(), now, sources.sessionActivity).flatMap((s) =>
      s.lastActiveMs !== undefined ? [[s.seat, s.lastActiveMs] as const] : s.activity === 'idle' && s.idleForMs !== null ? [[s.seat, now - s.idleForMs] as const] : s.activity === 'working' ? [[s.seat, now] as const] : []));
  } catch { active = null; }
  // Waiting facts (open PRs ⊕ same-head receipts ⊕ verdicts), read once on first use. Unreadable → every cell counts as
  // active (the pre-rail-30 behaviour: WIP 1 holds, nothing is skipped) — never a wrong claim.
  let facts: WaitFacts | null | undefined;
  const waitFacts = (): WaitFacts | null => {
    if (facts !== undefined) return facts;
    try {
      const sources = liveSources(undefined, now);
      facts = { prs: parsePrs(ghJson(['pr', 'list', '--state', 'open', '--limit', '150', '--json', 'number,headRefOid,headRefName,title,isDraft,updatedAt'], resolveGhTarget(undefined, liveGhTargetDeps()))),
        receipts: sources.receipts(), verdicts: sources.verdicts() };
    } catch { facts = null; }
    return facts;
  };
  const waitOf = (cell: BoardCell): CellWait | null => { const f = waitFacts(); return f ? cellWaitOf(cell.id, f) : null; };
  const prDone = (cell: BoardCell): string | null => { const f = waitFacts(); return f ? prDoneTodo(cell.id, f, authorTreeOf)?.line ?? null : null; };
  // HAND-PULL-ON-BLOCK — cells parked by `eln work block` (unreadable ledger/mail → no block facts: the cell is a plain board cell).
  const blocksFile = cellBlocksPath(effectiveInstanceRoot());
  let blocks: Map<string, CellBlockRow> = new Map();
  try { blocks = openBlocks(readCellBlockRows(blocksFile), version); } catch { blocks = new Map(); }
  const replied = new Map<string, number | undefined>();
  const blockOf = (cell: BoardCell) => {
    const block = blocks.get(cell.id);
    if (!block) return undefined;
    if (!replied.has(cell.id)) {
      try { replied.set(cell.id, blockRepliedAtMs(block, ladder.parentOf(block.by).toUpperCase())); } catch { replied.set(cell.id, undefined); }
    }
    return blockState(block, seat, replied.get(cell.id), now);
  };
  let hints: Record<string, PullHint> | undefined;
  return {
    now: () => now,
    version,
    cells: () => listChecklist(version).items as readonly BoardCell[],
    scopeOf: (s) => ladder.parentOf(s).toUpperCase(),
    lastActiveMs: (s) => (active ? active.get(s) : now),
    waitOf,
    prDone,
    swap: (id, input) => swapOwnerIf(version, id, input),
    record: (row) => appendJsonl(pullLedgerPath(effectiveInstanceRoot()), row),
    isCoordinator: (s) => ladder.depthOf(s) === 2,
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
  const result = workNext(seat, liveWorkNextDeps(seat, opts.version ? { version: opts.version } : {}), opts.scope ? { scope: opts.scope } : {});
  recordFact({ type: 'work', seat, state: result.code === 3 ? 'empty' : result.code === 0 ? 'claimed' : 'continue', ...('cell' in result ? { cell: result.cell.id } : {}), source: 'work-next' });
  // MODEL-BY-DIFFICULTY: a claim sets the hand's model for the cell (applied at its next turn start · same tab).
  let modelLine: string | null = null;
  if (result.code === 0) {
    try {
      const m = await import('../../seat/model-by-difficulty.js');
      const { cellTargetPaths } = await import('../../seat/seat-assign.js');
      const { priorAttempts } = await import('../../seat/seat-assign-live.js');
      const paths = cellTargetPaths(result.cell as unknown as Parameters<typeof cellTargetPaths>[0]);
      const d = m.directiveFor({ seat, cell: result.cell.id, facts: { cellId: result.cell.id, paths, priorAttempts: priorAttempts(result.cell.id) }, usedShare: m.liveUsedShare, by: 'work-next', now: new Date() });
      m.writeSeatModelDirective(effectiveInstanceRoot(), d);
      debug.log('seat', 'seat.model-directive', { seat: d.seat, cell: d.cell, tier: d.tier, model: `${d.provider}/${d.model}`, score: d.score, reasons: d.reasons, ...(d.note ? { note: d.note } : {}), via: 'work-next' });
      modelLine = m.directiveLine(d);
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
