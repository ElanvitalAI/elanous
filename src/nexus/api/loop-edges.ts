import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { listSeatRequests, type SeatRequestRow } from '../../seat-dispatch/seat-request-ledger.js';
import { listCoordEvents } from '../../context-bus/coord-events.js';
import { CardStore, cardIndexPath, type TaskCard } from '../../task-cards/card-store.js';
import { loadRunLedger, resolveFederatedRunLedgerDirectories, type RunLedgerEntry } from '../../self-implement/run-ledger.js';
import { listLoops } from '../../loops/registry.js';
import { listSubSeatCharters } from './sub-seat-charters.js';
import { SEATS } from './ops-seats.js';
import { jsonResponse } from './json-response.js';

export interface LoopEdge {
  at: string;
  kind: 'request' | 'decision' | 'report' | 'card' | 'run';
  from: string;
  to: string;
  ref: string;
}

export interface LoopEdgesDeps {
  listCoord?: typeof listCoordEvents;
  cardRoot?: string;
  ledgerDir?: string;
  listCards?: () => TaskCard[];
  listRunStarts?: (since: string) => Array<{ runId: string; at: string; seat: string; mergedAt?: string }>;
  listSeatRequests?: () => SeatRequestRow[];
  listOrchestratorLaunches?: () => Array<{ key: string; runId: string }>;
  listLoopOwners?: () => Array<{ id: string; owner?: string | null }>;
  seatIds?: () => string[];
}

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SURFACES = new Set(['telegram', 'pwa', 'linear', 'tui', 'discord', 'api', 'cli', 'voice', 'folder', 'wish']);
const KINDS: Record<string, LoopEdge['kind']> = { '요청': 'request', '결정': 'decision', '보고': 'report' };

