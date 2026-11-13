/** Opt-in cut selector: inherit only terminal passing file results from one judged run. */
import { createHash } from 'node:crypto';
import { gateFileReceiptClosureDigest, gateFileReceiptIdentityFromClosure, gateFileReceiptKey, planGateFileReceipts, type GateFileReceipt, type GateFileReceiptEnvelope,
  type GateFileReceiptIdentity } from './gate-file-receipts.js';
import { CODE_FILE, gitClosureTree } from './gate-closure.js';
import { changedFilesBetween } from './gate-partial.js';
import { gateAssignableTestsAtCommit } from './gate-baseline-receipt.js';
import { gateLockfileHashAtCommit } from './gate-reuse-identity.js';

const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^sha256:[a-f0-9]{64}$/i;
const HEX = /^[a-f0-9]{64}$/i;
const TEST = /\.test\.(?:tsx?|jsx?|mts|cts)$/;
const TEST_INPUT = /(?:^|\/)(?:test|tests|fixtures|__fixtures__|__snapshots__|__mocks__)\//;
const FIXTURE_PATH = /(?:^|\/)(?:fixtures|__fixtures__|__snapshots__|__mocks__)\//;
const CONFIG_INPUT = /(?:^|\/)(?:config|configs)\//;
const CONFIG_FILE = /(?:^|\/)(?:[^/]+\.config|config)(?:\.[^/]+)+$/i;
const FIXTURE_FILE = /(?:^|\/)[^/]+\.(?:fixture|mock|snapshot)\.[^/]+$/i;
const NONCODE = /\.(?:json|ya?ml|toml|lock|css|html|sql|svg|png|jpe?g|webp|xml|txt)$/i;

export interface WinnowSourceFile {
  file: string;
  outcome: 'pass' | 'fail' | 'error' | 'unmeasured';
  /** The judged run whose result inventory contains this row. */
  judgedRunId: string;
  /** The measurement's original run/cut, retained through earlier carries. */
  sourceRunId?: string;
  sourceCutSha?: string;
  /** Hash from the canonical judged result inventory, loaded separately from the source receipt. */
  judgedReceiptSha256?: string;
  /** Canonical loader checked a carried source against its immutable judged attempt. */
  sourceJudgedVerified?: true;
  /** Source cut identity reconstructed from its immutable Git tree by the cut wrapper. */
  priorIdentity?: GateFileReceiptIdentity;
  receipt?: GateFileReceiptEnvelope;
}

export interface GateRadiusWinnowInput {
  priorRunId: string;
  priorCutSha: string;
  priorVerdict: 'ok' | 'regression' | 'error' | 'incomplete' | 'hitl';
  priorExpectedFiles: readonly string[];
  priorFiles: readonly WinnowSourceFile[];
  priorImageDigest: string;
  priorLockfileHash: string;
  newCutSha: string;
  currentImageDigest: string;
  currentLockfileHash: string;
  current: readonly GateFileReceiptIdentity[];
  /** Exact git object diff between priorCutSha and newCutSha. */
  changedFiles: readonly string[];
}

export type GateRadiusWinnowDecision =
  | { action: 'full'; reason: string; priorRunId: string; priorCutSha: string; newCutSha: string; reuseRatio: 0 }
  | { action: 'radius'; reason: string; priorRunId: string; priorCutSha: string; newCutSha: string;
      carry: Array<{ file: string; key: string; sourceRunId: string; sourceCutSha: string }>;
      measure: string[]; total: number; reuseRatio: number };

const validRunId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const validFile = (value: string): boolean => /^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/.test(value)
  && !value.split('/').includes('..');

