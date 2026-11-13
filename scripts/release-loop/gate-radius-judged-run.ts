/** Canonical, run-scoped file inventory for the opt-in cut radius. */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readGateFileReceiptHistory } from './gate-shard-receipts.js';
import { gateFileReceiptIdentityFromClosure, gateFileReceiptKey, type GateFileReceiptEnvelope } from './gate-file-receipts.js';
import { gitClosureTree } from './gate-closure.js';
import { gateAssignableTestsAtCommit } from './gate-baseline-receipt.js';
import { gateLockfileHashAtCommit } from './gate-reuse-identity.js';
import type { WinnowSourceFile } from './gate-radius-winnow.js';
import { planGateRadiusWinnowAtCut, type GateRadiusWinnowDecision } from './gate-radius-winnow.js';
import type { PartialPlan } from './gate-partial.js';

const SHA = /^[a-f0-9]{40}$/i;
const HEX = /^[a-f0-9]{64}$/i;
const RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;

export interface JudgedFileRow {
  file: string;
  outcome: 'pass' | 'fail' | 'error' | 'unmeasured';
  /** Exact immutable receipt selected by this verdict, never the mutable CAS latest. */
  key?: string;
  recordSha256?: string;
  sourceRunId?: string;
  sourceCutSha?: string;
}

export interface JudgedRunInventory {
  schema: 'gate-radius-judged-run-v1';
  runId: string;
  cutSha: string;
  imageDigest: string;
  lockfileHash: string;
  expectedFiles: string[];
  files: JudgedFileRow[];
}

export interface LoadedJudgedRun {
  runId: string;
  cutSha: string;
  verdict: 'ok' | 'regression' | 'error' | 'incomplete' | 'hitl';
  imageDigest: string;
  lockfileHash: string;
  expectedFiles: string[];
  files: WinnowSourceFile[];
}

/** Structural gate for final verdict replacement; the builder verifies every referenced CAS receipt. */
export function validFinalJudgedRun(value: unknown, runId: unknown, cutSha: unknown): value is JudgedRunInventory {
  const row = object(value);
  if (!row || row.schema !== 'gate-radius-judged-run-v1' || row.runId !== runId || row.cutSha !== cutSha
    || typeof row.runId !== 'string' || !RUN.test(row.runId)
    || typeof row.cutSha !== 'string' || !SHA.test(row.cutSha)
    || typeof row.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(row.imageDigest)
    || typeof row.lockfileHash !== 'string' || !HEX.test(row.lockfileHash)
    || !Array.isArray(row.expectedFiles) || !Array.isArray(row.files)
    || !row.expectedFiles.length || row.files.length !== row.expectedFiles.length
    || row.expectedFiles.some((file) => typeof file !== 'string' || !/^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file))
    || new Set(row.expectedFiles).size !== row.expectedFiles.length) return false;
  const expected = new Set(row.expectedFiles);
  const files = row.files.map(object);
  if (files.some((file) => !file || !expected.has(file.file))
    || new Set(files.map((file) => file?.file)).size !== files.length) return false;
  return files.every((file) => {
    if (!file) return false;
    if (file.outcome === 'pass') return typeof file.key === 'string' && HEX.test(file.key)
      && typeof file.recordSha256 === 'string' && HEX.test(file.recordSha256)
      && typeof file.sourceRunId === 'string' && RUN.test(file.sourceRunId)
      && typeof file.sourceCutSha === 'string' && SHA.test(file.sourceCutSha);
    return (file.outcome === 'fail' || file.outcome === 'error')
      && file.key === undefined && file.recordSha256 === undefined
      && file.sourceRunId === undefined && file.sourceCutSha === undefined;
  });
}

