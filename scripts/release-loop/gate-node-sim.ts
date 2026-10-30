/**
 * GATE-MOCK-EVENT-SCENARIOS — deterministic event catalogue and gate-node driver.
 *
 * Outcomes are injected at GateRunner.sweep (the judgement boundary); judgeGate remains the production
 * classifier. Dispatch/partial rows additionally call the production planners that select reuse,
 * remeasurement, or a fail-closed full/HOLD path. Retry rows use the production shard-artifact reader
 * with distinct first-attempt and retry artifacts. Inputs describe test data, not real Pod lifecycle events.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateRunner, judgeGate, readShardArtifacts, type GateRunner, type GateTools } from './gate-node.js';
import { planStalledShardRecheck } from './gate-partial.js';
import { planGateShardDispatch, type GateShardReceipt } from './gate-shard-dispatch.js';
import { createFakeKubectl } from '../../src/ux-sim/fake-kubectl.js';
import { createFakeGh } from '../../src/ux-sim/fake-gh.js';
import { planPartialRegate } from './gate-partial.js';

export type GateScenarioAction = 'reuse' | 'remeasure' | 'full sweep' | 'HOLD';
export type GateScenario = {
  id: string;
  injectedInput: string;
  gateInjection: 'pass' | 'regression' | 'hold' | 'malformed';
  retryResult?: 'pass' | 'fail';
  expectedOutcome: 'ok' | 'regression' | 'error';
  expectedError?: string;
  action: GateScenarioAction;
  planner?: 'dispatch' | 'partial';
  expectedDispatchKinds?: Array<'reuse' | 'run' | 'unmeasured'>;
  expectedPartialFiles?: string[];
  dispatchInput?: { head40?: string; receipts: 'complete' | 'absent' | 'identity-mismatch'; minihAvailable: boolean;
    msb1Available?: boolean; receiptHosts?: Record<string, string>; rerouteShard?: string };
  partialInput?: { kind: 'stalled'; stalledFiles: string[] } | { kind: 'changed-head'; priorCommit: string; forCommit: string; changedFiles: string[] };
};

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const FILE = 'src/example.test.ts';
const FAILURE = `${FILE} > simulated failure`;
const ENV = 'gate-env-v1';
const EVIDENCE = 'c'.repeat(64);

/**
 * Kept as data so the emitted E4 table and focused tests have the same inventory.
 * Action vocabulary is the operator-facing disposition after judgeGate and the relevant planner run.
 */
