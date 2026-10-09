import { debug } from '../debug/log.js';
import { openMsgStore } from '../msg/msg-store.js';
import { judgeNeighbor, type Neighbor } from './neighbors.js';
import { join } from 'node:path';

export type LoopHealth = 'healthy' | 'degraded';
export type NeighborIncident = { observer: string; neighbor: string; state: 'absent'; reason: string; action: Neighbor['onAbsent']['action']; to: string; at: string; lastSeenAt: string | null };

export const SEAT_NEIGHBORS: Record<string, Neighbor[]> = Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map(seat => [seat,
  [
    ...['OP', 'TC', 'MK', 'UX'].filter(peer => peer !== seat).map(peer => ({
      id: peer === 'MK' ? 'cmo-seat' : `${peer.toLowerCase()}-seat`, exchange: ['status'] as Neighbor['exchange'],
      heartbeat: { everyMinutes: 15, missedTicks: 2 },
      onAbsent: peer === 'OP' ? { action: 'delegate' as const, delegateTo: 'steward' }
        : peer === 'TC' ? { action: 'escalate' as const, delegateTo: 'orchestrator' }
          : { action: 'defer' as const, delegateTo: 'orchestrator' },
    })),
    { id: 'orchestrator', exchange: ['status'], heartbeat: { everyMinutes: 120, missedTicks: 2 },
      onAbsent: { action: 'escalate', delegateTo: 'human' } },
  ],
]));

type Signal = { at: string; health: LoopHealth; ends_at: string | null };

function withStore<T>(root: string, fn: (store: ReturnType<typeof openMsgStore>) => T): T {
  const store = openMsgStore(join(root, 'msg', 'messages.db'));
  try {
    store.db.exec(`CREATE TABLE IF NOT EXISTS loop_signals (loop_id TEXT PRIMARY KEY, at TEXT NOT NULL, health TEXT NOT NULL, ends_at TEXT);
      CREATE TABLE IF NOT EXISTS loop_watches (observer TEXT NOT NULL, neighbor TEXT NOT NULL, first_at TEXT NOT NULL, PRIMARY KEY(observer, neighbor));
      CREATE TABLE IF NOT EXISTS loop_incidents (observer TEXT NOT NULL, neighbor TEXT NOT NULL, signal_at TEXT NOT NULL,
        reason TEXT NOT NULL, action TEXT NOT NULL, recipient TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY(observer, neighbor, signal_at, reason));`);
    return fn(store);
  } finally { store.close(); }
}

/** Durable signal, independent of chat sessions or the seat work-item ledger. */
export function emitLoopHeartbeat(root: string, loopId: string, health: LoopHealth, now: Date, endsAt?: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(loopId) || !Number.isFinite(now.getTime())) throw new Error('invalid loop heartbeat');
  if (endsAt && !Number.isFinite(Date.parse(endsAt))) throw new Error('invalid heartbeat end');
  withStore(root, store => {
    store.db.query(`INSERT INTO loop_signals(loop_id, at, health, ends_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(loop_id) DO UPDATE SET at=excluded.at, health=excluded.health, ends_at=excluded.ends_at
      WHERE loop_signals.at <= excluded.at`).run(loopId, now.toISOString(), health, endsAt ?? null);
  });
  debug.log(`loop.${loopId}`, 'heartbeat', { loopId, at: now.toISOString(), health, endsAt: endsAt ?? null });
}

/** First watch starts the missing-signal clock. Action receipt and message commit atomically. */
export function checkLoopNeighbors(root: string, observer: string, neighbors: readonly Neighbor[], now: Date): NeighborIncident[] {
  return withStore(root, store => {
    const incidents: NeighborIncident[] = [];
    for (const neighbor of neighbors) {
      if (neighbor.id === observer) continue;
      try {
        store.db.exec('BEGIN IMMEDIATE');
        store.db.query('INSERT OR IGNORE INTO loop_watches(observer, neighbor, first_at) VALUES(?, ?, ?)').run(observer, neighbor.id, now.toISOString());
        const signal = store.db.query('SELECT at, health, ends_at FROM loop_signals WHERE loop_id=?').get(neighbor.id) as Signal | null;
        const watch = store.db.query('SELECT first_at FROM loop_watches WHERE observer=? AND neighbor=?').get(observer, neighbor.id) as { first_at: string };
        const judgment = judgeNeighbor({ neighbor, lastSeenAt: signal?.at ?? watch.first_at, now });
        const expired = !!signal?.ends_at && Date.parse(signal.ends_at) <= now.getTime();
        // A declared lease (ends_at in the future) outranks the heartbeat interval: a scheduled loop idle between
        // windows is not absent until its own declared end passes.
        const leased = !!signal?.ends_at && !expired;
        const absent = expired || signal?.health === 'degraded' || (!leased && judgment.state === 'absent');
        if (!absent) { store.db.exec('COMMIT'); continue; }
        const reason = expired ? 'end-expired' : signal?.health === 'degraded' ? 'degraded' : judgment.reason;
        const signalAt = signal?.at ?? watch.first_at;
        const { action, delegateTo: to } = neighbor.onAbsent;
        const inserted = store.db.query(`INSERT OR IGNORE INTO loop_incidents(observer, neighbor, signal_at, reason, action, recipient, at)
          VALUES(?, ?, ?, ?, ?, ?, ?)`).run(observer, neighbor.id, signalAt, reason, action, to, now.toISOString());
        if (inserted.changes) {
          const incident: NeighborIncident = { observer, neighbor: neighbor.id, state: 'absent', reason, action, to,
            at: now.toISOString(), lastSeenAt: signal?.at ?? null };
          store.append({ from: observer, to, kind: `neighbor-${action}`,
            body: `[${observer} → ${to}] ${neighbor.id} ${reason}: ${action}` });
          incidents.push(incident);
        }
        store.db.exec('COMMIT');
      } catch (error) {
        try { store.db.exec('ROLLBACK'); } catch { /* no open transaction */ }
        debug.log('loop.neighbors', 'check-failed', { observer, neighbor: neighbor.id, error: String(error) }, { level: 'warn' });
      }
    }
    for (const incident of incidents) debug.log('loop.neighbors', 'absent', incident, { level: 'warn' });
    return incidents;
  });
}
