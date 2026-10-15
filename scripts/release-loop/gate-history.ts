#!/usr/bin/env bun
/**
 * GATE-FAIL-HISTORY (0.2.29 칸) — 판을 넘어 보는 게이트 실패 표.
 *
 * 판 게이트 결과는 지금 런마다 `graph-runs/release-loop/<id>.json`(·`<인스턴스>/release/<판>/gate-verdict.json`)에만
 * 남는다 — «어느 시험이 자주 깨지나 · 어떤 PR 종류가 회귀를 내나»를 판을 넘어 보는 표가 없다(10-14 0.2.28 회귀
 * 35 를 예측 못 함). 이 모듈이 그 표를 읽기 전용으로 만든다:
 *
 *   elanous release gate-history [--since <판|YYYY-MM-DD>] [--top N] [--json]
 *
 * ① 원장 — `<root>/graph-runs/{release-loop,light-rc}/*.json` 의 gate 노드 출력(판정 원본) ⊕
 *    `<ledgerRoot>/release/<판>/gate-verdict.json`(id 정본)을 판마다 합친다.
 * ② 집계 — 시험 파일별 introduced · preexisting · env(knownEnv) · flaky(loadFlaky) 횟수 · 마지막 실패 판 ·
 *    원인 PR(수리 PR 본문의 «원인 #N»).
 * ③ 감시 목록 — 최근 3판 중 2판 이상 introduced/flaky 인 파일(`release/light-rc-always.txt` 에 자동 추가 가능).
 * ④ 못 읽음 — 파싱이 안 되는 원장은 세지 않고 «못 읽음 n» 으로만 표시한다(조용히 넘기지 않는다).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { testFileOfId } from './gate-partial.js';
import { isReleaseVersion } from './release-version.js';

/** A run ledger per loop (`<instanceRoot>/graph-runs/<graph>/`). light-rc runs land under their own graph when run as one. */
export const GATE_HISTORY_GRAPHS = ['release-loop', 'light-rc'] as const;
/** A gate-verdict file per version (`<ledgerRoot>/release/<version>/`). */
export const gateVerdictPath = (ledgerRoot: string, version: string) => join(ledgerRoot, 'release', version, 'gate-verdict.json');

export type GateBucket = 'introduced' | 'preexisting' | 'knownEnv' | 'loadFlaky';
export const GATE_BUCKETS: readonly GateBucket[] = ['introduced', 'preexisting', 'knownEnv', 'loadFlaky'];
/** Row file for failures a ledger could only count, not name — bare preexisting/knownEnv counts without verdict ids. */
export const UNATTRIBUTED_FILE = '(파일 미상)';

/** One gate run as the ledgers tell it: the run ledger gives the run (id · started · outcome), the verdict file the full ids. */
export interface GateRunRecord {
  runId: string;
  version: string;
  graph: string;
  startedAt: string | null;
  outcome: string | null;
  /** Failure ids per bucket (union over this version's records when merged). */
  buckets: Partial<Record<GateBucket, string[]>>;
  /** A bucket the records could only count, not name by id (preexisting/knownEnv from a gate node output). */
  unattributed: Partial<Record<GateBucket, number>>;
}

export interface GateHistoryRow {
  file: string;
  introduced: number;
  preexisting: number;
  env: number;
  flaky: number;
  lastFailVersion: string | null;
  /** Cause PR numbers referenced from repair PR bodies («원인 #N») for the versions this file failed in. */
  causePrs: number[];
}

export interface GateHistoryReport {
  versions: string[];
  runs: number;
  /** Gate runs that ended in error even when no failure id was available. */
  errorRuns: number;
  unreadable: number;
  rows: GateHistoryRow[];
  watchList: string[];
  /** Cause PRs per version (repair PR body «원인 #N») — the same numbers the rows cite. */
  causePrsByVersion: Record<string, number[]>;
}

export interface GateHistoryMergedPr { number: number; title: string; body: string; mergedAt: string }

