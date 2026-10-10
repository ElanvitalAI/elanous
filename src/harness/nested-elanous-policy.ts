// Nested elanous launch policy.
//
// Codex children drop parent env under shell_environment_policy inherit=core, so a
// depth marker that only lives in the environment never arrives. Depth is therefore
// carried on the codex argv (`-c shell_environment_policy.set.ELANOUS_NESTED_DEPTH="<n>"` — TOML 문자열).
//
// Unset ELANOUS_NESTED_DEPTH is depth 0 (the outer launcher). A missing marker is
// not "depth unknown" and does not refuse an ordinary mission spawn.
// Refusal for a backend that cannot carry the marker applies only when a nested
// elanous launch was actually requested (allow flag or config allow).
//
// Only depth 0 (the outer launcher) may allow a nested elanous launch. At depth >= 1
// an allow flag is ignored and the launch stays refused.

import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';

export const ELANOUS_NESTED_DEPTH_ENV = 'ELANOUS_NESTED_DEPTH';

/** Codex config key that sets the depth marker inside the child's shell policy. */
export const CODEX_NESTED_DEPTH_CONFIG_KEY = `shell_environment_policy.set.${ELANOUS_NESTED_DEPTH_ENV}`;

export type NestedElanousBackendName = 'codex' | 'claude' | 'gemini' | 'grok' | 'aside' | (string & {});

export interface NestedElanousDecision {
  readonly allowed: boolean;
  readonly depth: number;
  /** True when depth >= 1 supplied allow and it was ignored. */
  readonly allowIgnored: boolean;
  readonly reason: 'depth-0' | 'depth-0-allow' | 'depth-unknown' | 'nested-refused' | 'allow-ignored' | 'depth-cap';
}

/** Current process depth from the nested-depth marker. Unset or unreadable = 0 (outer launcher). */
export function readNestedElanousDepth(env: Record<string, string | undefined> = process.env): number {
  const raw = env[ELANOUS_NESTED_DEPTH_ENV];
  if (raw === undefined || raw.trim() === '') return 0;
  if (!/^\d+$/.test(raw.trim())) return 0;
  return Number(raw);
}

/** True when this backend can carry the depth marker to its child. Only codex can. */
export function backendCarriesNestedDepth(backendName: string): boolean {
  return backendName === 'codex';
}

/**
 * Codex argv fragment that sets the child's depth marker.
 * `depth` is the child's depth (parent + 1). Non-codex backends return [] — they cannot carry it.
 */
export function nestedDepthCodexArgs(backendName: string, childDepth: number): string[] {
  if (backendName !== 'codex') return [];
  if (!Number.isInteger(childDepth) || childDepth < 0) return [];
  // 🩸 CODEX-NESTED-DEPTH-QUOTE(2026-10-09): `-c` 값은 TOML 이고 shell_environment_policy.set 은 «문자열» 맵이다.
  //   맨 정수(`=1`)는 codex 0.159.3 에서 «failed to load bootstrap configuration» 으로 자식을 바로 죽인다 → 따옴표로 문자열.
  return ['-c', `${CODEX_NESTED_DEPTH_CONFIG_KEY}="${childDepth}"`];
}

/**
 * Allow decision. Depth 0 allows only when `allow` is true.
 * Depth >= 1 always refuses; a supplied allow is ignored and logged.
 */
/** Nested depth cap: explicit value, else `harness.nestedElanousMaxDepth`, else 2. */
export function resolveNestedDepthCap(maxDepth?: number): number {
  const configured = maxDepth ?? getUserConfig().harness?.nestedElanousMaxDepth;
  return typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0 ? configured : 2;
}

export function decideNestedElanousLaunch(input: {
  readonly depth: number;
  readonly allow?: boolean;
  readonly maxDepth?: number;
  /** False for an ordinary mission spawn that did not request a nested launch — no cap log. */
  readonly logCap?: boolean;
}): NestedElanousDecision {
  const depth = Number.isInteger(input.depth) && input.depth >= 0 ? input.depth : 0;
  const cap = resolveNestedDepthCap(input.maxDepth);
  if (depth >= cap) {
    if (input.logCap !== false) debug.log('agent-mission.nested', 'depth-cap', { depth, cap });
    return { allowed: false, depth, allowIgnored: input.allow === true, reason: 'depth-cap' };
  }
  if (depth >= 1) {
    if (input.allow === true) {
      debug.log('agent-mission.nested', 'allow-ignored', { depth });
      return { allowed: false, depth, allowIgnored: true, reason: 'allow-ignored' };
    }
    return { allowed: false, depth, allowIgnored: false, reason: 'nested-refused' };
  }
  if (input.allow === true) {
    return { allowed: true, depth, allowIgnored: false, reason: 'depth-0-allow' };
  }
  return { allowed: false, depth, allowIgnored: false, reason: 'depth-0' };
}

/** Config `harness.nestedElanous`. Only `'allow'` counts, and only at depth 0. */
export function configAllowsNestedElanous(
  config: { harness?: { nestedElanous?: string } } | undefined,
  depth: number,
): boolean {
  if (depth !== 0) return false;
  return config?.harness?.nestedElanous === 'allow';
}

/**
 * Gate a nested elanous launch.
 *
 * Ordinary mission spawn is not this gate: call it only when a nested elanous
 * launch was requested. A backend that cannot carry the depth marker is then
 * refused (`depth-unknown`) — including depth 0 with allow — because the child
 * would not know its own depth. Unset depth is 0, not unknown.
 *
 * `allow` is the flag. Config allow counts only at depth 0 and never overrides
 * a depth >= 1 refusal.
 */
export function gateNestedElanousLaunch(input: {
  readonly backendName: string;
  readonly depth: number;
  /** True only when this call is gating a requested nested elanous launch. */
  readonly nestedLaunchRequested: boolean;
  readonly allow?: boolean;
  readonly configAllow?: boolean;
  readonly maxDepth?: number;
}): NestedElanousDecision {
  const depth = Number.isInteger(input.depth) && input.depth >= 0 ? input.depth : 0;
  const allow = input.nestedLaunchRequested && (input.allow === true || (depth === 0 && input.configAllow === true));
  if (!input.nestedLaunchRequested) {
    return decideNestedElanousLaunch({ depth, allow: false, logCap: false, ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }) });
  }
  if (!backendCarriesNestedDepth(input.backendName)) {
    // The depth-unknown refusal stands; reaching the cap is still recorded.
    const cap = resolveNestedDepthCap(input.maxDepth);
    if (depth >= cap) debug.log('agent-mission.nested', 'depth-cap', { depth, cap, backend: input.backendName });
    return { allowed: false, depth, allowIgnored: false, reason: 'depth-unknown' };
  }
  return decideNestedElanousLaunch({ depth, allow, ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }) });
}
