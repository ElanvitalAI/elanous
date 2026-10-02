import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { spawnSync } from 'node:child_process';

export interface Versions { released: string | null; dev: string | null; codename: string | null }
export interface VersionOptions { releaseRoot?: string; repoRoot?: string; codenames?: Record<string, string> }

/** SemVer order for release ledgers: numeric core, then a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => { const [core, pre] = v.split('-', 2); return { nums: core!.split('.').map(n => Number(n) || 0), pre: pre ?? null }; };
  const x = parse(a); const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

export function createVersionResolver(opts: VersionOptions = {}): (ts: string) => Versions {
  const releases: Array<{ at: number; version: string }> = [];
  const root = opts.releaseRoot ?? join(elanousStateRoot(), 'release');
  if (existsSync(root)) for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const path = join(root, dir.name, 'release.json');
    if (!existsSync(path)) continue;
    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const stamp = record.publishedAt ?? record.published_at ?? record.releasedAt;
      const at = Date.parse(String(stamp ?? ''));
      if (typeof record.version === 'string' && Number.isFinite(at)) releases.push({ at, version: record.version });
    } catch { /* a malformed ledger cannot supply a release boundary */ }
  }
  releases.sort((a, b) => a.at - b.at);
  const repo = opts.repoRoot ?? process.cwd();
  // A current-branch commit date is not proof of when that commit entered origin/main.
  // Reflog updates are observed branch snapshots; before the first retained update the answer is unknown.
  const reflog = spawnSync('git', ['reflog', 'show', '--date=unix', '--format=%H%x09%gd', 'refs/remotes/origin/main'], { cwd: repo, encoding: 'utf8', timeout: 10000 });
  const snapshots: Array<{ at: number; commit: string; order: number }> = [];
  if (reflog.status === 0) for (const line of reflog.stdout.split('\n')) {
    const match = /^([0-9a-f]+)\torigin\/main@\{(\d+)\}$/.exec(line.trim());
    // Reflog lists newest first; keep that order so two updates in the same second resolve to the later one.
    if (match) snapshots.push({ at: Number(match[2]) * 1000, commit: match[1]!, order: snapshots.length });
  }
  snapshots.sort((a, b) => a.at - b.at || b.order - a.order);
  const versions = new Map<string, string | null>();
  for (const { commit } of snapshots) {
    if (versions.has(commit)) continue;
    const show = spawnSync('git', ['show', `${commit}:package.json`], { cwd: repo, encoding: 'utf8', timeout: 5000 });
    let version: string | null = null;
    if (show.status === 0) {
      try {
        const parsed = JSON.parse(show.stdout).version;
        if (typeof parsed === 'string') version = parsed;
      } catch { /* unreadable package at this snapshot */ }
    }
    versions.set(commit, version);
  }
  const cache = new Map<string, Versions>();
  return ts => {
    const existing = cache.get(ts);
    if (existing) return existing;
    const time = Date.parse(ts);
    // The public version at a moment = the highest version published by then (a re-written old record must not win by date).
    const released = Number.isFinite(time) ? releases.filter(x => x.at <= time).map(x => x.version).sort(compareVersions).at(-1) ?? null : null;
    const snapshot = Number.isFinite(time) ? [...snapshots].reverse().find(x => x.at <= time) : undefined;
    const dev = snapshot ? versions.get(snapshot.commit) ?? null : null;
    const codenames = opts.codenames ?? {};
    const codename = codenames[dev?.replace(/-.*/, '') ?? ''] ?? codenames[released ?? ''] ?? null;
    const value = { released, dev, codename };
    cache.set(ts, value);
    return value;
  };
}
