/** Files and caches that survive between requests on a reusable Pod worker. */
export const POD_REUSE_CLEAN_EXCLUSIONS = [
  { name: 'node_modules', pattern: 'node_modules' },
  { name: 'apps/pwa/node_modules', pattern: 'apps/pwa/node_modules' },
  // Bun's install cache and remote gate cache live outside the worker checkout.
  { name: 'bun install cache', pattern: null },
  { name: 'TypeScript build info', pattern: '*.tsbuildinfo' },
  { name: 'remote gate TypeScript cache', pattern: null },
] as const;

export type PodReuseCleanupOutcome = 'reuse' | 'discard';

export interface PodReuseCleanupDecisionInput {
  base: string;
  resetExitCode: number | null;
  cleanExitCode: number | null;
  statusExitCode: number | null;
  statusPorcelain: string;
  remainingPaths?: readonly string[];
  additionalCleanExclusions?: readonly { name: string; pattern: string }[];
  statusExclusions?: readonly string[];
}

export interface PodReuseCleanupDecision {
  resetArgs: readonly string[];
  cleanArgs: readonly string[];
  statusArgs: readonly string[];
  preserved: readonly string[];
  outcome: PodReuseCleanupOutcome;
  reason?: 'invalid-base' | 'reset-failed' | 'clean-failed' | 'status-failed' | 'worktree-not-clean';
  remainingPaths: readonly string[];
}

/**
 * Pure policy: return fixed argv and decide whether the worker can be reused
 * from actual command results. WarmWorkerRuntime owns execution and lifecycle
 * event emission at the serialized request boundary.
 */
export function decidePodReuseCleanup(input: PodReuseCleanupDecisionInput): PodReuseCleanupDecision {
  const remainingPaths = (input.remainingPaths ?? []).slice(0, 5);
  const resetArgs = ['reset', '--hard', input.base] as const;
  const cleanArgs = [
    'clean', '-ffdx',
    ...[...POD_REUSE_CLEAN_EXCLUSIONS, ...(input.additionalCleanExclusions ?? [])]
      .flatMap(({ pattern }) => pattern ? ['-e', pattern] : []),
  ] as const;
  const statusArgs = ['status', '--porcelain', '-z', '--', '.', ...(input.statusExclusions ?? [])
    .map((path) => `:(exclude,top,literal)${path}`)] as const;
  const preserved = [...POD_REUSE_CLEAN_EXCLUSIONS, ...(input.additionalCleanExclusions ?? [])].map(({ name }) => name);

  let reason: PodReuseCleanupDecision['reason'];
  if (!/^[0-9a-f]{40}$/i.test(input.base)) reason = 'invalid-base';
  else if (input.resetExitCode !== 0) reason = 'reset-failed';
  else if (input.cleanExitCode !== 0) reason = 'clean-failed';
  else if (input.statusExitCode !== 0) reason = 'status-failed';
  else if (input.statusPorcelain.trim() !== '') reason = 'worktree-not-clean';

  return {
    resetArgs,
    cleanArgs,
    statusArgs,
    preserved,
    outcome: reason ? 'discard' : 'reuse',
    ...(reason ? { reason } : {}),
    remainingPaths,
  };
}
