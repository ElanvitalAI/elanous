// RESOURCE-OPT-STEWARD — the seat-idle event (SIM-STEWARD-AB-1125 FU 7): a seat's TUI that ends a turn writes one small file
// `seat-idle.<SEAT>` ({seat, since}) next to the resource-opt trigger; the HQ TUI watches the folder (fs events, no
// polling) and hands the event to the scheduler, which runs the steward once the seat has been idle 5 min. A seat that is
// busy again by then is simply not idle in the table (the steward reads the live pane state). Fail-open both ways.
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SEAT_IDLE_PREFIX = 'seat-idle.';
/** One seat writes at most this often (a burst of short turns is one event). */
export const SEAT_IDLE_WRITE_MIN_MS = 30_000;

const defaultDir = (): string => join(homedir(), 'elanous-hq', 'seat-state', 'OP', 'resource-opt');
const safeSeat = (seat: string): string | null => { const s = seat.trim().toUpperCase(); return /^[A-Z][A-Z0-9_-]{0,63}$/u.test(s) ? s : null; };

/** A writer for one seat (throttled). Returns false when nothing was written. */
export function createSeatIdleSignal(seat: string, opts: { dir?: string; now?: () => number } = {}): () => boolean {
  const name = safeSeat(seat);
  const now = opts.now ?? Date.now;
  let last = -Infinity;
  return () => {
    if (!name) return false;
    const t = now();
    if (t - last < SEAT_IDLE_WRITE_MIN_MS) return false;
    last = t;
    try {
      const dir = opts.dir ?? defaultDir();
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${SEAT_IDLE_PREFIX}${name}.${process.pid}.tmp`);
      writeFileSync(tmp, `${JSON.stringify({ seat: name, since: t })}\n`);
      renameSync(tmp, join(dir, `${SEAT_IDLE_PREFIX}${name}`));
      return true;
    } catch { return false; }
  };
}

/** Parse one event file's name ⊕ content. */
export function readSeatIdleEvent(dir: string, fileName: string): { seat: string; since: number } | null {
  if (!fileName.startsWith(SEAT_IDLE_PREFIX)) return null;
  const seat = safeSeat(fileName.slice(SEAT_IDLE_PREFIX.length));
  if (!seat) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, fileName), 'utf8')) as { since?: unknown };
    return { seat, since: typeof parsed.since === 'number' && Number.isFinite(parsed.since) ? parsed.since : Date.now() };
  } catch { return null; }
}

/** Watch for seat-idle events. Returns a stop function; an unwatchable folder → no-op. */
export function watchSeatIdle(onIdle: (seat: string, since: number) => void, dir: string = defaultDir()): () => void {
  try {
    mkdirSync(dir, { recursive: true });
    const watcher = watch(dir, (_event, name) => {
      const event = readSeatIdleEvent(dir, String(name ?? ''));
      if (event) { try { onIdle(event.seat, event.since); } catch { /* fail-open */ } }
    });
    (watcher as { unref?: () => void }).unref?.();
    return () => { try { watcher.close(); } catch { /* already closed */ } };
  } catch { return () => {}; }
}
