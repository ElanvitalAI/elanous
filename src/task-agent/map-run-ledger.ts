/**
 * MAPREDUCE-FANOUT: one immutable inventory snapshot, followed by one result per item.
 * The reducer is read-only. A partial inventory or missing/duplicate result is a hold,
 * never evidence for a checklist change or a draft close.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { withFileLockSync } from '../storage/file-lock.js';

export type MapRecipe = 'green-close' | 'draft-close';
export type MapRowKind = 'green-candidate' | 'mock-pr' | 'implementation-remains'
  | 'harvest' | 'close-candidate' | 'hold';
export type MapEvidenceVerdict = 'pass' | 'fail' | 'hold' | 'unmeasured';

/** Shared, execution-neutral contract consumed by task MAPREDUCE-FANOUT and gate shards. */
export interface MapReducePolicy {
  seed: string;
  /** Additional attempts after the first dispatch. */
  retryMax: number;
  /** Total ceiling in the caller's documented cost unit. */
  costLimit: number;
}
export interface MapReduceAttemptReceipt {
  attempt: number;
  host: string;
  status: 'complete' | 'failed' | 'unmeasured';
  cost: number;
}
export interface MapReducePieceReceipt {
  pieceId: string;
  host: string | null;
  status: 'complete' | 'failed' | 'unmeasured' | 'budget-exceeded';
  reservedCost: number;
  attempts: MapReduceAttemptReceipt[];
}
export interface MapReduceReceipt {
  seed: string;
  costLimit: number;
  reservedCost: number;
  spentCost: number;
  verdict: 'complete' | 'partial' | 'hold';
  pieces: MapReducePieceReceipt[];
}

export function validMapReducePolicy(policy: MapReducePolicy): boolean {
  return typeof policy.seed === 'string' && policy.seed.trim().length > 0
    && Number.isSafeInteger(policy.retryMax) && policy.retryMax >= 0 // Source: retry.max counts additional attempts and cannot be negative (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
    && Number.isFinite(policy.costLimit) && policy.costLimit >= 0; // Source: the reservation ceiling is a non-negative budget (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
}

export function validMapReducePieceReceipt(policy: MapReducePolicy, piece: MapReducePieceReceipt): boolean {
  if (!validMapReducePolicy(policy) || !MAP_REDUCE_PIECE_ID.test(piece.pieceId)
    || !['complete', 'failed', 'unmeasured', 'budget-exceeded'].includes(piece.status)
    || (piece.host !== null && (typeof piece.host !== 'string' || !piece.host.trim()))
    || !Number.isFinite(piece.reservedCost) || piece.reservedCost < 0 // Source: reservations cannot be negative (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
    || !Array.isArray(piece.attempts) || piece.attempts.length > policy.retryMax + 1) return false;
  const attemptsValid = piece.attempts.every((attempt, index) => Number.isSafeInteger(attempt.attempt)
    && attempt.attempt === index + 1 // Source: attempt history is one-based (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
    && typeof attempt.host === 'string' && !!attempt.host.trim()
    && ['complete', 'failed', 'unmeasured'].includes(attempt.status)
    && Number.isFinite(attempt.cost) && attempt.cost >= 0); // Source: measured spend cannot be negative (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
  const priorAttemptsFailed = piece.attempts.slice(0, -1).every((attempt) => attempt.status === 'failed');
  return attemptsValid
    && (piece.status !== 'complete' || piece.attempts.at(-1)?.status === 'complete' && priorAttemptsFailed
      && piece.host === piece.attempts.at(-1)?.host)
    && (piece.status !== 'failed' || piece.attempts.length === policy.retryMax + 1
      && piece.attempts.every((attempt) => attempt.status === 'failed')
      && piece.host === piece.attempts.at(-1)?.host)
    && (piece.status !== 'unmeasured' || piece.attempts.length === 0
      || piece.attempts.at(-1)?.status === 'unmeasured' && priorAttemptsFailed
        && piece.host === piece.attempts.at(-1)?.host)
    && (piece.status !== 'budget-exceeded' || piece.attempts.length === 0);
}

