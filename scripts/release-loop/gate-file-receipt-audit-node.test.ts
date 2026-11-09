import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { auditGateFileReceipts } from './gate-file-receipt-audit-node.js';
import { gateFileReceiptClosureDigest, gateFileReceiptIdentityFromClosure, gateFileReceiptKey, type GateFileReceipt } from './gate-file-receipts.js';
import type { GraphContext } from './node-verdict.js';

const COMMIT = 'a'.repeat(40);
const IMAGE = 'sha256:' + 'b'.repeat(64);
const FILE = 'scripts/fixture.test.ts';
const tree = (read: (path: string) => string | undefined) => ({ files: [FILE], read, preload: [] as string[] });
const context: GraphContext = { runId: 'audit-run', input: { version: '0.3.8', previousVersion: '0.3.7' },
  outputs: { cutoff: { commit: COMMIT }, gate: { outcome: 'ok', introduced: [] } } };

function receiptFor(source: string): GateFileReceipt {
  const identity = gateFileReceiptIdentityFromClosure(tree(() => source), FILE, IMAGE)!;
  const key = gateFileReceiptKey(identity)!;
  const closureDigest = createHash('sha256').update(JSON.stringify(identity.closureFiles.map((path) => [path, identity.contentHashes[path]]))).digest('hex');
  return { file: FILE, closureFiles: [...identity.closureFiles], closureDigest, imageDigest: IMAGE, key,
    sourceHead40: COMMIT, outcome: 'pass', evidence: { source: 'gate-flow-sim' } };
}

test('receipt audit uses the latest gate visit instead of a stale residual verdict', () => {
  const stale = { outcome: 'ok', introduced: [] };
  const current = { outcome: 'error', summary: 'fresh gate execution failed' };
  const result = auditGateFileReceipts({ ...context, outputs: { ...context.outputs, gate: current, 'residual-run': stale },
    nodeHistory: [{ nodeId: 'residual-run', output: stale }, { nodeId: 'gate', output: current }] }, {
      repo: '/repo', roots: { instance: '/instance', ledger: '/ledger' }, testsAtCommit: () => [FILE],
      closureTree: () => tree(() => 'test'), pinnedImage: () => IMAGE, readReceipt: () => null });
  expect(result).toMatchObject({ outcome: 'fail', otherFailures: ['fresh gate execution failed'] });
});

test('receipt audit accepts a cross-run CAS receipt only when its carried head matches the audited cut', () => {
  const source = 'test("fixture", () => expect(true).toBe(true));';
  const receipt = receiptFor(source);
  const carried = { ...receipt, sourceHead40: 'd'.repeat(40), carriedToHead40: COMMIT };
  const deps = { repo: '/repo', roots: { instance: '/instance', ledger: '/ledger' },
    testsAtCommit: () => [FILE], closureTree: () => tree(() => source), pinnedImage: () => IMAGE,
    readReceipt: () => ({ ...carried, recordSha256: 'c'.repeat(64) }) };
  expect(auditGateFileReceipts(context, deps)).toMatchObject({ outcome: 'ok',
    measurement: { complete: true, totalFiles: 1, coveredFiles: 1, unmeasuredFiles: 0 } });
  expect(auditGateFileReceipts(context, { ...deps,
    readReceipt: () => ({ ...carried, carriedToHead40: 'e'.repeat(40), recordSha256: 'c'.repeat(64) }) }))
    .toMatchObject({ outcome: 'fail', measurement: { complete: false, coveredFiles: 0, unmeasuredFiles: 1 } });
  expect(auditGateFileReceipts(context, { ...deps,
    readReceipt: () => ({ ...carried, carriedToHead40: undefined, recordSha256: 'c'.repeat(64) }) }))
    .toMatchObject({ outcome: 'fail', measurement: { complete: false, coveredFiles: 0, unmeasuredFiles: 1 } });
});

