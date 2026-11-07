import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createGraphEventBus } from '../../src/graph-runner/graph-events.js';
import { runGraph } from '../../src/graph-runner/runner.js';
import { gateTriageShadowFromContext } from './gate-triage-node.js';
import { runGateRepairNode, validateRepairPrInspection } from './gate-repair-node.js';
import { readGraphContext, type GraphContext } from './node-verdict.js';
import { runGateNode } from './gate-node.js';
import { waitForRepairPrLanded } from './repair-pr-landed.js';
import type { GateResult, GateRunner } from './gate-node.js';
import { runPrLand } from '../../src/cli/pr-cli.js';
import { resetEffectiveInstanceRoot } from '../../src/instance/resolve.js';

const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
const scenarioPath = join(import.meta.dir, '../../scenarios/ux-sim/rla-rehearsal-incident-sim-b.yaml');

const gateFailure = (): GateResult => ({ outcome: 'regression', commit: 'e'.repeat(40),
  introduced: ['src/release/test.test.ts > hard rehearsal regression'], preexisting: 0, fixed: null, knownEnv: 0,
  knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 10 });

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

test('RLA repair node rejects draft or multi-file child PRs before waiting for a landing event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-repair-pr-validation-'));
  const context: GraphContext = {
    runId: 'rla-repair-pr-validation',
    input: { version: '0.3.6', previousVersion: '0.3.5' },
    nodeInput: { version: '0.3.6', runId: 'rla-repair-pr-validation', commit: 'd'.repeat(40),
      failureIds: ['src/release/test.test.ts > regression'] },
    outputs: {},
  };
  const invalidInspections = [
    { isDraft: false, headRefOid: 'a'.repeat(40), files: ['src/release/test.test.ts', 'src/release/extra.ts'] },
    { isDraft: true, headRefOid: 'a'.repeat(40), files: ['src/release/test.test.ts'] },
  ];
  try {
    for (const inspection of invalidInspections) {
      let waitCalls = 0;
      await expect(runGateRepairNode(context, {
        root,
        startRepairChild: async () => ({ ok: true, prNumber: 80422,
          prUrl: 'https://github.com/ElanvitalAI/elanous/pull/80422' }),
        inspectRepairPr: async () => inspection,
        waitForLanded: async () => { waitCalls++; throw new Error('wait must not start for an invalid child PR'); },
      })).rejects.toThrow(inspection.isDraft ? 'must be ready' : 'must change only attributed file');
      expect(waitCalls).toBe(0);
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
    await expect(runGateRepairNode(context, {
      root,
      startRepairChild: async () => ({ ok: true, prNumber: 80423,
        prUrl: 'https://github.com/ElanvitalAI/elanous/pull/80423' }),
      inspectRepairPr: async () => ({ isDraft: false, headRefOid: 'a'.repeat(40), files: ['src/release/test.test.ts'] }),
      waitForLanded: async () => ({ schema: 1, prNumber: 80423, repairRunId: context.runId!,
        head: 'b'.repeat(40), mergeSha: 'c'.repeat(40), base: 'main', mergedAt: '2026-11-07T00:00:00Z' }),
    })).rejects.toThrow('differs from inspected head');
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
  const repairPrLifecycle: string[] = [];
  const gateExecutionIds: string[] = [];
  const measuredGateShas: string[] = [];
  const triageGateExecutionIds: string[] = [];
  const commands: string[] = [];
  const gateCommitByTree = new Map<string, string>();
  const testFile = 'src/release/test.test.ts';
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
      const result = await runGateRepairNode(context, {
        root,
        repo: join(import.meta.dir, '../..'),
        startRepairChild: async (featureFile, base) => {
          repairPrOpened++;
          repairPrLifecycle.push('opened');
          expect(base).toBe('main');
          expect(await Bun.file(featureFile).text()).toContain('Attributed source file: src/release/test.test.ts');
          return { ok: true, prNumber: 80421, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/80421',
            branch: 'self-impl/gate-repair', checkedHeadCommit: 'd'.repeat(40) };
        },
        inspectRepairPr: async (prNumber, repo) => {
          repairPrInspected++;
          repairPrLifecycle.push('inspected');
          expect(prNumber).toBe(80421);
          expect(repo).toBe(join(import.meta.dir, '../..'));
          return { isDraft: false, headRefOid: 'd'.repeat(40), files: [testFile] };
        },
        waitForLanded: async (prNumber, eventRoot) => {
          repairLandEventsConsumed++;
          repairPrLifecycle.push('waiting');
          expect(prNumber).toBe(80421);
          expect(eventRoot).toBe(root);
          const abort = new AbortController();
          const waiting = waitForRepairPrLanded(prNumber, { root: eventRoot, repairRunId: runId, signal: abort.signal });
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
      });
      return { exitCode: 0, stdout: JSON.stringify(result), stderr: '' };
    }
    if (body.includes('version-node.ts release --json'))
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit: 'e'.repeat(40) }), stderr: '' };
    const recognizedCommand = [
      'version-node.ts release --json', 'traffic-node.ts traffic-cut-start', 'node-verdict.ts cutoff',
      'checklist-gate-node.ts', 'docs-node.ts --json', 'export-check-node.ts', 'gate-node.ts --json',
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
    const rlaPath = state.path.filter((nodeId) => nodeId === 'gate' || nodeId === 'gate-triage' || /^gate-repair-[a-f0-9]{12}$/.test(nodeId))
      .map((nodeId) => nodeId.startsWith('gate-repair-') ? 'gate-repair' : nodeId);
    expect(rlaPath).toEqual(scenario.expected.pathContains);
    expect(state.path.filter((nodeId) => nodeId === 'gate')).toHaveLength(scenario.expected.gateVisits);
    expect(state.path.filter((nodeId) => nodeId === 'gate-triage-shadow')).toHaveLength(scenario.expected.shadowTriageVisits);
    expect(repairNode).toBeDefined();
    expect(state.path.filter((nodeId) => nodeId === repairNode)).toHaveLength(scenario.expected.repairVisits);
    expect(state.path.indexOf(repairNode!)).toBe(state.path.indexOf('gate') + 2);
    expect(state.path[state.path.indexOf(repairNode!) + 1]).toBe('gate');
    expect(gateVisits).toBe(scenario.expected.gateVisits);
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
});
