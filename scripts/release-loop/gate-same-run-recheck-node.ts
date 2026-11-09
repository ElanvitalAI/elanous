#!/usr/bin/env bun
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { podCommandImageFor } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { cachedCutSnapshot, createCutSnapshot } from './gate-cut-snapshot.js';
import { planStalledShardRecheck, writeRecheckPlan } from './gate-partial.js';
import { readGraphContext, finishNode, type GraphContext } from './node-verdict.js';
import { stalledGateEvidence } from './gate-stalled-evidence.js';
import { gateImagePinPath, readGateImagePin } from './gate-image-pin.js';
import { gateLockfileHashAtCommit } from './gate-reuse-identity.js';
import { gateAssignableTestsAtCommit } from './gate-baseline-receipt.js';

type Result = { outcome: 'ok' | 'error'; verdict: 'pass' | 'fail'; summary: string; planPath?: string;
  reusedShardCount?: number; remeasureFiles?: string[]; skipped?: boolean; fullSweepFallback?: boolean };
type Deps = { repo?: string; roots?: string[]; ledgerRoot?: string;
  inspect?: typeof stalledGateEvidence; write?: typeof writeRecheckPlan;
  testsAtCommit?: (repo: string, commit: string) => string[] | null;
  pinnedImageDigest?: (root: string, version: string, runId: string, commit: string) => string | null;
  lockfileHash?: (repo: string, commit: string) => string | null;
  existsAtCommit?: (repo: string, commit: string, file: string) => boolean };

/** Build a same-run plan only for the approved, fail-closed incomplete-batch path. */
export function prepareSameRunGateRecheck(context: GraphContext, deps: Deps = {}): Result {
  const gate = context.outputs.gate;
  const errorText = `${String(gate?.error ?? '')} ${String(gate?.summary ?? '')}`;
  if (gate?.outcome !== 'error' || !/shard result batch (?:write failed|is incomplete)|incomplete completed shard batch/i.test(errorText))
    return { outcome: 'ok', verdict: 'pass', skipped: true, summary: 'same-run receipt recheck not applicable' };
  const commit = typeof gate.commit === 'string' ? gate.commit : '';
  const version = context.input.version;
  if (!context.runId || !/^[a-f0-9]{40}$/i.test(commit))
    return { outcome: 'error', verdict: 'fail', summary: 'same-run gate identity is incomplete' };
  const baseline = context.outputs.cutoff?.baseline as { sha?: unknown } | undefined;
  const repo = deps.repo ?? resolve(import.meta.dir, '../..');
  const ledgerRoot = deps.ledgerRoot ?? releaseLedgerRoot();
  const fullSweepFallback = (reason: string): Result => {
    let tests: string[] | null;
    try { tests = (deps.testsAtCommit ?? gateAssignableTestsAtCommit)(repo, commit); }
    catch (error) { tests = null; reason += `; test inventory failed: ${String(error)}`; }
    if (!tests?.length) return { outcome: 'error', verdict: 'fail', summary: `same-run receipts rejected; full sweep unavailable: ${reason}` };
    const files = [...new Set(tests)].sort();
    const plan = { kind: 'recheck' as const, version, priorCommit: commit, forCommit: commit,
      files, stalledFiles: files, priorFailures: [], priorErrors: [], preservedShardCount: 0 };
    try {
      const planPath = (deps.write ?? writeRecheckPlan)(ledgerRoot, plan);
      return { outcome: 'ok', verdict: 'pass', planPath, reusedShardCount: 0, remeasureFiles: files,
        fullSweepFallback: true, summary: `same-run receipts rejected (${reason}); remeasure full gate: ${files.length} test files` };
    } catch (error) {
      return { outcome: 'error', verdict: 'fail', summary: `same-run receipts rejected; full-sweep plan write failed: ${String(error)}` };
    }
  };
  const roots = deps.roots ?? [...new Set([ledgerRoot, effectiveInstanceRoot()])];
  let expectedImageDigest: string | null, expectedLockfileHash: string | null;
  try {
    expectedImageDigest = (deps.pinnedImageDigest ?? ((root, releaseVersion, runId, sha) => {
      const image = `${podCommandImageFor([], true).split(':')[0]}:${sha.slice(0, 12)}`;
      return readGateImagePin(gateImagePinPath(root, releaseVersion, runId), runId, image, sha)?.digest ?? null;
    }))(ledgerRoot, version, context.runId, commit);
    expectedLockfileHash = (deps.lockfileHash ?? gateLockfileHashAtCommit)(repo, commit);
  } catch (error) {
    return fullSweepFallback(`runtime identity unavailable: ${String(error instanceof Error ? error.message : error)}`);
  }
  if (!expectedImageDigest || !expectedLockfileHash)
    return fullSweepFallback('image pin or cut lockfile identity is unavailable');
  let evidence: ReturnType<typeof stalledGateEvidence>;
  try {
    evidence = (deps.inspect ?? stalledGateEvidence)({ version, commit, repo, roots, gateOutput: gate,
      ...(typeof baseline?.sha === 'string' ? { expectedBase40: baseline.sha } : {}), expectedRunId: context.runId,
      expectedImageDigest, expectedLockfileHash });
  } catch (error) {
    return fullSweepFallback(`receipt inspection failed: ${String(error instanceof Error ? error.message : error)}`);
  }
  if (!evidence.ok) return fullSweepFallback(evidence.reason);
  const { stalledShards, partialFailures, preservedShardCount } = evidence.evidence;
  const stalledFiles = stalledShards.flatMap((shard) => shard.files);
  let snapshot: ReturnType<typeof cachedCutSnapshot>;
  try { snapshot = cachedCutSnapshot(repo, commit); }
  catch (error) { return fullSweepFallback(`cut snapshot unavailable: ${String(error instanceof Error ? error.message : error)}`); }
  const existsAtCommit = deps.existsAtCommit ?? ((root: string, sha: string, file: string) => {
    snapshot ??= createCutSnapshot(root, sha, join(ledgerRoot, 'cut-snapshots'));
    return snapshot.existsBlob(file);
  });
  const planned = planStalledShardRecheck({ version, measuredCommit: commit, forCommit: commit,
    failures: partialFailures.failures, errors: partialFailures.errors, stalledFiles, preservedShardCount,
    existsAtCommit: (file) => existsAtCommit(repo, commit, file) });
  if (!planned.ok) return fullSweepFallback(`recheck plan rejected: ${planned.reason}`);
  try {
    const planPath = (deps.write ?? writeRecheckPlan)(ledgerRoot, planned.plan);
    return { outcome: 'ok', verdict: 'pass', planPath, reusedShardCount: preservedShardCount,
      remeasureFiles: planned.plan.files, summary: `same-run receipts preserved ${preservedShardCount} shards; remeasure ${planned.plan.files.length} stalled files` };
  } catch (error) {
    return fullSweepFallback(`recheck plan write failed: ${String(error instanceof Error ? error.message : error)}`);
  }
}

function main(): void {
  const context = readGraphContext();
  const result = prepareSameRunGateRecheck(context);
  process.exitCode = finishNode('gate-same-run-recheck', context.input.version, result);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
