#!/usr/bin/env bun
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log.js';
import { devVersion, listChecklist, statusChangesSince } from '../src/release-loop/checklist.js';

interface Report { id: number | string; created_at: string; login: string; body: string }
interface Change { version: string; at: string; from: unknown; to: unknown }
interface Cell { id: string; reports: number; bySender: Record<string, number>; last: string | null; statusChanges: Change[] }
interface Digest { track: string; since: string; versions: string[]; cells: Cell[]; totals: { reports: number; cells: number; statusChanges: number } }

const NO_CELL = '칸 없음';
const registry = JSON.parse(readFileSync(join(import.meta.dir, 'coord-tracks.json'), 'utf8')) as { tracks: Array<{ id: string; alias?: string }> };
const recipients = new Set(['전원', ...registry.tracks.flatMap(({ id, alias }) => alias ? [id, alias] : [id])]);
const STATUS_ICON: Record<string, string> = { yellow: '🟡', green: '🟢', red: '🔴', done: '✅' };

function options(args: string[]): { track: string; hours: number; versions: string[]; json: boolean; explicitSince: boolean } {
  let track = '';
  let hours = 2;
  let json = false;
  let explicitSince = false;
  const versions: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--track' && args[i + 1]) track = args[++i]!;
    else if (arg === '--since' && args[i + 1]) {
      const match = /^(\d+(?:\.\d+)?)h$/.exec(args[++i]!);
      if (!match || Number(match[1]) <= 0) throw new Error('--since 는 양수 시간(예: 2h)이어야 한다');
      hours = Number(match[1]);
      explicitSince = true;
    } else if (arg === '--version' && args[i + 1]) versions.push(args[++i]!);
    else if (arg === '--json') json = true;
    else throw new Error(`모르는 인자: ${arg}`);
  }
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(track)) throw new Error('--track <ID> 가 필요하다');
  return { track, hours, versions: versions.length ? [...new Set(versions)] : [devVersion().replace(/-dev\.\d+$/, '')], json, explicitSince };
}

function reportCell(body: string): { id: string; sender: string } | null {
  const line = body.split(/\r?\n/, 1)[0] ?? '';
  const envelope = /^\s*(?:#+\s*)?\*\*\[([^\]]+)\]\*\*[^\n]*?→\s*(.+)$/.exec(line);
  if (!envelope) return null;
  const fields = envelope[2]!.split('·').map((part) => part.trim());
  if (!recipients.has(fields[0] ?? '') || fields[1] !== '보고') return null;
  const cell = fields[2];
  return { id: !cell || cell === '-' ? NO_CELL : cell, sender: envelope[1]! };
}

function readCursor(path: string): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string' || typeof id === 'number')) {
      throw new Error('invalid cursor ids');
    }
    return new Set(parsed.map(String));
  } catch (error) {
    const backup = `${path}.corrupt-${randomUUID()}`;
    writeFileSync(backup, raw, { mode: 0o600, flag: 'wx' });
    console.error(`${path}: 손상된 커서를 ${backup} 에 보존하고 빈 커서로 복구: ${error instanceof Error ? error.message : String(error)}`);
    return new Set();
  }
}

function saveCursor(path: string, seen: Set<string>): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify([...seen])}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Serialize digest runs per track: cursor read → count → cursor save happens under one lock (review round 2).
 *  A lock whose owner pid is gone, or older than 60 s, is taken over; otherwise wait up to 10 s, then fail. */
function withDigestLock<T>(root: string, track: string, fn: () => T): T {
  mkdirSync(root, { recursive: true });
  const path = join(root, `${track}-digest.lock`);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const owner = Number(readFileSync(path, 'utf8').trim());
        const age = Date.now() - statSync(path).mtimeMs;
        if (age > 60_000) stale = true;
        else if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') stale = true; }
        }
      } catch { stale = false; }
      if (stale) { try { unlinkSync(path); } catch { /* another run took it */ } continue; }
      if (Date.now() > deadline) throw new Error('다른 요약이 같은 자리에서 도는 중이다 — 잠시 뒤 다시');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try { return fn(); } finally { try { unlinkSync(path); } catch { /* already gone */ } }
}

