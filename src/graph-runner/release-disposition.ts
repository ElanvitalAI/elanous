import { createHash } from 'node:crypto';

export type ReleaseGateVerdict = 'pass' | 'waived-known-issue' | 'fail';
export type ReleaseDispositionState = ReleaseGateVerdict | 'needs-evidence';
export type ObservedReleaseVerdict = 'pass' | 'fail' | 'unmeasured';

/** Fresh identities come from the saved run and independently enumerated receipts, never from the artifact. */
export interface ReleaseDispositionIdentity {
  runId: string;
  cut: string;
  version: string;
  invocationId: string;
  imageDigest: string;
  graphSha256: string;
  recipesSha256: string;
  policyVersion: string;
  policySha256: string;
  ledgerSha256: string;
  tableSha256: string;
  checklistSha256: string;
}
export interface ReleaseDispositionOutput {
  nodeId: string;
  childRunId: string;
  attemptId: string;
  sha256: string;
  formalVerdict: ObservedReleaseVerdict;
}
export interface ReleaseDispositionExecution {
  nodeId: string;
  checkoutCommit: string;
  scriptSha256: string;
  argvSha256: string;
  cwd: string;
}
export interface ReleaseDispositionSignature {
  role: 'OP' | 'JUD';
  keyId: string;
  signature: string;
}
export interface ReleaseDispositionArtifact {
  schemaVersion: 1;
  identity: ReleaseDispositionIdentity;
  verdict: ReleaseDispositionState;
  issuedAt: string;
  expiresAt: string;
  publishAt: string;
  outputs: ReleaseDispositionOutput[];
  executions: ReleaseDispositionExecution[];
  unmeasuredShards: string[];
  introducedCritical: string[];
  pendingEvidence: string[];
  signatures: ReleaseDispositionSignature[];
}
export interface ReleaseDispositionObservation extends Omit<ReleaseDispositionOutput, 'sha256'> {
  /** Complete original output bytes, not a selected-field projection or reserialized JSON. */
  bytes: Uint8Array;
}
export interface ReleaseDispositionContext {
  identity: ReleaseDispositionIdentity;
  now: number;
  publishAt: string;
  /** Pinned in the immutable run/decision ledger, not supplied by the node output being checked. */
  artifactSha256: string;
  /** Once a waiver is recorded, a forged normal-PASS artifact cannot downgrade that lineage. */
  recordedWaiverSha256?: string;
  requiredOutputNodes: readonly string[];
  observations: readonly ReleaseDispositionObservation[];
  /** Actual/planned script bytes, argv, cwd and checkout observed by the runner for this consumer. */
  executions: readonly ReleaseDispositionExecution[];
  unmeasuredShards: readonly string[];
  introducedCritical: readonly string[];
  evidenceComplete: boolean;
  /** Trusted policy-selected verifiers. B must bind these to immutable OP/JUD decisions or trusted public keys.
   * There is no permissive default; an artifact's role/key label is never authority by itself. */
  authorities: Readonly<Record<'OP' | 'JUD', { keyId: string; verify: (payload: Uint8Array, signature: string) => boolean }>>;
}
export type ReleaseDispositionDecision =
  | { verdict: 'pass' | 'waived-known-issue'; artifactSha256: string }
  | { verdict: 'needs-evidence'; reason: 'evidence-incomplete' }
  | { verdict: 'fail'; reason: string };

export function releaseDispositionSha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
/** Sign/attest every schema field except the proof envelopes, with a protocol domain separator. */
export function releaseDispositionSigningBytes(artifact: ReleaseDispositionArtifact): Uint8Array {
  const { signatures: _signatures, ...payload } = artifact;
  return Buffer.from(`elanous.release-disposition.v1\n${canonical(payload)}`, 'utf8');
}
const hash = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const text = (x: unknown): x is string => typeof x === 'string' && x.trim() === x && x.length > 0;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const unique = (xs: readonly string[]): boolean => xs.every(text) && new Set(xs).size === xs.length;
const strings = (x: unknown): x is string[] => Array.isArray(x) && unique(x);
const date = (x: unknown): x is string => text(x) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(x) && Number.isFinite(Date.parse(x));
function identity(x: unknown): x is ReleaseDispositionIdentity {
  if (!object(x)) return false;
  return ['runId', 'invocationId', 'policyVersion'].every(k => text(x[k]))
    && typeof x.cut === 'string' && /^[a-f0-9]{40}$/.test(x.cut)
    && typeof x.version === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(x.version)
    && typeof x.imageDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(x.imageDigest)
    && ['graphSha256', 'recipesSha256', 'policySha256', 'ledgerSha256', 'tableSha256', 'checklistSha256'].every(k => hash(x[k]));
}
function output(x: unknown): x is ReleaseDispositionOutput {
  return object(x) && ['nodeId', 'childRunId', 'attemptId'].every(k => text(x[k])) && hash(x.sha256)
    && ['pass', 'fail', 'unmeasured'].includes(x.formalVerdict as string);
}
function execution(x: unknown): x is ReleaseDispositionExecution {
  return object(x) && text(x.nodeId) && text(x.cwd) && x.cwd.startsWith('/')
    && typeof x.checkoutCommit === 'string' && /^[a-f0-9]{40}$/.test(x.checkoutCommit)
    && hash(x.scriptSha256) && hash(x.argvSha256);
}
function signature(x: unknown): x is ReleaseDispositionSignature {
  return object(x) && ['OP', 'JUD'].includes(x.role as string) && text(x.keyId)
    && text(x.signature);
}
/** Parses untrusted persisted JSON; rejects malformed/duplicate entries without logging raw outputs. */
export function parseReleaseDispositionArtifact(bytes: Uint8Array): ReleaseDispositionArtifact {
  const x: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (!object(x) || x.schemaVersion !== 1 || !identity(x.identity)
    || !['pass', 'waived-known-issue', 'fail', 'needs-evidence'].includes(x.verdict as string)
    || !date(x.issuedAt) || !date(x.expiresAt) || !date(x.publishAt)
    || !Array.isArray(x.outputs) || !x.outputs.every(output) || !unique(x.outputs.map(o => o.nodeId))
    || !Array.isArray(x.executions) || !x.executions.every(execution) || !unique(x.executions.map(e => e.nodeId))
    || !strings(x.unmeasuredShards) || !strings(x.introducedCritical) || !strings(x.pendingEvidence)
    || !Array.isArray(x.signatures) || !x.signatures.every(signature) || !unique(x.signatures.map(s => s.role))) {
    throw new Error('invalid-release-disposition-schema');
  }
  return x as unknown as ReleaseDispositionArtifact;
}
const sameSet = (a: readonly string[], b: readonly string[]) => unique(a) && unique(b)
  && canonical([...a].sort()) === canonical([...b].sort());

