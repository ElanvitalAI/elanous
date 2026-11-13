// Seat mail reaches next TUI through the shared H2 gate; no prompt is typed into a pane.
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { detectSeatTui } from '../dashboard/seat-boot-preamble.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../dashboard/input/internal-turn.js';
import { readUnreadSummary } from '../msg/msg-store.js';

export interface NextMailWakeDeps {
  startTurnIfIdle: (text: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  cwd?: string;
  home?: string;
  seat?: string | null;
  enabled?: boolean;
  readUnread?: (seat: string) => { count: number; maxId: number | null } | null;
  intervalMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface NextMailWake {
  poll(): void;
  pendingDeliveryAllowed(): boolean;
  withdrawPending(): void;
  confirmDelivery(): void;
  dispose(): void;
}

function regularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

export function createNextMailWake(deps: NextMailWakeDeps): NextMailWake {
  const home = deps.home ?? homedir();
  let seat = deps.seat ?? null;
  if (deps.seat === undefined) {
    try { seat = detectSeatTui(deps.cwd ?? process.cwd(), { home })?.seat ?? null; }
    catch (error) { debug.log('tui.msg-wake', 'detect-error', { error: String(error) }); }
  }
  const optedIn = (): boolean => deps.enabled ?? (seat !== null && (
    regularFile(join(home, 'elanous-hq', 'seat-state', seat, 'autowake'))
    || regularFile(join(home, 'elanous-hq', 'seats', seat, 'autowake'))
  ));
  const read = deps.readUnread ?? readUnreadSummary;
  const log = deps.log ?? ((event: string, data: Record<string, unknown>) => debug.log('tui.msg-wake', event, data));
  let lastOpenedId = 0;
  let pendingId = 0;
  let stopped = false;
  const poll = (): void => {
    // Consent is live state: deleting the file stops reads and turns; recreating it resumes polling.
    if (stopped || !seat || !optedIn()) return;
    let unread: { count: number; maxId: number | null } | null;
    try { unread = read(seat); }
    catch (error) { log('read-error', { seat, error: String(error) }); return; }
    if (!unread || unread.count <= 0 || !unread.maxId || unread.maxId <= lastOpenedId) return;
    const result = deps.startTurnIfIdle(
      `[우편 깨움] ${seat} 미읽음 ${unread.count}통 — eln msg list --to ${seat} 로 읽고 처리`,
      { origin: 'msg-wake', reason: `우편 ${unread.count}통` },
    );
    if (result.opened) {
      pendingId = unread.maxId;
      log('opened', { seat, maxId: pendingId, count: unread.count, turnId: result.turnId });
    } else log('deferred', { seat, maxId: unread.maxId, count: unread.count, reason: result.reason, detail: result.detail ?? null });
  };
  const timer = seat ? setInterval(poll, deps.intervalMs ?? 15_000) : null;
  timer?.unref?.();
  if (timer) queueMicrotask(poll);
  return {
    poll,
    pendingDeliveryAllowed() { return pendingId === 0 || optedIn(); },
    withdrawPending() { pendingId = 0; },
    confirmDelivery() { lastOpenedId = Math.max(lastOpenedId, pendingId); pendingId = 0; },
    dispose() { stopped = true; if (timer) clearInterval(timer); },
  };
}
