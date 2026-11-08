/** A shadow recommendation. No value here is a release waiver or a graph edge. */
export type GateTriageClass = 'unmeasured' | 'load' | 'env' | 'regression' | 'clean' | 'exhausted';

export interface GateTriageEvidence {
  /** Observed from the Pod/host during this gate; a timeout alone is not proof of load. */
  highLoad?: boolean;
  /** Count of the suspected failure IDs reproduced in an isolated run. */
  isolatedReproductions?: number;
  /** Exact introduced IDs that actually received an isolated recheck. */
  isolatedCheckedFailureIds?: string[];
  /** Timeout shard files that completed an isolated recheck. */
  isolatedPassedFiles?: string[];
  /** Exact test IDs independently attributed to the Pod environment. */
  environmentFailureIds?: string[];
  /** The last two actual decisions, including their measured identities. */
  priorDecisions?: Array<{ classification: GateTriageClass; commit: string; failureIds: string[] }>;
  /** Verified main-HEAD standalone remeasurement receipt reference for introduced-failure attribution. */
  introducedMainFixedPick?: {
    mainTip?: string;
    firstParentCommits?: string[];
    mainMeasurement?: { commit: string; runId: string; receiptSha256: string };
  };
}

export interface GateTriageShadow {
  /** Exact gate execution this triage was computed from; absent only for legacy/direct offline inputs. */
  gateExecutionId?: string;
  classification: GateTriageClass;
  reason: string;
  commit: string;
  introduced: string[];
  stalledFiles: string[];
  failureIds: string[];
  evidence: {
    highLoad: boolean | null;
    isolatedReproductions: number | null;
    isolatedCheckedFailureIds: string[] | null;
    isolatedPassedFiles: string[] | null;
    environmentFailureIds: string[] | null;
    loadFlaky: string[] | null;
    stalledEnv: Array<{ file: string; local: string }>;
  };
  /** Classification succeeded; the release graph still routes to its failure exit. */
  outcome: 'ok' | 'error';
}