/** Pure acceptance contract. B owns trusted ledger/raw/source adapters and every production caller. */
export function evaluateReleaseDisposition(bytes: Uint8Array, context: ReleaseDispositionContext): ReleaseDispositionDecision {
  const fail = (reason: string): ReleaseDispositionDecision => ({ verdict: 'fail', reason });
  let artifact: ReleaseDispositionArtifact;
  try { artifact = parseReleaseDispositionArtifact(bytes); }
  catch { return fail('invalid-release-disposition-schema'); }
  const sha = releaseDispositionSha256(bytes);
  if (!hash(context.artifactSha256) || sha !== context.artifactSha256) return fail('artifact-sha-mismatch');
  if (!identity(context.identity) || canonical(artifact.identity) !== canonical(context.identity)) return fail('identity-mismatch');
  if (!Number.isFinite(context.now) || Date.parse(artifact.issuedAt) > context.now
    || Date.parse(artifact.expiresAt) <= context.now || Date.parse(artifact.expiresAt) <= Date.parse(artifact.issuedAt)) return fail('expired-or-future-artifact');
  if (artifact.publishAt !== context.publishAt) return fail('publish-at-mismatch');
  if (context.recordedWaiverSha256 !== undefined
    && (!hash(context.recordedWaiverSha256) || context.recordedWaiverSha256 !== sha || artifact.verdict !== 'waived-known-issue')) return fail('waiver-lineage-mismatch');
  if (!sameSet(artifact.unmeasuredShards, context.unmeasuredShards)
    || !sameSet(artifact.introducedCritical, context.introducedCritical)) return fail('independent-evidence-set-mismatch');
  if (context.introducedCritical.length > 0) return fail('new-critical-failure');
  if (artifact.verdict === 'fail') return fail('recorded-failure');
  if (artifact.verdict === 'needs-evidence' || !context.evidenceComplete || artifact.pendingEvidence.length > 0)
    return { verdict: 'needs-evidence', reason: 'evidence-incomplete' };
  if (context.requiredOutputNodes.length === 0 || !sameSet(artifact.outputs.map(o => o.nodeId), context.requiredOutputNodes)
    || !sameSet(context.observations.map(o => o.nodeId), context.requiredOutputNodes)) return fail('output-set-mismatch');
  for (const expected of artifact.outputs) {
    const actual = context.observations.find(o => o.nodeId === expected.nodeId)!;
    if (!(actual.bytes instanceof Uint8Array) || actual.bytes.length === 0 || actual.childRunId !== expected.childRunId || actual.attemptId !== expected.attemptId
      || actual.formalVerdict !== expected.formalVerdict || releaseDispositionSha256(actual.bytes) !== expected.sha256)
      return fail('original-output-mismatch');
  }
  if (context.executions.length === 0 || !context.executions.every(execution)
    || !sameSet(artifact.executions.map(e => e.nodeId), context.executions.map(e => e.nodeId))) return fail('execution-set-mismatch');
  for (const expected of artifact.executions) {
    const actual = context.executions.find(e => e.nodeId === expected.nodeId)!;
    if (expected.checkoutCommit !== artifact.identity.cut || canonical(expected) !== canonical(actual)) return fail('execution-source-mismatch');
  }
  if (artifact.verdict === 'pass') {
    if (artifact.outputs.some(o => o.formalVerdict !== 'pass') || artifact.unmeasuredShards.length > 0) return fail('pass-has-unresolved-evidence');
    return { verdict: 'pass', artifactSha256: sha };
  }
  if (!artifact.outputs.some(o => o.formalVerdict !== 'pass') && artifact.unmeasuredShards.length === 0) return fail('waiver-without-original-failure');
  const signingBytes = releaseDispositionSigningBytes(artifact);
  try {
    for (const role of ['OP', 'JUD'] as const) {
      const authority = context.authorities[role];
      const signed = artifact.signatures.find(s => s.role === role);
      if (!signed || signed.keyId !== authority.keyId
        || authority.verify(signingBytes, signed.signature) !== true) return fail('invalid-waiver-signature');
    }
  } catch { return fail('invalid-waiver-signature'); }
  return { verdict: 'waived-known-issue', artifactSha256: sha };
}
