// GATE-SPEED-P2 — measure one commit's gate wall clock without folding earlier attempts into retries.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJunitFileSeconds } from './gate-method.js';
import { resolveGateLogDir } from './gate-timing.js';

type TimedPod = { name: string; start: number; end: number; durationMs: number; root: boolean };
export interface GateWallAttempt {
  commit: string;
  records: number;
  roots: number;
  retries: number;
  wallMin: number;
  rootWallMin: number | null;
  retryTailMin: number | null;
  overhead: { medianMin: number | null; p90Min: number | null; unmeasuredRoots: number };
}
export interface GateWallReport {
  dir: string;
  targetMin: number;
  measured: boolean;
  commit: string | null;
  records: number;
  roots: number;
  retries: number;
  wallMin: number | null;
  wallSource: 'pod-records' | null;
  rootWallMin: number | null;
  retryTailMin: number | null;
  overhead: GateWallAttempt['overhead'];
  retryOnlyAttempts: number;
  attempts: GateWallAttempt[];
  shardsWallMin: number | null;
  disagree: boolean;
  unreadable: string[];
  /** ✓ only when every pod record was read; a slower verdict is already certain. */
  verdict: 'pass' | 'fail' | 'undetermined' | null;
  /** Why shards.json was not compared although present (it carries no attempt identity). */
  shardsSkipped: 'not-latest-attempt' | 'outside-attempt-window' | null;
}

const POD_JSON = /^pod-.+\.json$/;
const ROOT = /^pod-\d+\.json$/;
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
function spanMin(pods: TimedPod[]): number {
  return (Math.max(...pods.map((p) => p.end)) - Math.min(...pods.map((p) => p.start))) / 60_000;
}
function attempt(dir: string, commit: string, pods: TimedPod[]): GateWallAttempt {
  const roots = pods.filter((p) => p.root);
  const overhead: number[] = [];
  let unmeasuredRoots = 0;
  for (const pod of roots) {
    try {
      const xml = readFileSync(join(dir, pod.name.replace(/\.json$/, '.junit.xml')), 'utf8');
      const seconds = [...readJunitFileSeconds(xml).values()];
      if (!seconds.length) { unmeasuredRoots++; continue; }
      overhead.push((pod.durationMs - seconds.reduce((sum, s) => sum + s, 0) * 1000) / 60_000);
    } catch { unmeasuredRoots++; }
  }
  const wall = spanMin(pods);
  const rootWall = roots.length ? spanMin(roots) : null;
  const sorted = overhead.sort((a, b) => a - b);
  return {
    commit, records: pods.length, roots: roots.length, retries: pods.length - roots.length,
    wallMin: wall, rootWallMin: rootWall,
    retryTailMin: rootWall === null ? null : wall - rootWall,
    overhead: {
      medianMin: sorted.length ? median(sorted) : null,
      p90Min: sorted.length ? sorted[Math.ceil(sorted.length * 0.9) - 1]! : null,
      unmeasuredRoots,
    },
  };
}

const SHARDS_WINDOW_SLACK_MS = 5 * 60_000;
/**
 * shards.json is a snapshot of the latest attempt, not an archive of every commit, and has no attempt identity.
 * A row is attributed to the attempt only when its root id is one of the attempt's roots AND
 * a row starts inside the attempt's pod-record window (from 5 min before its first start to its last end) — a
 * previous attempt's snapshot reusing `pod-0` started earlier and is rejected. The end is free: a longer
 * snapshot is exactly the disagreement this report keeps.
 */
