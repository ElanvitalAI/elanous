// CURRENT-RELEASE-ONE-SOURCE (0.3.39 P0 · 대표 11-28 07:3x «버전 발행 후 판을 가리키는 것 — 가장 중요한 기준선»).
//
// S: 0.3.38 was published 06:01; the dev-bump landed 06:15 and the installed CLI was rebuilt at the 07:23 rail. Between,
//    every reader that took «the current board» from the package dev version (`release checklist status` default ·
//    steward space · work next fallback) read the closed 0.3.38 board — steward:hq said «no backlog» and assigned nothing
//    for over an hour. `release.graph.version` (the release graph's per-version *live approval*) was moved to 0.3.39 by a
//    hand run only at 06:59, and the dev-bump node failed outright (scope-revert-guard false positive).
// C: «the current board» lived in six places that move at different times (package.json/server.json/agent.json ·
//    release.graph.version · PLAN `status: current` · schedule rows · release/<v> branch · roster) and each reader picked one.
//    The graph-version key cannot be the pointer either: the publish run of <v> needs it to stay <v> (live mode) while its
//    npm/verify/dev-bump tail runs.
// Q: what is the one record every reader takes «current board» from, and who moves it — when?
// A: `<releaseLedgerRoot>/release/current-board.json` = { current, previous, flippedAt, by, cause, seq } beside the
//    per-version release.json and the checklist store (the same root every board reader already opens, the same universe
//    isolation: a --config-dir/test universe has its own). The release graph flips it as its own step right after
//    `publish` is really done — before npm/verify/dev-bump, never waiting on them — and announces «board now <v>» once on
//    the op-context bus and the fed-state ledger. Readers go through `activeBoardVersion()` (current-version.ts), which
//    reads this file fresh on every call: record → release.graph.version (legacy) → package.
//
// 세 얼굴: 관측 = `eln release current` (record · source · disagreements) ⊕ current-board.jsonl (every flip) ⊕ the bus/fact
//          row ⊕ the release graph ledger row `board-flip` ·
//          판단 근거 = the publish step's real `done` (graph exit 0 · REL detected · marked) — never a shadow would-run ·
//          수복과 인계 = a failed write leaves the step pending (retried every tick) and cards OP once; a race keeps the higher
//          version (never backwards); `eln release current set <v> --by --cause` is the hand surgery.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { assertNotTestWritingOps } from '../instance/test-write-guard.js';

export interface BoardRecord {
  /** The board every reader works on (x.y.z). */
  readonly current: string;
  /** The board before the last flip (normally the version just published) — null on the first record. */
  readonly previous: string | null;
  readonly flippedAt: string;
  /** Who moved it: `release-graph:<v>` · a seat (`OP`) for a hand set. */
  readonly by: string;
  /** Why: `published 0.3.38 (graph)` · the hand set's reason. */
  readonly cause: string;
  /** Monotonic flip counter (1 on the first record). */
  readonly seq: number;
}

export type BoardFlipOutcome =
  | { readonly kind: 'flipped'; readonly record: BoardRecord }
  | { readonly kind: 'already'; readonly record: BoardRecord }
  | { readonly kind: 'refused'; readonly record: BoardRecord; readonly reason: string };

const BARE = /^(\d+)\.(\d+)\.(\d+)$/u;
const LOCK_STALE_MS = 30_000; // not-policy: file-lock mechanics — a holder silent this long is dead (O_EXCL lock reclaim), not a tuning knob
const LOCK_WAIT_MS = 25; // not-policy: file-lock poll step
/** Default wait for a live lock holder before giving up (the tick retries next minute). */
const LOCK_BUDGET_MS = 5_000; // not-policy: file-lock total wait (the tick retries next minute)

export function isBoardVersion(v: unknown): v is string { return typeof v === 'string' && BARE.test(v); }

/** Numeric x.y.z compare (board versions are bare). */
export function compareBoardVersions(a: string, b: string): number {
  const pa = BARE.exec(a); const pb = BARE.exec(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  return (Number(pa[1]) - Number(pb[1])) || (Number(pa[2]) - Number(pb[2])) || (Number(pa[3]) - Number(pb[3]));
}

/** The board after a publish of <v>: the next patch (the same rule as the dev-bump node: 0.3.38 → 0.3.39). */
export function nextBoardVersion(published: string): string {
  const m = BARE.exec(published);
  if (!m) throw new Error(`current board: not an x.y.z version: ${published}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

export function boardRecordPath(ledgerRoot: string = releaseLedgerRoot()): string { return join(ledgerRoot, 'release', 'current-board.json'); }
export function boardHistoryPath(ledgerRoot: string = releaseLedgerRoot()): string { return join(ledgerRoot, 'release', 'current-board.jsonl'); }

function parseRecord(raw: unknown): BoardRecord | null {
  const r = raw as Partial<BoardRecord> | null;
  if (!r || !isBoardVersion(r.current) || typeof r.flippedAt !== 'string' || typeof r.by !== 'string' || typeof r.cause !== 'string') return null;
  return { current: r.current, previous: isBoardVersion(r.previous) ? r.previous : null, flippedAt: r.flippedAt, by: r.by, cause: r.cause,
    seq: typeof r.seq === 'number' && Number.isFinite(r.seq) ? r.seq : 1 };
}

/** The record, read from disk on every call (no cache · a flip is visible to the next read). null = absent or unreadable. */
export function readBoardRecord(ledgerRoot: string = releaseLedgerRoot()): BoardRecord | null {
  try {
    const p = boardRecordPath(ledgerRoot);
    return existsSync(p) ? parseRecord(JSON.parse(readFileSync(p, 'utf8'))) : null;
  } catch { return null; }
}

/** Exclusive O_EXCL lock beside the record; a lock older than 30 s is a dead writer and is broken. */
function withBoardLock<T>(ledgerRoot: string, fn: () => T, budgetMs = LOCK_BUDGET_MS): T {
  const lock = `${boardRecordPath(ledgerRoot)}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  for (let i = 0, tries = Math.max(1, Math.ceil(budgetMs / LOCK_WAIT_MS)); i < tries; i++) {
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); } catch { /* gone meanwhile */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
      continue;
    }
    try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
    try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
  }
  throw new Error(`current board: write lock busy (${lock})`);
}

