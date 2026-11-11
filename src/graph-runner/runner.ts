import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getElanousConfigDir, getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { debug, redactSecretText } from '../debug/log.js';
import { createGateCorrelationContext, GATE_HEARTBEAT_INTERVAL_MS, withGateCorrelationContext } from '../mss/logging/gate-correlation.js';
import { observeModelInputTokens } from '../harness/model-input-observation.js';
import { publishInsideEvent } from '../nexus/api/inside-events.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { listInstalledPlugins } from '../plugins/install/plugin-install.js';
import { credentialStatus, pluginEnv } from '../plugins/install/plugin-credentials.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { spawnElanousSync } from '../instance/spawn-elanous.js';
import { loadNodeCatalog } from '../self-implement/graph-catalog.js';
import { recordFailureEvent } from '../self-implement/heal-intake.js';
import { growthApprovalRef, proposeGrowth, type GraphGrowth, type GrowthProposer, type GrowthRecipeEffect, type GrowthDecisionDeps, type GrowthCommand } from './graph-grow.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { createLLMGrowthProposer } from './graph-grow-llm.js';
import type { ResearchEdgeDecisionRegistry } from '../research/edge-decision.js';
import { graphVersionHash, parseGraphTemplateYaml, type GraphNodeSpec, type GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { evaluateOverlayCondition } from '../self-implement/graph-overlay-condition.js';
import { createGraphUnitResolver, resolveGraphUnit, UnitNotFoundError, type ResolvedGraphUnit } from '../self-implement/graph-unit-resolver.js';
import { flattenGraphUnits } from '../self-implement/graph-unit-flatten.js';
import { shapeGraphUnit } from './unit-shape.js';
import { createGraphEventBus, createScopedGraphEventBus, publishNodeGraphEvent, type GraphEvent, type GraphEventBus } from './graph-events.js';
import { registerGraphSubscriptions, type GraphEdgeAdditionApi, type GraphSubgraphAppendProposal, type GraphSubscriptionDispatch } from './graph-subscriptions.js';
import { registerReleaseGraphEventAdapters } from '../release-loop/graph-event-adapters.js';
import { releaseGateCutoverPath } from './release-gate-cutover-policy.js';
export { UnitNotFoundError } from '../self-implement/graph-unit-resolver.js';
import { createGraphVariant } from '../self-implement/graph-variant.js';
import { psProcessStartMs, START_TOLERANCE_MS } from '../harness/harness-stop.js';
import { executeBashNode } from '../workflow-runtime/nodes/bash.js';
import { executeClassifyNode } from '../workflow-runtime/nodes/classify.js';
import { requireInProcessHandler, type InProcessHandlerRegistry } from './in-process-registry.js';
import { capabilityNameFromRecipe, dispatchGraphCapability, dispatchGraphContract, graphContractValueMatches, isCapabilityRecipe } from './capabilities.js';
import { interpolate } from '../workflow-runtime/variables.js';
import { assertGraphManifestRecipeAllowed, assertGraphManifestTemplate, loadGraphManifestForFile, type GraphManifestDeclaration } from './graph-manifest-loader.js';
import type { BashNode, ClassifyNode, NodeExecContext, NodeOutput, WorkflowDeps } from '../workflow-runtime/types.js';
import { releaseResumeAcceptedRegressions, releaseResumeGateExecutor, releaseResumeGatePodPool, releaseResumeGateShardReroute, releaseResumeWaiver } from '../../scripts/release-loop/resume.js';
import type { AcceptedRegression, GateExecutorOverride, GatePodPoolOverride, GateShardRerouteOverride } from '../../scripts/release-loop/resume-types.js';
import { gateUnmeasuredDetail } from '../../scripts/release-loop/resume.js';
import { registerAdaptiveGateHealAdapter, RELEASE_GATE_FAILED_EVENT, type AdaptiveGateHealAppendNodeRequest, type AdaptiveGateHealAppendNodeReceipt, type AdaptiveGateHealRerunGateRequest } from '../../scripts/release-loop/adaptive-gate-heal-adapter.js';
import type { AdaptiveGateHealPlan } from '../../scripts/release-loop/adaptive-gate-heal.js';
import { resolveChildAllowance } from './arg-allowance.js';
import { withGraphProviderContextExtensions } from './provider-context.js';
import { lowerGraphV2, type LowerGraphV2Result } from '../graph-v2/lower.js';
import { emitReleaseStageTransition, postReleaseStageMail, type ReleaseStageState } from '../release-loop/stage-mail.js';
import { applyReleaseOpCommand, emptyReleaseOpState, parseReleaseOpBufferedEvent, parseReleaseOpCommand, recordReleaseOpEvent, shadowReleaseOpDecision, type ReleaseOpEvent, type ReleaseOpState } from '../release-loop/op-channel.js';
import { openMsgStore } from '../msg/msg-store.js';
import type { MsgStore } from '../msg/msg-store.js';
import { consumeWaiverEventFromLedger, gateWaiverEvidence, hasExactWaiverEvidence } from '../release-loop/waiver-events.js';
import { fanOutGraphSource, nextNode, planHarnessLoopRoute, releaseRouteReachesKnownIssues, topLevelTerminalStatus, type PlannedStep } from './runner-routing.js';
import { lastJsonObject, STOPPED_NODE_ERROR } from './runner-primitives.js';
import { declaredHealEdges, graphHealManifest, type DeclaredHealEdge } from './declared-heal-edges.js';
import type { GraphGrowthScope, GraphLoopBudgetScope, GraphNodeLifecycleEvent, GraphNodeLifecyclePhase, GraphRun, GraphRunOptions, GraphRunState } from './runner-types.js';
export { nextNode } from './runner-routing.js';
export { lastJsonObject, STOPPED_NODE_ERROR } from './runner-primitives.js';
export type { GraphGrowthScope, GraphNodeLifecycleEvent, GraphNodeLifecyclePhase, GraphRun, GraphRunOptions, GraphRunState } from './runner-types.js';

type BashRun = WorkflowDeps['runBash'];

/** Keep runner-originated gate observations in the same correlation scope as the child invocation. */
export function withRunnerGateObservation<T>(identity: { runId: string; invocation: string; batch: string }, run: () => T): T {
  return withGateCorrelationContext(createGateCorrelationContext(identity), run);
}

export const GRAPH_GROWTH_SCOPE_ENV = 'ELANOUS_GRAPH_GROWTH_SCOPE';
const graphGrowthScope = new AsyncLocalStorage<GraphGrowthScope>();

/** Scope implicit graph growth to an approved in-process harness dispatch. */
export function withGraphGrowthScope<T>(scope: GraphGrowthScope, work: () => T): T {
  return graphGrowthScope.run(scope, work);
}
const DEFAULT_BASH_TIMEOUT_MS = 5 * 60 * 1_000;
const eventBusSequences = new WeakMap<GraphEventBus, number>();
const fanOutDailyBudgetExemptRunIds = new Set<string>();

function stableSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
}

function requiredContractForNode(node: GraphNodeSpec): string | undefined {
  if (node.requires !== undefined) {
    if (node.kind !== 'capability') throw new Error(`requires is only valid on capability nodes: ${node.nodeId}`);
    if (node.recipe !== 'none') throw new Error(`contract capability node must not name a provider recipe: ${node.nodeId}`);
    if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*@[1-9]\d*$/.test(node.requires))
      throw new Error(`invalid capability contract id for ${node.nodeId}: ${node.requires}`);
    return node.requires;
  }
  if (node.kind === 'capability') {
    if (!isCapabilityRecipe(node.recipe)) throw new Error(`capability node requires a contract id or legacy cap:<name> recipe: ${node.nodeId}`);
    if (!capabilityNameFromRecipe(node.recipe)) throw new Error(`unknown graph capability for ${node.nodeId}: ${node.recipe.slice(4)}`);
  } else if (isCapabilityRecipe(node.recipe)) {
    throw new Error(`cap:<name> recipe requires kind capability: ${node.nodeId}`);
  }
  return undefined;
}

export function bindGraphV2StaticMapItem(nodeInput: unknown, outputs: Readonly<Record<string, unknown>>):
  { readonly nodeInput: unknown; readonly skipped?: { readonly index: number; readonly count: number } } {
  if (!nodeInput || typeof nodeInput !== 'object' || Array.isArray(nodeInput)) return { nodeInput };
  const input = nodeInput as Record<string, unknown>;
  const mapItem = input.__graphV2MapItem;
  if (!mapItem || typeof mapItem !== 'object' || Array.isArray(mapItem)) return { nodeInput };
  const declaration = mapItem as Record<string, unknown>;
  const match = typeof declaration.over === 'string'
    ? /^\$([A-Za-z0-9][A-Za-z0-9._-]*)\.result\.items$/.exec(declaration.over) : null;
  const index = declaration.index;
  const maxParallel = declaration.maxParallel;
  const as = declaration.as;
  if (!match || !Number.isSafeInteger(index) || (index as number) < 0 || !Number.isSafeInteger(maxParallel)
    || (maxParallel as number) < 2 || typeof as !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(as))
    throw new Error('invalid lowered static-map item metadata');
  const rawOutput = outputs[match[1]!];
  const source = typeof rawOutput === 'string' ? lastJsonObject(rawOutput) : rawOutput;
  const result = source && typeof source === 'object' && !Array.isArray(source) ? (source as Record<string, unknown>).result : undefined;
  const items = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>).items : undefined;
  if (!Array.isArray(items)) throw new Error(`static-map source has no result.items array: ${match[1]}`);
  if (items.length > (maxParallel as number))
    throw new Error(`static-map input has ${items.length} items but this static branches+join graph is bounded to ${maxParallel}`);
  if ((index as number) >= items.length) return { nodeInput, skipped: { index: index as number, count: items.length } };
  const { __graphV2MapItem: _metadata, ...declaredInput } = input;
  return { nodeInput: { ...declaredInput, [as]: structuredClone(items[index as number]), mapIndex: index, mapCount: items.length } };
}
function completionCommit(state: GraphRunState): string | undefined {
  const releaseCommit = state.nodes.find((record) => record.nodeId === 'version-release')?.output;
  const commit = lastJsonObject(releaseCommit)?.commit;
  return typeof commit === 'string' && /^[a-f0-9]{40}$/i.test(commit) ? commit : undefined;
}

function actualSourceCommit(root: string, git?: (args: string[]) => string): string | undefined {
  try {
    const result = git ? undefined : spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (result && (result.status !== 0 || result.error)) return undefined;
    const commit = git ? git(['rev-parse', 'HEAD']) : result?.stdout ?? '';
    const value = commit.trim();
    return /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : undefined;
  } catch { return undefined; }
}

function resolveUnitInputBinding(reference: unknown, outputs: Readonly<Record<string, unknown>>): unknown {
  if (typeof reference !== 'string') return undefined;
  const match = /^\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/.exec(reference);
  if (!match) return undefined;
  let value: unknown = outputs[match[1]!];
  for (const key of match[2]!.split('.')) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function completionArtifactSnapshot(output: unknown, baseDir: string): { sha256: string; valid: boolean } {
  const files: Array<{ path: string; sha256: string | null }> = [];
  const looksLikeArtifactPath = (value: string): boolean => /^(?:\/|\.\.?[\\/])/.test(value) || /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value);
  const isArtifactPath = (value: string): boolean => looksLikeArtifactPath(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  const recordArtifactPath = (value: string): void => {
    const artifactPath = resolve(baseDir, value);
    try {
      if (lstatSync(artifactPath).isFile()) files.push({ path: artifactPath, sha256: createHash('sha256').update(readFileSync(artifactPath)).digest('hex') });
      else files.push({ path: artifactPath, sha256: null });
    } catch { files.push({ path: artifactPath, sha256: null }); }
  };
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      try { visit(JSON.parse(value)); } catch { /* Plain text outputs have no structured artifact references. */ }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && isArtifactPath(entry)) recordArtifactPath(entry);
        else visit(entry);
      }
      return;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const namedPath = /^(?:artifact|artifactpath|file(?:path)?|report(?:path)?|path)$/i.test(key) &&
        (key.toLowerCase() !== 'artifact' || looksLikeArtifactPath(String(entry)));
      const inferredPath = typeof entry === 'string' && isArtifactPath(entry);
      if (typeof entry === 'string' && (namedPath || inferredPath)) {
        recordArtifactPath(entry);
      } else visit(entry);
    }
  };
  visit(output);
  const valid = files.every((file) => file.sha256 !== null);
  return { sha256: stableSha256({ output, files }), valid };
}

// Independent of graph YAML and recipe snapshots: an already-wrong saved binding must fail closed.
export const RELEASE_NODE_COMMANDS: Readonly<Record<string, Readonly<{ recipe: string; command?: string }>>> = {
  'version-release': { recipe: 'cmd:version-release', command: 'bun scripts/release-loop/version-node.ts release --json' },
  'readiness-countdown': { recipe: 'cmd:readiness-countdown', command: 'bun scripts/release-loop/release-readiness.ts --image-t60-hold' },
  'traffic-cut-start': { recipe: 'cmd:traffic-cut-start', command: 'bun scripts/release-loop/traffic-node.ts traffic-cut-start' },
  cutoff: { recipe: 'cmd:cutoff', command: 'bun scripts/release-loop/node-verdict.ts cutoff' },
  'rla-cloud-join': { recipe: 'cmd:cloud-join', command: 'bun scripts/release-loop/hand-response-node.ts rla-cloud-join' },
  'checklist-gate': { recipe: 'cmd:checklist-gate', command: 'bun scripts/release-loop/checklist-gate-node.ts' },
  tsc: { recipe: 'cmd:tsc', command: 'bun run scripts/ci-typecheck-changed.ts' },
  ratchet: { recipe: 'cmd:ratchet', command: 'bash scripts/ratchets/train-side-invariants.sh' },
  prefetch: { recipe: 'cmd:docs', command: 'bun scripts/release-loop/docs-node.ts --json' },
  'pre-gate-join': { recipe: 'none' },
  gate: { recipe: 'cmd:gate', command: 'bun scripts/release-loop/gate-node.ts --json' },
  'emergency-switch': { recipe: 'cmd:emergency-switch', command: 'bun scripts/release-loop/emergency-publish-switch-sim.ts' },
  'emergency-gate': { recipe: 'cmd:emergency-gate', command: 'bun scripts/release-loop/emergency-publish-gate-node.ts' },
  'receipt-audit': { recipe: 'cmd:receipt-audit', command: 'bun scripts/release-loop/gate-file-receipt-audit-node.ts' },
  'residual-run': { recipe: 'cmd:gate', command: 'bun scripts/release-loop/gate-node.ts --json' },
  'receipt-audit-recheck': { recipe: 'cmd:receipt-audit', command: 'bun scripts/release-loop/gate-file-receipt-audit-node.ts' },
  'traffic-gate-passed': { recipe: 'cmd:traffic-gate-passed', command: 'bun scripts/release-loop/traffic-node.ts traffic-gate-passed' },
  'gate-triage': { recipe: 'cmd:gate-triage', command: 'bun scripts/release-loop/gate-triage-node.ts' },
  'gate-repair-recovery': { recipe: 'approval:repair-recovery' },
  'gate-heal-decision': { recipe: 'approval:gate-heal-decision' },
  'gate-same-run-recheck': { recipe: 'cmd:gate-same-run-recheck', command: 'bun scripts/release-loop/gate-same-run-recheck-node.ts' },
  'mac-smoke': { recipe: 'cmd:mac-smoke', command: 'bun scripts/release-loop/mac-smoke-node.ts' },
  'export-check': { recipe: 'cmd:export-check', command: 'bun scripts/release-loop/export-check-node.ts' },
  pwa: { recipe: 'cmd:pwa', command: 'bun scripts/release-loop/node-verdict.ts pwa' },
  'pre-prepare-join': { recipe: 'none' },
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
  'approve-continue': { recipe: 'approval:continue-publish' },
  publish: { recipe: 'cmd:publish-command', command: 'bun scripts/release-loop/publish-node.ts' },
  'npm-publish': { recipe: 'cmd:npm-publish', command: 'bun scripts/release-loop/npm-publish-node.ts' },
  'traffic-npm-published': { recipe: 'cmd:traffic-npm-published', command: 'bun scripts/release-loop/traffic-node.ts traffic-npm-published' },
  'release-post-publish-join': { recipe: 'none' },
  'docs-land': { recipe: 'cmd:docs-land', command: 'bun scripts/release-loop/docs-land-node.ts' },
  verify: { recipe: 'cmd:verify', command: 'bun scripts/release-loop/verify-node.ts' },
  'traffic-verify-complete': { recipe: 'cmd:traffic-verify-complete', command: 'bun scripts/release-loop/traffic-node.ts traffic-verify-complete' },
  'traffic-failed-restore': { recipe: 'cmd:traffic-failed-restore', command: 'bun scripts/release-loop/traffic-node.ts traffic-failed-restore' },
  'vault-note': { recipe: 'cmd:vault-note', command: 'bun scripts/release-loop/vault-note-node.ts' },
  'release-story': { recipe: 'cmd:release-story', command: 'bun scripts/release-story/draft.ts --graph' },
  'ops-upgrade': { recipe: 'cmd:ops-upgrade', command: 'bun scripts/release-loop/ops-upgrade-node.ts' },
  'version-dev-bump': { recipe: 'cmd:version-dev-bump', command: 'bun scripts/release-loop/version-node.ts dev-bump --json' },
  done: { recipe: 'none' },
  failed: { recipe: 'none' },
};

function releasePluginCommandBinding(node: GraphNodeSpec, manifest?: GraphManifestDeclaration): Readonly<{ recipe: string; command?: string }> | undefined {
  const path = fileURLToPath(new URL('../../graphs/release/node-command-bindings.json', import.meta.url));
  const bindings = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('invalid release plugin command bindings');
  if (node.kind === 'hitl' && /^hitl:[a-z][a-z0-9-]*$/.test(node.recipe) && manifest?.hitl.includes(node.nodeId)) {
    const wildcard = bindings['hitl:*'];
    if (!wildcard || typeof wildcard !== 'object' || Array.isArray(wildcard) ||
      Object.keys(wildcard).join(',') !== 'recipe' || (wildcard as Record<string, unknown>).recipe !== 'hitl:*')
      throw new Error('invalid release plugin HITL binding');
    return { recipe: node.recipe };
  }
  const value = bindings[node.nodeId];
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid release plugin command binding');
  const record = value as Record<string, unknown>;
  if (node.kind === 'subgraph' && record.recipe === 'none' && Object.keys(record).join(',') === 'recipe')
    return { recipe: 'none' };
  if (Object.keys(record).sort().join(',') !== 'command,recipe'
    || record.recipe !== `cmd:${node.nodeId}` || typeof record.command !== 'string'
    || !/^bun scripts\/release-loop\/[a-z0-9-]+-node\.ts$/.test(record.command)) {
    throw new Error('invalid release plugin command binding');
  }
  return { recipe: record.recipe, command: record.command };
}

function assertReleaseCommandBinding(node: GraphNodeSpec, command: string | undefined, terminal: boolean,
  manifest?: GraphManifestDeclaration): void {
  const adaptiveRepair = /^gate-repair-[a-f0-9]{12}$/.test(node.nodeId)
    ? { recipe: 'cmd:gate-repair', command: 'bun scripts/release-loop/gate-repair-node.ts' }
    : /^gate-image-repair-[a-f0-9]{12}$/.test(node.nodeId)
      ? { recipe: 'cmd:gate-image-repair', command: 'bun scripts/release-loop/gate-image-repair-node.ts' }
      : undefined;
  const expected = RELEASE_NODE_COMMANDS[node.nodeId] ?? adaptiveRepair ?? releasePluginCommandBinding(node, manifest);
  if (!expected || node.recipe !== expected.recipe || command !== expected.command ||
    terminal !== (node.nodeId === 'done' || node.nodeId === 'failed')) {
    throw new Error(`release node dispatch mismatch before execution: ${node.nodeId}`);
  }
  if (adaptiveRepair && !existsSync(fileURLToPath(new URL(`../../${adaptiveRepair.command.slice('bun '.length)}`, import.meta.url)))) {
    throw new Error(`release node entrypoint is missing before execution: ${node.nodeId} -> ${adaptiveRepair.command}`);
  }
}

/** HARNESS-FULL-GRAPH-LOOPS — the four goal loops are self-implement harness templates: their recipes are
 *  catalog roles (no `recipes.yaml` sidecar) and some edges branch on `changed-files`. `graph run` can only
 *  *plan* them: `--dry-run` walks the declared success route; a real run is refused (the harness owns effects). */
const HARNESS_LOOP_GRAPH_IDS: ReadonlySet<string> = new Set(['default-loop', 'document-loop', 'operate-loop', 'research-loop']);



function failedCommandStderrTail(exitCode: number, stderr: string): string | undefined {
  if (exitCode === 0 || !stderr.trim()) return undefined;
  return stderr.replace(/(?:\r?\n)+$/, '').split(/\r?\n/).slice(-40).join('\n') || undefined;
}

export interface ReleaseNodeFailureDetail {
  kind: 'export-detection' | 'tool-error' | 'timeout';
  stderrTail?: string;
  markers: string[];
  locations: string[];
}

function scrubReleaseFailureText(text: string, rootDir: string, redact: (value: string) => string): string {
  const root = resolve(rootDir).replaceAll('\\', '/').replace(/\/$/u, '');
  const safe = (value: string) => {
    const normalized = value.replaceAll('\\', '/');
    if (normalized === root) return '<repo>';
    if (normalized.startsWith(`${root}/`)) return `<repo>/${normalized.slice(root.length + 1)}`;
    return `<absolute-path>/${normalized.split('/').at(-1) ?? 'path'}`;
  };
  return redact(text)
    .replace(/\\\\[^\\\s]+(?:\\[^\\\s]+)+/gu, (path) => safe(path))
    .replace(/\b[A-Za-z]:[\\/](?:[^\s:]+[\\/])*[^\s:]+/gu, (path) => safe(path))
    .replace(/(?<=[=:])\/(?:[^/\s:]+\/)*[^/\s:]+/gu, (path) => safe(path))
    .replace(/(?<![A-Za-z0-9])(?<!\.\/)(?<!\.\.)(?<!<repo>)(?<!<absolute-path>)\/(?:[^/\s:]+\/)*[^/\s:]+/gu, (path) => safe(path))
    .replaceAll(root, '<repo>');
}

/** Scrub all strings before persisting an export-check payload, not just the compact summary. */
function scrubReleaseNodeOutput(output: unknown, rootDir: string, redact: (value: string) => string): unknown {
  if (typeof output === 'string') {
    try { return JSON.stringify(scrubReleaseNodeOutput(JSON.parse(output) as unknown, rootDir, redact)); }
    catch { return scrubReleaseFailureText(output, rootDir, redact); }
  }
  if (Array.isArray(output)) return output.map((value) => scrubReleaseNodeOutput(value, rootDir, redact));
  if (output && typeof output === 'object') {
    const usedKeys = new Set<string>();
    const entries = Object.entries(output).map(([key, value]) => {
      const base = scrubReleaseFailureText(key, rootDir, redact);
      let safeKey = base;
      let suffix = 1;
      while (usedKeys.has(safeKey)) safeKey = `${base}#${suffix++}`;
      usedKeys.add(safeKey);
      return [safeKey, scrubReleaseNodeOutput(value, rootDir, redact)] as const;
    });
    return Object.fromEntries(entries);
  }
  return output;
}

/** Extract only bounded, path- and credential-scrubbed evidence from the export-check node's JSON result. */
export function releaseNodeFailureDetail(output: unknown, rootDir: string, redact: (value: string) => string): ReleaseNodeFailureDetail | undefined {
  const result = lastJsonObject(output);
  if (!result || (result.outcome !== 'fail' && result.outcome !== 'error')) return undefined;
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics.filter((value): value is string => typeof value === 'string') : [];
  const rawLines = [result.summary, result.tail, ...diagnostics]
    .filter((value): value is string => typeof value === 'string');
  if (!rawLines.length) return undefined;
  const lines = rawLines.map((value) => scrubReleaseFailureText(value, rootDir, redact).slice(-1_000));
  const markers = [...new Set(lines.flatMap(line => [...line.matchAll(/\b(absolute-home-path|kr-mobile-phone|pilot-tree|handoff-doc-link|plan-doc-link|xcode-author-header|[a-z][a-z0-9-]*-error)\b/gu)].map(match => match[1]!)))].slice(0, 12);
  const root = resolve(rootDir).replaceAll('\\', '/').replace(/\/$/u, '');
  const locations = [...new Set(lines.flatMap((line) => [...line.matchAll(/(?:^|[\s(=:>])((?:<repo>\/|<absolute-path>\/|[A-Za-z]:[\\/]|\/)?[^\s():>]+\.(?:tsx?|jsx?|json|ya?ml)):(\d+)(?::\d+)?/gu)].map((match) => {
    const rawPath = match[1]!.replaceAll('\\', '/');
    const path = rawPath.startsWith(`${root}/`) ? `<repo>/${rawPath.slice(root.length + 1)}`
      : rawPath.startsWith('/') || /^[A-Za-z]:\//u.test(rawPath) ? `<absolute-path>/${rawPath.split('/').at(-1)}` : rawPath;
    return `${path}:${match[2]}`;
  })))].slice(0, 12);
  const text = lines.join('\n');
  const kind: ReleaseNodeFailureDetail['kind'] = /(?:timed?\s*out|timeout|ETIMEDOUT|SIGTERM)/iu.test(text)
    ? 'timeout' : markers.length ? 'export-detection' : 'tool-error';
  const tail = typeof result.tail === 'string' && result.tail.trim() ? result.tail : diagnostics.join('\n');
  return { kind, ...(tail.trim() ? { stderrTail: scrubReleaseFailureText(tail, rootDir, redact).slice(-1_000) } : {}), markers, locations };
}

function fanOutFailureDiagnostics(fanout: NonNullable<GraphRunState['fanOuts']>[string]) {
  return Object.entries(fanout.branches).flatMap(([nodeId, branch]) => {
    if (branch.status !== 'failed') return [];
    const renderedOutput = typeof branch.output === 'string' ? branch.output
      : branch.output === undefined ? '' : JSON.stringify(branch.output) ?? String(branch.output);
    const outputFirstLine = renderedOutput.split(/\r?\n/, 1)[0];
    return [{ nodeId, runId: branch.runId, ...(branch.error ? { error: branch.error } : {}),
      outputFirstLine: outputFirstLine || null }];
  });
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
    ...(entry.timeout_ms !== undefined ? { timeout_ms: entry.timeout_ms } : {}) } : undefined;
}

