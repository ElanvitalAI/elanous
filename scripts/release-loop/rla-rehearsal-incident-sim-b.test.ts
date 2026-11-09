import { expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createGraphEventBus } from '../../src/graph-runner/graph-events.js';
import { runGraph } from '../../src/graph-runner/runner.js';
import { gateTriageShadowFromContext } from './gate-triage-node.js';
import { runGateRepairNode as invokeGateRepairNode, validateRepairPrInspection, type GateRepairNodeDeps } from './gate-repair-node.js';
import { readGraphContext, type GraphContext } from './node-verdict.js';
import { runGateNode } from './gate-node.js';
import { RepairLandingRecoveryExhaustedError, waitForRepairPrLanded } from './repair-pr-landed.js';
import type { GateResult, GateRunner } from './gate-node.js';
import { runPrLand } from '../../src/cli/pr-cli.js';
import { resetEffectiveInstanceRoot } from '../../src/instance/resolve.js';
import type { ReleaseFailureAttribution } from '../../src/release-loop/release-failure-attribution.js';

const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
const scenarioPath = join(import.meta.dir, '../../scenarios/ux-sim/rla-rehearsal-incident-sim-b.yaml');

const gateFailure = (): GateResult => ({ outcome: 'regression', commit: 'e'.repeat(40),
  introduced: ['src/release/test.test.ts > hard rehearsal regression'], preexisting: 0, fixed: null, knownEnv: 0,
  knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 10 });

function attributedSource(failureId: string, testFile: string, sourceFile: string): ReleaseFailureAttribution[] {
  return [{ failureId, testFile, sourceFiles: [sourceFile], causePrs: [35259], unresolvedImports: [], confidence: 'high',
    method: 'first-parent-source-overlap', evidence: [{ commit: 'b'.repeat(40), subject: 'fix: source regression (#35259)', files: [sourceFile] }] }];
}

/** Existing multi-file cases begin with attributed test IDs; route them through the new production consumer seam. */
function simulationAttribution(_input: { repo: string; previousTag: string; cutCommit: string; failureIds: readonly string[] }): ReleaseFailureAttribution[] {
  return _input.failureIds.map((failureId) => {
    const separator = failureId.indexOf(' > ');
    const sourceFile = separator > 0 ? failureId.slice(0, separator) : '';
    const original = separator > 0 ? failureId.slice(separator + 3) : failureId;
    const testFile = original.split(' > ', 1)[0]!.trim();
    return { failureId: original, testFile, sourceFiles: sourceFile ? [sourceFile] : [], causePrs: sourceFile ? [35259] : [],
      unresolvedImports: sourceFile ? [] : ['simulation attribution missing source'], confidence: sourceFile ? 'high' : 'unmeasured',
      method: sourceFile ? 'first-parent-source-overlap' : 'unmeasured',
      evidence: sourceFile ? [{ commit: 'b'.repeat(40), subject: 'fix: simulated source regression (#35259)', files: [sourceFile] }] : [] };
  });
}

function runSimulatedGateRepairNode(context: GraphContext, deps: GateRepairNodeDeps = {}) {
  return invokeGateRepairNode(context, { attributeFailures: simulationAttribution, ...deps });
}

test('RLA repair child PR must be one attributed file and ready before the graph waits for landing', () => {
  expect(() => validateRepairPrInspection('src/release/test.test.ts', {
    isDraft: false, headRefOid: 'a'.repeat(40), files: ['src/release/test.test.ts', 'src/release/extra.ts'],
  })).toThrow('must change only attributed file');
  expect(() => validateRepairPrInspection('src/release/test.test.ts', {
    isDraft: false, headRefOid: 'unknown', files: ['src/release/test.test.ts'],
  })).toThrow('valid head SHA');
  expect(() => validateRepairPrInspection('src/release/test.test.ts', {
    isDraft: true, headRefOid: 'a'.repeat(40), files: ['src/release/test.test.ts'],
  })).toThrow('must be ready before landing-event wait');
  expect(() => validateRepairPrInspection('src/release/test.test.ts', {
    isDraft: false, headRefOid: 'a'.repeat(40), files: ['src/release/test.test.ts'],
  })).not.toThrow();
});

