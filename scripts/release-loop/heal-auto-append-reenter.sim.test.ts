import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph, type GraphRunOptions } from '../../src/graph-runner/runner.js';
import { readGraphContext } from './node-verdict.js';
import { runGateRepairNode } from './gate-repair-node.js';
import { planAdaptiveGateHeal } from './adaptive-gate-heal.js';
import { classifyGateShadow } from './gate-triage-node.js';
import { runGateFileReceiptAuditNode } from './gate-file-receipt-audit-node.js';
import { gateFileReceiptIdentityFromClosure, gateFileReceiptKey } from './gate-file-receipts.js';
import { parseOptions } from './gate-runtime.js';
import type { ClosureTree } from './gate-closure.js';
import type { GateFileReceipt } from './gate-file-receipts.js';

const sha = (char: string) => char.repeat(40);

test('HEAL-AUTO-APPEND-REENTER: ARG permits two repair rounds and returns to receipt audit', () => {
  const gate = { outcome: 'regression' as const, commit: sha('a'), introduced: ['test/one.test.ts > regression'],
    preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 };
  const triage = classifyGateShadow(gate);
  const plan = (visit: number) => planAdaptiveGateHeal({ version: '0.3.8', runId: 'auto-two-rounds', gate, triage,
    autoAppendRepair: true, visitState: { gate: visit, gateTriage: visit } });
  expect(plan(1).disposition).toMatchObject({ action: 'append-repair-and-resume',
    rerunGateAt: 'gate', auditAfterGate: 'receipt-audit', visitLimits: { gate: 3, gateTriage: 3 } });
  expect(plan(2).disposition).toMatchObject({ action: 'append-repair-and-resume',
    rerunGateAt: 'gate' });
  expect(plan(3).disposition).toMatchObject({ action: 'decision-required' });
});

