import { expect, test } from 'bun:test';
import { decideGateSkipByEvidence, skipGateFromContext, type SkipEvidenceAudit } from './gate-skip-by-evidence-node.js';
import type { GraphContext } from './node-verdict.js';

const CUT = 'a'.repeat(40);
const audit = (): SkipEvidenceAudit => ({ commit: CUT,
  measurement: { complete: true, totalFiles: 4, coveredFiles: 4, unmeasuredFiles: 0 },
  introduced: [], ledgerDefects: [{ kind: 'receipt-write', detail: 'HQ ledger write failed after all four files ran' }], otherFailures: [] });

test('completed audit with introduced 0 and a ledger write defect takes the evidence edge', () => {
  const context = { input: { version: '0.3.8', previousVersion: '0.3.7' },
    outputs: { cutoff: { commit: CUT }, 'receipt-audit': audit() } } as unknown as GraphContext;
  expect(skipGateFromContext(context)).toMatchObject({ outcome: 'ok', eligible: true, commit: CUT,
    evidence: { totalFiles: 4, coveredFiles: 4, unmeasuredFiles: 0 }, knownIssues: [] });
});

test('missing coverage, opaque gap, and inconsistent counts cannot skip', () => {
  for (const measurement of [
    { complete: false, totalFiles: 4, coveredFiles: 4, unmeasuredFiles: 0 },
    { complete: true, totalFiles: 4, coveredFiles: 3, unmeasuredFiles: 1 },
    { complete: true, totalFiles: 4, coveredFiles: 3, unmeasuredFiles: 0 },
  ]) expect(decideGateSkipByEvidence({ ...audit(), measurement }, CUT).eligible).toBe(false);
});

test('introduced, other failures, unknown defects, and mismatched cut refuse the edge', () => {
  const base = audit();
  for (const value of [
    { ...base, introduced: ['src/a.test.ts > regression'] },
    { ...base, otherFailures: ['artifact build failed'] },
    { ...base, ledgerDefects: [{ kind: 'cleanup', detail: 'failed' }] },
    { ...base, ledgerDefects: [] },
    { ...base, commit: 'b'.repeat(40) },
  ]) expect(decideGateSkipByEvidence(value, CUT)).toMatchObject({ outcome: 'fail', eligible: false, knownIssues: [] });
});