test('RLA repair node routes draft or multi-file child PRs to HITL before waiting for landing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-repair-pr-validation-'));
  const repairFile = 'src/release/gate.ts';
  const failureId = 'src/release/test.test.ts > regression';
  const context: GraphContext = {
    runId: 'rla-repair-pr-validation',
    input: { version: '0.3.6', previousVersion: '0.3.5' },
    nodeInput: { version: '0.3.6', runId: 'rla-repair-pr-validation', commit: 'd'.repeat(40),
      failureIds: ['src/release/test.test.ts > regression'] },
    outputs: {},
  };
  const invalidInspections = [
    { isDraft: false, headRefOid: 'a'.repeat(40), files: [repairFile, 'src/release/extra.ts'] },
    { isDraft: true, headRefOid: 'a'.repeat(40), files: [repairFile] },
  ];
  try {
    for (const inspection of invalidInspections) {
      let waitCalls = 0;
      const result = await runSimulatedGateRepairNode(context, {
        root,
        startRepairChild: async () => ({ ok: true, prNumber: 80422,
          prUrl: 'https://github.com/ElanvitalAI/elanous/pull/80422' }),
        attributeFailures: () => attributedSource(failureId, 'src/release/test.test.ts', repairFile),
        inspectRepairPr: async () => inspection,
        waitForLanded: async () => { waitCalls++; throw new Error('wait must not start for an invalid child PR'); },
      });
      expect(waitCalls).toBe(0);
      if (result.outcome !== 'fail') throw new Error('invalid repair PR must route this file to HITL');
      expect(result.outcome).toBe('fail');
      expect(result.remainingFailureIds).toEqual(['src/release/test.test.ts > regression']);
      expect(result.humanRequired[0]?.reason).toContain(inspection.isDraft ? 'must be ready' : 'must change only attributed file');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RLA repair node rejects a landing event for a different child PR head', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-repair-pr-head-'));
  const context: GraphContext = {
    runId: 'rla-repair-pr-head',
    input: { version: '0.3.6', previousVersion: '0.3.5' },
    nodeInput: { version: '0.3.6', runId: 'rla-repair-pr-head', commit: 'd'.repeat(40),
      failureIds: ['src/release/test.test.ts > regression'] },
    outputs: {},
  };
  try {
    const result = await runSimulatedGateRepairNode(context, {
      root,
      attributeFailures: () => attributedSource('src/release/test.test.ts > regression', 'src/release/test.test.ts', 'src/release/gate.ts'),
      startRepairChild: async () => ({ ok: true, prNumber: 80423,
        prUrl: 'https://github.com/ElanvitalAI/elanous/pull/80423' }),
      inspectRepairPr: async () => ({ isDraft: false, headRefOid: 'a'.repeat(40), files: ['src/release/gate.ts'] }),
      waitForLanded: async () => ({ schema: 1, prNumber: 80423, repairRunId: context.runId!,
        head: 'b'.repeat(40), mergeSha: 'c'.repeat(40), base: 'main', mergedAt: '2026-11-07T00:00:00Z' }),
    });
    if (result.outcome !== 'fail') throw new Error('head mismatch must route this file to HITL');
    expect(result.outcome).toBe('fail');
    expect(result.humanRequired[0]?.reason).toContain('differs from inspected head');
    expect(result.remainingFailureIds).toEqual(['src/release/test.test.ts > regression']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-REPAIR-MULTI-FILE sim: independent source failures launch in parallel and land one-file PRs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-repair-multi-sim-'));
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
  const failureIds = files.map((file, index) => `${file} > src/test-${index}.test.ts > introduced regression`);
  const context: GraphContext = { runId: 'gate-repair-multi-sim', input: { version: '0.3.7', previousVersion: '0.3.6' },
    nodeInput: { version: '0.3.7', runId: 'gate-repair-multi-sim', commit: 'd'.repeat(40), failureIds,
      independenceEvidence: failureIds.map((id, index) => ({ failureId: id.slice(id.indexOf(' > ') + 3), sourceFiles: [files[index]!], unresolvedImports: [] })) }, outputs: {} };
  const started: string[] = [];
  let observedParallel = false;
  const pendingStartReleases: Array<{ resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  let inspections = 0;
  try {
    const result = await runSimulatedGateRepairNode(context, {
      root,
      startRepairChild: async (featureFile) => {
        const body = await Bun.file(featureFile).text();
        const file = files.find((candidate) => body.includes(`Attributed source file: ${candidate}`))!;
        for (const id of failureIds) {
          if (id.startsWith(`${file} >`)) expect(body).toContain(id);
          else expect(body).not.toContain(id);
        }
        started.push(file);
        await new Promise<void>((resolve, reject) => {
          const waiter = { resolve, reject, timer: setTimeout(() => {
            const stranded = pendingStartReleases.splice(0);
            for (const pending of stranded) {
              clearTimeout(pending.timer);
              pending.reject(new Error('parallel repair start barrier timed out; all waiting children were released with failure'));
            }
          }, 2_000) };
          pendingStartReleases.push(waiter);
          if (pendingStartReleases.length === 2) {
            observedParallel = true;
            for (const pending of pendingStartReleases.splice(0)) {
              clearTimeout(pending.timer);
              pending.resolve();
            }
          }
        });
        const prNumber = 80500 + files.indexOf(file);
        return { ok: true, prNumber, prUrl: `https://github.com/ElanvitalAI/elanous/pull/${prNumber}` };
      },
      inspectRepairPr: async (prNumber) => {
        inspections++;
        const file = files[prNumber - 80500]!;
        return { isDraft: false, headRefOid: (String(prNumber).padStart(40, 'a')).slice(-40), files: [file] };
      },
      waitForLanded: async (prNumber) => {
        const file = files[prNumber - 80500]!;
        return { schema: 1, prNumber, repairRunId: context.runId!,
          head: (String(prNumber).padStart(40, 'a')).slice(-40), mergeSha: 'f'.repeat(40), base: 'main', mergedAt: '2026-11-07T00:00:00Z' };
      },
      isAncestor: (ancestor, descendant) => ancestor === descendant,
      refreshMainlineHead: () => 'f'.repeat(40),
    });
    expect(started.sort()).toEqual([...files].sort());
    expect(observedParallel).toBe(true);
    expect(inspections).toBe(4);
    if (result.outcome !== 'ok') throw new Error('independent repair files should all land');
    expect(result.outcome).toBe('ok');
    expect(result.repairs).toHaveLength(4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-REPAIR-MULTI-FILE sim: repairs all 15 independent files in rounds of four with at most two parallel children', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-repair-limits-sim-'));
  const files = Array.from({ length: 15 }, (_, index) => `src/file-${String(index).padStart(2, '0')}.ts`);
  const failureIds = files.map((file, index) => `${file} > src/test-${index}.test.ts > introduced regression`);
  const context: GraphContext = { runId: 'gate-repair-limits-sim', input: { version: '0.3.7', previousVersion: '0.3.6' },
    nodeInput: { version: '0.3.7', runId: 'gate-repair-limits-sim', commit: 'd'.repeat(40), failureIds,
      independenceEvidence: failureIds.map((id, index) => ({ failureId: id.slice(id.indexOf(' > ') + 3), sourceFiles: [files[index]!], unresolvedImports: [] })) }, outputs: {} };
  const started: string[] = [];
  const pending: Array<{ file: string; resolve: (result: { ok: boolean; prNumber: number; prUrl: string }) => void }> = [];
  let active = 0;
  let maximumActive = 0;
  let singleChildTimer: ReturnType<typeof setTimeout> | undefined;
  const releasePending = () => {
    if (singleChildTimer) clearTimeout(singleChildTimer);
    singleChildTimer = undefined;
    const children = pending.splice(0);
    active -= children.length;
    for (const child of children) {
      const prNumber = 80700 + files.indexOf(child.file);
      child.resolve({ ok: true, prNumber, prUrl: `https://github.com/ElanvitalAI/elanous/pull/${prNumber}` });
    }
  };
  try {
    const result = await runSimulatedGateRepairNode(context, {
      root,
      startRepairChild: async (featureFile) => {
        const body = await Bun.file(featureFile).text();
        const file = files.find((candidate) => body.includes(`Attributed source file: ${candidate}`))!;
        started.push(file);
        active++;
        maximumActive = Math.max(maximumActive, active);
        return await new Promise((resolve) => {
          pending.push({ file, resolve });
          if (pending.length === 2) {
            releasePending();
          } else {
            singleChildTimer = setTimeout(releasePending, 10);
          }
        });
      },
      inspectRepairPr: async (prNumber) => ({ isDraft: false, headRefOid: 'a'.repeat(40), files: [files[prNumber - 80700]!] }),
      waitForLanded: async (prNumber) => ({ schema: 1, prNumber, repairRunId: context.runId!, head: 'a'.repeat(40),
        mergeSha: 'f'.repeat(40), base: 'main', mergedAt: '2026-11-07T00:00:00Z' }),
      isAncestor: (ancestor, descendant) => ancestor === descendant,
      refreshMainlineHead: () => 'f'.repeat(40),
    });
    expect(maximumActive).toBe(2);
    expect(started.sort()).toEqual([...files].sort());
    expect(result.outcome).toBe('ok');
    expect(result.repairedFiles).toHaveLength(15);
    expect(result.humanRequired ?? []).toHaveLength(0);
  } finally { if (singleChildTimer) clearTimeout(singleChildTimer); rmSync(root, { recursive: true, force: true }); }
});

test('GATE-REPAIR-MULTI-FILE sim: coupled source attribution routes to HITL before launching children', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-repair-coupled-sim-'));
  const failureIds = ['src/a.ts > src/shared.test.ts > introduced regression', 'src/b.ts > src/shared.test.ts > introduced regression'];
  const context: GraphContext = { runId: 'gate-repair-coupled-sim', input: { version: '0.3.7', previousVersion: '0.3.6' },
    nodeInput: { version: '0.3.7', runId: 'gate-repair-coupled-sim', commit: 'd'.repeat(40), failureIds }, outputs: {} };
  let childCalls = 0;
  try {
    const result = await runSimulatedGateRepairNode(context, { root, startRepairChild: async () => {
      childCalls++;
      return { ok: false };
    } });
    expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail', repairedFiles: [],
      remainingFailureIds: ['src/shared.test.ts > introduced regression'] });
    expect(result.summary).toContain('HITL needed');
    expect(result.humanRequired?.length).toBe(2);
    expect(result.humanRequired?.every(({ reason }) => reason.includes('does not prove independent failing tests'))).toBe(true);
    expect(childCalls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-REPAIR-MULTI-FILE sim: separate tests with overlapping source closures stay on HITL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-repair-shared-test-file-sim-'));
  const failureIds = ['src/a.ts > src/a.test.ts > regression', 'src/b.ts > src/b.test.ts > regression'];
  const context: GraphContext = { runId: 'gate-repair-shared-test-file-sim', input: { version: '0.3.7', previousVersion: '0.3.6' },
    nodeInput: { version: '0.3.7', runId: 'gate-repair-shared-test-file-sim', commit: 'd'.repeat(40), failureIds,
      independenceEvidence: [
        { failureId: 'src/a.test.ts > regression', sourceFiles: ['src/a.ts', 'src/shared.ts'], unresolvedImports: [] },
        { failureId: 'src/b.test.ts > regression', sourceFiles: ['src/b.ts', 'src/shared.ts'], unresolvedImports: [] },
      ] }, outputs: {} };
  let childCalls = 0;
  try {
    const result = await runSimulatedGateRepairNode(context, { root, attributeFailures: () => [
      { failureId: 'src/a.test.ts > regression', testFile: 'src/a.test.ts', sourceFiles: ['src/a.ts', 'src/shared.ts'],
        causePrs: [35259], unresolvedImports: [], confidence: 'high', method: 'first-parent-source-overlap',
        evidence: [{ commit: 'b'.repeat(40), subject: 'fix: simulated source regression (#35259)', files: ['src/a.ts', 'src/shared.ts'] }] },
      { failureId: 'src/b.test.ts > regression', testFile: 'src/b.test.ts', sourceFiles: ['src/b.ts', 'src/shared.ts'],
        causePrs: [35259], unresolvedImports: [], confidence: 'high', method: 'first-parent-source-overlap',
        evidence: [{ commit: 'c'.repeat(40), subject: 'fix: simulated source regression (#35259)', files: ['src/b.ts', 'src/shared.ts'] }] },
    ], startRepairChild: async () => {
      childCalls++;
      return { ok: false };
    } });
    expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail', repairedFiles: [],
      remainingFailureIds: ['src/a.test.ts > regression', 'src/b.test.ts > regression'] });
    expect(result.humanRequired?.map(({ file }) => file)).toEqual(['src/a.ts', 'src/shared.ts', 'src/b.ts']);
    expect(result.humanRequired?.every(({ reason }) => reason.includes('does not prove independent failing tests'))).toBe(true);
    expect(childCalls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-REPAIR-MULTI-FILE sim: equal merge timestamps select the mainline head containing every repair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-repair-ancestry-sim-'));
  const files = ['src/a.ts', 'src/b.ts'];
  const commits = ['1'.repeat(40), '2'.repeat(40)];
  const refreshedMainline = '3'.repeat(40);
  const context: GraphContext = { runId: 'gate-repair-ancestry-sim', input: { version: '0.3.7', previousVersion: '0.3.6' },
    nodeInput: { version: '0.3.7', runId: 'gate-repair-ancestry-sim', commit: 'd'.repeat(40),
      failureIds: files.map((file, index) => `${file} > src/failure-${index}.test.ts > introduced regression`),
      independenceEvidence: files.map((file, index) => ({ failureId: `src/failure-${index}.test.ts > introduced regression`, sourceFiles: [file], unresolvedImports: [] })) }, outputs: {} };
  const landedByPr = new Map<number, string>();
  try {
    const result = await runSimulatedGateRepairNode(context, {
      root,
      startRepairChild: async (featureFile) => {
        const body = await Bun.file(featureFile).text();
        const file = files.find((candidate) => body.includes(`Attributed source file: ${candidate}`))!;
        const prNumber = 80700 + files.indexOf(file);
        landedByPr.set(prNumber, commits[files.indexOf(file)]!);
        return { ok: true, prNumber, prUrl: `https://github.com/ElanvitalAI/elanous/pull/${prNumber}` };
      },
      inspectRepairPr: async (prNumber) => ({ isDraft: false, headRefOid: 'a'.repeat(40), files: [files[prNumber - 80700]!] }),
      waitForLanded: async (prNumber) => ({ schema: 1, prNumber, repairRunId: context.runId!,
        head: 'a'.repeat(40), mergeSha: landedByPr.get(prNumber)!, base: 'main', mergedAt: '2026-11-07T00:00:00Z' }),
      isAncestor: (ancestor, descendant) => ancestor === descendant || (ancestor === commits[0]
        && (descendant === commits[1] || descendant === refreshedMainline)) || (ancestor === commits[1] && descendant === refreshedMainline),
      refreshMainlineHead: () => refreshedMainline,
    });
    if (result.outcome !== 'ok') throw new Error('ancestry-verified repair set should be resumable');
    expect(result.commit).toBe(refreshedMainline);
    expect(result.repairs.filter((repair) => repair.status === 'repaired').map((repair) => repair.mergedAt))
      .toEqual(['2026-11-07T00:00:00Z', '2026-11-07T00:00:00Z']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-REPAIR-MULTI-FILE sim: only landed repairs missing from mainline are added to partial HITL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-repair-partial-mainline-sim-'));
  const files = ['src/present.ts', 'src/missing.ts', 'src/not-landed.ts'];
  const context: GraphContext = { runId: 'gate-repair-partial-mainline-sim', input: { version: '0.3.7', previousVersion: '0.3.6' },
    nodeInput: { version: '0.3.7', runId: 'gate-repair-partial-mainline-sim', commit: 'd'.repeat(40),
      failureIds: files.map((file, index) => `${file} > src/failure-${index}.test.ts > introduced regression`),
      independenceEvidence: files.map((file, index) => ({ failureId: `src/failure-${index}.test.ts > introduced regression`, sourceFiles: [file], unresolvedImports: [] })) }, outputs: {} };
  try {
    const result = await runSimulatedGateRepairNode(context, {
      root,
      startRepairChild: async (featureFile) => {
        const body = await Bun.file(featureFile).text();
        const file = files.find((candidate) => body.includes(`Attributed source file: ${candidate}`))!;
        const prNumber = 80800 + files.indexOf(file);
        return { ok: true, prNumber, prUrl: `https://github.com/ElanvitalAI/elanous/pull/${prNumber}` };
      },
      inspectRepairPr: async (prNumber) => ({ isDraft: false, headRefOid: 'a'.repeat(40), files: [files[prNumber - 80800]!] }),
      waitForLanded: async (prNumber) => {
        if (prNumber === 80802) throw new Error('repair PR did not land');
        return { schema: 1, prNumber, repairRunId: context.runId!,
          head: 'a'.repeat(40), mergeSha: prNumber === 80800 ? '1'.repeat(40) : '2'.repeat(40),
          base: 'main', mergedAt: '2026-11-07T00:00:00Z' };
      },
      refreshMainlineHead: () => '3'.repeat(40),
      isAncestor: (ancestor, descendant) => ancestor === '1'.repeat(40) && descendant === '3'.repeat(40),
    });
    if (result.outcome !== 'fail') throw new Error('missing repair ancestry must route only the missing file to HITL');
    expect(result.repairedFiles).toEqual(['src/present.ts']);
    expect(result.humanRequired.map(({ file }) => file)).toEqual(['src/not-landed.ts', 'src/missing.ts']);
    expect(result.remainingFailureIds).toEqual([
      'src/failure-2.test.ts > introduced regression',
      'src/failure-1.test.ts > introduced regression',
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-REPAIR-MULTI-FILE sim: fetches landed repair commit into an old checkout before ancestry verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-repair-stale-checkout-sim-'));
  const origin = join(root, 'origin.git'), seed = join(root, 'seed'), repo = join(root, 'repo');
  mkdirSync(seed, { recursive: true });
  const gitEnv = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Release sim', GIT_AUTHOR_EMAIL: 'release-sim@example.invalid',
    GIT_COMMITTER_NAME: 'Release sim', GIT_COMMITTER_EMAIL: 'release-sim@example.invalid' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
  try {
    git(root, 'init', '--bare', '--initial-branch=main', origin);
    git(seed, 'init', '--initial-branch=main');
    git(seed, 'config', 'user.name', 'Release sim');
    git(seed, 'config', 'user.email', 'release-sim@example.invalid');
    writeFileSync(join(seed, 'tracked.txt'), 'initial\n');
    git(seed, 'add', 'tracked.txt');
    git(seed, 'commit', '-m', 'initial');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-u', 'origin', 'main');
    git(root, 'clone', origin, repo);
    writeFileSync(join(seed, 'tracked.txt'), 'repair landed\n');
    git(seed, 'add', 'tracked.txt');
    git(seed, 'commit', '-m', 'repair merge');
    git(seed, 'push', 'origin', 'main');
    const mergeSha = git(seed, 'rev-parse', 'HEAD');
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(mergeSha);

    const context: GraphContext = { runId: 'gate-repair-stale-checkout-sim', input: { version: '0.3.7', previousVersion: '0.3.6' },
      nodeInput: { version: '0.3.7', runId: 'gate-repair-stale-checkout-sim', commit: 'd'.repeat(40),
        failureIds: ['src/repaired.ts > introduced regression'] }, outputs: {} };
    const result = await runSimulatedGateRepairNode(context, {
      root, repo,
      startRepairChild: async () => ({ ok: true, prNumber: 80900,
        prUrl: 'https://github.com/ElanvitalAI/elanous/pull/80900' }),
      inspectRepairPr: async () => ({ isDraft: false, headRefOid: 'a'.repeat(40), files: ['src/repaired.ts'] }),
      waitForLanded: async () => ({ schema: 1, prNumber: 80900, repairRunId: context.runId!,
        head: 'a'.repeat(40), mergeSha, base: 'main', mergedAt: '2026-11-07T00:00:00Z' }),
    });
    if (result.outcome !== 'ok') throw new Error('fetched landed repair must allow same-run remeasurement');
    expect(result.commit).toBe(mergeSha);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-REPAIR-MULTI-FILE sim: tangled and failed files go to HITL while landed siblings stay repaired', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-repair-partial-sim-'));
  const files = ['src/fixed.ts', 'src/tangled.ts', 'src/shared.ts', 'src/failed.ts'];
  const failureIds = [
    'src/fixed.ts > src/fixed.test.ts > regression',
    'src/tangled.ts > src/shared.test.ts > regression',
    'src/shared.ts > src/shared.test.ts > regression',
    'src/failed.ts > src/failed.test.ts > regression',
  ];
  const context: GraphContext = { runId: 'gate-repair-partial-sim', input: { version: '0.3.7', previousVersion: '0.3.6' },
    nodeInput: { version: '0.3.7', runId: 'gate-repair-partial-sim', commit: 'd'.repeat(40), failureIds,
      independenceEvidence: [
        { failureId: 'src/fixed.test.ts > regression', sourceFiles: ['src/fixed.ts'], unresolvedImports: [] },
        { failureId: 'src/shared.test.ts > regression', sourceFiles: ['src/tangled.ts', 'src/shared.ts'], unresolvedImports: [] },
        { failureId: 'src/failed.test.ts > regression', sourceFiles: ['src/failed.ts'], unresolvedImports: [] },
      ] }, outputs: {} };
  try {
    const result = await runSimulatedGateRepairNode(context, {
      root,
      startRepairChild: async (featureFile) => {
        const body = await Bun.file(featureFile).text();
        const file = files.find((candidate) => body.includes(`Attributed source file: ${candidate}`))!;
        const prNumber = 80600 + files.indexOf(file);
        return { ok: true, prNumber, prUrl: `https://github.com/ElanvitalAI/elanous/pull/${prNumber}` };
      },
      inspectRepairPr: async (prNumber) => {
        const file = files[prNumber - 80600]!;
        return { isDraft: false, headRefOid: 'a'.repeat(40),
          files: file === 'src/tangled.ts' ? [file, 'src/shared.ts'] : [file] };
      },
      waitForLanded: async (prNumber) => {
        const file = files[prNumber - 80600]!;
        if (file === 'src/failed.ts') throw new Error('repair PR did not land');
        return { schema: 1, prNumber, repairRunId: context.runId!, head: 'a'.repeat(40), mergeSha: 'f'.repeat(40),
          base: 'main', mergedAt: '2026-11-07T00:00:00Z' };
      },
      refreshMainlineHead: () => 'f'.repeat(40),
      isAncestor: (ancestor, descendant) => ancestor === descendant,
    });
    if (result.outcome !== 'fail') throw new Error('partial repairs must leave unresolved files for HITL');
    expect(result.outcome).toBe('fail');
    expect(result.repairedFiles).toEqual(['src/fixed.ts']);
    expect(result.remainingFailureIds).toEqual(['src/shared.test.ts > regression', 'src/failed.test.ts > regression']);
    expect(result.humanRequired.map(({ file }) => file).sort()).toEqual(['src/failed.ts', 'src/shared.ts', 'src/tangled.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-REPAIR-MULTI-FILE sim: landing recovery waits for sibling repairs and preserves both outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-repair-recovery-siblings-'));
  const files = ['src/recovery.ts', 'src/landed.ts'];
  const context: GraphContext = { runId: 'gate-repair-recovery-siblings', input: { version: '0.3.7', previousVersion: '0.3.6' },
    nodeInput: { version: '0.3.7', runId: 'gate-repair-recovery-siblings', commit: 'd'.repeat(40),
      failureIds: files.map((file, index) => `${file} > src/failure-${index}.test.ts > regression`),
      independenceEvidence: files.map((file, index) => ({ failureId: `src/failure-${index}.test.ts > regression`, sourceFiles: [file], unresolvedImports: [] })) }, outputs: {} };
  const completed: string[] = [];
  try {
    const result = await runSimulatedGateRepairNode(context, {
      root,
      startRepairChild: async (featureFile) => {
        const body = await Bun.file(featureFile).text();
        const file = files.find((candidate) => body.includes(`Attributed source file: ${candidate}`))!;
        const prNumber = 81000 + files.indexOf(file);
        return { ok: true, prNumber, prUrl: `https://github.com/ElanvitalAI/elanous/pull/${prNumber}` };
      },
      inspectRepairPr: async (prNumber) => ({ isDraft: false, files: [files[prNumber - 81000]!], headRefOid: 'a'.repeat(40) }),
      waitForLanded: async (prNumber) => {
        const file = files[prNumber - 81000]!;
        await new Promise((resolve) => setTimeout(resolve, file === 'src/recovery.ts' ? 5 : 35));
        completed.push(file);
        if (file === 'src/recovery.ts') throw new RepairLandingRecoveryExhaustedError('PR #81000 run gate-repair-recovery-siblings inspected head ' + 'a'.repeat(40));
        return { schema: 1, prNumber, repairRunId: context.runId!, head: 'a'.repeat(40), mergeSha: 'f'.repeat(40),
          base: 'main', mergedAt: '2026-11-07T00:00:00Z' };
      },
      refreshMainlineHead: () => 'f'.repeat(40),
      isAncestor: (ancestor, descendant) => ancestor === descendant,
    });
    expect(completed.sort()).toEqual([...files].sort());
    if (result.outcome !== 'recovery-required') throw new Error('recovery exhaustion must return structured recovery-required output');
    expect(result.outcome).toBe('recovery-required');
    expect(result.repairedFiles).toEqual(['src/landed.ts']);
    expect(result.repairs).toMatchObject([
      { file: 'src/landed.ts', status: 'repaired' },
      { file: 'src/recovery.ts', status: 'recovery-required' },
    ]);
    expect(result.remainingFailureIds).toEqual(['src/failure-0.test.ts > regression']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RLA rehearsal incident SIM-B uses release.gate.failed ARG append and same-run wake in live mode', async () => {
  const scenario = parseYaml(await Bun.file(scenarioPath).text()) as {
    id: string;
    fault: { source: string; firstGateOutcome: string; repairOutcome: string };
    sameRun: { processRestart: boolean; resumeCli: boolean };
    expected: { event: string; sourceNode: string; pathContains: string[]; gateVisits: number; gateExecutions: number;
      gateExecutionIdsDistinct: boolean; priorGateInvalidated: boolean; repairVisits: number;
      status: string; shadowTriageVisits: number };
    boundaries: { injectedCommandsOnly: boolean; externalPublish: boolean; externalCloud: boolean };
  };
  expect(scenario.id).toBe('rla-rehearsal-incident-sim-b');
  expect(scenario.fault.source).toBe('hard-5h rehearsal gate');
  expect(scenario.fault.firstGateOutcome).toBe('regression');
  expect(scenario.fault.repairOutcome).toBe('ok');
  expect(scenario.expected.status).toBe('done');
  expect(scenario.sameRun).toEqual({ processRestart: false, resumeCli: false });
  expect(scenario.boundaries).toEqual({ injectedCommandsOnly: true, externalPublish: false, externalCloud: false });

  const root = mkdtempSync(join(tmpdir(), 'rla-rehearsal-sim-b-'));
  const runId = 'rla-rehearsal-sim-b-live';
  const events: Array<{ type: string; graphId: string; runId: string; source: { nodeId?: string }; data?: Record<string, unknown> }> = [];
  const bus = createGraphEventBus();
  bus.subscribe((event) => {
    if (event.type === scenario.expected.event && event.graphId === 'release-loop' && event.runId === runId) {
      events.push(event as typeof events[number]);
    }
  });
  let gateVisits = 0;
  let repairVisits = 0;
  let repairPrOpened = 0;
  let repairPrInspected = 0;
  let repairLandEventsConsumed = 0;
  let receiptAuditVisits = 0;
  const repairPrLifecycle: string[] = [];
  const gateExecutionIds: string[] = [];
  const measuredGateShas: string[] = [];
  const triageGateExecutionIds: string[] = [];
  const commands: string[] = [];
  const gateCommitByTree = new Map<string, string>();
  const testFile = 'src/release/test.test.ts';
  const sourceFile = 'src/release/gate.ts';
  const failureOutput = `${testFile}:\n(fail) hard rehearsal regression [1.00ms]\n1 fail\nRan 1 tests across 1 files.\n`;
  const gateRunner: GateRunner = {
    async command(command, args, cwd) {
      if (command === 'bun' && args[0] === 'install') return { rc: 0, output: '' };
      if (command === 'git' && args[0] === 'ls-files') return { rc: 0, output: `${testFile}\0` };
      if (command === 'bun' && args[0] === 'run') {
        return gateCommitByTree.get(cwd) === 'e'.repeat(40)
          ? { rc: 1, output: failureOutput }
          : { rc: 0, output: `1 pass\n0 fail\nRan 1 tests across 1 files.\n` };
      }
      return { rc: 0, output: '' };
    },
    async localCommand() { return { rc: 0, output: '' }; },
    async sweep(tree) {
      const measuredSha = gateCommitByTree.get(tree);
      expect(measuredSha).toBeString();
      if (tree.endsWith('/cut')) measuredGateShas.push(measuredSha!);
      return measuredSha === 'e'.repeat(40) ? { rc: 1, output: failureOutput } : { rc: 0, output: `1 pass\n0 fail\nRan 1 tests across 1 files.\n` };
    },
    async add(tree, commit) { gateCommitByTree.set(tree, commit); },
    async remove(tree) { gateCommitByTree.delete(tree); },
    async snapshot(tree, commit) { gateCommitByTree.set(tree, commit); },
    async removeSnapshot(tree) { gateCommitByTree.delete(tree); },
  };
  const runBash = async (body: string, options: { env?: NodeJS.ProcessEnv }) => {
    commands.push(body);
    if (body.includes('gate-node.ts --json')) {
      gateVisits++;
      const gateContext = readGraphContext(options.env);
      expect(gateContext.executionId).toBeString();
      gateExecutionIds.push(gateContext.executionId!);
      const gateOutput = spyOn(console, 'log').mockImplementation(() => {});
      let exitCode: number;
      let stdout = '';
      const previousStateDir = process.env.ELANOUS_STATE_DIR;
      process.env.ELANOUS_STATE_DIR = root;
      resetEffectiveInstanceRoot();
      try {
        if (gateVisits === 2) {
          const repairOutput = Object.entries(gateContext.outputs).find(([nodeId]) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId))?.[1];
          expect(repairOutput?.commit).toBe('f'.repeat(40));
        }
        exitCode = await runGateNode(['--json'], options.env ?? {}, gateRunner);
        stdout = String(gateOutput.mock.calls.at(-1)?.[0] ?? '');
      } finally {
        gateOutput.mockRestore();
        if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
        else process.env.ELANOUS_STATE_DIR = previousStateDir;
        resetEffectiveInstanceRoot();
      }
      const emitted = JSON.parse(stdout) as Record<string, unknown>;
      expect(emitted.commit).toBe(measuredGateShas.at(-1));
      expect(emitted.outcome).toBe(gateVisits === 1 ? 'fail' : 'ok');
      return { exitCode, stdout, stderr: '' };
    }
    if (body.includes('gate-triage-node.ts')) {
      const triageContext = readGraphContext(options.env);
      const classified = gateTriageShadowFromContext(triageContext);
      expect(classified.classification).toBe('regression');
      expect(classified.introduced).toEqual([`${testFile} > hard rehearsal regression`]);
      triageGateExecutionIds.push(classified.gateExecutionId ?? 'missing');
      expect(triageContext.input.adaptiveGateExecutionId).toBe(classified.gateExecutionId);
      return { exitCode: 0, stdout: JSON.stringify(classified), stderr: '' };
    }
    if (body.includes('gate-repair-node.ts')) {
      repairVisits++;
      const entrypoint = join(import.meta.dir, 'gate-repair-node.ts');
      expect(existsSync(entrypoint)).toBe(true);
      const context = readGraphContext(options.env);
      const result = await runSimulatedGateRepairNode(context, {
        root,
        repo: join(import.meta.dir, '../..'),
        attributeFailures: () => attributedSource(`${testFile} > hard rehearsal regression`, testFile, sourceFile),
        startRepairChild: async (featureFile, base) => {
          repairPrOpened++;
          repairPrLifecycle.push('opened');
          expect(base).toBe('main');
          expect(await Bun.file(featureFile).text()).toContain(`Attributed source file: ${sourceFile}`);
          return { ok: true, prNumber: 80421, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/80421',
            branch: 'self-impl/gate-repair', checkedHeadCommit: 'd'.repeat(40) };
        },
        inspectRepairPr: async (prNumber, repo) => {
          repairPrInspected++;
          repairPrLifecycle.push('inspected');
          expect(prNumber).toBe(80421);
          expect(repo).toBe(join(import.meta.dir, '../..'));
          return { isDraft: false, headRefOid: 'd'.repeat(40), files: [sourceFile] };
        },
        waitForLanded: async (prNumber, eventRoot) => {
          repairLandEventsConsumed++;
          repairPrLifecycle.push('waiting');
          expect(prNumber).toBe(80421);
          expect(eventRoot).toBe(root);
          const abort = new AbortController();
          let notifyLanding: (() => void) | undefined;
          const waiting = waitForRepairPrLanded(prNumber, {
            root: eventRoot,
            repairRunId: runId,
            signal: abort.signal,
            // Model the filesystem notification boundary deterministically; the
            // receipt itself is still written and read from the test universe.
            watchDirectory: (_directory, onEvent) => {
              notifyLanding = onEvent;
              return () => {};
            },
          });
          const previousStateDir = process.env.ELANOUS_STATE_DIR;
          process.env.ELANOUS_STATE_DIR = root;
          resetEffectiveInstanceRoot();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const landCode = await runPrLand({ body: 'RLA gate repair SIM-B landing.' }, {
              prodFreezeRoot: join(root, 'freeze'),
              currentBranch: () => 'self-impl/gate-repair',
              resolveBase: () => 'origin/main',
              run: (command, args) => {
                if (command === 'git' && args[0] === 'rev-parse') {
                  if (args[1] === 'HEAD') return { ok: true, out: 'd'.repeat(40) };
                  if (args[1] === '--show-toplevel') return { ok: true, out: process.cwd() };
                }
                if (command === 'git' && args[0] === 'remote') return { ok: true, out: args[1] === 'get-url' ? 'https://github.com/ElanvitalAI/elanous.git' : 'origin' };
                if (command === 'git' && args[0] === 'diff') return { ok: true, out: '' };
                if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
                  if (args.includes('title,headRefOid,baseRefName,mergedAt,mergeCommit')) return { ok: true, out: JSON.stringify({
                    title: `RLA-GATE-REPAIR ${runId} 0.3.6: src/release/test.ts`, headRefOid: 'd'.repeat(40), baseRefName: 'main',
                    mergedAt: '2026-11-07T00:00:00Z', mergeCommit: { oid: 'f'.repeat(40) },
                  }) };
                  if (args.includes('baseRefName')) return { ok: true, out: JSON.stringify({ baseRefName: 'main' }) };
                  if (args.includes('labels')) return { ok: true, out: '' };
                }
                return { ok: true, out: '' };
              },
              listUnfinishedRuns: () => [],
              queryRunningRuns: () => { throw new Error('observation unavailable'); },
              runTypecheckGate: () => true,
              runIsolationGate: () => true,
              runMockModuleRestoreGate: () => true,
              runModelHardcodeGate: () => true,
              runDaemonPortGate: () => true,
              runPublicLeakGate: () => 0,
              runExportLeakCheck: () => ({ measured: true, hits: [] }),
              runExportImportCheck: () => ({ measured: true, hits: [], unseen: 0 }),
              runTestInterferenceGate: async () => 0,
              runLandGlobalChecks: () => true,
              runAndroidGate: () => true,
              runIosGate: () => true,
              runPwaGate: () => true,
              listOpenPrs: () => [],
              out: { log: () => {}, error: () => {} },
              manager: {
                findPrForBranchOutcome: () => ({ status: 'NOT_FOUND' }),
                upsertPr: () => ({ ok: true, url: `https://github.com/ElanvitalAI/elanous/pull/${prNumber}`, reused: false }),
                mergePrOutcome: () => ({ ok: true, kind: 'merged' }),
              } as never,
            });
            expect(landCode).toBe(0);
            notifyLanding?.();
            return await Promise.race([waiting, new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => { abort.abort(); reject(new Error('runPrLand did not publish the repair landing event')); }, 1_000);
            })]);
          } finally {
            if (timeout) clearTimeout(timeout);
            if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
            else process.env.ELANOUS_STATE_DIR = previousStateDir;
            resetEffectiveInstanceRoot();
          }
        },
        isAncestor: (ancestor, descendant) => ancestor === descendant,
        refreshMainlineHead: () => 'f'.repeat(40),
      });
      return { exitCode: 0, stdout: JSON.stringify(result), stderr: '' };
    }
    if (body.includes('version-node.ts release --json'))
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit: 'e'.repeat(40) }), stderr: '' };
    if (body.includes('gate-file-receipt-audit-node.ts')) {
      receiptAuditVisits++;
      const context = readGraphContext(options.env);
      expect(context.nodeId).toBe('receipt-audit');
      expect(context.runId).toBe(runId);
      expect(context.outputs.gate).toMatchObject({ outcome: 'ok', commit: 'f'.repeat(40) });
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit: 'f'.repeat(40) }), stderr: '' };
    }
    const recognizedCommand = [
      'version-node.ts release --json', 'release-readiness.ts', 'traffic-node.ts traffic-cut-start', 'node-verdict.ts cutoff',
      'checklist-gate-node.ts', 'docs-node.ts --json', 'export-check-node.ts', 'gate-node.ts --json',
      'emergency-publish-switch-sim.ts', 'gate-file-receipt-audit-node.ts',
      'gate-triage-node.ts', 'gate-repair-node.ts',
      'traffic-node.ts traffic-gate-passed', 'mac-smoke-node.ts', 'node-verdict.ts pwa',
      'prepare-node.ts', 'upgrade-node.ts', 'docs-node.ts --json', 'known-issues-node.ts',
      'check-node.ts --json', 'auto-approve-node.ts', 'publish-node.ts', 'npm-publish-node.ts',
      'traffic-node.ts traffic-npm-published', 'docs-land-node.ts', 'version-node.ts dev-bump --json', 'verify-node.ts',
      'traffic-node.ts traffic-verify-complete', 'vault-note-node.ts', 'draft.ts --graph',
      'ops-upgrade-node.ts',
    ].some((marker) => body.includes(marker));
    if (!recognizedCommand) throw new Error(`unexpected release graph command in SIM-B: ${body}`);
    return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
  };

  try {
    mkdirSync(join(root, 'release', '0.3.5'), { recursive: true });
    await Bun.write(join(root, 'release', '0.3.5', 'release.json'), JSON.stringify({ sourceCommit: 'd'.repeat(40) }));
    const state = await runGraph(graphPath, {
      runId,
      pinChildUniverse: true,
      input: { version: '0.3.6', previousVersion: '0.3.5' },
      eventBus: bus,
      deps: { root, runBash },
    });
    const repairNode = state.path.find((nodeId) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId));
    expect(state.status).toBe('done');
    expect(state.path).toContain('gate-triage');
    expect(state.path).toContain('receipt-audit');
    expect(state.path).not.toContain('residual-run');
    const rlaPath = state.path.filter((nodeId) => nodeId === 'gate' || nodeId === 'gate-triage' || /^gate-repair-[a-f0-9]{12}$/.test(nodeId))
      .map((nodeId) => nodeId.startsWith('gate-repair-') ? 'gate-repair' : nodeId);
    expect(rlaPath).toEqual(scenario.expected.pathContains);
    expect(state.path.filter((nodeId) => nodeId === 'gate')).toHaveLength(scenario.expected.gateVisits);
    expect(state.path.filter((nodeId) => nodeId === 'gate-triage-shadow')).toHaveLength(scenario.expected.shadowTriageVisits);
    expect(repairNode).toBeDefined();
    expect(state.path.filter((nodeId) => nodeId === repairNode)).toHaveLength(scenario.expected.repairVisits);
    expect(state.path.indexOf(repairNode!)).toBe(state.path.indexOf('gate-triage') + 1);
    expect(state.path[state.path.indexOf(repairNode!) + 1]).toBe('gate');
    expect(gateVisits).toBe(scenario.expected.gateVisits);
    expect(receiptAuditVisits).toBe(1);
    expect(repairVisits).toBe(scenario.expected.repairVisits);
    expect(repairPrOpened).toBe(1);
    expect(repairPrInspected).toBe(1);
    expect(repairPrLifecycle).toEqual(['opened', 'inspected', 'waiting']);
    expect(repairLandEventsConsumed).toBe(1);
    expect(gateExecutionIds).toHaveLength(scenario.expected.gateExecutions);
    expect(new Set(gateExecutionIds).size).toBe(scenario.expected.gateExecutionIdsDistinct ? 2 : 1);
    expect(measuredGateShas).toEqual(['e'.repeat(40), 'f'.repeat(40)]);
    expect(triageGateExecutionIds).toEqual([gateExecutionIds[0]]);
    const secondGateTriage = gateTriageShadowFromContext({
      input: { version: '0.3.6', previousVersion: '0.3.5', adaptiveGateExecutionId: gateExecutionIds[1] },
      outputs: { gate: { ...gateFailure(), outcome: 'regression', executionId: gateExecutionIds[1] } },
    });
    expect(secondGateTriage.gateExecutionId).toBe(gateExecutionIds[1]);
    expect(() => gateTriageShadowFromContext({
      input: { version: '0.3.6', previousVersion: '0.3.5', adaptiveGateExecutionId: gateExecutionIds[1] },
      outputs: { gate: { ...gateFailure(), outcome: 'regression', executionId: gateExecutionIds[0] } },
    })).toThrow('latest gate execution id');
    expect(state.nodes.find((node) => node.nodeId === 'gate')?.invalidatedByEvent).toBe(state.adaptiveGateNodeAppends?.[0]?.eventId);
    expect(state.nodes.find((node) => node.nodeId === 'gate')?.output).toBeUndefined();
    expect(state.nodes.find((node) => node.nodeId === 'gate')?.invalidatedByEvent !== undefined).toBe(scenario.expected.priorGateInvalidated);
    expect(state.adaptiveGateNodeAppends).toHaveLength(1);
    expect(state.adaptiveGateNodeAppends?.[0]).toMatchObject({ graphRevision: 2,
      request: { graphId: 'release-loop', runId, eventId: expect.any(String), afterNodeId: 'gate-triage',
        resumeFrom: repairNode, rerunGateAt: 'gate', maxRepairRetries: 1 } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: scenario.expected.event, graphId: 'release-loop', runId,
      source: { nodeId: scenario.expected.sourceNode },
      data: { version: '0.3.6', sourceOutcome: 'fail', gate: { outcome: 'regression' }, triage: { classification: 'regression' },
        visitState: { gate: 1, gateTriage: 1 } } });
    expect(commands.some((body) => body.includes('gate-repair-node.ts'))).toBe(true);
    console.log(JSON.stringify({ scenario: scenario.id, status: state.status, path: state.path,
      event: events[0]?.type, appendCount: state.adaptiveGateNodeAppends?.length, gateVisits, repairVisits,
      gateExecutionIds, mode: 'live', processRestart: false, resumeCli: false, externalPublish: false, externalCloud: false }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
