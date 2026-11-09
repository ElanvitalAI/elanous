import type { GateExecutor } from './gate-executor.js';

export interface AcceptedRegression { id: string; note: string }

export interface GateExecutorOverride {
  kind: 'gate-executor';
  at: string;
  from: string;
  set: { gateExecutor: GateExecutor; gateRemote?: string };
  /** Input keys removed — switching back to pod drops the host an earlier override added (the original had none). */
  unset?: Array<'gateRemote'>;
  previous: { gateExecutor: unknown; gateRemote: unknown };
}

/** RESUME-GATE-POOL-OVERRIDE — replace the saved pool for a gate that will be re-run. */
export interface GatePodPoolOverride {
  kind: 'gate-pod-pool';
  at: string;
  from: string;
  set: { gatePodPool: string };
  previous: { gatePodPool: unknown };
}

/** One shard keeps its component identity while the run-time scheduler chooses a compatible member. */
export interface GateShardRerouteOverride {
  kind: 'gate-shard-reroute'; at: string; from: string;
  set: { gateRerouteShard: string; gateShardHost?: string; gateShardCapabilities?: Record<string, { os: 'darwin' | 'linux' }> };
  previous: { gateRerouteShard: unknown; gateShardHost: unknown; gateShardCapabilities: unknown };
}