/** Stable seeded host selection shared by both existing planners; it does not execute work. */
export function mapReduceHostForPiece(seed: string, pieceId: string, attempt: number, hosts: readonly string[]): string | null {
  const eligible = [...new Set(hosts.filter((host) => typeof host === 'string' && host.trim()))].sort();
  if (!eligible.length || !Number.isSafeInteger(attempt) || attempt < 1) return null; // Source: attempts are one-based (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
  let hash = 2166136261; // Source: FNV-1a 32-bit offset basis (NUMGUARD)
  for (const character of `${seed}\0${pieceId}\0${attempt}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0; // Source: FNV-1a 32-bit prime (NUMGUARD)
  return eligible[hash % eligible.length]!;
}

/** Canonical receipt reducer. Callers translate their production rows into these piece receipts. */
export function reduceMapReduceReceipt(policy: MapReducePolicy, pieceIds: readonly string[], pieces: readonly MapReducePieceReceipt[]): MapReduceReceipt {
  if (!validMapReducePolicy(policy) || new Set(pieceIds).size !== pieceIds.length
    || pieceIds.some((id) => !MAP_REDUCE_PIECE_ID.test(id))) throw new Error('map-reduce contract identity or policy invalid');
  const expected = new Set(pieceIds);
  const validPieces = pieces.filter((piece) => expected.has(piece.pieceId));
  const duplicate = new Set<string>();
  const seen = new Set<string>();
  for (const piece of validPieces) {
    if (seen.has(piece.pieceId)) duplicate.add(piece.pieceId);
    seen.add(piece.pieceId);
  }
  const canonical = pieceIds.map((pieceId) => validPieces.find((piece) => piece.pieceId === pieceId))
    .filter((piece): piece is MapReducePieceReceipt => !!piece)
    .map((piece) => ({ ...piece, attempts: [...piece.attempts] }))
    .sort((a, b) => a.pieceId.localeCompare(b.pieceId));
  const reservedCost = canonical.reduce((sum, piece) => sum + piece.reservedCost, 0);
  const spentCost = canonical.reduce((sum, piece) => sum + piece.attempts.reduce((cost, attempt) => cost + attempt.cost, 0), 0);
  const attemptsValid = canonical.every((piece) => validMapReducePieceReceipt(policy, piece)
    && piece.attempts.reduce((sum, attempt) => sum + attempt.cost, 0) <= piece.reservedCost);
  const allPiecesPresent = canonical.length === pieceIds.length && validPieces.length === pieces.length
    && seen.size === pieceIds.length && duplicate.size === 0;
  const verdict = pieceIds.length === 0 // Source: empty work has no completion receipt (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
    || !allPiecesPresent || !attemptsValid || reservedCost > policy.costLimit || spentCost > policy.costLimit
    || canonical.some((piece) => piece.status === 'unmeasured') ? 'hold'
    : canonical.every((piece) => piece.status === 'complete') ? 'complete' : 'partial';
  return { seed: policy.seed, costLimit: policy.costLimit, reservedCost, spentCost, verdict, pieces: canonical };
}

export interface MapRunStart {
  event: 'start';
  mapRunId: string;
  recipe: MapRecipe;
  recipeSha: string;
  snapshotTime: string;
  snapshotRef: string;
  /** Exact origin/main captured with the inventory, independent of the image or recipe commit. */
  mainSha: string;
  /** The checklist snapshot artifact used by green-close; draft-close records null. */
  checklistSnapshotPath: string | null;
  inventoryComplete: boolean;
  /** Stable identities from the complete inventory; item display titles are never keys. */
  itemIds: string[];
  requestedPool: string;
  selectedPool: string | null;
  imageCommit: string | null;
  dryRun: boolean;
  mapReducePolicy?: MapReducePolicy;
}

export interface MapRunRow {
  event: 'row';
  mapRunId: string;
  itemId: string | null;
  recipe: MapRecipe;
  kind: MapRowKind;
  verdict: MapRowKind;
  reason: string;
  evidence: string[];
  e1?: { verdict: MapEvidenceVerdict; mergeSha?: string; mainAncestor?: boolean };
  e2?: { verdict: MapEvidenceVerdict; command?: string; exitCode?: number };
  e2Source?: 'completion-boundary' | 'prior-evidence' | 'missing';
  e3?: { verdict: MapEvidenceVerdict; reason: string };
  /** Only an inventory-wide failure uses this form; it suppresses all item rows and requires pr:null. */
  rowsSuppressed?: boolean;
  pr?: number | null;
  prUrl?: string | null;
  headOid?: string | null;
  podJob?: string | null;
  podUid?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  rc?: number | null;
  result?: Record<string, unknown>;
  mapReducePiece?: MapReducePieceReceipt;
}

export interface MapRunRead {
  start: MapRunStart;
  rows: MapRunRow[];
}

export interface MapRunReduce {
  mapRunId: string;
  verdict: 'complete' | 'hold';
  reason: string;
  expected: number;
  observed: number;
  counts: Record<MapRowKind, number>;
  /** A dry-run has no write authority, even when every item is a candidate. */
  writes: 0;
  receipt?: MapReduceReceipt;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const MAP_REDUCE_PIECE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^[0-9a-f]{40}$/;
const KINDS = new Set<MapRowKind>(['green-candidate', 'mock-pr', 'implementation-remains', 'harvest', 'close-candidate', 'hold']);
const RECIPE_KINDS: Record<MapRecipe, ReadonlySet<MapRowKind>> = {
  'green-close': new Set(['green-candidate', 'mock-pr', 'implementation-remains', 'hold']),
  'draft-close': new Set(['harvest', 'close-candidate', 'hold']),
};

function checkId(value: string, label: string): void {
  if (!ID.test(value)) throw new Error(`map-run invalid ${label}: ${value}`);
}

export function mapRunLedgerPath(mapRunId: string, root = effectiveInstanceRoot()): string {
  checkId(mapRunId, 'id');
  return join(root, 'map-runs', `${mapRunId}.jsonl`);
}

function validateStart(start: MapRunStart): void {
  checkId(start.mapRunId, 'id');
  if (start.recipe !== 'green-close' && start.recipe !== 'draft-close') throw new Error('map-run unknown recipe');
  if (!SHA.test(start.recipeSha)) throw new Error('map-run recipe SHA missing');
  if (!start.snapshotTime || !start.snapshotRef) throw new Error('map-run snapshot identity missing');
  if (!SHA.test(start.mainSha) || !('checklistSnapshotPath' in start)
    || (start.recipe === 'green-close' && (!start.checklistSnapshotPath || !isAbsolute(start.checklistSnapshotPath)))
    || (start.recipe === 'draft-close' && start.checklistSnapshotPath !== null)) {
    throw new Error('map-run main or checklist snapshot provenance missing');
  }
  if (!Array.isArray(start.itemIds) || start.itemIds.some((id) => typeof id !== 'string' || !ID.test(id))
    || new Set(start.itemIds).size !== start.itemIds.length) throw new Error('map-run item identities missing or duplicate');
  if (typeof start.inventoryComplete !== 'boolean' || typeof start.dryRun !== 'boolean') throw new Error('map-run completeness or dry-run missing');
  if (!start.inventoryComplete && start.itemIds.length) throw new Error('map-run partial inventory cannot name items');
  if (!start.requestedPool || !('selectedPool' in start) || !('imageCommit' in start)) throw new Error('map-run pool or image provenance missing');
  if (start.mapReducePolicy && !validMapReducePolicy(start.mapReducePolicy)) throw new Error('map-run invalid shared map-reduce policy');
}

function validateRow(row: MapRunRow, start: MapRunStart): void {
  if (row.mapRunId !== start.mapRunId || row.recipe !== start.recipe || !KINDS.has(row.kind) || row.verdict !== row.kind
    || !Array.isArray(row.evidence)
    || row.evidence.some((value) => typeof value !== 'string') || typeof row.reason !== 'string') {
    throw new Error('map-run row contract mismatch');
  }
  if (!RECIPE_KINDS[start.recipe].has(row.kind)) throw new Error('map-run kind outside recipe');
  if (row.rowsSuppressed) {
    if (start.inventoryComplete || row.itemId !== null || row.pr !== null || row.kind !== 'hold') {
      throw new Error('map-run suppressed row must hold an incomplete inventory without a PR');
    }
  } else if (!start.inventoryComplete) {
    throw new Error('map-run incomplete inventory suppresses item rows');
  } else if (!row.itemId || !start.itemIds.includes(row.itemId)) {
    throw new Error(`map-run unknown item: ${row.itemId}`);
  }
  if (row.kind === 'hold' && !row.reason.trim()) throw new Error('map-run hold needs a reason');
  if (row.kind !== 'hold' && row.evidence.length === 0) throw new Error('map-run candidate needs evidence');
  if (row.kind === 'green-candidate'
    && (row.e1?.verdict !== 'pass' || row.e2?.verdict !== 'pass' || row.e3?.verdict !== 'pass'
      || !SHA.test(row.e1.mergeSha ?? '') || row.e1.mainAncestor !== true
      || !row.e3.reason.trim()
      || typeof row.pr !== 'number' || !Number.isSafeInteger(row.pr) || row.pr <= 0
      || !row.prUrl || !row.e2Source || row.e2Source === 'missing'
      || !row.e2.command?.trim() || row.e2.exitCode !== 0)) {
    throw new Error('map-run green candidate needs E1/E2/E3 and PR proof');
  }
  if ((row.kind === 'harvest' || row.kind === 'close-candidate')
    && (typeof row.pr !== 'number' || !Number.isSafeInteger(row.pr) || row.pr <= 0 || !SHA.test(row.headOid ?? ''))) {
    throw new Error('map-run draft decision needs exact PR head');
  }
  if (row.rc != null && row.rc !== 0 && row.kind !== 'hold') throw new Error('map-run failed Pod cannot yield a candidate');
  for (const field of ['podJob', 'podUid', 'startedAt', 'endedAt'] as const) {
    const value = row[field];
    if (value != null && (typeof value !== 'string' || !value.trim())) throw new Error(`map-run invalid ${field}`);
  }
  if (row.result != null && (typeof row.result !== 'object' || Array.isArray(row.result))) {
    throw new Error('map-run invalid result');
  }
  if (start.mapReducePolicy && !row.rowsSuppressed && !row.mapReducePiece) {
    throw new Error('map-run shared piece receipt missing');
  }
  if (row.mapReducePiece && (row.mapReducePiece.pieceId !== row.itemId || !start.mapReducePolicy
    || !validMapReducePieceReceipt(start.mapReducePolicy, row.mapReducePiece))) {
    throw new Error('map-run invalid shared piece receipt');
  }
}

/** Exclusive create prevents a retry from silently replacing the original inventory. */
export function createMapRun(start: MapRunStart, root?: string): string {
  validateStart(start);
  const path = mapRunLedgerPath(start.mapRunId, root);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(start)}\n`); }
  finally { closeSync(fd); }
  return path;
}