test('receipt audit covers the exact closure/image identity and rejects stale or missing file receipts', () => {
  const source = 'test("fixture", () => expect(true).toBe(true));';
  const receipt = receiptFor(source);
  const deps = { repo: '/repo', roots: { instance: '/instance', ledger: '/ledger' },
    testsAtCommit: () => [FILE], closureTree: () => tree(() => source), pinnedImage: () => IMAGE,
    readReceipt: (_root: string, key: string) => key === receipt.key ? { ...receipt, recordSha256: 'c'.repeat(64) } : null };
  expect(auditGateFileReceipts(context, deps)).toMatchObject({ outcome: 'ok', commit: COMMIT,
    measurement: { complete: true, totalFiles: 1, coveredFiles: 1, unmeasuredFiles: 0 } });
  expect(auditGateFileReceipts(context, { ...deps, readReceipt: () => null })).toMatchObject({ outcome: 'fail',
    measurement: { complete: false, totalFiles: 1, coveredFiles: 0, unmeasuredFiles: 1 } });
  expect(auditGateFileReceipts(context, { ...deps, closureTree: () => tree(() => undefined) })).toMatchObject({ outcome: 'fail',
    measurement: { complete: false, totalFiles: 1, coveredFiles: 0, unmeasuredFiles: 1 }, summary: expect.stringContaining('1 opaque closure(s)') });
  expect(auditGateFileReceipts({ ...context, outputs: { ...context.outputs, gate: { outcome: 'fail', introduced: ['src/broken.test.ts'] } } },
    { ...deps, readReceipt: (_root: string, key: string) => key === receipt.key ? { ...receipt, recordSha256: 'c'.repeat(64) } : null }))
    .toMatchObject({ outcome: 'fail', verdict: 'fail', introduced: ['src/broken.test.ts'], measurement: { complete: true } });
  expect(auditGateFileReceipts({ ...context, outputs: { ...context.outputs, gate: { outcome: 'error', summary: 'executor unavailable' } } },
    { ...deps, readReceipt: (_root: string, key: string) => key === receipt.key ? { ...receipt, recordSha256: 'c'.repeat(64) } : null }))
    .toMatchObject({ outcome: 'fail', verdict: 'fail', otherFailures: ['executor unavailable'] });
});

test('opaque receipts count only when measured in this graph run and remain counted beside another missing file', () => {
  const opaqueFile = FILE;
  const missingFile = 'scripts/missing.test.ts';
  const source = "import { readFileSync } from 'node:fs'; test('opaque', () => readFileSync(process.env.FIXTURE!, 'utf8'));";
  const files = [opaqueFile, missingFile];
  const closure = { files, preload: [] as string[], read: (path: string) => path === opaqueFile ? source : path === missingFile ? "test('missing', () => {});" : undefined };
  const identity = gateFileReceiptIdentityFromClosure(closure, opaqueFile, IMAGE)!;
  // Source: the closure analyzer reports a non-empty reason list for the dynamic process.env read above.
  expect(identity.opaqueReasons).toBeDefined();
  expect(identity.opaqueReasons).not.toEqual([]);
  const receipt: GateFileReceipt = { file: opaqueFile, closureFiles: [...identity.closureFiles],
    closureDigest: gateFileReceiptClosureDigest(identity), imageDigest: IMAGE, key: gateFileReceiptKey(identity)!,
    sourceHead40: COMMIT, outcome: 'pass', opaqueReasons: [...identity.opaqueReasons!], evidence: { runId: context.runId } };
  const recordSha256 = createHash('sha256').update('opaque-receipt-record').digest('hex');
  const expectedCoveredFiles = [opaqueFile].length;
  const deps = { repo: '/repo', roots: { instance: '/instance', ledger: '/ledger' }, testsAtCommit: () => files,
    closureTree: () => closure, pinnedImage: () => IMAGE,
    readReceipt: (_root: string, key: string) => key === receipt.key ? { ...receipt, recordSha256 } : null };
  expect(auditGateFileReceipts(context, deps)).toMatchObject({ outcome: 'fail',
    measurement: { complete: false, totalFiles: files.length, coveredFiles: expectedCoveredFiles,
      unmeasuredFiles: files.length - expectedCoveredFiles } });
  expect(auditGateFileReceipts(context, { ...deps,
    readReceipt: () => ({ ...receipt, evidence: { runId: 'previous-graph-run' }, recordSha256 }) }))
    .toMatchObject({ outcome: 'fail', measurement: { complete: false, coveredFiles: [].length,
      unmeasuredFiles: files.length } });
});