function shardsSpan(dir: string, rootNames: Set<string>, window: { start: number; end: number }): number | 'outside-attempt-window' | null {
  try {
    const file: unknown = JSON.parse(readFileSync(join(dir, 'shards.json'), 'utf8'));
    if (!file || typeof file !== 'object' || !('shards' in file) || !Array.isArray(file.shards)) return null;
    const rows = file.shards as unknown[];
    if (!rows.length) return null;
    const starts: number[] = [];
    const ends: number[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !('id' in row) || typeof row.id !== 'string'
        || !rootNames.has(`${row.id}.json`)) return null;
      const start = 'startedAt' in row && typeof row.startedAt === 'string' ? Date.parse(row.startedAt) : NaN;
      const end = 'endedAt' in row && typeof row.endedAt === 'string' ? Date.parse(row.endedAt) : NaN;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
      if (start < window.start - SHARDS_WINDOW_SLACK_MS || start > window.end) return 'outside-attempt-window';
      starts.push(start);
      ends.push(end);
    }
    if (Math.max(...ends) < Math.min(...starts)) return null;
    return (Math.max(...ends) - Math.min(...starts)) / 60_000;
  } catch { return null; }
}

export function gateWall(dir: string, opts: { commit?: string; targetMin?: number } = {}): GateWallReport {
  const targetMin = opts.targetMin ?? 30;
  if (!Number.isFinite(targetMin) || targetMin <= 0) throw new Error('target-min 은 양수여야 합니다');
  const groups = new Map<string, TimedPod[]>();
  const unreadable: string[] = [];
  const names = existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter((n) => POD_JSON.test(n)).sort() : [];
  for (const name of names) {
    try {
      const pod: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!pod || typeof pod !== 'object' || !('commit' in pod) || !('durationMs' in pod)
        || typeof pod.commit !== 'string' || !pod.commit.trim()
        || typeof pod.durationMs !== 'number' || !Number.isFinite(pod.durationMs) || pod.durationMs < 0) {
        unreadable.push(name); continue;
      }
      const end = statSync(join(dir, name)).mtimeMs;
      if (!Number.isFinite(end)) { unreadable.push(name); continue; }
      const group = groups.get(pod.commit) ?? [];
      group.push({ name, start: end - pod.durationMs, end, durationMs: pod.durationMs, root: ROOT.test(name) });
      groups.set(pod.commit, group);
    } catch { unreadable.push(name); }
  }
  const ordered = [...groups].sort((a, b) => Math.max(...b[1].map((p) => p.end)) - Math.max(...a[1].map((p) => p.end)));
  const matching = opts.commit === undefined ? ordered : ordered.filter(([commit]) => commit.startsWith(opts.commit!));
  if (opts.commit !== undefined && matching.length > 1) throw new Error(`모호한 커밋 앞자리: ${opts.commit}`);
  const chosen = matching.find(([, pods]) => pods.some((p) => p.root));
  const attempts = ordered.map(([commit, pods]) => attempt(dir, commit, pods));
  const selected = chosen && attempts.find((a) => a.commit === chosen[0]);
  // The snapshot has no commit field. Only the latest recorded attempt can own it; require its root row IDs too.
  const latest = chosen !== undefined && ordered[0]?.[0] === chosen[0];
  const span = chosen && latest
    ? shardsSpan(dir, new Set(chosen[1].filter((p) => p.root).map((p) => p.name)),
      { start: Math.min(...chosen[1].map((p) => p.start)), end: Math.max(...chosen[1].map((p) => p.end)) }) : null;
  const snapshot = typeof span === 'number' ? span : null;
  const shardsWallMin = snapshot;
  const hasShards = existsSync(join(dir, 'shards.json'));
  const shardsSkipped = !hasShards || !chosen ? null : !latest ? 'not-latest-attempt' as const : span === 'outside-attempt-window' ? span : null;
  const wallMin = selected?.wallMin ?? null;
  const verdict = wallMin === null ? null : wallMin > targetMin ? 'fail' as const : unreadable.length ? 'undetermined' as const : 'pass' as const;
  return {
    dir, targetMin, measured: selected !== undefined, commit: selected?.commit ?? null,
    records: selected?.records ?? 0, roots: selected?.roots ?? 0, retries: selected?.retries ?? 0,
    wallMin: selected?.wallMin ?? null, wallSource: selected ? 'pod-records' : null,
    rootWallMin: selected?.rootWallMin ?? null, retryTailMin: selected?.retryTailMin ?? null,
    overhead: selected?.overhead ?? { medianMin: null, p90Min: null, unmeasuredRoots: 0 },
    retryOnlyAttempts: attempts.filter((a) => a.roots === 0).length,
    attempts, shardsWallMin,
    disagree: snapshot !== null && chosen !== undefined && Math.abs(snapshot - spanMin(chosen[1])) > 5,
    unreadable, verdict, shardsSkipped,
  };
}