export function readMapRun(mapRunId: string, root?: string): MapRunRead {
  const path = mapRunLedgerPath(mapRunId, root);
  if (!existsSync(path)) throw new Error(`map-run missing: ${mapRunId}`);
  const raw = readFileSync(path, 'utf8');
  if (!raw.endsWith('\n')) throw new Error('map-run truncated JSONL tail');
  const lines = raw.trimEnd().split('\n');
  let start: MapRunStart;
  try { start = JSON.parse(lines[0]!) as MapRunStart; }
  catch { throw new Error('map-run invalid start JSON'); }
  if (start.event !== 'start' || start.mapRunId !== mapRunId) throw new Error('map-run invalid start');
  validateStart(start);
  const rows: MapRunRow[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    let row: MapRunRow;
    try { row = JSON.parse(line) as MapRunRow; }
    catch { throw new Error('map-run invalid row JSON'); }
    if (row.event !== 'row') throw new Error('map-run unexpected event');
    validateRow(row, start);
    const key = row.rowsSuppressed ? '__inventory_hold__' : row.itemId!;
    if (seen.has(key)) throw new Error(`map-run duplicate row: ${key}`);
    seen.add(key);
    rows.push(row);
  }
  if (rows.some((row) => row.rowsSuppressed) && rows.length !== 1) throw new Error('map-run suppressed inventory has item rows');
  return { start, rows };
}

