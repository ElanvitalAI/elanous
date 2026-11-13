import { expect, test } from 'bun:test';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  evaluateReleaseDisposition, parseReleaseDispositionArtifact, releaseDispositionSha256, releaseDispositionSigningBytes,
  type ReleaseDispositionArtifact, type ReleaseDispositionContext,
} from './release-disposition.js';

// Ephemeral synthetic authorities; private keys never leave this test process.
const keys = { OP: generateKeyPairSync('ed25519'), JUD: generateKeyPairSync('ed25519') };
const sha = (text: string) => releaseDispositionSha256(text);
function fixture(waived = false) {
  const identity = { runId: 'fresh-run', cut: 'a'.repeat(40), version: '0.3.16', invocationId: 'fresh-invocation',
    imageDigest: `sha256:${sha('image')}`, graphSha256: sha('graph'), recipesSha256: sha('recipes'), policyVersion: 'critical-policy-v1', policySha256: sha('critical-policy-content'),
    ledgerSha256: sha('independently-enumerated-ledger'), tableSha256: sha('frozen-table'), checklistSha256: sha('current-checklist') };
  const observation = { nodeId: 'pwa', childRunId: 'fresh-child', attemptId: 'fresh-attempt',
    formalVerdict: waived ? 'fail' as const : 'pass' as const,
    bytes: Buffer.from(JSON.stringify({ formalVerdict: waived ? 'fail' : 'pass', detail: { all: 'original bytes' } })) };
  const execution = { nodeId: 'prepare', checkoutCommit: identity.cut, scriptSha256: sha('prepare script'), argvSha256: sha('argv'), cwd: '/isolated/cut' };
  const artifact: ReleaseDispositionArtifact = { schemaVersion: 1, identity, verdict: waived ? 'waived-known-issue' : 'pass',
    issuedAt: '2026-11-13T00:00:00.000Z', expiresAt: '2026-11-14T00:00:00.000Z', publishAt: '2026-11-13T20:00:00.000Z',
    outputs: [{ nodeId: observation.nodeId, childRunId: observation.childRunId, attemptId: observation.attemptId,
      formalVerdict: observation.formalVerdict, sha256: sha(Buffer.from(observation.bytes).toString()) }],
    executions: [execution], unmeasuredShards: [], introducedCritical: [], pendingEvidence: [], signatures: [] };
  const context: ReleaseDispositionContext = { identity: structuredClone(identity), now: Date.parse('2026-11-13T12:00:00.000Z'),
    publishAt: artifact.publishAt, artifactSha256: '', requiredOutputNodes: ['pwa'], observations: [observation],
    executions: [structuredClone(execution)], unmeasuredShards: [], introducedCritical: [], evidenceComplete: true,
    authorities: { OP: { keyId: 'op-current', verify: (bytes, signature) => verify(null, bytes, keys.OP.publicKey, Buffer.from(signature, 'base64')) },
      JUD: { keyId: 'jud-current', verify: (bytes, signature) => verify(null, bytes, keys.JUD.publicKey, Buffer.from(signature, 'base64')) } } };
  const seal = () => {
    artifact.signatures = artifact.verdict === 'waived-known-issue' ? (['OP', 'JUD'] as const).map(role => ({ role,
      keyId: context.authorities[role].keyId, signature: sign(null, releaseDispositionSigningBytes(artifact), keys[role].privateKey).toString('base64') })) : [];
    const bytes = Buffer.from(JSON.stringify(artifact));
    context.artifactSha256 = releaseDispositionSha256(bytes);
    return bytes;
  };
  const bytes = seal();
  return { artifact, context, seal, bytes, decide: () => evaluateReleaseDisposition(bytes, context) };
}

test('fresh normal PASS and signed known issue remain distinct, preserving formal failure', () => {
  const normal = fixture();
  expect(normal.decide().verdict).toBe('pass');
  const waived = fixture(true);
  expect(waived.decide().verdict).toBe('waived-known-issue');
  expect(waived.artifact.outputs[0]!.formalVerdict).toBe('fail');
  expect(parseReleaseDispositionArtifact(waived.bytes).identity.runId).toBe('fresh-run');
});

test('needs-evidence is collection state, never accepted PASS or an empty successful set', () => {
  const f = fixture();
  f.context.evidenceComplete = false;
  expect(f.decide()).toEqual({ verdict: 'needs-evidence', reason: 'evidence-incomplete' });
  f.context.evidenceComplete = true;
  f.artifact.verdict = 'needs-evidence';
  f.artifact.pendingEvidence = ['parent-child-receipt'];
  expect(evaluateReleaseDisposition(f.seal(), f.context).verdict).toBe('needs-evidence');
});

