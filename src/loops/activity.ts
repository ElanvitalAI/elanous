import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { LogStore, type LogStoreRow } from '../mss/logging/log-store.js';
import { checkLoops } from './checker.js';
import { defaultLoopRoot, listAllLoops, type AllLoopEntry } from './registry.js';
import type { ScheduleRow } from '../domains/schedule-registry.js';

export interface ActivityNode {
  id: string;
  kind: AllLoopEntry['kind'] | 'seat' | 'card' | 'event';
  title: string;
  state: string | null;
  reason: string | null;
  lastAt: string | null;
  events: number;
}
export interface ActivityEdge {
  from: string;
  to: string;
  kind: 'delegation' | 'request' | 'reply' | 'card';
  count: number;
  lastAt: string;
}
export interface LoopActivityResult {
  since: string;
  until: string;
  nodes: ActivityNode[];
  edges: ActivityEdge[];
}
export interface LoopActivityDeps {
  listAllLoops?: (opts: { root: string; stateRoot: string; now: Date; schedules: ScheduleRow[] }) => AllLoopEntry[];
  queryEvents?: (root: string, sinceMs: number, untilMs: number) => LogStoreRow[];
  readJournal?: (root: string, name: string) => readonly Record<string, unknown>[];
  readCards?: (root: string) => readonly { id: string; createdAt: string; sections: readonly { owner: string; createdAt: string }[] }[];
}

function readSchedules(root: string): ScheduleRow[] {
  const path = join(root, 'schedules.db');
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schedule_registry'").get()) return [];
    const columns = (db.query('PRAGMA table_info(schedule_registry)').all() as Array<{ name: string }>).map(row => row.name);
    if (!columns.includes('run_via')) return [];
    return db.query('SELECT * FROM schedule_registry').all() as ScheduleRow[];
  } finally { db.close(); }
}

