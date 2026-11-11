/**
 * MAPREDUCE-FANOUT backend. Inventory and card execution are ports so the CLI can
 * bind the existing checklist/draft readers and tasks hand Pod launcher separately.
 * A run snapshots its inventory before any card starts; one terminal row belongs
 * to each item. This module never changes a checklist or closes a PR.
 */
import { randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';
import {
  appendMapRunRow, createMapRun, readMapRun, reduceMapRun,
  mapReduceHostForPiece, validMapReducePolicy,
  type MapRecipe, type MapReduceAttemptReceipt, type MapReducePieceReceipt, type MapReducePolicy,
  type MapRowKind, type MapRunRow, type MapRunStart,
} from './map-run-ledger.js';

export type MapSource = 'landed-but-yellow' | 'drafts';
export interface MapItem { id: string; estimatedCost?: number }
export interface MapInventory<T extends MapItem> {
  items: readonly T[];
  complete: boolean;
  snapshotTime: string;
  snapshotRef: string;
  recipeSha: string;
  mainSha: string;
  checklistSnapshotPath: string | null;
  requestedPool: string;
  selectedPool: string | null;
  imageCommit: string | null;
  /** A failed inventory is recorded as a suppressed HOLD row. */
  reason?: string;
}
export interface MapCard {
  id: string;
  itemId: string;
  mapRunId: string;
  recipe: MapRecipe;
  text: string;
}
export interface MapContext {
  mapRunId: string;
  recipe: MapRecipe;
  source: MapSource;
  dryRun: boolean;
  attempt?: number;
  host?: string;
  /** Per-attempt cost ceiling passed to the launcher before it starts the child. */
  costLimit?: number;
}
export interface MapPorts<T extends MapItem> {
  inventory: (recipe: MapRecipe, source: MapSource, limit: number | undefined) => Promise<MapInventory<T>>;
  /** Pure card authoring. Do not persist or launch here. */
  buildCard: (item: T, context: MapContext) => MapCard;
  /** Production adapter must launch through tasks hand and wait for its terminal recipe result. */
  launchCard: (card: MapCard, item: T, context: MapContext) => Promise<MapRunRow>;
  /** Optional pure preview; default dry-run yields a HOLD without invoking launchCard. */
  previewCard?: (card: MapCard, item: T, context: MapContext) => MapRunRow | Promise<MapRunRow>;
  log?: (event: string, data: Record<string, unknown>) => void;
}
export interface MapRequest {
  recipe: MapRecipe;
  source: MapSource;
  limit?: number;
  concurrency?: number;
  dryRun?: boolean;
  mapReduce?: MapReducePolicy;
  hosts?: readonly string[];
  root?: string;
  mapRunId?: string;
}
export interface MapResult { mapRunId: string; expected: number; observed: number; dryRun: boolean }

const validPairs: Readonly<Record<MapRecipe, MapSource>> = {
  'green-close': 'landed-but-yellow', 'draft-close': 'drafts',
};
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

function checkPositive(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`map ${label} must be a positive integer`);
}
function hold(context: MapContext, itemId: string | null, reason: string, suppressed = false): MapRunRow {
  return { event: 'row', mapRunId: context.mapRunId, itemId, recipe: context.recipe,
    kind: 'hold', verdict: 'hold', reason, evidence: [], ...(suppressed ? { rowsSuppressed: true, pr: null } : {}) };
}
function record(log: MapPorts<MapItem>['log'], event: string, data: Record<string, unknown>): void {
  try { (log ?? ((name, fields) => debug.log('task-agent.map-reduce', name, fields)))(event, data); }
  catch { /* diagnostics must not turn a completed item into a failed one */ }
}

