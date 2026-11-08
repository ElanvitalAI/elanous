import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { loadMirroredRunRecord } from './run-record-mirror.js';
import type { SelfDevRunState } from './run-store-contract.js';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const loggedAbsentCheckpoints = new Set<string>();

/** `<ELANOUS_STATE_DIR or ~/.elanous>/self-dev-runs`. */
export function selfDevRunsDir(stateDir?: string): string {
  return join(stateDir ?? elanousStateRoot(), 'self-dev-runs');
}

export function runPath(runId: string, dir: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`invalid self-dev run ID: ${runId}`);
  const root = resolve(dir);
  const path = resolve(root, `${runId}.json`);
  if (!path.startsWith(`${root}${sep}`)) throw new Error(`invalid self-dev run ID: ${runId}`);
  return path;
}

/** Read one checkpoint without loading the self-dev store's ledger aggregation code. */
export function loadSelfDevRunFromPath(path: string): SelfDevRunState | null {
  const runId = path.slice(path.lastIndexOf(sep) + 1, -'.json'.length);
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as SelfDevRunState | null;
    if (value && typeof value.runId === 'string' && Array.isArray(value.results)) return value;
    try { debug.log('self-dev.run-store', 'read-failed', { runId, reason: 'invalid checkpoint shape' }); } catch { /* preserve fail-soft reads */ }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (!loggedAbsentCheckpoints.has(runId)) {
        loggedAbsentCheckpoints.add(runId);
        try { debug.log('self-dev.run-store', 'checkpoint-absent', { runId }); } catch { /* preserve fail-soft reads */ }
      }
    } else {
      try { debug.log('self-dev.run-store', 'read-failed', { runId, reason: String(error) }); } catch { /* preserve fail-soft reads */ }
    }
  }
  return null;
}

/** Load a run checkpoint by id, or null if absent/corrupt. */
export function loadSelfDevRun(runId: string, dir = selfDevRunsDir()): SelfDevRunState | null {
  const primary = loadSelfDevRunFromPath(runPath(runId, dir));
  if (primary) return primary;
  const mirrored = loadMirroredRunRecord(runId);
  if (mirrored) {
    try { debug.log('self-dev.run-store', 'read-from-mirror', { runId }); } catch { /* preserve fail-soft reads */ }
  }
  return mirrored;
}
