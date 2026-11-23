export type PodPoolFederationRole = 'task' | 'gate' | 'cloud';
export type PodPoolState = 'available' | 'draining';
export type PodReusePolicy = 'warm-worker' | 'per-job';

export interface PodPoolEntry {
  /** kubectl context this pool member runs in. */
  readonly context: string;
  /** Key into the nexus remote-hosts registry (ssh host) when the cluster runs on another machine. */
  readonly host?: string;
  /** Concurrent Job cap for this member; 0 = off (registered but never assigned). */
  readonly capacity: number;
  /** Spec had no `:N` so the capacity is the pool default, not the operator's number. */
  readonly capacityDefaulted?: boolean;
  /** k3d cluster name (image import); defaults to the `k3d-` prefix of context, else `elanous-pool`. */
  readonly k3dCluster?: string;
  /** Node-local registry image (commit tag) the Pod pulls; absent = locally imported image. */
  readonly imageRef?: string;
  /** In-cluster registry address (`host:port`). */
  readonly registry?: string;
  readonly federationRole?: PodPoolFederationRole;
  readonly state: PodPoolState;
  readonly aliases?: readonly string[];
  readonly reuse?: { readonly policy: PodReusePolicy; readonly maxIdleMs?: number };
}

export interface PodPoolsFile {
  readonly version: 1;
  readonly pools: Record<string, PodPoolEntry>;
}