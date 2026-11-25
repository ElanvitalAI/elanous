// TUI-LONG-PASTE-SPIN — the off-loop half of the loop watchdog (see loop-watchdog.ts). Runs in a worker thread, so it
// keeps running while the TUI's main loop is wedged. It reads the heartbeat from shared memory; at 30 s without a beat
// it writes one diagnostic file and restarts the TUI in place with execve (same pid · same terminal · `--resume`).
// Nothing here imports the TUI: a wedged main thread must not be needed for any of it.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { execInPlace } from './exec-in-place.js';
import { judgeHardStall, LOOP_PHASES, SLOT_ARMED, SLOT_BEAT, SLOT_PHASE, stallRestartEnv } from './loop-watchdog.js';

export interface LoopWatchdogWorkerData {
  readonly shared: SharedArrayBuffer;
  readonly base: number;
  readonly limitMs: number;
  readonly diagDir: string;
  readonly pid: number;
  /** Probe interval (ms). */
  readonly checkMs?: number;
}

export interface LoopWatchdogRestartPlan { readonly argv: readonly string[]; readonly sessionId: string }

if (parentPort && workerData) {
  const data = workerData as LoopWatchdogWorkerData;
  const slots = new Int32Array(data.shared);
  let restart: LoopWatchdogRestartPlan | null = null;
  let fired = false;
  const recentPhases: string[] = [];
  parentPort.on('message', (message: { restart?: LoopWatchdogRestartPlan | null }) => {
    if ('restart' in message) restart = message.restart ?? null;
  });
  const timer = setInterval(() => {
    const phase = LOOP_PHASES[Atomics.load(slots, SLOT_PHASE)] ?? 'unknown';
    if (recentPhases.at(-1) !== phase) { recentPhases.push(phase); if (recentPhases.length > 12) recentPhases.shift(); }
    const verdict = judgeHardStall({ wallNow: Date.now(), base: data.base, beat: Atomics.load(slots, SLOT_BEAT), limitMs: data.limitMs });
    if (!verdict.stalled) { fired = false; return; }
    if (fired) return;
    fired = true;
    const armed = Atomics.load(slots, SLOT_ARMED) === 1;
    const gen = stallRestartEnv(process.env, Date.now());
    const willRestart = armed && restart !== null && gen.allowed;
    const diagnostic = {
      event: 'tui.loop-stall', kind: 'hard', at: new Date().toISOString(), pid: data.pid, stalledMs: verdict.stalledMs, phase,
      recentPhases: [...recentPhases], sessionId: (restart as LoopWatchdogRestartPlan | null)?.sessionId ?? null,
      restart: willRestart ? 'exec-resume' : !armed ? 'not-armed' : restart === null ? 'no-session' : 'generation-cap',
    };
    try {
      mkdirSync(data.diagDir, { recursive: true });
      writeFileSync(join(data.diagDir, `loop-stall-${data.pid}-${Date.now()}.json`), `${JSON.stringify(diagnostic, null, 2)}\n`);
      appendFileSync(join(data.diagDir, 'loop-stall.jsonl'), `${JSON.stringify(diagnostic)}\n`);
    } catch { /* the restart below must not depend on the disk */ }
    parentPort!.postMessage({ diagnostic });
    if (!willRestart) return;
    const failure = execInPlace(restart!.argv, gen.env);
    try { appendFileSync(join(data.diagDir, 'loop-stall.jsonl'), `${JSON.stringify({ event: 'tui.loop-stall', kind: 'restart-failed', pid: data.pid, failure })}\n`); } catch { /* fail-open */ }
  }, data.checkMs ?? 1_000);
  // Never unref this timer: it is the only thing keeping the watcher thread alive (the Worker handle is unref'd instead).
  void timer;
}
