import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { gateFileReceiptKey, type GateFileReceiptIdentity } from '../../scripts/release-loop/gate-file-receipts.js';
import { makeGateFileReceiptSimulationReceipt, type GateSweepCertificate } from './gate-receipt-file-closure-cas.js';
import { simulateGateSteadyStateProof, type GateSteadyStateProofInput } from './gate-steady-state-proof-sim.js';

const train = '1'.repeat(40), cut = '2'.repeat(40), image = `sha256:${'a'.repeat(64)}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identities: GateFileReceiptIdentity[] = Array.from({ length: 10 }, (_, index) => {
  const file = `test/suite-${index}.test.ts`;
  return { file, closureFiles: [file], contentHashes: { [file]: hash(file) }, imageDigest: image };
});
const certificate: GateSweepCertificate = { sourceHead40: train, imageDigest: image,
  fileKeys: Object.fromEntries(identities.map((row) => [row.file, gateFileReceiptKey(row)!])),
  // source: #36052 fixture example; policy-invalid variants are boundary probes, not runtime thresholds.
  measuredAt: 1_000, maxAgeMs: 60_000, maxDirtyRatio: 0.1, sweepConcurrency: 24,
  thresholdSource: 'fixture: recorded sweep policy' };
const input = (): GateSteadyStateProofInput => ({ cutHead40: cut, trainHead40: train, nowMs: 21_000,
  identities, certificate, trainReceipts: identities.slice(0, 7).map((row) => makeGateFileReceiptSimulationReceipt(row, train, 'train-run-1')),
  cutInvocations: [{ runId: 'cut-run-1', cutHead40: cut,
    selectedFiles: identities.slice(7).map((row) => row.file), outcome: 'pass' }] });

test('GATE-STEADY-STATE-PROOF · one cut reports all four measured dimensions from receipt and certificate evidence', () => {
  expect(simulateGateSteadyStateProof(input())).toEqual({ gateRunsForCut: 1, residualFiles: 3, totalFiles: 10,
    certificateAgeMs: 20_000, trainReceiptFiles: 7, trainReceiptRatio: 0.7, complete: true, reasons: [] });
});

test('same-cut duplicate, stale certificate, and incomplete train proof fail closed', () => {
  const base = input();
  const duplicate = simulateGateSteadyStateProof({ ...base, cutInvocations: [...base.cutInvocations, { ...base.cutInvocations[0]!, runId: 'cut-run-2' }] });
  expect(duplicate).toMatchObject({ gateRunsForCut: 2, complete: false, reasons: ['cut-gate-run-count'] });
  const stale = simulateGateSteadyStateProof({ ...base, nowMs: 62_000 });
  expect(stale).toMatchObject({ certificateAgeMs: 61_000, complete: false, reasons: ['certificate-age-invalid'] });
  const missing = simulateGateSteadyStateProof({ ...base, trainReceipts: base.trainReceipts.slice(1) });
  expect(missing).toMatchObject({ trainReceiptFiles: 6, residualFiles: 4, complete: false });
  expect(missing.reasons).toContain('cut-gate-incomplete');
  const wrongHead = simulateGateSteadyStateProof({ ...base, trainReceipts: [{ ...base.trainReceipts[0]!, sourceHead40: cut }, ...base.trainReceipts.slice(1)] });
  expect(wrongHead.reasons).toContain('train-receipts-invalid');
  for (const maxAgeMs of [NaN, Infinity, -1]) {
    expect(simulateGateSteadyStateProof({ ...base, certificate: { ...certificate, maxAgeMs } }).reasons)
      .toContain('certificate-age-invalid');
  }
  expect(simulateGateSteadyStateProof({ ...base, cutHead40: '' }).reasons).toContain('invalid-head');
  expect(simulateGateSteadyStateProof({ ...base, trainHead40: '' }).reasons).toContain('invalid-head');
});

test('invalid sweep certificate policy fields fail closed', () => {
  const invalidCertificates: GateSweepCertificate[] = [
    { ...certificate, sweepConcurrency: 0 },
    { ...certificate, measuredAt: Number.NaN },
    // source: #36052 boundary probe, intentionally outside the [0, 1] policy range.
    { ...certificate, maxDirtyRatio: 1.1 },
    { ...certificate, thresholdSource: '  ' },
  ];
  for (const invalidCertificate of invalidCertificates) {
    const proof = simulateGateSteadyStateProof({ ...input(), certificate: invalidCertificate });
    expect(proof.complete).toBe(false);
    expect(proof.reasons).toContain('certificate-policy-invalid');
  }
});
