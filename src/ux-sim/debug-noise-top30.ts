/** Isolated 24-hour replay through the production debug logger and an actual logs.db sink. */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { LogDietGuard } from '../debug/log-diet.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';

export interface DebugNoiseObservation {
  top30: Array<{ key: string; count: number }>;
  rowCount: number;
  payloadBytes: number;
  logsDbBytes: number;
  protectedCounts: Record<string, number>;
}

const PROTECTED = [
  ['pod-lease', 'admit-by-usage'],
  ['observe', 'state-changed'],
  ['self-heal', 'failure'],
  ['hitl', 'awaiting'],
  ['failure', 'critical'],
] as const;

/** The caller's debug singleton, sinks, and guard never see the synthetic input. */
export function replayDebugNoise24h(diet: boolean): DebugNoiseObservation {
  const root = mkdtempSync(join(tmpdir(), 'debug-noise-top30-'));
  try {
    const child = spawnSync(process.execPath,
      [fileURLToPath(import.meta.url), '--isolated-replay', diet ? 'diet' : 'baseline'], {
        cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
        env: { ...process.env, MSS_STDERR_SINK: '0', MSS_OTEL_ENDPOINT: '' },
      });
    if (child.error || child.status !== 0)
      throw new Error(`debug-noise replay child failed: ${child.error?.message ?? child.stderr}`);
    return JSON.parse(child.stdout) as DebugNoiseObservation;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Same deterministic input for both paths, inside a fresh process and temporary cwd. */
function runIsolatedReplay(diet: boolean): DebugNoiseObservation {
  const root = process.cwd();
  const path = join(root, 'logs.db');
  const store = new LogStore(path, { instance: 'debug-noise-sim' });
  const sink = new StoreSink(store, 'debug-noise-sim', { installExitHandlers: false });
  let time = 0;
  debug.setFileEnabled(false);
  debug.setMirror(false);
  debug.setDiagEnabled(true); // keep the production log() path open for the isolated StoreSink
  debug.setLogDietGuard(diet ? new LogDietGuard({ now: () => time }) : null);
  const unregister = debug.registerSink(sink);
  try {
    for (let hour = 0; hour < 24; hour++) {
      for (let repeat = 0; repeat < 30; repeat++) {
        time = hour * 3_600_000 + repeat * 1_000;
        debug.log('tox.loop', 'tick', { runId: 'debug-noise-sim', state: 'waiting' });
      }
      for (const [category, event] of PROTECTED)
        debug.log(category, event, { runId: 'debug-noise-sim', hour }, { level: category === 'failure' ? 'error' : 'debug' });
    }
    debug.drainLogDietPending();
    sink.flush();
    const rows = store.queryAll({ surfaces: ['debug-noise-sim'] });
    const counts = new Map<string, number>();
    let payloadBytes = 0;
    for (const row of rows) {
      const key = `${row.category}/${row.event}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      payloadBytes += Buffer.byteLength(row.data ?? '', 'utf8');
    }
    const protectedCounts = Object.fromEntries(PROTECTED.map(([category, event]) => {
      const key = `${category}/${event}`;
      return [key, counts.get(key) ?? 0];
    }));
    // In WAL mode the live database grows in both files until checkpoint; count both.
    const logsDbBytes = statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
    sink.close();
    store.close();
    return {
      top30: [...counts].map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, 30),
      rowCount: rows.length, payloadBytes, logsDbBytes, protectedCounts,
    };
  } finally {
    unregister();
    try { sink.close(); } catch { /* cleanup */ }
    try { store.close(); } catch { /* cleanup */ }
  }
}

if (import.meta.main && process.argv[2] === '--isolated-replay') {
  process.stdout.write(JSON.stringify(runIsolatedReplay(process.argv[3] === 'diet')));
}
