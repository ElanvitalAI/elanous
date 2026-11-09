import { expect, test } from 'bun:test';
import { trainGateCasLane, type GateFilePlanLike } from '../../scripts/release-loop/gate-train-cas-adapter.js';

const receiptKey = (char: string) => char.repeat(64);
const expectedFiles = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'];
type FileCasIdentity = { file: string; closureFiles: string[]; contentHashes: Record<string, string>; imageDigest: string };
type FileCasReceipt = { file: string; key: string; outcome: string; closureDigest: string; imageDigest: string; sourceHead40: string };
const plan: GateFilePlanLike<FileCasIdentity, FileCasReceipt> = {
  reuse: [{ file: 'test/a.test.ts', key: receiptKey('a'), outcome: 'pass', closureDigest: receiptKey('b'),
    imageDigest: `sha256:${receiptKey('d')}`, sourceHead40: receiptKey('e').slice(0, 40) }],
  measure: [
    { file: 'test/b.test.ts', closureFiles: ['src/b.ts', 'test/b.test.ts'], contentHashes: { 'src/b.ts': receiptKey('b'), 'test/b.test.ts': receiptKey('c') }, imageDigest: `sha256:${receiptKey('d')}` },
    { file: 'test/c.test.ts', closureFiles: ['test/c.test.ts'], contentHashes: { 'test/c.test.ts': receiptKey('e') }, imageDigest: `sha256:${receiptKey('d')}` },
  ],
};

test('M4.5 lane simulation selects exactly the uncovered test files for the gate runner', () => {
  expect(trainGateCasLane(plan, expectedFiles)).toEqual({ action: 'run-uncovered',
    files: ['test/b.test.ts', 'test/c.test.ts'], receiptKeys: [receiptKey('a')], knownNonPassingFiles: [] });
});

test('M4.5 lane simulation fails closed for incomplete, duplicated, unsafe, or previously failing inventory', () => {
  expect(trainGateCasLane({ ...plan, measure: plan.measure.slice(0, 1) }, expectedFiles))
    .toEqual({ action: 'full-gate', reason: 'file-cas-inventory-mismatch' });
  expect(trainGateCasLane({ ...plan, measure: [...plan.measure, plan.measure[0]!] }, expectedFiles))
    .toEqual({ action: 'full-gate', reason: 'file-cas-inventory-mismatch' });
  expect(trainGateCasLane({ reuse: [], measure: [{ file: '../escape.test.ts' }] }, ['../escape.test.ts']))
    .toEqual({ action: 'full-gate', reason: 'file-cas-expected-inventory-invalid' });
  const failedPlan: GateFilePlanLike<FileCasIdentity, FileCasReceipt> = { ...plan,
    reuse: [...plan.reuse, { file: 'test/b.test.ts', key: receiptKey('f'), outcome: 'fail',
      closureDigest: receiptKey('b'), imageDigest: `sha256:${receiptKey('d')}`, sourceHead40: receiptKey('e').slice(0, 40) }],
    measure: [plan.measure[1]!] };
  expect(trainGateCasLane(failedPlan, expectedFiles)).toMatchObject({ action: 'run-uncovered',
    files: ['test/b.test.ts', 'test/c.test.ts'], receiptKeys: [receiptKey('a')], knownNonPassingFiles: ['test/b.test.ts'] });
});
