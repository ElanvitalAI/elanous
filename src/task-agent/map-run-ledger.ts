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
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
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
  return {
    mapRunId, verdict: complete ? 'complete' : 'hold',
    reason: !start.inventoryComplete ? 'inventory-incomplete' : start.itemIds.length === 0 ? 'empty-inventory'
      : !accounted ? 'results-missing'
      : counts.hold ? 'item-hold' : 'all-items-accounted',
    expected: start.itemIds.length, observed: rows.length, counts, writes: 0,
  };
}
