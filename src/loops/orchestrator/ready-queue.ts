import { appendFileSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLockSync } from '../../storage/file-lock.js';

export type ReadyPriority = 'P0' | 'P1' | 'P2';

/** Versioned contract between the coordinator (writer) and the resident dispatcher (reader). */
export interface PreparedTask {
  schemaVersion: 1;
  key: string;
  priority: ReadyPriority;
  seat: string;
  contract: {
    title: string;
    text: string;
    checklistId: string;
    sourceCardId: string;
    sourceRunId: string;
  };
  status: 'ready';
  createdAt: string;
}

export function preparedQueuePath(root: string): string {
  return join(root, 'loop', 'orchestrator', 'ready-queue.jsonl');
}

/** Only a genuinely absent queue is empty. Permission, resolution, and link failures must surface. */
function readQueueSourceIfPresent(path: string): string | undefined {
  let parent = dirname(path);
  for (;;) {
    let entry: ReturnType<typeof lstatSync> | undefined;
    try {
      entry = lstatSync(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (entry?.isSymbolicLink()) statSync(parent);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return readFileSync(path, 'utf8');
}

function validPreparedTask(value: unknown): value is PreparedTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<PreparedTask>;
  const contract = row.contract;
  // Source: schemaVersion 1 is the first persisted coordinator/dispatcher contract.
  return row.schemaVersion === 1 && typeof row.key === 'string' && row.key.length > 0
    && (row.priority === 'P0' || row.priority === 'P1' || row.priority === 'P2')
    && typeof row.seat === 'string' && row.seat.length > 0
    && !!contract && typeof contract === 'object'
    && typeof contract.title === 'string' && contract.title.length > 0
    && typeof contract.text === 'string' && contract.text.length > 0
    && typeof contract.checklistId === 'string' && contract.checklistId.length > 0
    && typeof contract.sourceCardId === 'string' && contract.sourceCardId.length > 0
    && typeof contract.sourceRunId === 'string' && contract.sourceRunId.length > 0
    && row.status === 'ready' && typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt));
}

/** A malformed row fails closed: silently skipping it could lose a coordinator decision. */
export function readPreparedTasks(root: string): PreparedTask[] {
  const path = preparedQueuePath(root);
  const source = readQueueSourceIfPresent(path);
  if (source === undefined) return [];
  const rows: PreparedTask[] = [];
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('invalid coordinator ready queue JSON'); }
    if (!validPreparedTask(value)) throw new Error('invalid coordinator ready queue contract');
    rows.push(value);
  }
  return rows;
}

/** Existing task keys are read even when TASK handoff is disabled, to suppress a second consumer. */
export function readPreparedTaskKeys(root: string): Set<string> {
  const path = preparedQueuePath(root);
  const source = readQueueSourceIfPresent(path);
  if (source === undefined) return new Set();
  const keys = new Set<string>();
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { key?: unknown };
      if (typeof value?.key === 'string' && value.key.length > 0) keys.add(value.key);
    } catch { /* strict validation belongs to the live dispatcher path */ }
  }
  return keys;
}

/** Immutable, idempotent enqueue. Dispatch status belongs to the dispatcher, not the coordinator. */
export function enqueuePreparedTask(root: string, task: PreparedTask): boolean {
  if (!validPreparedTask(task)) throw new Error('invalid prepared task');
  const path = preparedQueuePath(root);
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(`${path}.lock`, () => {
    if (readPreparedTasks(root).some(row => row.key === task.key)) return false;
    const existingSource = readQueueSourceIfPresent(path) ?? '';
    const separator = existingSource.length > 0 && !existingSource.endsWith('\n') ? '\n' : '';
    appendFileSync(path, `${separator}${JSON.stringify(task)}\n`);
    return true;
  });
}