function resolveNodeRecipe(node: GraphNodeSpec, recipes: Record<string, Recipe>, catalogRoles: ReadonlySet<string>,
  manifest?: GraphManifestDeclaration | null): { command?: CommandRecipe; prompt?: PromptRecipe; approval?: { approval: string } } {
  if (node.recipe.startsWith('hitl:')) {
    if (node.kind !== 'hitl' || !manifest?.hitl.includes(node.nodeId) || !/^hitl:[a-z][a-z0-9-]*$/.test(node.recipe)) return {};
    const input = node.input && typeof node.input === 'object' && !Array.isArray(node.input)
      ? node.input as Record<string, unknown> : undefined;
    if (input?.approval !== undefined && (typeof input.approval !== 'string' || !input.approval.trim()))
      throw new Error(`invalid HITL approval prompt: ${node.nodeId}`);
    const prompt = typeof input?.approval === 'string'
      ? input.approval : `Approve graph action ${node.recipe.slice('hitl:'.length)}?`;
    const choices = node.hitl?.options.length === 2
      ? ` Choose one graph option: ${node.hitl.options.map(option => `${option.key} → ${option.exit}${option.default ? ' (default)' : ''}`).join(', ')}` : '';
    return { approval: { approval: prompt + choices } };
  }
  if (node.kind === 'hitl' && node.hitl?.options.length === 2) {
    const choices = node.hitl.options.map(option => `${option.key} → ${option.exit}${option.default ? ' (default)' : ''}`).join(', ');
    return { approval: { approval: `Choose one graph option: ${choices}` } };
  }
  if (node.recipe === 'none') return {};
  if (node.recipe === 'cmd:gate-repair' && /^gate-repair-[a-f0-9]{12}$/.test(node.nodeId))
    return { command: { command: 'bun scripts/release-loop/gate-repair-node.ts', timeout_ms: 30 * 60 * 1_000 } };
  if (node.recipe === 'cmd:gate-image-repair' && /^gate-image-repair-[a-f0-9]{12}$/.test(node.nodeId))
    return { command: { command: 'bun scripts/release-loop/gate-image-repair-node.ts', timeout_ms: 30 * 60 * 1_000 } };
  if (node.kind === 'prompt' && node.recipe.startsWith('prompt:')) {
    const entry = recipes[node.recipe.slice('prompt:'.length)];
    return entry && 'prompt' in entry ? { prompt: entry } : {};
  }
  if (node.recipe.startsWith('cmd:')) {
    const id = node.recipe.slice(4);
    const entry = recipes[id];
    return entry && 'command' in entry && !('approval' in entry) && typeof entry.command === 'string' ? { command: { command: entry.command,
      ...(entry.dry_run_command ? { dry_run_command: entry.dry_run_command } : {}),
      ...(entry.timeout_ms !== undefined ? { timeout_ms: entry.timeout_ms } : {}) } } : {};
  }
  if (node.recipe.startsWith('approval:')) {
    const id = node.recipe.slice(9);
    const entry = recipes[id];
    return entry && 'approval' in entry ? { approval: entry,
      ...('command' in entry && typeof entry.command === 'string' ? { command: { command: entry.command,
        ...(entry.dry_run_command ? { dry_run_command: entry.dry_run_command } : {}),
        ...(entry.timeout_ms !== undefined ? { timeout_ms: entry.timeout_ms } : {}) } } : {}) } : {};
  }
  const command = roleCommand(node.recipe, recipes, catalogRoles);
  return command ? { command } : {};
}