/** Any untraceable non-code input or dependency layer changes cause a full cut. */
function fullChangingInput(changed: readonly string[]): string | null {
  for (const file of changed) {
    if (typeof file !== 'string' || file.startsWith('/') || file.split('/').includes('..')) return 'unsafe changed path';
    if (CONFIG_INPUT.test(file) || CONFIG_FILE.test(file) || FIXTURE_PATH.test(file) || FIXTURE_FILE.test(file)
      || NONCODE.test(file) || file === 'bun.lock' || file === 'Dockerfile')
      return `noncode input changed: ${file}`;
    if (TEST.test(file)) continue;
    if (TEST_INPUT.test(file)) return `test support input changed: ${file}`;
    if (CODE_FILE.test(file)) continue;
    if (file.endsWith('.md')) continue;
    return `unclassified changed input: ${file}`;
  }
  return null;
}

/** Fail closed on identity drift; an incomplete/HITL verdict can still supply its terminal passing file rows. */
export function planGateRadiusWinnow(input: GateRadiusWinnowInput): GateRadiusWinnowDecision {
  const full = (reason: string): GateRadiusWinnowDecision => ({ action: 'full', reason,
    priorRunId: input.priorRunId, priorCutSha: input.priorCutSha, newCutSha: input.newCutSha, reuseRatio: 0 });
  if (!validRunId(input.priorRunId) || !SHA.test(input.priorCutSha) || !SHA.test(input.newCutSha)
    || input.priorCutSha === input.newCutSha) return full('run or cut identity invalid');
  if (!DIGEST.test(input.priorImageDigest) || !DIGEST.test(input.currentImageDigest)
    || input.priorImageDigest.toLowerCase() !== input.currentImageDigest.toLowerCase()) return full('image digest missing or changed');
  if (!HEX.test(input.priorLockfileHash) || !HEX.test(input.currentLockfileHash)
    || input.priorLockfileHash.toLowerCase() !== input.currentLockfileHash.toLowerCase()) return full('lockfile digest missing or changed');
  const inputs = fullChangingInput(input.changedFiles);
  if (inputs) return full(inputs);
  const expected = [...input.current].map((row) => row.file);
  const priorExpected = [...input.priorExpectedFiles];
  if (!expected.length || new Set(expected).size !== expected.length || expected.some((file) => !validFile(file))
    || new Set(priorExpected).size !== priorExpected.length || priorExpected.some((file) => !validFile(file)))
    return full('test inventory invalid');
  if (priorExpected.some((file) => !expected.includes(file))) return full('prior test deleted');
  if (new Set(input.priorFiles.map((row) => row.file)).size !== input.priorFiles.length
    || input.priorFiles.some((row) => !priorExpected.includes(row.file) || row.judgedRunId !== input.priorRunId))
    return full('prior file result inventory invalid');
  if (input.priorVerdict === 'ok' && input.priorFiles.length !== priorExpected.length)
    return full('clean prior verdict has incomplete file results');
  const priorByFile = new Map(input.priorFiles.map((row) => [row.file, row]));
  const candidates: GateFileReceipt[] = [];
  for (const identity of input.current) {
    const row = priorByFile.get(identity.file);
    if (!row?.receipt) continue;
    const receipt = row.receipt;
    const { recordSha256, ...body } = receipt;
    const evidence = receipt.evidence as { runId?: unknown } | null;
    // A carried measurement can cross cuts only after the canonical loader verifies its
    // original judged attempt, image, lock, and exact receipt hash.
    if (!row.sourceRunId || !validRunId(row.sourceRunId)
      || row.sourceRunId !== input.priorRunId && row.sourceJudgedVerified !== true
      || !row.sourceCutSha || !SHA.test(row.sourceCutSha)
      || row.sourceCutSha !== input.priorCutSha && row.sourceJudgedVerified !== true
      || !HEX.test(recordSha256) || !row.judgedReceiptSha256 || row.judgedReceiptSha256 !== recordSha256
      || createHash('sha256').update(JSON.stringify(body)).digest('hex') !== recordSha256
      || receipt.sourceHead40 !== row.sourceCutSha || receipt.outcome !== row.outcome
      || receipt.file !== identity.file || evidence?.runId !== row.sourceRunId
      || !row.priorIdentity || row.priorIdentity.file !== identity.file
      || receipt.key !== gateFileReceiptKey(row.priorIdentity)
      || receipt.closureDigest !== gateFileReceiptClosureDigest(row.priorIdentity)
      || JSON.stringify(receipt.closureFiles) !== JSON.stringify(row.priorIdentity.closureFiles)
      || receipt.imageDigest !== row.priorIdentity.imageDigest)
      return full(`malformed receipt provenance: ${identity.file}`);
    if (row.outcome !== 'pass') continue;
    if (input.changedFiles.includes(identity.file)) continue;
    candidates.push(receipt);
  }
  const plan = planGateFileReceipts({ current: input.current, receipts: candidates });
  const carry = plan.reuse.flatMap((receipt) => {
    const row = priorByFile.get(receipt.file);
    const key = input.current.find((identity) => identity.file === receipt.file);
    return row?.sourceRunId && row.sourceCutSha && key && receipt.key === gateFileReceiptKey(key)
      ? [{ file: receipt.file, key: receipt.key, sourceRunId: row.sourceRunId, sourceCutSha: row.sourceCutSha }] : [];
  }).sort((a, b) => a.file.localeCompare(b.file));
  const carried = new Set(carry.map((row) => row.file));
  const measure = expected.filter((file) => !carried.has(file)).sort();
  if (carry.length + measure.length !== expected.length) return full('winnow result inventory mismatch');
  return { action: 'radius', reason: 'file result and closure identity checked',
    priorRunId: input.priorRunId, priorCutSha: input.priorCutSha, newCutSha: input.newCutSha,
    carry, measure, total: expected.length, reuseRatio: carry.length / expected.length };
}

