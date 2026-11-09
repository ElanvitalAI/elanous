import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateEnvFingerprint } from '../../scripts/release-loop/gate-baseline-receipt.js';
import { gateFileReceiptKey, gateFileReceiptKeyFromClosureDigest, planGateFileReceipts, type GateFileReceipt, type GateFileReceiptIdentity } from '../../scripts/release-loop/gate-file-receipts.js';
import { judgeGate, writeGateVerdictRecord, type GateRunner } from '../../scripts/release-loop/gate-node.js';
import { releaseResumeGateExecutor } from '../../scripts/release-loop/resume.js';
import { runGraph, type GraphRunState } from '../graph-runner/runner.js';
import type { InProcessHandlerRegistry, InProcessHandlerResult } from '../graph-runner/in-process-registry.js';

interface PersistedRun {
  runId?: string;
  status?: string;
  path?: string[];
  reason?: string;
  nodes?: Array<{ nodeId: string; output?: unknown; executed?: boolean }>;
  subscriptionGraphAppends?: Array<{
    proposal: { entryNodeId?: string; returnTo?: string; failureTo?: string; reason?: string;
      nodes?: Array<{ nodeId: string; kind?: string; recipe?: string; maxVisits?: number }>;
      edges?: Array<{ from: string; on?: string; map?: unknown }>; };
    [key: string]: unknown;
  }>;
  pendingSubscriptionActions?: unknown[];
  wakeContinuation?: unknown;
}

interface FakeEffectLedger {
  callsByKey: Record<string, number>;
  effectsByKey: Record<string, number>;
  nodeAttemptsByRun: Record<string, Record<string, number>>;
  graphNodeEntriesByRun: Record<string, number>;
}

interface EdgeCreatorAppendProposal {
  entryNodeId?: string;
  returnTo?: string;
  failureTo?: string;
  reason?: string;
  nodes?: Array<{ nodeId: string; kind?: string; recipe?: string; maxVisits?: number }>;
  edges?: Array<{ from: string; on?: string; map?: unknown }>;
}

export const EDGE_CREATOR_NODE_VISIT_LIMITS = { source: 1, resume: 2, done: 1, failed: 1, repair: 1 } as const;
// E6 invokes the real CLI in a test child; bound the subprocess using the recorded PR test budget.
const EDGE_CREATOR_CHILD_TIMEOUT_MS = 10_000; // 출처: #35989 E6 subprocess bound

const EDGE_CREATOR_AXES = {
  outcome: ['ok', 'fail', 'timeout', 'unmeasured'],
  interruption: ['node', 'receipt', 'append', 'resume'],
  mutation: ['none', 'append', 'receipt', 'image-pin'],
  environment: ['same-host', 'partial-shards', 'remote-user-missing', 'image-drift'],
} as const;

export interface EdgeCreatorSeed {
  readonly incidentId: `E${number}`;
  readonly summary: string;
  readonly axes: {
    readonly outcome: typeof EDGE_CREATOR_AXES.outcome[number];
    readonly interruption: typeof EDGE_CREATOR_AXES.interruption[number];
    readonly mutation: typeof EDGE_CREATOR_AXES.mutation[number];
    readonly environment: typeof EDGE_CREATOR_AXES.environment[number];
  };
  readonly invariant: string;
}

/** Transcribed from the 2026-11-08 0.3.7 eight-event list in the SIM-EDGE-CREATOR checklist evidence. */
export const EDGE_CREATOR_INCIDENT_SEEDS: readonly EdgeCreatorSeed[] = [
  { incidentId: 'E1', summary: 'partial gate overwrote the previous completed receipt', axes: { outcome: 'timeout', interruption: 'receipt', mutation: 'receipt', environment: 'partial-shards' }, invariant: 'completed-receipts-survive-interruption' },
  { incidentId: 'E2', summary: 'source image digest invalidated every appended receipt', axes: { outcome: 'unmeasured', interruption: 'append', mutation: 'image-pin', environment: 'image-drift' }, invariant: 'invalidate-only-source-affected-receipts' },
  { incidentId: 'E3', summary: 'one node execution override expanded to the whole run', axes: { outcome: 'unmeasured', interruption: 'node', mutation: 'none', environment: 'same-host' }, invariant: 'node-scope-does-not-expand-run-scope' },
  { incidentId: 'E4', summary: 'a failed gate omitted baseline receipts for passing shards', axes: { outcome: 'fail', interruption: 'receipt', mutation: 'receipt', environment: 'partial-shards' }, invariant: 'passing-shard-receipts-survive-peer-failure' },
  { incidentId: 'E5', summary: 'dynamic repair append resumed in the same run', axes: { outcome: 'timeout', interruption: 'append', mutation: 'append', environment: 'same-host' }, invariant: 'same-run-resume-is-equivalent-and-idempotent' },
  { incidentId: 'E6', summary: 'standalone gate lacked the cut image pin context', axes: { outcome: 'unmeasured', interruption: 'resume', mutation: 'image-pin', environment: 'image-drift' }, invariant: 'missing-cut-pin-refuses-standalone-gate' },
  { incidentId: 'E7', summary: 'review waiver stores disagreed and rejected the review', axes: { outcome: 'fail', interruption: 'resume', mutation: 'receipt', environment: 'remote-user-missing' }, invariant: 'waiver-store-mismatch-fails-closed' },
  { incidentId: 'E8', summary: 'train wrapper masked a build failure as success', axes: { outcome: 'fail', interruption: 'node', mutation: 'none', environment: 'remote-user-missing' }, invariant: 'child-failure-exit-code-is-preserved' },
];

