import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecretText } from '../debug/log.js';
import { refuseProductionLedgerWriteInTest } from './ledger-write-guard.js';

export interface RunExit {
  runId: string;
  reason: string;
  status: number | null;
  signal: string | null;
  at: string;
  entrance?: string;
  seat?: string;
  cwd?: string;
  hostname?: string;
  pid?: number;
  lastLines?: string[];
}

export interface IncidentBurst {
  reason: string;
  count: number;
  firstAt: string;
  lastAt: string;
  runIds: string[];
  entrance?: string;
  seat?: string;
  hostname?: string;
}

/** Scrub before bounding: a token crossing the 200-character boundary must not leak. */
export function incidentLastLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-3)
    .map((line) => redactSecretText(line).slice(0, 200));
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
      rows.push({ runId: row.runId, reason: row.reason, status: row.status, signal: row.signal, at: row.at,
        ...(typeof row.entrance === 'string' ? { entrance: row.entrance } : {}),
        ...(typeof row.seat === 'string' ? { seat: row.seat } : {}),
        ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
        ...(typeof row.hostname === 'string' ? { hostname: row.hostname } : {}),
        ...(typeof row.pid === 'number' && Number.isSafeInteger(row.pid) ? { pid: row.pid } : {}),
        ...(Array.isArray(row.lastLines) && row.lastLines.every((line) => typeof line === 'string')
          ? { lastLines: row.lastLines } : {}),
      });
    }
  }
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.runId.localeCompare(b.runId));
}

/** SQLite's process-owned write lock serializes ledger checks and appends across processes. */
export function recordRunExit(row: RunExit, root: string): void {
  if (refuseProductionLedgerWriteInTest(root, 'incidents')) return;
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
        const safeRow = row.lastLines === undefined ? row : {
          ...row, lastLines: row.lastLines.slice(-3).map((line) => redactSecretText(line).slice(0, 200)),
        };
        appendFileSync(join(dir, `${kstDate(at)}.jsonl`), `${JSON.stringify(safeRow)}\n`);
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

const HOSTNAME_BURST_WINDOW_MS = 60 * 60_000;

function uniqueRunExits(rows: readonly RunExit[]): RunExit[] {
  const unique: RunExit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.runId || seen.has(row.runId) || !Number.isFinite(Date.parse(row.at))) continue;
    seen.add(row.runId);
    unique.push(row);
  }
  return unique;
}

function groupRunExits(rows: readonly RunExit[], keyOf: (row: RunExit) => string): RunExit[][] {
  const byIdentity = new Map<string, RunExit[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = byIdentity.get(key) ?? [];
    group.push(row);
    byIdentity.set(key, group);
  }
  return [...byIdentity.values()];
}

function burstMemberWindows(group: RunExit[], windowMs: number, threshold: number): RunExit[][] {
  const sorted = group.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.runId.localeCompare(b.runId));
  const windows: RunExit[][] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && Date.parse(sorted[end]!.at) - Date.parse(sorted[start]!.at) <= windowMs) end++;
    if (end - start < threshold) { start++; continue; }
    windows.push(sorted.slice(start, end));
    start = end;
  }
  return windows;
}

function burstFromMembers(members: RunExit[], extra: Pick<IncidentBurst, 'seat' | 'entrance' | 'hostname'>): IncidentBurst {
  return {
    reason: members[0]!.reason, count: members.length, firstAt: members[0]!.at,
    lastAt: members[members.length - 1]!.at, runIds: members.map((row) => row.runId),
    ...(extra.seat ? { seat: extra.seat } : {}),
    ...(extra.entrance ? { entrance: extra.entrance } : {}),
    ...(extra.hostname ? { hostname: extra.hostname } : {}),
  };
}

/** Non-overlapping windows within each identity; seat and host are independent views of an exit. */
export function detectBursts(rows: readonly RunExit[], { windowMs = 60_000, threshold = 3 }: {
  windowMs?: number; threshold?: number;
} = {}): IncidentBurst[] {
  const unique = uniqueRunExits(rows);
  const bursts: IncidentBurst[] = [];
  for (const group of groupRunExits(unique, (row) => JSON.stringify([row.reason, row.seat ?? null, row.entrance ?? null]))) {
    const { seat, entrance } = group[0]!;
    for (const members of burstMemberWindows(group, windowMs, threshold)) {
      bursts.push(burstFromMembers(members, { ...(seat ? { seat } : {}), ...(entrance ? { entrance } : {}) }));
    }
  }
  for (const group of groupRunExits(unique.filter((row) => row.hostname), (row) => JSON.stringify([row.reason, row.hostname]))) {
    const hostname = group[0]!.hostname;
    for (const members of burstMemberWindows(group, HOSTNAME_BURST_WINDOW_MS, 3)) {
      bursts.push(burstFromMembers(members, { ...(hostname ? { hostname } : {}) }));
    }
  }
  return bursts.sort((a, b) => Date.parse(a.firstAt) - Date.parse(b.firstAt) || a.reason.localeCompare(b.reason));
}

export function recentBurst(root: string, now: Date | number, { lookbackMs = 15 * 60_000, seat, entrance }: {
  lookbackMs?: number; seat?: string; entrance?: string;
} = {}): IncidentBurst | null {
  const time = typeof now === 'number' ? now : now.getTime();
  const recent = detectBursts(readRunExits(root)).filter((burst) => {
    const last = Date.parse(burst.lastAt);
    return !burst.hostname && last <= time && last >= time - lookbackMs
      && burst.seat === seat && burst.entrance === entrance;
  });
  return recent.sort((a, b) => Date.parse(a.lastAt) - Date.parse(b.lastAt)).at(-1) ?? null;
}

export function formatIncidentBurstWarning(burst: IncidentBurst): string {
  const time = new Date(Date.parse(burst.lastAt) + KST_OFFSET_MS).toISOString().slice(11, 16);
  const owner = burst.seat || burst.entrance ? ` [seat=${burst.seat ?? '-'} entrance=${burst.entrance ?? '-'}]` : '';
  return `⚠ 최근 묶음 사고${owner}: ${burst.reason} ×${burst.count} (${time} KST) — 원인 확인 전 재발사는 중복·재사고 위험 · elanous harness incidents`;
}
