import { debug } from '../debug/log.js';

export interface BootTimer {
  begin(): void;
  phase(name: string): void;
  done(): void;
}

export function createBootTimer(now: () => number = performance.now): BootTimer {
  const startedAt = now();
  let phaseStartedAt = startedAt;
  let lastPhase: string | undefined;
  let slowest: { phase: string; ms: number } | undefined;
  let completed = false;

  return {
    begin(): void {
      phaseStartedAt = now();
    },
    phase(name: string): void {
      const current = now();
      const ms = current - phaseStartedAt;
      phaseStartedAt = current;
      lastPhase = name;
      if (!slowest || ms > slowest.ms) slowest = { phase: name, ms };
      try { debug.log('tui.boot', 'phase', { phase: name, ms }); } catch { /* logging must not block startup */ }
    },
    done(): void {
      if (completed) return;
      completed = true;
      const totalMs = now() - startedAt;
      try { debug.log('tui.boot', 'summary', { totalMs, slowest: slowest ?? (lastPhase ? { phase: lastPhase, ms: totalMs } : null) }); } catch { /* logging must not block startup */ }
    },
  };
}