function build(track: string, since: string, versions: string[], root: string, explicitSince: boolean): Digest {
  const cells = new Map<string, Cell>();
  const latest = new Map<string, number>();
  const cellFor = (id: string): Cell => {
    let cell = cells.get(id);
    if (!cell) {
      cell = { id, reports: 0, bySender: Object.create(null) as Record<string, number>, last: null, statusChanges: [] };
      cells.set(id, cell);
    }
    return cell;
  };
  const reportsPath = join(root, `${track}-reports.jsonl`);
  const cursorPath = join(root, `${track}-digest-cursor`);
  const seen = readCursor(cursorPath);
  const cutoff = Date.parse(since);
  const now = Date.now();
  let count = 0;
  const counted = new Set<string>();
  if (existsSync(reportsPath)) for (const [index, line] of readFileSync(reportsPath, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    let report: Report;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null ||
          !('id' in parsed) || (typeof parsed.id !== 'string' && typeof parsed.id !== 'number') ||
          !('created_at' in parsed) || typeof parsed.created_at !== 'string' ||
          !('login' in parsed) || typeof parsed.login !== 'string' ||
          !('body' in parsed) || typeof parsed.body !== 'string') throw new Error('invalid report fields');
      report = parsed as Report;
    } catch (error) {
      console.error(`${reportsPath}:${index + 1}: 잘못된 보고 줄 건너뜀: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const id = String(report.id);
    const at = Date.parse(report.created_at);
    if (!id || !Number.isFinite(at) || at < cutoff || at > now || counted.has(id) || (!explicitSince && seen.has(id))) continue;
    const envelope = reportCell(report.body);
    if (envelope === null) continue;
    const { id: cellId, sender } = envelope;
    seen.add(id);
    counted.add(id);
    const cell = cellFor(cellId);
    cell.reports++;
    cell.bySender[sender] = (cell.bySender[sender] ?? 0) + 1;
    const first = report.body.split(/\r?\n/, 1)[0] ?? '';
    if (at >= (latest.get(cellId) ?? -Infinity)) {
      cell.last = Array.from(first).slice(0, 80).join('');
      latest.set(cellId, at);
    }
    count++;
  }
  for (const version of versions) for (const entry of statusChangesSince(listChecklist(version).history, since)) {
    if (Date.parse(entry.at) > now) continue;
    cellFor(entry.id).statusChanges.push({ version, at: entry.at, from: entry.from, to: entry.to });
  }
  const output = [...cells.values()].map(({ id, reports, bySender, last, statusChanges }) => ({
    id, reports, bySender, last, statusChanges: statusChanges.sort((a, b) => a.at.localeCompare(b.at)),
  })).sort((a, b) => a.id.localeCompare(b.id, 'ko'));
  const totals = { reports: count, cells: output.length, statusChanges: output.filter((cell) => cell.statusChanges.length > 0).length };
  debug.log('coord.digest', 'built', { track, reports: count, cells: totals.cells, statusChanges: totals.statusChanges });
  mkdirSync(root, { recursive: true });
  saveCursor(cursorPath, seen);
  return { track, since, versions, cells: output, totals };
}

function text(digest: Digest): string {
  const lines = digest.cells.map((cell) => {
    const status = cell.statusChanges.map(({ from, to }) => `${STATUS_ICON[String(from)] ?? String(from)}→${STATUS_ICON[String(to)] ?? String(to)}`).join(', ') || '-';
    const senders = Object.entries(cell.bySender).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name} ${count}`).join(' · ');
    return `${cell.id} · ${status} · 보고 ${cell.reports}${senders ? `(${senders})` : ''} · 마지막: ${cell.last ?? '-'}`;
  });
  lines.push(`합계 · 글 ${digest.totals.reports} · 칸 ${digest.totals.cells} · 상태 바뀐 칸 ${digest.totals.statusChanges}`);
  return lines.join('\n');
}

if (import.meta.main) {
  try {
    const { track, hours, versions, json, explicitSince } = options(process.argv.slice(2));
    const root = join(process.env.HOME ?? homedir(), '.elanous', 'coord');
    const digest = withDigestLock(root, track, () => build(track, new Date(Date.now() - hours * 3_600_000).toISOString(), versions, root, explicitSince));
    console.log(json ? JSON.stringify(digest) : text(digest));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
