import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import type { SelfDevRunState } from './run-store.js';

export function mirrorDir(): string {
  return join(releaseLedgerRoot(), 'self-dev-runs');
}

function mirrorPath(runId: string, dir: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)) throw new Error(`invalid self-dev run ID: ${runId}`);
  return join(dir, `${runId}.json`);
}

/** Best-effort atomic copy in the machine ledger; never disrupts the primary checkpoint. */
export function mirrorRunRecord(state: SelfDevRunState, primaryDir: string): void {
  let temp: string | undefined;
  try {
    const dir = mirrorDir();
    if (resolve(primaryDir) === resolve(dir)) return;
    const path = mirrorPath(state.runId, dir);
    mkdirSync(dir, { recursive: true });
    temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    if (temp) { try { unlinkSync(temp); } catch { /* no temporary file to remove */ } }
    try { debug.log('self-dev.run-store', 'mirror-failed', { runId: state.runId, reason: String(error) }); } catch { /* keep the primary save fail-soft */ }
  }
}

export function loadMirroredRunRecord(runId: string): SelfDevRunState | null {
  try {
    const record = JSON.parse(readFileSync(mirrorPath(runId, mirrorDir()), 'utf8')) as SelfDevRunState | null;
    return record && record.runId === runId
      && typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
      && typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      && Array.isArray(record.results) ? record : null;
  } catch {
    return null;
  }
}
