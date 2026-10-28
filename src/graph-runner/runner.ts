import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getElanousConfigDir, getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';
import { observeModelInputTokens } from '../harness/model-input-observation.js';
import { publishInsideEvent } from '../nexus/api/inside-events.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { listInstalledPlugins } from '../plugins/install/plugin-install.js';
import { credentialStatus, pluginEnv } from '../plugins/install/plugin-credentials.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { loadNodeCatalog } from '../self-implement/graph-catalog.js';
import { recordFailureEvent } from '../self-implement/heal-intake.js';
import { growthApprovalRef, proposeGrowth, type GraphGrowth, type GrowthProposer, type GrowthRecipeEffect, type GrowthDecisionDeps, type GrowthCommand } from './graph-grow.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { createLLMGrowthProposer } from './graph-grow-llm.js';
import type { ResearchEdgeDecisionRegistry } from '../research/edge-decision.js';
import { graphVersionHash, parseGraphTemplateYaml, type GraphEdgeSpec, type GraphNodeSpec, type GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { createGraphUnitResolver, resolveGraphUnit, UnitNotFoundError, type ResolvedGraphUnit } from '../self-implement/graph-unit-resolver.js';
import { flattenGraphUnits } from '../self-implement/graph-unit-flatten.js';
export { UnitNotFoundError } from '../self-implement/graph-unit-resolver.js';
import { createGraphVariant, type GraphVariantPlan } from '../self-implement/graph-variant.js';
import { psProcessStartMs, START_TOLERANCE_MS } from '../harness/harness-stop.js';
import { executeBashNode } from '../workflow-runtime/nodes/bash.js';
import { executeClassifyNode } from '../workflow-runtime/nodes/classify.js';
import { interpolate } from '../workflow-runtime/variables.js';
import type { BashNode, ClassifyNode, NodeExecContext, NodeOutput, WorkflowDeps } from '../workflow-runtime/types.js';
import { releaseResumeAcceptedRegressions, releaseResumeGateExecutor, releaseResumeGatePodPool, releaseResumeGateShardReroute, releaseResumeWaiver, type AcceptedRegression, type GateExecutorOverride, type GatePodPoolOverride, type GateShardRerouteOverride } from '../../scripts/release-loop/resume.js';

type BashRun = WorkflowDeps['runBash'];
const DEFAULT_BASH_TIMEOUT_MS = 5 * 60 * 1_000;
// Independent of graph YAML and recipe snapshots: an already-wrong saved binding must fail closed.
const RELEASE_NODE_COMMANDS: Readonly<Record<string, { recipe: string; command?: string }>> = {
  'version-release': { recipe: 'cmd:version-release', command: 'bun scripts/release-loop/version-node.ts release --json' },
  'traffic-cut-start': { recipe: 'cmd:traffic-cut-start', command: 'bun scripts/release-loop/traffic-node.ts traffic-cut-start' },
  cutoff: { recipe: 'cmd:cutoff', command: 'bun scripts/release-loop/node-verdict.ts cutoff' },
  'checklist-gate': { recipe: 'cmd:checklist-gate', command: 'bun scripts/release-loop/checklist-gate-node.ts' },
  prefetch: { recipe: 'cmd:docs', command: 'bun scripts/release-loop/docs-node.ts --json' },
  gate: { recipe: 'cmd:gate', command: 'bun scripts/release-loop/gate-node.ts --json' },
  'traffic-gate-passed': { recipe: 'cmd:traffic-gate-passed', command: 'bun scripts/release-loop/traffic-node.ts traffic-gate-passed' },
  'gate-triage': { recipe: 'cmd:gate-triage', command: 'bun scripts/release-loop/gate-triage-node.ts' },
  'mac-smoke': { recipe: 'cmd:mac-smoke', command: 'bun scripts/release-loop/mac-smoke-node.ts' },
  'export-check': { recipe: 'cmd:export-check', command: 'bun scripts/release-loop/export-check-node.ts' },
  pwa: { recipe: 'cmd:pwa', command: 'bun scripts/release-loop/node-verdict.ts pwa' },
  prepare: { recipe: 'cmd:prepare', command: 'bun scripts/release-loop/prepare-node.ts' },
  upgrade: { recipe: 'cmd:upgrade', command: 'bun scripts/release-loop/upgrade-node.ts' },
  tui: { recipe: 'cmd:docs', command: 'bun scripts/release-loop/docs-node.ts --json' },
  docs: { recipe: 'cmd:docs', command: 'bun scripts/release-loop/docs-node.ts --json' },
  'known-issues': { recipe: 'cmd:known-issues', command: 'bun scripts/release-loop/known-issues-node.ts' },
  'notes-check': { recipe: 'cmd:notes-check', command: 'bun scripts/announce-loop/check-node.ts --json' },
  'notes-repair': { recipe: 'cmd:docs', command: 'bun scripts/release-loop/docs-node.ts --json' },
  'notes-recheck': { recipe: 'cmd:notes-check', command: 'bun scripts/announce-loop/check-node.ts --json' },
  'auto-approve': { recipe: 'cmd:auto-approve', command: 'bun scripts/release-loop/auto-approve-node.ts' },
  'approve-publish': { recipe: 'approval:publish' },
  publish: { recipe: 'cmd:publish-command', command: 'bun scripts/release-loop/publish-node.ts' },
  'npm-publish': { recipe: 'cmd:npm-publish', command: 'bun scripts/release-loop/npm-publish-node.ts' },
  'traffic-npm-published': { recipe: 'cmd:traffic-npm-published', command: 'bun scripts/release-loop/traffic-node.ts traffic-npm-published' },
  'docs-land': { recipe: 'cmd:docs-land', command: 'bun scripts/release-loop/docs-land-node.ts' },
  verify: { recipe: 'cmd:verify', command: 'bun scripts/release-loop/verify-node.ts' },
  'traffic-verify-complete': { recipe: 'cmd:traffic-verify-complete', command: 'bun scripts/release-loop/traffic-node.ts traffic-verify-complete' },
  'traffic-failed-restore': { recipe: 'cmd:traffic-failed-restore', command: 'bun scripts/release-loop/traffic-node.ts traffic-failed-restore' },
  'vault-note': { recipe: 'cmd:vault-note', command: 'bun scripts/release-loop/vault-note-node.ts' },
  'release-story': { recipe: 'cmd:release-story', command: 'bun scripts/release-story/draft.ts --graph' },
  'ops-upgrade': { recipe: 'cmd:ops-upgrade', command: 'bun scripts/release-loop/ops-upgrade-node.ts' },
  'version-dev-bump': { recipe: 'cmd:version-dev-bump', command: 'bun scripts/release-loop/version-node.ts dev-bump --json' },
  'version-dev-bump-after-failure': { recipe: 'cmd:version-dev-bump', command: 'bun scripts/release-loop/version-node.ts dev-bump --json' },
  done: { recipe: 'none' },
  failed: { recipe: 'none' },
};

function assertReleaseCommandBinding(node: GraphNodeSpec, command: string | undefined, terminal: boolean): void {
  const expected = RELEASE_NODE_COMMANDS[node.nodeId];
  if (!expected || node.recipe !== expected.recipe || command !== expected.command ||
    terminal !== (node.nodeId === 'done' || node.nodeId === 'failed')) {
    throw new Error(`release node dispatch mismatch before execution: ${node.nodeId}`);
  }
}

const LOOP_TERMINAL_STATUS: Readonly<Record<string, Readonly<Record<string, 'done' | 'failed'>>>> = {
  'ta-journey': { done: 'done', failed: 'failed', 'needs-human': 'failed', rework: 'failed' },
  'default-loop': { landed: 'done', stopped: 'failed' },
  'document-loop': { landed: 'done', 'document-blocked': 'failed', 'needs-human': 'failed' },
  'operate-loop': { landed: 'done', 'operate-blocked': 'failed', 'needs-human': 'failed' },
  'research-loop': { landed: 'done', 'needs-human': 'failed' },
};

function topLevelTerminalStatus(graphId: string, terminal: string): 'done' | 'failed' | undefined {
  const aliases = Object.hasOwn(LOOP_TERMINAL_STATUS, graphId) ? LOOP_TERMINAL_STATUS[graphId] : undefined;
  if (aliases) return Object.hasOwn(aliases, terminal) ? aliases[terminal] : undefined;
  return terminal === 'done' || terminal === 'failed' ? terminal : undefined;
}

/** HARNESS-FULL-GRAPH-LOOPS — the four goal loops are self-implement harness templates: their recipes are
 *  catalog roles (no `recipes.yaml` sidecar) and some edges branch on `changed-files`. `graph run` can only
 *  *plan* them: `--dry-run` walks the declared success route; a real run is refused (the harness owns effects). */
const HARNESS_LOOP_GRAPH_IDS: ReadonlySet<string> = new Set(['default-loop', 'document-loop', 'operate-loop', 'research-loop']);

type PlannedStep = { outcome?: string; to: string };

/** Shortest declared route (map/to edges only — fallbacks are not a success branch) to a terminal that maps to `done`.
 *  Ties keep the first declared outcome, so the plan follows the YAML's own order. A unit call only takes its first
 *  declared exit (the same stand-in a plain dry run uses) — its `rework` exit is a shortcut, not the success path. */
function planHarnessLoopRoute(graph: GraphTemplateSpec, unitSuccessExit: (nodeId: string) => string | undefined): Map<string, PlannedStep> {
  const candidates = new Map<string, PlannedStep[]>();
  for (const node of graph.nodes) {
    const edge = graph.edges.find((e) => e.from === node.nodeId);
    if (!edge) continue;
    const exit = unitSuccessExit(node.nodeId);
    candidates.set(node.nodeId, edge.to !== undefined ? [{ to: edge.to }]
      : Object.entries(edge.map ?? {}).filter(([outcome]) => exit === undefined || outcome === exit).map(([outcome, to]) => ({ outcome, to })));
  }
  const distance = new Map<string, number>();
  for (const terminal of graph.terminalNodes) if (topLevelTerminalStatus(graph.graphId, terminal) === 'done') distance.set(terminal, 0);
  const route = new Map<string, PlannedStep>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [nodeId, steps] of candidates) {
      if (graph.terminalNodes.includes(nodeId)) continue;
      let best: { step: PlannedStep; d: number } | undefined;
      for (const step of steps) {
        const d = distance.get(step.to);
        if (d !== undefined && (!best || d + 1 < best.d)) best = { step, d: d + 1 };
      }
      if (best && (distance.get(nodeId) ?? Infinity) > best.d) {
        distance.set(nodeId, best.d);
        route.set(nodeId, best.step);
        changed = true;
      }
    }
  }
  return route;
}

export interface GraphRunState {
  graphId: string;
  runId: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  pidStartedAt?: string;
  activeNode?: { nodeId: string; pid: number; pidStartedAt: string };
  stoppedAt?: string;
  status: 'running' | 'done' | 'failed' | 'budget-exceeded' | 'awaiting-approval';
  /** Original named terminal when status is its canonical done/failed mapping. */
  reason?: string;
  path: string[];
  /** startedAt/endedAt (ISO) and seconds are written when the node runs; ledgers before GRAPH-NODE-TIMES (0.2.19) have none. */
  nodes: Array<{ nodeId: string; ok: boolean; exit: number | null; executed: boolean; output?: unknown; error?: string; reason?: string;
    failure?: { errorCode: string; message: string; stage: string }; decidedBy?: string; decidedAt?: string;
    startedAt?: string; endedAt?: string; seconds?: number;
    waiver?: { reason: string; at: string; /** RELEASE-WAIVE-UNMEASURED — why the waived gate had no verdict. */ unmeasured?: string; original: { exit: number | null; output?: unknown; error?: string } } }>;
  /** The node now running and when it started; cleared when its record is written. */
  currentNode?: { nodeId: string; startedAt: string };
  input?: unknown;
  pending?: { nodeId: string; message: string; since: string; notifiedAt?: string; decision?: 'approved' | 'rejected'; decidedBy?: string; decidedAt?: string };
  approvalSourceHash?: string;
  /** Hash of the graph and recipes used for this run; required to safely restart a failed path. */
  sourceHash?: string;
  graphSnapshot?: { graphSha: string; recipesSha: string };
  graphPath?: string;
  variant?: { overlayId: string; goal: string; plan: GraphVariantPlan };
  parentRunId?: string;
  /** The entry chosen by a parent call; absent for existing single-entry runs. */
  entryNodeId?: string;
  unitCalls?: Array<{ node: string; unit: string; version: number; hash: string; childRunId: string; exit: string; steps: number; entry?: string }>;
  growth?: GraphGrowth[];
  growthRejections?: Array<{ from: string; outcome: string; reason: string }>;
  growthPark?: { from: string; outcome: string; reason: string; decisionId: string; decisionRef: string; growth: GraphGrowth; command?: GrowthCommand; approval?: string };
  resume?: { from: string; at: string; previousStatus: GraphRunState['status']; graph?: 'snapshot' | 'current' };
  /** GATE-HOST-EXECUTOR — every explicit input change a resume made (what was set and what it replaced), oldest first. */
  inputOverrides?: Array<GateExecutorOverride | GatePodPoolOverride | GateShardRerouteOverride>;
  executed: number;
  dryRun: boolean;
  statePath: string;
}