function readEvents(root: string, sinceMs: number, untilMs: number): LogStoreRow[] {
  const path = join(root, 'logs', 'logs.db');
  if (!existsSync(path)) return [];
  const store = LogStore.openReadOnly(path);
  try { return store.queryAll({ categories: ['loop.', 'seat.loop'], sinceMs, untilMs }); }
  finally { store.close(); }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function readJournal(root: string, name: string): Record<string, unknown>[] {
  const path = join(root, 'seat-requests', name);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(parseObject) : [];
}

function readCards(root: string): { id: string; createdAt: string; sections: { owner: string; createdAt: string }[] }[] {
  const dir = join(root, 'task-cards');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(file => file.endsWith('.jsonl')).flatMap(file => {
    const entries = readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map(parseObject);
    const created = entries.find(row => row.type === 'created');
    if (!created || typeof created.id !== 'string' || typeof created.createdAt !== 'string') return [];
    return [{ id: created.id, createdAt: created.createdAt,
      sections: entries.filter(row => row.type === 'section' && typeof row.owner === 'string' && typeof row.createdAt === 'string')
        .map(row => ({ owner: row.owner as string, createdAt: row.createdAt as string })) }];
  });
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function loopId(value: unknown): string | null {
  const id = text(value);
  if (!id) return null;
  const seat = id.toUpperCase();
  if (seat === 'OP' || seat === 'TC' || seat === 'UX') return `${seat.toLowerCase()}-seat`;
  if (seat === 'MK' || seat === 'MK-SEAT') return 'cmo-seat';
  return id;
}

function cardNodeId(value: unknown): string | null {
  const id = text(value);
  return id ? (id.startsWith('card:') ? id : `card:${id}`) : null;
}

/** Read-only registry/checker snapshot plus observed edges in the inclusive time window. */
export function loopActivity({ since, until, root = effectiveInstanceRoot(), deps = {} }: {
  since: string | Date;
  until?: string | Date;
  root?: string;
  deps?: LoopActivityDeps;
}): LoopActivityResult {
  const end = until === undefined ? new Date() : new Date(until);
  const duration = typeof since === 'string' ? /^(\d+)([mhd])$/.exec(since) : null;
  const durationMs = duration ? Number(duration[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2]!] ?? NaN) : NaN;
  const start = duration ? new Date(end.getTime() - durationMs) : new Date(since);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) throw new Error('invalid loop activity window');
  const inventory = (deps.listAllLoops ?? listAllLoops)({ root: deps.listAllLoops ? root : defaultLoopRoot(), stateRoot: root, now: end, schedules: deps.listAllLoops ? [] : readSchedules(root) });
  const checked = checkLoops(inventory, end);
  const byId = new Map(inventory.map(entry => [entry.id, entry]));
  const nodes = new Map<string, ActivityNode>(checked.map(entry => [entry.id, {
    id: entry.id, kind: byId.get(entry.id)?.kind ?? 'graph',
    title: byId.get(entry.id)?.title ?? entry.id,
    state: entry.state, reason: entry.reason, lastAt: entry.lastRunAt ?? null, events: 0,
  }]));
  const edges = new Map<string, ActivityEdge>();
  const ensure = (id: string, kind: ActivityNode['kind'] = 'event'): ActivityNode => {
    let node = nodes.get(id);
    if (!node) {
      node = { id, kind, title: id, state: null, reason: null, lastAt: null, events: 0 };
      nodes.set(id, node);
    }
    return node;
  };
  const inWindow = (value: unknown): string | null => {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(ms) && ms >= start.getTime() && ms <= end.getTime() ? new Date(ms).toISOString() : null;
  };
  const touch = (id: string, at: string, kind: ActivityNode['kind'] = 'event'): void => {
    const node = ensure(id, kind);
    node.events++;
    if (!node.lastAt || at > node.lastAt) node.lastAt = at;
  };
  const connect = (from: string, to: string, kind: ActivityEdge['kind'], at: string): void => {
    if (from === to) return;
    ensure(from, from.startsWith('card:') ? 'card' : 'event');
    ensure(to, to.startsWith('card:') ? 'card' : 'event');
    const key = JSON.stringify([from, to, kind]);
    const edge = edges.get(key);
    if (edge) { edge.count++; if (at > edge.lastAt) edge.lastAt = at; }
    else edges.set(key, { from, to, kind, count: 1, lastAt: at });
  };
  for (const row of (deps.queryEvents ?? readEvents)(root, start.getTime(), end.getTime())) {
    const timestamp = Number.isFinite(row.ts_ms) ? row.ts_ms : Date.parse(row.ts);
    if (!Number.isFinite(timestamp) || timestamp < start.getTime() || timestamp > end.getTime()) continue;
    const data = parseObject(row.data ?? '');
    const actor = row.category.startsWith('loop.') && !['loop.checker', 'loop.observe', 'loop.registry', 'loop.neighbors', 'loop.package'].includes(row.category)
      ? loopId(row.category.slice('loop.'.length)) : row.category === 'seat.loop' ? loopId(data.seat) : null;
    if (!actor) continue;
    const at = new Date(timestamp).toISOString();
    touch(actor, at);
    if (row.event === 'exchange' && text(data.reason) === 'delegation') {
      const to = loopId(data.to ?? data.targetLoopId);
      if (to) connect(loopId(data.from) ?? actor, to, 'delegation', at);
    } else if (row.category === 'loop.orchestrator' && row.event === 'exchange' && data.reason === 'queued') {
      const to = loopId(data.targetLoopId);
      if (to) connect(actor, to, 'delegation', at);
    } else if (row.event === 'exchange' && (data.reason === 'request' || data.reason === 'reply' || data.reason === 'card')) {
      const to = data.reason === 'card' && data.cardId != null
        ? cardNodeId(data.cardId) : loopId(data.to ?? data.targetLoopId);
      if (to) connect(loopId(data.from) ?? actor, to, data.reason, at);
    }
  }
  for (const item of (deps.readJournal ?? readJournal)(root, 'requests.jsonl')) {
    const at = inWindow(item.queuedAt);
    const to = loopId(item.loopId ?? item.seat);
    if (!at || !to) continue;
    touch(to, at, 'seat');
    const from = loopId(item.from) ?? (item.source === 'orchestrator' || item.source === 'orchestrator-traffic' ? 'orchestrator'
      : item.source === 'loop-checker' ? 'checker' : null);
    if (from) connect(from, to, 'request', at);
  }
  for (const item of (deps.readJournal ?? readJournal)(root, 'replies.jsonl')) {
    const at = inWindow(item.repliedAt ?? item.createdAt);
    const from = loopId(item.from ?? item.seat);
    if (!at || !from) continue;
    touch(from, at, 'seat');
    const to = loopId(item.to);
    if (to) connect(from, to, 'reply', at);
  }
  for (const card of (deps.readCards ?? readCards)(root)) {
    const id = cardNodeId(card.id);
    if (!id) continue;
    const created = inWindow(card.createdAt);
    if (created) touch(id, created, 'card');
    for (const section of card.sections) {
      const at = inWindow(section.createdAt);
      const owner = loopId(section.owner);
      if (!at || !owner) continue;
      touch(id, at, 'card');
      connect(owner, id, 'card', at);
    }
  }
  return { since: start.toISOString(), until: end.toISOString(),
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind)) };
}
