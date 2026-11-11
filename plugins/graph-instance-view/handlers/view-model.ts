/** Surface-neutral JSON v1. The authoritative wire schema is schema/view-model.v1.schema.json. */
export interface GraphInstanceView {
  readonly schemaVersion: 1;
  readonly instance: {
    readonly source: 'harness' | 'graph' | 'release' | 'resource';
    readonly runId: string;
    readonly graphId?: string;
    readonly title: string;
    readonly observedAt: string;
    readonly state: 'running' | 'waiting' | 'done' | 'failed' | 'unknown';
  };
  readonly nodes: readonly {
    readonly id: string;
    readonly label: string;
    readonly model?: string;
    readonly role?: string;
    readonly state: 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'unknown' | 'on' | 'off' | 'stopped';
    readonly progress?: { readonly done: number; readonly total: number };
    readonly resource?: {
      readonly hostKind: 'local' | 'cloud';
      readonly cpuCores?: number;
      readonly loadavg?: readonly [number, number, number];
      readonly memory?: { readonly usedBytes: number; readonly totalBytes: number };
      readonly tasks: readonly { readonly kind: 'seat' | 'pod' | 'train' | 'gate' | 'rehearsal' | 'review'; readonly label: string }[];
    };
  }[];
  readonly edges: readonly {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly kind: 'flow' | 'branch' | 'join';
    readonly state: 'planned' | 'taken' | 'unknown';
  }[];
  readonly progress: { readonly completed: number; readonly total: number | null; readonly activeNodeIds: readonly string[]; readonly label?: string };
  readonly logs: readonly {
    readonly seq: number;
    readonly at?: string;
    readonly nodeId?: string;
    readonly level: 'info' | 'warn' | 'error';
    readonly text: string;
  }[];
  readonly statusLine: string;
  readonly readState: 'ok' | 'partial' | 'unavailable';
}

/** Version served by the read-only HTTP route and declared plugin handler. */
export function graphInstanceViewVersion(): 1 { return 1; }

/** Runtime contract marker for declared plugin loading and version negotiation. */