/** The lock protects the read-before-append duplicate check across concurrent Pod completions. */
export function appendMapRunRow(row: MapRunRow, root?: string): void {
  const path = mapRunLedgerPath(row.mapRunId, root);
  withFileLockSync(`${path}.lock`, () => {
    const current = readMapRun(row.mapRunId, root);
    validateRow(row, current.start);
    const key = row.rowsSuppressed ? '__inventory_hold__' : row.itemId!;
    if (current.rows.some((existing) => (existing.rowsSuppressed ? '__inventory_hold__' : existing.itemId) === key)) {
      throw new Error(`map-run duplicate row: ${key}`);
    }
    if (row.rowsSuppressed && current.rows.length) throw new Error('map-run inventory hold cannot follow item rows');
    if (current.rows.some((existing) => existing.rowsSuppressed)) throw new Error('map-run inventory hold suppresses item rows');
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  });
}

/** No consumer of this result can write: incomplete evidence remains an explicit hold. */
export function reduceMapRun(mapRunId: string, root?: string): MapRunReduce {
  const { start, rows } = readMapRun(mapRunId, root);
  const counts: Record<MapRowKind, number> = {
    'green-candidate': 0, 'mock-pr': 0, 'implementation-remains': 0,
    harvest: 0, 'close-candidate': 0, hold: 0,
  };
  for (const row of rows) counts[row.kind]++;
  const accounted = start.inventoryComplete && rows.length === start.itemIds.length
    && rows.every((row) => !row.rowsSuppressed);
  const complete = accounted && start.itemIds.length > 0 && counts.hold === 0;
  const receipt = start.mapReducePolicy ? reduceMapReduceReceipt(start.mapReducePolicy, start.itemIds,
    rows.flatMap((row) => row.mapReducePiece ? [row.mapReducePiece] : [])) : undefined;
  return {
    mapRunId, verdict: complete ? 'complete' : 'hold',
    reason: !start.inventoryComplete ? 'inventory-incomplete' : start.itemIds.length === 0 ? 'empty-inventory'
      : !accounted ? 'results-missing'
      : counts.hold ? 'item-hold' : 'all-items-accounted',
    expected: start.itemIds.length, observed: rows.length, counts, writes: 0,
    ...(receipt ? { receipt } : {}),
  };
}
