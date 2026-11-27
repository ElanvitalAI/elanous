// Read-only classification: neither the policy nor its collector removes a worktree.
import { spawnSync } from 'node:child_process';

export interface EphemeralFacts {
  ownerKnown?: boolean;
  trackedClean?: boolean;
  untrackedAbsent?: boolean;
  ignoredAbsent?: boolean;
  ptyInactive?: boolean;
  merged?: boolean;
  lastActivityMs?: number;
  nowMs: number;
}

export function classifyEphemeralWorktree(facts: EphemeralFacts): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (facts.ownerKnown !== true) reasons.push('owner-unknown');
  if (facts.trackedClean !== true) reasons.push('tracked-dirty-or-unknown');
  if (facts.untrackedAbsent !== true) reasons.push('untracked-present-or-unknown');
  if (facts.ignoredAbsent !== true) reasons.push('ignored-present-or-unknown');
  if (facts.ptyInactive !== true) reasons.push('pty-active-or-unknown');
  if (facts.merged !== true) reasons.push('not-merged-or-unknown');
  if (!Number.isFinite(facts.nowMs) || facts.lastActivityMs === undefined || !Number.isFinite(facts.lastActivityMs) || facts.nowMs - facts.lastActivityMs < 48 * 60 * 60 * 1000) {
    reasons.push('idle-under-48h-or-unknown');
  }
  return { eligible: reasons.length === 0, reasons };
}

/** Snapshot identity is supplied by a trusted collector; this function performs no deletion. */
export interface EphemeralSnapshot {
  targetId?: string;
  ownerId?: string;
  lastActivityMs?: number;
  observedAtMs?: number;
  facts: EphemeralFacts;
}

/** Fail closed on stale/missing snapshots, changed identity/activity, or changed safety facts. */
export function revalidateEphemeralSnapshot(initial: EphemeralSnapshot, current: EphemeralSnapshot, nowMs: number, maxAgeMs: number): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) reasons.push('invalid-clock-or-freshness');
  for (const snapshot of [initial, current]) {
    if (!snapshot.targetId || !snapshot.ownerId || !Number.isFinite(snapshot.lastActivityMs) || snapshot.lastActivityMs !== snapshot.facts.lastActivityMs) reasons.push('identity-or-activity-unknown');
    if (!Number.isFinite(snapshot.observedAtMs) || !Number.isFinite(nowMs) || snapshot.observedAtMs! > nowMs || nowMs - snapshot.observedAtMs! > maxAgeMs) reasons.push('snapshot-stale-or-unknown');
  }
  if (initial.targetId !== current.targetId || initial.ownerId !== current.ownerId || initial.lastActivityMs !== current.lastActivityMs) reasons.push('identity-or-activity-changed');
  if (initial.observedAtMs !== undefined && current.observedAtMs !== undefined && current.observedAtMs < initial.observedAtMs) reasons.push('snapshot-order-invalid');
  reasons.push(...classifyEphemeralWorktree({ ...initial.facts, nowMs }).reasons, ...classifyEphemeralWorktree({ ...current.facts, nowMs }).reasons);
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Collect Git facts only; ownership, activity, merge and idle must come from trusted callers. */
export function classifyGitWorktree(path: string, facts: Omit<EphemeralFacts, 'trackedClean' | 'untrackedAbsent' | 'ignoredAbsent'>) {
  const git = (args: string[]): boolean | undefined => {
    const result = spawnSync('git', args, { cwd: path, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    return result.status === 0 ? result.stdout.length === 0 : undefined;
  };
  return classifyEphemeralWorktree({ ...facts,
    trackedClean: git(['status', '--porcelain', '--untracked-files=no']),
    untrackedAbsent: git(['ls-files', '--others', '--exclude-standard', '-z']),
    ignoredAbsent: git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
  });
}