export interface EdgeCreatorPlan {
  readonly scenarios: readonly {
    readonly id: string;
    readonly axes: EdgeCreatorSeed['axes'];
    readonly incidentIds: readonly string[];
    readonly incidentSummaries: readonly string[];
    readonly invariants: readonly string[];
  }[];
  readonly incidentCount: number;
  readonly coveredIncidentIds: readonly string[];
  readonly requiredPairCount: number;
  readonly coveredPairCount: number;
}

/** Greedily generates a bounded pairwise plan, then pins every recorded incident tuple into it. */
export function generateEdgeCreatorPlan(seeds: readonly EdgeCreatorSeed[] = EDGE_CREATOR_INCIDENT_SEEDS): EdgeCreatorPlan {
  const incidentIds = new Set<string>();
  for (const seed of seeds) {
    if (incidentIds.has(seed.incidentId)) throw new Error(`duplicate edge incident seed: ${seed.incidentId}`);
    incidentIds.add(seed.incidentId);
    if (!seed.summary.trim() || !seed.invariant.trim()) throw new Error(`edge incident seed needs summary and invariant: ${seed.incidentId}`);
  }
  const axisNames = Object.keys(EDGE_CREATOR_AXES) as (keyof EdgeCreatorSeed['axes'])[];
  const tupleKey = (axes: EdgeCreatorSeed['axes']) => axisNames.map((axis) => axes[axis]).join('|');
  const pairKeys = (axes: EdgeCreatorSeed['axes']): string[] => axisNames.flatMap((left, index) =>
    axisNames.slice(index + 1).map((right) => `${left}:${axes[left]}|${right}:${axes[right]}`));
  const candidates: EdgeCreatorSeed['axes'][] = [];
  for (const outcome of EDGE_CREATOR_AXES.outcome) for (const interruption of EDGE_CREATOR_AXES.interruption)
    for (const mutation of EDGE_CREATOR_AXES.mutation) for (const environment of EDGE_CREATOR_AXES.environment)
      candidates.push({ outcome, interruption, mutation, environment });

  const requiredPairs = new Set<string>();
  for (let i = 0; i < axisNames.length; i++) for (let j = i + 1; j < axisNames.length; j++) {
    const left = axisNames[i]!;
    const right = axisNames[j]!;
    for (const leftValue of EDGE_CREATOR_AXES[left]) for (const rightValue of EDGE_CREATOR_AXES[right])
      requiredPairs.add(`${left}:${leftValue}|${right}:${rightValue}`);
  }
  const uncovered = new Set(requiredPairs);
  const selected = new Map<string, EdgeCreatorSeed['axes']>();
  while (uncovered.size > 0) {
    const ranked = candidates.map((axes) => ({ axes, key: tupleKey(axes), score: pairKeys(axes).filter((key) => uncovered.has(key)).length }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    const best = ranked[0];
    if (!best) break;
    selected.set(best.key, best.axes);
    for (const pair of pairKeys(best.axes)) uncovered.delete(pair);
  }

  for (const seed of seeds) selected.set(tupleKey(seed.axes), seed.axes);
  const scenarios = [...selected.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, axes], index) => {
    const matching = seeds.filter((seed) => tupleKey(seed.axes) === key);
    return { id: `edge-case-${String(index + 1).padStart(2, '0')}`, axes,
      incidentIds: matching.map((seed) => seed.incidentId), incidentSummaries: matching.map((seed) => seed.summary),
      invariants: matching.map((seed) => seed.invariant) };
  });
  const coveredIncidentIds = scenarios.flatMap((scenario) => scenario.incidentIds).sort();
  return { scenarios, incidentCount: seeds.length, coveredIncidentIds,
    requiredPairCount: requiredPairs.size, coveredPairCount: requiredPairs.size - uncovered.size };
}

export function isExpectedEdgeCreatorAppend(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const proposal = value as EdgeCreatorAppendProposal;
  const node = proposal.nodes?.[0];
  const edge = proposal.edges?.[0];
  const map = edge?.map as { ok?: unknown; fail?: unknown; error?: unknown } | undefined;
  return proposal.entryNodeId === 'repair' && proposal.returnTo === 'resume' &&
    proposal.failureTo === 'failed' && proposal.reason === 'E5 dynamic repair append' &&
    proposal.nodes?.length === 1 && node?.nodeId === 'repair' && node.kind === 'agent' &&
    node.recipe === 'handler:edge-repair' && node.maxVisits === EDGE_CREATOR_NODE_VISIT_LIMITS.repair &&
    proposal.edges?.length === 1 && edge?.from === 'repair' && edge.on === 'outcome' &&
    map?.ok === 'resume' && map.fail === 'failed' && map.error === 'failed';
}

export function sourceReceiptMatches(before: unknown, after: unknown): boolean {
  return isCompletedSourceReceipt(before) && isCompletedSourceReceipt(after) &&
    JSON.stringify(before) === JSON.stringify(after);
}