test.each(['runId', 'cut', 'version', 'invocationId', 'imageDigest', 'graphSha256', 'recipesSha256', 'policyVersion', 'policySha256',
  'ledgerSha256', 'tableSha256', 'checklistSha256'] as const)('rejects a changed runtime identity field: %s', field => {
  const f = fixture(true);
  f.context.identity[field] = `${f.context.identity[field]}-different`;
  expect(f.decide()).toEqual({ verdict: 'fail', reason: 'identity-mismatch' });
});

test('same policy version with different independently read policy bytes is rejected', () => {
  const f = fixture(true);
  const policyVersion = f.context.identity.policyVersion;
  f.context.identity.policySha256 = sha('replaced-policy-content');
  expect(f.context.identity.policyVersion).toBe(policyVersion);
  expect(f.decide()).toEqual({ verdict: 'fail', reason: 'identity-mismatch' });
});

test('rejects artifact byte changes even when only an unused metadata field changes', () => {
  const f = fixture(true);
  const bytes = Buffer.from(JSON.stringify({ ...f.artifact, note: 'changed' }));
  expect(evaluateReleaseDisposition(bytes, f.context)).toEqual({ verdict: 'fail', reason: 'artifact-sha-mismatch' });
});

test.each(['OP', 'JUD'] as const)('requires trusted %s signature over the whole payload', role => {
  const f = fixture(true);
  f.artifact.signatures = f.artifact.signatures.filter(s => s.role !== role);
  const bytes = Buffer.from(JSON.stringify(f.artifact));
  f.context.artifactSha256 = releaseDispositionSha256(bytes);
  expect(evaluateReleaseDisposition(bytes, f.context)).toEqual({ verdict: 'fail', reason: 'invalid-waiver-signature' });
});

test('a recomputed artifact hash cannot replace a signature after accepted scope changes', () => {
  const f = fixture(true);
  f.artifact.publishAt = f.context.publishAt = '2026-11-13T21:00:00.000Z';
  const bytes = Buffer.from(JSON.stringify(f.artifact));
  f.context.artifactSha256 = releaseDispositionSha256(bytes);
  expect(evaluateReleaseDisposition(bytes, f.context)).toEqual({ verdict: 'fail', reason: 'invalid-waiver-signature' });
});

test('rejects wrong authority, duplicate role and malformed signature instead of trusting role labels', () => {
  const f = fixture(true);
  f.context.authorities = { ...f.context.authorities, OP: { keyId: 'op-current', verify: (bytes, signature) => verify(null, bytes, generateKeyPairSync('ed25519').publicKey, Buffer.from(signature, 'base64')) } };
  expect(f.decide()).toEqual({ verdict: 'fail', reason: 'invalid-waiver-signature' });
  f.artifact.signatures.push(f.artifact.signatures[0]!);
  const duplicateBytes = Buffer.from(JSON.stringify(f.artifact));
  f.context.artifactSha256 = releaseDispositionSha256(duplicateBytes);
  expect(evaluateReleaseDisposition(duplicateBytes, f.context)).toEqual({ verdict: 'fail', reason: 'invalid-release-disposition-schema' });
  // Restore the trusted verifier so only the malformed proof can cause this rejection.
  f.context.authorities = fixture(true).context.authorities;
  f.artifact.signatures = [{ role: 'OP', keyId: 'op-current', signature: 'not-a-signature' }];
  const invalidBytes = Buffer.from(JSON.stringify(f.artifact));
  f.context.artifactSha256 = releaseDispositionSha256(invalidBytes);
  expect(evaluateReleaseDisposition(invalidBytes, f.context)).toEqual({ verdict: 'fail', reason: 'invalid-waiver-signature' });
});

test('rejects an expired/future artifact and changed publishAt', () => {
  const f = fixture(true);
  f.context.now = Date.parse(f.artifact.expiresAt);
  expect(f.decide().verdict).toBe('fail');
  f.context.now = Date.parse(f.artifact.issuedAt) - 1;
  expect(f.decide().verdict).toBe('fail');
  f.context.now = Date.parse(f.artifact.issuedAt);
  f.context.publishAt = '2026-11-13T22:00:00.000Z';
  expect(f.decide()).toEqual({ verdict: 'fail', reason: 'publish-at-mismatch' });
});

test('independent shard set, not signed assertions alone, governs acceptance', () => {
  const f = fixture(true);
  f.context.unmeasuredShards = ['missing-parent'];
  expect(f.decide()).toEqual({ verdict: 'fail', reason: 'independent-evidence-set-mismatch' });
  f.artifact.unmeasuredShards = ['missing-parent'];
  expect(evaluateReleaseDisposition(f.seal(), f.context).verdict).toBe('waived-known-issue');
});

