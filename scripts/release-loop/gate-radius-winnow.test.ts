import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateFileReceiptClosureDigest, gateFileReceiptKey, type GateFileReceiptEnvelope, type GateFileReceiptIdentity } from './gate-file-receipts.js';
import { gateFileReceiptIdentityFromClosure } from './gate-file-receipts.js';
import { gitClosureTree } from './gate-closure.js';
import { gateLockfileHashAtCommit } from './gate-reuse-identity.js';
import { planGateRadiusWinnow, planGateRadiusWinnowAtCut, type GateRadiusWinnowInput } from './gate-radius-winnow.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const IMAGE = 'sha256:' + 'c'.repeat(64);
const LOCK = 'd'.repeat(64);
const file = (name: string, content: string, dependency = 'src/shared.ts'): GateFileReceiptIdentity => ({
  file: name, closureFiles: [name, dependency].sort(),
  contentHashes: { [name]: content.repeat(64), [dependency]: 'e'.repeat(64) }, imageDigest: IMAGE,
});
const priorIdentities = [file('src/changed.test.ts', '1'), file('src/other.test.ts', '2', 'src/other.ts')];
const receipt = (identity: GateFileReceiptIdentity, sourceHead40 = A): GateFileReceiptEnvelope => {
  const body = {
  file: identity.file, closureFiles: [...identity.closureFiles],
  closureDigest: gateFileReceiptClosureDigest(identity), imageDigest: IMAGE,
  key: gateFileReceiptKey(identity)!, sourceHead40, outcome: 'pass', lane: 'cut',
  evidence: { runId: 'run-a', shardId: 'pod-0', testIds: [identity.file + ' > passes'] },
  } as const;
  return { ...body, closureFiles: [...body.closureFiles], recordSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
};
const base = (): GateRadiusWinnowInput => ({
  priorRunId: 'run-a', priorCutSha: A, priorVerdict: 'ok', priorExpectedFiles: priorIdentities.map((row) => row.file),
  priorFiles: priorIdentities.map((identity) => ({ file: identity.file, outcome: 'pass' as const, judgedRunId: 'run-a',
    sourceRunId: 'run-a', sourceCutSha: A, judgedReceiptSha256: receipt(identity).recordSha256,
    priorIdentity: identity, receipt: receipt(identity) })),
  priorImageDigest: IMAGE, priorLockfileHash: LOCK, newCutSha: B, currentImageDigest: IMAGE,
  currentLockfileHash: LOCK, current: [file('src/changed.test.ts', '3'), priorIdentities[1]!],
  changedFiles: ['src/changed.test.ts'],
});

test('GATE-RADIUS-WINNOW cut wrapper computes Git diff and import closure from both immutable trees', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-winnow-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q'); git('config', 'user.name', 'TF Test'); git('config', 'user.email', 'tf@example.invalid');
    mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'bun.lock'), 'lock-a');
    writeFileSync(join(repo, 'apps/pwa/bun.lock'), 'lock-b');
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 1;\n');
    writeFileSync(join(repo, 'src/a.test.ts'), "import { a } from './a';\ntest('a', () => { if (!a) throw Error('a'); });\n");
    writeFileSync(join(repo, 'src/b.test.ts'), "import { b } from './b';\ntest('b', () => { if (!b) throw Error('b'); });\n");
    git('add', '.'); git('commit', '-qm', 'prior');
    const priorCutSha = git('rev-parse', 'HEAD');
    const tree = gitClosureTree(repo, priorCutSha);
    const priorFiles = ['src/a.test.ts', 'src/b.test.ts'].map((name) => {
      const identity = gateFileReceiptIdentityFromClosure(tree, name, IMAGE)!;
      return { file: name, outcome: 'pass' as const, judgedRunId: 'run-a', sourceRunId: 'run-a',
        sourceCutSha: priorCutSha, judgedReceiptSha256: receipt(identity, priorCutSha).recordSha256,
        receipt: receipt(identity, priorCutSha) };
    });
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
    git('add', '.'); git('commit', '-qm', 'change a');
    const newCutSha = git('rev-parse', 'HEAD');
    const decision = planGateRadiusWinnowAtCut({ repo, priorRunId: 'run-a', priorCutSha, newCutSha,
      priorVerdict: 'ok', priorExpectedFiles: ['src/a.test.ts', 'src/b.test.ts'], priorFiles,
      priorImageDigest: IMAGE, currentImageDigest: IMAGE, priorLockfileHash: gateLockfileHashAtCommit(repo, priorCutSha)! });
    expect(decision).toMatchObject({ action: 'radius', measure: ['src/a.test.ts'],
      carry: [{ file: 'src/b.test.ts', sourceRunId: 'run-a', sourceCutSha: priorCutSha }], reuseRatio: 0.5 });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('GATE-RADIUS-WINNOW selects only changed closure and links a carried file to source run and cut', () => {
  const decision = planGateRadiusWinnow(base());
  expect(decision).toMatchObject({ action: 'radius', priorRunId: 'run-a', priorCutSha: A, newCutSha: B,
    measure: ['src/changed.test.ts'], total: 2, reuseRatio: 0.5,
    carry: [{ file: 'src/other.test.ts', sourceRunId: 'run-a', sourceCutSha: A }] });
});

