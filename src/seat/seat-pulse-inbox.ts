// OP-PULSE inbox consumer — the OP TUI opens the pulse graph's brief as ONE internal turn (origin `pulse`).
// Not a mail (no unread/ack churn) and not a ScheduleWakeup (the wake cap never coalesces it): the graph's turn node
// writes seat-state/OP/pulse/inbox.json; this watcher offers it to the same H2 gate every 15 s until the gate opens a
// turn, then records the id in inbox.consumed so the same pulse never opens twice (a newer pulse replaces an unread one).
//
// 세 얼굴: 관측 = debug 'tui.pulse' offered/opened/refused · inbox.consumed · 판단 근거 = inbox id ≠ consumed id ·
//          수복과 인계 = a refused offer (busy · person typing) retries on the next poll; the registry's goal deadline
//          (beat mails within 20 min) cards OP's owner when the turn never happened.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../chat/internal-turn-contract.js';
import { readPulseInbox } from '../loops/op-pulse.js';

export const PULSE_INBOX_POLL_MS = 15_000;

export interface PulseInboxDeps {
  inboxPath: string;
  consumedPath: string;
  startTurnIfIdle: (text: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  intervalMs?: number;
  notify?: (line: string) => void;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface PulseInboxWatcher { poll(): boolean; start(): void; dispose(): void }

const readConsumed = (path: string): string | null => { try { return existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null; } catch { return null; } };

export function createPulseInboxWatcher(deps: PulseInboxDeps): PulseInboxWatcher {
  let timer: unknown = null;
  let disposed = false;
  const log = deps.log ?? (() => {});
  const poll = (): boolean => {
    const req = readPulseInbox(deps.inboxPath);
    if (!req || readConsumed(deps.consumedPath) === req.id) return false;
    const result = deps.startTurnIfIdle(req.body, { origin: 'pulse', reason: `pulse ${req.window}`, ownLimit: true });
    if (!result.opened) { log('refused', { id: req.id, reason: result.reason }); return false; }
    mkdirSync(dirname(deps.consumedPath), { recursive: true });
    writeFileSync(deps.consumedPath, `${req.id}\n`);
    log('opened', { id: req.id, turnId: result.turnId });
    deps.notify?.(`⏰ OP pulse ${req.window}`);
    return true;
  };
  const tick = () => { if (disposed) return; try { poll(); } catch (e) { log('error', { error: String(e) }); } timer = deps.setTimer(tick, deps.intervalMs ?? PULSE_INBOX_POLL_MS); };
  return {
    poll,
    start() { if (!timer && !disposed) timer = deps.setTimer(tick, deps.intervalMs ?? PULSE_INBOX_POLL_MS); },
    dispose() { disposed = true; if (timer) deps.clearTimer(timer); timer = null; },
  };
}
