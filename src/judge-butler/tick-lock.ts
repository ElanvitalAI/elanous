// BUTLER-TICK-CADENCE — one tick at a time. The trigger (state-changed ⊕ ≤10 min) and a person's `eln loop butler tick`
// (or a stopgap loop) used to run side by side: 11-27 23:26Z two ticks judged the same cells 4 s apart and every second
// sign was refused «판정 중 칸 변경» (noise, and doubled gh/ssh reads). The lock is a file created with O_EXCL in the
// butler's home; a lock older than STALE_MS (a crashed tick) or whose pid is gone is taken over.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const TICK_LOCK_STALE_MS = 15 * 60_000;

export interface LockHeld { readonly held: true; readonly pid: number; readonly at: string }
export interface LockTaken { readonly held: false; release(): void }

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export function acquireTickLock(home: string, now = new Date(), opts: { pid?: number; isAlive?: (pid: number) => boolean; staleMs?: number } = {}): LockHeld | LockTaken {
  const path = join(home, 'tick.lock');
  const pid = opts.pid ?? process.pid; const isAlive = opts.isAlive ?? alive; const staleMs = opts.staleMs ?? TICK_LOCK_STALE_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify({ pid, at: now.toISOString() })); } finally { closeSync(fd); }
      return { held: false, release: () => { try { const j = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number }; if (j.pid === pid) rmSync(path, { force: true }); } catch { /* gone */ } } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let cur: { pid?: number; at?: string } = {};
      try { cur = JSON.parse(readFileSync(path, 'utf8')) as typeof cur; } catch { /* torn: treat as stale */ }
      const age = now.getTime() - Date.parse(cur.at ?? '');
      const stale = !Number.isFinite(age) || age > staleMs || !cur.pid || !isAlive(cur.pid);
      if (!stale) return { held: true, pid: cur.pid!, at: cur.at! };
      rmSync(path, { force: true });
    }
  }
  return { held: true, pid: -1, at: now.toISOString() };
}