function seat(value: unknown, seats: ReadonlySet<string>): value is string {
  return typeof value === 'string' && seats.has(value);
}
function surface(value: unknown): value is string {
  return typeof value === 'string' && SURFACES.has(value);
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parse(content: string): Record<string, unknown> | null {
  try { return object(JSON.parse(content) as unknown); } catch { return null; }
}
function inWindow(at: string, since: number, now: number): boolean {
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms >= since && ms <= now;
}

type PlacedCell = { cardId: string; cellId: string; owner: string };

function cardEdges(card: TaskCard, since: number, now: number, seats: ReadonlySet<string>, placedCells: PlacedCell[]): LoopEdge[] {
  if (!card.goalId.startsWith('wish:') || !ID.test(card.id)) return [];
  const node = `card:${card.id}`;
  const ref = card.id;
  const edges: LoopEdge[] = [];
  const intake = card.sections.find(s => s.key === 'intake:wish:0');
  const intakeData = intake && parse(intake.content);
  if (intake && surface(intakeData?.source) && inWindow(intake.createdAt, since, now)) {
    edges.push({ at: intake.createdAt, kind: 'card', from: `surface:${intakeData.source}`, to: node, ref });
  }
  const split = card.sections.find(s => s.key === 'flow:split:0');
  const splitData = split && parse(split.content);
  const cells = Array.isArray(splitData?.cells) ? splitData.cells : [];
  const owners = new Map<string, string>();
  for (const item of cells) {
    const cell = object(item);
    if (typeof cell?.id === 'string' && ID.test(cell.id) && seat(cell.owner, seats)) owners.set(cell.id, cell.owner);
  }
  const placedOwners = new Set<string>();
  for (const section of card.sections) {
    if (!section.key.startsWith('flow:placed:')) continue;
    const cellId = section.key.slice('flow:placed:'.length);
    const saved = parse(section.content);
    const placement = object(saved?.decision);
    const owner = owners.get(cellId);
    if (!owner || !placement || placement.id !== cellId || !ID.test(cellId)
      || typeof placement.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(placement.version)) continue;
    placedOwners.add(owner);
    placedCells.push({ cardId: card.id, cellId, owner });
    if (inWindow(section.createdAt, since, now)) {
      const cellNode = `loop:${cellId}`;
      edges.push({ at: section.createdAt, kind: 'card', from: node, to: cellNode, ref });
      edges.push({ at: section.createdAt, kind: 'card', from: cellNode, to: owner, ref });
    }
  }
  const reply = card.sections.find(s => s.key === 'intake:reply:0');
  const replyData = reply && parse(reply.content);
  // The destination section alone is not a send; flow:result records a completed card flow.
  const result = card.sections.find(s => s.key === 'flow:result:0');
  if (result && reply && surface(replyData?.surface) && inWindow(result.createdAt, since, now)) {
    for (const owner of placedOwners) {
      edges.push({ at: result.createdAt, kind: 'card', from: owner, to: `surface:${replyData.surface}`, ref });
    }
  }
  return edges;
}

function runStarts(since: string, dir: string, owners: ReadonlyMap<string, string>, seats: ReadonlySet<string>): Array<{ runId: string; at: string; seat: string; mergedAt?: string }> {
  if (!existsSync(dir)) return [];
  const result: Array<{ runId: string; at: string; seat: string; mergedAt?: string }> = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  for (const name of names) {
    if (!/^run-[a-zA-Z0-9-]+\.jsonl$/.test(name)) continue;
    const path = join(dir, name);
    try { if (!statSync(path).isFile() || statSync(path).size > 5 * 1024 * 1024) continue; }
    catch { continue; }
    const runId = name.slice(0, -6);
    let entries: RunLedgerEntry[] | null;
    try { entries = loadRunLedger(runId, dir); } catch { continue; }
    const start = entries?.find(entry => entry.event === 'start' && entry.runId === runId);
    const feature = typeof start?.data.feature === 'string' ? start.data.feature : '';
    const launchSeat = start?.data.launchSeat ?? start?.data.seat ?? owners.get(feature)
      ?? start?.data.originAgent ?? start?.data.controller;
    if (start?.timestamp && seat(launchSeat, seats)) {
      const merged = entries?.find(entry => entry.event === 'merged' && entry.data.merged === true && typeof entry.timestamp === 'string');
      if (start.timestamp >= since || (merged?.timestamp && merged.timestamp >= since)) {
        result.push({ runId, at: start.timestamp, seat: launchSeat, ...(merged?.timestamp ? { mergedAt: merged.timestamp } : {}) });
      }
    }
  }
  return result;
}

/** Project only the key and runId of orchestrator launches, never their card snapshots or prose. */
function orchestratorLaunches(root: string): Array<{ key: string; runId: string }> {
  const dir = join(root, 'loop', 'orchestrator');
  if (!existsSync(dir)) return [];
  const launches: Array<{ key: string; runId: string }> = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  for (const name of names) {
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile() || statSync(path).size > 5 * 1024 * 1024) continue;
      const state = parse(readFileSync(path, 'utf8'));
      if (state?.mode !== 'live' || !Array.isArray(state.launched)) continue;
      for (const item of state.launched) {
        const launch = object(item);
        if (typeof launch?.key === 'string' && typeof launch.runId === 'string') {
          launches.push({ key: launch.key, runId: launch.runId });
        }
      }
    } catch { /* An unreadable tick cannot establish a launch. */ }
  }
  return launches;
}