test('a new critical failure cannot be waived or become PASS', () => {
  const f = fixture(true);
  f.artifact.introducedCritical = ['new-session-isolation'];
  f.context.introducedCritical = ['new-session-isolation'];
  expect(evaluateReleaseDisposition(f.seal(), f.context)).toEqual({ verdict: 'fail', reason: 'new-critical-failure' });
});

test('whole output bytes reject detail tampering and forged PWA ok despite same projected fields', () => {
  const f = fixture(true);
  f.context.observations = [{ ...f.context.observations[0]!, bytes: Buffer.from('{"formalVerdict":"fail","detail":{"all":"tampered"}}') }];
  expect(f.decide()).toEqual({ verdict: 'fail', reason: 'original-output-mismatch' });
  f.context.observations = [{ ...f.context.observations[0]!, formalVerdict: 'pass', bytes: Buffer.from('{"outcome":"ok"}') }];
  expect(f.decide()).toEqual({ verdict: 'fail', reason: 'original-output-mismatch' });
});

test.each(['childRunId', 'attemptId'] as const)('does not substitute another %s', field => {
  const f = fixture(true);
  f.context.observations = [{ ...f.context.observations[0]!, [field]: 'other' }];
  expect(f.decide()).toEqual({ verdict: 'fail', reason: 'original-output-mismatch' });
});

test('a recorded waiver cannot be bypassed with a fresh forged normal-PASS artifact', () => {
  const old = fixture(true);
  const forged = fixture();
  forged.context.recordedWaiverSha256 = old.context.artifactSha256;
  expect(forged.decide()).toEqual({ verdict: 'fail', reason: 'waiver-lineage-mismatch' });
  old.context.recordedWaiverSha256 = old.context.artifactSha256;
  expect(old.decide().verdict).toBe('waived-known-issue');
});

test.each(['checkoutCommit', 'scriptSha256', 'argvSha256', 'cwd'] as const)('binds actual execution source: %s', field => {
  const f = fixture(true);
  f.context.executions = [{ ...f.context.executions[0]!, [field]: field === 'cwd' ? '/other/checkout' : field === 'checkoutCommit' ? 'b'.repeat(40) : sha('other') }];
  expect(f.decide()).toEqual({ verdict: 'fail', reason: 'execution-source-mismatch' });
});

test('a signed main-only script checkout is still rejected: A requires a new cut containing the scripts', () => {
  const f = fixture(true);
  f.artifact.executions[0]!.checkoutCommit = 'b'.repeat(40);
  f.context.executions = structuredClone(f.artifact.executions);
  expect(evaluateReleaseDisposition(f.seal(), f.context)).toEqual({ verdict: 'fail', reason: 'execution-source-mismatch' });
});

test('omitted/duplicate observations and consumer execution entries do not silently pass', () => {
  const f = fixture(true);
  f.context.observations = [];
  expect(f.decide().verdict).toBe('fail');
  f.context.observations = fixture(true).context.observations;
  f.context.executions = [];
  expect(f.decide().verdict).toBe('fail');
  f.context.executions = [f.artifact.executions[0]!, f.artifact.executions[0]!];
  expect(f.decide().verdict).toBe('fail');
});

test('recorded fail, PASS with unmeasured evidence and no-failure waiver are not accepted', () => {
  const f = fixture();
  f.artifact.verdict = 'fail';
  expect(evaluateReleaseDisposition(f.seal(), f.context)).toEqual({ verdict: 'fail', reason: 'recorded-failure' });
  f.artifact.verdict = 'pass';
  f.artifact.unmeasuredShards = ['parent']; f.context.unmeasuredShards = ['parent'];
  expect(evaluateReleaseDisposition(f.seal(), f.context).verdict).toBe('fail');
  const w = fixture(); w.artifact.verdict = 'waived-known-issue';
  expect(evaluateReleaseDisposition(w.seal(), w.context)).toEqual({ verdict: 'fail', reason: 'waiver-without-original-failure' });
});

test('untrusted malformed JSON and schema versions are fail closed without raw data in errors', () => {
  const f = fixture();
  for (const text of ['{broken', 'null', '[]', JSON.stringify({ ...f.artifact, schemaVersion: 2 })]) {
    expect(evaluateReleaseDisposition(Buffer.from(text), f.context)).toEqual({ verdict: 'fail', reason: 'invalid-release-disposition-schema' });
  }
});
