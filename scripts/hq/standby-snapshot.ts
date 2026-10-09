#!/usr/bin/env bun
// HQ-REP — standby snapshots for the HQ move (mbp → node-b). OP design 10-04 08:33 (channel #23032):
//   ① canonical ledgers every 10 min · ② observation DBs every hour · ③ secrets host-to-host only · ④ runtime is not copied.
//   Never `cp` a live SQLite file: take `.backup` snapshots, number the generation, list sha256 for every file,
//   then rsync into `<host>:~/.elanous-standby/<tier>/<generation>/` (not the live folder) and move `latest` only
//   after the receiver verifies the checksums.
// Usage:
//   bun scripts/hq/standby-snapshot.ts --tier core|big|obs [--push <host>] [--survival <host>,s3://bucket/prefix] [--keep N] [--dry-run] [--json]
//   대표 10-04 08:4x: no whole-copy of big DBs every 10 minutes — core (≤20MB) every 10 min, big and obs four times a day,
//   and each push sends only changed blocks (`rsync --inplace` into `current/`, then a clone becomes the generation).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { debug } from '../../src/debug/log.js';

export type Tier = 'core' | 'big' | 'obs';
/** 대표 10-04 08:4x: only ledgers at or under this size go every 10 minutes; larger canonical DBs go four times a day. */
export const SMALL_LEDGER_BYTES = 20 * 1024 * 1024;
export interface PlanItem { rel: string; kind: 'sqlite' | 'file'; survival: boolean }
export interface ManifestEntry { path: string; bytes: number; sha256: string; kind: PlanItem['kind']; reused?: boolean }
export interface Manifest { generation: string; tier: Tier; createdAt: string; source: string; host: string; entries: ManifestEntry[] }

/** Secrets never leave the host pair through a survival copy (cloud-vm · bucket), whatever the tier. */
export function isSecretPath(rel: string): boolean {
  const lower = rel.toLowerCase();
  return /(^|\/)(secrets?|backup-key|acp-token)(\/|$|\.)/.test(lower)
    || /(^|\/)auth\.json/.test(lower)
    || /\.(p8|pem|key|env)$/.test(lower)
    || /(token|credential|password|session)[^/]*$/.test(lower);
}

// ① canonical — small, consistency matters. `survival` = also kept on cloud-vm and the ops bucket.
const CORE_FILES: Array<[string, boolean]> = [
  ['release/features.sqlite', true], ['schedules.db', true], ['tasks/tasks.db', false], ['directives/directives.db', true],
  ['scheduler/scheduler.db', false], ['task-cards/index.db', false], ['knowledge.db', false], ['memory/knowledge.db', false],
  ['config.json', false],
];
const CORE_DIRS: Array<[string, boolean]> = [
  ['decisions', true], ['budget', false], ['seat-loop', false], ['seat-requests', false], ['test-diet', false],
  ['consult-requests', false], ['outputs', false],
  // HQ drill round-trip marker (runbook «되돌리기»): one line written on the new HQ must come back to the old one.
  ['hq-drill', false],
];
// ② observation — large, append-only, losable.
const OBS_FILES = ['logs/logs.db', 'memory/surface_events.db'];

function walkFiles(root: string, dir: string): string[] {
  if (!existsSync(join(root, dir))) return [];
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name);
    const st = lstatSync(join(root, rel));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...walkFiles(root, rel));
    else if (st.isFile() && !/\.(tmp|lock)$|-wal$|-shm$|-journal$/.test(name)) out.push(rel);
  }
  return out;
}

const isSqlite = (rel: string) => /\.(db|sqlite|sqlite3)$/.test(rel);

