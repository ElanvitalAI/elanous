/** A release cut is a position in landing order, not an ordering of SHA strings. */
export interface ReleaseLanding {
  sha: string;
  title: string;
  kind: string;
  gate: 'passed' | 'failed' | 'unknown';
  docs: 'paired' | 'exempt' | 'missing';
  reverted?: boolean;
  goalRef?: string;
  releaseTarget?: 'next' | 'later';
  breaking?: boolean;
  removedPublicCommands?: readonly string[];
}

export interface ReleaseGoal {
  ref: string;
  status: 'running' | 'landed';
  releaseTarget?: 'next' | 'later';
}

export interface BuildReleaseManifestInput {
  version: string;
  cutoff: string;
  /** Oldest to newest; the cutoff SHA must appear exactly once. */
  landings: readonly ReleaseLanding[];
  goals?: readonly ReleaseGoal[];
}

export interface ReleaseManifestEntry {
  sha: string;
  title: string;
  kind: string;
  docs: ReleaseLanding['docs'];
}

export interface ReleaseDeferredEntry {
  ref: string;
  reason: 'after-cutoff' | 'in-flight' | 'release-target-later' | 'gate-not-passed' | 'docs-missing' | 'reverted';
}

export interface ReleaseEscalation {
  sha: string;
  reason: 'breaking' | 'removed-public-command';
  command?: string;
}

export interface BuiltReleaseManifest {
  version: string;
  cutoff: string;
  in: ReleaseManifestEntry[];
  deferred: ReleaseDeferredEntry[];
  escalate: ReleaseEscalation[];
}

/** Classify a snapshot without reading git, a clock, or the goal ledger. */
export function buildReleaseManifest(input: BuildReleaseManifestInput): BuiltReleaseManifest {
  const cutoffIndex = input.landings.findIndex((landing) => landing.sha === input.cutoff);
  if (cutoffIndex < 0 || input.landings.findIndex((landing, i) => i > cutoffIndex && landing.sha === input.cutoff) !== -1) {
    throw new Error(`컷오프 SHA 는 착지 목록에 정확히 한 번 있어야 한다: ${input.cutoff}`);
  }
  const goals = new Map<string, ReleaseGoal>();
  for (const goal of input.goals ?? []) {
    if (goals.has(goal.ref)) throw new Error(`중복 골: ${goal.ref}`);
    goals.set(goal.ref, goal);
  }
  const manifest: BuiltReleaseManifest = { version: input.version, cutoff: input.cutoff, in: [], deferred: [], escalate: [] };
  for (const [index, landing] of input.landings.entries()) {
    const goal = landing.goalRef === undefined ? undefined : goals.get(landing.goalRef);
    if (landing.goalRef !== undefined && !goal) throw new Error(`착지의 골을 찾을 수 없다: ${landing.goalRef}`);
    const reason: ReleaseDeferredEntry['reason'] | undefined =
      index > cutoffIndex ? 'after-cutoff'
        : goal?.status === 'running' ? 'in-flight'
          : (landing.releaseTarget ?? goal?.releaseTarget ?? 'later') === 'later' ? 'release-target-later'
            : landing.reverted ? 'reverted'
              : landing.gate !== 'passed' ? 'gate-not-passed'
                : landing.docs === 'missing' ? 'docs-missing' : undefined;
    if (reason) {
      manifest.deferred.push({ ref: landing.sha, reason });
      continue;
    }
    manifest.in.push({ sha: landing.sha, title: landing.title, kind: landing.kind, docs: landing.docs });
    if (landing.breaking) manifest.escalate.push({ sha: landing.sha, reason: 'breaking' });
    for (const command of landing.removedPublicCommands ?? []) {
      manifest.escalate.push({ sha: landing.sha, reason: 'removed-public-command', command });
    }
  }
  for (const goal of input.goals ?? []) {
    if (goal.status === 'running' && !input.landings.some((landing) => landing.goalRef === goal.ref)) {
      manifest.deferred.push({ ref: goal.ref, reason: 'in-flight' });
    }
  }
  return manifest;
}
