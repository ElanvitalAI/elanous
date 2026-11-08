import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── RefsGC ToolRuntime (Coding Pipeline P5 hygiene · Trail H) ──
//
// `~/.cache/elanous-refs/<host>/<owner>/<repo>` is elanous's scratch area
// for SyncRepo'd reference repositories. Without housekeeping it
// grows monotonically — a year of weekly research can pile up to
// 5–10 GB. RefsGC scans the cache, evicts stale or excess entries,
// and reports how much was freed.
//
// Policy (per call):
//   - TTL: any repo whose FETCH_HEAD mtime is older than `ttlDays`
//     (default 30) is unconditionally evicted.
//   - Size cap: after the TTL pass, if the total cache size still
//     exceeds `maxGB` (default 5), evict additional repos in
//     least-recently-fetched order until under the cap.
//
// `dryRun: true` reports what would happen without removing anything
// — recommended first invocation so the user can sanity-check.
//
// Eviction = recursive delete of the `<repo>` directory only. The
// `<host>/<owner>` parents stay in place so subsequent SyncRepo calls
// don't have to recreate the directory tree. Empty parents are NOT
// pruned — they're cheap (a few inodes) and pruning them risks racing
// a concurrent SyncRepo that just mkdir'd them.
//
// Single-instance lock: shares the same .lock convention SyncRepo
// uses (per-repo). RefsGC takes a top-level lock so two GC runs can't
// race; if locked, returns a `busy` outcome instead of waiting.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ToolRuntime, ToolRuntimeContext } from './types.js';

const CACHE_ROOT_DEFAULT = join(homedir(), '.cache', 'elanous-refs');
const TTL_DAYS_DEFAULT = 30;
const MAX_GB_DEFAULT = 5;
const LOCK_FILENAME = '.gc.lock';

export interface RefsGCArgs {
  /** Time-to-live in days. Repos older than this are evicted in the
   *  TTL pass before the size-cap pass runs. Default 30. */
  ttlDays?: number;
  /** Total cache cap in GB. After TTL eviction, oldest-fetched repos
   *  are removed until total size drops under this. Default 5. */
  maxGB?: number;
  /** Don't actually delete — return what would have been removed.
   *  Default false. */
  dryRun?: boolean;
  /** Override cache root (tests). */
  cacheRoot?: string;
}

export interface RefsGCEvictedEntry {
  /** Path under the cache root (host/owner/repo). */
  relPath: string;
  /** Size in bytes that was (or would be) freed. */
  bytes: number;
  /** Last FETCH_HEAD mtime — null if FETCH_HEAD missing. */
  lastFetchAt: number | null;
  /** 'ttl' or 'size-cap' — which pass evicted this entry. */
  reason: 'ttl' | 'size-cap';
}

export interface RefsGCResult {
  output: string;
  cacheRoot: string;
  scanned: number;
  retained: number;
  evicted: RefsGCEvictedEntry[];
  totalBytesBefore: number;
  totalBytesAfter: number;
  bytesFreed: number;
  dryRun: boolean;
  /** True when another GC was already running and we backed off. */
  busy: boolean;
}

export function buildRefsGCTool(): LLMToolSpec {
  return {
    name: 'RefsGC',
    description:
      'Garbage-collect the SyncRepo cache at ~/.cache/elanous-refs. Two passes: ' +
      '(1) TTL — any repo whose FETCH_HEAD is older than `ttlDays` (default 30) is evicted. ' +
      '(2) Size cap — if the cache still exceeds `maxGB` (default 5), evict oldest repos until ' +
      'under the cap. Pass `dryRun: true` to preview without deleting. Returns scanned / ' +
      'retained / evicted counts and bytes freed.',
    parameters: {
      type: 'object',
      properties: {
        ttlDays: {
          type: 'number',
          description: 'TTL in days. Default 30. Pass 0 to disable the TTL pass.',
        },
        maxGB: {
          type: 'number',
          description: 'Total cache cap in GB. Default 5. Pass 0 to disable the size-cap pass.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview eviction without deleting. Default false.',
        },
      },
      additionalProperties: false,
    },
  };
}