export const GATE_NODE_SIM_SCENARIOS: readonly GateScenario[] = [
  { id: 'injected-hold', injectedInput: 'injected sweep HOLD', gateInjection: 'hold', expectedOutcome: 'error', expectedError: 'simulated HOLD: injected sweep HOLD', action: 'HOLD' },
  { id: 'retry-pass', injectedInput: 'first-attempt failure artifact plus a distinct clean retry artifact', gateInjection: 'pass', retryResult: 'pass', expectedOutcome: 'ok', action: 'reuse' },
  { id: 'retry-fail', injectedInput: 'first-attempt failure artifact plus a distinct failing retry artifact', gateInjection: 'pass', retryResult: 'fail', expectedOutcome: 'regression', action: 'HOLD' },
  { id: 'host-down-reroute', injectedInput: 'host down; reroute only the affected shard', gateInjection: 'pass', expectedOutcome: 'ok', action: 'remeasure', planner: 'dispatch', dispatchInput: { receipts: 'complete', minihAvailable: false, receiptHosts: { 'pod-1': 'node-b' }, rerouteShard: 'pod-0' }, expectedDispatchKinds: ['run', 'reuse'] },
  { id: 'all-hosts-down', injectedInput: 'no eligible host; preserve an unmeasured HOLD', gateInjection: 'hold', expectedOutcome: 'error', expectedError: 'simulated HOLD: no eligible host; preserve an unmeasured HOLD', action: 'HOLD', planner: 'dispatch', dispatchInput: { receipts: 'absent', minihAvailable: false, msb1Available: false }, expectedDispatchKinds: ['unmeasured', 'unmeasured'] },
  { id: 'partial-resume', injectedInput: 'resume only the stopped shard', gateInjection: 'pass', expectedOutcome: 'ok', action: 'remeasure', planner: 'partial', partialInput: { kind: 'stalled', stalledFiles: ['src/stopped.test.ts'] }, expectedPartialFiles: ['src/stopped.test.ts'] },
  { id: 'same-head-receipt', injectedInput: 'complete receipt at the same head and base with matching shard inventory', gateInjection: 'pass', expectedOutcome: 'ok', action: 'reuse', planner: 'dispatch', dispatchInput: { receipts: 'complete', minihAvailable: true }, expectedDispatchKinds: ['reuse', 'reuse'] },
  { id: 'changed-head-outside-radius', injectedInput: 'changed head outside permitted radius', gateInjection: 'pass', expectedOutcome: 'ok', action: 'full sweep', planner: 'dispatch', dispatchInput: { head40: 'd'.repeat(40), receipts: 'complete', minihAvailable: true }, expectedDispatchKinds: ['run', 'run'] },
  { id: 'changed-head-inside-radius', injectedInput: 'changed head inside permitted radius', gateInjection: 'pass', expectedOutcome: 'ok', action: 'remeasure', planner: 'partial', partialInput: { kind: 'changed-head', priorCommit: B, forCommit: H, changedFiles: [FILE] }, expectedPartialFiles: [FILE] },
  { id: 'receipt-identity-mismatch', injectedInput: 'receipt identity differs from expected shard', gateInjection: 'pass', expectedOutcome: 'ok', action: 'remeasure', planner: 'dispatch', dispatchInput: { receipts: 'identity-mismatch', minihAvailable: true }, expectedDispatchKinds: ['run', 'reuse'] },
  { id: 'receipt-absent', injectedInput: 'receipt absent', gateInjection: 'pass', expectedOutcome: 'ok', action: 'full sweep', planner: 'dispatch', dispatchInput: { receipts: 'absent', minihAvailable: true }, expectedDispatchKinds: ['run', 'run'] },
  { id: 'sweep-summary-malformed', injectedInput: 'sweep returns an unparseable summary', gateInjection: 'malformed', expectedOutcome: 'error', action: 'HOLD' },
  { id: 'reuse-planner-gate-error', injectedInput: 'same-head planner proposes receipt reuse while the gate summary is malformed', gateInjection: 'malformed', expectedOutcome: 'error', action: 'HOLD', planner: 'dispatch', dispatchInput: { receipts: 'complete', minihAvailable: true }, expectedDispatchKinds: ['reuse', 'reuse'] },
  { id: 'reroute-planner-gate-regression', injectedInput: 'host reroute planner proposes a shard run while the gate reports a regression', gateInjection: 'regression', expectedOutcome: 'regression', action: 'HOLD', planner: 'dispatch', dispatchInput: { receipts: 'complete', minihAvailable: false, receiptHosts: { 'pod-1': 'node-b' }, rerouteShard: 'pod-0' }, expectedDispatchKinds: ['run', 'reuse'] },
  { id: 'partial-planner-gate-error', injectedInput: 'partial planner proposes remeasurement while the gate summary is malformed', gateInjection: 'malformed', expectedOutcome: 'error', action: 'HOLD', planner: 'partial', partialInput: { kind: 'stalled', stalledFiles: ['src/stopped.test.ts'] }, expectedPartialFiles: ['src/stopped.test.ts'] },
  { id: 'partial-planner-gate-regression', injectedInput: 'partial planner proposes remeasurement while the gate reports a regression', gateInjection: 'regression', expectedOutcome: 'regression', action: 'HOLD', planner: 'partial', partialInput: { kind: 'stalled', stalledFiles: ['src/stopped.test.ts'] }, expectedPartialFiles: ['src/stopped.test.ts'] },
];

function makeReceipt(id: string, files: string[], host: string): GateShardReceipt {
  return { id, files, head40: H, base40: B, host, envKey: ENV, status: 'complete',
    failureIds: [], errorIds: [], evidencePath: '/sim/pod-0.json', evidenceSha256: EVIDENCE,
    measuredAt: '2026-10-29T00:00:00.000Z', attempt: 1 };
}
type PlannerEvidence =
  | { kind: 'dispatch'; actions: ReturnType<typeof planGateShardDispatch> }
  | { kind: 'partial'; ok: true; files: string[] }
  | { kind: 'none' };