/** A selected radius must have both measured and carried files; zero-file cuts use the full gate. */
export function selectJudgedCutRadius(input: { ledgerRoot: string; receiptRoot: string; repo: string;
  version: string; priorRunId: string; newCutSha: string; currentImageDigest: string }):
  { decision: GateRadiusWinnowDecision; plan: PartialPlan | null; carryRows: JudgedFileRow[] }
  | { decision: null; plan: null; reason: string; carryRows: [] } {
  const prior = loadPriorJudgedRun({ ledgerRoot: input.ledgerRoot, receiptRoot: input.receiptRoot,
    repo: input.repo, version: input.version, runId: input.priorRunId });
  if (!prior) return { decision: null, plan: null, reason: 'canonical prior judged run unavailable', carryRows: [] };
  const decision = planGateRadiusWinnowAtCut({ repo: input.repo, priorRunId: prior.runId,
    priorCutSha: prior.cutSha, priorVerdict: prior.verdict, priorExpectedFiles: prior.expectedFiles,
    priorFiles: prior.files, priorImageDigest: prior.imageDigest, priorLockfileHash: prior.lockfileHash,
    newCutSha: input.newCutSha, currentImageDigest: input.currentImageDigest });
  if (decision.action !== 'radius' || !decision.carry.length || !decision.measure.length)
    return { decision, plan: null, carryRows: [] };
  const byFile = new Map(prior.files.map((row) => [row.file, row]));
  const carryRows = decision.carry.map((entry): JudgedFileRow | null => {
    const source = byFile.get(entry.file);
    return source?.receipt && source.sourceRunId && source.sourceCutSha
      ? { file: entry.file, outcome: 'pass', key: source.receipt.key,
          recordSha256: source.receipt.recordSha256, sourceRunId: source.sourceRunId,
          sourceCutSha: source.sourceCutSha } : null;
  });
  if (carryRows.some((row) => !row)) return { decision, plan: null, carryRows: [] };
  return { decision, plan: { version: input.version, priorCommit: prior.cutSha,
    forCommit: input.newCutSha, files: decision.measure,
    priorFailures: [], priorErrors: [] }, carryRows: carryRows as JudgedFileRow[] };
}