interface RepoEntry {
  /** Absolute path. */
  absPath: string;
  /** Relative path from cache root: `<host>/<owner>/<repo>`. */
  relPath: string;
  /** FETCH_HEAD mtime. Null when FETCH_HEAD missing → treated as
   *  "very old" for both passes. */
  lastFetchAt: number | null;
  /** Size of the directory tree in bytes. */
  bytes: number;
}

/** Recursively sum the byte size of a directory. Skips broken symlinks
 *  and unreadable entries silently — best-effort hygiene tool. */
function dirSize(path: string): number {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const child = join(path, e.name);
    try {
      const st = statSync(child);
      if (st.isDirectory()) {
        total += dirSize(child);
      } else {
        total += st.size;
      }
    } catch {
      // ignored
    }
  }
  return total;
}

/** Scan the cache and produce a flat list of repo entries. Cache
 *  layout is exactly 3 levels deep: <host>/<owner>/<repo>. We do
 *  NOT recurse beyond that. */
function scanCache(cacheRoot: string): RepoEntry[] {
  if (!existsSync(cacheRoot)) return [];
  const out: RepoEntry[] = [];
  let hosts: string[] = [];
  try {
    hosts = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const host of hosts) {
    const hostPath = join(cacheRoot, host);
    let owners: string[] = [];
    try {
      owners = readdirSync(hostPath, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch { continue; }
    for (const owner of owners) {
      const ownerPath = join(hostPath, owner);
      let repos: string[] = [];
      try {
        repos = readdirSync(ownerPath, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch { continue; }
      for (const repo of repos) {
        const absPath = join(ownerPath, repo);
        const fetchHeadPath = join(absPath, '.git', 'FETCH_HEAD');
        let lastFetchAt: number | null = null;
        try {
          // Try .git/FETCH_HEAD first (regular clone), fall back to
          // FETCH_HEAD at repo root (bare clone).
          if (existsSync(fetchHeadPath)) {
            lastFetchAt = statSync(fetchHeadPath).mtimeMs;
          } else {
            const altPath = join(absPath, 'FETCH_HEAD');
            if (existsSync(altPath)) lastFetchAt = statSync(altPath).mtimeMs;
          }
        } catch {
          // ignored
        }
        out.push({
          absPath,
          relPath: `${host}/${owner}/${repo}`,
          lastFetchAt,
          bytes: dirSize(absPath),
        });
      }
    }
  }
  return out;
}

export function dispatchRefsGC(args: RefsGCArgs = {}): RefsGCResult {
  const cacheRoot = args.cacheRoot ?? CACHE_ROOT_DEFAULT;
  const ttlDays = args.ttlDays ?? TTL_DAYS_DEFAULT;
  const maxGB = args.maxGB ?? MAX_GB_DEFAULT;
  const dryRun = !!args.dryRun;

  if (ttlDays < 0) throw new Error('RefsGC: ttlDays must be >= 0');
  if (maxGB < 0) throw new Error('RefsGC: maxGB must be >= 0');

  // No cache yet → nothing to do (and don't create the dir).
  if (!existsSync(cacheRoot)) {
    return {
      output: `RefsGC: cache root ${cacheRoot} doesn't exist; nothing to scan.`,
      cacheRoot,
      scanned: 0,
      retained: 0,
      evicted: [],
      totalBytesBefore: 0,
      totalBytesAfter: 0,
      bytesFreed: 0,
      dryRun,
      busy: false,
    };
  }

  // Top-level lock so two GC calls can't race. We DON'T wait — return
  // busy and let the caller retry.
  const lockPath = join(cacheRoot, LOCK_FILENAME);
  let acquiredLock = false;
  if (!dryRun) {
    if (existsSync(lockPath)) {
      // Stale-lock heuristic: locks older than 1h are abandoned.
      try {
        const lockAge = Date.now() - statSync(lockPath).mtimeMs;
        if (lockAge < 60 * 60 * 1000) {
          return {
            output: `RefsGC: another GC run holds the lock at ${lockPath} (age ${Math.round(lockAge / 1000)}s); try again later.`,
            cacheRoot,
            scanned: 0,
            retained: 0,
            evicted: [],
            totalBytesBefore: 0,
            totalBytesAfter: 0,
            bytesFreed: 0,
            dryRun,
            busy: true,
          };
        }
        // Stale — overwrite below.
      } catch {
        // unreadable lock — try anyway
      }
    }
    try {
      mkdirSync(cacheRoot, { recursive: true });
      writeFileSync(lockPath, String(process.pid), 'utf-8');
      acquiredLock = true;
    } catch {
      // best-effort; if we can't write the lock we still proceed
      // rather than block the user.
    }
  }

  try {
    const entries = scanCache(cacheRoot);
    const totalBytesBefore = entries.reduce((s, e) => s + e.bytes, 0);
    const evicted: RefsGCEvictedEntry[] = [];

    // ── Pass 1: TTL ─────────────────────────────────────────────────
    // Treat null lastFetchAt as "very old" → evicted by TTL.
    const now = Date.now();
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    const survivedTtl: RepoEntry[] = [];
    for (const entry of entries) {
      const isOlder = ttlDays > 0 && (
        entry.lastFetchAt === null ||
        (now - entry.lastFetchAt) > ttlMs
      );
      if (isOlder) {
        evicted.push({
          relPath: entry.relPath,
          bytes: entry.bytes,
          lastFetchAt: entry.lastFetchAt,
          reason: 'ttl',
        });
        if (!dryRun) {
          try { rmSync(entry.absPath, { recursive: true, force: true }); }
          catch { /* best-effort */ }
        }
      } else {
        survivedTtl.push(entry);
      }
    }

    // ── Pass 2: Size cap ────────────────────────────────────────────
    // Sort survivors oldest-fetched first; evict until under cap.
    const maxBytes = maxGB * 1024 * 1024 * 1024;
    let runningBytes = survivedTtl.reduce((s, e) => s + e.bytes, 0);
    const finalSurvivors: RepoEntry[] = [];
    if (maxGB > 0 && runningBytes > maxBytes) {
      const sorted = [...survivedTtl].sort((a, b) => {
        const aT = a.lastFetchAt ?? 0;
        const bT = b.lastFetchAt ?? 0;
        return aT - bT;  // oldest first
      });
      for (const entry of sorted) {
        if (runningBytes <= maxBytes) {
          finalSurvivors.push(entry);
          continue;
        }
        evicted.push({
          relPath: entry.relPath,
          bytes: entry.bytes,
          lastFetchAt: entry.lastFetchAt,
          reason: 'size-cap',
        });
        if (!dryRun) {
          try { rmSync(entry.absPath, { recursive: true, force: true }); }
          catch { /* best-effort */ }
        }
        runningBytes -= entry.bytes;
      }
    } else {
      finalSurvivors.push(...survivedTtl);
    }

    const totalBytesAfter = finalSurvivors.reduce((s, e) => s + e.bytes, 0);
    const bytesFreed = totalBytesBefore - totalBytesAfter;

    const summary =
      `RefsGC ${dryRun ? '(dry-run) ' : ''}— scanned ${entries.length}, ` +
      `evicted ${evicted.length} (${formatBytes(bytesFreed)} freed), ` +
      `retained ${finalSurvivors.length} (${formatBytes(totalBytesAfter)}).`;

    return {
      output: summary,
      cacheRoot,
      scanned: entries.length,
      retained: finalSurvivors.length,
      evicted,
      totalBytesBefore,
      totalBytesAfter,
      bytesFreed,
      dryRun,
      busy: false,
    };
  } finally {
    if (acquiredLock) {
      try { unlinkSync(lockPath); } catch { /* best-effort */ }
    }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const refsGCRuntime: ToolRuntime<RefsGCArgs, RefsGCResult> = {
  id: 'refs_gc',
  spec: buildRefsGCTool(),
  async run(req: RefsGCArgs, _ctx: ToolRuntimeContext): Promise<RefsGCResult> {
    return dispatchRefsGC(req);
  },
};
