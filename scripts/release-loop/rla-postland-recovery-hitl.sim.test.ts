import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { decideGraphApproval, runGraph } from '../../src/graph-runner/runner.js';
import { resetEffectiveInstanceRoot } from '../../src/instance/resolve.js';
import { runGateRepairNodeCli } from './gate-repair-node.js';
import { gateTriageShadowFromContext } from './gate-triage-node.js';
import { readGraphContext } from './node-verdict.js';

test('same release run parks on HITL after bounded landing recovery fails, then approves into a fresh gate visit', async () => {
  const scenarioPath = join(import.meta.dir, '../../scenarios/ux-sim/rla-postland-recovery-hitl.yaml');
  const scenario = parseYaml(await Bun.file(scenarioPath).text()) as {
    id: string;
    expected: { sameRun: boolean; recoveryAttempts: number; pendingNode: string; approvalContinuesAt: string;
      gateExecutions: number; terminalStatus: 'failed' };
    boundaries: { productionGraphRunner: string; productionGateRepairNode: string; githubAndClock: string };
  };
  expect(scenario.id).toBe('rla-postland-recovery-hitl');
  expect(scenario.expected.sameRun).toBe(true);
  expect(scenario.boundaries).toEqual({ productionGraphRunner: 'real', productionGateRepairNode: 'real', githubAndClock: 'simulated' });
  const productionGraphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const productionGraph = parseYaml(await Bun.file(productionGraphPath).text()) as {
    graph_id: string; version: number; entry_node: string; terminal_nodes: string[];
    nodes: Array<{ node_id: string; [key: string]: unknown }>;
    edges: Array<{ from: string; [key: string]: unknown }>;
  };
  const productionRecipes = parseYaml(await Bun.file(join(import.meta.dir, '../../graphs/release/recipes.yaml')).text()) as Record<string, unknown>;
  expect(productionGraph.nodes.find((node) => node.node_id === scenario.expected.pendingNode)).toMatchObject({
    kind: 'hitl', recipe: 'approval:repair-recovery',
  });
  expect(productionGraph.edges.find((edge) => edge.from === scenario.expected.pendingNode)).toMatchObject({
    map: { ok: 'gate', fail: 'failed', error: 'failed' },
  });
  expect(productionRecipes['repair-recovery']).toMatchObject({ approval: expect.stringContaining('같은 런에서 gate를 재측정') });
  const root = mkdtempSync(join(tmpdir(), 'rla-postland-hitl-sim-'));
  const graphDir = join(root, 'graphs', 'release');
  mkdirSync(graphDir, { recursive: true });
  const graphPath = join(graphDir, 'release-loop.yaml');
  const graphSlice = { ...productionGraph, entry_node: 'gate' };
  writeFileSync(graphPath, stringifyYaml(graphSlice));
  writeFileSync(join(graphDir, 'recipes.yaml'), await Bun.file(join(import.meta.dir, '../../graphs/release/recipes.yaml')).text());
  for (const file of ['plugin.json', 'release-graph.schema.yaml', 'release-edge-vocabulary.yaml', 'release-gate-domain-pack.yaml'])
    writeFileSync(join(graphDir, file), await Bun.file(join(import.meta.dir, `../../graphs/release/${file}`)).text());

  const runId = 'postland-recovery-hitl';
  let gateVisits = 0;
  let recoveryAttempts = 0;
  let repairMode: 'recovery-exhausted' | 'inspection-failure' | 'command-error' = 'recovery-exhausted';
  let stopAfterReGate = true;
  let controller = new AbortController();
  const introduced = ['src/release/test.test.ts > injected regression'];
  const runBash = async (body: string, options: { env?: NodeJS.ProcessEnv }) => {
    if (body.includes('gate-node.ts --json')) {
      gateVisits++;
      if (stopAfterReGate && gateVisits === scenario.expected.gateExecutions) controller.abort();
      const context = readGraphContext(options.env);
      return { exitCode: gateVisits === 1 ? 1 : 0, stderr: '', stdout: JSON.stringify({
        outcome: gateVisits === 1 ? 'regression' : 'ok', verdict: gateVisits === 1 ? 'fail' : 'pass',
        summary: gateVisits === 1 ? 'injected regression' : 'recovered', commit: gateVisits === 1 ? 'a'.repeat(40) : 'b'.repeat(40),
        introduced: gateVisits === 1 ? introduced : [], preexisting: 0, fixed: null, knownEnv: 0,
        knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1, executionId: context.executionId,
      }) };
    }
    if (body.includes('gate-triage-node.ts')) {
      const context = readGraphContext(options.env);
      return { exitCode: 0, stderr: '', stdout: JSON.stringify(gateTriageShadowFromContext(context)) };
    }
    if (body.includes('gate-repair-node.ts')) {
      if (repairMode === 'command-error') return { exitCode: 2, stderr: 'injected child process timeout',
        stdout: JSON.stringify({ outcome: 'error', verdict: 'fail', summary: 'injected child process timeout' }) };
      const previous = process.env.ELANOUS_STATE_DIR;
      process.env.ELANOUS_STATE_DIR = root;
      resetEffectiveInstanceRoot();
      const output = spyOn(console, 'log').mockImplementation(() => {});
      try {
        const exitCode = await runGateRepairNodeCli(options.env ?? {}, {
          root,
          repo: join(import.meta.dir, '../..'),
          attributeFailures: () => [{ failureId: introduced[0]!, testFile: 'src/release/test.test.ts',
            sourceFiles: ['src/release/test.test.ts'], causePrs: [80420], unresolvedImports: [], confidence: 'high',
            method: 'first-parent-source-overlap', evidence: [] }],
          startRepairChild: async () => ({ ok: true, prNumber: 80421,
            prUrl: 'https://github.com/ElanvitalAI/elanous/pull/80421' }),
          inspectRepairPr: async () => {
            if (repairMode === 'inspection-failure') throw new Error('injected child PR inspection failure');
            return { isDraft: false, files: ['src/release/test.test.ts'], headRefOid: 'c'.repeat(40) };
          },
          recoverLanded: async () => { recoveryAttempts++; throw new Error('injected GitHub receipt failure'); },
          recoveryIntervalMs: 1,
        });
        return { exitCode, stderr: '', stdout: String(output.mock.calls.at(-1)?.[0] ?? '') };
      } finally {
        output.mockRestore();
        if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
        else process.env.ELANOUS_STATE_DIR = previous;
        resetEffectiveInstanceRoot();
      }
    }
    throw new Error(`unexpected command in HITL simulation: ${body}`);
  };

  try {
    const first = await runGraph(graphPath, { runId, input: { version: '0.3.7', previousVersion: '0.3.6' },
      deps: { root, runBash }, signal: controller.signal });
    expect(first.status).toBe('awaiting-approval');
    expect(first.path).toContain(scenario.expected.pendingNode);
    expect(first.path.some((nodeId) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId))).toBe(true);
    expect(first.pending?.nodeId).toBe(scenario.expected.pendingNode);
    expect(recoveryAttempts).toBe(scenario.expected.recoveryAttempts);
    const repairOutput = first.nodes.find((node) => /^gate-repair-[a-f0-9]{12}$/.test(node.nodeId))?.output;
    expect(String(repairOutput)).toContain('PR #80421');
    expect(String(repairOutput)).toContain('run postland-recovery-hitl');
    expect(String(repairOutput)).toContain('inspected head ' + 'c'.repeat(40));

    decideGraphApproval(first.graphId, first.runId, 'approved', 'sim-owner', root);
    const continued = await runGraph(graphPath, { resumeRunId: runId, input: { version: '0.3.7', previousVersion: '0.3.6' },
      deps: { root, runBash }, signal: controller.signal });
    expect(continued.status).toBe(scenario.expected.terminalStatus);
    expect(continued.path.filter((nodeId) => nodeId === scenario.expected.approvalContinuesAt)).toHaveLength(scenario.expected.gateExecutions);
    expect(gateVisits).toBe(scenario.expected.gateExecutions);

    repairMode = 'inspection-failure';
    stopAfterReGate = false;
    controller = new AbortController();
    gateVisits = 0;
    const failedRun = await runGraph(graphPath, { runId: `${runId}-inspection-failure`, input: { version: '0.3.7', previousVersion: '0.3.6' },
      deps: { root, runBash }, signal: controller.signal });
    expect(failedRun.status).toBe('awaiting-approval');
    expect(failedRun.pending?.nodeId).toBe('gate-heal-decision');
    expect(failedRun.path.at(-1)).toBe('gate-heal-decision');

    repairMode = 'command-error';
    gateVisits = 0;
    const commandErrorRun = await runGraph(graphPath, { runId: `${runId}-command-error`, input: { version: '0.3.7', previousVersion: '0.3.6' },
      deps: { root, runBash }, signal: new AbortController().signal });
    expect(commandErrorRun.status).toBe('awaiting-approval');
    expect(commandErrorRun.pending?.nodeId).toBe('gate-heal-decision');
    expect(commandErrorRun.path).not.toContain(scenario.expected.pendingNode);
    expect(commandErrorRun.path.at(-1)).toBe('gate-heal-decision');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, { timeout: 15_000 });