/** GET only; project an allowlist of fields from the ledgers. Never serialize ledger records. */
export function handleLoopEdgesGet(req: Request, deps: LoopEdgesDeps = {}): Response {
  const params = new URL(req.url).searchParams;
  const rawSince = params.get('since');
  const since = rawSince === null ? Date.now() - 60 * 60 * 1000 : Date.parse(rawSince);
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  const now = Date.now();
  if (rawSince !== null && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(rawSince)
    || !Number.isFinite(since) || since > now || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    return jsonResponse({ error: 'usage: GET /v1/loops/edges?since=<ISO>&limit=<1..500>' }, 400);
  }
  const sinceIso = new Date(since).toISOString();
  const seats = new Set((deps.seatIds ?? (() => [...SEATS.map(s => s.seat), ...listSubSeatCharters().map(s => s.id)]))());
  const edges: LoopEdge[] = [];
  for (const event of (deps.listCoord ?? listCoordEvents)({ since: sinceIso, channelOnly: true })) {
    if (!seat(event.refs.seat, seats) || !inWindow(event.at, since, now)) continue;
    const kind = KINDS[event.refs.kind ?? ''];
    if (!kind || !Array.isArray(event.refs.recipients)) continue;
    const ref = typeof event.refs.url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+#issuecomment-\d+$/.test(event.refs.url)
      ? event.refs.url : event.id;
    if (!ID.test(ref) && !ref.startsWith('https://github.com/')) continue;
    for (const recipient of new Set(event.refs.recipients)) {
      if (seat(recipient, seats)) edges.push({ at: event.at, kind, from: event.refs.seat, to: recipient, ref });
    }
  }
  const placedCells: PlacedCell[] = [];
  if (deps.listCards) {
    for (const card of deps.listCards()) edges.push(...cardEdges(card, since, now, seats, placedCells));
  } else {
    const root = deps.cardRoot;
    if (existsSync(cardIndexPath(root))) {
      const store = new CardStore(root, true);
      try { for (const card of store.listCards()) edges.push(...cardEdges(card, since, now, seats, placedCells)); }
      finally { store.close(); }
    }
  }
  const readStarts = deps.listRunStarts ?? ((from: string) => {
    const owners = new Map<string, string>();
    try {
      for (const entry of (deps.listLoopOwners ?? (() => listLoops()))()) {
        if (seat(entry.owner, seats)) owners.set(entry.id, entry.owner);
      }
    } catch { /* A registry outage does not erase explicit launch-seat evidence. */ }
    return (deps.ledgerDir ? [deps.ledgerDir] : resolveFederatedRunLedgerDirectories({ includeTest: false }))
      .flatMap(dir => runStarts(from, dir, owners, seats));
  });
  const runs = readStarts(sinceIso).filter(run => seat(run.seat, seats) && ID.test(run.runId)
    && (inWindow(run.at, since, now) || (run.mergedAt !== undefined && inWindow(run.mergedAt, since, now))));
  for (const run of runs) {
    if (inWindow(run.at, since, now)) edges.push({ at: run.at, kind: 'run', from: run.seat, to: `loop:${run.runId}`, ref: run.runId });
  }
  if (placedCells.length && runs.length) {
    const root = deps.cardRoot ?? effectiveInstanceRoot();
    let requests: SeatRequestRow[] = [];
    let launches: Array<{ key: string; runId: string }> = [];
    try { requests = (deps.listSeatRequests ?? (() => listSeatRequests(root)))(); } catch { /* Missing request evidence is not a match. */ }
    try { launches = (deps.listOrchestratorLaunches ?? (() => orchestratorLaunches(root)))(); } catch { /* Missing launch evidence is not a match. */ }
    const confirmed = new Set(launches.filter(item => ID.test(item.runId) && runs.some(run => run.runId === item.runId))
      .map(item => JSON.stringify([item.key, item.runId])));
    for (const cell of placedCells) {
      const key = `orch:${cell.cardId}:${cell.cellId}`;
      if (!requests.some(row => row.key === key && row.cell === cell.cellId && row.source === 'orchestrator' && row.seat === cell.owner)) continue;
      for (const run of runs) {
        if (run.seat !== cell.owner || !confirmed.has(JSON.stringify([key, run.runId]))) continue;
        if (inWindow(run.at, since, now)) edges.push({ at: run.at, kind: 'card', from: cell.owner, to: `loop:${run.runId}`, ref: cell.cardId });
        if (run.mergedAt && inWindow(run.mergedAt, since, now)) {
          edges.push({ at: run.mergedAt, kind: 'card', from: `loop:${run.runId}`, to: `landed:${cell.cellId}`, ref: cell.cardId });
        }
      }
    }
  }
  edges.sort((a, b) => b.at.localeCompare(a.at) || a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return jsonResponse({ edges: edges.slice(0, limit) });
}