function failedCommandStderrTail(exitCode: number, stderr: string): string | undefined {
  if (exitCode === 0 || !stderr.trim()) return undefined;
  return stderr.replace(/(?:\r?\n)+$/, '').split(/\r?\n/).slice(-40).join('\n') || undefined;
}

export interface GraphClassifyInput {
  arguments: string;
  classify: ClassifyNode['classify'];
  /** Production consumer that asked for the verdict, so one ledger shape separates callers. */
  caller?: string;
}

/** Run the workflow classifier as a persisted harness graph node. The workflow verdict is unchanged. */
export async function runGraphClassifyNode(node: ClassifyNode, ctx: NodeExecContext, callLLM: WorkflowDeps['callLLM'],
  meta: { caller?: string } = {}): Promise<NodeOutput> {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-graph-classify-'));
  try {
    const path = join(dir, 'graph.yaml');
    writeFileSync(join(dir, 'recipes.yaml'), '{}\n');
    writeFileSync(path, stringifyYaml({
      graph_id: 'self-implement-classify', version: 1, entry_node: 'classify', terminal_nodes: ['done', 'failed'],
      nodes: [
        { node_id: 'classify', kind: 'classify', recipe: 'none', max_visits: 1 },
        { node_id: 'done', kind: 'gate', recipe: 'none', max_visits: 1 },
        { node_id: 'failed', kind: 'gate', recipe: 'none', max_visits: 1 },
      ],
      edges: [{ from: 'classify', on: 'outcome', map: { ok: 'done', fail: 'failed' } }],
    }));
    const run = await runGraph(path, { input: { arguments: ctx.arguments, classify: node.classify,
      ...(meta.caller === undefined ? {} : { caller: meta.caller }) } satisfies GraphClassifyInput,
      quiet: true,
      deps: { callLLM: async (prompt) => callLLM({ prompt, ...(ctx.resolvedModel === undefined ? {} : { model: ctx.resolvedModel }),
        ...(ctx.resolvedProvider === undefined ? {} : { provider: ctx.resolvedProvider }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) }) } });
    const recorded = lastJsonObject(run.nodes[0]?.output);
    if (!recorded || typeof recorded.durationMs !== 'number' || typeof recorded.ok !== 'boolean' || !('output' in recorded)) {
      throw new Error(`classify graph did not record a result: ${run.statePath}`);
    }
    return { ok: recorded.ok, output: recorded.output, durationMs: recorded.durationMs,
      ...(typeof recorded.error === 'string' ? { error: recorded.error } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface GraphRunOptions {
  input?: unknown;
  /** Bytes already checked by the tick gate, used for a current-graph start or legacy resume. */
  graphSource?: string;
  dryRun?: boolean;
  variant?: { goal: string; plan: GraphVariantPlan };
  runId?: string;
  resumeRunId?: string;
  resumeGraphId?: string;
  fromNodeId?: string;
  /** Embedded runs (a classify verdict inside self-implement) keep the per-node `[graph]` stderr lines off the caller's terminal; debug.log still records every node. */
  quiet?: boolean;
  /** Release-only: accept the recorded failed node without executing it, and expose its regression to known-issues. */
  releaseWaiver?: { nodeId: string; reason: string; requestedRegressions: AcceptedRegression[]; acceptedRegressions: AcceptedRegression[]; unmeasured?: string };
  /** Release-only: add accepted issues independently of a waiver at a restart boundary. */
  releaseAcceptedRegressions?: { requested: AcceptedRegression[]; acceptedRegressions: AcceptedRegression[] };
  /** Release-only (GATE-HOST-EXECUTOR): run the restarted gate on this executor — recorded in `inputOverrides`, never a waiver. */
  releaseGateExecutor?: { executor: string; host?: string };
  /** Release-only (RESUME-GATE-POOL-OVERRIDE): replace the saved gate pool for this resumed gate. */
  releaseGatePodPool?: string;
  /** Release-only: remeasure a shard after the same-commit resume preflight. */
  releaseGateShardReroute?: { shard: string; host?: string; os?: 'darwin' | 'linux' };
  useCurrentGraph?: boolean;
  /** Internal unit invocation context, propagated only by runGraph. */
  unitContext?: { parentRunId: string; ancestors: readonly string[]; remainingSteps: number; entryNodeId?: string };
  /**
   * RELEASE-LEDGER-UNIVERSE — stamp every cmd: child with this run's ledger root (`ELANOUS_STATE_DIR`).
   * Without it a child launched from a non-leader tree (`bun scripts/...` with cwd = that tree) re-resolves
   * its own universe and lands in the tree-derived test universe while the run ledger is prod.
   */
  pinChildUniverse?: boolean;
  /** Release resume: command checkout and cut tip, checked before every Bash dispatch. */
  releaseCommandSource?: { root: string; cutTip: string; git?: (args: string[]) => string };
  /** Optional per-run Bloom edge policy hook. */
  researchEdgeDecisionRegistry?: ResearchEdgeDecisionRegistry;
  deps?: { root?: string; runBash?: BashRun; callLLM?: (prompt: string) => Promise<string>; log?: (event: string, data: Record<string, unknown>) => void; beforeNode?: () => void; processStartMs?: (pid: number) => number | null; growthProposer?: GrowthProposer; growthLLM?: (prompt: string) => Promise<string>; classifyGrowthRecipe?: (node: GraphNodeSpec, resolved: { command?: string; approval?: string }) => GrowthRecipeEffect; growthDecision?: GrowthDecisionDeps & { list?: (filters: { status: 'all' }) => DecisionEntry[] } };
}

/** The command directory must itself be the checkout at the cut tip. */
export function verifyReleaseCommandRoot(root: string, cutTip: string, git?: (args: string[]) => string): string {
  let commandRoot: string;
  try { commandRoot = realpathSync(root); }
  catch { throw new Error(`release command root missing: ${root} — use --command-root <컷 tip checkout>`); }
  const run = git ?? ((args: string[]): string => {
    // git-spawn-allow: read-only checkout identity before release command dispatch.
    // `git ls-files -v -z` exceeds Node's 1 MiB default in the 25k-path main checkout.
    const result = spawnSync('git', args, { cwd: commandRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0 || result.error) throw new Error(`release command root is not a git checkout: ${commandRoot} — use --command-root <컷 tip checkout>`);
    return result.stdout.trim();
  });
  const head = run(['rev-parse', 'HEAD']);
  // `status` can hide modified tracked code when assume-unchanged or skip-worktree is set.
  // A release command checkout must not carry either index promise.
  const hiddenTracked = run(['ls-files', '-v', '-z']).split('\0').find((entry) => entry && entry[0] !== 'H');
  if (!/^[0-9a-f]{40}$/i.test(cutTip) || head.toLowerCase() !== cutTip.toLowerCase() ||
      (!git && realpathSync(run(['rev-parse', '--show-toplevel'])) !== commandRoot) ||
      hiddenTracked || run(['-c', 'status.showUntrackedFiles=all', 'status', '--porcelain', '--untracked-files=all'])) {
    throw new Error(`release command root ${commandRoot}@${head.slice(0, 12)} differs from cut tip ${cutTip.slice(0, 12)} — use --command-root <컷 tip checkout>`);
  }
  return commandRoot;
}

/** Reject a checkout whose saved release graph or recipes differ, including before an injected graph runner is called. */
export function verifyReleaseRecipeSnapshot(commandRoot: string, snapshot?: { graphSha: string; recipesSha: string }): void {
  if (!snapshot) throw new Error('release recipe snapshot missing — cannot pin command source');
  const cutGraph = join(commandRoot, 'graphs', 'release', 'release-loop.yaml');
  const cutRecipes = join(commandRoot, 'graphs', 'release', 'recipes.yaml');
  const hashFile = (file: string): string => {
    try { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
    catch { throw new Error(`release recipe source missing in cut checkout: ${file}`); }
  };
  if (hashFile(cutGraph) !== snapshot.graphSha || hashFile(cutRecipes) !== snapshot.recipesSha) {
    throw new Error('release recipe source differs from the saved graph snapshot at cut tip');
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === '.' || value === '..') {
    throw new Error(`invalid graph run identifier: ${value}`);
  }
  return value;
}

type CommandRecipe = { command: string; dry_run_command?: string; timeout_ms?: number };
type PromptRecipe = { prompt: string };
type Recipe = CommandRecipe | PromptRecipe | ({ approval: string } & Partial<CommandRecipe>);

/** 접두 없는 recipe 가 카탈로그 역할이고, 그래프 옆 recipes.yaml 에 같은 키의 `{ command }` 가 있을 때만 cmd 처럼 실행한다. */
function roleCommand(recipe: string, recipes: Record<string, Recipe>, catalogRoles: ReadonlySet<string>): CommandRecipe | undefined {
  if (!recipe || recipe === 'none' || recipe.includes(':') || !catalogRoles.has(recipe)) return undefined;
  const entry = recipes[recipe];
  // An entry that carries an approval only runs through `approval:` — never as a bare command.
  return entry && 'command' in entry && !('approval' in entry) && typeof entry.command === 'string' ? { command: entry.command,
    ...(entry.dry_run_command ? { dry_run_command: entry.dry_run_command } : {}),
    ...(entry.timeout_ms ? { timeout_ms: entry.timeout_ms } : {}) } : undefined;
}

function resolveNodeRecipe(node: GraphNodeSpec, recipes: Record<string, Recipe>, catalogRoles: ReadonlySet<string>): { command?: CommandRecipe; prompt?: PromptRecipe; approval?: { approval: string } } {
  if (node.recipe === 'none') return {};
  if (node.kind === 'prompt' && node.recipe.startsWith('prompt:')) {
    const entry = recipes[node.recipe.slice('prompt:'.length)];
    return entry && 'prompt' in entry ? { prompt: entry } : {};
  }
  if (node.recipe.startsWith('cmd:')) {
    const id = node.recipe.slice(4);
    const entry = recipes[id];
    return entry && 'command' in entry && !('approval' in entry) && typeof entry.command === 'string' ? { command: { command: entry.command,
      ...(entry.dry_run_command ? { dry_run_command: entry.dry_run_command } : {}),
      ...(entry.timeout_ms ? { timeout_ms: entry.timeout_ms } : {}) } } : {};
  }
  if (node.recipe.startsWith('approval:')) {
    const id = node.recipe.slice(9);
    const entry = recipes[id];
    return entry && 'approval' in entry ? { approval: entry,
      ...('command' in entry && typeof entry.command === 'string' ? { command: { command: entry.command,
        ...(entry.dry_run_command ? { dry_run_command: entry.dry_run_command } : {}),
        ...(entry.timeout_ms ? { timeout_ms: entry.timeout_ms } : {}) } } : {}) } : {};
  }
  const command = roleCommand(node.recipe, recipes, catalogRoles);
  return command ? { command } : {};
}

function approvalMessage(template: string, input: unknown): string {
  if (!template.includes('{{input.version}}')) return template;
  const version = input && typeof input === 'object' && 'version' in input ? (input as { version: unknown }).version : undefined;
  if (typeof version !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error('approval input.version must be a release version');
  }
  return template.replaceAll('{{input.version}}', version);
}

function recipesFor(path: string, recipeSource: string): Record<string, Recipe> {
  const file = join(dirname(path), 'recipes.yaml');
  const parsed: unknown = parseYaml(recipeSource);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`invalid recipes: ${file}`);
  const recipes: Record<string, Recipe> = Object.create(null);
  for (const [id, raw] of Object.entries(parsed)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid recipe: ${id}`);
    const item = raw as Record<string, unknown>;
    if (Object.hasOwn(item, 'prompt')) {
      if (typeof item.prompt !== 'string' || !item.prompt.trim() || Object.keys(item).some(key => key !== 'prompt')) throw new Error(`invalid recipe: ${id}`);
      recipes[id] = { prompt: item.prompt };
    } else if (Object.hasOwn(item, 'approval')) {
      if (typeof item.approval !== 'string' || !item.approval.trim() ||
        (item.command !== undefined && (typeof item.command !== 'string' || !item.command.trim())) ||
        (item.timeout_ms !== undefined && (!Number.isSafeInteger(item.timeout_ms) || (item.timeout_ms as number) <= 0)) ||
        (item.dry_run_command !== undefined && (typeof item.dry_run_command !== 'string' || !item.dry_run_command.trim())) ||
        (item.command === undefined && (item.timeout_ms !== undefined || item.dry_run_command !== undefined)) ||
        Object.keys(item).some(key => !['approval', 'command', 'dry_run_command', 'timeout_ms'].includes(key))) throw new Error(`invalid recipe: ${id}`);
      recipes[id] = { approval: item.approval,
        ...(item.command === undefined ? {} : { command: item.command as string }),
        ...(item.dry_run_command === undefined ? {} : { dry_run_command: item.dry_run_command as string }),
        ...(item.timeout_ms === undefined ? {} : { timeout_ms: item.timeout_ms as number }) };
    } else {
      if (typeof item.command !== 'string' || !item.command.trim() ||
        (item.timeout_ms !== undefined && (!Number.isSafeInteger(item.timeout_ms) || (item.timeout_ms as number) <= 0)) ||
        (item.dry_run_command !== undefined && (typeof item.dry_run_command !== 'string' || !item.dry_run_command.trim()))) {
        throw new Error(`invalid recipe: ${id}`);
      }
      recipes[id] = { command: item.command,
        ...(item.dry_run_command === undefined ? {} : { dry_run_command: item.dry_run_command as string }),
        ...(item.timeout_ms === undefined ? {} : { timeout_ms: item.timeout_ms as number }) };
    }
  }
  return recipes;
}

function realRunBash(onSpawn: (pid: number) => boolean): BashRun {
  return (body, opts) => new Promise((resolve, reject) => {
    let unverified: ReturnType<typeof setTimeout> | undefined;
    const child = execFile('/bin/bash', ['-c', body], { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, signal: opts.signal, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (unverified) clearTimeout(unverified);
      if (error && typeof (error as NodeJS.ErrnoException).code !== 'number') {
        reject(error);
        return;
      }
      resolve({ stdout, stderr, exitCode: error ? (error as unknown as { code: number }).code : 0 });
    });
    if (child.pid) {
      try {
        if (!onSpawn(child.pid)) {
          // A process can exit before ps observes it. A completed child is safe to report;
          // an unverified child still running must not be left without a tracked PID.
          unverified = setTimeout(() => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.kill('SIGTERM');
            reject(new Error(`cannot verify node process start: ${child.pid}`));
          }, 500);
        }
      } catch (error) { child.kill('SIGTERM'); reject(error); }
    }
  });
}

function graphRunPath(graphId: string, runId: string, root: string): string {
  return join(root, 'graph-runs', safeSegment(graphId), `${safeSegment(runId)}.json`);
}

function approvalDecisionPath(state: GraphRunState): string {
  return `${state.statePath}.${state.path.length}.decision.json`;
}

function applyRecordedDecision(state: GraphRunState): GraphRunState {
  if (!state.pending) return state;
  let recorded: { nodeId: string; decision: 'approved' | 'rejected'; decidedBy?: string; decidedAt: string };
  try { recorded = JSON.parse(readFileSync(approvalDecisionPath(state), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return state;
    throw error;
  }
  if (recorded.nodeId !== state.pending.nodeId || !['approved', 'rejected'].includes(recorded.decision) ||
    typeof recorded.decidedAt !== 'string' || (recorded.decidedBy !== undefined && typeof recorded.decidedBy !== 'string') ||
    (state.pending.decision && state.pending.decision !== recorded.decision)) {
    throw new Error(`approval decision mismatch: ${state.graphId}/${state.runId}`);
  }
  state.pending = { ...state.pending, ...recorded };
  return state;
}

function readGraphRun(graphId: string, runId: string, root: string): GraphRunState {
  const file = graphRunPath(graphId, runId, root);
  const state = JSON.parse(readFileSync(file, 'utf8')) as GraphRunState;
  if (state.graphId !== graphId || state.runId !== runId) throw new Error(`run identity mismatch: ${graphId}/${runId}`);
  return applyRecordedDecision({ ...state, statePath: file });
}

function persistGraphRun(state: GraphRunState): void {
  mkdirSync(dirname(state.statePath), { recursive: true });
  const temporary = `${state.statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n');
  renameSync(temporary, state.statePath);
}

/** Inbox I/O cannot change a persisted graph verdict. The saved run is the replay source if intake fails. */
function recordReleaseRunFailure(state: GraphRunState, root: string, summary: string): void {
  const event = { source: 'release-run' as const, kind: 'graph-run', ref: `${state.graphId}/${state.runId}`,
    summary, at: state.finishedAt! };
  try { recordFailureEvent(event, root); }
  catch (error) {
    debug.log('heal.intake', 'record-failed', {
      ...event, statePath: state.statePath, error: String(error),
    }, { level: 'error' });
  }
}

/** A synchronous, per-ledger critical section shared by runner writes and stop/destroy. */
function withRunWriteLock<T>(file: string, work: () => T): T {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.write.lock`;
  const staged = `${lock}.${randomUUID()}.staged`;
  mkdirSync(staged);
  const until = Date.now() + 5_000;
  let acquired = false;
  try {
    writeFileSync(join(staged, 'owner.json'), JSON.stringify({ pid: process.pid, started: Date.now() - process.uptime() * 1_000 }), { flag: 'wx' });
    while (!acquired) {
      try {
        // Unlike mkdir(lock) followed by a write, publication exposes an already complete owner.
        symlinkSync(staged, lock, 'dir');
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let owner: { pid: number; started: number } | undefined;
        try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); } catch { /* legacy unowned directory */ }
        const ownerStart = owner && Number.isSafeInteger(owner.pid) && Number.isFinite(owner.started) ? psProcessStartMs(owner.pid) : undefined;
        let stale = ownerStart !== undefined && (ownerStart === null || Math.abs(ownerStart - owner!.started) > START_TOLERANCE_MS);
        if (!owner && !lstatSync(lock).isSymbolicLink()) {
          // Legacy mkdir-before-owner crash: do not evict a writer still publishing its owner.
          stale = Date.now() - statSync(lock).mtimeMs >= 5_000;
        }
        if (stale) {
          try {
            if (lstatSync(lock).isSymbolicLink()) {
              const target = readlinkSync(lock);
              if (!target.startsWith(`${lock}.`) || !target.endsWith('.staged')) throw new Error('invalid graph run write lock');
              unlinkSync(lock);
              rmSync(target, { recursive: true, force: true });
            } else {
              if (owner) unlinkSync(join(lock, 'owner.json'));
              rmdirSync(lock);
            }
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
          }
          continue;
        }
        if (Date.now() >= until) throw new Error(`graph run write lock is held: ${file}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return work();
  } finally {
    if (acquired && existsSync(lock) && lstatSync(lock).isSymbolicLink() && readlinkSync(lock) === staged) unlinkSync(lock);
    rmSync(staged, { recursive: true, force: true });
  }
}

function persistOwnedRun(state: GraphRunState, expected: Pick<GraphRunState, 'pid' | 'pidStartedAt' | 'stoppedAt'>, allowRestart = false): void {
  withRunWriteLock(state.statePath, () => {
    let disk: GraphRunState;
    try { disk = JSON.parse(readFileSync(state.statePath, 'utf8')) as GraphRunState; }
    catch (cause) { throw new Error(`run was removed or unreadable: ${state.graphId}/${state.runId}`, { cause }); }
    if (disk.graphId !== state.graphId || disk.runId !== state.runId || disk.pid !== expected.pid ||
        disk.pidStartedAt !== expected.pidStartedAt || disk.stoppedAt !== expected.stoppedAt ||
        (disk.stoppedAt !== undefined && !allowRestart)) {
      throw new Error(`run was stopped or ownership changed: ${state.graphId}/${state.runId}`);
    }
    persistGraphRun(state);
  });
}

export interface ExpectedGraphApprovalVisit { nodeId: string; visit: number }

export function decideGraphApproval(graphId: string, runId: string, decision: 'approved' | 'rejected', by?: string, root = effectiveInstanceRoot(), expected?: ExpectedGraphApprovalVisit): GraphRunState {
  const state = readGraphRun(graphId, runId, root);
  if (state.status !== 'awaiting-approval' || !state.pending || state.growthPark || state.pending.decision ||
      (expected && (state.dryRun || state.pending.nodeId !== expected.nodeId || state.path.at(-1) !== expected.nodeId ||
        !Number.isSafeInteger(expected.visit) || expected.visit < 1 ||
        state.path.filter(node => node === expected.nodeId).length !== expected.visit))) {
    throw new Error(`run is not awaiting an undecided approval: ${graphId}/${runId}`);
  }
  if (by !== undefined && !by.trim()) throw new Error('approver name must not be empty');
  const recorded = { nodeId: state.pending.nodeId, decision, ...(by === undefined ? {} : { decidedBy: by }), decidedAt: new Date().toISOString() };
  // A card can claim only the visit it names; never derive a later visit's claim path from a fresh read.
  const decisionPath = approvalDecisionPath(state);
  const temporary = `${decisionPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(recorded) + '\n', { flag: 'wx' });
  try {
    // Hard-link creation is atomic across processes: only the first approver can claim this visit.
    linkSync(temporary, decisionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`run is not awaiting an undecided approval: ${graphId}/${runId}`);
    }
    throw error;
  } finally {
    unlinkSync(temporary);
  }
  return applyRecordedDecision(state);
}

/** The record `graph runs stop` writes for the node it cut (release resume reads it as an unmeasured gate). */
export const STOPPED_NODE_ERROR = 'stopped before node completed';

/** 노드 stdout 의 «마지막 비어 있지 않은 줄»이 JSON 객체면 그것을 구조 산출로 본다(아니면 없음). */
export function lastJsonObject(stdout: unknown): Record<string, unknown> | undefined {
  if (typeof stdout !== 'string') return undefined;
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last || !last.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(last);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Reconstruct the run-local edges from the ledger without rewriting the YAML snapshot. */
function withGrowth(graph: GraphTemplateSpec, growth: readonly GraphGrowth[]): GraphTemplateSpec {
  return growth.reduce<GraphTemplateSpec>((current, item) => {
    const edge = current.edges.find((candidate) => candidate.from === item.undo.removeOutcome.from);
    if (!edge || !edge.map || !item.node || item.undo.removeNode !== item.node.nodeId ||
        current.nodes.some((node) => node.nodeId === item.node.nodeId) ||
        Object.hasOwn(edge.map, item.undo.removeOutcome.outcome) ||
        !item.edges.some((added) => added.from === edge.from && added.map?.[item.undo.removeOutcome.outcome] === item.node.nodeId)) {
      throw new Error('invalid saved graph growth');
    }
    return { ...current, nodes: [...current.nodes, item.node], edges: current.edges.map((candidate) => candidate === edge
      ? { ...edge, map: { ...edge.map, [item.undo.removeOutcome.outcome]: item.node.nodeId } } : candidate)
      .concat(item.undo.removeEdge ? [item.undo.removeEdge] : []) };
  }, graph);
}

/** 이름 붙은 결과: 산출의 `outcome` 이 그 간선 map 의 키면 그 목적지 — 아니면 종전 ok/fail(exit) → fallback. */
function nextNode(edges: readonly GraphEdgeSpec[], nodeId: string, exitOutcome: 'ok' | 'fail', namedOutcome?: string): string | undefined {
  const edge = edges.find((e) => e.from === nodeId);
  if (!edge) return undefined;
  if (edge.to !== undefined) return edge.to;
  if (edge.on !== 'outcome') throw new Error(`unsupported edge condition: ${edge.on}`);
  if (namedOutcome !== undefined && edge.map && Object.hasOwn(edge.map, namedOutcome)) return edge.map[namedOutcome];
  return edge.map?.[exitOutcome] ?? edge.fallback?.[0]?.node;
}

type ResolvedUnit = ResolvedGraphUnit;
export const resolveUnit = resolveGraphUnit;

export function validateUnitCalls(graph: GraphTemplateSpec, path: string, ancestors: readonly string[] = [], onMissing?: (call: string) => void): Map<string, ResolvedUnit> {
  return validateUnitCallsWithResolver(graph, path, ancestors, onMissing, createGraphUnitResolver());
}

function validateUnitCallsWithResolver(graph: GraphTemplateSpec, path: string, ancestors: readonly string[], onMissing: ((call: string) => void) | undefined,
  resolve: typeof resolveGraphUnit): Map<string, ResolvedUnit> {
  if (ancestors.includes(graph.graphId)) throw new Error(`unit cycle: ${[...ancestors, graph.graphId].join(' -> ')}`);
  if (ancestors.length > 3) throw new Error('unit nesting exceeds depth 3');
  const result = new Map<string, ResolvedUnit>();
  for (const node of graph.nodes) {
    if (node.kind !== 'subgraph' || node.call === undefined) continue;
    let unit: ResolvedUnit;
    try { unit = resolve(node.call!, path); } catch (error) {
      if (error instanceof UnitNotFoundError && onMissing) { onMissing(node.call!); continue; }
      throw error;
    }
    const selectedEntry = node.callEntry ?? unit.template.entryNode;
    if (!(unit.template.unit?.entries ?? [unit.template.entryNode]).includes(selectedEntry)) {
      throw new Error(`unit entry mismatch: ${node.nodeId} -> ${selectedEntry}`);
    }
    const contract = node.contract!;
    const edge = graph.edges.find(e => e.from === node.nodeId);
    if (!unit.template.unit || contract.inputs.length !== unit.template.unit.inputs.length ||
        contract.inputs.some(key => !unit.template.unit!.inputs.includes(key)) ||
        contract.outputs.length !== unit.template.unit.outputs.length ||
        contract.outputs.some(key => !unit.template.unit!.outputs.includes(key)) || edge?.on !== 'outcome' ||
        !edge.map || Object.keys(edge.map).length !== unit.template.unit.exits.length ||
        unit.template.unit.exits.some(exit => !Object.hasOwn(edge.map!, exit))) {
      debug.log('graph.unit', 'contract-mismatch', { graphId: graph.graphId, nodeId: node.nodeId, call: node.call });
      throw new Error(`unit contract mismatch: ${node.nodeId} -> ${node.call}`);
    }
    validateUnitCallsWithResolver(unit.template, unit.path, [...ancestors, graph.graphId], onMissing, resolve);
    result.set(node.nodeId, unit);
  }
  return result;
}

export async function runGraph(path: string, options: GraphRunOptions = {}): Promise<GraphRunState> {
  if (options.resumeRunId && options.runId) throw new Error('runId and resumeRunId cannot be combined');
  if (options.fromNodeId && !options.resumeRunId) throw new Error('--from requires --resume');
  if (options.useCurrentGraph && !options.resumeRunId) throw new Error('--use-current-graph requires --resume');
  if (options.variant && options.resumeRunId) throw new Error('variant cannot be combined with --resume');
  if (options.releaseWaiver && (!options.resumeRunId || options.fromNodeId !== options.releaseWaiver.nodeId)) throw new Error('release waiver requires --resume --from <waived node>');
  if (options.releaseAcceptedRegressions && (!options.resumeRunId || !options.fromNodeId || options.releaseWaiver)) throw new Error('accepted regressions require a release resume boundary');
  if (options.releaseGateExecutor && (!options.resumeRunId || !options.fromNodeId)) throw new Error('gate executor override requires a release resume boundary');
  if (options.releaseGatePodPool !== undefined && (!options.resumeRunId || !options.fromNodeId)) throw new Error('gate pod pool override requires a release resume boundary');
  if (options.releaseGateShardReroute && (!options.resumeRunId || options.fromNodeId !== 'gate')) throw new Error('shard reroute requires release resume --from gate');
  const root = options.deps?.root ?? effectiveInstanceRoot();
  const matchingRuns = options.resumeRunId && !options.resumeGraphId
    ? listGraphRuns(root).runs.filter((run) => run.runId === options.resumeRunId && run.graphPath === resolve(path)) : [];
  if (matchingRuns.length > 1) throw new Error(`ambiguous run id: ${options.resumeRunId}`);
  const currentSource = options.resumeRunId && (options.resumeGraphId || matchingRuns.length) && !options.useCurrentGraph
    ? undefined : options.graphSource ?? readFileSync(path, 'utf8');
  const currentHeader: unknown = options.resumeRunId && !options.resumeGraphId && !matchingRuns.length ? parseYaml(currentSource!) : undefined;
  const resumeGraphId = options.resumeGraphId ?? matchingRuns[0]?.graphId ?? (currentHeader && typeof currentHeader === 'object' && !Array.isArray(currentHeader)
    ? (currentHeader as Record<string, unknown>).graph_id : undefined);
  const saved = options.resumeRunId && typeof resumeGraphId === 'string'
    ? readGraphRun(safeSegment(resumeGraphId), safeSegment(options.resumeRunId), root) : undefined;
  if (saved?.graphSnapshot && (!saved.graphPath || resolve(path) !== resolve(saved.graphPath))) {
    throw new Error('--file cannot change the graph path of a snapshot run (이 런은 시작 때 그래프 사본이 있다 — --file 대신 --use-current-graph)');
  }
  const snapshotDir = saved ? `${saved.statePath}.graph` : undefined;
  const graphMode: 'snapshot' | 'current' = snapshotDir && saved?.graphSnapshot && !options.useCurrentGraph ? 'snapshot' : 'current';
  const source = graphMode === 'snapshot' ? readFileSync(join(snapshotDir!, 'graph.yaml'), 'utf8') : currentSource ?? options.graphSource ?? readFileSync(path, 'utf8');
  // The shared YAML parser requires a recipe string. A command-less node in
  // this runner is represented internally as `none`, without changing that parser.
  const raw: unknown = parseYaml(source);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid graph: ${path}`);
  const document = raw as Record<string, unknown>;
  if (Array.isArray(document.nodes)) {
    document.nodes = document.nodes.map((node: unknown) => node && typeof node === 'object' && !Array.isArray(node) && !('recipe' in node)
      ? { ...node, recipe: 'none' } : node);
  }
  const parsed = parseGraphTemplateYaml(stringifyYaml(document), path);
  if (!parsed.template || parsed.errors.length) throw new Error(parsed.errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
  let graph = parsed.template;
  const variant = options.variant ? createGraphVariant({ template: graph, ...options.variant }) : undefined;
  if (variant && !variant.ok) throw new Error(`graph variant rejected: ${JSON.stringify(variant.rejections)}`);
  if (variant?.ok) graph = variant.template;
  const unitResolver = createGraphUnitResolver();
  const units = validateUnitCallsWithResolver(graph, path, options.unitContext?.ancestors ?? [], undefined, unitResolver);
  if (units.size > 0) {
    const staticView = flattenGraphUnits(graph, path, unitResolver);
    debug.log('graph.unit', 'static-view', { graphId: graph.graphId, hash: graphVersionHash(staticView),
      nodeIds: staticView.nodes.map((node) => node.nodeId), edges: staticView.edges });
  }
  const unitEntryNode = options.unitContext?.entryNodeId ?? saved?.entryNodeId ?? graph.entryNode;
  if (saved?.entryNodeId !== undefined && options.unitContext?.entryNodeId !== undefined && saved.entryNodeId !== options.unitContext.entryNodeId) {
    throw new Error('unit entry changed on resume');
  }
  if ((options.unitContext || saved?.entryNodeId !== undefined) && !(graph.unit?.entries ?? [graph.entryNode]).includes(unitEntryNode)) {
    throw new Error(`unit entry mismatch: ${unitEntryNode}`);
  }
  const variantSource = variant?.ok ? stringifyYaml({ ...document,
    nodes: graph.nodes.map((node, index) => ({
      ...((document.nodes as Record<string, unknown>[])[index] ?? {}), node_id: node.nodeId, kind: node.kind,
      recipe: node.recipe, max_visits: node.maxVisits,
      ...(node.contract ? { contract: node.contract } : {}),
    })),
    edges: graph.edges.map((edge, index) => ({
      ...((document.edges as Record<string, unknown>[])[index] ?? {}), from: edge.from,
      ...(edge.to === undefined ? { on: edge.on, map: edge.map } : { to: edge.to }),
      ...(edge.fallback ? { fallback: edge.fallback } : {}),
    })),
  }) : source;
  const pluginRoot = elanousStateRoot();
  const graphFile = graphMode === 'snapshot' && !existsSync(path) ? resolve(path) : realpathSync(path);
  const installed = listInstalledPlugins(pluginRoot);
  const owner = installed.find(item => {
    const graphsDir = join(item.path, 'graphs');
    return existsSync(graphsDir) && graphFile.startsWith(`${realpathSync(graphsDir)}${sep}`);
  });
  const credentials = owner ? pluginEnv(owner.name, pluginRoot) : {};
  const redactCredentials = (text: string) => Object.values(credentials).filter(value => value.length > 0)
    .reduce((safe, value) => safe.replaceAll(value, '[REDACTED]'), text);
  const declaredEnv = [...new Set(installed.map(item => item.name))]
    .flatMap(name => credentialStatus(name, pluginRoot).fields.map(field => field.env));
  const credentialFields = owner ? credentialStatus(owner.name, pluginRoot).fields.filter(field => field.set).map(field => field.name) : [];
  for (const terminal of graph.terminalNodes) {
    // Units use their declared exits. The four loop graphs also declare named
    // top-level exits; all other graphs retain the done/failed contract.
    if (!(graph.unit ? graph.unit.exits.includes(terminal) : topLevelTerminalStatus(graph.graphId, terminal) !== undefined)) {
      throw new Error(`unsupported terminal node: ${terminal} (expected ${graph.unit ? graph.unit.exits.join(' or ') : 'done or failed'})`);
    }
  }
  const recipePath = graphMode === 'snapshot' ? join(snapshotDir!, 'recipes.yaml') : join(dirname(path), 'recipes.yaml');
  // A harness loop template without a command sidecar is planned, never executed, by this runner.
  const harnessLoopTemplate = !graph.unit && HARNESS_LOOP_GRAPH_IDS.has(graph.graphId) && graphMode === 'current' && !existsSync(recipePath);
  if (harnessLoopTemplate && (options.dryRun !== true || options.resumeRunId)) {
    debug.log('graph.run', 'harness-loop-refused', { graphId: graph.graphId, path: resolve(path), why: 'real-run' });
    throw new Error(`harness loop template ${graph.graphId} runs through the self-implement harness — graph run only plans it with --dry-run`);
  }
  const harnessLoopRoute = harnessLoopTemplate ? planHarnessLoopRoute(graph, (nodeId) => units.get(nodeId)?.template.unit?.exits[0]) : undefined;
  const recipeSource = harnessLoopTemplate ? '{}\n' : readFileSync(recipePath, 'utf8');
  if (graphMode === 'snapshot' && saved?.graphSnapshot &&
    (createHash('sha256').update(source).digest('hex') !== saved.graphSnapshot.graphSha ||
      createHash('sha256').update(recipeSource).digest('hex') !== saved.graphSnapshot.recipesSha)) {
    throw new Error('graph snapshot changed since run started');
  }
  const recipes = recipesFor(path, recipeSource);
  const catalogRoles = new Set(loadNodeCatalog().roles.keys());
  // Bind a human decision to the exact graph and recipe contents, not just its id or approval prompt.
  const approvalSourceHash = createHash('sha256').update(variantSource).update('\0').update(recipeSource).digest('hex');
  // Resolve all commands before executing any node; an unknown recipe must never produce a partial publication.
  for (const node of graph.nodes) {
    if (node.kind === 'classify' && node.recipe !== 'none') throw new Error(`classify node cannot execute a recipe: ${node.nodeId}`);
    if (node.recipe === 'none') continue;
    const resolved = resolveNodeRecipe(node, recipes, catalogRoles);
    // Harness loop recipes are labels the self-implement harness dispatches by node id (most are outside the
    // node catalog — graph-catalog.test.ts); a planned loop never executes them, and a real run is refused above.
    if (harnessLoopRoute) continue;
    if (!resolved.command && !resolved.prompt && !resolved.approval) throw new Error(`unknown command recipe for ${node.nodeId}: ${node.recipe}`);
  }
  if (harnessLoopRoute) {
    if (!harnessLoopRoute.has(graph.entryNode)) throw new Error(`harness loop ${graph.graphId} has no declared route from ${graph.entryNode} to a success terminal`);
    const planned: string[] = [graph.entryNode];
    for (let at = harnessLoopRoute.get(graph.entryNode); at; at = harnessLoopRoute.get(at.to)) planned.push(at.to);
    debug.log('graph.run', 'harness-loop-plan', { graphId: graph.graphId, path: resolve(path), route: planned });
  }
  const graphId = safeSegment(graph.graphId);
  const isReleaseLoop = graphId === 'release-loop';
  // A copied or saved release graph is still a release graph. Its path cannot grant or revoke
  // permission to dispatch a command; only the graph identity and this independent table can.
  const enforceReleaseCommandBindings = isReleaseLoop;
  if (enforceReleaseCommandBindings) {
    for (const node of graph.nodes) assertReleaseCommandBinding(node,
      resolveNodeRecipe(node, recipes, catalogRoles).command?.command, graph.terminalNodes.includes(node.nodeId));
  }
  if (saved && graphId !== saved.graphId) {
    if (options.fromNodeId && graphMode === 'current') throw new Error('graph or recipes changed since failed run');
    throw new Error(`run identity mismatch: ${saved.graphId}/${saved.runId}`);
  }
  const runId = safeSegment(options.resumeRunId ?? options.runId ?? randomUUID());
  const statePath = graphRunPath(graphId, runId, root);
  // A resume owns the run from the first state read through its last write and command.
  // Fail closed on a concurrent (or interrupted) owner rather than replaying a command.
  const resumeLock = `${statePath}.resume.lock`;
  if (options.resumeRunId) {
    mkdirSync(dirname(statePath), { recursive: true });
    try { mkdirSync(resumeLock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`run is already being resumed: ${graphId}/${runId}`);
      throw error;
    }
  }
  try {
  const startMs = (options.deps?.processStartMs ?? psProcessStartMs)(process.pid);
  const runnerOwner = { pid: process.pid, pidStartedAt: new Date(startMs ?? Date.now() - process.uptime() * 1_000).toISOString() };
  const state: GraphRunState = options.resumeRunId
    ? readGraphRun(graphId, runId, root)
    : { graphId, runId, startedAt: new Date().toISOString(), ...runnerOwner, status: 'running', path: [], nodes: [], sourceHash: approvalSourceHash,
      graphSnapshot: { graphSha: createHash('sha256').update(variantSource).digest('hex'), recipesSha: createHash('sha256').update(recipeSource).digest('hex') },
      graphPath: resolve(path), ...(variant?.ok ? { variant: { overlayId: variant.overlay.overlayId, ...options.variant! } } : {}),
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.unitContext?.entryNodeId === undefined ? {} : { entryNodeId: options.unitContext.entryNodeId }),
      executed: 0, dryRun: options.dryRun === true, statePath };
  const verifyReleaseSource = (): string | undefined => {
    const source = options.releaseCommandSource;
    if (!source) return undefined;
    const savedCutTip = lastJsonObject(state.nodes.find((node) => node.nodeId === 'version-release')?.output)?.commit;
    if (graphId !== 'release-loop' || !options.resumeRunId || typeof savedCutTip !== 'string' || source.cutTip !== savedCutTip) {
      throw new Error('release command source differs from the saved cut tip');
    }
    const commandRoot = verifyReleaseCommandRoot(source.root, savedCutTip, source.git);
    // The ledger snapshot must be the recipe that the cut checkout actually carries.
    // HEAD alone does not bind a saved graph to that checkout.
    verifyReleaseRecipeSnapshot(commandRoot, state.graphSnapshot);
    return commandRoot;
  };
  verifyReleaseSource();
  if (options.resumeRunId && graphMode === 'snapshot' && state.sourceHash && state.sourceHash !== approvalSourceHash) {
    throw new Error('graph snapshot changed since run started');
  }
  if (options.resumeRunId && options.dryRun !== undefined && options.dryRun !== state.dryRun) throw new Error('cannot change dryRun when resuming');
  if (options.resumeRunId && state.growth?.length && graphMode === 'current' && state.sourceHash !== approvalSourceHash) {
    throw new Error('graph or recipes changed since grown run');
  }
  if (options.unitContext) {
    if (state.parentRunId !== undefined && state.parentRunId !== options.unitContext.parentRunId) throw new Error('unit parent run changed');
    state.parentRunId = options.unitContext.parentRunId;
  }
  if (state.growth?.length) graph = withGrowth(graph, state.growth);
  let waivedRecord: GraphRunState['nodes'][number] | undefined;
  if (options.fromNodeId) {
    if (state.status !== 'failed' || state.pending || state.dryRun) throw new Error('--from requires a failed, non-dry run without pending approval');
    if (graphMode === 'current' && (!state.sourceHash || state.sourceHash !== approvalSourceHash)) throw new Error('graph or recipes changed since failed run');
    const from = state.path.indexOf(options.fromNodeId);
    if (from < 0 || state.path.lastIndexOf(options.fromNodeId) !== from || graph.terminalNodes.includes(options.fromNodeId)) throw new Error(`--from node is not unique on the saved executable path: ${options.fromNodeId}`);
    if (state.path.length !== state.nodes.length || state.nodes.some((record, i) => record.nodeId !== state.path[i]) ||
      state.executed !== state.nodes.filter((record) => record.executed).length) {
      throw new Error('saved run path and node records do not match');
    }
    for (let i = 0; i < state.path.length; i++) {
      const recorded = state.nodes[i]!;
      const spec = graph.nodes.find((node) => node.nodeId === recorded.nodeId);
      if (!spec) throw new Error(`saved path has undeclared node: ${recorded.nodeId}`);
      if (i > 0) {
        const prior = state.nodes[i - 1]!;
        const reported = lastJsonObject(prior.output)?.outcome;
        const next = nextNode(graph.edges, prior.nodeId, prior.ok ? 'ok' : 'fail', typeof reported === 'string' ? reported : undefined);
        if (next !== recorded.nodeId) throw new Error('saved run path does not follow graph edges');
      } else if (recorded.nodeId !== unitEntryNode) throw new Error('saved run path does not start at entry node');
      if (i < from && !recorded.ok) {
        // A warning-only node explicitly sends every outcome to the same next
        // node. Its truthful failed record is safe to preserve when retrying a
        // later release step; a branching failure is still a hard stop.
        const edge = graph.edges.find((candidate) => candidate.from === recorded.nodeId);
        const next = state.path[i + 1];
        if (edge?.on !== 'outcome' || !next || !(['ok', 'fail', 'error'] as const).every((outcome) => edge.map?.[outcome] === next)) {
          throw new Error('cannot preserve a failed predecessor when resuming');
        }
      }
      const approved = resolveNodeRecipe(spec, recipes, catalogRoles).approval;
      if (approved && i >= from) throw new Error('cannot restart across an approval decision');
      if (approved && i < from) {
        // A JSON state alone is not evidence of approval: require the immutable decision claim for this visit.
        const decisionFile = `${statePath}.${i + 1}.decision.json`;
        let decision: { nodeId?: string; decision?: string; decidedAt?: string };
        try { decision = JSON.parse(readFileSync(decisionFile, 'utf8')); }
        catch { throw new Error(`missing approval decision for ${recorded.nodeId}`); }
        if (decision.nodeId !== recorded.nodeId || decision.decision !== 'approved' || decision.decidedAt !== recorded.decidedAt || !recorded.ok) {
          throw new Error(`invalid approval decision for ${recorded.nodeId}`);
        }
      }
    }
    if (resolveNodeRecipe(graph.nodes.find((node) => node.nodeId === options.fromNodeId)!, recipes, catalogRoles).approval) {
      throw new Error('--from cannot restart an approval node');
    }
    if (options.releaseWaiver) {
      if (graphId !== 'release-loop') throw new Error('release waiver requires the release-loop graph');
      const checked = releaseResumeWaiver(state, { from: options.fromNodeId, waive: options.releaseWaiver.nodeId, reason: options.releaseWaiver.reason, acceptedRegressions: options.releaseWaiver.requestedRegressions });
      if (!checked || JSON.stringify(checked.acceptedRegressions) !== JSON.stringify(options.releaseWaiver.acceptedRegressions) ||
        checked.unmeasured !== options.releaseWaiver.unmeasured) throw new Error('release waiver input changed before restart');
      const route = new Set<string>();
      let cursor: string | undefined = nextNode(graph.edges, options.fromNodeId, 'ok', 'ok');
      while (cursor && !route.has(cursor) && cursor !== 'known-issues') {
        route.add(cursor);
        cursor = nextNode(graph.edges, cursor, 'ok', 'ok');
      }
      if (cursor !== 'known-issues' || route.has('publish') || route.has('approve-publish')) throw new Error('waived node must reach known-issues before publication');
    }
    if (options.releaseAcceptedRegressions) {
      if (graphId !== 'release-loop') throw new Error('accepted regressions require the release-loop graph');
      const route = new Set<string>();
      let cursor: string | undefined = options.fromNodeId;
      while (cursor && !route.has(cursor) && cursor !== 'known-issues') {
        route.add(cursor);
        cursor = nextNode(graph.edges, cursor, 'ok', 'ok');
      }
      if (cursor !== 'known-issues' || route.has('publish') || route.has('approve-publish')) throw new Error('accepted regressions must reach known-issues before publication');
      const checked = releaseResumeAcceptedRegressions(state, options.releaseAcceptedRegressions.requested, options.fromNodeId);
      if (JSON.stringify(checked) !== JSON.stringify(options.releaseAcceptedRegressions.acceptedRegressions)) throw new Error('accepted regressions changed before restart');
      state.input = { ...(state.input as Record<string, unknown>), acceptedRegressions: checked };
    }
    if (options.releaseWaiver) {
      waivedRecord = state.nodes[from];
      state.input = { ...(state.input as Record<string, unknown>), acceptedRegressions: options.releaseWaiver.acceptedRegressions };
    } else if (graphId === 'release-loop' && state.nodes.slice(from).some((record) => record.waiver)) {
      // Restarting at or before a waived node drops its waiver record, so its accepted issue goes with it.
      state.input = { ...(state.input as Record<string, unknown>),
        acceptedRegressions: releaseResumeAcceptedRegressions(state, [], options.fromNodeId) };
    }
    if (options.releaseGateExecutor) {
      if (graphId !== 'release-loop') throw new Error('gate executor override requires the release-loop graph');
      const override = releaseResumeGateExecutor(state, { from: options.fromNodeId, executor: options.releaseGateExecutor.executor, host: options.releaseGateExecutor.host });
      const next: Record<string, unknown> = { ...(state.input as Record<string, unknown>), ...override.set };
      for (const key of override.unset ?? []) delete next[key];
      state.input = next;
      state.inputOverrides = [...(state.inputOverrides ?? []), override];
      debug.log('graph.runs', 'input-override', { graphId, runId, ...override });
    }
    if (options.releaseGatePodPool !== undefined) {
      if (graphId !== 'release-loop') throw new Error('gate pod pool override requires the release-loop graph');
      const override = releaseResumeGatePodPool(state, { from: options.fromNodeId, pool: options.releaseGatePodPool });
      state.input = { ...(state.input as Record<string, unknown>), ...override.set };
      state.inputOverrides = [...(state.inputOverrides ?? []), override];
      debug.log('graph.runs', 'input-override', { graphId, runId, ...override });
    }
    if (options.releaseGateShardReroute) {
      if (graphId !== 'release-loop') throw new Error('shard reroute requires the release-loop graph');
      const override = releaseResumeGateShardReroute(state, { from: options.fromNodeId, ...options.releaseGateShardReroute });
      state.input = { ...(state.input as Record<string, unknown>), ...override.set };
      state.inputOverrides = [...(state.inputOverrides ?? []), override];
      debug.log('graph.runs', 'input-override', { graphId, runId, ...override });
    }
    if (state.unitCalls) {
      const calls = state.unitCalls;
      state.unitCalls = calls.filter(call => {
        const keep = state.path.slice(0, from).filter(nodeId => nodeId === call.node).length;
        return calls.filter(item => item.node === call.node).indexOf(call) < keep;
      });
    }
    state.path = state.path.slice(0, from);
    state.nodes = state.nodes.slice(0, from);
    state.executed = state.nodes.filter((node) => node.executed).length;
    state.status = 'running';
    delete state.stoppedAt;
    Object.assign(state, runnerOwner);
    state.resume = { from: options.fromNodeId, at: new Date().toISOString(), previousStatus: 'failed', graph: graphMode };
    // Persist the restart boundary before executing it, so previous outputs remain durable.
    persistOwnedRun(state, saved!, true);
  }
  let resumedGrowth = false;
  if (options.resumeRunId && state.growthPark) {
    if (state.graphId !== graphId || state.runId !== runId || (graphMode === 'current' && state.sourceHash !== approvalSourceHash)) {
      throw new Error(`growth source changed since run was paused: ${graphId}/${runId}`);
    }
    const parked = state.growthPark;
    const decision = (options.deps?.growthDecision?.list?.({ status: 'all' }) ??
      new DecisionLedger({ stateDir: root }).list({ status: 'all' }))
      .find(entry => entry.id === parked.decisionId && entry.refs?.includes(parked.decisionRef));
    if (!decision || decision.status !== 'decided' || decision.decidedBy?.kind !== 'human' ||
        (decision.choice !== 'a' && decision.choice !== 'b')) {
      throw new Error(`growth is parked for human confirmation: ${graphId}/${runId}`);
    }
    if (typeof parked.decisionRef !== 'string' ||
        growthApprovalRef({ graphId, runId, from: parked.from, outcome: parked.outcome },
          parked.growth, parked.command, parked.approval) !== parked.decisionRef) {
      throw new Error(`growth approval target changed since card was raised: ${graphId}/${runId}`);
    }
    if (state.status !== 'awaiting-approval' || state.dryRun || state.path.at(-1) !== parked.from ||
        state.path.length !== state.nodes.length || state.nodes.at(-1)?.nodeId !== parked.from ||
        state.pending?.nodeId !== parked.from || state.growthRejections?.at(-1)?.from !== parked.from ||
        state.growthRejections.at(-1)?.outcome !== parked.outcome ||
        parked.growth.undo.removeOutcome.from !== parked.from || parked.growth.undo.removeOutcome.outcome !== parked.outcome) {
      throw new Error(`invalid parked growth: ${graphId}/${runId}`);
    }
    if (decision.choice === 'a') {
      const currentCommand = resolveNodeRecipe(parked.growth.node, recipes, catalogRoles).command;
      const currentApproval = resolveNodeRecipe(parked.growth.node, recipes, catalogRoles).approval?.approval;
      // The approved target is the (approval, command) pair as raised — a command appearing, vanishing or changing all fail.
      if (parked.growth.node.recipe !== 'none' &&
          (currentApproval !== parked.approval ||
            JSON.stringify(currentCommand ?? null) !== JSON.stringify(parked.command ?? null) ||
            (parked.approval === undefined && !parked.command))) {
        throw new Error(`growth command changed since approval: ${graphId}/${runId}`);
      }
      graph = withGrowth(graph, [parked.growth]);
      state.growth ??= [];
      state.growth.push(parked.growth);
      state.growthRejections!.pop();
    }
    resumedGrowth = true;
    delete state.pending;
    delete state.growthPark;
    state.status = 'running';
    persistOwnedRun(state, saved!);
  }
  if (options.resumeRunId && state.status === 'running' && state.pending) {
    throw new Error(`run is not awaiting approval: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && state.status === 'awaiting-approval' && !state.pending) {
    throw new Error(`run is not awaiting approval: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && state.status !== 'awaiting-approval' && state.status !== 'running') {
    throw new Error(`run is not awaiting approval: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && (state.graphId !== graphId || state.runId !== runId)) {
    throw new Error(`run is not awaiting approval: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && state.status === 'awaiting-approval' && state.approvalSourceHash !== approvalSourceHash) {
    throw new Error(`approval source changed since run was paused: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && !options.fromNodeId) {
    const previousStatus = state.status;
    Object.assign(state, runnerOwner);
    state.resume = { from: state.pending?.nodeId ?? state.path.at(-1) ?? unitEntryNode, at: new Date().toISOString(), previousStatus, graph: graphMode };
    persistOwnedRun(state, saved!);
  }
  if (options.resumeRunId) debug.log('graph.runs', 'resume', { graphId, runId, from: state.resume?.from, graph: graphMode });
  const persist = () => {
    if (state.status === 'done' || state.status === 'failed' || state.status === 'budget-exceeded') state.finishedAt ??= new Date().toISOString();
    persistOwnedRun(state, runnerOwner);
  };
  const baseLog = options.deps?.log ?? ((event: string, data: Record<string, unknown>) => debug.log('graph.runner', event, data));
  // RFC §U: every event of a unit (child) run carries its parentRunId.
  const log = options.unitContext
    ? (event: string, data: Record<string, unknown>) => baseLog(event, { ...data, parentRunId: options.unitContext!.parentRunId })
    : baseLog;
  const visits = new Map<string, number>();
  for (const nodeId of state.path) visits.set(nodeId, (visits.get(nodeId) ?? 0) + 1);
  let current: string | undefined = options.fromNodeId ?? state.pending?.nodeId ?? state.path.at(-1) ?? unitEntryNode;
  if (!options.resumeRunId) {
    mkdirSync(dirname(statePath), { recursive: true });
    if (readdirSync(dirname(statePath)).some((file) => file.startsWith(`${runId}.json.`) && file.endsWith('.decision.json'))) {
      throw new Error(`run id already exists: ${graphId}/${runId}`);
    }
    try { writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`run id already exists: ${graphId}/${runId}`);
      throw error;
    }
    mkdirSync(`${statePath}.graph`);
    writeFileSync(join(`${statePath}.graph`, 'graph.yaml'), variantSource, { flag: 'wx' });
    writeFileSync(join(`${statePath}.graph`, 'recipes.yaml'), recipeSource, { flag: 'wx' });
  }
  while (current !== undefined) {
    options.deps?.beforeNode?.();
    const node = graph.nodes.find((n) => n.nodeId === current);
    if (!node) throw new Error(`undeclared node: ${current}`);
    const resumingPending = state.pending?.nodeId === current;
    const completed = state.nodes.at(-1);
    const resumingCompleted = options.resumeRunId !== undefined && !options.fromNodeId && completed?.nodeId === current &&
      state.path.at(-1) === current && !resumingPending;
    const usedSteps = state.path.length + (state.unitCalls ?? []).reduce((sum, call) => sum + call.steps, 0);
    if (!resumingPending && !resumingCompleted && ((visits.get(current) ?? 0) >= node.maxVisits ||
        (options.unitContext && usedSteps >= options.unitContext.remainingSteps))) {
      state.status = 'budget-exceeded';
      log('budget-exceeded', { graphId, runId, nodeId: current });
      persist();
      break;
    }
    if (!resumingPending && !resumingCompleted) {
      visits.set(current, (visits.get(current) ?? 0) + 1);
      state.path.push(current);
    }
    const resolved = resolveNodeRecipe(node, recipes, catalogRoles);
    const command = resolved.command;
    if (enforceReleaseCommandBindings) assertReleaseCommandBinding(node, command?.command, graph.terminalNodes.includes(current));
    const prompt = resolved.prompt;
    const approval = resolved.approval ? { approval: approvalMessage(resolved.approval.approval, state.input) } : undefined;
    if (resumingPending && (!approval || approval.approval !== state.pending?.message)) {
      throw new Error(`pending approval no longer matches graph: ${current}`);
    }
    // Graphs may opt into previewing the approval boundary in dry runs.
    if (approval && (!state.dryRun || document.dry_run_await_approval === true) && !state.pending?.decision) {
      if (!state.pending) {
        state.pending = { nodeId: current, message: approval.approval, since: new Date().toISOString() };
        state.approvalSourceHash = approvalSourceHash;
      }
      state.status = 'awaiting-approval';
      if (!state.dryRun && !state.pending.notifiedAt) {
        try {
          log('approval-pending', { graphId, runId, nodeId: current, message: state.pending.message, since: state.pending.since });
          state.pending = { ...state.pending, notifiedAt: new Date().toISOString() };
        } catch (error) {
          persist();
          throw error;
        }
      }
      persist();
      break;
    }
    state.status = 'running';
    const startedAt = performance.now();
    const nodeStartedAt = new Date().toISOString();
    if (!resumingCompleted) state.currentNode = { nodeId: current, startedAt: nodeStartedAt };
    if (!options.quiet) console.error(`[graph] ${current} start (0.00s)`);
    debug.log('graph.run', 'node', { graphId, runId, nodeId: current, phase: 'start', dryRun: state.dryRun });
    publishInsideEvent({ kind: 'node', graphId, runId, nodeId: current, phase: 'start' });
    log('node-start', { graphId, runId, nodeId: current, visit: visits.get(current), dryRun: state.dryRun });
    persist();
    let ok = approval && !state.dryRun ? state.pending?.decision === 'approved' : true;
    let exit: number | null = null;
    let error: string | undefined;
    let commandFailureReason: string | undefined;
    let output: unknown;
    const waiving = options.releaseWaiver?.nodeId === current && waivedRecord !== undefined;
    if (command && !waiving && (!approval || state.dryRun || ok) && (!state.dryRun || command.dry_run_command) && !resumingCompleted) {
      const outputs: Record<string, unknown> = Object.create(null);
      // 구조 산출(마지막 JSON 줄)이 있으면 그것을, 없으면 원문을 준다 — 다음 노드가 판단을 «값»으로 받는다.
      for (const previous of state.nodes) outputs[previous.nodeId] = lastJsonObject(previous.output) ?? previous.output ?? null;
      const contextPath = join(`${statePath}.contexts`, `${state.path.length}.json`);
      mkdirSync(dirname(contextPath), { recursive: true });
      writeFileSync(contextPath, JSON.stringify({ graphId, runId, startedAt: state.startedAt, nodeId: current, input: state.input ?? null, outputs }, null, 2) + '\n');
      let code: number | null = null;
      const runBash: BashRun = async (body, opts) => {
        const commandRoot = verifyReleaseSource();
        // Hash the actual /bin/bash argv after interpolation. Keep the command text (which may contain
        // credentials) out of logs, but leave enough to distinguish a replayed publish from npm/docs.
        const argvSha256 = createHash('sha256').update(JSON.stringify(['/bin/bash', '-c', body])).digest('hex');
        const fingerprint = { graphId, runId, nodeId: current!, recipe: node.recipe, argvSha256 };
        debug.log('graph.run', 'command-dispatch', { ...fingerprint, pid: null });
        const execute = options.deps?.runBash ?? realRunBash((pid) => {
          debug.log('graph.run', 'command-spawn', { ...fingerprint, pid });
          // Publish the child before its start time is known, so a concurrent stop refuses instead of failing
          // the ledger while an untracked node keeps working (REL8b review round 3).
          state.activeNode = { nodeId: current!, pid, pidStartedAt: UNVERIFIED_NODE_START };
          persist();
          const started = (options.deps?.processStartMs ?? psProcessStartMs)(pid);
          if (started === null) return false;
          state.activeNode = { nodeId: current!, pid, pidStartedAt: new Date(started).toISOString() };
          persist();
          return true;
        });
        try {
          const result = await execute(body, commandRoot ? { ...opts, cwd: commandRoot } : opts);
          code = result.exitCode;
          const stderr = redactCredentials(result.stderr);
          commandFailureReason = failedCommandStderrTail(result.exitCode, stderr);
          return { ...result, stdout: redactCredentials(result.stdout), stderr };
        } finally {
          if (state.activeNode?.nodeId === current) {
            delete state.activeNode;
            persist();
          }
        }
      };
      if (owner) debug.log('plugin.credentials', 'injected', { plugin: owner.name, fields: credentialFields, count: credentialFields.length });
      const env = { ...process.env };
      for (const key of declaredEnv) delete env[key];
      Object.assign(env, credentials);
      // An explicit --config-dir is process-local. Pin its effective root via the
      // state stamp so a cmd: child resolves its default config in the same universe.
      // The ignored config-dir environment variable must not appear to propagate the flag.
      delete env.ELANOUS_CONFIG_DIR;
      if (options.pinChildUniverse) {
        // The run's own ledger root is the parent universe — the child writes where the run is recorded.
        env.ELANOUS_STATE_DIR = root;
        debug.log('graph-runner', 'child-universe-pinned', { graphId, runId, node: current, configDir: getElanousConfigDirOverride() ?? null, stateDir: env.ELANOUS_STATE_DIR, why: 'pinChildUniverse' });
      } else if (getElanousConfigDirOverride()) {
        env.ELANOUS_STATE_DIR = effectiveInstanceRoot();
        debug.log('graph-runner', 'child-universe-pinned', { graphId, runId, node: current, configDir: getElanousConfigDirOverride(), stateDir: env.ELANOUS_STATE_DIR });
      }
      env.ELANOUS_GRAPH_CONTEXT = contextPath;
      env.ELANOUS_GRAPH_DRY_RUN = state.dryRun ? '1' : '0';
      env.ELANOUS_GRAPH_DIR = dirname(resolve(path));
      const ctx = { arguments: '', artifactsDir: dirname(statePath), outputs: {}, resolvedProvider: undefined, resolvedModel: undefined, toolPolicy: {}, env } as NodeExecContext;
      const result = await executeBashNode({ id: current, type: 'bash', bash: state.dryRun ? command.dry_run_command! : command.command,
        idle_timeout: command.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS } as BashNode, ctx, { runBash } as WorkflowDeps);
      output = result.output;
      ok = result.ok;
      exit = code;
      error = result.error ? redactCredentials(result.error) : undefined;
      state.executed++;
    }
    let unitExecuted = false;
    const plannedStep: PlannedStep | undefined = harnessLoopRoute?.get(current);
    if (harnessLoopRoute && !graph.terminalNodes.includes(current)) {
      if (!plannedStep) throw new Error(`harness loop ${graphId} has no declared success route from ${current}`);
      // The planned outcome stands in for the harness node (or unit) that a real loop run would execute.
      output = JSON.stringify({ outcome: plannedStep.outcome ?? 'ok', dryRun: true, plannedNext: plannedStep.to });
    } else if (units.has(current) && !waiving && state.dryRun && !resumingCompleted) {
      // Dry run plans the walk only: no child run, no unit event, no unitCalls entry; the first declared exit stands in.
      output = JSON.stringify({ outcome: units.get(current)!.template.unit!.exits[0], dryRun: true });
    } else if (units.has(current) && !waiving && !resumingCompleted) {
      const unit = units.get(current)!;
      const contract = node.contract!;
      const previous: Record<string, unknown> = Object.create(null);
      for (const record of state.nodes) previous[record.nodeId] = lastJsonObject(record.output) ?? record.output;
      const supplied = state.input && typeof state.input === 'object' && !Array.isArray(state.input)
        ? state.input as Record<string, unknown> : {};
      const lastPrior = state.nodes.at(-1);
      const lastPriorOutput = lastPrior ? previous[lastPrior.nodeId] : undefined;
      const priorResult = lastPriorOutput && typeof lastPriorOutput === 'object' && !Array.isArray(lastPriorOutput)
        ? (lastPriorOutput as Record<string, unknown>).result : undefined;
      const inputs: Record<string, unknown> = Object.create(null);
      for (const key of contract.inputs) {
        const value = Object.hasOwn(supplied, key) ? supplied[key] : key === 'prior' ? priorResult : previous[key];
        if (value !== undefined) inputs[key] = value;
      }
      const alreadySpent = state.path.length + (state.unitCalls ?? []).reduce((sum, call) => sum + call.steps, 0);
      const remaining = options.unitContext ? options.unitContext.remainingSteps - alreadySpent : Infinity;
      const childRunId = randomUUID();
      const selectedEntry = node.callEntry ?? unit.template.entryNode;
      const recordEntry = node.callEntry !== undefined || unit.template.unit?.entries !== undefined;
      const info = { graphId, runId, nodeId: current, unit: unit.template.graphId, childRunId, parentRunId: runId,
        ...(recordEntry ? { entry: selectedEntry } : {}) };
      let entered = false;
      try {
        for (const key of contract.inputs) if (!Object.hasOwn(inputs, key)) throw new Error(`unit input missing: ${current}.${key}`);
        if (createHash('sha256').update(readFileSync(unit.path, 'utf8')).digest('hex') !== unit.hash)
          throw new Error(`unit source changed before call: ${current}`);
        debug.log('graph.unit', 'enter', info);
        log('graph.unit', { ...info, phase: 'enter' });
        entered = true;
        const child = await runGraph(unit.path, { runId: childRunId, input: inputs, dryRun: false,
          pinChildUniverse: options.pinChildUniverse,
          unitContext: { parentRunId: runId, ancestors: [...(options.unitContext?.ancestors ?? []), graphId],
            remainingSteps: Math.min(node.budget!.innerSteps, remaining),
            ...(recordEntry ? { entryNodeId: selectedEntry } : {}) }, deps: options.deps });
        const steps = child.path.length + (child.unitCalls ?? []).reduce((sum, call) => sum + call.steps, 0);
        const childExit = child.status === 'done' || child.status === 'failed' ? child.path.at(-1) : undefined;
        // The last successful record carrying every contracted output is the source;
        // intervening nodes (including terminal gates) need not reproduce those fields.
        const values = child.nodes.reduce<Record<string, unknown> | undefined>((found, record) => {
          if (!record.ok || !record.executed) return found;
          const value = lastJsonObject(record.output) ??
            (record.output && typeof record.output === 'object' && !Array.isArray(record.output)
              ? record.output as Record<string, unknown> : undefined);
          return value && contract.outputs.every(key => Object.hasOwn(value, key)) ? value : found;
        }, undefined) ?? {};
        state.unitCalls ??= [];
        state.unitCalls.push({ node: current, unit: unit.template.graphId, version: unit.template.version,
          hash: unit.hash, childRunId, exit: childExit ?? child.status, steps,
          ...(recordEntry ? { entry: selectedEntry } : {}) });
        if (child.status === 'awaiting-approval') throw new Error(`unit cannot pause for approval: ${current}`);
        if (child.status === 'budget-exceeded' || steps > node.budget!.innerSteps || steps > remaining) {
          debug.log('graph.unit', 'budget-exhausted', { ...info, steps, innerSteps: node.budget!.innerSteps });
          log('graph.unit', { ...info, phase: 'budget-exhausted', steps });
          throw new Error(`unit inner_steps exceeded: ${current}`);
        }
        if (!childExit || !unit.template.unit!.exits.includes(childExit)) throw new Error(`unit exit missing: ${current}`);
        if (child.status === 'done' && childExit === 'failed') throw new Error(`unit exit mismatch: ${current}`);
        const result: Record<string, unknown> = { outcome: childExit };
        for (const key of contract.outputs) {
          if (!Object.hasOwn(values, key)) throw new Error(`unit output missing: ${current}.${key}`);
          result[key] = values[key];
        }
        output = JSON.stringify(result);
        ok = child.status === 'done';
        debug.log('graph.unit', 'exit', { ...info, exit: childExit, steps });
        log('graph.unit', { ...info, phase: 'exit', exit: childExit, steps });
      } catch (cause) {
        ok = false;
        error = redactCredentials(cause instanceof Error ? cause.message : String(cause));
        if (entered) {
          debug.log('graph.unit', 'exit', { ...info, error });
          log('graph.unit', { ...info, phase: 'exit', error });
        }
      }
      // A rejected invocation has no child ledger and did not execute a unit.
      unitExecuted = existsSync(graphRunPath(unit.template.graphId, childRunId, root));
      if (unitExecuted) state.executed++;
    }
    if (prompt && !waiving && !state.dryRun && !resumingCompleted) {
      const outputs: Record<string, { ok: boolean; output: unknown; durationMs: number }> = Object.create(null);
      for (const previous of state.nodes) outputs[previous.nodeId] = { ok: previous.ok, output: lastJsonObject(previous.output) ?? previous.output ?? null, durationMs: 0 };
      try {
        const text = interpolate(prompt.prompt, {
          arguments: typeof state.input === 'string' ? state.input : state.input === undefined ? '' : JSON.stringify(state.input),
          artifactsDir: dirname(statePath), outputs,
        });
        if (text.missing.length) throw new Error(`missing prompt reference: ${text.missing.join(', ')}`);
        // The LLM is injected only; production wiring to a provider is a follow-up slice.
        if (!options.deps?.callLLM) throw new Error('prompt node requires an injected LLM (deps.callLLM)');
        output = await options.deps.callLLM(text.text);
        ok = true;
      } catch (cause) {
        ok = false;
        error = cause instanceof Error ? cause.message : String(cause);
      }
      state.executed++;
    }
    if (node.kind === 'classify' && !waiving && !state.dryRun && !resumingCompleted) {
      const input = state.input as GraphClassifyInput | undefined;
      const classify = input?.classify;
      if (!input || typeof input.arguments !== 'string' || !classify || typeof classify.input !== 'string' ||
          !Array.isArray(classify.classes) || !classify.classes.length || !classify.classes.every(c => typeof c === 'string' && c.length > 0) ||
          (classify.retries !== undefined && (!Number.isSafeInteger(classify.retries) || classify.retries < 0)) ||
          (classify.retryDelayMs !== undefined && (!Number.isSafeInteger(classify.retryDelayMs) || classify.retryDelayMs < 0))) {
        throw new Error('classify node requires input.arguments and a valid input.classify');
      }
      try {
        const result = await executeClassifyNode({ id: current, classify }, {
          arguments: input.arguments, artifactsDir: dirname(statePath), outputs: {},
          resolvedProvider: undefined, resolvedModel: undefined, toolPolicy: {},
        }, { callLLM: async ({ prompt }) => {
          if (!options.deps?.callLLM) throw new Error('classify node requires an injected LLM (deps.callLLM)');
          return options.deps.callLLM(prompt);
        }, runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) });
        output = JSON.stringify({ input: input.arguments, ok: result.ok, verdict: result.output, output: result.output,
          durationMs: result.durationMs, ...(result.error ? { error: result.error } : {}) });
        ok = result.ok;
        error = result.error;
      } catch (cause) {
        ok = false;
        error = cause instanceof Error ? cause.message : String(cause);
        output = JSON.stringify({ input: input.arguments, ok, verdict: 'unknown', output: 'unknown', durationMs: 0, error });
      }
      const recorded = lastJsonObject(output);
      debug.log('graph.classify', 'node-result', { graphId, runId, nodeId: current, caller: input.caller ?? null,
        input: input.arguments, inputChars: input.arguments.length, classes: classify.classes,
        verdict: recorded?.verdict ?? 'unknown', output: recorded?.output ?? 'unknown', ok,
        ...(error ? { error } : {}) });
      state.executed++;
    }
    const seconds = Number(((performance.now() - startedAt) / 1000).toFixed(2));
    // A wall clock stepped back mid-node must not record an end before the start.
    const nodeEndedAt = new Date(Math.max(Date.now(), Date.parse(nodeStartedAt))).toISOString();
    delete state.currentNode;
    if (waiving) {
      output = JSON.stringify({ outcome: 'ok', verdict: 'waived', summary: `waived ${current}`, reason: options.releaseWaiver!.reason });
      ok = true;
      exit = 0;
    }
    if (resumingCompleted && completed) {
      ok = completed.ok;
      exit = completed.exit;
      output = completed.output;
      error = completed.error;
      commandFailureReason = completed.reason;
    } else {
      // 승인 노드도 결과를 «값»으로 남긴다 — 뒤 노드가 문맥(outputs)에서 승인 여부를 확인할 수 있게(발행 노드가 승인 없이 돌지 않도록).
      if (approval && !state.dryRun && !command) {
        output = JSON.stringify({ outcome: ok ? 'approved' : 'rejected', graphId, runId, nodeId: current,
          ...(state.pending?.decidedBy === undefined ? {} : { decidedBy: state.pending.decidedBy }), decidedAt: state.pending?.decidedAt ?? null });
      }
      const failureMessage = !ok
        ? redactCredentials(commandFailureReason ?? error ?? `Node ${current} failed without a diagnostic.`)
        : undefined;
      const failure = failureMessage === undefined ? undefined : {
        errorCode: error?.startsWith('unit input missing:') ? 'GRAPH_UNIT_INPUT_MISSING' : 'GRAPH_NODE_FAILED',
        message: failureMessage,
        stage: units.has(current) ? 'unit-invocation' : command ? 'command-execution' : prompt ? 'prompt-execution' : 'node-execution',
      };
      state.nodes.push({ nodeId: current, ok, exit, executed: !waiving && ((!!command && (!state.dryRun || !!command.dry_run_command)) || (!!prompt && !state.dryRun) || (node.kind === 'classify' && !state.dryRun) || unitExecuted), ...((waiving || harnessLoopRoute || units.has(current) || ((command || prompt || approval || node.kind === 'classify') && (!state.dryRun || !!command?.dry_run_command))) && output !== undefined ? { output } : {}), ...(error ? { error } : {}),
        ...(failure ? { reason: failure.message, failure } : {}), ...(commandFailureReason && !failure ? { reason: commandFailureReason } : {}),
        ...(waiving ? { waiver: { reason: options.releaseWaiver!.reason, at: nodeEndedAt, ...(options.releaseWaiver!.unmeasured === undefined ? {} : { unmeasured: options.releaseWaiver!.unmeasured }), original: { exit: waivedRecord!.exit, ...(waivedRecord!.output === undefined ? {} : { output: waivedRecord!.output }), ...(waivedRecord!.error === undefined ? {} : { error: waivedRecord!.error }) } } } : {}),
        ...(approval && state.pending ? { ...(state.pending.decidedBy === undefined ? {} : { decidedBy: state.pending.decidedBy }), decidedAt: state.pending.decidedAt } : {}),
        startedAt: nodeStartedAt, endedAt: nodeEndedAt, seconds });
    }
    if (isReleaseLoop && graph.terminalNodes.includes(current) && node.recipe === 'none' &&
      (exit !== null || output !== undefined || error !== undefined || state.nodes.at(-1)?.executed)) {
      throw new Error(`release terminal received command output: ${current}`);
    }
    if (approval) {
      delete state.pending;
      delete state.approvalSourceHash;
    }
    const reported: unknown = waiving || harnessLoopRoute || units.has(current) || (prompt && !state.dryRun) || (command && (!state.dryRun || command.dry_run_command)) ? lastJsonObject(resumingCompleted ? completed?.output : output)?.outcome : undefined;
    const namedOutcome: string | undefined = typeof reported === 'string' ? reported : undefined;
    if (!options.quiet) console.error(`[graph] ${current} ${ok ? 'ok' : 'fail'} (${seconds.toFixed(2)}s)`);
    const nodeFailure = state.nodes.at(-1)?.nodeId === current ? state.nodes.at(-1)?.failure : undefined;
    const nodeReason = state.nodes.at(-1)?.nodeId === current ? state.nodes.at(-1)?.reason : undefined;
    debug.log('graph.run', 'node', { graphId, runId, nodeId: current, phase: ok ? 'ok' : 'fail', seconds, exit,
      ...(nodeReason ? { reason: nodeReason } : {}), ...(nodeFailure ? { failure: nodeFailure } : {}) });
    publishInsideEvent({ kind: 'node', graphId, runId, nodeId: current, phase: ok ? 'ok' : 'fail', seconds });
    publishInsideEvent({ kind: 'verdict', graphId, runId, nodeId: current, verdict: ok ? 'ok' : 'fail', ...(namedOutcome === undefined ? {} : { outcome: namedOutcome }) });
    log('node-end', { graphId, runId, nodeId: current, ok, exit,
      ...(nodeReason ? { reason: nodeReason } : {}), ...(nodeFailure ? { failure: nodeFailure } : {}),
      ...(namedOutcome === undefined ? {} : { outcome: namedOutcome }), dryRun: state.dryRun });
    if (!resumingCompleted) {
      // Recipe commands expose stdout/exit but no provider usage; never infer zero from success.
      observeModelInputTokens({ scope: 'harness-node', nodeKind: node.kind, runId, nodeId: current });
    }
    persist();
    if (graph.terminalNodes.includes(current)) {
      state.status = !ok ? 'failed' : graph.unit ? (current === 'failed' ? 'failed' : 'done')
        : topLevelTerminalStatus(graph.graphId, current)!;
      if (!graph.unit && current !== 'done' && current !== 'failed') state.reason = current;
      else delete state.reason;
      persist();
      if (state.status === 'failed' && !state.dryRun && graphId === 'release-loop') {
        recordReleaseRunFailure(state, root, `Graph ${graphId}/${runId} failed at ${current}`);
      }
      break;
    }
    const fromNodeId = current;
    const edge = graph.edges.find((candidate) => candidate.from === current);
    if (!resumedGrowth && document.grow === 'on' && !state.dryRun && namedOutcome !== undefined &&
        edge?.on === 'outcome' && edge.map && !Object.hasOwn(edge.map, namedOutcome) &&
        !state.growth?.some((item) => item.undo.removeOutcome.from === current && item.undo.removeOutcome.outcome === namedOutcome) &&
        !state.growthRejections?.some((item) => item.from === current && item.outcome === namedOutcome)) {
      const result = (state.growth?.length ?? 0) >= 3 ? { ok: false as const, reason: 'growth limit 3 reached' }
        : await proposeGrowth({ graph, nodeId: current, outcome: namedOutcome, runId, output: state.nodes.at(-1)?.output },
          options.deps?.growthProposer ?? createLLMGrowthProposer(options.deps?.growthLLM), (candidate) => {
            const resolved = resolveNodeRecipe(candidate, recipes, catalogRoles);
            if (!resolved.command && !resolved.approval && candidate.recipe !== 'none') return 'unknown';
            return { effect: resolved.approval ? 'unknown' : options.deps?.classifyGrowthRecipe?.(candidate, { command: resolved.command?.command }) ?? 'unknown',
              command: resolved.command, approval: resolved.approval?.approval };
          }, { ...options.deps?.growthDecision, root }, options.researchEdgeDecisionRegistry);
      if (result.ok) {
        graph = result.graph;
        state.growth ??= [];
        state.growth.push(result.growth);
        persist();
        log('edge-added', { graphId, runId, from: current, outcome: namedOutcome, to: result.growth.node.nodeId });
        debug.log('graph.run', 'edge-added', { graphId, runId, from: current, outcome: namedOutcome, to: result.growth.node.nodeId });
        publishInsideEvent({ kind: 'edge-added', graphId, runId, from: current, outcome: namedOutcome, to: result.growth.node.nodeId });
      } else {
        state.growthRejections ??= [];
        state.growthRejections.push({ from: current, outcome: namedOutcome, reason: result.reason });
        if (result.park && result.growth && result.decisionId && result.decisionRef) {
          state.status = 'awaiting-approval';
          state.pending = { nodeId: current, message: result.reason, since: new Date().toISOString() };
          state.growthPark = { from: current, outcome: namedOutcome, reason: result.reason,
            growth: result.growth, decisionId: result.decisionId, decisionRef: result.decisionRef,
            ...(result.command ? { command: result.command } : {}), ...(result.approval ? { approval: result.approval } : {}) };
          persist();
          break;
        }
      }
      persist();
    }
    // A planned harness loop follows its route directly: `changed-files` edges have no runner condition.
    current = plannedStep ? plannedStep.to
      : nextNode(graph.edges, current, state.dryRun && !command?.dry_run_command ? 'ok' : ok ? 'ok' : 'fail', namedOutcome);
    resumedGrowth = false;
    if (current !== undefined) publishInsideEvent({ kind: 'edge', graphId, runId, from: fromNodeId, to: current });
    if (current === undefined) {
      state.status = 'failed';
      persist();
      if (!state.dryRun && graphId === 'release-loop') {
        recordReleaseRunFailure(state, root, `Graph ${graphId}/${runId} failed after ${fromNodeId} (no outgoing edge)`);
      }
    }
  }
  return state;
  } finally {
    if (options.resumeRunId && existsSync(resumeLock)) rmdirSync(resumeLock);
  }
}

export type GraphRunAlive = boolean | 'unknown';

/** activeNode.pidStartedAt while the node child is spawned but its start time is not read yet — stop must not pass it. */
const UNVERIFIED_NODE_START = 'unverified';
/** A failed run's empty resume lock younger than this may belong to a resume that has not persisted «running» yet. */
const RESUME_LOCK_GRACE_MS = 60_000;

function runArtifacts(state: GraphRunState): string[] {
  const file = state.statePath;
  const claims = readdirSync(dirname(file))
    .filter(name => name.startsWith(`${state.runId}.json.`) && /^\d+\.decision\.json$/.test(name.slice(`${state.runId}.json.`.length)))
    .map(name => join(dirname(file), name));
  for (const claim of claims) {
    if (lstatSync(claim).isSymbolicLink()) throw new Error('graph run artifact is a symlink');
    let value: unknown;
    try { value = JSON.parse(readFileSync(claim, 'utf8')); }
    catch { throw new Error(`invalid graph run decision claim: ${claim}`); }
    const visit = Number(claim.slice(`${file}.`.length, -'.decision.json'.length));
    if (!isDecisionClaim(value) || !Number.isSafeInteger(visit) || visit < 1 ||
        (value as { nodeId: string }).nodeId !== state.path[visit - 1]) {
      throw new Error(`invalid graph run decision claim: ${claim}`);
    }
  }
  return [file, `${file}.graph`, `${file}.contexts`, ...claims];
}

/** Manage only an identity-checked ledger in this instance, never a caller-supplied path. */
export function manageGraphRun(graphId: string, runId: string, action: 'stop' | 'destroy',
  root = effectiveInstanceRoot(), processStartMs: (pid: number) => number | null = psProcessStartMs,
  signal: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM')): GraphRunState {
  const file = graphRunPath(safeSegment(graphId), safeSegment(runId), root);
  return withRunWriteLock(file, () => {
  if (lstatSync(join(root, 'graph-runs')).isSymbolicLink() || lstatSync(dirname(file)).isSymbolicLink() || lstatSync(file).isSymbolicLink()) throw new Error('graph run path is a symlink');
  const state = readGraphRun(graphId, runId, root);
  if (state.statePath !== file || !Array.isArray(state.path) || !Array.isArray(state.nodes) ||
      !Number.isSafeInteger(state.executed) || state.executed < 0 || (state.status === 'running' && state.pending)) {
    throw new Error(`invalid run state: ${graphId}/${runId}`);
  }
  for (const path of runArtifacts(state)) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('graph run artifact is a symlink'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const live = graphRunAlive(state, processStartMs);
  if (action === 'stop' && state.status !== 'running') throw new Error(`run is not running: ${graphId}/${runId}`);
  const lock = `${file}.resume.lock`;
  if (existsSync(lock) && (!lstatSync(lock).isDirectory() || readdirSync(lock).length > 0)) throw new Error('invalid resume lock');
  if (existsSync(lock) && state.status !== 'running') {
    // A resume persists «running» right after taking the lock; an older empty lock on a finished run is a crash leftover.
    const ageMs = Date.now() - statSync(lock).mtimeMs;
    if (ageMs < RESUME_LOCK_GRACE_MS) throw new Error(`run is being resumed: ${graphId}/${runId}`);
    rmdirSync(lock);
    debug.log('graph.runs', 'stale-resume-lock-cleared', { graphId, runId, ageMs: Math.round(ageMs), status: state.status });
  }
  if (state.status === 'running') {
    if (live === 'unknown') throw new Error(`cannot verify run owner: ${graphId}/${runId}`);
    if (live && state.pid === process.pid) throw new Error('cannot stop the current graph runner');
    const node = state.activeNode;
    if (node && (node.nodeId !== state.path.at(-1) || state.path.length !== state.nodes.length + 1)) throw new Error('active node does not match saved path');
    if (state.path.length !== state.nodes.length && state.path.length !== state.nodes.length + 1) {
      throw new Error('saved run path and node records do not match');
    }
    if (state.path.some((nodeId, i) => state.nodes[i] && state.nodes[i]?.nodeId !== nodeId) ||
        state.executed !== state.nodes.filter(record => record.executed).length) throw new Error('saved run path and node records do not match');
    if (node?.pidStartedAt === UNVERIFIED_NODE_START) {
      // While the runner lives it will either verify this child or kill it; retry stop after that.
      if (live) throw new Error(`node process start is not verified yet — retry stop: ${graphId}/${runId}`);
      // Runner gone (e.g. reboot): the pid may be reused, so never signal an identity we could not verify.
      debug.log('graph.runs', 'unverified-node-not-signaled', { graphId, runId, nodeId: node.nodeId, pid: node.pid });
    } else if (node) {
      const nodeAlive = graphRunAlive({ ...state, pid: node.pid, pidStartedAt: node.pidStartedAt }, processStartMs);
      if (nodeAlive === 'unknown') throw new Error('cannot verify node process owner');
      if (nodeAlive && node.pid === process.pid) throw new Error('cannot stop the current process');
      if (nodeAlive && node.pid !== state.pid) {
        try { signal(node.pid); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    const current = state.currentNode;
    const running = current && state.path.length === state.nodes.length + 1 && current.nodeId === state.path.at(-1) &&
      Number.isFinite(Date.parse(current.startedAt)) ? current.startedAt : undefined;
    // One stop instant for the node end, finishedAt and stoppedAt — never before the running node's start.
    const stopMs = running === undefined ? Date.now() : Math.max(Date.now(), Date.parse(running));
    if (state.path.length === state.nodes.length + 1) {
      state.nodes.push({ nodeId: state.path.at(-1)!, ok: false, exit: null, executed: false, error: STOPPED_NODE_ERROR,
        // The stop instant is always the node end; a start (and so seconds) exists only when the ledger named the running
        // node — a run begun by a runner before GRAPH-NODE-TIMES did not, and a guessed start would be a false time.
        endedAt: new Date(stopMs).toISOString(),
        ...(running === undefined ? {} : { startedAt: running, seconds: Number(((stopMs - Date.parse(running)) / 1000).toFixed(2)) }) });
    }
    delete state.currentNode;
    state.status = 'failed';
    state.finishedAt = new Date(stopMs).toISOString();
    state.stoppedAt = state.finishedAt;
    delete state.activeNode;
    persistGraphRun(state);
    try {
      if (live) signal(state.pid!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    } finally {
      // The failed ledger is durable even if its runner vanished between verification and signaling.
      if (existsSync(lock)) rmdirSync(lock);
    }
  } else if (existsSync(lock)) rmdirSync(lock);
  if (action === 'destroy') {
    for (const path of runArtifacts(state)) rmSync(path, { recursive: true, force: true });
  }
  debug.log('graph.runs', action, { graphId, runId, previousAlive: live, status: state.status });
  return state;
  });
}

export function graphRunAlive(state: GraphRunState, processStartMs: (pid: number) => number | null = psProcessStartMs): GraphRunAlive {
  if (state.pid === undefined) return 'unknown';
  if (!Number.isSafeInteger(state.pid) || state.pid <= 0 || typeof state.pidStartedAt !== 'string') return false;
  const recorded = Date.parse(state.pidStartedAt);
  if (!Number.isFinite(recorded)) return false;
  try {
    const actual = processStartMs(state.pid);
    return actual !== null && Number.isFinite(actual) && Math.abs(actual - recorded) <= START_TOLERANCE_MS;
  } catch { return false; }
}

function isDecisionClaim(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return typeof value.nodeId === 'string' && (value.decision === 'approved' || value.decision === 'rejected')
    && typeof value.decidedAt === 'string' && (value.decidedBy === undefined || typeof value.decidedBy === 'string')
    && !('graphId' in value) && !('runId' in value);
}

export function listGraphRuns(root = effectiveInstanceRoot()): { runs: GraphRunState[]; unreadable: number } {
  const base = join(root, 'graph-runs');
  let graphs: string[];
  try { graphs = readdirSync(base); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], unreadable: 0 };
    throw error;
  }
  const runs: GraphRunState[] = [];
  let unreadable = 0;
  for (const graphId of graphs) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(graphId) || graphId === '.' || graphId === '..') continue;
    const dir = join(base, graphId);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch { unreadable++; continue; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const runId = file.slice(0, -5);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') continue;
      // Decision claims are named <runId>.json.<visit>.decision.json; a run
      // may itself end in .decision, so check the ledger identity before skipping.
      const decisionParent = file.match(/^(.*\.json)\.\d+\.decision\.json$/)?.[1];
      try {
        const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        // Skip only a VALID decision claim (decideGraphApproval writes { nodeId, decision, decidedBy?, decidedAt });
        // anything else under a claim-like name is judged as a ledger and counts as unreadable when broken.
        if (decisionParent && isDecisionClaim(raw)) continue;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          (raw as Partial<GraphRunState>).graphId !== graphId || (raw as Partial<GraphRunState>).runId !== runId) {
          unreadable++;
          continue;
        }
        const state = readGraphRun(graphId, runId, root);
        if (typeof state.startedAt !== 'string' || !Number.isFinite(Date.parse(state.startedAt)) ||
          !Array.isArray(state.path) || !state.path.every((node) => typeof node === 'string') ||
          !Array.isArray(state.nodes) || !state.nodes.every((node) => node && typeof node.nodeId === 'string' && typeof node.ok === 'boolean')) {
          throw new Error('invalid run state');
        }
        runs.push(state);
      } catch { unreadable++; }
    }
  }
  runs.sort((a, b) => Date.parse(b.startedAt!) - Date.parse(a.startedAt!) || a.graphId.localeCompare(b.graphId) || a.runId.localeCompare(b.runId));
  return { runs, unreadable };
}

export function latestGraphRun(graphId: string, root = effectiveInstanceRoot()): GraphRunState | null {
  const dir = join(root, 'graph-runs', safeSegment(graphId));
  let files: string[];
  try { files = readdirSync(dir).filter((file) => file.endsWith('.json') && !file.endsWith('.decision.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const latest = files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)[0];
  return latest ? readGraphRun(graphId, latest.slice(0, -5), root) : null;
}