/** Bounded workers, with no unbounded Promise.all fanout. Default is a read-only preview. */
export async function mapInventory<T extends MapItem>(request: MapRequest, ports: MapPorts<T>): Promise<MapResult> {
  if (validPairs[request.recipe] !== request.source) throw new Error('map recipe/source mismatch');
  checkPositive(request.limit, 'limit');
  checkPositive(request.concurrency, 'concurrency');
  if (request.mapReduce && !validMapReducePolicy(request.mapReduce)) throw new Error('map invalid shared map-reduce policy');
  if (request.mapReduce && (!request.hosts?.length || request.hosts.some((host) => !host.trim()))) {
    throw new Error('map shared policy requires at least one named host');
  }
  const concurrency = request.concurrency ?? 2;
  const dryRun = request.dryRun !== false;
  const mapRunId = request.mapRunId ?? `map-${randomUUID()}`;
  if (!idPattern.test(mapRunId)) throw new Error('map invalid run id');
  const baseContext: MapContext = { mapRunId, recipe: request.recipe, source: request.source, dryRun };
  const inventory = await ports.inventory(request.recipe, request.source, request.limit);
  // A limit is a selection boundary, not permission to silently truncate a partial inventory.
  const items = inventory.complete ? inventory.items.slice(0, request.limit) : [];
  const start: MapRunStart = { event: 'start', mapRunId, recipe: request.recipe,
    recipeSha: inventory.recipeSha, snapshotTime: inventory.snapshotTime, snapshotRef: inventory.snapshotRef,
    mainSha: inventory.mainSha, checklistSnapshotPath: inventory.checklistSnapshotPath,
    inventoryComplete: inventory.complete, itemIds: items.map((item) => item.id),
    requestedPool: inventory.requestedPool, selectedPool: inventory.selectedPool,
    imageCommit: inventory.imageCommit, dryRun, ...(request.mapReduce ? { mapReducePolicy: request.mapReduce } : {}) };
  createMapRun(start, request.root);
  record(ports.log, 'start', { mapRunId, recipe: request.recipe, source: request.source, count: items.length, concurrency, dryRun });
  if (!inventory.complete) {
    appendMapRunRow(hold(baseContext, null, inventory.reason || 'inventory-incomplete', true), request.root);
    record(ports.log, 'inventory-hold', { mapRunId, reason: inventory.reason ?? 'inventory-incomplete' });
    return { mapRunId, expected: 0, observed: 1, dryRun };
  }
  const orderedItems = request.mapReduce ? [...items].sort((a, b) => a.id.localeCompare(b.id)) : [...items];
  const reservations = new Map<string, { cost: number; allowed: boolean }>();
  if (request.mapReduce) {
    let reserved = 0; // Source: budget accumulation starts with no reservations (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
    for (const item of orderedItems) {
      const estimate = item.estimatedCost;
      const cost = Number.isFinite(estimate) && estimate! >= 0 ? estimate! : Number.NaN;
      const reserve = cost * (request.mapReduce.retryMax + 1); // Source: reserve one estimate for the initial attempt plus retry.max (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
      const allowed = Number.isFinite(reserve) && reserved + reserve <= request.mapReduce.costLimit;
      if (allowed) reserved += reserve;
      reservations.set(item.id, { cost, allowed });
    }
  }
  let next = 0;
  let observed = 0;
  async function worker(): Promise<void> {
    while (next < orderedItems.length) {
      const item = orderedItems[next++]!;
      const reservation = reservations.get(item.id);
      let row: MapRunRow;
      let sharedReceipt: MapReducePieceReceipt | undefined;
      if (request.mapReduce && (!reservation?.allowed || !Number.isFinite(reservation.cost))) {
        row = hold(baseContext, item.id, Number.isFinite(reservation?.cost) ? 'budget-exceeded' : 'cost-estimate-unmeasured');
        sharedReceipt = { pieceId: item.id, host: null,
          status: Number.isFinite(reservation?.cost) ? 'budget-exceeded' : 'unmeasured', reservedCost: 0, attempts: [] }; // Source: rejected work has no measured spend (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
        row = { ...row, mapReducePiece: sharedReceipt };
        appendMapRunRow(row, request.root);
        observed++;
        record(ports.log, 'item', { mapRunId, itemId: item.id, kind: row.kind, reason: row.reason });
        continue;
      }
      try {
        const card = ports.buildCard(item, baseContext);
        if (!card || !idPattern.test(card.id) || card.itemId !== item.id || card.mapRunId !== mapRunId
          || card.recipe !== request.recipe || !card.text.trim()) throw new Error('card identity mismatch');
        if (request.mapReduce && dryRun) {
          row = ports.previewCard ? await ports.previewCard(card, item, baseContext) : hold(baseContext, item.id, 'dry-run-preview');
          sharedReceipt = { pieceId: item.id, host: null, status: 'unmeasured', reservedCost: reservation!.cost * (request.mapReduce.retryMax + 1), attempts: [] };
        } else if (request.mapReduce) {
          const attempts: MapReduceAttemptReceipt[] = [];
          let finalRow: MapRunRow | undefined;
          let finalHost: string | null = null;
          for (let attempt = 1; attempt <= request.mapReduce.retryMax + 1; attempt++) { // Source: attempt numbering starts at one and includes retry.max additional attempts (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
            const alternateHosts = attempt > 1 ? request.hosts!.filter((candidate) => candidate !== finalHost) : [];
            const eligibleHosts = alternateHosts.length ? alternateHosts : request.hosts!;
            const host = mapReduceHostForPiece(request.mapReduce.seed, item.id, attempt, eligibleHosts);
            if (!host) {
              attempts.push({ attempt, host: 'unassigned', status: 'unmeasured', cost: 0 }); // Source: no host execution means zero measured spend (NUMGUARD)
              break;
            }
            finalHost = host;
            const context: MapContext = { ...baseContext, attempt, host, costLimit: reservation!.cost };
            let candidate: MapRunRow;
            try { candidate = await ports.launchCard(card, item, context); }
            catch (error) {
              attempts.push({ attempt, host, status: 'failed', cost: 0 }); // Source: launcher rejection before a receipt has no measured spend (NUMGUARD)
              finalRow = hold(context, item.id, `map-item-failed: ${error instanceof Error ? error.message : String(error)}`);
              continue;
            }
            if (candidate.mapRunId !== mapRunId || candidate.itemId !== item.id || candidate.recipe !== request.recipe)
              throw new Error('result identity mismatch');
            const actualCost = candidate.result?.cost;
            if (!Number.isFinite(actualCost) || (actualCost as number) < 0) {
              attempts.push({ attempt, host, status: 'unmeasured', cost: 0 }); // Source: absent cost evidence is not fabricated (NUMGUARD)
              finalRow = hold(context, item.id, 'actual-cost-unmeasured');
              break;
            }
            const attemptCost = actualCost as number;
            const passed = candidate.kind !== 'hold' && (candidate.rc == null || candidate.rc === 0);
            const withinReservation = attemptCost <= reservation!.cost;
            attempts.push({ attempt, host, status: !withinReservation ? 'unmeasured' : passed ? 'complete' : 'failed', cost: attemptCost });
            finalRow = candidate;
            if (!withinReservation) {
              finalRow = hold(context, item.id, 'cost-limit-exceeded');
              break;
            }
            if (passed) break;
          }
          const last = attempts.at(-1);
          const status = last?.status === 'unmeasured' ? 'unmeasured'
            : last?.status === 'complete' ? 'complete'
              : attempts.length === request.mapReduce.retryMax + 1 ? 'failed' : 'unmeasured';
          sharedReceipt = { pieceId: item.id, host: finalHost, status, reservedCost: reservation!.cost * (request.mapReduce.retryMax + 1), attempts };
          row = finalRow ?? hold(baseContext, item.id, 'no-attempt-result');
        } else {
          row = dryRun
            ? ports.previewCard ? await ports.previewCard(card, item, baseContext) : hold(baseContext, item.id, 'dry-run-preview')
            : await ports.launchCard(card, item, baseContext);
        }
        if (row.mapRunId !== mapRunId || row.itemId !== item.id || row.recipe !== request.recipe)
          throw new Error('result identity mismatch');
        row = { ...row, result: { ...row.result, cardId: card.id } };
      } catch (error) {
        row = hold(baseContext, item.id, `map-item-failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (request.mapReduce && !sharedReceipt) sharedReceipt = { pieceId: item.id, host: null,
        status: 'unmeasured', reservedCost: 0, attempts: [] };
      if (sharedReceipt) row = { ...row, mapReducePiece: sharedReceipt };
      // The ledger validates recipe-specific evidence and rejects duplicate/unknown rows.
      // An invalid result is a hard error; never launder it into a successful map run.
      appendMapRunRow(row, request.root);
      observed++;
      record(ports.log, 'item', { mapRunId, itemId: item.id, kind: row.kind, reason: row.reason });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  record(ports.log, 'finished', { mapRunId, expected: items.length, observed });
  return { mapRunId, expected: items.length, observed, dryRun };
}

export interface MapReduceTable { mapRunId: string; markdown: string; writes: 0 }
const countKinds: readonly MapRowKind[] = ['green-candidate', 'mock-pr', 'implementation-remains', 'harvest', 'close-candidate', 'hold'];
function cell(value: unknown): string { return String(value ?? '').replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' '); }

/** Read-only aggregation. Applying green/close candidates belongs to a separate guarded reducer. */
export function renderMapReduceTable(mapRunId: string, root?: string): MapReduceTable {
  const { start, rows } = readMapRun(mapRunId, root);
  const summary = reduceMapRun(mapRunId, root);
  const lines = [
    `# Map run ${cell(mapRunId)}`,
    '',
    `Recipe: ${start.recipe} · snapshot: ${cell(start.snapshotRef)} · dry-run: ${start.dryRun} · verdict: ${summary.verdict} (${summary.reason})`,
    `Expected: ${summary.expected} · observed: ${summary.observed} · writes: 0`,
    `Counts: ${countKinds.map((kind) => `${kind} ${summary.counts[kind]}`).join(' · ')}`,
    '',
    '| Item | Card | Result | PR | Reason |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${cell(row.itemId ?? 'inventory')} | ${cell(row.result?.cardId)} | ${row.kind} | ${cell(row.pr)} | ${cell(row.reason)} |`),
  ];
  return { mapRunId, markdown: `${lines.join('\n')}\n`, writes: 0 };
}
