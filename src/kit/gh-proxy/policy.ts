// Kit gh-proxy — GH-PROXY-LAYER (0.3.40 P0 · CEO 11-28 21:0x «git 문제가 너무 많이 · proxy 등 기본 조치»). The numbers of the
// layer in front of GitHub live in graphs/policies/gh-proxy.yaml — this file parses them and holds none.
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

export interface GhProxyPolicy {
  readonly shim: { readonly readCacheSec: number; readonly readCacheWaitSec: number; readonly readCacheMaxBytes: number; readonly readCachePruneSec: number };
  readonly mirror: {
    readonly refreshMinIntervalSec: number; readonly refreshesPerTick: number; readonly staleFallbackMin: number;
    readonly fetchTimeoutSec: number; readonly refspecs: readonly string[];
  };
}

export const ghProxyPolicyPath = (root = resolve(import.meta.dir, '../../..')): string => join(root, 'graphs', 'policies', 'gh-proxy.yaml');

/** Parse the policy text. A missing / out-of-range value throws (the caller decides what an unreadable policy means). */
export function parseGhProxyPolicy(text: string): GhProxyPolicy {
  const v = parse(text) as Record<string, Record<string, unknown>> | null;
  const num = (sec: string, key: string, min = 1): number => {
    const n = v?.[sec]?.[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min) throw new Error(`gh-proxy policy: invalid ${sec}.${key}`);
    return n;
  };
  const refspecs = v?.mirror?.refspecs;
  if (!Array.isArray(refspecs) || refspecs.length === 0 || !refspecs.every(r => typeof r === 'string' && /^\+?refs\/[^:\s]+:refs\/[^:\s]+$/.test(r))) {
    throw new Error('gh-proxy policy: invalid mirror.refspecs');
  }
  return {
    shim: {
      readCacheSec: num('shim', 'read_cache_sec', 0), readCacheWaitSec: num('shim', 'read_cache_wait_sec', 0),
      readCacheMaxBytes: num('shim', 'read_cache_max_bytes'), readCachePruneSec: num('shim', 'read_cache_prune_sec'),
    },
    mirror: {
      refreshMinIntervalSec: num('mirror', 'refresh_min_interval_sec'), refreshesPerTick: num('mirror', 'refreshes_per_tick'),
      staleFallbackMin: num('mirror', 'stale_fallback_min'), fetchTimeoutSec: num('mirror', 'fetch_timeout_sec'),
      refspecs: refspecs as string[],
    },
  };
}

let memo: { path: string; mtimeMs: number; policy: GhProxyPolicy | null } | null = null;
/** The live policy (re-read when the file changes) · null = unreadable / invalid → the door passes calls through uncached. */
export function liveGhProxyPolicy(path = ghProxyPolicyPath()): GhProxyPolicy | null {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (memo && memo.path === path && memo.mtimeMs === mtimeMs) return memo.policy;
    let policy: GhProxyPolicy | null = null;
    try { policy = parseGhProxyPolicy(readFileSync(path, 'utf8')); } catch { policy = null; }
    memo = { path, mtimeMs, policy };
    return policy;
  } catch { return null; }
}
