export interface RemoteParentRun {
  dispatched: true;
  exitCode: number;
  host: string;
}

export type ParentDispatchDecision =
  | { mode: 'remote'; host: string; exitCode: number }
  | { mode: 'blocked'; reason: string }
  | { mode: 'local'; reason: string };

/** Goal-file paths and their contents belong to the caller's filesystem; only inline goals can cross hosts. */
export function orchestrateParentInputsShareable(input: { goalFileCount: number; hasResume: boolean; hasIsolatedInstance: boolean }): boolean {
  return Number.isSafeInteger(input.goalFileCount) && input.goalFileCount === 0
    && !input.hasResume && !input.hasIsolatedInstance;
}

export async function dispatchOrchestrateParent(input: {
  requested: boolean;
  worker: boolean;
  shareableInputs: boolean;
  args: string[];
}, ports: {
  runRemote: (args: string[]) => Promise<RemoteParentRun | { dispatched: false; blocked?: true; reason?: string }>;
  logLocalFallback: (reason: string) => void;
  logBlocked?: (reason: string) => void;
}): Promise<ParentDispatchDecision> {
  if (!input.requested || input.worker) return { mode: 'local', reason: 'remote-parent-not-requested' };
  if (!input.shareableInputs) {
    const reason = 'goal-input-is-local-only';
    ports.logLocalFallback(reason);
    return { mode: 'local', reason };
  }
  const remote = await ports.runRemote(input.args);
  if (remote.dispatched) return { mode: 'remote', host: remote.host, exitCode: remote.exitCode };
  if (remote.blocked) {
    const reason = remote.reason ?? 'release-gate-parent-dispatch-blocked';
    ports.logBlocked?.(reason);
    return { mode: 'blocked', reason };
  }
  const reason = 'no-eligible-remote-parent';
  ports.logLocalFallback(reason);
  return { mode: 'local', reason };
}