/** Create a complete judged inventory from the actual sweep, including files with no reusable receipt. */
export function buildJudgedRunInventory(input: { repo: string; receiptRoot: string; runId: string; cutSha: string;
  imageDigest: string; measuredFiles: readonly string[]; failures: readonly string[]; errors: readonly string[];
  carriedRows?: readonly JudgedFileRow[]; strictPassReceipts?: boolean }): JudgedRunInventory | null {
  if (!RUN.test(input.runId) || !SHA.test(input.cutSha)
    || !/^sha256:[a-f0-9]{64}$/i.test(input.imageDigest)) return null;
  try {
    const expectedFiles = gateAssignableTestsAtCommit(input.repo, input.cutSha);
    const lockfileHash = gateLockfileHashAtCommit(input.repo, input.cutSha);
    if (!expectedFiles || !expectedFiles.length || !lockfileHash) return null;
    const expected = new Set(expectedFiles);
    const carried = new Map((input.carriedRows ?? []).map((row) => [row.file, row]));
    const measured = new Set(input.measuredFiles);
    if (measured.size !== input.measuredFiles.length || carried.size !== (input.carriedRows ?? []).length
      || measured.size + carried.size !== expected.size
      || [...measured, ...carried.keys()].some((file) => !expected.has(file) || measured.has(file) && carried.has(file))) return null;
    const failed = new Set(input.failures.map((id) => id.split(' > ')[0]!));
    const errors = new Set(input.errors.map((id) => id.split(' > ')[0]!));
    if ([...failed, ...errors].some((file) => !expected.has(file) || carried.has(file))
      || [...failed].some((file) => errors.has(file))) return null;
    const tree = gitClosureTree(input.repo, input.cutSha);
    const files = expectedFiles.map((file): JudgedFileRow => {
      const carry = carried.get(file);
      if (carry) {
        const identity = gateFileReceiptIdentityFromClosure(tree, file, input.imageDigest);
        if (carry.outcome !== 'pass' || !identity || carry.key !== gateFileReceiptKey(identity)
          || !carry.recordSha256 || !HEX.test(carry.recordSha256)
          || !carry.sourceRunId || !RUN.test(carry.sourceRunId)
          || !carry.sourceCutSha || !SHA.test(carry.sourceCutSha)
          || readGateFileReceiptHistory(input.receiptRoot, carry.key)
            .filter((row) => row.recordSha256 === carry.recordSha256 && row.sourceHead40 === carry.sourceCutSha
              && row.outcome === 'pass').length !== 1) throw new Error('carried receipt invalid');
        return carry;
      }
      if (errors.has(file)) return { file, outcome: 'error' };
      if (failed.has(file)) return { file, outcome: 'fail' };
      const identity = gateFileReceiptIdentityFromClosure(tree, file, input.imageDigest);
      const key = identity && gateFileReceiptKey(identity);
      if (!key) return { file, outcome: 'unmeasured' };
      const matches = readGateFileReceiptHistory(input.receiptRoot, key).filter((receipt) =>
        receipt.file === file && receipt.outcome === 'pass' && receipt.sourceHead40 === input.cutSha
          && (receipt.evidence as { runId?: unknown } | null)?.runId === input.runId);
      if (matches.length !== 1) return { file, outcome: 'unmeasured' };
      return { file, outcome: 'pass', key, recordSha256: matches[0]!.recordSha256,
        sourceRunId: input.runId, sourceCutSha: input.cutSha };
    });
    if (input.strictPassReceipts && files.some((row) => row.outcome === 'unmeasured')) return null;
    return { schema: 'gate-radius-judged-run-v1', runId: input.runId, cutSha: input.cutSha,
      imageDigest: input.imageDigest, lockfileHash, expectedFiles, files };
  } catch { return null; }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sourceJudgedAttempt(input: { ledgerRoot: string; repo: string; version: string; sourceRunId: string;
  sourceCutSha: string; imageDigest: string; lockfileHash: string; file: string; key: string; recordSha256: string }): boolean {
  try {
    const path = join(input.ledgerRoot, 'release', input.version, 'gate-verdict-attempts.jsonl');
    if (statSync(path).size > 32 * 1024 * 1024) return false;
    const text = readFileSync(path, 'utf8');
    if (!text.endsWith('\n')) return false;
    const attempts = text.trimEnd().split('\n').map((line) => object(JSON.parse(line)));
    const terminal = attempts.filter((record) => {
      const receipt = object(record?.baselineReceipt);
      return record?.runId === input.sourceRunId && ['ok', 'regression'].includes(String(record.outcome))
        && (receipt?.schema === 2 && receipt.valid === true && receipt.commit === record.commit
          || validFinalJudgedRun(record.radiusJudgedRun, record.runId, record.commit));
    }).at(-1);
    const inventory = object(terminal?.radiusJudgedRun);
    const rows = inventory?.files;
    return terminal?.commit === input.sourceCutSha
      && gateLockfileHashAtCommit(input.repo, input.sourceCutSha) === input.lockfileHash
      && validFinalJudgedRun(inventory, input.sourceRunId, input.sourceCutSha)
      && (terminal.outcome !== 'ok' || inventory.files.every((row) => row.outcome === 'pass'))
      && inventory.schema === 'gate-radius-judged-run-v1'
      && inventory.runId === input.sourceRunId && inventory.cutSha === input.sourceCutSha
      && inventory.imageDigest === input.imageDigest && inventory.lockfileHash === input.lockfileHash
      && Array.isArray(rows) && rows.some((value) => {
        const row = object(value);
        return row?.file === input.file && row.outcome === 'pass'
          && row.sourceRunId === input.sourceRunId && row.sourceCutSha === input.sourceCutSha
          && row.key === input.key && row.recordSha256 === input.recordSha256;
      });
  } catch { return false; }
}

/** The final verdict owns the inventory. A missing or damaged pointer cannot select a CAS receipt. */
export function loadPriorJudgedRun(input: { ledgerRoot: string; receiptRoot: string; repo: string;
  version: string; runId: string }): LoadedJudgedRun | null {
  if (!VERSION.test(input.version) || !RUN.test(input.runId)) return null;
  try {
    const verdict = object(JSON.parse(readFileSync(join(input.ledgerRoot, 'release', input.version, 'gate-verdict.json'), 'utf8')));
    const inventory = object(verdict?.radiusJudgedRun);
    if (!verdict || !inventory || inventory.schema !== 'gate-radius-judged-run-v1'
      || inventory.runId !== input.runId || verdict.runId !== input.runId
      || typeof inventory.cutSha !== 'string' || !SHA.test(inventory.cutSha)
      || verdict.commit !== inventory.cutSha || typeof inventory.imageDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/i.test(inventory.imageDigest)
      || typeof inventory.lockfileHash !== 'string' || !HEX.test(inventory.lockfileHash)
      || !['ok', 'regression', 'error', 'incomplete', 'hitl'].includes(String(verdict.outcome))
      || !Array.isArray(inventory.expectedFiles) || !Array.isArray(inventory.files)) return null;
    const expected = gateAssignableTestsAtCommit(input.repo, inventory.cutSha);
    if (!expected || JSON.stringify(expected) !== JSON.stringify(inventory.expectedFiles)) return null;
    if (gateLockfileHashAtCommit(input.repo, inventory.cutSha) !== inventory.lockfileHash) return null;
    const expectedSet = new Set(expected);
    const rows = inventory.files.map(object);
    if (rows.some((row) => !row || typeof row.file !== 'string' || !expectedSet.has(row.file)
      || !['pass', 'fail', 'error', 'unmeasured'].includes(String(row.outcome)))
      || new Set(rows.map((row) => row!.file)).size !== rows.length
      || (verdict.outcome === 'ok' && (rows.length !== expected.length
        || rows.some((row) => row?.outcome !== 'pass')))) return null;
    const tree = gitClosureTree(input.repo, inventory.cutSha);
    const files: WinnowSourceFile[] = [];
    for (const row of rows) {
      const file = row!.file as string;
      const base: WinnowSourceFile = { file, outcome: row!.outcome as WinnowSourceFile['outcome'],
        judgedRunId: input.runId };
      if (row!.outcome === 'pass') {
        const key = row!.key;
        const hash = row!.recordSha256;
        if (typeof key !== 'string' || !HEX.test(key) || typeof hash !== 'string' || !HEX.test(hash)
          || typeof row!.sourceRunId !== 'string' || !RUN.test(row!.sourceRunId)
          || typeof row!.sourceCutSha !== 'string' || !SHA.test(row!.sourceCutSha)) return null;
        const matches = readGateFileReceiptHistory(input.receiptRoot, key)
          .filter((receipt) => receipt.recordSha256 === hash);
        if (matches.length !== 1) return null;
        const receipt: GateFileReceiptEnvelope = matches[0]!;
        const identity = gateFileReceiptIdentityFromClosure(tree, file, inventory.imageDigest);
        if (!identity || receipt.key !== gateFileReceiptKey(identity)
          || receipt.sourceHead40 !== row!.sourceCutSha || receipt.outcome !== 'pass') return null;
        const carried = row!.sourceRunId !== input.runId;
        if (carried && !sourceJudgedAttempt({ ledgerRoot: input.ledgerRoot, repo: input.repo, version: input.version,
          sourceRunId: row!.sourceRunId, sourceCutSha: row!.sourceCutSha,
          imageDigest: inventory.imageDigest, lockfileHash: inventory.lockfileHash,
          file, key, recordSha256: hash })) return null;
        files.push({ ...base, sourceRunId: row!.sourceRunId, sourceCutSha: row!.sourceCutSha,
          judgedReceiptSha256: hash, receipt, ...(carried ? { sourceJudgedVerified: true as const } : {}) });
      } else {
        if (row!.key !== undefined || row!.recordSha256 !== undefined
          || row!.sourceRunId !== undefined || row!.sourceCutSha !== undefined) return null;
        files.push(base);
      }
    }
    return { runId: input.runId, cutSha: inventory.cutSha, verdict: verdict.outcome as LoadedJudgedRun['verdict'],
      imageDigest: inventory.imageDigest, lockfileHash: inventory.lockfileHash,
      expectedFiles: expected, files };
  } catch { return null; }
}