/** Build the selector's cut/diff/T1 inputs from immutable Git objects, never a caller supplied smaller radius. */
export function planGateRadiusWinnowAtCut(input: Omit<GateRadiusWinnowInput,
  'current' | 'changedFiles' | 'currentLockfileHash'> & { repo: string }): GateRadiusWinnowDecision {
  const full = (reason: string): GateRadiusWinnowDecision => ({ action: 'full', reason,
    priorRunId: input.priorRunId, priorCutSha: input.priorCutSha, newCutSha: input.newCutSha, reuseRatio: 0 });
  try {
    const priorTests = gateAssignableTestsAtCommit(input.repo, input.priorCutSha);
    const currentTests = gateAssignableTestsAtCommit(input.repo, input.newCutSha);
    if (!priorTests || !currentTests || JSON.stringify(priorTests) !== JSON.stringify([...input.priorExpectedFiles].sort()))
      return full('judged run test inventory differs from source cut');
    const priorLock = gateLockfileHashAtCommit(input.repo, input.priorCutSha);
    const currentLock = gateLockfileHashAtCommit(input.repo, input.newCutSha);
    if (!priorLock || !currentLock || priorLock !== input.priorLockfileHash) return full('source lockfile proof differs from cut');
    const tree = gitClosureTree(input.repo, input.newCutSha);
    const priorTree = gitClosureTree(input.repo, input.priorCutSha);
    const current = currentTests.map((file) => gateFileReceiptIdentityFromClosure(tree, file, input.currentImageDigest));
    if (current.some((identity) => !identity)) return full('current T1 file identity unmeasured');
    const priorFiles = input.priorFiles.map((row) => ({ ...row,
      priorIdentity: gateFileReceiptIdentityFromClosure(priorTree, row.file, input.priorImageDigest) ?? undefined }));
    if (priorFiles.some((row) => !row.priorIdentity)) return full('source T1 file identity unmeasured');
    return planGateRadiusWinnow({ ...input, priorFiles, current: current as GateFileReceiptIdentity[],
      currentLockfileHash: currentLock, changedFiles: changedFilesBetween(input.repo, input.priorCutSha, input.newCutSha) });
  } catch (error) { return full(`cut evidence unreadable: ${String(error).slice(0, 160)}`); }
}
