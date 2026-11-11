/** RLA's narrow port to the identity-partitioned ARG feedback ledger. */
import { ArgFeedbackLedger, type ArgFeedbackIdentity } from './arg-feedback-lifecycle.js';
export interface ArgFeedbackSignature {
  readonly nodeId: string;
  readonly testName: string;
  readonly errorSignature: string;
}

export interface ArgFeedbackReference {
  readonly signature: ArgFeedbackSignature;
  readonly effect: string;
  readonly stage: 'candidate' | 'pack' | 'instance' | 'graph';
  readonly status: string;
  readonly templateEntryId?: string;
  readonly packId?: string;
}

export interface ArgFeedbackLedgerPort {
  templateCandidates(): readonly ArgFeedbackReference[] | Promise<readonly ArgFeedbackReference[]>;
  activePack(): readonly ArgFeedbackReference[] | Promise<readonly ArgFeedbackReference[]>;
  record(input: { readonly runId: string; readonly signature: ArgFeedbackSignature;
    readonly effect: string; readonly outcome: 'verified' | 'rollback'; readonly at: string }):
    ArgFeedbackReference | void | Promise<ArgFeedbackReference | void>;
}

export type ArgFeedbackCommittedOutcome =
  | { readonly outcome: 'verified' | 'rollback'; readonly effect: string }
  | 'absent' | 'unknown';

/** The graph must remain intact until a durable feedback outcome can be reconciled. */
export class ArgFeedbackDurabilityError extends Error {
  constructor(message: string) { super(message); this.name = 'ArgFeedbackDurabilityError'; }
}

/** Reopen the durable partition after a writer error; never trust its in-memory map. */
export function readDurableArgFeedbackOutcome(root: string, identity: ArgFeedbackIdentity,
  runId: string, signature: ArgFeedbackSignature): ArgFeedbackCommittedOutcome {
  const record = new ArgFeedbackLedger(root, identity).get(signature);
  if (!record?.seenRuns.includes(runId)) return 'absent';
  return { outcome: record.successfulRuns.includes(runId) ? 'verified' : 'rollback', effect: record.effect };
}

const sameSignature = (left: ArgFeedbackSignature, right: ArgFeedbackSignature): boolean =>
  left.nodeId === right.nodeId && left.testName === right.testName &&
  left.errorSignature === right.errorSignature;

/** Only MRTR-promoted candidates and active packs may inform a proposal. */
export async function readArgFeedback(ledger: ArgFeedbackLedgerPort, signature: ArgFeedbackSignature): Promise<{
  readonly candidates: readonly ArgFeedbackReference[]; readonly packs: readonly ArgFeedbackReference[]
}> {
  const [candidates, packs] = await Promise.all([ledger.templateCandidates(), ledger.activePack()]);
  return {
    candidates: candidates.filter(item => item.stage === 'candidate' &&
      item.status === 'candidate' && !!item.templateEntryId && sameSignature(item.signature, signature)),
    packs: packs.filter(item => item.stage === 'pack' && item.status === 'active' &&
      !!item.packId && sameSignature(item.signature, signature)),
  };
}