test('HEAL-AUTO-APPEND-REENTER: a landed independent repair appends to the cut and requires audit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-auto-append-'));
  const failureId = 'test/one.test.ts > regression';
  const runId = 'heal-auto-append-sim';
  const calls: unknown[] = [];
  try {
    const result = await runGateRepairNode({ runId,
      input: { version: '0.3.8', previousVersion: '0.3.7', autoAppendRepair: true },
      nodeInput: { version: '0.3.8', runId, commit: sha('a'), failureIds: [failureId] }, outputs: {} } as never, {
      root, repo: root,
      attributeFailures: () => [{ failureId, testFile: 'test/one.test.ts', sourceFiles: ['src/one.ts'],
        causePrs: [77], confidence: 'high', method: 'first-parent-source-overlap', evidence: [], unresolvedImports: [] }],
      startRepairChild: async (featureFile, base) => {
        expect(base).toBe('main');
        expect(readFileSync(featureFile, 'utf8')).toContain('Attributed cause PR: #77');
        return { ok: true, prNumber: 100, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/100' };
      },
      inspectRepairPr: async () => ({ isDraft: false, files: ['src/one.ts'], headRefOid: sha('b') }),
      waitForLanded: async () => ({ schema: 1, prNumber: 100, repairRunId: runId, head: sha('b'),
        mergeSha: sha('c'), base: 'main', mergedAt: '2026-11-08T00:00:00Z' }),
      refreshMainlineHead: () => sha('d'), isAncestor: () => true,
      appendCut: (options) => { calls.push(options); return { branch: 'release/0.3.8', commit: sha('e'), dryRun: false }; },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ version: '0.3.8', append: true, expectedTip: sha('a'), pick: [sha('c')] });
    expect(result).toMatchObject({ outcome: 'ok', commit: sha('e'), requiresReceiptAudit: true,
      appendedPicks: [sha('c')] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HEAL-AUTO-APPEND-REENTER: failed append remains red', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-auto-append-fail-'));
  const failureId = 'test/one.test.ts > regression';
  const runId = 'heal-auto-append-fail';
  try {
    const result = await runGateRepairNode({ runId,
      input: { version: '0.3.8', previousVersion: '0.3.7', autoAppendRepair: true },
      nodeInput: { version: '0.3.8', runId, commit: sha('a'), failureIds: [failureId] }, outputs: {} } as never, {
      root, repo: root,
      attributeFailures: () => [{ failureId, testFile: 'test/one.test.ts', sourceFiles: ['src/one.ts'],
        causePrs: [77], confidence: 'high', method: 'first-parent-source-overlap', evidence: [], unresolvedImports: [] }],
      startRepairChild: async () => ({ ok: true, prNumber: 100, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/100' }),
      inspectRepairPr: async () => ({ isDraft: false, files: ['src/one.ts'], headRefOid: sha('b') }),
      waitForLanded: async () => ({ schema: 1, prNumber: 100, repairRunId: runId, head: sha('b'),
        mergeSha: sha('c'), base: 'main', mergedAt: '2026-11-08T00:00:00Z' }),
      refreshMainlineHead: () => sha('d'), isAncestor: () => true,
      appendCut: () => { throw new Error('simulated cut conflict'); },
    });
    expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail', remainingFailureIds: [failureId] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HEAL-AUTO-APPEND-REENTER sim: one release run consumes a landed repair and enters receipt audit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-auto-append-graph-'));
  const runId = 'heal-auto-append-graph-sim';
  const commit = sha('a');
  const repairMerge = sha('c');
  const repairedCut = sha('e');
  const failureId = 'src/failing.ts > src/failing.test.ts > introduced regression';
  let gateVisits = 0;
  const gateExecutionIds: string[] = [];
  let triageVisited = false;
  let repairResult: Awaited<ReturnType<typeof runGateRepairNode>> | undefined;
  let receiptAuditInput: Record<string, unknown> | undefined;
  const repairContextRoots: string[] = [];
  const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (command, options) => {
    const nodeId = readGraphContext(options.env!).nodeId;
    if (command.includes('version-node.ts release')) {
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit }), stderr: '' };
    }
    if (command.includes('gate-node.ts --json')) {
      gateVisits++;
      const context = readGraphContext(options.env!);
      const gateRequest = parseOptions(['--json'], options.env!);
      if (gateRequest === 'help') throw new Error('production gate option resolution unexpectedly returned help');
      gateExecutionIds.push(context.executionId!);
      return gateVisits === 1
        ? { exitCode: 1, stdout: JSON.stringify({ outcome: 'regression', commit: gateRequest.commit, executionId: context.executionId, introduced: [failureId], preexisting: 0,
          fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 }), stderr: '' }
        : (() => {
          expect(gateRequest.commit).toBe(repairedCut);
          return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit: gateRequest.commit,
            executionId: context.executionId, introduced: [], durationMs: 1 }), stderr: '' };
        })();
    }
    if (command.includes('gate-cutover-switch-node.ts')) {
      const child = spawnSync('bun', [join(import.meta.dir, 'gate-cutover-switch-node.ts')], {
        cwd: root, env: { ...process.env, ...options.env }, encoding: 'utf8',
      });
      return { exitCode: child.status ?? 2, stdout: child.stdout ?? '', stderr: child.stderr ?? String(child.error ?? '') };
    }
    if (command.includes('gate-triage-node.ts')) {
      triageVisited = true;
      const context = readGraphContext(options.env!);
      const gate = { outcome: 'regression' as const, commit, introduced: [failureId], preexisting: 0, fixed: null,
        knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 };
      return { exitCode: 0, stdout: JSON.stringify({ ...classifyGateShadow(gate), gateExecutionId: context.input.adaptiveGateExecutionId }), stderr: '' };
    }
    if (command.includes('gate-repair-node.ts')) {
      if (!triageVisited) throw new Error('repair node ran before production gate-triage');
      const context = readGraphContext(options.env!);
      if (!context.runId) throw new Error('repair graph context has no run id');
      repairContextRoots.push(context.runId);
      repairResult = await runGateRepairNode(context, {
        root, repo: root,
        attributeFailures: () => [{ failureId, testFile: 'src/failing.test.ts', sourceFiles: ['src/failing.ts'],
          causePrs: [77], confidence: 'high', method: 'first-parent-source-overlap', evidence: [], unresolvedImports: [] }],
        startRepairChild: async (featureFile, base) => {
          if (base !== 'main' || !readFileSync(featureFile, 'utf8').includes('Attributed cause PR: #77'))
            throw new Error('repair child did not receive attributed one-file input');
          return { ok: true, prNumber: 100, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/100' };
        },
        inspectRepairPr: async () => ({ isDraft: false, files: ['src/failing.ts'], headRefOid: sha('b') }),
        waitForLanded: async () => ({ schema: 1, prNumber: 100, repairRunId: runId, head: sha('b'),
          mergeSha: repairMerge, base: 'main', mergedAt: '2026-11-09T00:00:00Z' }),
        refreshMainlineHead: () => sha('d'), isAncestor: () => true,
        appendCut: (request) => {
          expect(request.pick).toEqual([repairMerge]);
          expect(request.expectedTip).toBe(commit);
          return { branch: 'release/0.3.8', commit: repairedCut, dryRun: false };
        },
      });
      return { exitCode: repairResult.outcome === 'ok' ? 0 : 1, stdout: JSON.stringify(repairResult), stderr: '' };
    }
    if (command.includes('gate-file-receipt-audit-node.ts')) {
      const context = readGraphContext(options.env!);
      const testFile = 'src/failing.test.ts';
      const imageDigest = `sha256:${'1'.repeat(64)}`;
      const closureTree: ClosureTree = { files: [testFile], preload: [], read: (path) => path === testFile ? 'test("passes", () => expect(true).toBe(true));' : undefined };
      const identity = gateFileReceiptIdentityFromClosure(closureTree, testFile, imageDigest)!;
      const closureDigest = createHash('sha256').update(JSON.stringify(identity.closureFiles.map((file) => [file, identity.contentHashes[file]]))).digest('hex');
      const receipt: GateFileReceipt = { file: testFile, closureFiles: [...identity.closureFiles], closureDigest, imageDigest,
        key: gateFileReceiptKey(identity)!, sourceHead40: repairedCut, outcome: 'pass', evidence: { simulated: true } };
      const audited = runGateFileReceiptAuditNode(context, { repo: root, roots: { instance: root, ledger: root },
        testsAtCommit: (_repo, testedCommit) => { expect(testedCommit).toBe(repairedCut); return [testFile]; },
        closureTree: () => closureTree, pinnedImage: () => imageDigest,
        readReceipt: () => ({ ...receipt, recordSha256: 'c'.repeat(64) }), finish: () => 0 });
      receiptAuditInput = context.input as unknown as Record<string, unknown>;
      return { exitCode: audited.exitCode, stdout: JSON.stringify(audited.result), stderr: '' };
    }
    return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: `simulated ${nodeId ?? 'release'} boundary` }), stderr: '' };
  };
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      runId, input: { version: '0.3.8', previousVersion: '0.3.7', gateExecutor: 'pod', gatePodPool: 'pool-gcp2@gcp2:1', gateImagePin: 'cut-commit', graphCutover: 'legacy', autoAppendRepair: true },
      deps: { root, runBash },
    });
    const repairId = state.path.find((id) => /^gate-repair-[a-f0-9]{12}$/.test(id));
    expect(state.runId).toBe(runId);
    expect(state.status).toBe('done');
    expect(state.path).toContain('gate-triage');
    expect(repairId).toBeTruthy();
    expect(state.path.indexOf(repairId!)).toBeLessThan(state.path.indexOf('receipt-audit'));
    expect(state.path.indexOf(repairId!)).toBeLessThan(state.path.lastIndexOf('gate'));
    expect(state.path.lastIndexOf('gate')).toBeLessThan(state.path.indexOf('receipt-audit'));
    expect(state.path).toContain('receipt-audit');
    expect(state.adaptiveGateNodeAppends).toHaveLength(1);
    expect(state.adaptiveGateNodeAppends?.[0]).toMatchObject({ request: {
      runId, afterNodeId: 'gate-triage', rerunGateAt: 'gate', auditAfterGate: 'receipt-audit', node: { nodeId: repairId },
    } });
    expect(repairResult).toMatchObject({ outcome: 'ok', commit: repairedCut, requiresReceiptAudit: true,
      appendedPicks: [repairMerge] });
    expect(repairContextRoots).toEqual([runId]);
    expect(gateVisits).toBe(2);
    expect(gateExecutionIds).toHaveLength(2);
    expect(new Set(gateExecutionIds).size).toBe(2);
    expect(receiptAuditInput).toMatchObject({ version: '0.3.8', autoAppendRepair: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HEAL-AUTO-APPEND-REENTER sim: coupled sources stop at same-run HITL without append or audit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-auto-coupled-'));
  const runId = 'heal-auto-coupled-sim';
  const commit = sha('a');
  const failureId = 'src/shared.test.ts > coupled regression';
  let childStarts = 0;
  let repairResult: Awaited<ReturnType<typeof runGateRepairNode>> | undefined;
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      runId, input: { version: '0.3.8', previousVersion: '0.3.7', autoAppendRepair: true, graphCutover: 'legacy' },
      deps: { root, runBash: async (command, options) => {
        const context = readGraphContext(options.env!);
        if (command.includes('version-node.ts release'))
          return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit }), stderr: '' };
        if (command.includes('gate-node.ts --json'))
          return { exitCode: 1, stdout: JSON.stringify({ outcome: 'regression', commit, executionId: context.executionId,
            introduced: [failureId], preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [],
            rcNonzeroNoFailures: [], durationMs: 1 }), stderr: '' };
        if (command.includes('gate-triage-node.ts')) {
          const gate = { outcome: 'regression' as const, commit, introduced: [failureId], preexisting: 0, fixed: null,
            knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 };
          return { exitCode: 0, stdout: JSON.stringify({ ...classifyGateShadow(gate),
            gateExecutionId: context.input.adaptiveGateExecutionId }), stderr: '' };
        }
        if (command.includes('gate-repair-node.ts')) {
          repairResult = await runGateRepairNode(context, { root, repo: root,
            attributeFailures: () => [{ failureId, testFile: 'src/shared.test.ts', sourceFiles: ['src/a.ts', 'src/b.ts'],
              causePrs: [77], confidence: 'high', method: 'first-parent-source-overlap', evidence: [], unresolvedImports: [] }],
            startRepairChild: async () => { childStarts++; throw new Error('coupled repair must not start a child'); },
            appendCut: () => { throw new Error('coupled repair must not append'); },
          });
          return { exitCode: repairResult.outcome === 'ok' ? 0 : 1, stdout: JSON.stringify(repairResult), stderr: '' };
        }
        if (command.includes('gate-file-receipt-audit-node.ts')) throw new Error('coupled repair reached audit');
        return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass' }), stderr: '' };
      } },
    });
    expect(state.pending?.nodeId).toBe('gate-heal-decision');
    expect(state.path.some((id) => /^gate-repair-[a-f0-9]{12}$/.test(id))).toBe(true);
    expect(state.path).not.toContain('receipt-audit');
    expect(repairResult).toMatchObject({ outcome: 'fail', remainingFailureIds: [failureId] });
    expect(childStarts).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