export function formatGateWall(report: GateWallReport): string {
  const number = (value: number | null) => value === null ? '못 잼' : `${value.toFixed(1)}분`;
  if (!report.measured) return `게이트 벽시계 못 잼 · 목표 ≤${report.targetMin}분 판정 못 잼 · 루트 못 잼 · 재시도 꼬리 못 잼 · 조각 준비 중앙 못 잼`;
  return [
    `게이트 벽시계 ${number(report.wallMin)}(pod-records · 커밋 ${report.commit!.slice(0, 8)}) · 목표 ≤${report.targetMin}분 ${report.verdict === 'pass' ? '✓' : report.verdict === 'fail' ? '✗' : `판정 보류(못 읽은 기록 ${report.unreadable.length})`} · 루트 ${number(report.rootWallMin)} · 재시도 꼬리 ${number(report.retryTailMin)} · 조각 준비 중앙 ${number(report.overhead.medianMin)}`,
    `커밋 ${report.commit} · 기록 ${report.records} · 루트 ${report.roots} · 재시도 ${report.retries} · 루트 없는 시도 ${report.retryOnlyAttempts} · 준비 p90 ${number(report.overhead.p90Min)} · 준비 못 잰 루트 ${report.overhead.unmeasuredRoots}`,
    ...(report.shardsWallMin === null ? [] : [`shards.json 벽시계 ${number(report.shardsWallMin)} · 기록 추정 ${number(report.wallMin)}${report.disagree ? ' · ⚠ 5분 초과 불일치' : ''}`]),
    ...(report.shardsSkipped ? [`shards.json 대조 생략 — 이 시도의 것인지 확인 못 함(${report.shardsSkipped})`] : []),
    ...(report.unreadable.length ? [`⚠ 못 읽은 기록 ${report.unreadable.length}: ${report.unreadable.slice(0, 3).join(', ')}`] : []),
  ].join('\n');
}

export const GATE_WALL_USAGE = '사용법: bun scripts/release-loop/gate-wall.ts <version|dir> [--commit <sha>] [--target-min <n>] [--json]';

if (import.meta.main) {
  const args = process.argv.slice(2);
  let target: string | undefined;
  let commit: string | undefined;
  let targetMin: number | undefined;
  let json = false;
  let error: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--commit' || arg === '--target-min') {
      const value = args[++i];
      if (!value || value.startsWith('-')) { error = `값이 없는 옵션: ${arg}`; break; }
      if (arg === '--commit') commit = value;
      else {
        targetMin = Number(value);
        if (!Number.isFinite(targetMin) || targetMin <= 0) { error = `잘못된 목표 분: ${value}`; break; }
      }
      continue;
    }
    if (arg.startsWith('-')) { error = `알 수 없는 옵션: ${arg}`; break; }
    if (target) { error = `예상치 못한 인자: ${arg}`; break; }
    target = arg;
  }
  if (error || !target) { console.error(`${error ?? '대상 경로 또는 버전이 필요합니다'}\n${GATE_WALL_USAGE}`); process.exit(2); }
  try {
    const report = gateWall(resolveGateLogDir(target), { commit, targetMin });
    console.log(json ? JSON.stringify(report, null, 2) : formatGateWall(report));
    if (!report.measured) process.exitCode = 1;
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${GATE_WALL_USAGE}`);
    process.exitCode = 2;
  }
}
