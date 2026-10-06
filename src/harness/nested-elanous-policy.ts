// Nested elanous launch policy.
//
// Codex children drop parent env under shell_environment_policy inherit=core, so a
// depth marker that only lives in the environment never arrives. Depth is therefore
// carried on the codex argv (`-c shell_environment_policy.set.ELANOUS_NESTED_DEPTH=<n>`).
//
// Unset ELANOUS_NESTED_DEPTH is depth 0 (the outer launcher). A missing marker is
// not "depth unknown" and does not refuse an ordinary mission spawn.
// Refusal for a backend that cannot carry the marker applies only when a nested
// elanous launch was actually requested (allow flag or config allow).
//
// Only depth 0 (the outer launcher) may allow a nested elanous launch. At depth >= 1
// an allow flag is ignored and the launch stays refused.

import { debug } from '../debug/log.js';

export const ELANOUS_NESTED_DEPTH_ENV = 'ELANOUS_NESTED_DEPTH';

/** Codex config key that sets the depth marker inside the child's shell policy. */
export const CODEX_NESTED_DEPTH_CONFIG_KEY = `shell_environment_policy.set.${ELANOUS_NESTED_DEPTH_ENV}`;

export type NestedElanousBackendName = 'codex' | 'claude' | 'gemini' | 'grok' | 'aside' | (string & {});

export interface NestedElanousDecision {
  readonly allowed: boolean;
  readonly depth: number;
  /** True when depth >= 1 supplied allow and it was ignored. */
  readonly allowIgnored: boolean;
  readonly reason: 'depth-0' | 'depth-0-allow' | 'depth-unknown' | 'nested-refused' | 'allow-ignored';
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
  return ['-c', `${CODEX_NESTED_DEPTH_CONFIG_KEY}=${childDepth}`];
}

/**
 * Allow decision. Depth 0 allows only when `allow` is true.
 * Depth >= 1 always refuses; a supplied allow is ignored and logged.
 */
export function decideNestedElanousLaunch(input: {
  readonly depth: number;
  readonly allow?: boolean;
}): NestedElanousDecision {
  const depth = Number.isInteger(input.depth) && input.depth >= 0 ? input.depth : 0;
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
}): NestedElanousDecision {
  const depth = Number.isInteger(input.depth) && input.depth >= 0 ? input.depth : 0;
  if (!input.nestedLaunchRequested) {
    return decideNestedElanousLaunch({ depth, allow: false });
  }
  if (!backendCarriesNestedDepth(input.backendName)) {
    return { allowed: false, depth, allowIgnored: false, reason: 'depth-unknown' };
  }
  const allow = input.allow === true || (depth === 0 && input.configAllow === true);
  return decideNestedElanousLaunch({ depth, allow });
}
