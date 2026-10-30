/** Safe test carry from passed host-regate receipts into a release cut. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { gateAssignableTestsAtCommit } from './gate-baseline-receipt.js';
import { gitClosureTree, testsReachingChanged } from './gate-closure.js';
import { changedFilesBetween } from './gate-partial.js';
import { gateReceiptSelfKey, loadGateReceipts, type GateReceipt } from '../../src/self-implement/gate-receipt-registry.js';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';

const SHA = /^[0-9a-f]{40}$/i;
const TEST = /^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/;
const INERT = /\.(?:md|mdx|txt)$/i;

function git(repo: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 && !result.error ? result.stdout.trim() : null;
}

function ancestor(repo: string, base: string, head: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', base, head], { cwd: repo, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  return result.status === 0 && !result.error;
}

function blob(repo: string, commit: string, file: string): string | null {
  return git(repo, ['rev-parse', `${commit}:${file}`]);
}

function candidateTests(tree: ReturnType<typeof gitClosureTree>, receipt: GateReceipt): string[] {
  // The registry stores the changed-file radius, not the expanded importer/neighbor list that the
  // host gate selected. Only changed test files are certainly in that measurement; never infer
  // pass evidence for siblings or importers that the receipt did not persist explicitly.
  return [...new Set(receipt.radiusFiles.filter((file) => TEST.test(file) && tree.files.includes(file)))].sort();
}

export interface GateTrainReceiptPlan {
  priorCommit: string;
  files: string[];
  carriedFiles: string[];
  totalFiles: number;
  reasons: string[];
  receipts: string[];
}

/** Missing/invalid evidence only reduces carry; it never makes a gate pass. */
export function planGateTrainReceiptCarry(input: {
  repo: string;
  commit: string;
  receiptPath: string;
  bunVersion: string;
  lockfileHash: string;
  envFingerprint: string;
}): GateTrainReceiptPlan | null {
  if (!SHA.test(input.commit) || !input.bunVersion || !input.lockfileHash || !/^[0-9a-f]{64}$/i.test(input.envFingerprint)) return null;
  const tests = gateAssignableTestsAtCommit(input.repo, input.commit);
  if (!tests?.length) return null;
  const receipts = Object.values(loadGateReceipts(input.receiptPath));
  const currentTree = gitClosureTree(input.repo, input.commit);
  const carried = new Set<string>();
  const accepted: GateReceipt[] = [];
  const reasons = new Set<string>();
  const changedByBase = new Map<string, string[]>();

  for (const receipt of receipts) {
    if (receipt.verdict !== 'passed' || gateReceiptSelfKey(receipt) !== receipt.key) { reasons.add('invalid-or-non-passing receipt'); continue; }
    if (!receipt.checks.some((check) => check === 'test-interference:with-neighbours' || check === 'test-interference:changed-only')) {
      reasons.add('receipt lacks passing test-interference check'); continue;
    }
    if (receipt.bunVersion !== input.bunVersion || receipt.lockfileHash !== input.lockfileHash
      || receipt.envFingerprint !== input.envFingerprint) { reasons.add('bun/lockfile/environment differs'); continue; }
    if (!ancestor(input.repo, receipt.baseCommit, input.commit)) { reasons.add('receipt base is not an ancestor of cut'); continue; }
    if (receipt.radiusFiles.some((file) => !currentTree.files.includes(file)
      || blob(input.repo, receipt.headCommit, file) !== blob(input.repo, input.commit, file))) {
      reasons.add('receipt radius changed or missing at cut'); continue;
    }
    let measuredChanges: string[];
    try { measuredChanges = changedFilesBetween(input.repo, receipt.baseCommit, receipt.headCommit); }
    catch { reasons.add('receipt base-to-head diff unavailable'); continue; }
    if (measuredChanges.some((file) => !receipt.radiusFiles.includes(file))) {
      reasons.add('receipt radius does not cover base-to-head changes'); continue;
    }
    const candidates = candidateTests(currentTree, receipt);
    if (!candidates?.length) { reasons.add('receipt test radius is empty or opaque'); continue; }

    let changed: string[];
    try {
      changed = changedByBase.get(receipt.baseCommit) ?? changedFilesBetween(input.repo, receipt.baseCommit, input.commit);
      changedByBase.set(receipt.baseCommit, changed);
    } catch { reasons.add('cut diff from receipt base unavailable'); continue; }
    const outside = changed.filter((file) => !receipt.radiusFiles.includes(file) && !INERT.test(file));
    const nonCodeOutside = outside.find((file) => !/\.(?:[cm]?[jt]sx?)$/.test(file));
    if (nonCodeOutside) {
      reasons.add(`non-code release input changed outside receipt radius: ${nonCodeOutside}`); continue;
    }
    let safeCandidates = candidates;
    if (outside.length) {
      const affected = testsReachingChanged(currentTree, outside, candidates);
      if (!affected.ok) { reasons.add('cut import closure opaque'); continue; }
      const affectedSet = new Set(affected.tests);
      safeCandidates = candidates.filter((test) => !affectedSet.has(test));
      if (!safeCandidates.length) { reasons.add('merge-skew changes reach every receipt test'); continue; }
    }
    for (const test of safeCandidates) carried.add(test);
    accepted.push(receipt);
  }

  const noCarry = (reason: string): GateTrainReceiptPlan => ({ priorCommit: accepted[0]?.baseCommit ?? input.commit,
    files: [...tests], carriedFiles: [], totalFiles: tests.length,
    reasons: [...new Set([...reasons, ...(reason === 'no safe receipt coverage' && reasons.size ? [] : [reason])])].sort(),
    receipts: accepted.map((receipt) => receipt.key).sort() });
  if (!carried.size || !accepted.length) return noCarry(receipts.length ? 'no safe receipt coverage' : 'gate receipt registry empty');
  const selected = tests.filter((file) => !carried.has(file));
  // The caller falls back to a full sweep rather than skipping all test Pods.
  if (!selected.length) return noCarry('all tests carried; keep at least one measured sweep');
  const latest = [...accepted].sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0]!;
  return { priorCommit: latest.baseCommit, files: selected, carriedFiles: [...carried].sort(), totalFiles: tests.length,
    reasons: [...reasons].sort(), receipts: accepted.map((receipt) => receipt.key).sort() };
}

export function gateReceiptRegistryPath(repo: string): string | null {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common ? join(common, 'elanous-host-regate', 'gate-receipts.json') : null;
}