export function planSnapshot(root: string, tier: Tier): PlanItem[] {
  const items: PlanItem[] = [];
  const add = (rel: string, survival: boolean) => {
    if (!existsSync(join(root, rel))) return;
    items.push({ rel, kind: isSqlite(rel) ? 'sqlite' : 'file', survival: survival && !isSecretPath(rel) });
  };
  if (tier === 'obs') { for (const rel of OBS_FILES) add(rel, false); return items; }
  for (const [rel, survival] of CORE_FILES) add(rel, survival);
  for (const [dir, survival] of CORE_DIRS) for (const rel of walkFiles(root, dir)) add(rel, survival);
  // Trading ledgers are canonical too (OP 08:4x) — FENCE keeps execution on one host only.
  for (const rel of walkFiles(root, 'conatus')) if (isSqlite(rel)) add(rel, false);
  // Release ledgers: per-version checklist and manifest only — gate logs are rebuildable and large.
  if (existsSync(join(root, 'release'))) {
    for (const version of readdirSync(join(root, 'release'))) {
      for (const name of ['checklist.json', 'manifest.json']) add(join('release', version, name), true);
    }
  }
  const sized = items.filter(item => !isSecretPath(item.rel) || !item.survival);
  const big = (item: PlanItem) => statSync(join(root, item.rel)).size > SMALL_LEDGER_BYTES;
  return tier === 'big' ? sized.filter(big) : sized.filter(item => !big(item));
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Consistent copy: SQLite through `VACUUM INTO` (never a live-file copy), other files byte-for-byte. */
export const SQLITE_SNAPSHOT_TIMEOUT_MS = 600_000;
/** Host-specific settings that must never ride a replicated `config.json` (OP 10-04 12:02 · drill step 5:
 *  mbp's `hq.hostName=mbp` reached node-b's promoted universe and made node-b call itself mbp). */
export const HOST_LOCAL_CONFIG_KEYS = ['hq'] as const;

/** `config.json` without the host-local blocks; unparsable text is copied as is (the copy must not fail on it). */
export function stripHostLocalConfig(text: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return text; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
  const obj = { ...(parsed as Record<string, unknown>) };
  let removed = false;
  for (const key of HOST_LOCAL_CONFIG_KEYS) if (key in obj) { delete obj[key]; removed = true; }
  return removed ? `${JSON.stringify(obj, null, 2)}\n` : text;
}

export function snapshotItem(root: string, out: string, item: PlanItem, sqlite3 = 'sqlite3'): void {
  const dest = join(out, item.rel);
  mkdirSync(dirname(dest), { recursive: true });
  if (item.kind === 'sqlite') {
    // `VACUUM INTO` copies one read transaction. The CLI `.backup` restarts from page 1 whenever another connection
    // writes the source — on a busy logs.db (written every second) it ran 85+ minutes without finishing (10-09 00:43 obs tier).
    rmSync(dest, { force: true });
    const r = spawnSync(sqlite3, [join(root, item.rel), `VACUUM INTO '${dest.replace(/'/g, "''")}'`], { encoding: 'utf8', timeout: SQLITE_SNAPSHOT_TIMEOUT_MS });
    if (r.status !== 0) throw new Error(`sqlite backup failed: ${item.rel}: ${(r.error ? String(r.error) : (r.stderr || '').trim()) || `rc=${r.status}`}`);
  } else if (item.rel === 'config.json') {
    const original = readFileSync(join(root, item.rel), 'utf8');
    const stripped = stripHostLocalConfig(original);
    if (stripped !== original) debug.log('hq.standby', 'config-host-local-stripped', { keys: [...HOST_LOCAL_CONFIG_KEYS] });
    writeFileSync(dest, stripped);
  } else cpSync(join(root, item.rel), dest);
}

export function generationId(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Build one generation in `out`. SQLite files whose source is unchanged since `previous` are reused (hard link target). */
export function buildGeneration(opts: { root: string; out: string; tier: Tier; previous?: Manifest | null; previousDir?: string; host?: string; now?: Date; sqlite3?: string }): Manifest {
  const { root, out, tier } = opts;
  mkdirSync(out, { recursive: true });
  const entries: ManifestEntry[] = [];
  const prev = new Map((opts.previous?.entries ?? []).map(e => [e.path, e]));
  const prevAt = opts.previous ? Date.parse(opts.previous.createdAt) : NaN;
  for (const item of planSnapshot(root, tier)) {
    const old = prev.get(item.rel);
    const mtime = statSync(join(root, item.rel)).mtimeMs;
    if (item.kind === 'sqlite' && old && opts.previousDir && Number.isFinite(prevAt) && mtime < prevAt && existsSync(join(opts.previousDir, item.rel))) {
      mkdirSync(dirname(join(out, item.rel)), { recursive: true });
      cpSync(join(opts.previousDir, item.rel), join(out, item.rel));
      entries.push({ ...old, reused: true });
      continue;
    }
    snapshotItem(root, out, item, opts.sqlite3);
    const dest = join(out, item.rel);
    entries.push({ path: item.rel, bytes: statSync(dest).size, sha256: sha256(dest), kind: item.kind });
  }
  const manifest: Manifest = { generation: generationId(opts.now), tier, createdAt: (opts.now ?? new Date()).toISOString(), source: root, host: opts.host ?? hostname().replace(/\.local$/, ''), entries };
  writeFileSync(join(out, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, 'SHA256SUMS'), entries.map(e => `${e.sha256}  ${e.path}`).join('\n') + '\n');
  return manifest;
}

/** Survival subset: what cloud-vm and the bucket get. Secrets are excluded by construction. */
export function survivalPaths(manifest: Manifest, root: string): string[] {
  const plan = new Map(planSnapshot(root, manifest.tier).map(i => [i.rel, i]));
  return manifest.entries.map(e => e.path).filter(p => plan.get(p)?.survival === true && !isSecretPath(p));
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Delta push: `rsync --inplace` into a fixed `current/` (only changed blocks travel), verify, then clone it to `<gen>/`. */
function pushToHost(host: string, local: string, tier: Tier, gen: string, keep: number): void {
  const base = `.elanous-standby/${tier}`;
  run('ssh', ['-o', 'BatchMode=yes', host, `mkdir -p ${base}/current`]);
  const r = run('rsync', ['-a', '--inplace', '--no-whole-file', '--delete', `${local}/`, `${host}:${base}/current/`]);
  if (!r.ok) throw new Error(`rsync to ${host} failed: ${r.out}`);
  const verify = run('ssh', ['-o', 'BatchMode=yes', host, `cd ${base}/current && (shasum -a 256 -c SHA256SUMS >/dev/null 2>&1 || sha256sum -c SHA256SUMS >/dev/null 2>&1) && echo verified`]);
  if (verify.out !== 'verified') throw new Error(`checksum verify failed on ${host}:${base}/current`);
  // APFS clone on macOS (no extra space until files diverge), hard links on Linux.
  const clone = run('ssh', ['-o', 'BatchMode=yes', host, `cd ${base} && (cp -cR current ${gen} 2>/dev/null || cp -al current ${gen}) && ln -sfn ${gen} latest.new && (mv -fh latest.new latest 2>/dev/null || mv -fT latest.new latest) && ls -1d 2*Z | sort | awk -v k=${keep} '{a[NR]=$0} END {for (i=1;i<=NR-k;i++) print a[i]}' | xargs rm -rf; echo cloned`]);
  if (!clone.out.endsWith('cloned')) throw new Error(`generation clone failed on ${host}: ${clone.out}`);
}

function pushSurvival(target: string, local: string, manifest: Manifest, root: string): void {
  const paths = survivalPaths(manifest, root);
  const staging = `${local}.survival`;
  rmSync(staging, { recursive: true, force: true });
  for (const p of paths) { mkdirSync(dirname(join(staging, p)), { recursive: true }); cpSync(join(local, p), join(staging, p)); }
  const sub = manifest.entries.filter(e => paths.includes(e.path));
  writeFileSync(join(staging, 'SHA256SUMS'), sub.map(e => `${e.sha256}  ${e.path}`).join('\n') + '\n');
  writeFileSync(join(staging, 'MANIFEST.json'), `${JSON.stringify({ ...manifest, entries: sub }, null, 2)}\n`);
  if (target.startsWith('s3://')) {
    const r = run('aws', ['s3', 'sync', staging, `${target.replace(/\/$/, '')}/${manifest.generation}/`, '--sse', 'AES256', '--only-show-errors']);
    if (!r.ok) throw new Error(`s3 sync failed: ${r.out}`);
  } else {
    const base = `.elanous-standby/survival`;
    run('ssh', ['-o', 'BatchMode=yes', target, `mkdir -p ${base}`]);
    const r = run('rsync', ['-a', `${staging}/`, `${target}:${base}/${manifest.generation}/`]);
    if (!r.ok) throw new Error(`rsync survival to ${target} failed: ${r.out}`);
  }
  rmSync(staging, { recursive: true, force: true });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const tier = (val('--tier') ?? 'core') as Tier;
  if (tier !== 'core' && tier !== 'big' && tier !== 'obs') { console.error('--tier core|big|obs'); process.exit(2); }
  const root = process.env.ELANOUS_STATE_DIR ?? join(homedir(), '.elanous');
  const stagingRoot = join(homedir(), '.elanous-standby-staging', tier);
  const started = Date.now();
  try {
    if (argv.includes('--dry-run')) {
      const plan = planSnapshot(root, tier);
      console.log(JSON.stringify({ tier, items: plan.length, survival: plan.filter(i => i.survival).length, plan }, null, argv.includes('--json') ? 0 : 2));
      process.exit(0);
    }
    mkdirSync(stagingRoot, { recursive: true });
    // One clock reading names both the pushed folder and MANIFEST.generation — a big tier takes seconds to snapshot,
    // and two readings drifted apart (10-04 12:13 big: folder 031304Z · manifest 031309Z · caught by standby-verify).
    const now = new Date();
    const gen = generationId(now);
    const out = join(stagingRoot, 'current');
    const manifest = buildGeneration({ root, out, tier, now });
    const host = val('--push');
    const keep = Number(val('--keep') ?? (tier === 'core' ? 36 : 8));
    if (host) pushToHost(host, out, tier, gen, keep);
    for (const target of (val('--survival') ?? '').split(',').filter(Boolean)) pushSurvival(target, out, manifest, root);
    const bytes = manifest.entries.reduce((n, e) => n + e.bytes, 0);
    const summary = { generation: gen, tier, files: manifest.entries.length, reused: manifest.entries.filter(e => e.reused).length, bytes, pushed: host ?? null, survival: (val('--survival') ?? '').split(',').filter(Boolean), seconds: Math.round((Date.now() - started) / 1000) };
    debug.log('hq.standby', 'generation', summary);
    console.log(argv.includes('--json') ? JSON.stringify(summary) : `standby ${tier} ${gen}: ${summary.files} files (${summary.reused} reused) · ${(bytes / 1e6).toFixed(1)} MB · push ${host ?? '-'} · survival ${summary.survival.join(',') || '-'} · ${summary.seconds}s`);
  } catch (error) {
    debug.log('hq.standby', 'failed', { tier, error: String(error).slice(0, 300) });
    console.error(`standby ${tier} FAILED: ${String(error)}`);
    process.exit(1);
  }
}
