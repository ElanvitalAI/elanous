import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';

/** Plan weights for a Pod sweep: wall-scaled when the previous cut recorded shard wall times, junit seconds otherwise. */
export function planDurations(durationSource: string | undefined): { durations: Map<string, number>; wall?: { shards: number; scaledFiles: number }; fallback?: string } {
  if (!durationSource) return { durations: new Map() };
  const primary = planDurationsFrom(durationSource);
  if (primary.durations.size) return primary;
  // GATE-PLAN-TIMINGS: the baseline cut left no reports (0.2.20: baseline 0.2.19 was gated from another universe, so
  // all 5,585 files were «unknown», planned 3.9 min, measured 13–20 min). Use the most recent sibling cut instead.
  const fallback = latestSiblingCutDir(durationSource);
  if (!fallback) {
    debug.log('release-loop.gate', 'plan-duration-fallback', { source: durationSource, fallback: null });
    return primary;
  }
  const result = planDurationsFrom(fallback);
  debug.log('release-loop.gate', 'plan-duration-fallback', { source: durationSource, fallback, files: result.durations.size, wall: !!result.wall });
  return result.durations.size ? { ...result, fallback } : primary;
}

function planDurationsFrom(dir: string): { durations: Map<string, number>; wall?: { shards: number; scaledFiles: number } } {
  const junit = readFileDurations(dir);
  const wall = readFileWallWeights(dir, junit);
  return wall ? { durations: wall.weights, wall: { shards: wall.shards, scaledFiles: wall.scaledFiles } } : { durations: junit };
}

/**
 * For a `<root>/<version>/<a>/<b>` duration source (the gate passes `<ledger>/release/<baseline>/gate-logs/cut`), the
 * sibling `<root>/<other>/<a>/<b>` directory whose newest `*.junit.xml` is the most recent — «the latest gate». The
 * source itself is skipped. Undefined when the path is too shallow or no sibling holds a junit report.
 */
export function latestSiblingCutDir(durationSource: string): string | undefined {
  const source = resolve(durationSource);
  const b = basename(source);
  const a = basename(dirname(source));
  const root = dirname(dirname(dirname(source)));
  if (!a || !b || root === dirname(dirname(source))) return undefined;
  let versions: string[];
  try { versions = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch { return undefined; }
  let best: { dir: string; mtimeMs: number } | undefined;
  for (const version of versions.sort()) {
    const dir = join(root, version, a, b);
    if (dir === source) continue;
    let newest = -1;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.junit.xml')) continue;
        try { newest = Math.max(newest, statSync(join(dir, name)).mtimeMs); } catch { /* vanished mid-scan */ }
      }
    } catch { continue; }
    if (newest >= 0 && (!best || newest > best.mtimeMs)) best = { dir, mtimeMs: newest };
  }
  return best?.dir;
}

/** Observation for GATE-PLAN-WALLTIME, emitted once the shards are planned so `maxPlannedMin` is the heaviest shard. */
export function logPlanWalltime(wall: { shards: number; scaledFiles: number } | undefined, shards: ReadonlyArray<{ plannedSeconds: number }>): void {
  if (!wall) return;
  const maxPlannedSeconds = Math.max(0, ...shards.map((shard) => shard.plannedSeconds));
  debug.log('release-loop.gate', 'plan-walltime', { shards: wall.shards, scaledFiles: wall.scaledFiles, maxPlannedMin: Math.round(maxPlannedSeconds / 6) / 10 });
}

/** Read per-file seconds from previous cut Pod reports; missing or damaged reports are not estimates. */
export function readFileDurations(dir: string): Map<string, number> {
  const durations = new Map<string, number>();
  let names: string[];
  const entities: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  try { names = readdirSync(dir).filter((name) => name.endsWith('.junit.xml')).sort(); }
  catch { return durations; }
  for (const name of names) {
    try {
      const xml = readFileSync(join(dir, name), 'utf8');
      for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
        const attrs = match[1]!;
        const file = /\bfile="([^"]+)"/.exec(attrs)?.[1];
        const rawTime = /\btime="([^"]+)"/.exec(attrs)?.[1];
        if (!file || rawTime === undefined) continue;
        const seconds = Number(rawTime);
        if (!Number.isFinite(seconds) || seconds < 0) continue;
        const path = file.replace(/&(?:amp|quot|apos|lt|gt);/g, (entity) => entities[entity]!);
        durations.set(path, Math.max(durations.get(path) ?? 0, seconds));
      }
    } catch { /* One unreadable report must not discard the others. */ }
  }
  return durations;
}

