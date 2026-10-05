import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
  listRunStarts?: (since: string) => Array<{ runId: string; at: string; seat: string }>;
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

function cardEdges(card: TaskCard, since: number, now: number, seats: ReadonlySet<string>): LoopEdge[] {
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

function runStarts(since: string, dir: string, owners: ReadonlyMap<string, string>, seats: ReadonlySet<string>): Array<{ runId: string; at: string; seat: string }> {
  if (!existsSync(dir)) return [];
  const result: Array<{ runId: string; at: string; seat: string }> = [];
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
    if (start?.timestamp && start.timestamp >= since && seat(launchSeat, seats)) {
      result.push({ runId, at: start.timestamp, seat: launchSeat });
    }
  }
  return result;
}

/** GET only; project an allowlist of fields from the three ledgers. Never serialize ledger records. */
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
  if (deps.listCards) {
    for (const card of deps.listCards()) edges.push(...cardEdges(card, since, now, seats));
  } else {
    const root = deps.cardRoot;
    if (existsSync(cardIndexPath(root))) {
      const store = new CardStore(root, true);
      try { for (const card of store.listCards()) edges.push(...cardEdges(card, since, now, seats)); }
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
  for (const run of readStarts(sinceIso)) {
    if (seat(run.seat, seats) && ID.test(run.runId) && inWindow(run.at, since, now)) {
      edges.push({ at: run.at, kind: 'run', from: run.seat, to: `loop:${run.runId}`, ref: run.runId });
    }
  }
  edges.sort((a, b) => b.at.localeCompare(a.at) || a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return jsonResponse({ edges: edges.slice(0, limit) });
}