function plannerDecision(scenario: GateScenario, devices: { head40: string; minihAvailable: boolean; msb1Available: boolean }): { action: GateScenarioAction; evidence: PlannerEvidence } {
  if (scenario.planner === 'dispatch') {
    const input = scenario.dispatchInput ?? { receipts: 'complete' as const, minihAvailable: true };
    const shards = [{ id: 'pod-0', files: [FILE] }, { id: 'pod-1', files: ['src/second.test.ts'] }];
    const receipts = input.receipts === 'absent' ? [] : shards.map((shard) => makeReceipt(shard.id,
      input.receipts === 'identity-mismatch' && shard.id === 'pod-0' ? ['src/other.test.ts'] : shard.files,
      input.receiptHosts?.[shard.id] ?? 'node-c'));
    const plan = planGateShardDispatch({ head40: devices.head40, base40: B,
      shards, receipts,
      hosts: [{ id: 'node-c', platform: 'linux', available: devices.minihAvailable, reserved: false },
        { id: 'node-b', platform: 'linux', available: devices.msb1Available, reserved: false }],
      ...(input.rerouteShard ? { rerouteShard: input.rerouteShard } : {}),
    });
    const dispositions = plan.map((item) => {
      switch (item.kind) {
        case 'reuse': return 'reuse' as const;
        case 'run': return 'remeasure' as const;
        case 'unmeasured': return 'HOLD' as const;
        default: {
          const exhaustive: never = item;
          throw new Error(`unhandled shard action: ${String(exhaustive)}`);
        }
      }
    });
    const action = dispositions.every((kind) => kind === 'reuse') ? 'reuse'
      : dispositions.every((kind) => kind === 'remeasure') ? 'full sweep'
        : dispositions.includes('HOLD') ? 'HOLD' : 'remeasure';
    return { action, evidence: { kind: 'dispatch', actions: plan } };
  }
  if (scenario.planner === 'partial') {
    if (scenario.partialInput?.kind === 'changed-head') {
      const partial = planPartialRegate({ version: '0.2.42', priorCommit: scenario.partialInput.priorCommit, forCommit: scenario.partialInput.forCommit,
        changedFiles: scenario.partialInput.changedFiles, priorFailures: [], priorErrors: [],
        existsAtTip: () => true });
      return { action: partial.ok ? 'remeasure' : 'full sweep', evidence: partial.ok
        ? { kind: 'partial', ok: true, files: partial.plan.files } : { kind: 'none' } };
    }
    if (scenario.partialInput?.kind !== 'stalled') return { action: 'full sweep', evidence: { kind: 'none' } };
    const recheck = planStalledShardRecheck({ version: '0.2.42', measuredCommit: H, forCommit: H,
      failures: [FAILURE], errors: [], stalledFiles: scenario.partialInput.stalledFiles, preservedShardCount: 3,
      existsAtCommit: () => true });
    return recheck.ok ? { action: 'remeasure', evidence: { kind: 'partial', ok: true, files: recheck.plan.files } }
      : { action: 'full sweep', evidence: { kind: 'none' } };
  }
  return { action: 'HOLD', evidence: { kind: 'none' } };
}

function dispositionForOutcome(outcome: 'ok' | 'regression' | 'error'): GateScenarioAction {
  switch (outcome) {
    case 'ok': return 'reuse';
    case 'regression':
    case 'error': return 'HOLD';
  }
}

function output(ids: readonly string[]): string {
  const body = ids.map((id) => `${id.split(' > ')[0]}:\n(fail) ${id.split(' > ')[1]} [1.00ms]\n`).join('');
  return `${body}\n${ids.length} fail\nRan 1 tests across 1 files.\n`;
}

