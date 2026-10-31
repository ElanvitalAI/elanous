import { existsSync } from 'node:fs';
import { LogStore, logsDbPath, type LogStoreRow } from '../mss/logging/log-store.js';
import type { TaskCaptureArtifact } from './types.js';

export interface LinearCaptureEventWindow { runId: string; startedAt: number; endedAt: number }
export type LinearCaptureEventStore = Pick<LogStore, 'queryByDataKeys' | 'close'>;

function parseCaptureEvent(row: LogStoreRow, expectedRunId: string): TaskCaptureArtifact | undefined {
  if (row.event !== 'executed' || !row.data) return undefined;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    data = parsed as Record<string, unknown>;
  } catch { return undefined; }
  if (data.action !== 'read' || data.mode !== 'screenshot' || data.ok !== true || data.captureOutcome !== 'saved') return undefined;
  const capture = data.capture;
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return undefined;
  const descriptor = capture as Record<string, unknown>;
  if (typeof descriptor.path !== 'string' || !descriptor.path || typeof descriptor.mimeType !== 'string' ||
      descriptor.runId !== expectedRunId || typeof descriptor.linearIssueId !== 'string' || !descriptor.linearIssueId ||
      descriptor.externalShare !== true || typeof descriptor.sensitivity !== 'string' ||
      typeof descriptor.createdAt !== 'number' || !Number.isFinite(descriptor.createdAt)) return undefined;
  return {
    path: descriptor.path,
    mimeType: descriptor.mimeType,
    runId: expectedRunId,
    linearIssueId: descriptor.linearIssueId,
    externalShare: true,
    sensitivity: descriptor.sensitivity,
    createdAt: descriptor.createdAt,
  };
}

/** Read only approved browser screenshot events emitted during this exact TOX execution. */
export function collectLinearCaptureArtifacts(window: LinearCaptureEventWindow, deps: {
  dbPath?: string;
  openStore?: (path: string) => LinearCaptureEventStore;
} = {}): TaskCaptureArtifact[] {
  const runId = window.runId.trim();
  if (!runId || !Number.isFinite(window.startedAt) || !Number.isFinite(window.endedAt) || window.endedAt < window.startedAt) return [];
  const path = deps.dbPath ?? logsDbPath();
  if (!existsSync(path)) return [];
  const store = (deps.openStore ?? LogStore.openReadOnly)(path);
  try {
    const rows = store.queryByDataKeys({ exactCategories: ['harness.browser-action'], runIds: [runId] });
    const found = new Map<string, TaskCaptureArtifact>();
    for (const row of rows) {
      if (row.ts_ms < window.startedAt || row.ts_ms > window.endedAt) continue;
      const capture = parseCaptureEvent(row, runId);
      if (capture) found.set(capture.path, capture);
    }
    return [...found.values()].sort((a, b) => a.createdAt - b.createdAt || a.path.localeCompare(b.path));
  } finally { store.close(); }
}