function approvalMessage(template: string, input: unknown, releaseGraph: boolean): string {
  return template.replace(/\{\{input\.([A-Za-z][A-Za-z0-9_.-]*)\}\}/g, (_match, path: string) => {
    let value: unknown = input;
    for (const key of path.split('.')) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key))
        throw new Error(`approval input.${path} is missing`);
      value = (value as Record<string, unknown>)[key];
    }
    if (releaseGraph && path === 'version' && (typeof value !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)))
      throw new Error('approval input.version must be a release version');
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    if (!rendered || rendered.length > 8_192) throw new Error(`approval input.${path} is empty or too large`);
    return rendered;
  });
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
        (item.timeout_ms !== undefined && (!Number.isSafeInteger(item.timeout_ms) || (item.timeout_ms as number) < 0)) ||
        (item.dry_run_command !== undefined && (typeof item.dry_run_command !== 'string' || !item.dry_run_command.trim())) ||
        (item.command === undefined && (item.timeout_ms !== undefined || item.dry_run_command !== undefined)) ||
        Object.keys(item).some(key => !['approval', 'command', 'dry_run_command', 'timeout_ms'].includes(key))) throw new Error(`invalid recipe: ${id}`);
      recipes[id] = { approval: item.approval,
        ...(item.command === undefined ? {} : { command: item.command as string }),
        ...(item.dry_run_command === undefined ? {} : { dry_run_command: item.dry_run_command as string }),
        ...(item.timeout_ms === undefined ? {} : { timeout_ms: item.timeout_ms as number }) };
    } else {
      if (typeof item.command !== 'string' || !item.command.trim() ||
        (item.timeout_ms !== undefined && (!Number.isSafeInteger(item.timeout_ms) || (item.timeout_ms as number) < 0)) ||
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
  // A legacy card had no pinned input. Its claim is archived and a fresh card is issued on resume.
  if (!state.pending.inputSha256) return state;
  let recorded: { nodeId: string; decision: 'approved' | 'rejected'; decidedBy?: string; decidedAt: string; inputSha256?: string };
  try { recorded = JSON.parse(readFileSync(approvalDecisionPath(state), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return state;
    throw error;
  }
  if (recorded.nodeId !== state.pending.nodeId || !['approved', 'rejected'].includes(recorded.decision) ||
    typeof recorded.decidedAt !== 'string' || (recorded.decidedBy !== undefined && typeof recorded.decidedBy !== 'string') ||
    (state.pending.decision && state.pending.decision !== recorded.decision) ||
    (state.pending.inputSha256 !== undefined && state.pending.inputSha256 !== stableSha256(state.input)) ||
    (recorded.inputSha256 !== undefined && (recorded.inputSha256 !== stableSha256(state.input) ||
      recorded.inputSha256 !== state.pending.inputSha256))) {
    throw new Error(`approval decision mismatch: ${state.graphId}/${state.runId}`);
  }
  state.pending = { ...state.pending, ...recorded };
  return state;
}

function readGraphRun(graphId: string, runId: string, root: string): GraphRunState {
  const file = graphRunPath(graphId, runId, root);
  const state = JSON.parse(readFileSync(file, 'utf8')) as GraphRunState;
  if (state.graphId !== graphId || state.runId !== runId) throw new Error(`run identity mismatch: ${graphId}/${runId}`);
  const restored = { ...state, statePath: file };
  if (graphId === 'release-loop' && Number.isSafeInteger(restored.executed)) {
    const recordedExecuted = restored.nodes.filter((record) => record.executed).length;
    // Source: prior release-loop runners omitted executed fan-out joins from the persisted aggregate.
    if (restored.executed < recordedExecuted) restored.executed = recordedExecuted;
  }
  return applyRecordedDecision(restored);
}

export interface ApprovedGraphNodeInputCheck {
  graphId: string;
  runId: string;
  nodeId: string;
  /** Dot-separated path within the immutable graph run input, e.g. cloudElastic. */
  inputPath: string;
  inputSha256: string;
  maxAgeMs: number;
  root?: string;
  now?: number;
}

interface ApprovedInputBinding { nodeId: string; inputPath: string; maxAgeMs: number }

function approvedInputBinding(node: GraphNodeSpec): ApprovedInputBinding | undefined {
  const input = node.input && typeof node.input === 'object' && !Array.isArray(node.input)
    ? node.input as Record<string, unknown> : undefined;
  const raw = input?.approvedInput;
  if (raw === undefined) return undefined;
  if (!node.recipe.startsWith('cmd:') || !raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`invalid approved input binding: ${node.nodeId}`);
  const binding = raw as Record<string, unknown>;
  if (Object.keys(binding).sort().join(',') !== 'inputPath,maxAgeMs,nodeId' ||
    typeof binding.nodeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(binding.nodeId) ||
    typeof binding.inputPath !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(binding.inputPath) ||
    !Number.isSafeInteger(binding.maxAgeMs) || (binding.maxAgeMs as number) <= 0)
    throw new Error(`invalid approved input binding: ${node.nodeId}`);
  return binding as unknown as ApprovedInputBinding;
}

function graphInputAtPath(input: unknown, path: string): { found: boolean; value?: unknown } {
  let value = input;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) return { found: false };
    value = (value as Record<string, unknown>)[key];
  }
  return { found: true, value };
}

/** Check the saved input, completed HITL visit, and its separate durable decision claim. */
export function hasApprovedGraphNodeInput(check: ApprovedGraphNodeInputCheck): boolean {
  try {
    const { graphId, runId, nodeId, inputSha256, maxAgeMs } = check;
    const now = check.now ?? Date.now();
    if (!/^[a-f0-9]{64}$/.test(inputSha256) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 ||
      !Number.isFinite(now) || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(check.inputPath)) return false;
    const state = readGraphRun(graphId, runId, check.root ?? effectiveInstanceRoot());
    const pinned = graphInputAtPath(state.input, check.inputPath);
    if (!pinned.found || stableSha256(pinned.value) !== inputSha256) return false;
    const index = state.nodes.map(record => record.nodeId).lastIndexOf(nodeId);
    const record = state.nodes[index];
    if (index < 0 || !record?.ok || state.path[index] !== nodeId || record.output === undefined || !record.decidedAt) return false;
    const output = lastJsonObject(record.output);
    if (output?.outcome !== 'approved' || output.graphId !== graphId || output.runId !== runId ||
      output.nodeId !== nodeId || output.decidedAt !== record.decidedAt) return false;
    const decision = JSON.parse(readFileSync(`${state.statePath}.${index + 1}.decision.json`, 'utf8')) as
      { nodeId?: string; decision?: string; decidedAt?: string; inputSha256?: string };
    const decidedAt = Date.parse(record.decidedAt);
    return decision.nodeId === nodeId && decision.decision === 'approved' && decision.decidedAt === record.decidedAt &&
      decision.inputSha256 === stableSha256(state.input) &&
      Number.isFinite(decidedAt) && decidedAt <= now && now - decidedAt <= maxAgeMs;
  } catch { return false; }
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

function alertHealLoopFailure(state: GraphRunState, summary: string, postOpAlert?: (body: string) => void): void {
  const body = `heal-loop 실패 · ${state.runId} · ${state.path.at(-1) ?? 'unknown'} · ${summary} · ${state.statePath}`;
  try {
    if (postOpAlert) {
      postOpAlert(body);
      return;
    }
    if (process.env.NODE_ENV === 'test' || process.env.ELANOUS_TEST_HOME) return;
    const result = spawnElanousSync(['msg', 'post', '--from', 'HARNESS', '--to', 'OP', '--kind', 'alert', '--body', body],
      { executable: 'eln', encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) {
      const failureMessage = result.stderr || result.stdout || `eln exit ${result.status}`;
      throw result.error ?? new Error(String(failureMessage));
    }
  } catch (error) {
    debug.log('heal.intake', 'op-alert-failed', { graphId: state.graphId, runId: state.runId, statePath: state.statePath,
      error: String(error) }, { level: 'error' });
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

interface GraphLoopBudgetLedger {
  version: 1;
  runsPerDay: Record<string, Record<string, string[]>>;
  llmCalls: Record<string, number>;
}

function readGraphLoopBudgetLedger(file: string, initializedMarker: string): GraphLoopBudgetLedger {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    const ledger = value as Partial<GraphLoopBudgetLedger>;
    if (ledger.version !== 1 || !ledger.runsPerDay || typeof ledger.runsPerDay !== 'object' || Array.isArray(ledger.runsPerDay) ||
        !ledger.llmCalls || typeof ledger.llmCalls !== 'object' || Array.isArray(ledger.llmCalls)) throw new Error('invalid shape');
    const runsPerDay = Object.create(null) as GraphLoopBudgetLedger['runsPerDay'];
    for (const [graphId, rawDays] of Object.entries(ledger.runsPerDay)) {
      if (!rawDays || typeof rawDays !== 'object' || Array.isArray(rawDays) || Object.values(rawDays).some((runs) =>
        !Array.isArray(runs) || !runs.every((runId) => typeof runId === 'string'))) throw new Error('invalid daily run entries');
      runsPerDay[graphId] = Object.assign(Object.create(null), rawDays);
    }
    if (Object.values(ledger.llmCalls).some((count) => !Number.isSafeInteger(count) || count < 0)) throw new Error('invalid provider call entries');
    const safeLedger = { version: 1 as const, runsPerDay, llmCalls: Object.assign(Object.create(null), ledger.llmCalls) };
    // A ledger may predate the marker (or the process may have crashed between
    // publishing the first ledger and its marker), so a valid ledger can seed it.
    ensureGraphLoopBudgetMarker(initializedMarker);
    return safeLedger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (existsSync(initializedMarker)) throw new Error(`graph loop budget ledger missing after initialization: ${file}`, { cause: error });
      return { version: 1, runsPerDay: Object.create(null), llmCalls: Object.create(null) };
    }
    throw new Error(`graph loop budget ledger is unreadable: ${file}`, { cause: error });
  }
}

function ensureGraphLoopBudgetMarker(file: string): void {
  if (existsSync(file)) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, '{"version":1}\n', { flag: 'wx' });
    try { renameSync(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function writeGraphLoopBudgetLedger(file: string, initializedMarker: string, ledger: GraphLoopBudgetLedger): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(ledger)}\n`, { flag: 'wx' });
    renameSync(temporary, file);
    ensureGraphLoopBudgetMarker(initializedMarker);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function kstCalendarDay(instant: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error('graph loop budget requires a valid run start time');
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function graphLoopBudget(graph: GraphTemplateSpec): { runsPerDay?: number; llmCalls?: number } {
  // Release graph policies are namespaced in loop.ext; absorb owns this budget contract.
  const budget = (graph.loop?.budget ?? graph.loop?.ext?.['absorb.budget']) as Readonly<Record<string, unknown>> | undefined;
  if (!budget) return {};
  const read = (key: 'runs_per_day' | 'llm_calls'): number | undefined => {
    const value = budget[key];
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`loop.budget.${key} must be a positive safe integer`);
    return value as number;
  };
  const runsPerDay = read('runs_per_day');
  const llmCalls = read('llm_calls');
  return { ...(runsPerDay === undefined ? {} : { runsPerDay }), ...(llmCalls === undefined ? {} : { llmCalls }) };
}

function reserveDailyGraphRun(root: string, graphId: string, runId: string, startedAt: string, limit: number): void {
  const ledgerPath = join(root, 'graph-runs', '.loop-budget-ledger.json');
  const initializedMarker = join(root, '.graph-loop-budget-ledger.initialized');
  withRunWriteLock(ledgerPath, () => {
    const ledger = readGraphLoopBudgetLedger(ledgerPath, initializedMarker);
    const day = kstCalendarDay(startedAt);
    const graphDays = ledger.runsPerDay[graphId] ??= Object.create(null) as Record<string, string[]>;
    const runs = graphDays[day] ??= [];
    if (runs.includes(runId)) return;
    if (runs.length >= limit) throw new Error(`loop budget runs_per_day exceeded for ${graphId} on ${day}: ${limit}`);
    runs.push(runId);
    writeGraphLoopBudgetLedger(ledgerPath, initializedMarker, ledger);
  });
}

function reserveGraphProviderCalls(root: string, scopes: readonly GraphLoopBudgetScope[]): void {
  const unique = [...new Map(scopes.map((scope) => [`${scope.graphId}\0${scope.runId}`, scope])).values()];
  if (!unique.length) return;
  const ledgerPath = join(root, 'graph-runs', '.loop-budget-ledger.json');
  const initializedMarker = join(root, '.graph-loop-budget-ledger.initialized');
  withRunWriteLock(ledgerPath, () => {
    const ledger = readGraphLoopBudgetLedger(ledgerPath, initializedMarker);
    const keys = unique.map((scope) => [scope, JSON.stringify([scope.graphId, scope.runId])] as const);
    for (const [scope, key] of keys) {
      if ((ledger.llmCalls[key] ?? 0) >= scope.llmCalls)
        throw new Error(`loop budget llm_calls exceeded for ${scope.graphId}/${scope.runId}: ${scope.llmCalls}`);
    }
    for (const [, key] of keys) ledger.llmCalls[key] = (ledger.llmCalls[key] ?? 0) + 1;
    writeGraphLoopBudgetLedger(ledgerPath, initializedMarker, ledger);
  });
}

function persistOwnedRun(state: GraphRunState, expected: Partial<Pick<GraphRunState, 'pid' | 'pidStartedAt' | 'stoppedAt' | 'pausedAt' | 'cancelledAt'>>, allowRestart = false): void {
  withRunWriteLock(state.statePath, () => {
    let disk: GraphRunState;
    try { disk = JSON.parse(readFileSync(state.statePath, 'utf8')) as GraphRunState; }
    catch (cause) { throw new Error(`run was removed or unreadable: ${state.graphId}/${state.runId}`, { cause }); }
    if (disk.graphId !== state.graphId || disk.runId !== state.runId || disk.pid !== expected.pid ||
        disk.pidStartedAt !== expected.pidStartedAt || disk.stoppedAt !== expected.stoppedAt ||
        disk.pausedAt !== expected.pausedAt || disk.cancelledAt !== expected.cancelledAt ||
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
  if (!state.pending.inputSha256 || state.pending.inputSha256 !== stableSha256(state.input))
    throw new Error(`approval input changed since card was shown: ${graphId}/${runId}`);
  const recorded = { nodeId: state.pending.nodeId, decision, ...(by === undefined ? {} : { decidedBy: by }),
    decidedAt: new Date().toISOString(), inputSha256: state.pending.inputSha256 };
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



function hasActionableGateTriageEvidence(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  const introduced = value?.introduced;
  return typeof value?.classification === 'string' &&
    ['unmeasured', 'load', 'env', 'regression', 'clean', 'exhausted'].includes(value.classification) &&
    typeof value.commit === 'string' && /^[0-9a-f]{40}$/i.test(value.commit) &&
    Array.isArray(introduced) && (introduced.length > 0 || value.classification === 'unmeasured') &&
    introduced.every((id) => typeof id === 'string' && id.trim().length > 0);
}

/** Reconstruct the run-local edges from the ledger without rewriting the YAML snapshot. */
/** Apply validated, run-local edge growth to a graph snapshot. Exported for the graph simulator device. */
export function withGrowth(graph: GraphTemplateSpec, growth: readonly GraphGrowth[]): GraphTemplateSpec {
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

/** Return scheduler order for a bounded linear subgraph that ends at its declared resume node. */
function subscriptionAppendNodeOrder(proposal: GraphSubgraphAppendProposal): string[] {
  const nodeIds = proposal.nodes.map((node) => node.nodeId);
  const added = new Set(nodeIds);
  const edges = proposal.edges;
  const outcomeEdges = edges.filter((edge) => edge.on !== undefined || edge.map !== undefined || edge.branches !== undefined);
  const linearEdges = edges.filter((edge) => edge.on === undefined && edge.map === undefined && edge.branches === undefined);
  if (!proposal.reason.trim() || nodeIds.length === 0 || added.size !== nodeIds.length ||
    !added.has(proposal.entryNodeId) ||
    proposal.nodes.some((node) => !Number.isSafeInteger(node.maxVisits) || node.maxVisits < 1 || !node.recipe || !node.kind) ||
    linearEdges.some((edge) => edge.to === undefined || !added.has(edge.from) ||
      (!added.has(edge.to) && edge.to !== proposal.returnTo)) ||
    outcomeEdges.length > 1 || (outcomeEdges.length === 0 && proposal.failureTo !== undefined) ||
    (outcomeEdges.length === 1 && (!proposal.failureTo || outcomeEdges[0]!.on !== 'outcome' ||
      !outcomeEdges[0]!.map || outcomeEdges[0]!.branches !== undefined || outcomeEdges[0]!.to !== undefined ||
      !['error,fail,ok', 'error,fail,ok,recovery-required'].includes(Object.keys(outcomeEdges[0]!.map).sort().join(',')) ||
      outcomeEdges[0]!.map.ok !== proposal.returnTo || outcomeEdges[0]!.map.fail !== proposal.failureTo ||
      !outcomeEdges[0]!.map.fail || !added.has(outcomeEdges[0]!.from)))) {
    throw new Error('invalid saved subscriber graph append');
  }
  const outgoing = new Map<string, string>();
  for (const edge of linearEdges) {
    if (outgoing.has(edge.from)) throw new Error('invalid saved subscriber graph append');
    outgoing.set(edge.from, edge.to!);
  }
  const path: string[] = [];
  let cursor = proposal.entryNodeId;
  while (cursor !== proposal.returnTo) {
    if (!added.has(cursor) || path.includes(cursor)) throw new Error('invalid saved subscriber graph append');
    path.push(cursor);
    const next = outgoing.get(cursor);
    if (!next) {
      if (outcomeEdges.length === 1 && outcomeEdges[0]!.from === cursor) break;
      throw new Error('invalid saved subscriber graph append');
    }
    cursor = next;
  }
  if (path.length !== nodeIds.length || outgoing.size !== nodeIds.length - outcomeEdges.length ||
    (outcomeEdges.length === 1 && path.at(-1) !== outcomeEdges[0]!.from))
    throw new Error('invalid saved subscriber graph append');
  return path;
}

/** Restore subscriber-owned run-local subgraphs; each append is a bounded linear path ending at returnTo. */
function withSubscriptionGraphAppends(graph: GraphTemplateSpec,
  appends: NonNullable<GraphRunState['subscriptionGraphAppends']>): GraphTemplateSpec {
  return appends.reduce<GraphTemplateSpec>((current, append) => {
    const { proposal } = append;
    subscriptionAppendNodeOrder(proposal);
    const nodeIds = proposal.nodes.map((node) => node.nodeId);
    const outcomeEdge = proposal.edges.find((edge) => edge.on === 'outcome');
    const recoveryTarget = outcomeEdge?.map?.['recovery-required'] ?? outcomeEdge?.map?.error;
    const recoveryHitl = recoveryTarget && recoveryTarget !== proposal.failureTo
      ? current.nodes.find((node) => node.nodeId === recoveryTarget && node.kind === 'hitl' && node.recipe === 'approval:repair-recovery')
      : undefined;
    const failureHitl = proposal.failureTo ? current.nodes.find((node) => node.nodeId === proposal.failureTo && node.kind === 'hitl'
      && (node.recipe === 'approval:repair-recovery' || node.recipe === 'approval:gate-heal-decision')) : undefined;
    if (!current.nodes.some((node) => node.nodeId === proposal.returnTo) ||
      (proposal.failureTo !== undefined && !current.terminalNodes.includes(proposal.failureTo)
        && !failureHitl) ||
      (recoveryTarget !== undefined && recoveryTarget !== proposal.failureTo && !recoveryHitl) ||
      nodeIds.some((nodeId) => !nodeId || current.nodes.some((node) => node.nodeId === nodeId)))
      throw new Error('invalid saved subscriber graph append');
    return { ...current, nodes: [...current.nodes, ...proposal.nodes], edges: [...current.edges, ...proposal.edges] };
  }, graph);
}

function withAdaptiveGraphEdges(graph: GraphTemplateSpec,
  edges: NonNullable<GraphRunState['adaptiveGraphEdges']>, vocabulary: readonly string[]): GraphTemplateSpec {
  for (const edge of edges) {
    if (!graph.nodes.some((node) => node.nodeId === edge.from) || !graph.nodes.some((node) => node.nodeId === edge.to) ||
      !edge.triggerEvent.trim() || !edge.rationale.trim() || !vocabulary.includes(edge.triggerEvent))
      throw new Error('invalid saved adaptive graph edge');
  }
  return graph;
}

type ResolvedUnit = ResolvedGraphUnit & { readonly source?: string; readonly shapeHash?: string };
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
    if (node.shape && unit.definition !== 'component') {
      if (node.callEntry && (node.shape.skip ?? []).includes(node.callEntry))
        throw new Error(`unit shape cannot skip selected entry: ${node.nodeId} -> ${node.callEntry}`);
      const shaped = shapeGraphUnit(unit.source ?? readFileSync(unit.path, 'utf8'), unit.template, node.shape, unit.path);
      unit = { ...unit, template: shaped.template, source: shaped.source, shapeHash: shaped.shapeHash };
    }
    validateUnitCallsWithResolver(unit.template, unit.path, [...ancestors, graph.graphId], onMissing, resolve);
    result.set(node.nodeId, unit);
  }
  return result;
}

export async function runGraph(path: string, options: GraphRunOptions = {}): Promise<GraphRunState> {
  let lifecycleObserverQueue = Promise.resolve();
  const scopedContext = options.deps?.growthScope ?? graphGrowthScope.getStore();
  const envGrowthScope = process.env[GRAPH_GROWTH_SCOPE_ENV];
  // A separate Pod process cannot inherit AsyncLocalStorage. Only the explicit
  // harness handoff is trusted from env; task-agent remains an in-process scope.
  const growthScope = scopedContext ?? (envGrowthScope === 'harness' ? 'harness' : undefined);
  const rejectedGrowthScopeEnv = scopedContext === undefined && envGrowthScope !== undefined && envGrowthScope !== 'harness';
  if (options.resumeRunId && options.runId) throw new Error('runId and resumeRunId cannot be combined');
  if (options.resumeInputPatch && !options.resumeRunId) throw new Error('resumeInputPatch requires --resume');
  if (options.fromNodeId && !options.resumeRunId) throw new Error('--from requires --resume');
  if (options.fromVisitId && !options.resumeRunId) throw new Error('--from-visit requires --resume');
  if (options.fromVisitId && options.fromNodeId) throw new Error('--from and --from-visit cannot be combined');
  if (options.useCurrentGraph && !options.resumeRunId) throw new Error('--use-current-graph requires --resume');
  if (options.variant && options.resumeRunId) throw new Error('variant cannot be combined with --resume');
  if (options.releaseWaiver && (!options.resumeRunId || options.fromNodeId !== options.releaseWaiver.nodeId)) throw new Error('release waiver requires --resume --from <waived node>');
  if (options.releaseAcceptedRegressions && (!options.resumeRunId || !options.fromNodeId || options.releaseWaiver)) throw new Error('accepted regressions require a release resume boundary');
  if (options.releaseGateExecutor && (!options.resumeRunId || !options.fromNodeId)) throw new Error('gate executor override requires a release resume boundary');
  if (options.releaseGatePodPool !== undefined && (!options.resumeRunId || !options.fromNodeId)) throw new Error('gate pod pool override requires a release resume boundary');
  if (options.releaseGateShardReroute && (!options.resumeRunId || options.fromNodeId !== 'gate')) throw new Error('shard reroute requires release resume --from gate');
  const root = options.deps?.root ?? getTestStateRoot() ?? effectiveInstanceRoot();
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
  let source = graphMode === 'snapshot' ? readFileSync(join(snapshotDir!, 'graph.yaml'), 'utf8') : currentSource ?? options.graphSource ?? readFileSync(path, 'utf8');
  // Fan-out is an explicit release rehearsal input; ordinary runs retain the existing graph.
  const releaseFanoutInput = options.input && typeof options.input === 'object' && !Array.isArray(options.input)
    ? (options.input as Record<string, unknown>).releaseGateFanout === true : false;
  if (releaseFanoutInput && graphMode === 'current' && !options.resumeRunId && !options.graphSource
    && resolve(path).endsWith('/graphs/release/release-loop.yaml')) {
    source = readFileSync(join(dirname(resolve(path)), 'release-loop-fanout.yaml'), 'utf8');
  }
  // The shared YAML parser requires a recipe string. A command-less node in
  // this runner is represented internally as `none`, without changing that parser.
  const raw: unknown = parseYaml(source);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid graph: ${path}`);
  const document = raw as Record<string, unknown>;
  if (Array.isArray(document.nodes)) {
    document.nodes = document.nodes.map((node: unknown) => node && typeof node === 'object' && !Array.isArray(node) && !('recipe' in node)
      ? { ...node, recipe: 'none' } : node);
  }
  let graph: GraphTemplateSpec;
  let graphExtensionLedger: NonNullable<LowerGraphV2Result['ledgerExtensions']> | undefined;
  if (document.apiVersion === 'elanous.dev/graph/v2') {
    const lowered = lowerGraphV2(source, { label: path });
    if (!lowered.template || lowered.errors.length) throw new Error(lowered.errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
    graph = lowered.template;
    graphExtensionLedger = lowered.ledgerExtensions;
  } else {
    const parsed = parseGraphTemplateYaml(stringifyYaml(document), path);
    if (!parsed.template || parsed.errors.length) throw new Error(parsed.errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
    graph = parsed.template;
  }
  const variant = options.variant ? createGraphVariant({ template: graph, ...options.variant }) : undefined;
  if (variant && !variant.ok) throw new Error(`graph variant rejected: ${JSON.stringify(variant.rejections)}`);
  if (variant?.ok) graph = variant.template;
  if (graphExtensionLedger) graphExtensionLedger = { ...graphExtensionLedger, graphHash: graphVersionHash(graph) };
  const loopBudget = graphLoopBudget(graph);
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
      ...(edge.to === undefined ? { on: edge.on, ...(edge.map ? { map: edge.map } : {}),
        ...(edge.branches ? { branches: edge.branches, join: edge.join,
          ...(edge.warningBranches ? { warning_branches: edge.warningBranches } : {}) } : {}) } : { to: edge.to }),
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
  const graphManifest = loadGraphManifestForFile(graphFile, graph.graphId);
  if (graphManifest) assertGraphManifestTemplate(graphManifest, graph);
  const declaredRecipeFree = graphManifest && graph.nodes.every(node => node.recipe === 'none' ||
    (node.kind === 'hitl' && node.recipe.startsWith('hitl:') && graphManifest.hitl.includes(node.nodeId)) ||
    (node.kind === 'capability' && node.recipe.startsWith('cap:')));
  // A v2 graph with capability/verb nodes can be wholly declarative and need no command sidecar.
  const recipeSource = harnessLoopTemplate || ((declaredRecipeFree || document.apiVersion === 'elanous.dev/graph/v2') && !existsSync(recipePath))
    ? '{}\n' : readFileSync(recipePath, 'utf8');
  if (graphMode === 'snapshot' && saved?.graphSnapshot &&
    (createHash('sha256').update(source).digest('hex') !== saved.graphSnapshot.graphSha ||
      createHash('sha256').update(recipeSource).digest('hex') !== saved.graphSnapshot.recipesSha)) {
    throw new Error('graph snapshot changed since run started');
  }
  const recipes = recipesFor(path, recipeSource);
  const healEdges = declaredHealEdges(document, graph, graphHealManifest(graphFile, graph.graphId, owner?.path));
  const recipeIds = new Set(Object.keys(recipes));
  const catalogRoles = new Set(loadNodeCatalog().roles.keys());
  // Bind a human decision to the exact graph and recipe contents, not just its id or approval prompt.
  const approvalSourceHash = createHash('sha256').update(variantSource).update('\0').update(recipeSource).digest('hex');
  // Resolve all commands before executing any node; an unknown recipe must never produce a partial publication.
  for (const node of graph.nodes) {
    if (node.kind === 'classify' && node.recipe !== 'none') throw new Error(`classify node cannot execute a recipe: ${node.nodeId}`);
    const approvedInput = approvedInputBinding(node);
    if (approvedInput && (!graphManifest?.hitl.includes(approvedInput.nodeId) ||
      !graph.nodes.some(source => source.nodeId === approvedInput.nodeId && source.kind === 'hitl')))
      throw new Error(`invalid approved input source: ${node.nodeId}`);
    const requiredContract = requiredContractForNode(node);
    if (graphManifest) assertGraphManifestRecipeAllowed(graphManifest, node.recipe, recipeIds, node.requires, node);
    if (node.kind === 'capability') {
      continue;
    }
    if (node.recipe === 'none') continue;
    if (node.recipe.startsWith('handler:')) {
      requireInProcessHandler(node.recipe, node.nodeId, options.deps?.inProcessHandlers);
      continue;
    }
    const resolved = resolveNodeRecipe(node, recipes, catalogRoles, graphManifest);
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
      resolveNodeRecipe(node, recipes, catalogRoles, graphManifest).command?.command, graph.terminalNodes.includes(node.nodeId), graphManifest);
  }
  if (saved && graphId !== saved.graphId) {
    if (options.fromNodeId && graphMode === 'current') throw new Error('graph or recipes changed since failed run');
    throw new Error(`run identity mismatch: ${saved.graphId}/${saved.runId}`);
  }
  const runId = safeSegment(options.resumeRunId ?? options.runId ?? randomUUID());
  const eventSequenceBase = saved?.graphEventSequence ?? 0;
  let eventSequence = eventSequenceBase;
  let eventRunState: GraphRunState | undefined;
  let eventRunOwner: Pick<GraphRunState, 'pid' | 'pidStartedAt' | 'stoppedAt'> | undefined;
  let eventQueuePersistenceFailure: unknown;
  let persistEventState: (runState: GraphRunState, owner: Pick<GraphRunState, 'pid' | 'pidStartedAt' | 'stoppedAt'>) => void =
    (runState, owner) => {
      try {
        const persist = () => persistOwnedRun(runState, owner);
        if (runState === eventRunState) {
          options.deps?.beforePersist?.(runState);
          if (options.deps?.withPersistFence) options.deps.withPersistFence(runState, persist);
          else persist();
        } else persist();
      } catch (error) {
        eventQueuePersistenceFailure = error;
        throw error;
      }
    };
  const baseEventBus = options.eventBus ?? createGraphEventBus();
  const eventBus = createScopedGraphEventBus(baseEventBus, (input) => {
    const stableSequence = Math.max(eventBusSequences.get(baseEventBus) ?? 0,
      eventSequence, eventRunState?.graphEventSequence ?? eventSequenceBase) + 1;
    eventBusSequences.set(baseEventBus, stableSequence);
    eventSequence = stableSequence;
    if (eventRunState && eventRunOwner) {
      eventRunState.graphEventSequence = stableSequence;
    }
    return { ...input, eventId: `${graphId}:${runId}:${stableSequence}`, sequence: stableSequence,
      emittedAt: (options.eventNow?.() ?? new Date()).toISOString() } as GraphEvent;
  }, (event) => {
    if (!eventRunState || !eventRunOwner) return;
    eventRunState.pendingGraphEvents ??= [];
    if (!eventRunState.pendingGraphEvents.some((pending) => pending.eventId === event.eventId))
      eventRunState.pendingGraphEvents.push(event);
    persistEventState(eventRunState, eventRunOwner);
  }, (_scope, eventIds) => {
    if (!eventRunState || !eventRunOwner || eventIds.length === 0) return;
    const delivered = new Set(eventIds);
    const pendingApproval = eventRunState.pending;
    for (const event of eventRunState.pendingGraphEvents ?? []) {
      if (pendingApproval && delivered.has(event.eventId) && event.type === 'release-stage' && event.data?.state === 'wait' &&
          pendingApproval.nodeId === event.source.nodeId && !pendingApproval.notifiedAt) {
        eventRunState.pending = { ...pendingApproval, notifiedAt: new Date().toISOString() };
      }
    }
    eventRunState.pendingGraphEvents = (eventRunState.pendingGraphEvents ?? []).filter((event) => !delivered.has(event.eventId));
    persistEventState(eventRunState, eventRunOwner);
  });
  const useReleaseGraphEventAdapters = options.deps?.releaseGraphEventAdapters ??
    (process.env.NODE_ENV !== 'test' && process.env.BUN_TEST === undefined);
  eventBus.registerType('node-arrival');
  eventBus.registerType('node-leave');
  eventBus.registerType(RELEASE_GATE_FAILED_EVENT);
  if (!eventBus.hasType('release.gate.progress')) eventBus.registerType('release.gate.progress');
  if (!eventBus.hasType('release.gate.heartbeat-interrupted')) eventBus.registerType('release.gate.heartbeat-interrupted');
  if (isReleaseLoop) eventBus.registerType('release-stage');
  const lifecyclePhaseByType: Readonly<Record<string, GraphNodeLifecyclePhase>> = {
    'node-arrival': 'arrival', 'node-start': 'start', 'node-end': 'end', 'node-leave': 'leave',
  };
  eventBus.subscribe((event) => {
    const phase = lifecyclePhaseByType[event.type];
    const nodeId = event.source.nodeId;
    if (!phase || !nodeId) return;
    const visit = typeof event.data?.visit === 'number' ? event.data.visit : 0;
    const dryRun = event.data?.dryRun === true;
    const at = event.emittedAt;
    const extra = {
      ...(event.data?.outcome === 'ok' || event.data?.outcome === 'fail' ? { outcome: event.data.outcome } : {}),
      ...(typeof event.data?.nextNodeId === 'string' ? { nextNodeId: event.data.nextNodeId } : {}),
      ...(typeof event.data?.reason === 'string' ? { reason: event.data.reason } : {}),
    };
    publishInsideEvent({ kind: 'node.lifecycle', eventId: event.eventId, seq: event.sequence,
      source: 'graph-runner', phase, graphId: event.graphId, runId: event.runId, nodeId,
      attempt: visit, visit, dryRun, at, ...extra,
      data: { phase, visit, dryRun, at, ...extra } });
  });
  // Release gate progress is already run-scoped in the graph event bus. Relay only its display contract
  // to the authenticated operator stream; never forward arbitrary gate/node payloads or command output.
  eventBus.subscribe((event) => {
    if (event.graphId !== 'release-loop' || !event.runId) return;
    const raw = event.data ?? {};
    const data: Record<string, unknown> = {};
    for (const key of ['phase', 'shard', 'state', 'decision', 'reason', 'host', 'attemptId'] as const) {
      const value = raw[key];
      if (typeof value === 'string' && value.length <= 240) data[key] = redactSecretText(value).slice(0, 240);
    }
    for (const key of ['shardIndex', 'shardTotal', 'reuseCount', 'rerunCount', 'radiusInvalidatedCount', 'failureCount'] as const) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) data[key] = value;
    }
    if (raw.rerunReasons && typeof raw.rerunReasons === 'object' && !Array.isArray(raw.rerunReasons)) {
      const reasons = Object.fromEntries(Object.entries(raw.rerunReasons as Record<string, unknown>)
        .filter(([reason, count]) => reason.length <= 160 && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
        .map(([reason, count]) => [redactSecretText(reason).slice(0, 160), count]));
      if (Object.keys(reasons).length) data.rerunReasons = reasons;
    }
    publishInsideEvent({ kind: 'release.gate.progress', eventId: event.eventId, seq: event.sequence,
      graphId: event.graphId, runId: event.runId, nodeId: event.source.nodeId, at: event.emittedAt, data });
  }, { type: 'release.gate.progress' });
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
  const graphSubscriptionDisposers: (() => void)[] = [];
  const registeredGraphSubscriptionNodes = new Set<string>();
  const disposeGraphSubscriptions = (): void => { for (const dispose of graphSubscriptionDisposers.splice(0)) dispose(); };
  let disposeReleaseGraphEventAdapters: () => void = () => undefined;
  let disposeAdaptiveGateHealAdapter: () => void = () => undefined;
  type QueuedSubscriptionAction = NonNullable<GraphRunState['pendingSubscriptionActions']>[number];
  const pendingSubscriptionActions: QueuedSubscriptionAction[] = [];
  let subscriptionRunState: GraphRunState | undefined;
  const dispatchSubscription = async (dispatch: GraphSubscriptionDispatch): Promise<void> => {
    // A failed event delivery keeps the same envelope in the outbox. Its successful
    // subscribers must not enqueue the same durable action again when that envelope replays.
    const alreadyDispatched = subscriptionRunState?.subscriptionActions?.some((action) =>
      action.eventId === dispatch.event.eventId && action.subscriberId === dispatch.subscriberId) === true ||
      (subscriptionRunState?.pendingSubscriptionActions ?? []).some((action) =>
        action.event.eventId === dispatch.event.eventId && action.subscriberId === dispatch.subscriberId);
    // A subscriber may install a matching run-local edge in its callback below.
    // The scheduler validates reroutes after dispatch, once that proposal is durable.
    if (!alreadyDispatched) {
      if (dispatch.action === 'invalidate') {
        const record = [...(subscriptionRunState?.nodes ?? [])].reverse().find((item) => item.nodeId === dispatch.nodeId);
        if (!record) {
          logSubscriptionAction('rejected', dispatch, 'no prior node result exists to invalidate');
          return;
        }
        record.output = undefined;
        record.invalidatedByEvent = dispatch.event.eventId;
      }
      const queued: QueuedSubscriptionAction = { subscriberId: dispatch.subscriberId, nodeId: dispatch.nodeId,
        action: dispatch.action, event: dispatch.event };
      pendingSubscriptionActions.push(queued);
      if (subscriptionRunState) {
        subscriptionRunState.pendingSubscriptionActions = [...pendingSubscriptionActions];
      }
      logSubscriptionAction('queued', dispatch);
      if (subscriptionRunState) persistOwnedRun(subscriptionRunState, eventRunOwner!);
    }
    await options.deps?.dispatchGraphSubscription?.({ ...dispatch,
      eventVocabulary: { registerType: (type) => {
        if (!type.trim()) throw new Error('adaptive graph event type must be non-empty');
        if (!eventBus.hasType(type)) eventBus.registerType(type);
        const state = subscriptionRunState;
        if (state && eventRunOwner) {
          state.adaptiveGraphVocabulary ??= [];
          if (!state.adaptiveGraphVocabulary.includes(type)) {
            state.adaptiveGraphVocabulary.push(type);
            persistOwnedRun(state, eventRunOwner);
          }
        }
      }, hasType: (type) => eventBus.hasType(type) },
      proposeEdge: async (proposal) => {
        const state = subscriptionRunState;
        if (!state || !eventRunOwner) return { disposition: 'rejected', reason: 'run state is not ready' };
        if (proposal.mode === 'shadow') {
          if (!proposal.unmeasuredAxis.trim()) throw new Error('shadow graph edge proposal requires a non-empty unmeasuredAxis');
          return { disposition: 'shadow', unmeasuredAxis: proposal.unmeasuredAxis, reason: 'N21 adaptive graph changes are live by default; shadow requires an explicitly measured simulation gap' };
        }
        if (!proposal.rationale.trim() || !proposal.triggerEvent.trim()) return { disposition: 'rejected', reason: 'edge proposal requires a trigger event and rationale' };
        if (proposal.from !== dispatch.event.source.nodeId || proposal.to !== dispatch.nodeId)
          return { disposition: 'rejected', reason: 'adaptive edge endpoints must be the triggering node and subscribed node' };
        if (!graph.nodes.some((node) => node.nodeId === proposal.from) || !graph.nodes.some((node) => node.nodeId === proposal.to))
          return { disposition: 'rejected', reason: 'adaptive edge endpoints must exist in the active graph' };
        const policyResult = await options.deps?.proposeGraphEdge?.(proposal);
        if (policyResult && policyResult.disposition !== 'added') return policyResult;
        const prior = (state.adaptiveGraphEdges ?? []).find((edge) => edge.eventId === dispatch.event.eventId && edge.subscriberId === dispatch.subscriberId);
        if (prior) {
          const sameProposal = prior.from === proposal.from && prior.to === proposal.to && prior.triggerEvent === proposal.triggerEvent && prior.rationale === proposal.rationale;
          return sameProposal ? { disposition: 'added', reason: 'duplicate proposal already installed' }
            : { disposition: 'rejected', reason: 'subscriber already proposed a different edge for this event' };
        }
        try {
          graph = withAdaptiveGraphEdges(graph, [{ ...proposal, eventId: dispatch.event.eventId, subscriberId: dispatch.subscriberId }],
            [...(state.adaptiveGraphVocabulary ?? []), proposal.triggerEvent]);
        } catch (error) { return { disposition: 'rejected', reason: error instanceof Error ? error.message : String(error) }; }
        if (!eventBus.hasType(proposal.triggerEvent)) eventBus.registerType(proposal.triggerEvent);
        state.adaptiveGraphVocabulary ??= [];
        if (!state.adaptiveGraphVocabulary.includes(proposal.triggerEvent)) state.adaptiveGraphVocabulary.push(proposal.triggerEvent);
        state.adaptiveGraphEdges ??= [];
        state.adaptiveGraphEdges.push({ ...proposal, eventId: dispatch.event.eventId, subscriberId: dispatch.subscriberId });
        state.graphRevision = (state.graphRevision ?? 1) + 1;
        persistOwnedRun(state, eventRunOwner);
        try { (options.deps?.log ?? ((event, data) => debug.log('graph.runner', event, data)))('adaptive-graph-edge-added', {
          graphId, runId, eventId: dispatch.event.eventId, subscriberId: dispatch.subscriberId, ...proposal,
        }); } catch { /* persisted graph mutation is authoritative */ }
        return { disposition: 'added', reason: 'event vocabulary and run-local edge persisted' };
      }, appendGraph: async (proposal: GraphSubgraphAppendProposal) => {
      const state = subscriptionRunState;
      if (!state || !eventRunOwner) return { disposition: 'rejected', reason: 'run state is not ready' };
      if (!proposal.reason?.trim() || !Array.isArray(proposal.nodes) || !Array.isArray(proposal.edges))
        return { disposition: 'rejected', reason: 'append requires nodes, edges, and a reason' };
      const prior = (state.subscriptionGraphAppends ?? []).find((append) =>
        append.eventId === dispatch.event.eventId && append.subscriberId === dispatch.subscriberId);
      if (prior) return { disposition: 'duplicate', nodeId: prior.proposal.entryNodeId };
      const nodeIds = proposal.nodes.map((node) => node.nodeId);
      if (nodeIds.length === 0) return { disposition: 'rejected', reason: 'append requires at least one node' };
      const existingAppend = (state.subscriptionGraphAppends ?? []).find((append) =>
        JSON.stringify(append.proposal) === JSON.stringify(proposal));
      if (existingAppend) return { disposition: 'duplicate', nodeId: existingAppend.proposal.entryNodeId };
      if (nodeIds.some((nodeId) => graph.nodes.some((node) => node.nodeId === nodeId)))
        return { disposition: 'rejected', nodeId: nodeIds[0], reason: 'append node id already exists in this run' };
      const record = { proposal, eventId: dispatch.event.eventId, subscriberId: dispatch.subscriberId };
      let appendedGraph: GraphTemplateSpec;
      let appendNodeOrder: string[];
      try {
        appendNodeOrder = subscriptionAppendNodeOrder(proposal);
        appendedGraph = withSubscriptionGraphAppends(graph, [record]);
      }
      catch (error) { return { disposition: 'rejected', nodeId: nodeIds[0], reason: error instanceof Error ? error.message : String(error) }; }
      for (const node of proposal.nodes) {
        try {
          requiredContractForNode(node);
          if (graphManifest) assertGraphManifestRecipeAllowed(graphManifest, node.recipe, recipeIds, node.requires, node);
          const inProcessHandler = requireInProcessHandler(node.recipe, node.nodeId, options.deps?.inProcessHandlers);
          const resolved = resolveNodeRecipe(node, recipes, catalogRoles, graphManifest);
          if (!inProcessHandler && node.kind !== 'gate' && node.kind !== 'subgraph' && node.recipe !== 'none' &&
              !resolved.command && !resolved.prompt && !resolved.approval)
            return { disposition: 'rejected', nodeId: node.nodeId, reason: `unknown command recipe for ${node.nodeId}: ${node.recipe}` };
          if (enforceReleaseCommandBindings)
            assertReleaseCommandBinding(node, resolved.command?.command, appendedGraph.terminalNodes.includes(node.nodeId), graphManifest);
        } catch (error) {
          return { disposition: 'rejected', nodeId: node.nodeId, reason: error instanceof Error ? error.message : String(error) };
        }
      }
      state.subscriptionGraphAppends ??= [];
      state.subscriptionGraphAppends.push(record);
      graph = appendedGraph;
      registerGraphSubscriptionNodes(proposal.nodes);
      const outcomeMap = proposal.edges.find((edge) => edge.on === 'outcome')?.map;
      const errorTo = outcomeMap?.error;
      const recoveryTo = outcomeMap?.['recovery-required'];
      const appendedAction = { subscriberId: `${dispatch.subscriberId}/append:${proposal.entryNodeId}`,
        nodeId: proposal.entryNodeId, action: 'wake' as const, event: dispatch.event, returnTo: proposal.returnTo,
        ...(proposal.failureTo === undefined ? {} : { failureTo: proposal.failureTo }),
        ...(errorTo === undefined || errorTo === proposal.failureTo ? {} : { errorTo }),
        ...(recoveryTo === undefined ? {} : { recoveryTo }),
        appendNodeIds: appendNodeOrder };
      pendingSubscriptionActions.push(appendedAction);
      state.pendingSubscriptionActions = [...pendingSubscriptionActions];
      logSubscriptionAction('queued', { ...dispatch, subscriberId: appendedAction.subscriberId,
        nodeId: proposal.entryNodeId, action: 'wake' });
      persistOwnedRun(state, eventRunOwner);
      try { (options.deps?.log ?? ((event, data) => debug.log('graph.runner', event, data)))('subscription-graph-appended', {
        graphId, runId, eventId: dispatch.event.eventId, subscriberId: dispatch.subscriberId,
        entryNodeId: proposal.entryNodeId, nodeIds, returnTo: proposal.returnTo, reason: proposal.reason,
      }); } catch { /* append is persisted; observation must not undo it */ }
      return { disposition: 'appended', nodeId: proposal.entryNodeId };
    } });
  };
  const logSubscriptionAction = (outcome: 'queued' | 'handled' | 'rejected', dispatch: Pick<GraphSubscriptionDispatch, 'event' | 'subscriberId' | 'nodeId' | 'action'>, reason?: string): void => {
    const action = { eventId: dispatch.event.eventId, subscriberId: dispatch.subscriberId, nodeId: dispatch.nodeId,
      action: dispatch.action, outcome, ...(reason === undefined ? {} : { reason }), at: new Date().toISOString() };
    if (subscriptionRunState) {
      subscriptionRunState.subscriptionActions ??= [];
      subscriptionRunState.subscriptionActions.push(action);
    }
    try { (options.deps?.log ?? ((event, data) => debug.log('graph.runner', event, data)))('subscription-action', action); }
    catch { /* observation must not change graph execution */ }
  };
  const registerGraphSubscriptionNodes = (nodes: readonly GraphNodeSpec[]): void => {
    if (!eventBus) return;
    const fresh = nodes.filter((node) => !registeredGraphSubscriptionNodes.has(node.nodeId));
    for (const node of fresh) {
      registeredGraphSubscriptionNodes.add(node.nodeId);
      for (const eventType of [...(node.emits ?? []), ...(node.subscribes ?? []).map((subscription) => subscription.event)])
        if (!eventBus.hasType(eventType)) eventBus.registerType(eventType);
    }
    const subscribing = fresh.filter((node) => (node.subscribes?.length ?? 0) > 0);
    if (subscribing.length > 0) graphSubscriptionDisposers.push(registerGraphSubscriptions(eventBus, subscribing,
      dispatchSubscription, { scope: { graphId, runId }, proposeEdge: options.deps?.proposeGraphEdge }));
  };
  try {
  for (const eventType of saved?.adaptiveGraphVocabulary ?? []) if (!eventBus.hasType(eventType)) eventBus.registerType(eventType);
  registerGraphSubscriptionNodes(graph.nodes);
  if (eventBus && isReleaseLoop && useReleaseGraphEventAdapters) disposeReleaseGraphEventAdapters = registerReleaseGraphEventAdapters(eventBus,
    { graphId, runId, dryRun: options.resumeRunId ? saved?.dryRun === true : options.dryRun === true }, { root, ...(options.deps?.releaseStageMail ? { stageMail: options.deps.releaseStageMail } : {}),
      ...(options.deps?.log ? { log: options.deps.log } : {}) });
  const startMs = (options.deps?.processStartMs ?? psProcessStartMs)(process.pid);
  const runnerOwner = { pid: process.pid, pidStartedAt: new Date(startMs ?? Date.now() - process.uptime() * 1_000).toISOString() };
  const state: GraphRunState = options.resumeRunId
    ? readGraphRun(graphId, runId, root)
    : { graphId, runId, startedAt: new Date().toISOString(), ...runnerOwner, status: 'running', path: [], nodes: [], sourceHash: approvalSourceHash,
      graphSnapshot: { graphSha: createHash('sha256').update(variantSource).digest('hex'), recipesSha: createHash('sha256').update(recipeSource).digest('hex') },
      ...(graphExtensionLedger ? { graphExtensionLedger } : {}),
      graphPath: resolve(path), ...(variant?.ok ? { variant: { overlayId: variant.overlay.overlayId, ...options.variant! } } : {}),
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.unitContext?.entryNodeId === undefined ? {} : { entryNodeId: options.unitContext.entryNodeId }),
      executed: 0, dryRun: options.dryRun === true, graphRevision: 1, statePath };
  if (options.resumeRunId && state.status === 'cancelled') throw new Error(`cancelled graph run cannot be resumed: ${graphId}/${runId}`);
  if (graphExtensionLedger) {
    if (state.graphExtensionLedger && JSON.stringify(state.graphExtensionLedger) !== JSON.stringify(graphExtensionLedger))
      throw new Error('graph extension ledger changed since run started');
    state.graphExtensionLedger ??= graphExtensionLedger;
  }
  const ownLoopBudgetScope: GraphLoopBudgetScope[] = loopBudget.llmCalls === undefined ? [] : [{ graphId, runId, llmCalls: loopBudget.llmCalls }];
  const loopBudgetScopes = [...(options.loopBudgetScopes ?? []), ...ownLoopBudgetScope];
  const callLLM = options.deps?.callLLM === undefined ? undefined : async (prompt: string): Promise<string> => {
    reserveGraphProviderCalls(root, loopBudgetScopes);
    return options.deps!.callLLM!(prompt);
  };
  const growthLLM = options.deps?.growthLLM === undefined ? undefined : async (prompt: string): Promise<string> => {
    reserveGraphProviderCalls(root, loopBudgetScopes);
    return options.deps!.growthLLM!(prompt);
  };
  eventRunState = state;
  eventRunOwner = runnerOwner;
  subscriptionRunState = state;
  if (options.fromVisitId) {
    const matches = state.nodes.filter((record) => record.executionId === options.fromVisitId);
    if (matches.length !== 1) throw new Error(`--from-visit must identify one saved node execution: ${options.fromVisitId}`);
    options = { ...options, fromNodeId: matches[0]!.nodeId };
  }
  state.graphRevision ??= 1;
  pendingSubscriptionActions.push(...(state.pendingSubscriptionActions ?? []));
  const branchResume = options.fromNodeId ? Object.values(state.fanOuts ?? {}).flatMap((fanout) =>
    fanout.branches[options.fromNodeId!] !== undefined ? [{ fanout, branchId: options.fromNodeId! }] : [])[0] : undefined;
  if (branchResume) {
    throw new Error(`--from cannot resume fan-out branch '${branchResume.branchId}'; resume from fan-out source '${branchResume.fanout.from}' instead`);
  }
  const verifyReleaseSource = (): string | undefined => {
    const source = options.releaseCommandSource;
    if (!source) return undefined;
    const savedCutTip = lastJsonObject(state.nodes.find((node) => node.nodeId === 'version-release')?.output)?.commit ?? options.branchCutTip;
    if (graphId !== 'release-loop' || (!options.resumeRunId && !options.branchCutTip) || typeof savedCutTip !== 'string' || source.cutTip !== savedCutTip) {
      throw new Error('release command source differs from the saved cut tip');
    }
    const commandRoot = verifyReleaseCommandRoot(source.root, savedCutTip, source.git);
    // The ledger snapshot must be the recipe that the cut checkout actually carries.
    // HEAD alone does not bind a saved graph to that checkout.
    verifyReleaseRecipeSnapshot(commandRoot, options.branchGraphSnapshot ?? state.graphSnapshot);
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
  if (state.subscriptionGraphAppends?.length) {
    graph = withSubscriptionGraphAppends(graph, state.subscriptionGraphAppends);
    registerGraphSubscriptionNodes(state.subscriptionGraphAppends.flatMap((append) => append.proposal.nodes));
  }
  if (state.adaptiveGraphEdges?.length) graph = withAdaptiveGraphEdges(graph, state.adaptiveGraphEdges, state.adaptiveGraphVocabulary ?? []);
  let waivedRecord: GraphRunState['nodes'][number] | undefined;
  if (options.resumeRunId && options.resumeInputPatch) {
    if (!state.input || typeof state.input !== 'object' || Array.isArray(state.input)) throw new Error('cannot patch non-object saved graph input');
    state.input = { ...(state.input as Record<string, unknown>), ...options.resumeInputPatch };
  }
  let savedGateUnmeasured: string | undefined;
  if (options.fromNodeId) {
    const budgetResume = options.releaseBudgetExceededResume;
    if (budgetResume && (graphId !== 'release-loop' || !budgetResume.reason.trim() || state.status !== 'budget-exceeded'))
      throw new Error('--resume-budget-exceeded requires a budget-exceeded release-loop run and a reason');
    if (state.status !== 'failed' && state.status !== 'paused' && !(budgetResume && state.status === 'budget-exceeded')) {
      if (state.status === 'budget-exceeded') throw new Error(`release run ${runId} is budget-exceeded — use --resume-budget-exceeded --reason <text>`);
      throw new Error('--from requires a failed, non-dry run without pending approval (or a paused run)');
    }
    if (state.pending || state.dryRun) throw new Error('--from requires a failed, non-dry run without pending approval');
    if (graphMode === 'current' && (!state.sourceHash || state.sourceHash !== approvalSourceHash)) throw new Error('graph or recipes changed since failed run');
    // A visit selector names one exact execution; the legacy node selector keeps its latest-visit behavior.
    const from = options.fromVisitId
      ? state.nodes.findIndex((record) => record.executionId === options.fromVisitId)
      : state.path.lastIndexOf(options.fromNodeId);
    if (from < 0 || graph.terminalNodes.includes(options.fromNodeId)) throw new Error(`--from node is not on the saved executable path: ${options.fromNodeId}`);
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
        const priorEdge = graph.edges.find((candidate) => candidate.from === prior.nodeId);
        const exitOutcome = prior.ok ? 'ok' : 'fail';
        const namedOutcome = typeof reported === 'string' ? reported : undefined;
        const branchOutcome = priorEdge?.branches && namedOutcome && Object.hasOwn(priorEdge.branches, namedOutcome)
          ? namedOutcome : priorEdge?.branches && Object.hasOwn(priorEdge.branches, exitOutcome) ? exitOutcome : undefined;
        const next = branchOutcome !== undefined && priorEdge?.join
          ? priorEdge.join : nextNode(graph.edges, prior.nodeId, exitOutcome, namedOutcome);
        const priorVisit = state.path.slice(0, i - 1).filter((nodeId) => nodeId === prior.nodeId).length + 1;
        const declaredHealTransition = (state.healTransitions ?? []).some((item) => item.from === prior.nodeId
          && item.visit === priorVisit && item.to === recorded.nodeId
          && healEdges.some((edge) => edge.edgeRef === item.edgeRef));
        const adaptiveAppend = (state.adaptiveGateNodeAppends ?? []).find(({ eventId, request }) => {
          const nodeId = request.node.nodeId;
          const repairNode = (request.node.recipe === 'cmd:gate-repair' && /^gate-repair-[a-f0-9]{12}$/.test(nodeId)) ||
            (request.node.recipe === 'cmd:gate-image-repair' && /^gate-image-repair-[a-f0-9]{12}$/.test(nodeId));
          if (eventId !== request.eventId || request.graphId !== graphId || request.runId !== runId ||
            request.afterNodeId !== 'gate-triage' || request.rerunGateAt !== 'gate' || !repairNode) return false;
          const appended = (state.subscriptionGraphAppends ?? []).find((append) => append.eventId === eventId &&
            append.subscriberId === 'arg-adaptive-gate-heal' &&
            append.proposal.entryNodeId === nodeId && append.proposal.returnTo === request.rerunGateAt &&
            append.proposal.nodes.some((node) => node.nodeId === nodeId &&
              JSON.stringify(node) === JSON.stringify(request.node)) &&
            append.proposal.edges.some((edge) => edge.from === nodeId && edge.on === 'outcome' &&
              edge.map?.ok === request.rerunGateAt && edge.map?.fail === append.proposal.failureTo &&
              edge.map?.error === append.proposal.failureTo));
          if (!appended || request.resumeFrom !== nodeId) return false;
          return (prior.nodeId === request.afterNodeId && recorded.nodeId === nodeId) ||
            (prior.nodeId === nodeId && recorded.nodeId === request.rerunGateAt);
        });
        if (next !== recorded.nodeId && !adaptiveAppend && !declaredHealTransition) {
          throw new Error(`saved run path does not follow graph edges: ${prior.nodeId} -> ${recorded.nodeId}, expected ${next ?? '<terminal>'}`);
        }
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
      const approved = resolveNodeRecipe(spec, recipes, catalogRoles, graphManifest).approval;
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
    if (resolveNodeRecipe(graph.nodes.find((node) => node.nodeId === options.fromNodeId)!, recipes, catalogRoles, graphManifest).approval) {
      throw new Error('--from cannot restart an approval node');
    }
    if (options.releaseWaiver) {
      if (graphId !== 'release-loop') throw new Error('release waiver requires the release-loop graph');
      if (options.releaseWaiver.nodeId === 'gate') savedGateUnmeasured = gateUnmeasuredDetail(state, from);
      const checked = releaseResumeWaiver(state, { from: options.fromNodeId, waive: options.releaseWaiver.ownerWaived ? undefined : options.releaseWaiver.nodeId, ownerWaive: options.releaseWaiver.ownerWaived ? options.releaseWaiver.nodeId : undefined, reason: options.releaseWaiver.reason, acceptedRegressions: options.releaseWaiver.requestedRegressions, approvedBy: options.releaseWaiver.approvedBy });
      if (!checked || JSON.stringify(checked.acceptedRegressions) !== JSON.stringify(options.releaseWaiver.acceptedRegressions) ||
        checked.unmeasured !== options.releaseWaiver.unmeasured || savedGateUnmeasured !== options.releaseWaiver.unmeasured || checked.approvedBy !== options.releaseWaiver.approvedBy ||
        JSON.stringify(checked.introducedIds ?? []) !== JSON.stringify(options.releaseWaiver.introducedIds ?? []) || checked.ownerWaived !== options.releaseWaiver.ownerWaived) throw new Error('release waiver input changed before restart');
      if (!releaseRouteReachesKnownIssues(graph.edges, nextNode(graph.edges, options.fromNodeId, 'ok', 'ok') ?? '')) {
        throw new Error('waived node must reach known-issues before publication');
      }
    }
    if (options.releaseAcceptedRegressions) {
      if (graphId !== 'release-loop') throw new Error('accepted regressions require the release-loop graph');
      if (!releaseRouteReachesKnownIssues(graph.edges, options.fromNodeId)) {
        throw new Error('accepted regressions must reach known-issues before publication');
      }
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
    if (options.resumeInputPatch) {
      if (!state.input || typeof state.input !== 'object' || Array.isArray(state.input)) throw new Error('cannot patch non-object saved graph input');
      state.input = { ...(state.input as Record<string, unknown>), ...options.resumeInputPatch };
    }
    const resumedFromStatus = state.status;
    const priorUnitCalls = state.unitCalls?.length ?? 0;
    if (state.unitCalls) {
      const calls = state.unitCalls;
      state.unitCalls = calls.filter(call => {
        const keep = state.path.slice(0, from).filter(nodeId => nodeId === call.node).length;
        return calls.filter(item => item.node === call.node).indexOf(call) < keep;
      });
    }
    const priorExecuted = state.executed;
    state.path = state.path.slice(0, from);
    state.nodes = state.nodes.slice(0, from);
    state.executed = state.nodes.filter((node) => node.executed).length;
    state.status = 'running';
    delete state.stoppedAt;
    delete state.pausedAt;
    Object.assign(state, runnerOwner);
    const resumedAt = new Date().toISOString();
    state.resume = { from: options.fromNodeId, ...(options.fromVisitId ? { visitId: options.fromVisitId } : {}), at: resumedAt,
      previousStatus: budgetResume ? 'budget-exceeded' : resumedFromStatus, graph: graphMode,
      ...(budgetResume ? { budgetReset: { reason: budgetResume.reason.trim(), at: resumedAt, priorExecuted, resumedPrefixExecuted: state.executed,
        priorUnitCalls, resumedPrefixUnitCalls: state.unitCalls?.length ?? 0 } } : {}) };
    if (budgetResume) debug.log('graph.runs', 'budget-exceeded-resume', { graphId, runId, from: options.fromNodeId,
      reason: budgetResume.reason.trim(), priorExecuted, resumedPrefixExecuted: state.executed, priorUnitCalls,
      resumedPrefixUnitCalls: state.unitCalls?.length ?? 0 });
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
      const currentCommand = resolveNodeRecipe(parked.growth.node, recipes, catalogRoles, graphManifest).command;
      const currentApproval = resolveNodeRecipe(parked.growth.node, recipes, catalogRoles, graphManifest).approval?.approval;
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
      state.growthEvents ??= [];
      state.growthEvents.push({ phase: 'applied', from: parked.from, outcome: parked.outcome, at: new Date().toISOString(),
        nodeId: parked.growth.node.nodeId, kind: parked.growth.node.kind });
      state.growthEvents.push({ phase: 'undo-available', from: parked.from, outcome: parked.outcome, at: new Date().toISOString(),
        nodeId: parked.growth.node.nodeId, undo: parked.growth.undo });
      state.growthRejections!.pop();
    } else {
      state.growthEvents ??= [];
      state.growthEvents.push({ phase: 'rejected', from: parked.from, outcome: parked.outcome, at: new Date().toISOString(),
        nodeId: parked.growth.node.nodeId, kind: parked.growth.node.kind, reason: 'human rejected growth proposal' });
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
  if (options.resumeRunId && state.status !== 'awaiting-approval' && state.status !== 'running' && state.status !== 'paused') {
    throw new Error(`run is not awaiting approval: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && (state.graphId !== graphId || state.runId !== runId)) {
    throw new Error(`run is not awaiting approval: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && state.status === 'awaiting-approval' && state.approvalSourceHash !== approvalSourceHash) {
    throw new Error(`approval source changed since run was paused: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && state.status === 'awaiting-approval' && state.pending && !state.pending.inputSha256) {
    const pendingNode = graph.nodes.find(node => node.nodeId === state.pending!.nodeId);
    const template = pendingNode && resolveNodeRecipe(pendingNode, recipes, catalogRoles, graphManifest).approval?.approval;
    if (!template) throw new Error(`legacy approval node is no longer declared: ${state.pending.nodeId}`);
    const oldClaim = approvalDecisionPath(state);
    const approvalNonce = randomUUID();
    if (existsSync(oldClaim)) renameSync(oldClaim, `${oldClaim}.legacy-${approvalNonce}`);
    state.pending = { nodeId: state.pending.nodeId, message: approvalMessage(template, state.input, isReleaseLoop),
      since: new Date().toISOString(), inputSha256: stableSha256(state.input), approvalNonce };
    persistOwnedRun(state, saved!);
  }
  if (options.resumeRunId && state.status === 'awaiting-approval' && state.pending?.inputSha256 !== undefined &&
    state.pending.inputSha256 !== stableSha256(state.input))
    throw new Error(`approval input changed since card was shown: ${graphId}/${runId}`);
  if (options.resumeRunId && !options.fromNodeId) {
    const previousStatus = state.status;
    if (previousStatus === 'paused') {
      state.status = 'running';
      delete state.pausedAt;
      delete state.reason;
    }
    Object.assign(state, runnerOwner);
    state.resume = { from: state.pending?.nodeId ?? state.path.at(-1) ?? unitEntryNode, at: new Date().toISOString(), previousStatus, graph: graphMode };
    persistOwnedRun(state, saved!);
  }
  if (options.resumeRunId) debug.log('graph.runs', 'resume', { graphId, runId, from: state.resume?.from, graph: graphMode });
  const persist = () => {
    if (state.status === 'done' || state.status === 'failed' || state.status === 'cancelled' || state.status === 'budget-exceeded') state.finishedAt ??= new Date().toISOString();
    persistEventState(state, runnerOwner);
  };
  let releaseOpCursor = 0;
  let releaseOpState: ReleaseOpState = emptyReleaseOpState();
  const emitReleaseStage = async (nodeId: string, stage: ReleaseStageState): Promise<boolean> => {
    const releaseOpChannelActive = graphId === 'release-loop' || options.deps?.releaseOpChannel === true;
    const sendStage = async (event: { runId: string; nodeId: string; state: ReleaseStageState }): Promise<boolean> => {
      if (eventBus && isReleaseLoop && useReleaseGraphEventAdapters) {
        try {
          await eventBus.publish({ graphId, runId, type: 'release-stage', source: { kind: 'runner', nodeId: event.nodeId },
            data: { state: event.state, dryRun: state.dryRun } });
          await eventBus.flush({ graphId, runId });
          return true;
        } catch (error) {
          try { debug.log('release-loop.stage-mail', 'event-delivery-failed', { runId, nodeId: event.nodeId, state: event.state, error: String(error).slice(0, 300) }, { level: 'warn' }); }
          catch { /* delivery failure must not change graph execution */ }
          return false;
        }
      }
      return emitReleaseStageTransition(graphId, state.dryRun, event,
        options.deps?.releaseStageMail ?? ((mail) => postReleaseStageMail(mail, {
          configPath: join(root, 'config.json'),
          openStore: () => openMsgStore(join(root, 'msg', 'messages.db')),
        })));
    };
    if (!releaseOpChannelActive || state.dryRun) return sendStage({ runId, nodeId, state: stage });
    let stageSent = true;
    try {
      const store = openMsgStore(join(root, 'msg', 'messages.db'));
      try {
        const writeReleaseEvent = (event: ReleaseOpEvent) => {
          // The release graph adapters already publish the stage to OP with its stable graph event id.
          // Keep held events durable for resume, but avoid a duplicate unkeyed progress message.
          if (isReleaseLoop && useReleaseGraphEventAdapters && !event.held) return;
          return options.deps?.releaseOpEventWriter
            ? options.deps.releaseOpEventWriter(store, event) : recordReleaseOpEvent(store, event);
        };
        let page = store.listByRecipient('RLA', releaseOpCursor, 1000);
        while (page.length > 0) {
          let resumeFlushFailed = false;
          for (const message of page) {
            if (message.kind === 'rla-held-event') {
              let held: ReleaseOpState['bufferedEvents'][number];
              try { held = parseReleaseOpBufferedEvent(message.body); }
              catch { releaseOpCursor = message.id; continue; /* malformed ledger row is ignored */ }
              if (releaseOpState.held) releaseOpState = { ...releaseOpState, bufferedEvents: [...releaseOpState.bufferedEvents, held] };
              else {
                writeReleaseEvent({ ...held, held: false });
                if (!await sendStage({ runId: held.runId, nodeId: held.nodeId, state: held.state }))
                  throw new Error(`RLA deferred stage mail delivery failed: ${held.nodeId}/${held.state}`);
              }
              releaseOpCursor = message.id;
              continue;
            }
            if (message.from !== 'OP') { releaseOpCursor = message.id; continue; }
            if (message.kind === 'rla-question') {
              const question = message.body.trim();
              const why = /\bwhy\b|왜|이유|근거/i.test(question);
              const holdStatus = /\bhold\b|보류|멈춤/i.test(question);
              const target = question.match(/(?:why|이유|근거)\s+([A-Za-z0-9_-]+)/i)?.[1] ?? state.currentNode?.nodeId;
              const record = target ? [...state.nodes].reverse().find(item => item.nodeId === target) ?? null : null;
              const answer = why
                ? { question, node: target ?? null, record, explanation: record?.error ?? (record ? JSON.stringify(record.output ?? record) : '해당 노드의 실행 기록이 아직 없습니다') }
                : holdStatus ? { question, held: releaseOpState.held, bufferedEvents: releaseOpState.bufferedEvents.length }
                  : { question, status: state.status, currentNode: state.currentNode?.nodeId ?? null, path: state.path };
              store.appendWithProvenance({ from: 'RLA', to: 'OP', kind: 'report', replyTo: message.id,
                body: `RLA answer · ${JSON.stringify(answer)}` }, `rla-question-reply:${message.id}:OP`);
              releaseOpCursor = message.id;
              continue;
            }
            if (message.kind !== 'rla-command') { releaseOpCursor = message.id; continue; }
            let command: ReturnType<typeof parseReleaseOpCommand>;
            try { command = parseReleaseOpCommand(message.body); }
            catch (error) {
              store.appendWithProvenance({ from: 'RLA', to: 'OP', kind: 'alert',
                body: `RLA command rejected · message=${message.id} · ${String(error).slice(0, 300)}` }, `rla-command-reply:${message.id}:OP`);
              releaseOpCursor = message.id;
              continue;
            }
            const wasHeld = releaseOpState.held;
            const bufferedBeforeResume = releaseOpState.bufferedEvents;
            const nextOpState = applyReleaseOpCommand(releaseOpState, command);
            if (command.verb === 'resume' && wasHeld) {
              // Do not consume the resume command until every durable event has been flushed.
              for (const buffered of bufferedBeforeResume) {
                try {
                  writeReleaseEvent({ ...buffered, held: false });
                  if (!await sendStage({ runId: buffered.runId, nodeId: buffered.nodeId, state: buffered.state })) {
                    resumeFlushFailed = true; break;
                  }
                } catch { resumeFlushFailed = true; break; }
              }
              if (resumeFlushFailed) break;
              releaseOpState = { ...nextOpState, bufferedEvents: [] };
            } else releaseOpState = nextOpState;
            const details = command.verb === 'status'
              ? { graphId, runId, status: state.status, currentNode: state.currentNode?.nodeId ?? null, path: state.path, nodes: state.nodes, op: releaseOpState }
              : command.verb === 'why'
                ? { graphId, runId, node: command.node, record: [...state.nodes].reverse().find(record => record.nodeId === command.node) ?? null }
                : releaseOpState;
            store.appendWithProvenance({ from: 'RLA', to: 'OP', kind: 'report',
              body: `RLA ${command.verb} · run=${runId} · state=${JSON.stringify(details)}` }, `rla-command-reply:${message.id}:OP`);
            releaseOpCursor = message.id;
          }
          if (resumeFlushFailed) {
            debug.log('release-loop.op-channel', 'resume-flush-pending', { runId, messageId: page.find(message => message.kind === 'rla-command' && message.body === 'resume')?.id ?? null });
            break;
          }
          if (page.length < 1000) break;
          page = store.listByRecipient('RLA', releaseOpCursor, 1000);
        }
        if (releaseOpState.held) releaseOpState = { ...releaseOpState,
          bufferedEvents: [...releaseOpState.bufferedEvents, { runId, nodeId, state: stage,
            eventId: `${runId}:${nodeId}:${visits.get(nodeId) ?? 1}:${stage}` }] };
        writeReleaseEvent({ runId, nodeId, state: stage, held: releaseOpState.held,
          eventId: `${runId}:${nodeId}:${visits.get(nodeId) ?? 1}:${stage}` });
        if (!releaseOpState.held) stageSent = await sendStage({ runId, nodeId, state: stage });
      } finally { store.close(); }
    } catch (error) {
      debug.log('release-loop.op-channel', 'delivery-failed', { runId, nodeId, state: stage, error: String(error).slice(0, 300) }, { level: 'warn' });
      if (!releaseOpState.held) stageSent = await sendStage({ runId, nodeId, state: stage });
    }
    return stageSent;
  };
  const publishLifecycleEvent = async (input: Parameters<GraphEventBus['publish']>[0]): Promise<GraphEvent | undefined> => {
    let published: GraphEvent | undefined;
    try {
      published = await eventBus.publish(input);
      await eventBus.flush({ graphId, runId });
    } catch (error) {
      if (eventQueuePersistenceFailure !== undefined) {
        const persistenceFailure = eventQueuePersistenceFailure;
        eventQueuePersistenceFailure = undefined;
        throw persistenceFailure;
      }
      if (input.type === RELEASE_GATE_FAILED_EVENT) throw error;
      try { debug.log('graph.runner', 'event-delivery-failed', { graphId, runId, type: input.type,
        error: String(error).slice(0, 300) }, { level: 'warn' }); } catch { /* graph execution is fail-open for observers */ }
    }
    return published;
  };
  const baseLog = options.deps?.log ?? ((event: string, data: Record<string, unknown>) => debug.log('graph.runner', event, data));
  // RFC §U: every event of a unit (child) run carries its parentRunId.
  const log = options.unitContext
    ? (event: string, data: Record<string, unknown>) => baseLog(event, { ...data, parentRunId: options.unitContext!.parentRunId })
    : baseLog;
  const emitNodeLifecycle = async (phase: GraphNodeLifecyclePhase, nodeId: string, visit: number,
    extra: Pick<GraphNodeLifecycleEvent, 'outcome' | 'nextNodeId' | 'reason'> = {},
    details: Readonly<Record<string, unknown>> = {}): Promise<void> => {
    const at = new Date().toISOString();
    const type = phase === 'arrival' ? 'node-arrival' : phase === 'leave' ? 'node-leave' : `node-${phase}`;
    const graphEvent = await publishLifecycleEvent({ graphId, runId, type, source: { kind: 'node', nodeId },
      data: { nodeId, phase, visit, dryRun: state.dryRun, ...extra, ...details } });
    const sequence = graphEvent?.sequence ?? state.graphEventSequence ?? eventSequenceBase;
    const emittedAt = graphEvent?.emittedAt ?? at;
    const event: GraphNodeLifecycleEvent = { eventId: graphEvent?.eventId ?? `${graphId}:${runId}:${sequence}`, seq: sequence,
      kind: 'node.lifecycle', source: 'graph-runner', phase, graphId, runId, nodeId, attempt: visit, visit,
      dryRun: state.dryRun, at: emittedAt, ...extra,
      data: { phase, visit, dryRun: state.dryRun, at: emittedAt,
        ...(extra.nextNodeId === undefined ? {} : { nextNodeId: extra.nextNodeId }),
        ...(extra.reason === undefined ? {} : { reason: extra.reason }) } };
    const reportHookFailure = (error: unknown): void => {
      try { log('node-lifecycle-hook-failed', { graphId, runId, nodeId, visit, phase, error: String(error).slice(0, 300) }); }
      catch { /* lifecycle reporting must not stop graph execution */ }
    };
    const hook = options.deps?.nodeLifecycle;
    if (hook) {
      lifecycleObserverQueue = lifecycleObserverQueue.then(async () => {
        try { await hook(event); }
        catch (error) { reportHookFailure(error); }
      });
    }
    try { log('node-lifecycle', { ...event }); }
    catch (error) { reportHookFailure(error); }
  };
  if (rejectedGrowthScopeEnv && document.grow === 'on') {
    log('growth-scope-rejected', { graphId, runId, source: 'env', reason: 'not-allowlisted' });
  }
  const visits = new Map<string, number>();
  for (const nodeId of state.path) visits.set(nodeId, (visits.get(nodeId) ?? 0) + 1);
  // GRAPH-UNIT-SPAN-DURATION: visit index per unit within this run, so enter/exit of
  // the same (runId, unit, visit) can be paired. The clock source is monotonic and
  // injectable (fake clock in tests); it never goes backwards in production. The
  // sequence is carried on the run state so a restart continues it.
  const unitVisits = new Map<string, number>(Object.entries(state.unitVisitSeq ?? {}));
  const monotonicMs = options.deps?.monotonicMs ?? (() => performance.now());
  let wakeContinuation: { nodeId: string; returnTo?: string; failureTo?: string; errorTo?: string; recoveryTo?: string; appendNodeIds?: string[] } | undefined = state.wakeContinuation;
  let current: string | undefined = options.fromNodeId ?? state.pending?.nodeId ?? wakeContinuation?.nodeId ?? state.path.at(-1) ?? unitEntryNode;
  const storedGate = [...state.nodes].reverse().find((record) => record.nodeId === 'gate' && record.output !== undefined);
  const storedGateOutput = lastJsonObject(storedGate?.output);
  const legacyGateResumeNeedsRefresh = isReleaseLoop && options.resumeRunId !== undefined && !options.fromNodeId &&
    (state.path.at(-1) === 'gate' || state.path.at(-1) === 'gate-triage') &&
    (!storedGate?.executionId || typeof storedGateOutput?.executionId !== 'string' || storedGateOutput.executionId !== storedGate.executionId);
  if (legacyGateResumeNeedsRefresh) {
    if (current === 'gate-triage') current = 'gate';
    if (state.resume) {
      state.resume = { ...state.resume, from: 'gate' };
      persist();
    }
    debug.log('graph.runs', 'legacy-gate-execution-identity-refresh', { graphId, runId, from: state.path.at(-1) });
  }
  const appendAdaptiveGateNode = async (request: AdaptiveGateHealAppendNodeRequest): Promise<AdaptiveGateHealAppendNodeReceipt> => {
    const regressionRepair = request.node.recipe === 'cmd:gate-repair' && /^gate-repair-[a-f0-9]{12}$/.test(request.node.nodeId);
    const imageRepair = request.node.recipe === 'cmd:gate-image-repair' && /^gate-image-repair-[a-f0-9]{12}$/.test(request.node.nodeId);
    if (!isReleaseLoop || state.dryRun || request.graphId !== graphId || request.runId !== runId ||
      request.afterNodeId !== 'gate-triage' || request.resumeFrom !== request.node.nodeId || request.rerunGateAt !== 'gate' ||
      request.maxRepairRetries !== 1 || request.visitLimits.gate !== 2 || request.visitLimits.gateTriage !== 2 ||
      request.node.kind !== 'agent' || request.node.maxVisits !== 1 || !(regressionRepair || imageRepair)) {
      throw new Error('adaptive gate append request is outside the release ARG contract');
    }
    const prior = (state.adaptiveGateNodeAppends ?? []).find((append) => append.eventId === request.eventId);
    if (prior) {
      if (JSON.stringify(prior.request) !== JSON.stringify(request))
        throw new Error(`adaptive gate append identity conflict: ${graphId}/${runId}/${request.eventId}`);
      return { disposition: 'already-appended', graphRevision: prior.graphRevision };
    }
    const event = (state.pendingGraphEvents ?? []).find((pending) => pending.eventId === request.eventId);
    const data = event?.data;
    const gate = data?.gate;
    const triage = data?.triage;
    const input = request.node.input;
    if (!event || event.graphId !== graphId || event.runId !== runId || event.type !== RELEASE_GATE_FAILED_EVENT ||
      event.source.kind !== 'node' || event.source.nodeId !== 'gate-triage' || data?.dryRun === true ||
      current !== 'gate-triage' || state.path.at(-1) !== 'gate-triage' || state.nodes.at(-1)?.nodeId !== 'gate-triage' ||
      state.nodes.at(-1)?.executed !== true || !gate || typeof gate !== 'object' || !triage || typeof triage !== 'object' ||
      !input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('adaptive gate append event is not the active completed gate-triage event');
    }
    const nodeInput = input as Record<string, unknown>;
    const gateRecord = gate as Record<string, unknown>;
    const triageRecord = triage as Record<string, unknown>;
    const actualVisits = { gate: visits.get('gate') ?? 0, gateTriage: visits.get('gate-triage') ?? 0 };
    const attributedFailureIds = nodeInput.failureIds;
    const triagedIntroduced = triageRecord.introduced;
    const commonPlanValid = Array.isArray(triageRecord.introduced) &&
      request.visitState.gate === actualVisits.gate && request.visitState.gateTriage === actualVisits.gateTriage &&
      actualVisits.gate >= 1 && actualVisits.gate < request.visitLimits.gate &&
      actualVisits.gateTriage >= 1 && actualVisits.gateTriage < request.visitLimits.gateTriage &&
      nodeInput.version === data?.version && nodeInput.runId === runId && nodeInput.commit === triageRecord.commit;
    const attributedRepairValid = regressionRepair && commonPlanValid && Array.isArray(attributedFailureIds)
      && Array.isArray(triagedIntroduced)
      && JSON.stringify([...attributedFailureIds].sort()) === JSON.stringify([...triagedIntroduced].sort());
    const releaseInput = state.input as Record<string, unknown>;
    const gateError = typeof gateRecord.error === 'string' ? gateRecord.error : '';
    const imageFailureCode = nodeInput.failureCode;
    const imageRepairValid = imageRepair && commonPlanValid && gateRecord.outcome === 'error' &&
      (imageFailureCode === 'pod-gate-missing-cut-image-pin' || imageFailureCode === 'pod-gate-missing-run-scope') &&
      gateError.includes(imageFailureCode) &&
      triageRecord.classification === 'unmeasured' &&
      Array.isArray(triageRecord.introduced) && triageRecord.introduced.length === 0 &&
      typeof nodeInput.pool === 'string' && nodeInput.pool.trim() !== '' && nodeInput.pool === releaseInput.gatePodPool &&
      releaseInput.gateExecutor !== 'host';
    if (!commonPlanValid || !(attributedRepairValid || imageRepairValid)) {
      throw new Error('adaptive gate append plan differs from the active release evidence or visit budget');
    }
    if (graph.nodes.some((node) => node.nodeId === request.node.nodeId))
      throw new Error(`adaptive gate repair node id already exists: ${request.node.nodeId}`);
    const proposal: GraphSubgraphAppendProposal = {
      nodes: [request.node],
      edges: [{ from: request.node.nodeId, on: 'outcome', map: { ok: request.rerunGateAt,
        fail: 'gate-heal-decision', error: 'gate-heal-decision', 'recovery-required': 'gate-repair-recovery' } }],
      entryNodeId: request.resumeFrom,
      returnTo: request.rerunGateAt,
      failureTo: 'gate-heal-decision',
      reason: `ARG repair for ${request.eventId}`,
    };
    const appendRecord = { proposal, eventId: request.eventId, subscriberId: 'arg-adaptive-gate-heal' };
    const appendedGraph = withSubscriptionGraphAppends(graph, [appendRecord]);
    requiredContractForNode(request.node);
    const resolved = resolveNodeRecipe(request.node, recipes, catalogRoles, graphManifest);
    const requiredCapabilities = 'requires' in request.node ? request.node.requires : undefined;
    if (requiredCapabilities !== undefined && typeof requiredCapabilities !== 'string')
      throw new Error('adaptive repair requires must be a string');
    if (graphManifest) assertGraphManifestRecipeAllowed(graphManifest, request.node.recipe, recipeIds, requiredCapabilities, request.node);
    if (!resolved.command?.command) throw new Error(`adaptive repair command is not configured: ${request.node.recipe}`);
    assertReleaseCommandBinding(request.node, resolved.command.command, false, graphManifest);
    const graphRevision = (state.graphRevision ?? 1) + 1;
    const action: QueuedSubscriptionAction = { subscriberId: appendRecord.subscriberId, nodeId: request.resumeFrom,
      action: 'wake', event, returnTo: request.rerunGateAt, failureTo: 'gate-heal-decision', errorTo: 'gate-heal-decision', recoveryTo: 'gate-repair-recovery',
      appendNodeIds: [request.node.nodeId] };
    state.adaptiveGateNodeAppends ??= [];
    const priorGate = [...state.nodes].reverse().find((record) => record.nodeId === 'gate' && record.output !== undefined);
    if (!priorGate) throw new Error('adaptive gate repair cannot invalidate a missing prior gate result');
    priorGate.output = undefined;
    priorGate.invalidatedByEvent = request.eventId;
    state.adaptiveGateNodeAppends.push({ eventId: request.eventId, request, graphRevision });
    state.subscriptionGraphAppends ??= [];
    state.subscriptionGraphAppends.push(appendRecord);
    state.graphRevision = graphRevision;
    graph = appendedGraph;
    registerGraphSubscriptionNodes([request.node]);
    pendingSubscriptionActions.push(action);
    state.pendingSubscriptionActions = [...pendingSubscriptionActions];
    logSubscriptionAction('queued', { event, subscriberId: action.subscriberId, nodeId: action.nodeId, action: 'wake' });
    persistOwnedRun(state, eventRunOwner!);
    return { disposition: 'appended', graphRevision };
  };
  const rerunAdaptiveGateOnPod = async (request: AdaptiveGateHealRerunGateRequest): Promise<{ disposition: 'queued' | 'already-queued' }> => {
    if (!isReleaseLoop || state.dryRun || request.graphId !== graphId || request.runId !== runId || request.resumeFrom !== 'gate'
      || request.visitLimits.gate !== 2 || request.visitLimits.gateTriage !== 2 || !request.gatePodPool.trim())
      throw new Error('adaptive gate Pod rerun request is outside the release ARG contract');
    const prior = state.adaptiveGateReruns?.find((rerun) => rerun.eventId === request.eventId);
    if (prior) {
      if (JSON.stringify(prior.request) !== JSON.stringify(request))
        throw new Error(`adaptive gate rerun identity conflict: ${graphId}/${runId}/${request.eventId}`);
      return { disposition: 'already-queued' };
    }
    const event = (state.pendingGraphEvents ?? []).find((pending) => pending.eventId === request.eventId);
    const data = event?.data;
    const gate = data?.gate;
    const triage = data?.triage;
    const releaseInput = state.input as Record<string, unknown>;
    const actualVisits = { gate: visits.get('gate') ?? 0, gateTriage: visits.get('gate-triage') ?? 0 };
    const rawGate = gate && typeof gate === 'object' ? gate as Record<string, unknown> : {};
    const triageRecord = triage && typeof triage === 'object' ? triage as Record<string, unknown> : {};
    const stalledUnattributed = Array.isArray(rawGate.stalledShards) && rawGate.stalledShards.some((shard) =>
      !!shard && typeof shard === 'object' && (shard as { reason?: unknown }).reason === 'unattributed');
    const attributionGap = typeof rawGate.error === 'string' && /failure attribution/.test(rawGate.error) || stalledUnattributed;
    if (!event || event.graphId !== graphId || event.runId !== runId || event.type !== RELEASE_GATE_FAILED_EVENT ||
      event.source.kind !== 'node' || event.source.nodeId !== 'gate-triage' || data?.dryRun === true || current !== 'gate-triage' ||
      state.path.at(-1) !== 'gate-triage' || state.nodes.at(-1)?.nodeId !== 'gate-triage' || state.nodes.at(-1)?.executed !== true ||
      data?.gateExecutor !== 'host' || releaseInput.gateExecutor !== 'host' || request.gatePodPool !== releaseInput.gatePodPool ||
      data?.version !== releaseInput.version || !Array.isArray(triageRecord.introduced) || triageRecord.introduced.length !== 0 ||
      rawGate.outcome !== 'error' || !attributionGap || request.visitState.gate !== actualVisits.gate ||
      request.visitState.gateTriage !== actualVisits.gateTriage || actualVisits.gate < 1 || actualVisits.gate >= 2 ||
      actualVisits.gateTriage < 1 || actualVisits.gateTriage >= 2) {
      throw new Error('adaptive gate Pod rerun does not match the active host attribution failure or visit budget');
    }
    const priorGate = [...state.nodes].reverse().find((record) => record.nodeId === 'gate' && record.output !== undefined);
    if (!priorGate) throw new Error('adaptive gate Pod rerun cannot invalidate a missing prior gate result');
    priorGate.output = undefined;
    priorGate.invalidatedByEvent = request.eventId;
    state.input = { ...releaseInput, gateExecutor: 'pod', gatePodPool: request.gatePodPool };
    const action: QueuedSubscriptionAction = { subscriberId: 'arg-adaptive-gate-heal', nodeId: 'gate', action: 'wake', event,
      returnTo: 'gate-triage', failureTo: 'gate-triage', errorTo: 'gate-triage' };
    state.adaptiveGateReruns ??= [];
    state.adaptiveGateReruns.push({ eventId: request.eventId, request });
    pendingSubscriptionActions.push(action);
    state.pendingSubscriptionActions = [...pendingSubscriptionActions];
    logSubscriptionAction('queued', { event, subscriberId: action.subscriberId, nodeId: action.nodeId, action: 'wake' });
    persistOwnedRun(state, eventRunOwner!);
    return { disposition: 'queued' };
  };
  const liveRlaTick = async (plan: AdaptiveGateHealPlan, event: GraphEvent): Promise<void> => {
    const input = state.input;
    if (process.env.ELANOUS_RLA_ARG_LIVE !== '1' || state.dryRun ||
        releaseGateCutoverPath(input) !== 'audit') return;
    const { runArgSupervisorTick } = await import('./arg-supervisor.js');
    const beforeRevision = state.graphRevision ?? 1;
    const beforeVocabulary = [...(state.adaptiveGraphVocabulary ?? [])];
    const beforeEdges = [...(state.adaptiveGraphEdges ?? [])];
    const beforeGraph = graph;
    const vocabularyOverlayPath = join(`${state.statePath}.graph`, 'release-edge-vocabulary.yaml');
    const priorVocabularyOverlay = existsSync(vocabularyOverlayPath) ? readFileSync(vocabularyOverlayPath, 'utf8') : undefined;
    const restoreVocabularyOverlay = (): void => {
      if (priorVocabularyOverlay === undefined) {
        if (existsSync(vocabularyOverlayPath)) unlinkSync(vocabularyOverlayPath);
      } else {
        const temporary = `${vocabularyOverlayPath}.${randomUUID()}.tmp`;
        writeFileSync(temporary, priorVocabularyOverlay);
        renameSync(temporary, vocabularyOverlayPath);
      }
    };
    const edge = { from: 'gate-triage', to: 'gate', triggerEvent: event.type,
      rationale: `RLA same-run Pod retry for ${event.eventId}`, mode: 'live' as const,
      eventId: event.eventId, subscriberId: 'loop:rla@1' };
    const present = beforeEdges.some(item => item.eventId === event.eventId && item.subscriberId === edge.subscriberId);
    let proposed = false;
    const ok = (evidence: string) => ({ outcome: 'ok' as const, evidence });
    try {
      if (plan.disposition.action === 'rerun-pod') {
      const result = await runArgSupervisorTick({ loopPath: resolve(dirname(path), 'rla/loop.yaml'), root,
        targetGraphId: graphId, targetRunId: runId, gateEventId: event.eventId,
        graphRevision: beforeRevision, operation: 'reroute', mutableState: state,
        ports: {
          persist: () => { graph = withAdaptiveGraphEdges(beforeGraph,
            state.adaptiveGraphEdges ?? [], state.adaptiveGraphVocabulary ?? []); persist(); },
          observe: () => ok('host gate attribution failed; Pod rerun prescribed'),
          propose: () => { proposed = !present; return { ...ok('same-run retry edge proposed'),
            effect: { kind: 'retry-edge', from: edge.from, to: edge.to,
              triggerEvent: edge.triggerEvent, rationale: edge.rationale } }; },
          validate: () => proposed && graph.nodes.some(node => node.nodeId === edge.from) &&
            graph.nodes.some(node => node.nodeId === edge.to) && !present
            ? ok('run-local edge endpoints and event checked') : { outcome: 'fail', evidence: 'retry edge already exists or endpoints missing' },
          verify: () => state.adaptiveGraphEdges?.some(item => item.eventId === event.eventId && item.subscriberId === edge.subscriberId)
            ? ok('retry edge durable before Pod scheduler') : { outcome: 'fail', evidence: 'retry edge missing' },
        } });
      if (result.graphRun.path.at(-1) !== 'done') throw new Error('RLA tick did not verify the retry edge');
      }
      const triage = event.data?.triage;
      if (callLLM && triage && typeof triage === 'object' && !Array.isArray(triage) &&
          (triage as Record<string, unknown>).classification === 'unmeasured') {
        const memory: readonly unknown[] = []; // Source: graphs/release/rla/loop.yaml injectCandidateMemory: false.
        const openBefore = state.graphRevision ?? 1;
        const vocabularyBefore = [...(state.adaptiveGraphVocabulary ?? [])];
        const open = await runArgSupervisorTick({ loopPath: resolve(dirname(path), 'rla/loop.yaml'), root,
          targetGraphId: graphId, targetRunId: runId, gateEventId: event.eventId,
          graphRevision: openBefore, operation: 'reroute', mutableState: state,
          vocabularyOverlay: { sourcePath: resolve(dirname(path), 'release-edge-vocabulary.yaml'), path: vocabularyOverlayPath },
          openProposal: { observation: { gate: event.data?.gate, triage, plan: plan.disposition }, memory, callLLM },
          ports: {
            persist,
            observe: () => ({ outcome: 'novel', evidence: 'unmeasured gate failure' }),
            propose: ({ proposal }) => proposal ? { ...ok(`open proposal ${proposal.verb}`),
              ...(proposal.changes[0]?.kind === 'vocabulary'
                ? { effect: { kind: 'vocabulary' as const, term: proposal.changes[0].term } } : {}) }
              : { outcome: 'fail', evidence: 'proposal missing' },
            validate: ({ decision }) => decision?.disposition === 'auto-apply' ? ok('open proposal policy dry-run passed')
              : { outcome: 'input_required', evidence: decision?.reason ?? 'MRTR approval required' },
            verify: ({ proposal }) => {
              const overlay = existsSync(vocabularyOverlayPath)
                ? parseYaml(readFileSync(vocabularyOverlayPath, 'utf8')) as { failureTypes?: Record<string, unknown> } : undefined;
              return proposal?.changes.every(change => change.kind === 'vocabulary' &&
                state.adaptiveGraphVocabulary?.includes(change.term) &&
                Object.hasOwn(overlay?.failureTypes ?? {}, change.term)) ? ok('vocabulary durable')
                : { outcome: 'fail', evidence: 'vocabulary missing' };
            },
          } });
        if (open.resultType === 'input_required') {
          state.argInputRequests ??= [];
          if (!state.argInputRequests.some(item => item.eventId === event.eventId))
            state.argInputRequests.push({ eventId: event.eventId, resultType: open.resultType,
              requestState: open.requestState ?? {}, inputRequests: open.inputRequests ?? [] });
          persist();
          try { (options.deps?.log ?? ((name, data) => debug.log('graph.runner', name, data)))('rla-arg-mrtr-required',
            { graphId, runId, eventId: event.eventId, requestState: open.requestState }); } catch { /* diagnostic only */ }
        } else if (open.graphRun.path.at(-1) !== 'done') {
          state.adaptiveGraphVocabulary = vocabularyBefore;
          state.graphRevision = openBefore;
          restoreVocabularyOverlay();
          persist();
        } else {
          for (const term of state.adaptiveGraphVocabulary ?? []) if (!eventBus.hasType(term)) eventBus.registerType(term);
        }
      }
    } catch (error) {
      state.adaptiveGraphEdges = beforeEdges;
      state.adaptiveGraphVocabulary = beforeVocabulary;
      state.graphRevision = beforeRevision;
      graph = beforeGraph;
      restoreVocabularyOverlay();
      persist();
      try { (options.deps?.log ?? ((name, data) => debug.log('graph.runner', name, data)))('rla-arg-legacy-fallback',
        { graphId, runId, eventId: event.eventId, reason: String(error) }); } catch { /* diagnostic only */ }
    }
  };
  if (eventBus && isReleaseLoop) disposeAdaptiveGateHealAdapter = registerAdaptiveGateHealAdapter(eventBus,
    { graphId, runId, dryRun: state.dryRun }, { appendNode: appendAdaptiveGateNode, rerunGate: rerunAdaptiveGateOnPod,
      onPlan: liveRlaTick });
  let growthScopeSkipLogged = false;
  let growthCapReachedLogged = state.growthRejections?.some((item) =>
    item.reason === 'growth proposal limit 8 reached' || item.reason === 'growth limit 3 reached') ?? false;
  if (!options.resumeRunId) {
    mkdirSync(dirname(statePath), { recursive: true });
    if (readdirSync(dirname(statePath)).some((file) => file.startsWith(`${runId}.json.`) && file.endsWith('.decision.json'))) {
      throw new Error(`run id already exists: ${graphId}/${runId}`);
    }
    if (existsSync(statePath)) throw new Error(`run id already exists: ${graphId}/${runId}`);
    if (loopBudget.runsPerDay !== undefined && !state.dryRun && !fanOutDailyBudgetExemptRunIds.has(runId))
      reserveDailyGraphRun(root, graphId, runId, state.startedAt!, loopBudget.runsPerDay);
    try { writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`run id already exists: ${graphId}/${runId}`);
      throw error;
    }
    mkdirSync(`${statePath}.graph`);
    writeFileSync(join(`${statePath}.graph`, 'graph.yaml'), variantSource, { flag: 'wx' });
    writeFileSync(join(`${statePath}.graph`, 'recipes.yaml'), recipeSource, { flag: 'wx' });
  }
  if (eventBus && (state.pendingGraphEvents?.length ?? 0) > 0) {
    for (const pendingEvent of [...state.pendingGraphEvents!]) {
      try {
        await eventBus.publish(pendingEvent);
        await eventBus.flush({ graphId, runId });
      } catch (error) {
        log('event-replay-pending', { graphId, runId, eventId: pendingEvent.eventId,
          error: error instanceof Error ? error.message : String(error) });
        state.status = 'failed';
        state.reason = 'graph-event-delivery-pending';
        persist();
        disposeGraphSubscriptions();
        disposeReleaseGraphEventAdapters();
        disposeAdaptiveGateHealAdapter();
        if (options.resumeRunId && existsSync(resumeLock)) rmdirSync(resumeLock);
        return state;
      }
    }
  }
  let activeLifecycleNode: { nodeId: string; visit: number } | undefined;
  try {
  if (!options.resumeRunId && graph.loop?.stopWhen) {
    const input = state.input && typeof state.input === 'object' && !Array.isArray(state.input)
      ? state.input as Readonly<Record<string, unknown>> : {};
    const verdict = evaluateOverlayCondition(graph.loop.stopWhen, input);
    if (verdict.kind === 'applies') {
      current = undefined;
      state.status = 'done';
      debug.log('graph.run', 'loop-stopped', { graphId, runId, condition: graph.loop.stopWhen });
      persist();
    } else if (verdict.kind !== 'does-not-apply') {
      throw new Error(`loop stop_when could not be evaluated: ${verdict.kind}`);
    }
  }
  while (current !== undefined) {
    if (options.signal?.aborted) {
      state.status = 'failed';
      state.reason = 'cancelled';
      persist();
      break;
    }
    options.deps?.beforeNode?.();
    const executedBeforeNode = state.executed;
    const node = graph.nodes.find((n) => n.nodeId === current);
    if (!node) throw new Error(`undeclared node: ${current}`);
    const resumingPending = state.pending?.nodeId === current;
    const completed = state.nodes.at(-1);
    const nodeCompletionInputSha256 = stableSha256({ graphId, nodeId: current, input: state.input ?? null,
      nodeInput: Object.hasOwn(node, 'input') ? node.input : null,
      outputs: state.nodes.map((record) => [record.nodeId, record.output ?? null]), sourceHash: state.sourceHash ?? null });
    const resumingCompleted = options.resumeRunId !== undefined && !options.fromNodeId &&
      !(legacyGateResumeNeedsRefresh && current === 'gate') && completed?.nodeId === current &&
      state.path.at(-1) === current && !resumingPending;
    const emitVisitLifecycle = async (phase: GraphNodeLifecyclePhase, nodeId: string, visit: number,
      extra: Pick<GraphNodeLifecycleEvent, 'outcome' | 'nextNodeId' | 'reason'> = {},
      details: Readonly<Record<string, unknown>> = {}): Promise<void> => {
      if (resumingCompleted) return;
      if (phase === 'arrival') activeLifecycleNode = { nodeId, visit };
      await emitNodeLifecycle(phase, nodeId, visit, extra, details);
      if (phase === 'leave' && activeLifecycleNode?.nodeId === nodeId && activeLifecycleNode.visit === visit) activeLifecycleNode = undefined;
    };
    const executionId = randomUUID();
    const visit = (visits.get(current) ?? 0) + (resumingPending || resumingCompleted ? 0 : 1);
    const usedSteps = state.path.length + (state.unitCalls ?? []).reduce((sum, call) => sum + call.steps, 0);
    const effectiveRemaining = Math.min(
      graph.allowance ? graph.allowance.innerSteps - usedSteps : Infinity,
      options.unitContext ? options.unitContext.remainingSteps - usedSteps : Infinity,
    );
    if (!resumingPending && !resumingCompleted && ((visits.get(current) ?? 0) >= node.maxVisits ||
        (effectiveRemaining <= 0 && !graph.terminalNodes.includes(current)))) {
      await emitVisitLifecycle('arrival', current, visit, { reason: 'budget-exceeded' });
      await emitVisitLifecycle('leave', current, visit, { reason: 'budget-exceeded' });
      state.status = 'budget-exceeded';
      log('budget-exceeded', { graphId, runId, nodeId: current });
      persist();
      break;
    }
    if (!resumingPending && !resumingCompleted) {
      visits.set(current, (visits.get(current) ?? 0) + 1);
      state.path.push(current);
    }
    await emitVisitLifecycle('arrival', current, visit);
    let resolved: ReturnType<typeof resolveNodeRecipe>;
    try {
      if (graphManifest) assertGraphManifestRecipeAllowed(graphManifest, node.recipe, recipeIds, node.requires, node);
      resolved = resolveNodeRecipe(node, recipes, catalogRoles, graphManifest);
      const approvedInput = approvedInputBinding(node);
      if (approvedInput && !state.dryRun) {
        const pinned = graphInputAtPath(state.input, approvedInput.inputPath);
        if (!pinned.found || !hasApprovedGraphNodeInput({ graphId, runId, nodeId: approvedInput.nodeId,
          inputPath: approvedInput.inputPath, inputSha256: stableSha256(pinned.value),
          maxAgeMs: approvedInput.maxAgeMs, root }))
          throw new Error(`graph.approval-denied: ${node.nodeId} requires ${approvedInput.nodeId}`);
      }
      if (enforceReleaseCommandBindings) assertReleaseCommandBinding(node, resolved.command?.command, graph.terminalNodes.includes(current), graphManifest);
      options.deps?.validateNodeBinding?.(node.nodeId, resolved.command?.command);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('graph.manifest-denied'))
        log('manifest-denied', { graphId, runId, nodeId: current, kind: 'recipe', name: node.recipe });
      await emitVisitLifecycle('leave', current, visit, { reason: 'pre-dispatch-validation-failed' });
      throw error;
    }
    const command = resolved.command;
    const prompt = resolved.prompt;
    const approval = resolved.approval ? { approval: approvalMessage(resolved.approval.approval, state.input, isReleaseLoop) } : undefined;
    if (resumingPending && (!approval || approval.approval !== state.pending?.message)) {
      throw new Error(`pending approval no longer matches graph: ${current}`);
    }
    // Graphs may opt into previewing the approval boundary in dry runs.
    if (approval && (!state.dryRun || document.dry_run_await_approval === true) && !state.pending?.decision) {
      if (!state.pending) {
        state.pending = { nodeId: current, message: approval.approval, since: new Date().toISOString(),
          inputSha256: stableSha256(state.input) };
        state.approvalSourceHash = approvalSourceHash;
      }
      state.status = 'awaiting-approval';
      if (!state.dryRun && !state.pending.notifiedAt) {
        try {
          log('approval-pending', { graphId, runId, nodeId: current, message: state.pending.message, since: state.pending.since });
          if (await emitReleaseStage(current, 'wait')) state.pending = { ...state.pending, notifiedAt: new Date().toISOString() };
        } catch (error) {
          persist();
          throw error;
        }
      }
      persist();
      await emitVisitLifecycle('leave', current, visit, { reason: 'awaiting-approval' });
      break;
    }
    state.status = 'running';
    const startedAt = performance.now();
    const nodeStartedAt = new Date().toISOString();
    if (!resumingCompleted) state.currentNode = { nodeId: current, executionId, startedAt: nodeStartedAt };
    await emitVisitLifecycle('start', current, visit);
    if (!options.quiet) console.error(`[graph] ${current} start (0.00s)`);
    debug.log('graph.run', 'node', { graphId, runId, nodeId: current, phase: 'start', dryRun: state.dryRun });
    publishInsideEvent({ kind: 'node', graphId, runId, nodeId: current, phase: 'start' });
    log('node-start', { graphId, runId, nodeId: current, visit: visits.get(current), dryRun: state.dryRun });
    await emitReleaseStage(current, 'start');
    persist();
    const releaseOpMode = typeof options.deps?.releaseOpMode === 'function'
      ? options.deps.releaseOpMode() : options.deps?.releaseOpMode ?? 'operational';
    let operatorDecision = releaseOpState.phaseDecisions[current]?.decision ?? 'go';
    if (releaseOpMode === 'shadow' && (graphId === 'release-loop' || options.deps?.releaseOpChannel === true)) {
      try {
        const store = openMsgStore(join(root, 'msg', 'messages.db'));
        try { operatorDecision = shadowReleaseOpDecision(store, current); } finally { store.close(); }
      } catch (error) {
        debug.log('release-loop.op-channel', 'shadow-read-failed', { runId, nodeId: current, error: String(error).slice(0, 300) }, { level: 'warn' });
      }
    }
    options.deps?.releaseOpDecisionObserver?.({ nodeId: current, decision: operatorDecision, mode: releaseOpMode });
    const operatorNoGo: boolean = releaseOpMode === 'operational' &&
      (graphId === 'release-loop' || options.deps?.releaseOpChannel === true) &&
      releaseOpState.phaseDecisions[current]?.decision === 'no-go';
    const joinedFanout = Object.values(state.fanOuts ?? {}).find((fanout) => fanout.join === current &&
      Object.values(fanout.branches).every((branch) => branch.status === 'done' || branch.status === 'failed'));
    const branchDiagnostics = joinedFanout ? fanOutFailureDiagnostics(joinedFanout) : [];
    const warningBranches = joinedFanout
      ? graph.edges.find((edge) => edge.from === joinedFanout.from)?.warningBranches ?? [] : [];
    let ok: boolean = operatorNoGo ? false : approval && !state.dryRun ? state.pending?.decision === 'approved' : joinedFanout
      ? Object.entries(joinedFanout.branches).every(([branchId, branch]) => branch.status === 'done' || warningBranches.includes(branchId)) : true;
    let exit: number | null = null;
    let error: string | undefined;
    let commandFailureReason: string | undefined;
    let output: unknown;
    if (operatorNoGo) {
      exit = 1;
      error = releaseOpState.phaseDecisions[current]!.reason;
      output = JSON.stringify({ outcome: 'fail', decidedBy: 'OP', reason: error });
    }
    if (joinedFanout) {
      const mapJoinInput = node.input && typeof node.input === 'object' && !Array.isArray(node.input)
        ? (node.input as Record<string, unknown>).__graphV2MapJoin : undefined;
      const mapBranchIds = mapJoinInput && typeof mapJoinInput === 'object' && !Array.isArray(mapJoinInput)
        ? (mapJoinInput as { branchIds?: unknown }).branchIds : undefined;
      const mappedItems = Array.isArray(mapBranchIds) ? mapBranchIds.flatMap((branchId) => {
        if (typeof branchId !== 'string') return [];
        const branchOutput = lastJsonObject(joinedFanout.branches[branchId]?.output);
        return branchOutput && Object.hasOwn(branchOutput, 'result') ? [branchOutput.result] : [];
      }) : undefined;
      const mapOutcomes = Array.isArray(mapBranchIds) ? mapBranchIds.flatMap((branchId) => {
        if (typeof branchId !== 'string') return [];
        const branchOutput = lastJsonObject(joinedFanout.branches[branchId]?.output);
        return typeof branchOutput?.outcome === 'string' ? [branchOutput.outcome] : [];
      }) : [];
      const unitExitOutcomes = new Set(['done', 'rework', 'needs-human', 'failed']);
      const everyBranchHasUnitExit = Array.isArray(mapBranchIds) && mapOutcomes.length === mapBranchIds.length &&
        mapOutcomes.every((branchOutcome) => unitExitOutcomes.has(branchOutcome));
      const joinedOutcome = everyBranchHasUnitExit
        ? (['failed', 'needs-human', 'rework', 'done'].find((candidate) => mapOutcomes.includes(candidate)) ?? (ok ? 'ok' : 'fail'))
        : ok ? 'ok' : 'fail';
      output = JSON.stringify({ ...(mappedItems === undefined ? {} : { result: { items: mappedItems } }),
        outcome: joinedOutcome, branches: joinedFanout.branches });
    }
    const waiving = options.releaseWaiver?.nodeId === current && waivedRecord !== undefined;
    if (waiving && current === 'gate') {
      if (savedGateUnmeasured !== options.releaseWaiver!.unmeasured) {
        throw new Error('saved gate unmeasured evidence changed before waiver event consumption');
      }
      const gateOutput = lastJsonObject(waivedRecord!.output);
      const cutOutput = lastJsonObject(state.nodes.find((record) => record.nodeId === 'version-release')?.output);
      const head = typeof cutOutput?.commit === 'string' && /^[0-9a-f]{40}$/i.test(cutOutput.commit) ? cutOutput.commit : '';
      const target = `run:${runId}`;
      const eventPath = join(options.waiverLedgerRoot ?? options.deps?.root ?? effectiveInstanceRoot(), 'review-results', 'waiver-events.jsonl');
      const waiverActor = options.releaseWaiver!.approvedBy ?? process.env.ELANOUS_SEAT ?? process.env.USER ?? 'release-resume';
      const waiverEvidence = gateWaiverEvidence({ reason: options.releaseWaiver!.reason, actor: waiverActor,
        unmeasured: savedGateUnmeasured });
      const expectedEvidence = [`saved-run:${statePath}`, ...waiverEvidence];
      const measuredRegression = (Array.isArray(gateOutput?.introduced) && gateOutput.introduced.length > 0)
        || (typeof gateOutput?.introduced === 'number' && gateOutput.introduced > 0)
        || (Array.isArray(gateOutput?.introducedIds) && gateOutput.introducedIds.some((id) => typeof id === 'string' && id.trim().length > 0))
        || (typeof gateOutput?.introducedIds === 'number' && gateOutput.introducedIds > 0);
      consumeWaiverEventFromLedger(eventPath, (candidate) => candidate.kind === 'gate' && candidate.mode === 'operational'
        && candidate.target === target && candidate.head === head && candidate.uses === 0 && candidate.expiredBy === undefined
        && candidate.actor === waiverActor && hasExactWaiverEvidence(candidate, expectedEvidence),
      { target, head, now: Date.now, measuredRegression });
    }
    const requiredContract = requiredContractForNode(node);
    const capabilityName = node.kind === 'capability' && !requiredContract ? capabilityNameFromRecipe(node.recipe) : undefined;
    const inProcessHandler = capabilityName || requiredContract ? undefined : requireInProcessHandler(node.recipe, current, options.deps?.inProcessHandlers);
    let handlerExecuted = false;
    if ((inProcessHandler || capabilityName || requiredContract) && !operatorNoGo && !waiving && !state.dryRun && !resumingCompleted) {
      const eventNodeId = node.nodeId;
      const outputs: Record<string, unknown> = Object.assign(Object.create(null), options.branchParentOutputs ?? {});
      for (const previous of state.nodes) outputs[previous.nodeId] = lastJsonObject(previous.output) ?? previous.output ?? null;
      for (const fanout of Object.values(state.fanOuts ?? {})) for (const [branchId, branch] of Object.entries(fanout.branches))
        if (branch.output !== undefined) outputs[branchId] = lastJsonObject(branch.output) ?? branch.output;
      const mapBinding = bindGraphV2StaticMapItem(node.input, outputs);
      handlerExecuted = true;
      debug.log('graph.run', 'handler-dispatch', { graphId, runId, nodeId: current, recipe: node.recipe });
      try {
        const handlerContext = { graphId, runId, nodeId: current, input: state.input ?? null,
          ...(node.requires === undefined ? {} : { requires: node.requires }),
          ...(Object.hasOwn(node, 'input') ? { nodeInput: mapBinding.nodeInput } : {}), outputs,
          ...(eventBus === undefined ? {} : { emitEvent: (type: string, data?: Readonly<Record<string, unknown>>) => publishNodeGraphEvent(eventBus,
            { graphId, runId, type, source: { kind: 'node', nodeId: eventNodeId }, ...(data === undefined ? {} : { data }) }, node.emits ?? []) }) };
        if (mapBinding.skipped) {
          output = JSON.stringify({ evidence: { mapItemSkipped: true, ...mapBinding.skipped }, outcome: 'done' });
          ok = true;
          exit = 0;
        } else {
          const result = requiredContract
            ? await dispatchGraphContract(requiredContract, handlerContext, options.deps?.capabilityProviders && 'contracts' in options.deps.capabilityProviders
              ? options.deps.capabilityProviders : undefined)
            : capabilityName
              ? await dispatchGraphCapability(capabilityName, handlerContext, options.deps?.capabilityProviders)
              : await inProcessHandler!(handlerContext);
          await eventBus?.flush({ graphId, runId });
          if (!result || typeof result.ok !== 'boolean' || typeof result.outcome !== 'string' || !result.outcome.trim())
            throw new Error(`invalid in-process handler result: ${current}`);
          output = JSON.stringify({ ...(result.result === undefined ? {} : { result: result.result }),
            ...(result.evidence === undefined ? {} : { evidence: result.evidence }), outcome: result.outcome,
            ...(result.error ? { error: result.error } : {}) });
          ok = result.ok;
          exit = ok ? 0 : 1;
          error = result.error;
        }
      } catch (cause) {
        ok = false;
        exit = 1;
        error = redactCredentials(cause instanceof Error ? cause.message : String(cause));
        output = JSON.stringify({ outcome: 'fail', error });
      }
      debug.log('graph.run', 'handler-result', { graphId, runId, nodeId: current, recipe: node.recipe, ok,
        outcome: lastJsonObject(output)?.outcome ?? null, ...(error ? { error } : {}) });
      state.executed++;
    }
    if (command && !operatorNoGo && !waiving && (!approval || state.dryRun || ok) && (!state.dryRun || command.dry_run_command) && !resumingCompleted) {
      const outputs: Record<string, unknown> = Object.assign(Object.create(null), options.branchParentOutputs ?? {});
      // 구조 산출(마지막 JSON 줄)이 있으면 그것을, 없으면 원문을 준다 — 다음 노드가 판단을 «값»으로 받는다.
      for (const previous of state.nodes) outputs[previous.nodeId] = lastJsonObject(previous.output) ?? previous.output ?? null;
      for (const fanout of Object.values(state.fanOuts ?? {})) for (const [branchId, branch] of Object.entries(fanout.branches))
        if (branch.output !== undefined) outputs[branchId] = lastJsonObject(branch.output) ?? branch.output;
      const contextPath = join(`${statePath}.contexts`, `${state.path.length}.json`);
      mkdirSync(dirname(contextPath), { recursive: true });
      if (isReleaseLoop && current === 'residual-run' && state.input && typeof state.input === 'object' && !Array.isArray(state.input)) {
        const releaseInput = state.input as Record<string, unknown>;
        const priorGate = [...state.nodes].reverse().find((record) =>
          (record.nodeId === 'gate' || record.nodeId === 'residual-run') && record.output !== undefined);
        const priorGateOutput = lastJsonObject(priorGate?.output);
        const attributionGap = typeof priorGateOutput?.error === 'string' && /failure attribution/.test(priorGateOutput.error)
          || Array.isArray(priorGateOutput?.stalledShards) && priorGateOutput.stalledShards.some((shard) =>
            !!shard && typeof shard === 'object' && (shard as { reason?: unknown }).reason === 'unattributed');
        if (releaseInput.gateExecutor === 'host' && releaseInput.gateImagePin === 'cut-commit'
          && typeof releaseInput.gatePodPool === 'string' && releaseInput.gatePodPool.trim()
          && priorGateOutput?.outcome === 'error' && attributionGap) {
          state.input = { ...releaseInput, gateExecutor: 'pod' };
          debug.log('release-loop.gate', 'residual-pod-attribution-retry', { runId, priorGateNodeId: priorGate?.nodeId,
            pool: releaseInput.gatePodPool });
        }
      }
      const latestGate = current === 'gate-triage' ? [...state.nodes].reverse().find((record) =>
        (record.nodeId === 'gate' || record.nodeId === 'residual-run') && record.output !== undefined) : undefined;
      const latestGateOutput = latestGate ? lastJsonObject(latestGate.output) : undefined;
      const latestGateOutputExecutionId = latestGateOutput?.executionId;
      if (isReleaseLoop && latestGate && latestGateOutputExecutionId !== latestGate.executionId) {
        throw new Error('latest gate output execution id does not match its recorded execution');
      }
      const nodeRunInput = isReleaseLoop && current === 'gate-triage' && state.input && typeof state.input === 'object' && !Array.isArray(state.input)
        ? { ...(state.input as Record<string, unknown>), adaptiveHealVisitState: {
          gate: visits.get('gate') ?? 0, gateTriage: visits.get('gate-triage') ?? 0,
        }, ...(typeof latestGateOutputExecutionId === 'string' ? { adaptiveGateExecutionId: latestGateOutputExecutionId } : {}) }
        : state.input ?? null;
      const nodeHistory = state.nodes.filter((record) => record.nodeId === 'gate' || record.nodeId === 'residual-run').map((record) => ({ nodeId: record.nodeId,
        ...(record.executionId ? { executionId: record.executionId } : {}),
        ...(record.startedAt ? { startedAt: record.startedAt } : {}),
        ...(record.endedAt ? { endedAt: record.endedAt } : {}),
        ...(record.output === undefined ? {} : { output: lastJsonObject(record.output) ?? record.output }) }));
      writeFileSync(contextPath, JSON.stringify({ graphId, runId, startedAt: state.startedAt, executionId, nodeId: current,
        input: nodeRunInput, ...(Object.hasOwn(node, 'input') ? { nodeInput: node.input } : {}), outputs, nodeHistory }, null, 2) + '\n');
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
        const gateProgressPath = isReleaseLoop && current === 'gate' ? `${contextPath}.gate-progress.jsonl` : undefined;
        const gateCorrelationScope = isReleaseLoop && (current === 'gate' || current === 'residual-run');
        const childOpts = commandRoot ? { ...opts, cwd: commandRoot } : { ...opts };
        if (gateProgressPath) {
          childOpts.env = { ...process.env, ...childOpts.env, ELANOUS_GATE_PROGRESS_FILE: gateProgressPath };
        }
        let readingProgress = gateProgressPath !== undefined;
        let progressOffset = 0;
        let progressRemainder = Buffer.alloc(0);
        let lastGateHeartbeatAt: number | undefined;
        let lastGateHeartbeat: Record<string, unknown> | undefined;
        let expectedHeartbeatIntervalMs = GATE_HEARTBEAT_INTERVAL_MS;
        let gateHeartbeatInterrupted = false;
        let gateFinished = false;
        const gateObservationStartedAt = Date.now();
        const gateInvocation = randomUUID();
        const initialGateObservation = { runId, invocation: gateInvocation, batch: executionId ?? 'unknown',
          shard: null, attempt: null, phase: 'startup', host: null, podJob: null, file: null, evidenceLevel: 'unknown' };
        const publishGateObservation = (type: 'release.gate.progress' | 'release.gate.heartbeat-interrupted',
          source: { kind: 'runner' | 'node'; nodeId: string }, data: Record<string, unknown>) => baseEventBus.publish({
          graphId, runId, type, source,
          // Observation events are ephemeral: sequence 0 stays outside the durable lifecycle sequence and run ledger.
          eventId: `${graphId}:${runId}:gate-observation:${randomUUID()}`, sequence: 0, emittedAt: new Date().toISOString(), data,
        });
        const emitHeartbeatInterrupted = async (reason: 'heartbeat-stale' | 'child-exited' | 'first-heartbeat-missing'): Promise<void> => {
          if (gateHeartbeatInterrupted || gateFinished) return;
          const lastObservedAt = lastGateHeartbeatAt ?? gateObservationStartedAt;
          const gapMs = Math.max(0, Date.now() - lastObservedAt);
          const alert = { ...(lastGateHeartbeat ?? initialGateObservation), event: 'heartbeat-interrupted', reason, gapMs,
            expectedIntervalMs: expectedHeartbeatIntervalMs, detectedAt: new Date().toISOString() };
          gateHeartbeatInterrupted = true;
          debug.log('release.gate', 'heartbeat-interrupted', alert, { level: 'warn' });
          try {
            await publishGateObservation('release.gate.heartbeat-interrupted', { kind: 'runner', nodeId: current! }, alert);
          } catch (error) {
            debug.log('graph.event', 'release-gate-heartbeat-alert-delivery-failed', { graphId, runId, reason,
              error: String(error) }, { level: 'warn' });
          }
        };
        const monitorGateHeartbeat = async (): Promise<void> => {
          if (!gateProgressPath || gateFinished) return;
          const lastObservedAt = lastGateHeartbeatAt ?? gateObservationStartedAt;
          if (Date.now() - lastObservedAt > expectedHeartbeatIntervalMs * 1.5)
            await emitHeartbeatInterrupted(lastGateHeartbeatAt === undefined ? 'first-heartbeat-missing' : 'heartbeat-stale');
        };
        const pumpGateProgress = async (): Promise<void> => {
          if (!gateProgressPath) return;
          try {
            if (!existsSync(gateProgressPath)) return;
            const size = statSync(gateProgressPath).size;
            if (size < progressOffset) { progressOffset = 0; progressRemainder = Buffer.alloc(0); }
            if (size === progressOffset) return;
            const fd = openSync(gateProgressPath, 'r');
            const bytes = Buffer.alloc(size - progressOffset);
            let bytesRead: number;
            try { bytesRead = readSync(fd, bytes, 0, bytes.length, progressOffset); }
            finally { closeSync(fd); }
            progressOffset += bytesRead;
            const complete = Buffer.concat([progressRemainder, bytes.subarray(0, bytesRead)]);
            const lastNewline = complete.lastIndexOf(0x0a);
            if (lastNewline < 0) { progressRemainder = complete; return; }
            progressRemainder = complete.subarray(lastNewline + 1);
            for (const line of complete.subarray(0, lastNewline).toString('utf8').split('\n')) {
              if (!line.trim()) continue;
              let data: Record<string, unknown>;
              try { data = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
              const publishHeartbeatAlert = data.event === 'heartbeat-interrupted' && !gateHeartbeatInterrupted;
              if (data.event === 'phase-heartbeat') {
                lastGateHeartbeat = data;
                lastGateHeartbeatAt = Date.now();
                if (typeof data.expectedIntervalMs === 'number' && Number.isFinite(data.expectedIntervalMs) && data.expectedIntervalMs > 0)
                  expectedHeartbeatIntervalMs = data.expectedIntervalMs;
                gateHeartbeatInterrupted = false;
              } else if (data.event === 'gate-finished') gateFinished = true;
              else if (data.event === 'heartbeat-interrupted') gateHeartbeatInterrupted = true;
              const phase = typeof data.phase === 'string' ? data.phase : 'progress';
              try {
                await publishGateObservation('release.gate.progress', { kind: 'node', nodeId: current! }, data);
              } catch (error) { debug.log('graph.event', 'release-gate-progress-delivery-failed', { graphId, runId, phase, error: String(error) }, { level: 'warn' }); }
              if (publishHeartbeatAlert) {
                debug.log('release.gate', 'heartbeat-interrupted', data, { level: 'warn' });
                try {
                  await publishGateObservation('release.gate.heartbeat-interrupted', { kind: 'runner', nodeId: current! }, data);
                } catch (error) {
                  debug.log('graph.event', 'release-gate-heartbeat-alert-delivery-failed', { graphId, runId,
                    reason: 'child-heartbeat-interrupted', error: String(error) }, { level: 'warn' });
                }
              }
            }
          } catch (error) { debug.log('graph.event', 'release-gate-progress-read-failed', { graphId, runId, error: String(error) }, { level: 'warn' }); }
        };
        const progressPump = withRunnerGateObservation({ runId, invocation: gateInvocation, batch: executionId ?? 'unknown' }, async () => {
          while (readingProgress) {
            await pumpGateProgress();
            await monitorGateHeartbeat();
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          await pumpGateProgress();
          if (!gateFinished) await emitHeartbeatInterrupted(lastGateHeartbeat ? 'child-exited' : 'first-heartbeat-missing');
        });
        try {
          if (gateCorrelationScope) {
            const gateEnv: NodeJS.ProcessEnv = { ...process.env, ...childOpts.env, ELANOUS_RUN_ID: runId,
              ELANOUS_GRAPH_RUN_ID: runId, ELANOUS_GATE_INVOCATION: gateInvocation };
            if (executionId) gateEnv.ELANOUS_BATCH_ID = executionId;
            else delete gateEnv.ELANOUS_BATCH_ID;
            childOpts.env = gateEnv;
          }
          const result = gateCorrelationScope
            ? await withRunnerGateObservation({ runId, invocation: gateInvocation, batch: executionId ?? 'unknown' }, () => execute(body, childOpts))
            : await execute(body, childOpts);
          readingProgress = false;
          await progressPump;
          code = result.exitCode;
          const scrubCommandDiagnostic = current === 'export-check'
            ? (text: string) => scrubReleaseFailureText(text, options.deps?.root ?? process.cwd(), redactCredentials)
            : redactCredentials;
          const stderr = scrubCommandDiagnostic(result.stderr);
          commandFailureReason = failedCommandStderrTail(result.exitCode, stderr);
          return { ...result, stdout: redactCredentials(result.stdout), stderr };
        } finally {
          readingProgress = false;
          await progressPump;
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
      } else if (getTestStateRoot()) {
        // Test isolation takes precedence over process-local config overrides for child state.
        env.ELANOUS_STATE_DIR = root;
      } else if (getElanousConfigDirOverride()) {
        env.ELANOUS_STATE_DIR = effectiveInstanceRoot();
        debug.log('graph-runner', 'child-universe-pinned', { graphId, runId, node: current, configDir: getElanousConfigDirOverride(), stateDir: env.ELANOUS_STATE_DIR });
      }
      env.ELANOUS_GRAPH_CONTEXT = contextPath;
      env.ELANOUS_GRAPH_DRY_RUN = state.dryRun ? '1' : '0';
      env.ELANOUS_GRAPH_DIR = dirname(resolve(path));
      const ctx = { arguments: '', artifactsDir: dirname(statePath), outputs: {}, resolvedProvider: undefined, resolvedModel: undefined, toolPolicy: {}, env,
        ...(options.signal ? { signal: options.signal } : {}) } as NodeExecContext;
      const result = await executeBashNode({ id: current, type: 'bash', bash: state.dryRun ? command.dry_run_command! : command.command,
        idle_timeout: command.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS } as BashNode, ctx, { runBash } as WorkflowDeps);
      output = result.output;
      if (isReleaseLoop && (current === 'gate' || current === 'residual-run') && typeof output === 'string') {
        const gateOutput = lastJsonObject(output);
        if (gateOutput) {
          if (gateOutput.executionId !== undefined && gateOutput.executionId !== executionId) {
            throw new Error('gate output execution id does not match the current gate execution (gate or residual-run)');
          }
          output = JSON.stringify({ ...gateOutput, executionId });
        }
      }
      ok = result.ok;
      exit = code;
      error = result.error ? (current === 'export-check'
        ? scrubReleaseFailureText(result.error, options.deps?.root ?? process.cwd(), redactCredentials)
        : redactCredentials(result.error)) : undefined;
      state.executed++;
    }
    let unitExecuted = false;
    const plannedStep: PlannedStep | undefined = harnessLoopRoute?.get(current);
    if (harnessLoopRoute && !graph.terminalNodes.includes(current)) {
      if (!plannedStep) throw new Error(`harness loop ${graphId} has no declared success route from ${current}`);
      // The planned outcome stands in for the harness node (or unit) that a real loop run would execute.
      output = JSON.stringify({ outcome: plannedStep.outcome ?? 'ok', dryRun: true, plannedNext: plannedStep.to });
    } else if (units.has(current) && !operatorNoGo && !waiving && state.dryRun && !resumingCompleted) {
      // Dry run plans the walk only: no child run, no unit event, no unitCalls entry; the first declared exit stands in.
      output = JSON.stringify({ outcome: units.get(current)!.template.unit!.exits[0], dryRun: true });
    } else if (units.has(current) && !operatorNoGo && !waiving && !resumingCompleted) {
      const unit = units.get(current)!;
      const contract = node.contract!;
      const previous: Record<string, unknown> = Object.create(null);
      for (const record of state.nodes) previous[record.nodeId] = lastJsonObject(record.output) ?? record.output;
      const supplied = state.input && typeof state.input === 'object' && !Array.isArray(state.input)
        ? state.input as Record<string, unknown> : {};
      const callMetadata = node.input && typeof node.input === 'object' && !Array.isArray(node.input)
        ? node.input as Record<string, unknown> : {};
      const lastPrior = state.nodes.at(-1);
      const lastPriorOutput = lastPrior ? previous[lastPrior.nodeId] : undefined;
      const priorResult = lastPriorOutput && typeof lastPriorOutput === 'object' && !Array.isArray(lastPriorOutput)
        ? (lastPriorOutput as Record<string, unknown>).result : undefined;
      const inputs: Record<string, unknown> = Object.create(null);
      let optionalInputMissing = false;
      for (const key of contract.inputs) {
        const binding = callMetadata[key];
        const optionalBinding = typeof binding === 'string' && binding.endsWith('?');
        const resolvedBinding = binding !== undefined
          ? resolveUnitInputBinding(optionalBinding ? binding.slice(0, -1) : binding, previous) : undefined;
        const value = optionalBinding && resolvedBinding === undefined && Object.hasOwn(supplied, key)
          ? supplied[key]
          : binding !== undefined ? resolvedBinding
          : Object.hasOwn(supplied, key) ? supplied[key]
          : key === 'prior' ? (priorResult === undefined ? {} : priorResult) : previous[key];
        if (value !== undefined) inputs[key] = value;
        else if (optionalBinding) optionalInputMissing = true;
      }
      // Graph-v2 unit nodes carry authoring metadata in their input payload. Keep it
      // available to the called unit's prompt without changing the public unit contract.
      const graphNodeMetadata = Object.fromEntries(['type', 'skill', 'uses', 'packs']
        .filter(key => Object.hasOwn(callMetadata, key)).map(key => [key, callMetadata[key]]));
      if (Object.keys(graphNodeMetadata).length > 0 && contract.inputs.includes('context')) {
        const context = inputs.context && typeof inputs.context === 'object' && !Array.isArray(inputs.context)
          ? inputs.context as Record<string, unknown> : {};
        const existing = context.graphNode && typeof context.graphNode === 'object' && !Array.isArray(context.graphNode)
          ? context.graphNode as Record<string, unknown> : {};
        for (const [key, value] of Object.entries(graphNodeMetadata)) {
          if (Object.hasOwn(existing, key) && JSON.stringify(existing[key]) !== JSON.stringify(value))
            throw new Error(`unit graph-node context conflict: ${current}.${key}`);
        }
        inputs.context = { ...context, graphNode: { ...existing, ...graphNodeMetadata } };
      }
      if (contract.inputs.includes('context') && node.context?.ext) {
        inputs.context = withGraphProviderContextExtensions(inputs.context, node.context.ext);
      }
      const alreadySpent = state.path.length + (state.unitCalls ?? []).reduce((sum, call) => sum + call.steps, 0);
      const remaining = Math.min(
        graph.allowance ? graph.allowance.innerSteps - alreadySpent : Infinity,
        options.unitContext ? options.unitContext.remainingSteps - alreadySpent : Infinity,
      );
      const requested = Math.min(node.budget!.innerSteps, node.allowance?.innerSteps ?? node.budget!.innerSteps);
      const allowance = resolveChildAllowance(requested, Math.max(0, remaining));
      const childRunId = randomUUID();
      const selectedEntry = node.callEntry ?? unit.template.entryNode;
      const recordEntry = node.callEntry !== undefined || unit.template.unit?.entries !== undefined;
      const info = { graphId, runId, nodeId: current, unit: unit.template.graphId, childRunId, parentRunId: runId,
        ...(unit.shapeHash === undefined ? {} : { shapeHash: unit.shapeHash }),
        ...(recordEntry ? { entry: selectedEntry } : {}) };
      let entered = false;
      let span: { visit: number; enteredAtMs: number } | undefined;
      if (optionalInputMissing && unit.template.unit!.exits.includes('skip')) {
        output = JSON.stringify({ outcome: 'skip', verdict: 'skip', reason: 'candidate-path-unavailable', receiptPath: '' });
        ok = true;
        state.executed++;
      } else if (allowance.kind === 'needs-human') {
        const exitName = unit.template.unit!.exits.includes('needs-human') ? 'needs-human'
          : unit.template.unit!.exits.includes('rework') ? 'rework' : undefined;
        if (!exitName) throw new Error(`unit has no needs-human or rework exit for zero allowance: ${current}`);
        output = JSON.stringify({ outcome: exitName });
        ok = false;
        error = `unit allowance exhausted before execution: ${current}`;
        debug.log('graph.unit', 'allowance-exhausted', { ...info, requested: allowance.requested, remaining: 0, exit: exitName });
        log('graph.unit', { ...info, phase: 'allowance-exhausted', requested: allowance.requested, remaining: 0, exit: exitName });
      } else try {
        for (const key of contract.inputs) if (!Object.hasOwn(inputs, key)) throw new Error(`unit input missing: ${current}.${key}`);
        if (contract.inputSchema && !graphContractValueMatches(contract.inputSchema, inputs))
          throw new Error(`unit input schema mismatch: ${current}`);
        const currentUnit = resolveGraphUnit(`${unit.template.graphId}@${unit.template.version}`, path);
        if (currentUnit.path !== unit.path || currentUnit.hash !== unit.hash)
          throw new Error(`unit source changed before call: ${current}`);
        const visitIndex = (unitVisits.get(unit.template.graphId) ?? 0) + 1;
        unitVisits.set(unit.template.graphId, visitIndex);
        (state.unitVisitSeq ??= {})[unit.template.graphId] = visitIndex;
        const enteredAtMs = monotonicMs();
        span = { visit: visitIndex, enteredAtMs };
        debug.log('graph.unit', 'enter', { ...info, ...span });
        log('graph.unit', { ...info, phase: 'enter', ...span });
        if (allowance.clamped) {
          debug.log('graph.unit', 'allowance-clamped', { ...info, requested: allowance.requested, granted: allowance.granted, remaining });
          log('graph.unit', { ...info, phase: 'allowance-clamped', requested: allowance.requested, granted: allowance.granted, remaining });
        }
        entered = true;
        const child = await runGraph(unit.path, { runId: childRunId, input: inputs, dryRun: false,
          ...(unit.source === undefined ? {} : { graphSource: unit.source }),
          ...(baseEventBus === undefined ? {} : { eventBus: baseEventBus }),
          ...(options.signal ? { signal: options.signal } : {}),
          pinChildUniverse: options.pinChildUniverse,
          unitContext: { parentRunId: runId, ancestors: [...(options.unitContext?.ancestors ?? []), graphId],
            remainingSteps: allowance.granted,
            ...(recordEntry ? { entryNodeId: selectedEntry } : {}) }, loopBudgetScopes, deps: options.deps });
        const exitedAtMs = monotonicMs();
        // Same (runId, unit, visit): never let a clock that went backwards emit a negative span.
        const durationMs = Math.max(0, exitedAtMs - enteredAtMs);
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
          ...(unit.shapeHash === undefined ? {} : { shapeHash: unit.shapeHash }),
          visit: visitIndex, enteredAtMs, exitedAtMs, durationMs,
          ...(recordEntry ? { entry: selectedEntry } : {}) });
        if (child.status === 'awaiting-approval') throw new Error(`unit cannot pause for approval: ${current}`);
        if (child.status === 'budget-exceeded' || steps > allowance.granted || steps > remaining) {
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
        if (contract.outputSchema && !graphContractValueMatches(contract.outputSchema, result))
          throw new Error(`unit output schema mismatch: ${current}`);
        output = JSON.stringify(result);
        ok = child.status === 'done';
        debug.log('graph.unit', 'exit', { ...info, exit: childExit, steps, visit: visitIndex, enteredAtMs, exitedAtMs, durationMs });
        log('graph.unit', { ...info, phase: 'exit', exit: childExit, steps, visit: visitIndex, enteredAtMs, exitedAtMs, durationMs });
      } catch (cause) {
        ok = false;
        error = redactCredentials(cause instanceof Error ? cause.message : String(cause));
        if (entered && span) {
          const exitedAtMs = monotonicMs();
          const durationMs = Math.max(0, exitedAtMs - span.enteredAtMs);
          const call = state.unitCalls?.at(-1);
          if (call && call.childRunId === childRunId) {
            call.exitedAtMs = exitedAtMs;
            call.durationMs = durationMs;
          }
          debug.log('graph.unit', 'exit', { ...info, error, ...span, exitedAtMs, durationMs });
          log('graph.unit', { ...info, phase: 'exit', error, ...span, exitedAtMs, durationMs });
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
        if (!callLLM) throw new Error('prompt node requires an injected LLM (deps.callLLM)');
        output = await callLLM(text.text);
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
          if (!callLLM) throw new Error('classify node requires an injected LLM (deps.callLLM)');
          return callLLM(prompt);
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
      // Keep the accepted waiver distinct in the graph outcome so its explicit route is auditable.
      output = JSON.stringify(options.releaseWaiver!.ownerWaived
        ? { outcome: 'ok', verdict: 'owner-waived', summary: `owner waived ${current}`, reason: options.releaseWaiver!.reason, approvedBy: options.releaseWaiver!.approvedBy }
        : { outcome: 'ok', verdict: 'waived', summary: `waived ${current}`, reason: options.releaseWaiver!.reason });
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
        const rejectionReason = state.pending?.decision === 'rejected'
          ? `approval rejected${state.pending.decidedBy ? ` by ${state.pending.decidedBy}` : ''}` : undefined;
        const selected = node.hitl?.options.length === 2
          ? node.hitl.options.find(option => (option.default === true) === !ok)
          : undefined;
        output = JSON.stringify({ outcome: selected?.exit ?? (ok ? 'approved' : 'rejected'),
          ...(selected ? { choice: selected.key } : {}), graphId, runId, nodeId: current,
          ...(state.pending?.decidedBy === undefined ? {} : { decidedBy: state.pending.decidedBy }), decidedAt: state.pending?.decidedAt ?? null,
          ...(rejectionReason ? { error: rejectionReason } : {}) });
        if (rejectionReason) error = rejectionReason;
      }
      const joinFailureMessage = branchDiagnostics.length
        ? `join failed: ${JSON.stringify({ failedBranches: branchDiagnostics })}` : undefined;
      const releaseRoot = options.deps?.root ?? process.cwd();
      const releaseDetail = !ok && current === 'export-check' ? releaseNodeFailureDetail(output, releaseRoot, redactCredentials) : undefined;
      if (!ok && current === 'export-check') output = scrubReleaseNodeOutput(output, releaseRoot, redactCredentials);
      if (releaseDetail) {
        const structured = lastJsonObject(output);
        if (structured) output = JSON.stringify({ ...structured, failureDetail: releaseDetail });
        debug.log('release-loop.node', 'failed', { graphId, runId, nodeId: current, ...releaseDetail });
      }
      const rawFailureMessage = !ok
        ? redactCredentials([commandFailureReason ?? error ?? joinFailureMessage ?? `Node ${current} failed without a diagnostic.`,
          ...(releaseDetail ? [`${releaseDetail.kind}${releaseDetail.markers.length ? ` · ${releaseDetail.markers.join(', ')}` : ''}${releaseDetail.locations.length ? ` · ${releaseDetail.locations.join(', ')}` : ''}${releaseDetail.stderrTail ? ` · ${releaseDetail.stderrTail}` : ''}`] : [])].join(' · '))
        : undefined;
      const failureMessage = rawFailureMessage === undefined ? undefined : releaseDetail
        ? scrubReleaseFailureText(rawFailureMessage, releaseRoot, redactCredentials) : rawFailureMessage;
      const failure = failureMessage === undefined ? undefined : {
        errorCode: error?.startsWith('unit input missing:') ? 'GRAPH_UNIT_INPUT_MISSING' : 'GRAPH_NODE_FAILED',
        message: failureMessage,
        stage: units.has(current) ? 'unit-invocation' : command ? 'command-execution' : prompt ? 'prompt-execution' : 'node-execution',
      };
      const hasOutput = waiving || harnessLoopRoute || units.has(current) || handlerExecuted || !!joinedFanout ||
        ((command || prompt || approval || node.kind === 'classify') && (!state.dryRun || !!command?.dry_run_command));
      const storedOutput = hasOutput ? output : undefined;
      const rawReceiptCommit = current === 'version-release' ? lastJsonObject(output)?.commit : completionCommit(state) ?? options.branchCutTip;
      const receiptCommit = typeof rawReceiptCommit === 'string' && /^[a-f0-9]{40}$/i.test(rawReceiptCommit) ? rawReceiptCommit : undefined;
      const artifactSnapshot = completionArtifactSnapshot(storedOutput ?? null, options.deps?.root ?? process.cwd());
      const completionReceipt = ok && receiptCommit !== undefined && artifactSnapshot.valid
        ? { inputSha256: nodeCompletionInputSha256, commit: receiptCommit, artifactSha256: artifactSnapshot.sha256 }
        : undefined;
      state.nodes.push({ nodeId: current, executionId, ok, exit, executed: !waiving && (handlerExecuted || (!!joinedFanout && !state.dryRun) || (!!command && (!state.dryRun || !!command.dry_run_command)) || (!!prompt && !state.dryRun) || (node.kind === 'classify' && !state.dryRun) || unitExecuted), ...(storedOutput === undefined ? {} : { output: storedOutput }), ...(completionReceipt === undefined ? {} : { completionReceipt }), ...(error ? { error } : {}),
        ...(failure ? { reason: failure.message, failure } : {}), ...(commandFailureReason && !failure ? { reason: commandFailureReason } : {}),
        ...(waiving ? { waiver: { reason: options.releaseWaiver!.reason, at: nodeEndedAt, ...(options.releaseWaiver!.approvedBy === undefined ? {} : { approvedBy: options.releaseWaiver!.approvedBy }), ...(options.releaseWaiver!.ownerWaived ? { ownerWaived: true } : {}), ...(options.releaseWaiver!.introducedIds === undefined ? {} : { introducedIds: options.releaseWaiver!.introducedIds }), ...(options.releaseWaiver!.unmeasured === undefined ? {} : { unmeasured: options.releaseWaiver!.unmeasured }), original: { exit: waivedRecord!.exit, ...(waivedRecord!.output === undefined ? {} : { output: waivedRecord!.output }), ...(waivedRecord!.error === undefined ? {} : { error: waivedRecord!.error }) } } } : {}),
        ...(approval && state.pending ? { ...(state.pending.decidedBy === undefined ? {} : { decidedBy: state.pending.decidedBy }), decidedAt: state.pending.decidedAt } : {}),
        startedAt: nodeStartedAt, endedAt: nodeEndedAt, seconds });
    }
    const completedRecord = [...state.nodes].reverse().find(record => record.nodeId === current);
    // Source: real fan-out joins are executed records too; dry-run previews do not execute them.
    if (!resumingCompleted && completedRecord?.executed && state.executed === executedBeforeNode) state.executed++;
    if (isReleaseLoop && graph.terminalNodes.includes(current) && node.recipe === 'none' &&
      (exit !== null || output !== undefined || error !== undefined || completedRecord?.executed)) {
      await emitReleaseStage(current, 'fail');
      throw new Error(`release terminal received command output: ${current}`);
    }
    await emitReleaseStage(current, !ok ? 'fail' : (waiving || approval || joinedFanout || graph.terminalNodes.includes(current) || completedRecord?.executed) ? 'ok' : 'skip');
    if (approval) {
      delete state.pending;
      delete state.approvalSourceHash;
    }
    const reported: unknown = joinedFanout || waiving || approval || harnessLoopRoute || units.has(current) || handlerExecuted || (resumingCompleted && inProcessHandler) || (prompt && !state.dryRun) || (command && (!state.dryRun || command.dry_run_command)) ? lastJsonObject(resumingCompleted ? completed?.output : output)?.outcome : undefined;
    // A dry run never executes the switch recipe; preview its pinned policy choice instead.
    const dryRunCutover = state.dryRun && graphId === 'release-loop' && current === 'gate-cutover-switch'
      ? releaseGateCutoverPath(state.input) : undefined;
    const namedOutcome: string | undefined = typeof dryRunCutover === 'string' ? dryRunCutover
      : typeof reported === 'string' ? reported : undefined;
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
    await emitVisitLifecycle('end', current, visit, { outcome: ok ? 'ok' : 'fail', ...(nodeReason ? { reason: nodeReason } : {}) },
      { nodeId: current, ok, exit, ...(nodeReason === undefined ? {} : { reason: nodeReason }),
        ...(namedOutcome === undefined ? {} : { outcome: namedOutcome }), dryRun: state.dryRun });
    if (!resumingCompleted) {
      // Recipe commands expose stdout/exit but no provider usage; never infer zero from success.
      observeModelInputTokens({ scope: 'harness-node', nodeKind: node.kind, runId, nodeId: current });
    }
    let releaseGateFailedEvent: GraphEvent | undefined;
    const triageOutput = lastJsonObject(completedRecord?.output);
    if (isReleaseLoop && current === 'gate-triage' && !state.dryRun && !resumingCompleted &&
      hasActionableGateTriageEvidence(triageOutput)) {
      const gateRecord = [...state.nodes].reverse().find((record) =>
        (record.nodeId === 'gate' || record.nodeId === 'residual-run') && record.output !== undefined);
      const gateOutput = lastJsonObject(gateRecord?.output);
      if (!gateOutput || !triageOutput || typeof state.input !== 'object' || state.input === null || Array.isArray(state.input))
        throw new Error('release.gate.failed cannot be emitted without gate, triage, and release input evidence');
      if (!gateRecord?.executionId || gateOutput.executionId !== gateRecord.executionId || triageOutput.gateExecutionId !== gateRecord.executionId)
        throw new Error('release.gate.failed requires triage evidence from the latest gate execution id');
      const releaseInput = state.input as Record<string, unknown>;
      const sourceOutcome = gateOutput.outcome;
      const normalizedGate = { ...gateOutput, outcome: sourceOutcome === 'fail' ? 'regression' : sourceOutcome };
      releaseGateFailedEvent = eventBus.prepare({ graphId, runId, type: RELEASE_GATE_FAILED_EVENT,
        source: { kind: 'node', nodeId: 'gate-triage' },
        data: { version: releaseInput.version, gate: normalizedGate, triage: triageOutput,
          ...(Object.prototype.hasOwnProperty.call(releaseInput, 'macrophageRepairLadder')
            ? { macrophageRepairLadder: releaseInput.macrophageRepairLadder } : {}),
          ...(sourceOutcome === 'ok' || sourceOutcome === 'regression' || sourceOutcome === 'error' || sourceOutcome === 'fail'
            ? { sourceOutcome } : {}),
          ...(releaseInput.gateExecutor === 'host' || releaseInput.gateExecutor === 'pod' ? { gateExecutor: releaseInput.gateExecutor } : {}),
          ...(typeof releaseInput.gatePodPool === 'string' ? { gatePodPool: releaseInput.gatePodPool } : {}),
          visitState: { gate: visits.get('gate') ?? 0, gateTriage: visits.get('gate-triage') ?? 0 },
          dryRun: false } });
      state.pendingGraphEvents ??= [];
      if (!state.pendingGraphEvents.some((pending) => pending.eventId === releaseGateFailedEvent!.eventId))
        state.pendingGraphEvents.push(releaseGateFailedEvent);
    }
    // Persist the completed triage record and its ARG event outbox entry in one ledger write.
    persist();
    if (releaseGateFailedEvent) await publishLifecycleEvent(releaseGateFailedEvent);
    if (options.signal?.aborted) {
      await emitVisitLifecycle('leave', current, visit, { outcome: ok ? 'ok' : 'fail', reason: 'cancelled' });
      state.status = 'failed';
      state.reason = 'cancelled';
      persist();
      break;
    }
    if (graph.terminalNodes.includes(current)) {
      state.status = !ok ? 'failed' : graph.unit ? (current === 'failed' ? 'failed' : 'done')
        : topLevelTerminalStatus(graph.graphId, current)!;
      if (!graph.unit && current !== 'done' && current !== 'failed') state.reason = current;
      else delete state.reason;
      await emitVisitLifecycle('leave', current, visit, { outcome: ok ? 'ok' : 'fail', reason: 'terminal' });
      persist();
      if (state.status === 'failed' && !state.dryRun && graphId === 'release-loop') {
        recordReleaseRunFailure(state, root, `Graph ${graphId}/${runId} failed at ${current}`);
      }
      if (state.status === 'failed' && !state.dryRun && graphId === 'heal-loop') {
        alertHealLoopFailure(state, `Graph ${graphId}/${runId} failed at ${current}`, options.deps?.postOpAlert);
      }
      break;
    }
    const fromNodeId = current;
    const edge = graph.edges.find((candidate) => candidate.from === current);
    if (!growthScope && !growthScopeSkipLogged && !resumedGrowth && document.grow === 'on' && !state.dryRun && namedOutcome !== undefined &&
        (state.growthAttempts ?? 0) < 8 && (state.growth?.length ?? 0) < 3 &&
        edge?.on === 'outcome' && edge.map && !Object.hasOwn(edge.map, namedOutcome) &&
        !state.growth?.some((item) => item.undo.removeOutcome.from === current && item.undo.removeOutcome.outcome === namedOutcome) &&
        !state.growthRejections?.some((item) => item.from === current && item.outcome === namedOutcome)) {
      growthScopeSkipLogged = true;
      log('growth-skipped-no-scope', { graphId, runId, from: current, outcome: namedOutcome });
    }
    if (growthScope && !growthCapReachedLogged && !resumedGrowth && document.grow === 'on' && !state.dryRun && namedOutcome !== undefined &&
        edge?.on === 'outcome' && edge.map && !Object.hasOwn(edge.map, namedOutcome) &&
        !state.growth?.some((item) => item.undo.removeOutcome.from === current && item.undo.removeOutcome.outcome === namedOutcome) &&
        !state.growthRejections?.some((item) => item.from === current && item.outcome === namedOutcome)) {
      state.growthEvents ??= [];
      let result: Awaited<ReturnType<typeof proposeGrowth>>;
      if ((state.growthAttempts ?? 0) >= 8) result = { ok: false, reason: 'growth proposal limit 8 reached' };
      else if ((state.growth?.length ?? 0) >= 3) result = { ok: false, reason: 'growth limit 3 reached' };
      else {
        const at = new Date().toISOString();
        const input = { graph, nodeId: current, outcome: namedOutcome, runId, output: state.nodes.at(-1)?.output };
        state.growthEvents.push({ phase: 'proposal', from: current, outcome: namedOutcome, at });
        state.growthAttempts = (state.growthAttempts ?? 0) + 1;
        persist();
        const allowedKinds = new Set(['agent', 'observe', 'judge']);
        const proposer = options.deps?.growthProposer ?? createLLMGrowthProposer(growthLLM);
        // Enforce the vocabulary at the runner boundary even when a caller injects a non-LLM proposer.
        const constrainedProposer: GrowthProposer = async (proposalInput) => {
          const proposal = await proposer(proposalInput);
          return proposal && allowedKinds.has(proposal.node.kind) ? proposal : undefined;
        };
        result = await proposeGrowth(input, constrainedProposer, (candidate) => {
            const resolved = resolveNodeRecipe(candidate, recipes, catalogRoles, graphManifest);
            if (!resolved.command && !resolved.approval && candidate.recipe !== 'none') return 'unknown';
            return { effect: resolved.approval ? 'unknown' : options.deps?.classifyGrowthRecipe?.(candidate, { command: resolved.command?.command }) ?? 'unknown',
              command: resolved.command, approval: resolved.approval?.approval };
          }, { ...options.deps?.growthDecision, root }, options.researchEdgeDecisionRegistry);
      }
      if (result.ok) {
        graph = result.graph;
        state.growth ??= [];
        state.growth.push(result.growth);
        state.growthEvents.push({ phase: 'applied', from: current, outcome: namedOutcome, at: new Date().toISOString(),
          nodeId: result.growth.node.nodeId, kind: result.growth.node.kind });
        state.growthEvents.push({ phase: 'undo-available', from: current, outcome: namedOutcome, at: new Date().toISOString(),
          nodeId: result.growth.node.nodeId, undo: result.growth.undo });
        persist();
        log('edge-added', { graphId, runId, from: current, outcome: namedOutcome, to: result.growth.node.nodeId });
        debug.log('graph.run', 'edge-added', { graphId, runId, from: current, outcome: namedOutcome, to: result.growth.node.nodeId });
        publishInsideEvent({ kind: 'edge-added', graphId, runId, from: current, outcome: namedOutcome, to: result.growth.node.nodeId });
      } else {
        state.growthRejections ??= [];
        const capped = result.reason === 'growth proposal limit 8 reached' || result.reason === 'growth limit 3 reached';
        if (capped) growthCapReachedLogged = true;
        state.growthRejections.push({ from: current, outcome: namedOutcome, reason: result.reason });
        if (result.park && result.growth && result.decisionId && result.decisionRef) {
          state.growthEvents.push({ phase: 'parked', from: current, outcome: namedOutcome, at: new Date().toISOString(), reason: result.reason,
            nodeId: result.growth.node.nodeId, kind: result.growth.node.kind, undo: result.growth.undo });
          state.status = 'awaiting-approval';
          state.pending = { nodeId: current, message: result.reason, since: new Date().toISOString() };
          state.growthPark = { from: current, outcome: namedOutcome, reason: result.reason,
            growth: result.growth, decisionId: result.decisionId, decisionRef: result.decisionRef,
            ...(result.command ? { command: result.command } : {}), ...(result.approval ? { approval: result.approval } : {}) };
          persist();
          await emitVisitLifecycle('leave', current, visit, { outcome: ok ? 'ok' : 'fail', reason: 'awaiting-growth-approval' });
          break;
        }
        state.growthEvents.push({ phase: 'rejected', from: current, outcome: namedOutcome, at: new Date().toISOString(), reason: result.reason,
          ...(result.growth ? { nodeId: result.growth.node.nodeId, kind: result.growth.node.kind, undo: result.growth.undo } : {}) });
      }
      persist();
    }
    const completedNodeId: string = current;
    // A planned harness loop follows its route directly: `changed-files` edges have no runner condition.
    const edgeOutcome: 'ok' | 'fail' = state.dryRun && !command?.dry_run_command ? 'ok' : ok ? 'ok' : 'fail';
    const outgoing = graph.edges.find((candidate) => candidate.from === current);
    const outputForHealing = lastJsonObject(state.nodes.at(-1)?.output);
    const evidenceForHealing = outputForHealing?.evidence && typeof outputForHealing.evidence === 'object' && !Array.isArray(outputForHealing.evidence)
      ? outputForHealing.evidence as Record<string, unknown> : {};
    const acceptanceDecisions = new Map<string, boolean>();
    const acceptanceDecision = (edge: DeclaredHealEdge): boolean => {
      if (acceptanceDecisions.has(edge.edgeRef)) return acceptanceDecisions.get(edge.edgeRef)!;
      let accepted = false;
      try {
        const id = evidenceForHealing.id;
        const rule = evidenceForHealing.rule;
        const input = state.input && typeof state.input === 'object' && !Array.isArray(state.input)
          ? state.input as Record<string, unknown> : {};
        const version = input.version;
        const isSemver = (value: unknown): value is string => {
          if (typeof value !== 'string' || value.trim() !== value) return false;
          const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
          return !!match && (!match[4] || match[4].split('.').every((part) => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0')));
        };
        const ledgerPath = edge.ledger!.includes('{{input.version}}')
          ? isSemver(version) ? edge.ledger!.replaceAll('{{input.version}}', version) : ''
          : edge.ledger!;
        const file = ledgerPath ? resolve(root, ledgerPath) : '';
        if (file.startsWith(resolve(root) + sep) && typeof id === 'string' && typeof rule === 'string' && edge.rules!.includes(rule)) {
          const ledger = JSON.parse(readFileSync(file, 'utf8')) as { items?: Array<{ id?: string; rule?: string; acceptedVersion?: string; expiresAt?: string }> };
          const versionOrder = (value: unknown): number | null => {
            if (!isSemver(value)) return null;
            const order = input.releaseOrder;
            if (!Array.isArray(order) || new Set(order).size !== order.length || !order.every(isSemver)) return null;
            return order.indexOf(value);
          };
          accepted = Array.isArray(ledger.items) && ledger.items.some((item) => {
            if (item.id !== id || item.rule !== rule || typeof item.expiresAt !== 'string') return false;
            const expiry = edge.expiry!;
            if (typeof expiry === 'string') return Date.now() <= Date.parse(expiry) && Date.now() <= Date.parse(item.expiresAt);
            const current = versionOrder(version);
            const acceptedAt = versionOrder(item.acceptedVersion);
            const expiresAt = versionOrder(item.expiresAt);
            return current !== null && current >= 0 && acceptedAt !== null && acceptedAt >= 0
              && expiresAt !== null && expiresAt >= 0 && acceptedAt <= current && current <= expiresAt
              && expiresAt - acceptedAt <= expiry;
          });
        }
      } catch { /* Missing or malformed acceptance evidence follows the declared else edge. */ }
      acceptanceDecisions.set(edge.edgeRef, accepted);
      return accepted;
    };
    const branchOutcome: string | undefined = namedOutcome !== undefined && outgoing?.branches && Object.hasOwn(outgoing.branches, namedOutcome)
      ? namedOutcome : outgoing?.branches && Object.hasOwn(outgoing.branches, edgeOutcome) ? edgeOutcome : undefined;
    const matchingHealEdge = !plannedStep
      ? healEdges.find((edge) => edge.from === completedNodeId
        && (edge.on.includes(namedOutcome ?? edgeOutcome) || edge.on.includes(edgeOutcome)))
      : undefined;
    const acceptBeforeFanOut = matchingHealEdge?.kind === 'accept' ? acceptanceDecision(matchingHealEdge) : undefined;
    const healingBeforeFanOut = (matchingHealEdge !== undefined
      && ['retry', 'heal', 'detour', 'escalate'].includes(matchingHealEdge.kind))
      || (matchingHealEdge?.kind === 'accept' && acceptBeforeFanOut === false)
      || (state.healPending?.via === completedNodeId && !ok);
    const selectedBranchOutcome = healingBeforeFanOut ? undefined : branchOutcome;
    if (!plannedStep && outgoing?.branches && selectedBranchOutcome !== undefined && outgoing.join) {
      const destinations = outgoing.branches[selectedBranchOutcome]!;
      const fanOutKey: string = `${current}:${selectedBranchOutcome}`;
      const fanout: NonNullable<GraphRunState['fanOuts']>[string] = state.fanOuts?.[fanOutKey] ?? { from: current, join: outgoing.join, branches: {} };
      if (fanout.join !== outgoing.join) throw new Error(`fan-out state conflicts with graph: ${fanOutKey}`);
      const runningBranch = destinations.find((id) => fanout.branches[id]?.status === 'running');
      if (runningBranch) throw new Error(`fan-out branch ${runningBranch} is still marked running; crashed-child recovery is not supported`);
      state.fanOuts ??= {};
      state.fanOuts[fanOutKey] = fanout;
      const parentOutputs = state.nodes.map((record) => [record.nodeId, record.output ?? null]);
      const sourceCommit = completionCommit(state);
      const hasCompletedBranch = destinations.some((branchId) => fanout.branches[branchId]?.status === 'done');
      const sourceRoot = options.releaseCommandSource?.root ?? options.deps?.root ?? process.cwd();
      const verifiedSourceCommit = sourceCommit && hasCompletedBranch
        ? actualSourceCommit(sourceRoot, options.releaseCommandSource?.git)
        : undefined;
      const branchInputSha256 = (branchId: string) => stableSha256({ graphId, sourceHash: state.sourceHash ?? null,
        input: state.input ?? null, from: current, branchId, outputs: parentOutputs });
      const selected = destinations.filter((branchId) => {
        const branch = fanout.branches[branchId];
        if (branch?.status !== 'done') return true;
        const receipt = branch.completionReceipt;
        const artifactSnapshot = completionArtifactSnapshot(branch.output, options.deps?.root ?? process.cwd());
        return !sourceCommit || !verifiedSourceCommit || verifiedSourceCommit !== sourceCommit || !receipt ||
          receipt.inputSha256 !== branchInputSha256(branchId) || receipt.commit !== sourceCommit ||
          !branch.artifactSha256 || receipt.artifactSha256 !== branch.artifactSha256 ||
          !artifactSnapshot.valid || branch.artifactSha256 !== artifactSnapshot.sha256;
      });
      const pending = [...selected];
      const active = new Map<Promise<string>, { branchId: string; locks: readonly string[] }>();
      const activeLocks = new Set<string>();
      const maxParallel = graph.maxParallelNodes ?? Math.max(1, selected.length);
      const launch = (branchId: string): void => {
        const runId = randomUUID();
        fanout.branches[branchId] = { runId, status: 'running', startedAt: new Date().toISOString() };
        const locks = graph.nodes.find((node) => node.nodeId === branchId)?.resourceLocks ?? [];
        for (const lock of locks) activeLocks.add(lock);
        persist();
        const work = (async () => {
          const branch = fanout.branches[branchId]!;
          try {
          // Each branch's fresh runId owns its registrations; parent subscriptions remain scoped to the parent run.
          fanOutDailyBudgetExemptRunIds.add(runId);
          let child: GraphRunState;
          try { child = await runGraph(path, { runId, graphSource: fanOutGraphSource(variantSource, graph, branchId), input: state.input,
            ...(baseEventBus === undefined ? {} : { eventBus: baseEventBus }),
            dryRun: state.dryRun, quiet: true, signal: options.signal, pinChildUniverse: options.pinChildUniverse,
            releaseCommandSource: options.releaseCommandSource,
            branchCutTip: lastJsonObject(state.nodes.find((record) => record.nodeId === 'version-release')?.output)?.commit as string | undefined,
            branchGraphSnapshot: state.graphSnapshot,
            branchParentOutputs: Object.fromEntries(state.nodes.map((record) => [record.nodeId, lastJsonObject(record.output) ?? record.output ?? null])),
            researchEdgeDecisionRegistry: options.researchEdgeDecisionRegistry,
            loopBudgetScopes,
            deps: options.deps }); }
          finally { fanOutDailyBudgetExemptRunIds.delete(runId); }
          const record = child.nodes.find((item) => item.nodeId === branchId);
          if (state.dryRun) branch.path = child.path;
          branch.status = child.status === 'done' && record?.ok ? 'done' : 'failed';
          if (record?.output !== undefined) {
            branch.output = record.output;
            const artifactSnapshot = completionArtifactSnapshot(record.output, options.deps?.root ?? process.cwd());
            branch.artifactSha256 = artifactSnapshot.sha256;
            if (sourceCommit && artifactSnapshot.valid) branch.completionReceipt = { inputSha256: branchInputSha256(branchId), commit: sourceCommit,
              artifactSha256: branch.artifactSha256 };
          }
          if (record?.error) branch.error = record.error;
          else if (child.status !== 'done') branch.error = `branch child run ended ${child.status}`;
          } catch (cause) {
            branch.status = 'failed';
            branch.error = cause instanceof Error ? cause.message : String(cause);
          }
          branch.endedAt = new Date().toISOString();
          persist();
          return branchId;
        })();
        active.set(work, { branchId, locks });
      };
      while (pending.length || active.size) {
        while (active.size < maxParallel) {
          const readyIndex = pending.findIndex((branchId) =>
            (graph.nodes.find((node) => node.nodeId === branchId)?.resourceLocks ?? []).every((lock) => !activeLocks.has(lock)));
          if (readyIndex < 0) break;
          const [branchId] = pending.splice(readyIndex, 1);
          if (branchId !== undefined) launch(branchId);
        }
        if (active.size === 0) throw new Error(`fan-out scheduler has pending nodes but no runnable node: ${fanOutKey}`);
        const completed = await Promise.race(active.keys());
        const completedTask = [...active].find(([, task]) => task.branchId === completed);
        if (completedTask) active.delete(completedTask[0]);
        for (const lock of completedTask?.[1].locks ?? []) activeLocks.delete(lock);
      }
      persist();
      current = outgoing.join;
    } else {
      current = plannedStep ? plannedStep.to
        : nextNode(graph.edges, current, edgeOutcome, namedOutcome);
    }
    if (!plannedStep && healEdges.length) {
      const priorTransition = (state.healTransitions ?? []).find((item) => item.from === completedNodeId
        && item.visit === (visits.get(completedNodeId) ?? 0));
      if (priorTransition) {
        current = priorTransition.to;
      } else {
      const reportHeal = (event: string, edgeRef: string, data: Record<string, unknown>): void => {
        const details = { graphId, runId, edgeRef, ...data };
        log(`graph.${event}`, details);
        debug.log('graph.run', event, details);
      };
      let selected: { edgeRef: string; kind: string; to: string } | undefined;
      const pending = state.healPending;
      if (pending?.via === completedNodeId && !matchingHealEdge) {
        if (ok && outgoing?.branches && selectedBranchOutcome !== undefined && outgoing.join) {
          // A repair node's declared fan-out join is part of the repair result. Resolve its rejoin only after the join runs.
          pending.via = outgoing.join;
        } else {
          selected = { edgeRef: pending.edgeRef, kind: ok ? 'rejoin' : 'escalate',
            to: ok ? pending.to : pending.exhaustedTo };
          reportHeal(selected.kind, pending.edgeRef, { from: pending.from, via: pending.via, to: selected.to,
            ...(ok ? { budgetLeft: Math.max(0, (graph.nodes.find((node) => node.nodeId === pending.from)?.maxVisits ?? 0) - (visits.get(pending.from) ?? 0)) }
              : { exhausted: true }) });
          delete state.healPending;
        }
      } else {
        if (pending?.via === completedNodeId && matchingHealEdge) {
          // An explicit edge from the repair node supersedes its prior pending rejoin.
          delete state.healPending;
        }
        const completedOutput = lastJsonObject(state.nodes.at(-1)?.output);
        const evidence = completedOutput?.evidence && typeof completedOutput.evidence === 'object' && !Array.isArray(completedOutput.evidence)
          ? completedOutput.evidence as Record<string, unknown> : {};
        const outcome = namedOutcome ?? edgeOutcome;
        for (const edge of healEdges) {
          if (edge.from !== completedNodeId || (!edge.on.includes(outcome) && !edge.on.includes(edgeOutcome))) continue;
          const used = (state.healTransitions ?? []).filter((item) => item.edgeRef === edge.edgeRef && item.kind === edge.kind).length;
          const visitsLeft = (graph.nodes.find((node) => node.nodeId === completedNodeId)?.maxVisits ?? 0) - (visits.get(completedNodeId) ?? 0);
          if (edge.kind === 'retry' || edge.kind === 'heal') {
            if (used >= edge.attempts! || visitsLeft <= 0) {
              selected = { edgeRef: edge.edgeRef, kind: 'escalate', to: edge.exhaustedTo! };
              reportHeal('escalate', edge.edgeRef, { from: completedNodeId, to: selected.to, exhausted: true });
            } else if (edge.kind === 'retry') {
              selected = { edgeRef: edge.edgeRef, kind: 'retry', to: completedNodeId };
              reportHeal('retry', edge.edgeRef, { from: completedNodeId, to: completedNodeId,
                attempt: used + 1, left: edge.attempts! - used - 1 });
            } else {
              const className = typeof evidence.class === 'string' ? evidence.class : outcome;
              const repair = edge.repair?.[className];
              if (!repair || typeof repair !== 'string') {
                const escalation = repair && typeof repair === 'object' ? repair.escalate : edge.exhaustedTo!;
                selected = { edgeRef: edge.edgeRef, kind: 'escalate', to: escalation };
                reportHeal('escalate', edge.edgeRef, { from: completedNodeId, to: selected.to, class: className, exhausted: false });
              } else {
                selected = { edgeRef: edge.edgeRef, kind: 'heal', to: repair };
                state.healPending = { edgeRef: edge.edgeRef, from: completedNodeId, via: repair,
                  to: completedNodeId, exhaustedTo: edge.exhaustedTo! };
                reportHeal('heal', edge.edgeRef, { from: completedNodeId, to: repair, class: className, repair,
                  attempt: used + 1, evidence: completedOutput?.evidence ?? null });
              }
            }
          } else if (edge.kind === 'detour') {
            const rejoin = edge.rejoin === 'computed'
              ? outgoing?.branches && branchOutcome !== undefined && outgoing.join ? outgoing.join : current
              : edge.rejoin;
            if (!rejoin) throw new Error('computed detour has no route');
            if (rejoin === completedNodeId && visitsLeft <= 0) {
              selected = { edgeRef: edge.edgeRef, kind: 'escalate', to: edge.exhaustedTo! };
              reportHeal('escalate', edge.edgeRef, { from: completedNodeId, to: selected.to, exhausted: true });
            } else {
              selected = { edgeRef: edge.edgeRef, kind: 'detour', to: edge.via! };
              state.healPending = { edgeRef: edge.edgeRef, from: completedNodeId, via: edge.via!,
                to: rejoin, exhaustedTo: edge.exhaustedTo! };
              reportHeal('edge-added', edge.edgeRef, { from: completedNodeId, via: edge.via, rejoin });
            }
          } else if (edge.kind === 'append-recheck') {
            const fromOutput = completedOutput?.changedFiles;
            const fromInput = state.input && typeof state.input === 'object' && !Array.isArray(state.input)
              ? (state.input as Record<string, unknown>).changedFiles : undefined;
            const changed = Array.isArray(fromOutput) ? fromOutput : Array.isArray(fromInput) ? fromInput : [];
            if (changed.some((file) => typeof file !== 'string')) throw new Error(`${edge.edgeRef} changedFiles must be paths`);
            const matches = (path: string, pattern: string): boolean => {
              const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*\*\//g, '__DOUBLE_STAR_SLASH__')
                .replace(/\*\*/g, '__DOUBLE_STAR__').replace(/\*/g, '[^/]*')
                .replaceAll('__DOUBLE_STAR_SLASH__', '(?:.*/)?').replaceAll('__DOUBLE_STAR__', '.*');
              return new RegExp(`^${escaped}$`).test(path);
            };
            const promoted = !changed.length || (changed as string[]).some((file) => edge.promote!.when.some((pattern) => matches(file, pattern)));
            selected = { edgeRef: edge.edgeRef, kind: 'recheck', to: promoted ? edge.promote!.to : edge.recheck! };
            reportHeal('recheck', edge.edgeRef, { from: completedNodeId, to: selected.to, scope: promoted ? 'full' : 'radius',
              why: promoted ? 'changed path matches promote.when' : 'changed paths stay in radius', changedFiles: changed });
          } else if (edge.kind === 'accept') {
            const accepted = acceptanceDecision(edge);
            const destination = accepted ? edge.to ?? current : edge.elseTo!;
            if (!destination) throw new Error('accepted route has no declared destination');
            selected = { edgeRef: edge.edgeRef, kind: 'accept', to: destination };
            reportHeal('accept', edge.edgeRef, { from: completedNodeId, to: destination, accepted,
              items: accepted ? [evidence.id] : [], rule: evidence.rule ?? null, expiresAt: edge.expiry });
          } else {
            selected = { edgeRef: edge.edgeRef, kind: 'escalate', to: edge.to! };
            reportHeal('escalate', edge.edgeRef, { from: completedNodeId, to: selected.to, evidence: edge.evidence,
              exhausted: false });
          }
          break;
        }
      }
      if (selected) {
        let transitionTo = selected.to;
        if (outgoing?.branches && outgoing.join && current === outgoing.join && selected.to !== outgoing.join
          && (selected.kind === 'recheck' || selected.kind === 'accept')) {
          // Run the selected branch join before applying its post-fan-out route.
          const joinFailureTarget = nextNode(graph.edges, outgoing.join, 'fail');
          if (!joinFailureTarget) throw new Error(`fan-out join has no declared failure route: ${outgoing.join}`);
          state.healPending = { edgeRef: selected.edgeRef, from: completedNodeId, via: outgoing.join,
            to: selected.to, exhaustedTo: joinFailureTarget };
          // Resume at the join if the process stops before it runs; `selected.to` is after the join.
          transitionTo = outgoing.join;
        } else {
          current = selected.to;
        }
        state.healTransitions ??= [];
        state.healTransitions.push({ edgeRef: selected.edgeRef, kind: selected.kind, from: completedNodeId,
          visit: visits.get(completedNodeId) ?? 0, to: transitionTo });
        persist();
      }
      }
    }
    const naturalNext: string | undefined = current;
    const continuation = wakeContinuation;
    let scheduledNext: string | undefined = naturalNext;
    if (continuation && (continuation.nodeId === completedNodeId || continuation.appendNodeIds?.includes(completedNodeId))) {
      const isAppendedNode = continuation.appendNodeIds?.includes(completedNodeId) === true;
      const isLastAppendedNode = !isAppendedNode || continuation.appendNodeIds?.at(-1) === completedNodeId;
      if (isLastAppendedNode) {
        const preservesFailureRoute = isAppendedNode &&
          (naturalNext === continuation.failureTo || naturalNext === continuation.errorTo || naturalNext === continuation.recoveryTo);
        if (!preservesFailureRoute) scheduledNext = continuation.returnTo;
        // Appended graphs keep their declared failure/error targets; ordinary wake actions resume at returnTo.
        wakeContinuation = undefined;
        delete state.wakeContinuation;
      } else {
        scheduledNext = naturalNext;
      }
    }
    const action = pendingSubscriptionActions.shift();
    state.pendingSubscriptionActions = [...pendingSubscriptionActions];
    if (action) {
      const target = graph.nodes.find((candidate) => candidate.nodeId === action.nodeId);
      if (!target || ((visits.get(action.nodeId) ?? 0) >= target.maxVisits && scheduledNext !== action.nodeId)) {
        logSubscriptionAction('rejected', action, !target ? 'subscriber node no longer exists' : 'subscriber node visit limit reached');
      } else if (action.action === 'reroute') {
        const rerouteIsCurrentAndDeclared = action.event.source.nodeId === completedNodeId &&
          (graph.edges.some((edge) => edge.from === completedNodeId && edge.to === action.nodeId) ||
            (state.adaptiveGraphEdges ?? []).some((edge) => edge.from === completedNodeId && edge.to === action.nodeId && edge.triggerEvent === action.event.type));
        if (!rerouteIsCurrentAndDeclared) {
          logSubscriptionAction('rejected', action, 'reroute is no longer a declared edge from the current node');
        } else {
          scheduledNext = action.nodeId;
          logSubscriptionAction('handled', action);
        }
      } else if (scheduledNext !== action.nodeId || action.returnTo !== undefined) {
        wakeContinuation = { nodeId: action.nodeId, returnTo: action.returnTo ?? scheduledNext,
          ...(action.failureTo === undefined ? {} : { failureTo: action.failureTo }),
          ...(action.errorTo === undefined ? {} : { errorTo: action.errorTo }),
          ...(action.recoveryTo === undefined ? {} : { recoveryTo: action.recoveryTo }),
          ...(action.appendNodeIds === undefined ? {} : { appendNodeIds: [...action.appendNodeIds] }) };
        state.wakeContinuation = wakeContinuation;
        scheduledNext = action.nodeId;
        logSubscriptionAction('handled', action);
      } else {
        logSubscriptionAction('handled', action);
      }
    }
    current = scheduledNext;
    persist();
    resumedGrowth = false;
    await emitVisitLifecycle('leave', fromNodeId, visit, { outcome: ok ? 'ok' : 'fail', ...(current === undefined ? {} : { nextNodeId: current }),
      ...(current === undefined ? { reason: 'no-outgoing-edge' } : {}) });
    if (current !== undefined) publishInsideEvent({ kind: 'edge', graphId, runId, from: fromNodeId, to: current });
    if (current === undefined) {
      while (pendingSubscriptionActions.length > 0) {
        const unhandled = pendingSubscriptionActions.shift()!;
        logSubscriptionAction('rejected', unhandled, 'run has no remaining scheduler path');
      }
      state.pendingSubscriptionActions = [];
      state.status = 'failed';
      persist();
      if (!state.dryRun && graphId === 'release-loop') {
        recordReleaseRunFailure(state, root, `Graph ${graphId}/${runId} failed after ${fromNodeId} (no outgoing edge)`);
      }
      if (!state.dryRun && graphId === 'heal-loop') {
        alertHealLoopFailure(state, `Graph ${graphId}/${runId} failed after ${fromNodeId} (no outgoing edge)`, options.deps?.postOpAlert);
      }
    }
  }
  } catch (error) {
    if (activeLifecycleNode) {
      try { await emitNodeLifecycle('leave', activeLifecycleNode.nodeId, activeLifecycleNode.visit,
        { outcome: 'fail', reason: 'execution-failed' }); }
      catch { /* preserve the original graph failure if lifecycle reporting also fails */ }
      try { persist(); }
      catch { /* preserve the original error if the run ledger is still unavailable */ }
      activeLifecycleNode = undefined;
      await lifecycleObserverQueue;
    }
    throw error;
  }
  if (state.dryRun && Object.keys(state.fanOuts ?? {}).length > 0) {
    const fanoutsBySource = new Map<string, NonNullable<GraphRunState['fanOuts']>[string][]>();
    for (const fanout of Object.values(state.fanOuts!)) {
      const group = fanoutsBySource.get(fanout.from) ?? [];
      group.push(fanout);
      fanoutsBySource.set(fanout.from, group);
    }
    state.plannedPath = state.path.flatMap((nodeId) => [nodeId, ...(fanoutsBySource.get(nodeId) ?? []).flatMap((fanout) =>
      Object.values(fanout.branches).flatMap((branch) => (branch.path ?? []).filter((branchNode) => !graph.terminalNodes.includes(branchNode))))]);
    persist();
  }
  await lifecycleObserverQueue;
  return state;
  } finally {
    await lifecycleObserverQueue;
    disposeGraphSubscriptions();
    disposeReleaseGraphEventAdapters();
    disposeAdaptiveGateHealAdapter();
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
export function manageGraphRun(graphId: string, runId: string, action: 'stop' | 'pause' | 'cancel' | 'destroy',
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
  if ((action === 'stop' || action === 'pause' || action === 'cancel') && state.status !== 'running') {
    throw new Error(`run is not running: ${graphId}/${runId}`);
  }
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
      state.nodes.push({ nodeId: state.path.at(-1)!, ...(current?.executionId ? { executionId: current.executionId } : {}),
        ok: false, exit: null, executed: false, error: STOPPED_NODE_ERROR,
        // The stop instant is always the node end; a start (and so seconds) exists only when the ledger named the running
        // node — a run begun by a runner before GRAPH-NODE-TIMES did not, and a guessed start would be a false time.
        endedAt: new Date(stopMs).toISOString(),
        ...(running === undefined ? {} : { startedAt: running, seconds: Number(((stopMs - Date.parse(running)) / 1000).toFixed(2)) }) });
    }
    delete state.currentNode;
    state.status = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'failed';
    if (action === 'pause' || action === 'cancel') state.reason = action === 'pause' ? 'paused' : 'cancelled';
    if (action === 'pause') {
      state.pausedAt = new Date(stopMs).toISOString();
      delete state.finishedAt;
      delete state.stoppedAt;
    } else {
      state.finishedAt = new Date(stopMs).toISOString();
      if (action === 'cancel') state.cancelledAt = state.finishedAt;
      if (action === 'stop' || action === 'destroy') state.stoppedAt = state.finishedAt;
    }
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

/** Fork a paused or failed run onto a descendant commit while keeping the source ledger immutable. */
export function forkGraphRun(graphId: string, runId: string, forkRunId: string, targetCommit: string,
  options: { root?: string; isAncestor: (ancestor: string, descendant: string) => boolean }): GraphRunState {
  const root = options.root ?? effectiveInstanceRoot();
  safeSegment(graphId); safeSegment(runId); safeSegment(forkRunId);
  if (runId === forkRunId) throw new Error('fork run id must differ from source run id');
  if (!/^[0-9a-f]{40}$/i.test(targetCommit)) throw new Error('fork commit must be a full commit hash');
  const source = readGraphRun(graphId, runId, root);
  if (source.status !== 'paused' && source.status !== 'failed') throw new Error(`fork requires a paused or failed run (found ${source.status})`);
  if (source.pending) throw new Error('fork cannot copy a pending approval');
  const input = source.input && typeof source.input === 'object' && !Array.isArray(source.input)
    ? source.input as Record<string, unknown> : undefined;
  const releaseCommit = graphId === 'release-loop'
    ? lastJsonObject(source.nodes.find((node) => node.nodeId === 'version-release')?.output)?.commit : undefined;
  const sourceCommit = input?.commit ?? input?.cutCommit ?? releaseCommit;
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(sourceCommit)) throw new Error('fork source run has no full source commit');
  if (!options.isAncestor(sourceCommit, targetCommit)) throw new Error(`fork commit is outside source lineage: ${sourceCommit} -> ${targetCommit}`);
  const forkPath = graphRunPath(graphId, forkRunId, root);
  if (existsSync(forkPath)) throw new Error(`fork run already exists: ${graphId}/${forkRunId}`);
  const forkInput = { ...input, ...(input?.cutCommit === undefined ? { commit: targetCommit } : { cutCommit: targetCommit }), forkedFrom: runId };
  const forkNodes = source.nodes.map((node) => {
    if (graphId !== 'release-loop' || node.nodeId !== 'version-release') return { ...node };
    const output = lastJsonObject(node.output);
    return output ? { ...node, output: { ...output, commit: targetCommit } } : { ...node };
  });
  const fork: GraphRunState = { ...source, nodes: forkNodes, runId: forkRunId, statePath: forkPath,
    input: forkInput, forkedFromRunId: runId,
    forkedFromCommit: sourceCommit, forkedToCommit: targetCommit, status: 'paused',
    pausedAt: new Date().toISOString(), reason: 'forked',
  };
  delete fork.pid;
  delete fork.pidStartedAt;
  delete fork.activeNode;
  delete fork.finishedAt;
  delete fork.stoppedAt;
  delete fork.cancelledAt;
  mkdirSync(dirname(forkPath), { recursive: true });
  const sourceArtifacts = runArtifacts(source);
  for (const artifact of sourceArtifacts) {
    if (artifact === source.statePath) continue;
    if (!existsSync(artifact)) continue;
    const target = artifact.replace(source.statePath, forkPath);
    if (lstatSync(artifact).isSymbolicLink()) throw new Error('graph run artifact is a symlink');
    cpSync(artifact, target, { recursive: true, errorOnExist: true, force: false });
  }
  persistGraphRun(fork);
  debug.log('graph.runs', 'fork', { graphId, runId, forkRunId, sourceCommit, targetCommit, status: fork.status });
  return fork;
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

// Keep the lightweight public callable contract aligned with its implementation.
void (runGraph satisfies GraphRun);