/** Per-file peak memory (MB) from a TSV with `file` and `rss_mb` columns (TD1 whole-gate measurement); missing → empty. */
export function readFileMemory(path: string): Map<string, number> {
  const memory = new Map<string, number>();
  let lines: string[];
  try { lines = readFileSync(path, 'utf8').split(/\r?\n/); } catch { return memory; }
  const header = lines[0]?.split('\t') ?? [];
  const fileAt = header.indexOf('file');
  const rssAt = header.indexOf('rss_mb');
  if (fileAt < 0 || rssAt < 0) return memory;
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const mb = Number(cells[rssAt]);
    if (cells[fileAt] && cells[rssAt] !== '' && Number.isFinite(mb) && mb >= 0) memory.set(cells[fileAt]!, mb);
  }
  return memory;
}

/** Longest processing time first; tie-breaks use lexical paths, then the least populated lightest shard. */
export function planShards(files: string[], durations: Map<string, number>, count: number): Array<{ files: string[]; plannedSeconds: number }> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('invalid shard count');
  const known = files.map((file) => durations.get(file)).filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const median = known.length ? (known[Math.floor((known.length - 1) / 2)]! + known[Math.floor(known.length / 2)]!) / 2 : 1;
  const weight = (file: string) => {
    const value = durations.get(file);
    return value !== undefined && Number.isFinite(value) && value >= 0 ? value : median;
  };
  const shards = Array.from({ length: Math.min(count, files.length) }, () => ({ files: [] as string[], plannedSeconds: 0 }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    let lightest = shards[0]!;
    for (const shard of shards) if (shard.plannedSeconds < lightest.plannedSeconds
      || (shard.plannedSeconds === lightest.plannedSeconds && shard.files.length < lightest.files.length)) lightest = shard;
    lightest.files.push(file);
    lightest.plannedSeconds += weight(file);
  }
  return shards.filter((shard) => shard.files.length > 0);
}

/**
 * GATE-PLAN-WALLTIME: junit testsuite times run far below a shard's real wall time (0.2.18 pod-23: planned 2.7 min,
 * measured 33.3 min), so LPT balanced the wrong quantity. When the previous cut left `pod-*.json` records
 * (`durationMs` ⊕ `files`), each file's junit seconds are scaled so its shard's planned total equals the measured wall
 * time; files without junit take that shard's average per-file wall time. A file measured in several records takes
 * its first-pass shard (`pod-<n>.json` — the shape the next cut plans) over descent/retry children, whose per-Pod
 * install overhead lands on one or two files; among equals, the record with the fewest files.
 * Returns undefined when no usable record exists, so callers keep the junit-only behaviour.
 */
export function readFileWallWeights(dir: string, junit: Map<string, number>): { weights: Map<string, number>; shards: number; scaledFiles: number } | undefined {
  let names: string[];
  try { names = readdirSync(dir).filter((name) => /^pod-.*\.json$/.test(name)).sort(); }
  catch { return undefined; }
  const records: Array<{ wallSeconds: number; files: string[]; firstPass: boolean }> = [];
  for (const name of names) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { durationMs?: unknown; files?: unknown };
      if (typeof meta.durationMs !== 'number' || !Number.isFinite(meta.durationMs) || meta.durationMs <= 0) continue;
      if (!Array.isArray(meta.files) || !meta.files.length || !meta.files.every((file) => typeof file === 'string')) continue;
      records.push({ wallSeconds: meta.durationMs / 1000, files: [...new Set(meta.files as string[])], firstPass: /^pod-\d+\.json$/.test(name) });
    } catch { /* One damaged record must not discard the others. */ }
  }
  if (!records.length) return undefined;
  const valid = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
  const best = new Map<string, { rank: number; seconds: number }>();
  for (const record of records) {
    const unknownCount = record.files.filter((file) => !valid(junit.get(file))).length;
    const junitSum = record.files.reduce((sum, file) => { const value = junit.get(file); return sum + (valid(value) ? value : 0); }, 0);
    const average = record.wallSeconds / record.files.length;
    const remaining = record.wallSeconds - unknownCount * average;
    for (const file of record.files) {
      const seconds = junit.get(file);
      const weight = valid(seconds) && junitSum > 0 && remaining > 0 ? seconds * (remaining / junitSum) : average;
      const prior = best.get(file);
      const rank = (record.firstPass ? 0 : 1_000_000) + record.files.length;
      if (!prior || rank < prior.rank) best.set(file, { rank, seconds: weight });
    }
  }
  // Files timed by junit but absent from every record (new or renamed since the cut) take the overall scale, so the
  // plan never mixes wall seconds with raw junit seconds.
  let scaledSum = 0;
  let junitSum = 0;
  for (const [file, { seconds }] of best) { const value = junit.get(file); if (valid(value) && value > 0) { scaledSum += seconds; junitSum += value; } }
  const overall = junitSum > 0 ? scaledSum / junitSum : 1;
  const weights = new Map([...junit].map(([file, seconds]) => [file, seconds * overall] as [string, number]));
  for (const [file, { seconds }] of best) weights.set(file, seconds);
  return { weights, shards: records.length, scaledFiles: best.size };
}