export interface GateHistoryDeps {
  readFile?: (path: string) => string | undefined;
  listDir?: (dir: string) => string[];
  /** Merged PRs whose bodies may carry «원인 #N» cause references; default = `gh pr list` in this checkout. */
  mergedPrs?: () => GateHistoryMergedPr[];
}

const defaultReadFile = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
const defaultListDir = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

/** Same order the release CLI sorts versions by (core semver first, then alpha < beta < rc < final). */
export function compareGateVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core, pre] = version.split('-');
    const [major, minor, patch] = core!.split('.').map(Number);
    const [stage, sequence] = pre?.split('.') ?? [];
    return [major!, minor!, patch!, stage === undefined ? 3 : ({ alpha: 0, beta: 1, rc: 2 } as Record<string, number>)[stage]!, Number(sequence ?? 0)];
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}

/** `원인 #N` cause PR numbers in a repair PR body (unique, in order of appearance). */
export function causePrNumbersOf(body: string): number[] {
  return [...new Set([...body.matchAll(/원인\s*#(\d+)/g)].map((match) => Number(match[1])).filter((n) => Number.isSafeInteger(n) && n > 0))];
}

/** A bucket value as the ledgers give it: an id array (named) or a bare count (unattributed). */
const idListOrCount = (value: unknown): { ids?: string[]; count?: number } => {
  if (Array.isArray(value)) {
    // An array names the bucket (even empty): a bare count never comes from a list.
    return { ids: value.filter((id): id is string => typeof id === 'string' && id.includes(' > ')) };
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? { count: value } : {};
};

/** The gate node outputs of one run ledger, whatever graph wrote it — tolerant of the output being a JSON string or an object. */
export function gateOutputsOfLedger(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const nodes = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const outputs: Array<Record<string, unknown>> = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const { nodeId, output } = node as { nodeId?: unknown; output?: unknown };
    if (nodeId !== 'gate') continue;
    if (typeof output !== 'string') {
      if (output && typeof output === 'object' && !Array.isArray(output)) outputs.push(output as Record<string, unknown>);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(output);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) outputs.push(parsed as Record<string, unknown>);
    } catch { /* an unreadable gate output makes the ledger unreadable, not the whole history */ }
  }
  return outputs;
}

/** A gate node exists in this ledger (its output may still be unreadable). */
export function hasGateNode(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const nodes = (raw as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) && nodes.some((node) => !!node && typeof node === 'object' && (node as { nodeId?: unknown }).nodeId === 'gate');
}

/** One record per ledger file (graph run) and per verdict file, with the version's buckets merged onto the run. */
export function readGateHistoryRecords(instanceRoots: readonly string[], ledgerRoots: readonly string[], deps: GateHistoryDeps = {}, since?: string): { records: GateRunRecord[]; unreadable: number } {
  const readFile = deps.readFile ?? defaultReadFile;
  const listDir = deps.listDir ?? defaultListDir;
  const records: GateRunRecord[] = [];
  const excludedCommits = new Set<string>();
  const verdictCandidates: Array<{ record: GateRunRecord; commits: string[] }> = [];
  const commitRuns = new Map<string, number>();
  let unreadable = 0;
  for (const graph of GATE_HISTORY_GRAPHS) {
    for (const root of instanceRoots) {
      const dir = join(root, 'graph-runs', graph);
      for (const name of listDir(dir)) {
        if (!name.endsWith('.json')) continue;
        const text = readFile(join(dir, name));
        if (text === undefined) { unreadable++; continue; }
        let raw: unknown;
        try { raw = JSON.parse(text); } catch { unreadable++; continue; }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { unreadable++; continue; }
        const run = raw as { input?: { version?: unknown }; startedAt?: unknown };
        const version = run.input?.version;
        if (typeof version !== 'string' || !isReleaseVersion(version)) { unreadable++; continue; }
        // A run that never reached the gate node says nothing about gate history (not unreadable, not a record).
        if (!hasGateNode(raw)) continue;
        // Select the terminal node before parsing. A corrupt final output must not revive an
        // earlier, superseded gate result just because that earlier output was readable.
        const finalGate = (raw as { nodes: unknown[] }).nodes.filter((node) => !!node && typeof node === 'object'
          && (node as { nodeId?: unknown }).nodeId === 'gate').at(-1);
        const output = gateOutputsOfLedger({ nodes: [finalGate] })[0];
        const hasBucket = output && GATE_BUCKETS.some((bucket) => {
          const value = idListOrCount(output[bucket]);
          return value.ids !== undefined || value.count !== undefined;
        });
        if (!output || !['ok', 'regression', 'error'].includes(String(output.outcome))
          || (!hasBucket && output.outcome !== 'error')) {
          unreadable++;
          continue;
        }
        // Record excluded commits before joining a version-wide verdict, even if traversal sees the included run first.
        const startedAt = typeof run.startedAt === 'string' ? run.startedAt : null;
        const commits = typeof output.commit === 'string' ? [output.commit] : [];
        if (since && !passesSince(version, startedAt, since)) {
          for (const commit of commits) excludedCommits.add(`${version}:${commit}`);
          continue;
        }
        const buckets: Partial<Record<GateBucket, string[]>> = {};
        const unattributed: Partial<Record<GateBucket, number>> = {};
        const outcome = typeof output.outcome === 'string' ? output.outcome : null;
        for (const bucket of GATE_BUCKETS) {
          const { ids, count } = idListOrCount(output[bucket]);
          if (ids) buckets[bucket] = [...new Set(ids)];
          else if (count !== undefined) unattributed[bucket] = count;
        }
        const record: GateRunRecord = {
          runId: name.replace(/\.json$/, ''), version, graph,
          startedAt,
          outcome, buckets, unattributed,
        };
        verdictCandidates.push({ record, commits });
        for (const commit of commits) {
          const key = `${version}:${commit}`;
          commitRuns.set(key, (commitRuns.get(key) ?? 0) + 1);
        }
        records.push(record);
      }
    }
  }
  // A verdict has a commit but no run identity. Join it only when one included run has that commit;
  // an excluded run or a same-commit retry makes ownership ambiguous, so keep bare counts unknown.
  for (const { record, commits } of verdictCandidates) {
    const { version, buckets, unattributed } = record;
    for (const ledgerRoot of ledgerRoots) {
      const verdictText = readFile(gateVerdictPath(ledgerRoot, version));
      if (verdictText === undefined) continue;
      try {
        const verdict = JSON.parse(verdictText) as Record<string, unknown>;
        if (verdict.version !== version || typeof verdict.commit !== 'string'
          || !commits.includes(verdict.commit) || excludedCommits.has(`${version}:${verdict.commit}`)
          || commitRuns.get(`${version}:${verdict.commit}`) !== 1) continue;
        for (const bucket of GATE_BUCKETS) {
          const { ids } = idListOrCount(verdict[bucket]);
          if (ids) buckets[bucket] = [...new Set([...(buckets[bucket] ?? []), ...ids])];
        }
      } catch { /* a damaged verdict file leaves the run ledger's own reading as is */ }
    }
  }
  return { records, unreadable };
}

/** Repair PRs («원인 #N» in the body) merged while `version` was the open gate — after its first run, before the next version's. */
export function causePrsByVersion(versions: readonly string[], firstRunAt: Record<string, string | null>, mergedPrs: readonly GateHistoryMergedPr[]): Record<string, number[]> {
  const byVersion: Record<string, number[]> = {};
  const sorted = [...versions].sort(compareGateVersions);
  for (const [index, version] of sorted.entries()) {
    const started = firstRunAt[version] ? Date.parse(firstRunAt[version]!) : Number.NaN;
    const next = sorted[index + 1];
    const nextStart = next && firstRunAt[next] ? Date.parse(firstRunAt[next]!) : Number.POSITIVE_INFINITY;
    const prs = new Set<number>();
    for (const pr of mergedPrs) {
      if (!Number.isFinite(started)) continue;
      const merged = Date.parse(pr.mergedAt);
      if (!Number.isFinite(merged) || merged < started || merged >= nextStart) continue;
      for (const n of causePrNumbersOf(pr.body)) prs.add(n);
    }
    byVersion[version] = [...prs].sort((a, b) => a - b);
  }
  return byVersion;
}

function calendarDay(day: string): number | null {
  const value = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === day ? value : null;
}

function sinceFilter(since: string): { day: number | null; version: boolean } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    const day = calendarDay(since);
    if (day === null) throw new Error(`--since 는 실제 날짜여야 한다: ${since}`);
    return { day, version: false };
  }
  if (!isReleaseVersion(since)) throw new Error(`--since 는 판(x.y.z) 또는 YYYY-MM-DD 이다: ${since}`);
  return { day: null, version: true };
}

function runStartMs(startedAt: string | null): number | null {
  if (!startedAt) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(startedAt);
  if (!match || calendarDay(match[1]!) === null) return null;
  const at = Date.parse(startedAt);
  return Number.isFinite(at) ? at : null;
}

/** `--since <판|YYYY-MM-DD>`: a version keeps from that version on; a date keeps runs started at or after it. */
export function passesSince(version: string, startedAt: string | null, since: string): boolean {
  const filter = sinceFilter(since);
  if (!filter.version) {
    const at = runStartMs(startedAt);
    return at !== null && at >= filter.day!;
  }
  return compareGateVersions(version, since) >= 0;
}

/** The report: per-file bucket counts over the versions seen (ids deduped per version, so retries never double-count). */
export function gateHistory(o: { instanceRoots: readonly string[]; ledgerRoots: readonly string[]; since?: string; watchWindow?: number; watchHits?: number }, deps: GateHistoryDeps = {}): GateHistoryReport {
  if (o.since !== undefined) sinceFilter(o.since);
  const { records: kept, unreadable } = readGateHistoryRecords(o.instanceRoots, o.ledgerRoots, deps, o.since);
  const versions = [...new Set(kept.map(({ version }) => version))].sort(compareGateVersions);
  // One bucket list per version: a version's retries and light-rc runs are the same failures, counted once.
  const idsByVersion = new Map<string, Partial<Record<GateBucket, Set<string>>>>();
  // A run's own named IDs explain only that run's bare count. Keep the largest unexplained
  // remainder per version; IDs from a different run or commit cannot explain it.
  const bareByVersion = new Map<string, Partial<Record<GateBucket, number>>>();
  const firstRunAt: Record<string, string | null> = {};
  for (const record of kept) {
    const buckets = idsByVersion.get(record.version) ?? {};
    for (const bucket of GATE_BUCKETS) (buckets[bucket] ??= new Set());
    for (const [bucket, ids] of Object.entries(record.buckets) as Array<[GateBucket, string[]]>) for (const id of ids) buckets[bucket]!.add(id);
    idsByVersion.set(record.version, buckets);
    const bare = bareByVersion.get(record.version) ?? {};
    for (const [bucket, count] of Object.entries(record.unattributed) as Array<[GateBucket, number]>) {
      const unexplained = Math.max(0, count - new Set(record.buckets[bucket] ?? []).size);
      bare[bucket] = Math.max(bare[bucket] ?? 0, unexplained);
    }
    bareByVersion.set(record.version, bare);
    const prior = firstRunAt[record.version];
    if (record.startedAt && (!prior || record.startedAt < prior)) firstRunAt[record.version] = record.startedAt;
    else if (!(record.version in firstRunAt)) firstRunAt[record.version] = record.startedAt;
  }
  const mergedPrs = deps.mergedPrs ? safeMergedPrs(deps.mergedPrs) : [];
  const cause = mergedPrs.length ? causePrsByVersion(versions, firstRunAt, mergedPrs) : Object.fromEntries(versions.map((version) => [version, []])) as Record<string, number[]>;
  const rows = new Map<string, GateHistoryRow>();
  const lastFail = new Map<string, string>();
  for (const version of versions) {
    const buckets = idsByVersion.get(version) ?? {};
    // These counts were reconciled within each run above; never subtract version-wide IDs again.
    const bare: Partial<Record<GateBucket, number>> = { ...bareByVersion.get(version) ?? {} };
    const perFileBuckets = new Map<string, Partial<Record<GateBucket, number>>>();
    for (const bucket of GATE_BUCKETS) {
      for (const id of buckets[bucket] ?? []) {
        let file: string;
        try { file = testFileOfId(id); } catch { continue; }
        const counts = perFileBuckets.get(file) ?? {};
        counts[bucket] = 1; // One hit per (version, bucket, file), regardless of failures or retries.
        perFileBuckets.set(file, counts);
      }
    }
    // Each (version, file) is one hit. A regression outranks a flaky retry, then a known
    // preexisting failure, then an environment-known failure.
    const bucketPriority: readonly GateBucket[] = ['introduced', 'loadFlaky', 'preexisting', 'knownEnv'];
    for (const counts of perFileBuckets.values()) {
      const winner = bucketPriority.find((bucket) => (counts[bucket] ?? 0) > 0);
      for (const bucket of GATE_BUCKETS) if (bucket !== winner) delete counts[bucket];
    }
    for (const [file, counts] of perFileBuckets) {
      if (!lastFail.has(file) || compareGateVersions(version, lastFail.get(file)!) >= 0) lastFail.set(file, version);
      const row = rows.get(file) ?? { file, introduced: 0, preexisting: 0, env: 0, flaky: 0, lastFailVersion: null, causePrs: [] };
      row.introduced += counts.introduced ?? 0;
      row.preexisting += counts.preexisting ?? 0;
      row.env += counts.knownEnv ?? 0;
      row.flaky += counts.loadFlaky ?? 0;
      row.lastFailVersion = lastFail.get(file) ?? row.lastFailVersion;
      if ((counts.introduced ?? 0) > 0 || (counts.loadFlaky ?? 0) > 0) row.causePrs = [...new Set([...row.causePrs, ...cause[version] ?? []])];
      rows.set(file, row);
    }
    // The bare counts no verdict named still happened — one unnamed row carries them instead of silently dropping them from the table.
    if (Object.values(bare).some((count) => (count ?? 0) > 0)) {
      if (!lastFail.has(UNATTRIBUTED_FILE) || compareGateVersions(version, lastFail.get(UNATTRIBUTED_FILE)!) >= 0) lastFail.set(UNATTRIBUTED_FILE, version);
      const row = rows.get(UNATTRIBUTED_FILE) ?? { file: UNATTRIBUTED_FILE, introduced: 0, preexisting: 0, env: 0, flaky: 0, lastFailVersion: null, causePrs: [] };
      row.introduced += bare.introduced ?? 0;
      row.preexisting += bare.preexisting ?? 0;
      row.env += bare.knownEnv ?? 0;
      row.flaky += bare.loadFlaky ?? 0;
      if ((bare.introduced ?? 0) > 0 || (bare.loadFlaky ?? 0) > 0) row.causePrs = [...new Set([...row.causePrs, ...cause[version] ?? []])];
      rows.set(UNATTRIBUTED_FILE, row);
    }
  }
  for (const row of rows.values()) row.lastFailVersion = lastFail.get(row.file) ?? null;
  const watchWindow = o.watchWindow ?? 3;
  const watchHits = o.watchHits ?? 2;
  const recent = versions.slice(-watchWindow);
  const watchCounts = new Map<string, number>();
  for (const version of recent) {
    const buckets = idsByVersion.get(version) ?? {};
    const files = new Set<string>();
    for (const id of [...buckets.introduced ?? [], ...buckets.loadFlaky ?? []]) {
      try { files.add(testFileOfId(id)); } catch { /* an id the plan cannot carry names no file */ }
    }
    for (const file of files) watchCounts.set(file, (watchCounts.get(file) ?? 0) + 1);
  }
  const watchList = [...watchCounts].filter(([, hits]) => hits >= watchHits).map(([file]) => file).sort();
  const ordered = [...rows.values()].sort((a, b) => (b.introduced + b.flaky + b.preexisting + b.env) - (a.introduced + a.flaky + a.preexisting + a.env) || a.file.localeCompare(b.file));
  return { versions, runs: kept.length, errorRuns: kept.filter((record) => record.outcome === 'error').length,
    unreadable, rows: ordered, watchList, causePrsByVersion: cause };
}

function safeMergedPrs(fn: () => GateHistoryMergedPr[]): GateHistoryMergedPr[] {
  try {
    return fn().filter((pr) => pr && typeof pr.number === 'number' && typeof pr.body === 'string' && typeof pr.mergedAt === 'string');
  } catch { return []; }
}

/** Idempotent watch-list apply: only lines the list does not have yet are added, comments and existing order untouched. */
export function applyWatchList(text: string, files: readonly string[]): { text: string; added: string[] } {
  const existing = new Set(text.split('\n').map((line) => line.replace(/#.*/, '').trim()).filter(Boolean));
  const added = files.filter((file) => {
    if (existing.has(file)) return false;
    existing.add(file);
    return true;
  });
  if (!added.length) return { text, added };
  const lines = text.split('\n');
  while (lines.length && lines.at(-1) === '') lines.pop();
  const next = [...lines, ...(lines.length && lines.at(-1) !== '' ? [''] : []), ...added.map((file) => `${file}`), ''].join('\n');
  return { text: `${next}`, added };
}

/** Merged PRs whose bodies may name a cause PR — best-effort `gh pr list`; an unavailable gh yields none (never blocks the report). */
export function ghMergedPrs(cwd = process.cwd()): GateHistoryMergedPr[] {
  const run = spawnSync('gh', ['pr', 'list', '--state', 'merged', '--limit', '100', '--json', 'number,title,body,mergedAt'],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0 || !run.stdout) return [];
  const parsed: unknown = JSON.parse(run.stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((pr): pr is GateHistoryMergedPr => !!pr && typeof pr === 'object'
    && typeof (pr as { number?: unknown }).number === 'number' && typeof (pr as { body?: unknown }).body === 'string'
    && typeof (pr as { mergedAt?: unknown }).mergedAt === 'string');
}

/** People lines for the CLI (the --json path carries the report object as is). */
export function formatGateHistory(report: GateHistoryReport, top?: number): string[] {
  const lines: string[] = [];
  lines.push(`판 ${report.versions.length} · 게이트 런 ${report.runs} · 오류 ${report.errorRuns} · 못 읽음 ${report.unreadable}${report.versions.length ? ` · ${report.versions[0]} ~ ${report.versions.at(-1)}` : ''}`);
  const shown = top !== undefined && top >= 0 ? report.rows.slice(0, top) : report.rows;
  if (!report.rows.length && report.errorRuns > 0) lines.push(`게이트 오류 ${report.errorRuns}런 · 실패 ID 없음`);
  else if (!report.rows.length && report.unreadable > 0) lines.push(`읽은 원장에 실패 ID가 없다 · 못 읽은 원장 ${report.unreadable}건`);
  else if (!report.rows.length) lines.push('읽은 원장에 게이트 실패가 없다');
  else if (!shown.length) lines.push(`상위 제한으로 실패 행 ${report.rows.length}개 생략`);
  for (const row of shown) {
    const cause = row.causePrs.length ? ` · 원인 ${row.causePrs.map((n) => `#${n}`).join(' ')}` : '';
    lines.push(`${row.file} · 새 ${row.introduced} · 기존 ${row.preexisting} · 환경 ${row.env} · 흔들림 ${row.flaky} · 마지막 실패 ${row.lastFailVersion ?? '-'}${cause}`);
  }
  if (report.watchList.length) lines.push(`감시 목록(최근 ${report.versions.slice(-3).length}판 중 2판 이상 새 실패·흔들림): ${report.watchList.join(' · ')}`);
  else lines.push('감시 목록: 없음');
  return lines;
}
