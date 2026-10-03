import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface RunExit {
  runId: string;
  reason: string;
  status: number | null;
  signal: string | null;
  at: string;
}

export interface IncidentBurst {
  reason: string;
  count: number;
  firstAt: string;
  lastAt: string;
  runIds: string[];
}

const KST_OFFSET_MS = 9 * 60 * 60_000;
const INCIDENT_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function kstDate(at: number): string {
  return new Date(at + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Read only recorded exits. Missing ledgers are not evidence that no runs failed. */
export function readRunExits(root: string): RunExit[] {
  const dir = join(root, 'incidents');
  if (!existsSync(dir)) return [];
  const rows: RunExit[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => INCIDENT_FILE.test(name)).sort()) {
    const path = join(dir, file);
    let text: string;
    try {
      if (!statSync(path).isFile()) continue;
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (!value || typeof value !== 'object') continue;
      const row = value as Partial<RunExit>;
      if (typeof row.runId !== 'string' || !row.runId.trim() || seen.has(row.runId)
        || typeof row.reason !== 'string' || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))
        || !(row.status === null || typeof row.status === 'number')
        || !(row.signal === null || typeof row.signal === 'string')) continue;
      seen.add(row.runId);
      rows.push(row as RunExit);
    }
  }
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.runId.localeCompare(b.runId));
}

/** SQLite's process-owned write lock serializes ledger checks and appends across processes. */
export function recordRunExit(row: RunExit, root: string): void {
  if (!row.runId?.trim()) return;
  const at = Date.parse(row.at);
  if (!Number.isFinite(at)) throw new Error('invalid incident exit time');
  const dir = join(root, 'incidents');
  mkdirSync(dir, { recursive: true });
  const lock = new Database(join(root, '.incident-write-lock.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout = 60000');
    lock.exec('BEGIN IMMEDIATE');
    try {
      if (!readRunExits(root).some((record) => record.runId === row.runId)) {
        appendFileSync(join(dir, `${kstDate(at)}.jsonl`), `${JSON.stringify(row)}\n`);
      }
      lock.exec('COMMIT');
    } catch (error) {
      lock.exec('ROLLBACK');
      throw error;
    }
  } finally {
    lock.close();
  }
}

/** Non-overlapping, maximal same-reason windows; no run contributes to two bursts. */
export function detectBursts(rows: readonly RunExit[], { windowMs = 60_000, threshold = 3 }: {
  windowMs?: number; threshold?: number;
} = {}): IncidentBurst[] {
  const bursts: IncidentBurst[] = [];
  const byReason = new Map<string, RunExit[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.runId || seen.has(row.runId) || !Number.isFinite(Date.parse(row.at))) continue;
    seen.add(row.runId);
    const group = byReason.get(row.reason) ?? [];
    group.push(row);
    byReason.set(row.reason, group);
  }
  for (const [reason, group] of byReason) {
    group.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.runId.localeCompare(b.runId));
    for (let start = 0; start < group.length;) {
      let end = start + 1;
      while (end < group.length && Date.parse(group[end]!.at) - Date.parse(group[start]!.at) <= windowMs) end++;
      if (end - start < threshold) { start++; continue; }
      const members = group.slice(start, end);
      bursts.push({ reason, count: members.length, firstAt: members[0]!.at,
        lastAt: members[members.length - 1]!.at, runIds: members.map((row) => row.runId) });
      start = end;
    }
  }
  return bursts.sort((a, b) => Date.parse(a.firstAt) - Date.parse(b.firstAt) || a.reason.localeCompare(b.reason));
}

export function recentBurst(root: string, now: Date | number, { lookbackMs = 15 * 60_000 }: {
  lookbackMs?: number;
} = {}): IncidentBurst | null {
  const time = typeof now === 'number' ? now : now.getTime();
  const recent = detectBursts(readRunExits(root)).filter((burst) => {
    const last = Date.parse(burst.lastAt);
    return last <= time && last >= time - lookbackMs;
  });
  return recent.sort((a, b) => Date.parse(a.lastAt) - Date.parse(b.lastAt)).at(-1) ?? null;
}

export function formatIncidentBurstWarning(burst: IncidentBurst): string {
  const time = new Date(Date.parse(burst.lastAt) + KST_OFFSET_MS).toISOString().slice(11, 16);
  return `⚠ 최근 묶음 사고: ${burst.reason} ×${burst.count} (${time} KST) — 원인 확인 전 재발사는 중복·재사고 위험 · elanous harness incidents`;
}