export function isWithinE5VisitLimit(path: readonly string[] | undefined, limit: number): boolean {
  return Array.isArray(path) && path.length <= limit;
}

function isCompletedSourceReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('evidence' in value)) return false;
  const evidence = (value as { evidence?: unknown }).evidence;
  return !!evidence && typeof evidence === 'object' && 'sourceReceipt' in evidence &&
    (evidence as { sourceReceipt?: unknown }).sourceReceipt === 'source-v1';
}

export interface EdgeCreatorE5Result {
  readonly runId: string;
  readonly verdict: 'green' | 'red';
  readonly invariantViolations: readonly string[];
  readonly interruptedStatus: string;
  readonly resumedStatus: string;
  readonly baselineTerminal: string | undefined;
  readonly resumedTerminal: string | undefined;
  readonly baselineStatus: string;
  readonly baselineAppendCount: number;
  readonly baselineRepairCalls: number;
  readonly appendCount: number;
  readonly sourceReceiptPreserved: boolean;
  readonly sourceReceiptBefore: unknown;
  readonly sourceReceiptAfter: unknown;
  readonly repairCallsByIdempotencyKey: Readonly<Record<string, number>>;
  readonly effectsByIdempotencyKey: Readonly<Record<string, number>>;
  readonly runNodeExecutionCount: number;
  readonly declaredRunNodeExecutionLimit: number;
  readonly perRunTimeoutMs: number;
}

