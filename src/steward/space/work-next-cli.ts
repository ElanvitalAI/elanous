// `eln work next [--scope <space>] [--seat <seat>] [--json]` — live wiring for work-next.ts (ledger · ladder · activity clock).
import { recordFact } from '../../fed-state/ledger.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { loadDeclaredSeatRoles, loadFederationLadder } from '../../msg/hand-raise-ladder.js';
import { isJudgeRole } from '../../seat/hand-pool.js';
import { checklistDevVersion, listChecklist, swapOwnerIf } from '../../release-loop/checklist.js';
import { cellWaitOf, type CellWait, type WaitFacts } from './cell-wait.js';
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
  const version = opts.version ?? checklistDevVersion();
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
  return {
    now: () => now,
    version,
    cells: () => listChecklist(version).items as readonly BoardCell[],
    scopeOf: (s) => ladder.parentOf(s).toUpperCase(),
    lastActiveMs: (s) => (active ? active.get(s) : now),
    waitOf,
    swap: (id, input) => swapOwnerIf(version, id, input),
    record: (row) => appendJsonl(pullLedgerPath(effectiveInstanceRoot()), row),
    isCoordinator: (s) => ladder.depthOf(s) === 2,
    isJudge: (s) => isJudgeRole(s, { parentOf: (x) => ladder.parentOf(x), roleOf: (x) => roles[x.toUpperCase()] }),
    priorityOrder: () => readPriorityOrder(effectiveInstanceRoot()).order,
    lend: (row) => debug.log('pool', 'lend', row),
    blockOf,
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
  if (opts.json) console.log(JSON.stringify(result));
  else {
    console.log(result.line);
    if (result.code === 3 && result.breakdown) console.log(`(${result.breakdown})`);
    if (result.code === 0 && result.lentTo) console.log(`(pool.lend — borrowed into ${result.lentTo}; you return to the pool when the cell closes)`);
    if (result.code === 0 && result.waiting?.length) console.log(`(your waiting cells: ${result.waiting.join(' · ')} — resume each when its verdict/receipt lands)`);
  }
  return result.code;
}

// ── federation.priorityOrder — the OP pulse's ranking of pool P0 work (demo P0 · main red · landing bottleneck …) ──
// A small ledger the OP pulse rewrites each pulse; `eln work next` reads it on every call. Unreadable/absent = [] (P0 by
// version then age) — a broken ledger never blocks a claim.
export const priorityOrderPath = (root: string): string => join(root, 'steward', 'priority-order.json');

export function readPriorityOrder(root: string): { order: string[]; at?: string; by?: string } {
  try {
    const path = priorityOrderPath(root);
    if (!existsSync(path)) return { order: [] };
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { order?: unknown; at?: unknown; by?: unknown };
    const order = Array.isArray(raw.order) ? raw.order.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()).slice(0, 32) : [];
    return { order, ...(typeof raw.at === 'string' ? { at: raw.at } : {}), ...(typeof raw.by === 'string' ? { by: raw.by } : {}) };
  } catch { return { order: [] }; }
}

export function runWorkPriorityCli(entries: readonly string[], opts: { clear?: boolean; by?: string; json?: boolean }): number {
  const root = effectiveInstanceRoot();
  const path = priorityOrderPath(root);
  if (entries.length || opts.clear) {
    const order = opts.clear ? [] : entries.flatMap((e) => e.split(',')).map((e) => e.trim()).filter(Boolean).slice(0, 32);
    const row = { order, at: new Date().toISOString(), by: (opts.by ?? process.env.ELANOUS_TRACK ?? 'OP').toUpperCase() };
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
  const version = opts.version ?? checklistDevVersion();
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
  if (opts.json) console.log(JSON.stringify(result));
  else (result.code === 0 ? console.log : console.error)(result.line);
  return result.code;
}