function writeRecord(ledgerRoot: string, record: BoardRecord): void {
  const p = boardRecordPath(ledgerRoot);
  assertNotTestWritingOps(p, 'flip the current board');
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 1)}\n`);
  renameSync(tmp, p);
  appendFileSync(boardHistoryPath(ledgerRoot), `${JSON.stringify(record)}\n`);
}

/**
 * The release graph's flip after a real publish of `published`: the board moves to `to` (default the next patch).
 * Idempotent (same target → `already`) and never backwards (a newer record → `refused`, kept). Atomic: tmp + rename under
 * the lock; every flip is also one history line.
 */
export function flipBoardAfterPublish(input: { published: string; by: string; cause?: string; to?: string; now?: Date; ledgerRoot?: string; lockBudgetMs?: number }): BoardFlipOutcome {
  const root = input.ledgerRoot ?? releaseLedgerRoot();
  const to = input.to ?? nextBoardVersion(input.published);
  if (!isBoardVersion(to)) throw new Error(`current board: not an x.y.z version: ${to}`);
  return withBoardLock(root, (): BoardFlipOutcome => {
    const was = readBoardRecord(root);
    if (was && was.current === to) return { kind: 'already', record: was };
    if (was && compareBoardVersions(was.current, to) > 0) return { kind: 'refused', record: was, reason: `board is already ${was.current} — a flip never moves it back to ${to}` };
    const record: BoardRecord = { current: to, previous: was?.current ?? input.published, flippedAt: (input.now ?? new Date()).toISOString(),
      by: input.by, cause: input.cause ?? `published ${input.published}`, seq: (was?.seq ?? 0) + 1 };
    writeRecord(root, record);
    return { kind: 'flipped', record };
  }, input.lockBudgetMs);
}

/** Hand surgery (`eln release current set`): any x.y.z, backwards included — the reason is recorded. */
export function setBoard(input: { to: string; by: string; cause: string; now?: Date; ledgerRoot?: string }): BoardFlipOutcome {
  const root = input.ledgerRoot ?? releaseLedgerRoot();
  if (!isBoardVersion(input.to)) throw new Error(`current board: not an x.y.z version: ${input.to}`);
  if (!input.by.trim() || !input.cause.trim()) throw new Error('current board set: --by and --cause are required');
  return withBoardLock(root, (): BoardFlipOutcome => {
    const was = readBoardRecord(root);
    if (was && was.current === input.to) return { kind: 'already', record: was };
    const record: BoardRecord = { current: input.to, previous: was?.current ?? null, flippedAt: (input.now ?? new Date()).toISOString(),
      by: input.by.trim(), cause: input.cause.trim(), seq: (was?.seq ?? 0) + 1 };
    writeRecord(root, record);
    return { kind: 'flipped', record };
  });
}

/** One line for the bus/bulletin/ledger: «board now 0.3.39 (was 0.3.38 · published 0.3.38)». */
export function boardFlipLine(record: BoardRecord): string {
  return `[board] 현재 판 = ${record.current} · board now ${record.current} (was ${record.previous ?? '-'} · ${record.cause} · by ${record.by})`;
}

/**
 * The one federation event for a flip: the op-context bus (status row every seat/loop agent catches up on) and the
 * fed-state ledger (type `board`). Fail-open per sink — a sink fault never undoes the flip; the result names each sink.
 */
export function announceBoardFlip(record: BoardRecord, deps: { stateRoot: string; busPost?: (line: string, ref: string) => void; fact?: (record: BoardRecord) => boolean }): { bus: string; fact: string } {
  const ref = `board:${record.current}`;
  let bus = 'posted'; let fact = 'recorded';
  try {
    if (deps.busPost) deps.busPost(boardFlipLine(record), ref);
    else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { busPost } = require('../op-context-bus/bus.js') as typeof import('../op-context-bus/bus.js');
      busPost(deps.stateRoot, { type: 'status', from: 'release-graph', body: boardFlipLine(record), refs: [ref], source: 'release-graph' });
    }
  } catch (e) { bus = `failed: ${String(e).slice(0, 160)}`; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ok = deps.fact ? deps.fact(record) : (require('../fed-state/ledger.js') as typeof import('../fed-state/ledger.js'))
      .recordFact({ type: 'board', state: 'flip', from: record.previous ?? undefined, to: record.current, ref, source: 'release-graph', decidedBy: record.by });
    if (!ok) fact = 'skipped';
  } catch (e) { fact = `failed: ${String(e).slice(0, 160)}`; }
  return { bus, fact };
}