export interface EdgeCreatorM2Result {
  readonly runId: string;
  readonly status: string;
  readonly executedIncidentIds: readonly string[];
  readonly invariantEvidence: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Execute the remaining receipt, scope, and cut-pin seeds through the production graph runner. */
export async function runEdgeCreatorM2Simulation(seeds: readonly EdgeCreatorSeed[] = EDGE_CREATOR_INCIDENT_SEEDS): Promise<EdgeCreatorM2Result> {
  const root = mkdtempSync(join(tmpdir(), 'edge-creator-m2-'));
  const runId = 'edge-creator-m2-production-helpers';
  const executedIncidentIds: string[] = [];
  const invariantEvidence: Record<string, Record<string, unknown>> = {};
  const graphPath = join(root, 'edge-m2.yaml');
  const scenarioByInvariant = {
    'completed-receipts-survive-interruption': 'e1',
    'invalidate-only-source-affected-receipts': 'e2',
    'node-scope-does-not-expand-run-scope': 'e3',
    'passing-shard-receipts-survive-peer-failure': 'e4',
    'missing-cut-pin-refuses-standalone-gate': 'e6',
  } as const;
  type M2Invariant = keyof typeof scenarioByInvariant;
  const selectedSeeds = seeds.filter((seed): seed is EdgeCreatorSeed & { invariant: M2Invariant } =>
    Object.hasOwn(scenarioByInvariant, seed.invariant));
  const seedByInvariant = new Map(selectedSeeds.map((seed) => [seed.invariant, seed]));
  const done = (invariant: M2Invariant, passed: boolean, evidence: Record<string, unknown>): InProcessHandlerResult => {
    const seed = seedByInvariant.get(invariant);
    if (!seed) throw new Error(`M2 scenario has no authoritative seed: ${invariant}`);
    executedIncidentIds.push(seed.incidentId);
    const seedEvidence = { seedSummary: seed.summary, seedAxes: seed.axes, seedInvariant: seed.invariant };
    invariantEvidence[seed.incidentId] = { ...seedEvidence, ...evidence, passed };
    return { ok: passed, outcome: passed ? 'ok' : 'fail', evidence: { incidentId: seed.incidentId, ...seedEvidence, ...evidence, passed } };
  };
  const edgeScenario = (invariant: M2Invariant, execute: (seed: EdgeCreatorSeed) => InProcessHandlerResult | Promise<InProcessHandlerResult>) => async (): Promise<InProcessHandlerResult> => {
    const seed = seedByInvariant.get(invariant);
    if (!seed) throw new Error(`M2 scenario has no authoritative seed: ${invariant}`);
    return execute(seed);
  };
  const handlers: InProcessHandlerRegistry = {
    'edge-m2-e1': edgeScenario('completed-receipts-survive-interruption', (seed) => {
      const caseRoot = join(root, 'e1');
      const receiptPath = join(caseRoot, 'release', '0.3.8', 'gate-verdict.json');
      const path = seed.axes.interruption === 'receipt' ? receiptPath
        : join(caseRoot, 'release', '0.3.8', `${seed.axes.interruption}-interruption.json`);
      const completedCommit = 'a'.repeat(40);
      const retryCommit = seed.axes.mutation === 'receipt' ? 'b'.repeat(40) : completedCommit;
      const retryOutcome = seed.axes.outcome === 'timeout' ? 'error' : seed.axes.outcome === 'fail' ? 'regression' : 'ok';
      writeGateVerdictRecord(path, { commit: completedCommit, outcome: 'ok', baselineReceipt: { schema: 2, valid: true, commit: completedCommit } });
      if (seed.axes.interruption === 'receipt' && seed.axes.environment === 'partial-shards')
        writeGateVerdictRecord(path, { commit: retryCommit, outcome: retryOutcome, reason: `${seed.axes.outcome} interruption` });
      const saved = JSON.parse(readFileSync(path, 'utf8')) as { commit?: string; outcome?: string };
      const attemptsPath = join(caseRoot, 'release', '0.3.8', 'gate-verdict-attempts.jsonl');
      const attempts = existsSync(attemptsPath) ? readFileSync(attemptsPath, 'utf8').trim().split('\n') : [];
      return done('completed-receipts-survive-interruption', saved.commit === completedCommit && saved.outcome === 'ok' && attempts.length === 2,
        { savedCommit: saved.commit, completedCommit, attemptCount: attempts.length, interruption: seed.axes.interruption,
          retryOutcome, mutation: seed.axes.mutation, environment: seed.axes.environment });
    }),
    'edge-m2-e2': edgeScenario('invalidate-only-source-affected-receipts', (seed) => {
      const digest = `sha256:${(seed.axes.environment === 'image-drift' ? 'c' : 'd').repeat(64)}`;
      const receiptFor = (file: string, changedSource: boolean): { identity: GateFileReceiptIdentity; receipt: GateFileReceipt } => {
        const dependency = file === 'src/a.test.ts' ? 'src/a.ts' : 'src/b.ts';
        const closureFiles = [file, dependency].sort();
        const contentHashes = Object.fromEntries(closureFiles.map((path) => [path,
          createHash('sha256').update(path === dependency && changedSource ? `${path}:changed` : path).digest('hex')]));
        const identity: GateFileReceiptIdentity = { file, closureFiles, contentHashes, imageDigest: digest };
        const closureDigest = createHash('sha256').update(JSON.stringify(closureFiles.map((path) => [path, contentHashes[path]]))).digest('hex');
        const key = gateFileReceiptKey(identity);
        if (!key) throw new Error(`could not key file receipt: ${file}`);
        return { identity, receipt: { file, closureFiles, closureDigest, imageDigest: digest, key,
          sourceHead40: 'd'.repeat(40), outcome: 'pass', evidence: { graphRunId: runId } } };
      };
      const prior = [receiptFor('src/a.test.ts', false), receiptFor('src/b.test.ts', false)];
      const sourceChanged = seed.axes.mutation === 'image-pin' && seed.axes.environment === 'image-drift'
        && seed.axes.interruption === 'append';
      const changed = receiptFor('src/a.test.ts', sourceChanged).identity;
      const unchanged = prior[1]!.identity;
      const plan = planGateFileReceipts({ current: [changed, unchanged], receipts: prior.map(({ receipt }) => receipt) });
      const passed = plan.reuse.map(({ file }) => file).join(',') === 'src/b.test.ts'
        && plan.measure.map(({ file }) => file).join(',') === 'src/a.test.ts'
        && prior[0]!.receipt.key !== gateFileReceiptKey(changed)
        && prior[1]!.receipt.key === gateFileReceiptKey(unchanged)
        && prior[0]!.receipt.key === gateFileReceiptKeyFromClosureDigest(prior[0]!.receipt.file,
          prior[0]!.receipt.closureDigest, prior[0]!.receipt.imageDigest);
      return done('invalidate-only-source-affected-receipts', passed, { reused: plan.reuse.map(({ file }) => file), measured: plan.measure.map(({ file }) => file),
        mutation: seed.axes.mutation, interruption: seed.axes.interruption, environment: seed.axes.environment });
    }),
    'edge-m2-e3': edgeScenario('node-scope-does-not-expand-run-scope', (seed) => {
      const state = { graphId: 'release-loop', runId, status: 'failed', path: ['cutoff', 'gate', 'mac-smoke', 'failed'], nodes: [],
        input: { version: '0.3.8', previousVersion: '0.3.7', gatePodPool: 'pool-sim@sim-host:1' }, executed: 3, dryRun: false, statePath: join(root, 'e3.json') };
      const from = seed.axes.interruption === 'node' ? 'gate' : 'mac-smoke';
      const executor = seed.axes.environment === 'same-host' ? 'host' : 'pod';
      const override = releaseResumeGateExecutor(state as unknown as GraphRunState, { from, executor, host: 'ubuntu@node-b' });
      const passed = JSON.stringify(override.set) === JSON.stringify({ gateExecutor: 'host', gateRemote: 'ubuntu@node-b' })
        && JSON.stringify(override.unset ?? []) === '[]' && seed.axes.mutation === 'none';
      return done('node-scope-does-not-expand-run-scope', passed, { override: override.set, unset: override.unset ?? [],
        interruption: from, requestedExecutor: executor, mutation: seed.axes.mutation });
    }),
    'edge-m2-e4': edgeScenario('passing-shard-receipts-survive-peer-failure', async (seed) => {
      const caseRoot = join(root, 'e4');
      const instanceRoot = join(caseRoot, 'instance');
      const ledgerRoot = join(caseRoot, 'ledger');
      const repo = join(caseRoot, 'repo');
      const commit = 'e'.repeat(40), baselineCommit = 'f'.repeat(40);
      const envFingerprint = gateEnvFingerprint(process.env);
      const imageDigest = `sha256:${'f'.repeat(64)}`;
      const graphRunId = 'edge-creator-e4-gate';
      const recordsPartialShard = seed.axes.environment === 'partial-shards'
        && seed.axes.interruption === 'receipt' && seed.axes.mutation === 'receipt';
      const files = recordsPartialShard ? ['src/pass.test.ts', 'src/fail.test.ts'] : ['src/fail.test.ts'];
      const logs = join(instanceRoot, 'release', '0.3.8', 'gate-logs', 'cut');
      mkdirSync(logs, { recursive: true });
      mkdirSync(join(instanceRoot, 'release', '0.3.7'), { recursive: true });
      writeFileSync(join(instanceRoot, 'release', '0.3.7', 'release.json'), JSON.stringify({ sourceCommit: baselineCommit }));
      writeFileSync(join(instanceRoot, 'release', '0.3.7', 'gate-failures.json'), JSON.stringify({ commit: baselineCommit, failures: [] }));
      writeFileSync(join(logs, 'pod-0.json'), JSON.stringify({ commit, files, shardCount: 1,
        sweepId: 'edge-e4-sweep', attemptId: 'edge-e4-attempt', imageDigest,
        runtimeIdentity: { bunVersion: Bun.version, platform: process.platform, architecture: process.arch, envFingerprint,
          baseImageDigest: `sha256:${'1'.repeat(64)}` } }));
      mkdirSync(join(instanceRoot, 'graph-runs', 'release-loop'), { recursive: true });
      writeFileSync(join(instanceRoot, 'graph-runs', 'release-loop', `${graphRunId}.json`), JSON.stringify({
        graphId: 'release-loop', runId: graphRunId, graphSnapshot: { graphSha: '2'.repeat(64), recipesSha: '3'.repeat(64) },
      }));
      const failureId = 'src/fail.test.ts > synthetic E4 regression';
      const outputFor = (failed: boolean) => failed
        ? `src/fail.test.ts:\n(fail) synthetic E4 regression [1.00ms]\n\n0 pass\n1 fail\n0 errors\nRan 1 test across 1 file.\n`
        : 'src/fail.test.ts:\n1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n';
      const runner: GateRunner = {
        async localCommand() { return { rc: 0, output: '' }; },
        async command(cmd, args, cwd) {
          if (cmd === 'sh') return { rc: 0, output: '/home/remote\n' };
          if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: 'true\n' };
          if (cmd === 'git' && args[0] === 'show-ref') return { rc: 1, output: '' };
          if (cmd === 'git' && args[0] === 'ls-files' && args[1] === '-z') return { rc: 0, output: `${args.slice(3).join('\0')}\0` };
          if (cmd === 'bun' && args[0] === 'run' && args[1] === 'test:deterministic') {
            const path = args[2]?.replace(/^\.\//, '');
            const failed = seed.axes.outcome === 'fail' && cwd.endsWith('/cut') && path === 'src/fail.test.ts';
            return { rc: failed ? 1 : 0, output: outputFor(failed) };
          }
          return { rc: 0, output: '' };
        },
        async sweep(tree) {
          const failed = seed.axes.outcome === 'fail' && tree.endsWith('/cut');
          return { rc: failed ? 1 : 0, output: outputFor(failed) };
        },
        async add() {}, async remove() {}, async snapshot() {}, async removeSnapshot() {},
      };
      const gateResult = await judgeGate({ commit, baselineCommit, version: '0.3.8', baselineVersion: '0.3.7',
        instanceRoot, ledgerRoot, repo, graphRunId, scratchOnly: true }, runner);
      const verdictPath = join(instanceRoot, 'release', '0.3.8', 'gate-verdict.json');
      const saved = JSON.parse(readFileSync(verdictPath, 'utf8')) as { outcome?: string; baselineReceipt?: { valid?: boolean; files?: number } };
      const receiptValid = saved.baselineReceipt?.valid === true && saved.baselineReceipt.files === files.length;
      const preservesPassingShard = recordsPartialShard && receiptValid;
      return done('passing-shard-receipts-survive-peer-failure', seed.axes.outcome === 'fail' && gateResult.outcome === 'regression'
        && gateResult.introduced.includes(failureId) && preservesPassingShard && saved.outcome === gateResult.outcome,
      { receiptValid, receiptFiles: saved.baselineReceipt?.files, verdict: saved.outcome, introduced: gateResult.introduced,
        outcome: seed.axes.outcome, interruption: seed.axes.interruption, mutation: seed.axes.mutation, environment: seed.axes.environment });
    }),
    'edge-m2-e6': edgeScenario('missing-cut-pin-refuses-standalone-gate', async (seed) => {
      const contextPath = join(root, 'e6-graph-context.json');
      writeFileSync(contextPath, JSON.stringify({
        input: { version: seed.axes.outcome === 'unmeasured' ? '0.3.8' : '0.3.9',
          previousVersion: seed.axes.interruption === 'resume' ? '0.3.7' : '0.3.8',
          gateExecutor: seed.axes.mutation === 'image-pin' ? 'pod' : 'host',
          ...(seed.axes.environment === 'image-drift' ? { gatePodPool: 'pool-sim@sim-host:1' } : {}),
          ...(seed.axes.mutation === 'image-pin' ? { gateImagePin: 'cut-commit' } : {}) },
        outputs: { 'version-release': { commit: '4'.repeat(40) } },
      }));
      const cliPath = join(process.cwd(), 'scripts', 'release-loop', 'gate-node-cli.ts');
      const child = spawnSync(process.execPath, [cliPath, '--json'], { cwd: process.cwd(), encoding: 'utf8', timeout: EDGE_CREATOR_CHILD_TIMEOUT_MS,
        env: { ...process.env, ELANOUS_GRAPH_CONTEXT: contextPath, ELANOUS_STATE_DIR: join(root, 'e6-state'), ELANOUS_STATE_DIR_SOURCE: 'derived' } });
      const exitCode = child.status ?? 2;
      const refusalReason = `${child.stdout ?? ''}\n${child.stderr ?? ''}`.includes('pod-gate-missing-run-scope')
        ? 'pod-gate-missing-run-scope' : 'not-observed';
      const refusal = seed.axes.outcome === 'unmeasured' && seed.axes.interruption === 'resume'
        && seed.axes.mutation === 'image-pin' && seed.axes.environment === 'image-drift'
        && refusalReason === 'pod-gate-missing-run-scope';
      return done('missing-cut-pin-refuses-standalone-gate', exitCode === 2 && refusal,
        { exitCode, refusalReason, outcome: seed.axes.outcome, interruption: seed.axes.interruption,
          mutation: seed.axes.mutation, environment: seed.axes.environment });
    }),
  };

  const incidentNodes = selectedSeeds.map((seed) => ({ id: seed.incidentId.toLowerCase(), handlerId: scenarioByInvariant[seed.invariant] }));
  const lines = ['graph_id: sim-edge-creator-m2', 'version: 1', `entry_node: incident-${incidentNodes[0]?.id ?? 'none'}`, 'terminal_nodes: [done, failed]', 'nodes:'];
  for (const { id, handlerId } of incidentNodes) lines.push(`  - { node_id: incident-${id}, kind: agent, recipe: handler:edge-m2-${handlerId}, max_visits: 1 }`);
  lines.push('  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', 'edges:');
  for (let index = 0; index < incidentNodes.length; index++) {
    const { id } = incidentNodes[index]!;
    const next = incidentNodes[index + 1] ? `incident-${incidentNodes[index + 1]!.id}` : 'done';
    lines.push(`  - { from: incident-${id}, on: outcome, map: { ok: ${next}, fail: failed } }`);
  }
  lines.push('');
  try {
    writeFileSync(graphPath, lines.join('\n'));
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    const result = await runGraph(graphPath, { runId, quiet: true, deps: { root, inProcessHandlers: handlers } });
    return { runId: result.runId, status: result.status, executedIncidentIds, invariantEvidence };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Runs E5 through the production graph runner; each restart is a separate, timeout-bounded process. */
export async function runEdgeCreatorE5Simulation(): Promise<EdgeCreatorE5Result> {
  const root = mkdtempSync(join(tmpdir(), 'edge-creator-e5-'));
  try {
    const graphPath = join(root, 'edge-e5.yaml');
    const ledgerPath = join(root, 'fake-effects.json');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(ledgerPath, JSON.stringify({ callsByKey: {}, effectsByKey: {}, nodeAttemptsByRun: {}, graphNodeEntriesByRun: {} } satisfies FakeEffectLedger));
    const runNodeExecutionLimit = Object.values(EDGE_CREATOR_NODE_VISIT_LIMITS).reduce((sum, count) => sum + count, 0);
    writeFileSync(graphPath, [
      'graph_id: edge-creator-e5', 'version: 1', 'entry_node: source', 'terminal_nodes: [done, failed]', 'nodes:',
      `  - node_id: source`, '    kind: agent', '    recipe: handler:edge-source', `    max_visits: ${EDGE_CREATOR_NODE_VISIT_LIMITS.source}`,
      '    emits: [sim.edge-creator.append]',
      '  - node_id: resume', '    kind: agent', '    recipe: handler:edge-resume', `    max_visits: ${EDGE_CREATOR_NODE_VISIT_LIMITS.resume}`,
      '    subscribes: [{ event: sim.edge-creator.append, match: { nodeId: source }, action: wake }]',
      `  - { node_id: done, kind: gate, recipe: none, max_visits: ${EDGE_CREATOR_NODE_VISIT_LIMITS.done} }`,
      `  - { node_id: failed, kind: gate, recipe: none, max_visits: ${EDGE_CREATOR_NODE_VISIT_LIMITS.failed} }`,
      'edges:', '  - { from: source, on: outcome, map: { ok: resume, fail: failed } }',
      '  - { from: resume, on: outcome, map: { ok: done, fail: failed } }', '',
    ].join('\n'));

    const runId = 'edge-e5-same-run';
    const timeoutMs = 10_000;
    const baselineRunId = 'edge-e5-baseline';
    const baselineResult = runInBoundedChild(root, graphPath, ledgerPath, baselineRunId, 'baseline', timeoutMs, runNodeExecutionLimit);
    const interrupted = runInBoundedChild(root, graphPath, ledgerPath, runId, 'repair-interrupt', timeoutMs, runNodeExecutionLimit, 87);
    const savedAtRepair = interrupted.state;
    const sourceReceiptAtRepair = readSourceReceipt(savedAtRepair);
    const appendCount = savedAtRepair.subscriptionGraphAppends?.length ?? 0;
    const skipResumeStatus = interrupted.state.status === 'execution-limit-exceeded'
      ? 'execution-limit-exceeded' : 'timeout';
    const resumed = baselineResult.timedOut || interrupted.timedOut || interrupted.state.status === 'execution-limit-exceeded'
      ? { state: { status: skipResumeStatus } as PersistedRun, timedOut: false }
      : runInBoundedChild(root, graphPath, ledgerPath, runId, 'resume', timeoutMs, runNodeExecutionLimit, 0, true);
    const resumedState = resumed.state;
    const resumedSourceReceipt = readSourceReceipt(resumedState);
    const baselineTerminal = baselineResult.state.path?.at(-1);
    const resumedTerminal = resumedState.path?.at(-1);
    const ledger = readLedger(ledgerPath);
    const repairCalls = ledger.callsByKey[`${runId}:repair`] ?? 0;
    const repairEffects = ledger.effectsByKey[`${runId}:repair`] ?? 0;
    const baselineRepairCalls = ledger.callsByKey[`${baselineRunId}:repair`] ?? 0;
    const runNodeExecutionCount = ledger.graphNodeEntriesByRun[runId] ?? 0;
    const invariantViolations: string[] = [];
    if (baselineResult.timedOut || interrupted.timedOut || resumed.timedOut)
      invariantViolations.push('I3-process-timeout');
    const baselineAppend = baselineResult.state.subscriptionGraphAppends?.[0]?.proposal;
    const persistedAppend = savedAtRepair.subscriptionGraphAppends?.[0]?.proposal;
    const resumedAppend = resumedState.subscriptionGraphAppends?.[0]?.proposal;
    if (baselineResult.state.subscriptionGraphAppends?.length !== 1 || !isExpectedEdgeCreatorAppend(baselineAppend) ||
        savedAtRepair.subscriptionGraphAppends?.length !== 1 || resumedState.subscriptionGraphAppends?.length !== 1 ||
        !isExpectedEdgeCreatorAppend(persistedAppend) || !isExpectedEdgeCreatorAppend(resumedAppend) ||
        JSON.stringify(persistedAppend) !== JSON.stringify(resumedAppend) || appendCount !== 1)
      invariantViolations.push('I2-dynamic-append-not-preserved-once');
    const sourceReceiptPreserved = sourceReceiptMatches(sourceReceiptAtRepair, resumedSourceReceipt);
    if (!sourceReceiptPreserved)
      invariantViolations.push('I2-source-receipt-not-preserved');
    if (baselineResult.state.status !== 'done' || baselineResult.state.path?.at(-1) !== 'done' || baselineRepairCalls !== 1)
      invariantViolations.push('I1-baseline-dynamic-run-not-green');
    if (repairCalls !== 2) invariantViolations.push('I2-retry-not-repeated');
    if (repairEffects !== 1) invariantViolations.push('I2-external-effect-not-deduplicated');
    if (baselineResult.state.status === 'execution-limit-exceeded' || savedAtRepair.status === 'execution-limit-exceeded' ||
        resumedState.status === 'execution-limit-exceeded' || runNodeExecutionCount > runNodeExecutionLimit)
      invariantViolations.push('I3-execution-bound-exceeded');
    if (baselineTerminal !== resumedTerminal) invariantViolations.push('I1-same-terminal');
    if (resumedState.status !== 'done') invariantViolations.push('I1-resume-status');
    if (resumedState.status === 'budget-exceeded') invariantViolations.push('I3-resume-visit-bound');
    return {
      runId, verdict: invariantViolations.length === 0 ? 'green' : 'red', invariantViolations,
      interruptedStatus: String(savedAtRepair.status),
      resumedStatus: String(resumedState.status), baselineTerminal, resumedTerminal, appendCount,
      baselineStatus: String(baselineResult.state.status), baselineAppendCount: baselineResult.state.subscriptionGraphAppends?.length ?? 0,
      baselineRepairCalls, sourceReceiptPreserved, sourceReceiptBefore: sourceReceiptAtRepair, sourceReceiptAfter: resumedSourceReceipt,
      repairCallsByIdempotencyKey: { [`${runId}:repair`]: repairCalls },
      effectsByIdempotencyKey: { [`${runId}:repair`]: repairEffects },
      runNodeExecutionCount, declaredRunNodeExecutionLimit: runNodeExecutionLimit, perRunTimeoutMs: timeoutMs,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runInBoundedChild(root: string, graphPath: string, ledgerPath: string, runId: string,
  stage: 'baseline' | 'repair-interrupt' | 'resume', timeoutMs: number, executionLimit: number,
  expectedExit = 0, isResume = false): { state: PersistedRun; timedOut: boolean } {
  const resultPath = join(root, `${runId}-${stage}.result`);
  const runnerUrl = new URL('../graph-runner/runner.js', import.meta.url).href;
  const childScript = `
    const fs = await import('node:fs');
    const { runGraph } = await import(${JSON.stringify(runnerUrl)});
    const root = process.env.EDGE_CREATOR_ROOT;
    const graphPath = process.env.EDGE_CREATOR_GRAPH;
    const ledgerPath = process.env.EDGE_CREATOR_LEDGER;
    const resultPath = process.env.EDGE_CREATOR_RESULT;
    const runId = process.env.EDGE_CREATOR_RUN;
    const stage = process.env.EDGE_CREATOR_STAGE;
    const executionLimit = ${executionLimit};
    const readLedger = () => JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const writeLedger = (ledger) => {
      const temporary = ledgerPath + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(ledger));
      fs.renameSync(temporary, ledgerPath);
    };
    const recordNodeAttempt = (nodeId) => {
      const ledger = readLedger();
      ledger.nodeAttemptsByRun[runId] ??= {};
      ledger.nodeAttemptsByRun[runId][nodeId] = (ledger.nodeAttemptsByRun[runId][nodeId] ?? 0) + 1;
      writeLedger(ledger);
    };
    const recordGraphNodeEntry = () => {
      const ledger = readLedger();
      ledger.graphNodeEntriesByRun[runId] = (ledger.graphNodeEntriesByRun[runId] ?? 0) + 1;
      writeLedger(ledger);
      if (ledger.graphNodeEntriesByRun[runId] > executionLimit) process.exit(88);
    };
    const applyExternalEffect = (key) => {
      const ledger = readLedger();
      ledger.callsByKey[key] = (ledger.callsByKey[key] ?? 0) + 1;
      if (ledger.effectsByKey[key] === undefined) ledger.effectsByKey[key] = 1;
      writeLedger(ledger);
      return ledger.callsByKey[key];
    };
    const handlers = {
      'edge-source': async (context) => {
        recordNodeAttempt('source');
        await context.emitEvent?.('sim.edge-creator.append');
        return { ok: true, outcome: 'ok', evidence: { sourceReceipt: 'source-v1' } };
      },
      'edge-resume': async () => {
        recordNodeAttempt('resume');
        return { ok: true, outcome: 'ok', evidence: { idempotencyKey: 'edge-e5:resume' } };
      },
      'edge-repair': async () => {
        recordNodeAttempt('repair');
        const attempts = applyExternalEffect(runId + ':repair');
        if (stage === 'repair-interrupt' && attempts === 1) process.exit(87);
        return { ok: true, outcome: 'ok', evidence: { idempotencyKey: 'edge-e5:repair' } };
      },
    };
    const deps = { root, inProcessHandlers: handlers, quiet: true, beforeNode: recordGraphNodeEntry,
      dispatchGraphSubscription: async (dispatch) => {
        if (!dispatch.appendGraph) throw new Error('graph append seam unavailable');
        const appendResult = await dispatch.appendGraph({
          nodes: [{ nodeId: 'repair', kind: 'agent', recipe: 'handler:edge-repair', maxVisits: ${EDGE_CREATOR_NODE_VISIT_LIMITS.repair} }],
          edges: [{ from: 'repair', on: 'outcome', map: { ok: 'resume', fail: 'failed', error: 'failed' } }],
          entryNodeId: 'repair', returnTo: 'resume', failureTo: 'failed', reason: 'E5 dynamic repair append',
        });
        if (appendResult.disposition === 'rejected') throw new Error(appendResult.reason);
      } };
    const result = await runGraph(graphPath, {
      ...(process.env.EDGE_CREATOR_IS_RESUME === '1' ? { resumeRunId: runId } : { runId }), deps,
    });
    fs.writeFileSync(resultPath, JSON.stringify(result));
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['-e', childScript], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs,
    env: { ...process.env, EDGE_CREATOR_ROOT: root, EDGE_CREATOR_GRAPH: graphPath,
      EDGE_CREATOR_LEDGER: ledgerPath, EDGE_CREATOR_RESULT: resultPath, EDGE_CREATOR_RUN: runId,
      EDGE_CREATOR_STAGE: stage, EDGE_CREATOR_IS_RESUME: isResume ? '1' : '0' },
  });
  const timedOut = child.error && 'code' in child.error && child.error.code === 'ETIMEDOUT';
  if (timedOut) return { state: { status: 'timeout' }, timedOut: true };
  if (child.status !== expectedExit) return { state: { status: child.status === 88 ? 'execution-limit-exceeded' : `process-exit-${String(child.status)}` }, timedOut: false };
  if (expectedExit !== 0) return { state: findRunReceipt(root, runId), timedOut: false };
  try {
    return { state: JSON.parse(readFileSync(resultPath, 'utf8')) as PersistedRun, timedOut: false };
  } catch {
    return { state: { status: 'missing-result' }, timedOut: false };
  }
}

function findRunReceipt(root: string, runId: string): PersistedRun {
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const value = JSON.parse(readFileSync(path, 'utf8')) as PersistedRun;
          if (value.runId === runId) return value;
        } catch { /* ignore non-run JSON files */ }
      }
    }
  }
  return { status: 'missing-run-receipt' };
}

function readSourceReceipt(run: PersistedRun): unknown {
  const output = run.nodes?.find((node) => node.nodeId === 'source')?.output;
  if (typeof output !== 'string') return output;
  let decoded: unknown;
  try { decoded = JSON.parse(output); }
  catch { return output; }
  return decoded;
}

function readLedger(path: string): FakeEffectLedger {
  return JSON.parse(readFileSync(path, 'utf8')) as FakeEffectLedger;
}