test('GATE-RADIUS-WINNOW uses the T1 content key when changed code reaches one test', () => {
  const input = base();
  input.changedFiles = ['src/shared.ts'];
  input.current = [{ ...priorIdentities[0]!, contentHashes: { ...priorIdentities[0]!.contentHashes,
    'src/shared.ts': 'f'.repeat(64) } }, priorIdentities[1]!];
  expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'radius', measure: ['src/changed.test.ts'],
    carry: [{ file: 'src/other.test.ts' }], reuseRatio: 0.5 });
});

test('GATE-RADIUS-WINNOW measures a new test under test/ while carrying unrelated passes', () => {
  const input = base();
  input.changedFiles = ['test/ordinary.test.ts'];
  input.current = [...priorIdentities, file('test/ordinary.test.ts', '3')];
  expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'radius',
    measure: ['test/ordinary.test.ts'], reuseRatio: 2 / 3 });
});

test('GATE-RADIUS-WINNOW keeps incomplete or HITL terminal passes but remeasures failures and missing files', () => {
  for (const verdict of ['incomplete', 'hitl'] as const) {
    const input = base();
    input.priorVerdict = verdict;
    input.changedFiles = [];
    input.current = [...priorIdentities];
    input.priorFiles = [{ ...input.priorFiles[0]!, outcome: 'fail', receipt: undefined }, input.priorFiles[1]!];
    expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'radius', measure: ['src/changed.test.ts'],
      carry: [{ file: 'src/other.test.ts' }], reuseRatio: 0.5 });
    input.priorFiles = [input.priorFiles[1]!];
    expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'radius', measure: ['src/changed.test.ts'],
      carry: [{ file: 'src/other.test.ts' }] });
  }
});

test('GATE-RADIUS-WINNOW fails full on image, lock, fixture, or incomplete clean provenance', () => {
  const drift = [
    { currentImageDigest: 'sha256:' + 'f'.repeat(64) },
    { currentLockfileHash: 'f'.repeat(64) },
    { changedFiles: ['test/fixtures/data.md'] },
    { changedFiles: ['test/fixtures/data.ts'] },
    { changedFiles: ['test/fixtures/data.test.ts'] },
    { changedFiles: ['config/gate.yaml'] },
    { changedFiles: ['config/gate.ts'] },
    { changedFiles: ['vitest.config.ts'] },
    { changedFiles: ['src/data.fixture.ts'] },
    { priorFiles: [base().priorFiles[0]!] },
  ];
  for (const change of drift) expect(planGateRadiusWinnow({ ...base(), ...change })).toMatchObject({ action: 'full', reuseRatio: 0 });
});

test('GATE-RADIUS-WINNOW rejects stale or spoofed file provenance for carry', () => {
  const input = base();
  input.changedFiles = [];
  input.current = [...priorIdentities];
  input.priorFiles = [{ ...input.priorFiles[0]!, sourceRunId: 'other-run' }, input.priorFiles[1]!];
  expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'full', reuseRatio: 0 });
  input.priorFiles = [{ ...base().priorFiles[0]!, sourceCutSha: B }, input.priorFiles[1]!];
  expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'full', reuseRatio: 0 });
  input.priorFiles = [{ ...base().priorFiles[0]!, receipt: { ...base().priorFiles[0]!.receipt!, recordSha256: 'f'.repeat(64) } }, input.priorFiles[1]!];
  expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'full', reuseRatio: 0 });
  input.priorFiles = [{ ...base().priorFiles[0]!, judgedReceiptSha256: undefined }, input.priorFiles[1]!];
  expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'full', reuseRatio: 0 });
  input.priorFiles = [{ ...base().priorFiles[0]!, priorIdentity: file('src/changed.test.ts', '9') }, input.priorFiles[1]!];
  expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'full', reuseRatio: 0 });
  input.priorFiles = [{ ...base().priorFiles[0]!, receipt: { ...base().priorFiles[0]!.receipt!, recordSha256: 'f'.repeat(64) } }, input.priorFiles[1]!];
  input.changedFiles = ['src/changed.test.ts'];
  expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'full', reuseRatio: 0 });
  input.priorFiles = [{ ...base().priorFiles[0]!, outcome: 'fail', receipt: {
    ...base().priorFiles[0]!.receipt!, outcome: 'fail', recordSha256: 'f'.repeat(64) } }, input.priorFiles[1]!];
  expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'full', reuseRatio: 0 });
  input.changedFiles = [];
  const oldReceipt = base().priorFiles[0]!.receipt!;
  const { recordSha256: _oldHash, ...oldBody } = oldReceipt;
  const tamperedBody = { ...oldBody, evidence: { ...(oldReceipt.evidence as Record<string, unknown>), runId: 'other-run' } };
  const tamperedReceipt = { ...tamperedBody, recordSha256: createHash('sha256').update(JSON.stringify(tamperedBody)).digest('hex') };
  input.priorFiles = [{ ...base().priorFiles[0]!, sourceRunId: 'other-run', receipt: tamperedReceipt }, input.priorFiles[1]!];
  expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'full', reuseRatio: 0 });
  input.priorFiles = [{ ...base().priorFiles[0]!, judgedRunId: 'other-run' }, input.priorFiles[1]!];
  expect(planGateRadiusWinnow(input)).toMatchObject({ action: 'full', reuseRatio: 0 });
});
