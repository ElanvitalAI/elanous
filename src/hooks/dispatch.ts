import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runSeatLoopOnce } from '../seat-loop/seat-loop.js';
import { getUserConfig } from '../user-config.js';
import { openMsgStore } from '../msg/msg-store.js';
import type { EventsConfig } from '../user-config.js';
import type { QueuedHook } from './queue.js';

export type HookWake = (seat: string) => Promise<unknown>;

// A crashed wake can be reclaimed after the lease expires; a live wake renews it until completion.
const WAKE_LEASE_MS = 120_000;
const DEFAULT_SEAT_ROUTES = [
  { source: 'linear', kind: 'Issue:update', seat: (event: QueuedHook, config: EventsConfig) =>
    event.task.assigneeId ? config.linearAssignees[event.task.assigneeId] : undefined },
  { source: 'github', kind: 'pull_request:review_requested', seat: 'TC' },
  { source: 'github', kind: 'check_run:completed', seat: 'TC' },
  { source: 'github', kind: 'check_suite:completed', seat: 'TC' },
] as const;

/** Record a work card and inbox delivery atomically. Wake state: 0 = retryable, 2 = leased, 1 = done, 3 = seat loop off (terminal).
 *  `events.mode` decides only whether the card is delivered; the wake runs the seat loop under its own `loops.seat` mode.
 *  So a delivered card with the seat loop off is not retried (the card waits in the inbox), and a shadow loop's wake is
 *  recorded as `wake_status = 'shadow'` — visible as «not executed», not mistaken for a real run. */
export async function dispatchHook(event: QueuedHook, root: string, config: EventsConfig,
  wake: HookWake = seat => runSeatLoopOnce(seat, { root, config: getUserConfig().loops?.seat ?? { mode: 'off' } }),
  now: () => number = Date.now): Promise<void> {
  const key = `${event.provider}:${event.eventId}`;
  const route = config.routes.find(candidate => candidate.source === event.provider && candidate.kind === event.kind);
  const defaultSeat = DEFAULT_SEAT_ROUTES.find(candidate => candidate.source === event.provider && candidate.kind === event.kind)?.seat;
  const defaultResolvedSeat = typeof defaultSeat === 'function' ? defaultSeat(event, config) : defaultSeat;
  if (event.provider === 'linear' && event.kind === 'Issue:update' && !route && !defaultResolvedSeat)
    throw new Error('Linear issue update assignee is not mapped to a seat');
  const seat = route?.seat ?? defaultResolvedSeat ?? 'OP';
  const store = openMsgStore(join(root, 'msg', 'messages.db'));
  const claim = randomUUID();
  try {
    store.db.exec(`CREATE TABLE IF NOT EXISTS hook_work_cards (
      event_key TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL,
      seat TEXT NOT NULL, loop TEXT NOT NULL, mode TEXT NOT NULL, title TEXT NOT NULL,
      message_id INTEGER, woken INTEGER NOT NULL DEFAULT 0,
      wake_claim TEXT, wake_lease_until INTEGER
    )`);
    const columns = store.db.query('PRAGMA table_info(hook_work_cards)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'wake_claim')) store.db.exec('ALTER TABLE hook_work_cards ADD COLUMN wake_claim TEXT');
    if (!columns.some(column => column.name === 'wake_lease_until')) store.db.exec('ALTER TABLE hook_work_cards ADD COLUMN wake_lease_until INTEGER');
    if (!columns.some(column => column.name === 'wake_status')) store.db.exec('ALTER TABLE hook_work_cards ADD COLUMN wake_status TEXT');
    store.db.transaction(() => {
      const existing = store.db.query('SELECT event_key FROM hook_work_cards WHERE event_key = ?').get(key);
      if (existing) return;
      const live = config.mode === 'on';
      let messageId: number | null = null;
      if (live) {
        const body = `[작업 카드 · ${key} · ${event.kind ?? 'unknown'} · loop: seat] ${event.task.title}\n${event.task.external.url ?? event.task.external.ref}`;
        messageId = store.append({ from: 'HOOKS', to: seat, kind: 'hook-task', body }).id;
      }
      store.db.query(`INSERT INTO hook_work_cards(event_key, source, kind, seat, loop, mode, title, message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(key, event.provider, event.kind ?? 'unknown', seat, route?.loop ?? 'seat', live ? 'on' : 'shadow', event.task.title, messageId);
    })();
    const leaseAt = now();
    const acquired = store.db.query(`UPDATE hook_work_cards SET woken = 2, wake_claim = ?, wake_lease_until = ?
      WHERE event_key = ? AND message_id IS NOT NULL
        AND (woken = 0 OR (woken = 2 AND (wake_lease_until IS NULL OR wake_lease_until <= ?)))`)
      .run(claim, leaseAt + WAKE_LEASE_MS, key, leaseAt).changes === 1;
    if (!acquired) return;
    const renew = () => store.db.query(`UPDATE hook_work_cards SET wake_lease_until = ?
      WHERE event_key = ? AND woken = 2 AND wake_claim = ?`).run(now() + WAKE_LEASE_MS, key, claim);
    const heartbeat = setInterval(renew, WAKE_LEASE_MS / 4);
    try {
      const result = await wake(seat);
      const status = result && typeof result === 'object' && 'status' in result && typeof result.status === 'string' ? result.status : 'woken';
      // Seat loop off is a policy, not a transient failure: keep the card in the inbox and stop retrying.
      const final = status === 'skipped-off' ? 3 : 1;
      store.db.query('UPDATE hook_work_cards SET woken = ?, wake_status = ?, wake_claim = NULL, wake_lease_until = NULL WHERE event_key = ? AND woken = 2 AND wake_claim = ?').run(final, status, key, claim);
      debug.log('hooks.dispatch', 'wake', { key, seat, status, retry: false });
    } catch (error) {
      store.db.query('UPDATE hook_work_cards SET woken = 0, wake_claim = NULL, wake_lease_until = NULL WHERE event_key = ? AND woken = 2 AND wake_claim = ?').run(key, claim);
      throw error;
    } finally { clearInterval(heartbeat); }
  } finally { store.close(); }
}