/** Run the production gate classifier with an injected, deterministic sweep outcome. */
export async function judgeInjectedGateEvent(scenario: GateScenario): Promise<{
  outcome: string; action: GateScenarioAction; evidence: PlannerEvidence; error?: string; podCommandCalls: number;
}> {
  const root = mkdtempSync(join(tmpdir(), 'gate-node-sim-'));
  const instanceRoot = join(root, 'instance');
  const ledgerRoot = join(root, 'ledger');
  mkdirSync(join(instanceRoot, 'release/1.0.0'), { recursive: true });
  writeFileSync(join(instanceRoot, 'release/1.0.0/release.json'), JSON.stringify({ sourceCommit: B }));
  writeFileSync(join(instanceRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: B, failures: [] }));
  const dispatchInput = scenario.dispatchInput ?? { receipts: 'complete' as const, minihAvailable: true };
  const minihDevice = createFakeKubectl({ context: dispatchInput.minihAvailable ? 'node-c' : 'node-c-offline', node: 'worker-sim' });
  const msb1Device = createFakeKubectl({ context: dispatchInput.msb1Available === false ? 'node-b-offline' : 'node-b', node: 'worker-sim' });
  const fakeGh = createFakeGh({ prs: [{ number: 1, title: 'simulated gate event', branch: 'sim', createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z', head: dispatchInput.head40 ?? H }] });
  const minihAvailable = minihDevice.kubectl(['config', 'get-contexts', 'node-c']).status === 0;
  const pr = JSON.parse(fakeGh.api(['api', 'repos/example/repo/pulls/1'])) as { head?: { sha?: string } };
  const msb1Available = msb1Device.kubectl(['config', 'get-contexts', 'node-b']).status === 0;
  const planner = plannerDecision(scenario, { head40: pr.head?.sha ?? '', minihAvailable, msb1Available });
  let podCommandCalls = 0;
  const command: GateRunner['command'] = async (cmd, args, cwd) => {
      if (cmd === 'bun' && args[0] === 'run') {
        const remainsFailing = scenario.gateInjection === 'regression' || scenario.retryResult === 'fail';
        const ids = cwd.endsWith('/cut') && remainsFailing ? [FAILURE] : [];
        return { rc: ids.length ? 1 : 0, output: output(ids) };
      }
      if (cmd === 'git' && args[0] === 'ls-files' && args[1] === '-z') return { rc: 0, output: `${FILE}\0` };
      return { rc: 0, output: '' };
  };
  const tools: GateTools = {
    now: () => Date.now(),
    podCommand: async () => { podCommandCalls++; throw new Error('Pod command is outside the injected sweep seam'); },
    admission: { acquire: async () => () => {}, waitReason: () => null },
  };
  const runner = createGateRunner(root, undefined, command, undefined, undefined, undefined, tools);
  // Inject only the declared test outcome at the sweep boundary; this does not model Pod lifecycle.
  runner.sweep = async (tree) => {
    if (scenario.gateInjection === 'hold') throw new Error(`simulated HOLD: ${scenario.injectedInput}`);
    if (scenario.gateInjection === 'malformed') return { rc: 0, output: 'unparseable simulated JUnit summary' };
    if (tree.endsWith('/cut') && scenario.retryResult) {
      const artifacts = join(root, 'retry-artifacts');
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, 'install.rc'), '0\n');
      writeFileSync(join(artifacts, 'install.log'), '');
      writeFileSync(join(artifacts, 'part-0.rc'), '1\n');
      writeFileSync(join(artifacts, 'part-0.log'), `${FILE}:\n(pass) stable case [1.00ms]\n(fail) simulated failure [1.00ms]\n1 pass\n1 fail\nRan 2 tests across 1 files.\n`);
      writeFileSync(join(artifacts, 'part-0.junit.xml'), `<testsuites><testsuite file="${FILE}"><testcase name="stable case"/><testcase name="simulated failure"><failure/></testcase></testsuite></testsuites>`);
      writeFileSync(join(artifacts, 'part-0.retry-files'), `${FILE}\n`);
      writeFileSync(join(artifacts, 'part-0.retry-0.started'), '');
      const retryPasses = scenario.retryResult === 'pass';
      writeFileSync(join(artifacts, 'part-0.retry-0.rc'), retryPasses ? '0\n' : '1\n');
      writeFileSync(join(artifacts, 'part-0.retry-0.log'), retryPasses
        ? '1 pass\n0 fail\nRan 1 test across 1 file.\n'
        : '0 pass\n1 fail\nRan 1 test across 1 file.\n');
      writeFileSync(join(artifacts, 'part-0.retry-0.junit.xml'), retryPasses
        ? `<testsuites tests="1"><testsuite file="${FILE}" tests="1"><testcase name="simulated failure"/></testsuite></testsuites>`
        : `<testsuites><testsuite file="${FILE}"><testcase name="simulated failure"><failure/></testcase></testsuite></testsuites>`);
      const read = readShardArtifacts(artifacts, [[FILE]]);
      return { rc: read.rc ?? 2, output: read.output ?? '',
        ...(read.loadFlaky ? { loadFlaky: read.loadFlaky } : {}),
        ...(read.loadFlakyAttemptedFiles ? { loadFlakyAttemptedFiles: read.loadFlakyAttemptedFiles } : {}) };
    }
    const ids = tree.endsWith('/cut') && scenario.gateInjection === 'regression' ? [FAILURE] : [];
    return { rc: ids.length ? 1 : 0, output: output(ids) };
  };
  try {
    const result = await judgeGate({ commit: H, version: '0.2.42', baselineVersion: '1.0.0', instanceRoot, ledgerRoot, repo: root }, runner);
    return { outcome: result.outcome,
      action: result.outcome === 'ok' ? (scenario.planner ? planner.action : dispositionForOutcome(result.outcome)) : dispositionForOutcome(result.outcome),
      evidence: planner.evidence, ...(result.error ? { error: result.error } : {}), podCommandCalls };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
