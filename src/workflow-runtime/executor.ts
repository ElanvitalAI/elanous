// Archon-port T2.1 (2026-05-08) — DAG executor.
//
// Sequential topological execution. Each ready node runs to completion
// before the next is dispatched. Parallelism is intentionally deferred
// (Archon's executor.ts is 800+ LOC partly because of parallel
// dispatch + fan-out — elanous's MVP runs strictly sequential).
//
// Yields events as it goes — caller (CLI / SSE / tests) decides
// rendering. Stops on the first node that fails AND has no
// `trigger_rule: all_done` consumer (Archon parity: `all_done`
// downstream nodes always run regardless of upstream ok).

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import {
  isApprovalNode,
  isBashNode,
  isCftNode,
  isClassifyNode,
  isExtractNode,
  isFilterNode,
  isHttpRequestNode,
  isIfNode,
  isIterationNode,
  isScheduleTriggerNode,
  isWebhookTriggerNode,
  isDiscordTriggerNode,
  isTelegramTriggerNode,
  isManualTriggerNode,
  isChatTriggerNode,
  isPromptNode,
  isSetNode,
  isShowroomNode,
  isTaskNode,
  isSkillNode,
  isSwitchNode,
  isTemplateNode,
  topoSort,
} from './schema.js';
import { evaluateWhen } from './variables.js';
import { readWorkflowPin } from './pin-data.js';
import { WORKFLOW_CORE_KINDS } from '../graph-kinds/registry.js';
import { checkModelRequires } from '../registry/resolver.js';
import { validateJudgmentContract, validateJudgmentVerdict } from './judgment-contract.js';
import { signalBus } from '../signal-bus/index.js';
import { userIntentLogger } from '../user-intent/index.js';
import { executeBashNode } from './nodes/bash.js';
import { executePromptNode } from './nodes/prompt.js';
import { executeSkillNode } from './nodes/skill.js';
import { executeCftNode } from './nodes/cft.js';
import { executeApprovalNode } from './nodes/approval.js';
import { executeIfNode } from './nodes/if.js';
import { executeSwitchNode } from './nodes/switch.js';
import { executeIterationNode } from './nodes/iteration.js';
import { executeClassifyNode } from './nodes/classify.js';
import { executeExtractNode } from './nodes/extract.js';
import { executeSetNode } from './nodes/set.js';
import { executeTaskNode } from './nodes/task.js';
import { executeFilterNode } from './nodes/filter.js';
import { executeTemplateNode } from './nodes/template.js';
import { executeHttpRequestNode } from './nodes/http.js';
import { executeShowroomNode } from './nodes/showroom.js';
import { executeScheduleTriggerNode, executeWebhookTriggerNode, executeDiscordTriggerNode, executeTelegramTriggerNode, executeManualTriggerNode, executeChatTriggerNode } from './nodes/triggers.js';
import { executePluginKindNode, isPluginKindNode } from './plugin-kind-node.js';
import type {
  DagNode,
  NodeExecContext,
  NodeOutput,
  RunWorkflowOpts,
  WorkflowDeps,
  WorkflowEvent,
} from './types.js';
import type { ToolPolicy } from '../tool-runtime/tool-policy.js';

/** Public entrypoint. Yields lifecycle events; caller awaits the
 *  generator's completion to read final outputs. */
export async function* runWorkflow(
  opts: RunWorkflowOpts,
  deps: WorkflowDeps,
): AsyncGenerator<WorkflowEvent, Record<string, NodeOutput>, unknown> {
  const runId = opts.runId ?? generateRunId();
  // Persistence (Caveat #4 follow-up): when `runDir` is set OR neither
  // override is supplied, we own the run dir and persist node outputs +
  // a final run.json. When only `artifactsDir` is overridden (the
  // test pattern with `mkdtempSync`), persistence is skipped — the
  // caller has signalled "I'm managing my own filesystem fixture."
  const runDir = resolveRunDir(opts, runId);
  const artifactsDir = opts.artifactsDir ?? join(runDir ?? defaultRunDir(runId), 'artifacts');
  ensureDir(artifactsDir);
  const shouldPersist = opts.persistRun ?? runDir !== null;
  const startedAt = Date.now();
  if (shouldPersist && runDir) {
    ensureDir(join(runDir, 'nodes'));
    persistRunHeader(runDir, {
      runId,
      workflowName: opts.workflow.name,
      arguments: opts.arguments,
      startedAt,
    });
  }

  yield { type: 'workflow_start', workflow: opts.workflow.name, runId };

  let order: string[];
  try {
    order = topoSort(opts.workflow.nodes);
  } catch (err) {
    yield {
      type: 'workflow_failed',
      error: err instanceof Error ? err.message : String(err),
      partial: {},
    };
    return {};
  }

  const outputs: Record<string, NodeOutput> = {};
  const nodeById = new Map(opts.workflow.nodes.map(n => [n.id, n] as const));

  for (const id of order) {
    const node = nodeById.get(id);
    if (!node) continue;

    // Surface-unification §D3 (2026-05-11) — dry-run skips trigger
    // nodes so PWA "▶ Run now (skip triggers)" jumps directly to the
    // dependent chain without waiting on a cron tick / webhook hit /
    // discord message / telegram update. Non-trigger nodes run as
    // usual; manualTrigger / chatTrigger are also covered by the
    // variant family check.
    if (opts.dryRun && isTriggerVariant(node)) {
      yield { type: 'node_skipped', nodeId: id, reason: 'dry-run' };
      continue;
    }

    const skipReason = shouldSkip(node, outputs);
    if (skipReason) {
      yield { type: 'node_skipped', nodeId: id, reason: skipReason };
      continue;
    }

    // Compose tool policy: workflow-level + node-level, deny wins.
    const toolPolicy: ToolPolicy = {
      ...(node.allowed_tools ? { allow: node.allowed_tools } : {}),
      ...(node.denied_tools ? { deny: node.denied_tools } : {}),
    };

    const ctx: NodeExecContext = {
      arguments: opts.arguments,
      artifactsDir,
      outputs,
      resolvedProvider: node.provider ?? opts.workflow.provider,
      resolvedModel: node.model ?? opts.workflow.model,
      toolPolicy,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.screen !== undefined ? { screen: opts.screen } : {}),
      // V2.2-1 (2026-05-12) — bind the per-run `onTokenChunk` fan-out
      // to this node's id so prompt-shaped nodes can forward partial
      // LLM chunks without the consumer needing to thread the id
      // alongside each call. Omitted when the run has no streaming
      // consumer (the prompt node then runs in plain buffer mode).
      ...(opts.onTokenChunk !== undefined
        ? { onTokenChunk: (chunk: string) => opts.onTokenChunk!(id, chunk) }
        : {}),
    };

    // RFC #2161 Phase 3 — capability requirements gate. When a node
    // declares `requires`, verify the resolved (provider, model) pair
    // satisfies every clause before we burn an LLM/bash call. Phase 5
    // tightens this by layering Live Registry (apiKey/health) on top.
    if (node.requires) {
      const reason = checkModelRequires(
        ctx.resolvedProvider,
        ctx.resolvedModel,
        node.requires,
      );
      if (reason) {
        yield { type: 'node_start', nodeId: id, nodeType: variantOf(node) };
        const startedAt = Date.now();
        const blocked: NodeOutput = {
          ok: false,
          output: '',
          error: `requires unmet — ${reason}`,
          durationMs: Date.now() - startedAt,
        };
        outputs[id] = blocked;
        if (shouldPersist && runDir) persistNodeOutput(runDir, id, blocked);
        yield { type: 'node_done', nodeId: id, result: blocked };
        const remaining = order.slice(order.indexOf(id) + 1);
        const hasAllDone = remaining.some((rid) => {
          const rn = nodeById.get(rid);
          return rn?.trigger_rule === 'all_done';
        });
        if (!hasAllDone) {
          if (shouldPersist && runDir) {
            persistRunFinal(runDir, {
              runId,
              workflowName: opts.workflow.name,
              arguments: opts.arguments,
              startedAt,
              ok: false,
              error: `node '${id}' blocked: ${reason}`,
              outputs,
              completedAt: Date.now(),
            });
          }
          yield {
            type: 'workflow_failed',
            error: `node '${id}' blocked: ${reason}`,
            partial: outputs,
          };
          return outputs;
        }
        continue;
      }
    }

    if (node.judgment) {
      const reason = validateJudgmentContract(node)
        ?? (node.observes?.includes('screen') && ctx.screen === undefined
          ? 'screen observation is not wired in this run'
          : null)
        ?? (!deps.runJudgment ? 'deps.runJudgment is not wired in this runtime' : null);
      if (reason) {
        yield { type: 'node_start', nodeId: id, nodeType: variantOf(node) };
        const nodeStartedAt = Date.now();
        const blocked: NodeOutput = {
          ok: false,
          output: '',
          error: `judgment contract unmet — ${reason}`,
          durationMs: Date.now() - nodeStartedAt,
        };
        outputs[id] = blocked;
        if (shouldPersist && runDir) persistNodeOutput(runDir, id, blocked);
        yield { type: 'node_done', nodeId: id, result: blocked };
        const remaining = order.slice(order.indexOf(id) + 1);
        const hasAllDone = remaining.some((rid) => nodeById.get(rid)?.trigger_rule === 'all_done');
        if (!hasAllDone) {
          if (shouldPersist && runDir) {
            persistRunFinal(runDir, {
              runId,
              workflowName: opts.workflow.name,
              arguments: opts.arguments,
              startedAt,
              ok: false,
              error: `node '${id}' blocked: ${reason}`,
              outputs,
              completedAt: Date.now(),
            });
          }
          yield {
            type: 'workflow_failed',
            error: `node '${id}' blocked: ${reason}`,
            partial: outputs,
          };
          return outputs;
        }
        continue;
      }
    }

    yield { type: 'node_start', nodeId: id, nodeType: variantOf(node) };
    const result = node.judgment
      ? await executeJudgmentNode(node, ctx, deps, opts.workflow.name, opts.judgmentContext)
      : await dispatchNode(node, ctx, deps, opts.workflow.name);
    outputs[id] = result;
    if (shouldPersist && runDir) persistNodeOutput(runDir, id, result);
    yield { type: 'node_done', nodeId: id, result };

    // Stop on the first failed node UNLESS some downstream node has
    // `trigger_rule: all_done` (which means it explicitly wants to
    // run after failures). Cheaper than a full DAG re-walk:
    // any-downstream-all_done in the remaining order.
    if (!result.ok) {
      const remaining = order.slice(order.indexOf(id) + 1);
      const hasAllDone = remaining.some(rid => {
        const rn = nodeById.get(rid);
        return rn?.trigger_rule === 'all_done';
      });
      if (!hasAllDone) {
        if (shouldPersist && runDir) {
          persistRunFinal(runDir, {
            runId,
            workflowName: opts.workflow.name,
            arguments: opts.arguments,
            startedAt,
            ok: false,
            error: `node '${id}' failed: ${result.error ?? '(no error message)'}`,
            outputs,
            completedAt: Date.now(),
          });
        }
        yield {
          type: 'workflow_failed',
          error: `node '${id}' failed: ${result.error ?? '(no error message)'}`,
          partial: outputs,
        };
        return outputs;
      }
    }
  }

  if (shouldPersist && runDir) {
    persistRunFinal(runDir, {
      runId,
      workflowName: opts.workflow.name,
      arguments: opts.arguments,
      startedAt,
      ok: true,
      outputs,
      completedAt: Date.now(),
    });
  }
  yield { type: 'workflow_done', outputs };
  return outputs;
}

/** Simpler convenience: run-to-completion + collect events. */
export async function runWorkflowToCompletion(
  opts: RunWorkflowOpts,
  deps: WorkflowDeps,
): Promise<{ outputs: Record<string, NodeOutput>; events: WorkflowEvent[]; ok: boolean }> {
  const events: WorkflowEvent[] = [];
  const gen = runWorkflow(opts, deps);
  let outputs: Record<string, NodeOutput> = {};
  let ok = true;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      outputs = next.value;
      break;
    }
    events.push(next.value);
    if (next.value.type === 'workflow_failed') ok = false;
  }
  return { outputs, events, ok };
}

function shouldSkip(node: DagNode, outputs: Record<string, NodeOutput>): string | null {
  // trigger_rule check on depends_on
  const deps = node.depends_on ?? [];
  if (deps.length > 0) {
    const rule = node.trigger_rule ?? 'all_success';
    const depResults = deps.map(d => outputs[d]).filter((o): o is NodeOutput => !!o);
    if (rule === 'all_success') {
      if (depResults.length !== deps.length) return `dep missing (rule=all_success)`;
      if (depResults.some(r => !r.ok)) return `dep failed (rule=all_success)`;
    } else if (rule === 'one_success') {
      if (!depResults.some(r => r.ok)) return `no successful dep (rule=one_success)`;
    } else if (rule === 'all_done') {
      if (depResults.length !== deps.length) return `dep not finished (rule=all_done)`;
    }
  }

  // when expression
  if (node.when) {
    const ok = evaluateWhen(node.when, {
      arguments: '',
      artifactsDir: '',
      outputs,
    });
    if (!ok) return `when='${node.when}' evaluated false`;
  }

  return null;
}

async function executeJudgmentNode(
  node: DagNode,
  ctx: NodeExecContext,
  deps: WorkflowDeps,
  workflowName: string,
  suppliedObservations?: RunWorkflowOpts['judgmentContext'],
): Promise<NodeOutput> {
  const startedAt = Date.now();
  if (!deps.runJudgment) {
    return {
      ok: false,
      output: '',
      error: 'judgment node requires `deps.runJudgment` (not wired in this runtime)',
      durationMs: Date.now() - startedAt,
    };
  }

  const observed = new Set(node.observes ?? []);
  const judgmentContext = {
    ...(observed.has('goal') ? { goal: ctx.arguments } : {}),
    ...(observed.has('outcome') ? { outcome: ctx.outputs } : {}),
    ...(observed.has('history') ? { history: suppliedObservations?.history ?? ctx.outputs } : {}),
    ...(observed.has('kind') && suppliedObservations?.kind !== undefined ? { kind: suppliedObservations.kind } : {}),
    ...(observed.has('lifecycle') ? { lifecycle: { workflow: workflowName, nodeId: node.id } } : {}),
    ...(observed.has('screen') ? { screen: ctx.screen } : {}),
  };

  try {
    const result = await deps.runJudgment(node.judgment!, judgmentContext);
    if (result.error) {
      return {
        ok: false,
        output: result.output,
        error: result.error,
        durationMs: Date.now() - startedAt,
      };
    }
    const verdictReason = validateJudgmentVerdict(node, result.verdict);
    if (verdictReason) {
      return {
        ok: false,
        output: result.output,
        error: `judgment contract unmet — ${verdictReason}`,
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      ok: result.ok ?? true,
      output: result.output,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function dispatchNode(
  node: DagNode,
  ctx: NodeExecContext,
  deps: WorkflowDeps,
  workflowName: string,
): Promise<NodeOutput> {
  // M4-4.2 (FU8 PR #1 · 2026-05-12) — pin executor seam. When a pin
  // exists for `<workflowName>/<node.id>` in the `.pins.json` side-
  // file, return the pinned value as the node output and skip the
  // real LLM / HTTP / bash call. Lets workflow authors freeze a
  // specific node's response for fast iteration on downstream nodes.
  const pinned = readWorkflowPin(workflowName, node.id);
  if (pinned !== null) {
    const output = pinned.value;
    // Fire the same 3-sink emit fan-out as the dispatch reference
    // pattern (D8.2) so Patcher / Thinker / dashboards see the pin
    // hit alongside real runs. Best-effort.
    try {
      signalBus().emit({
        source: 'workflow.pin_used',
        tier: 'info',
        message: `pin used · ${workflowName}.${node.id}`,
        payload: { workflowName, nodeId: node.id, note: pinned.note },
      });
    } catch { /* best-effort */ }
    try {
      userIntentLogger().emit({
        surface: 'tui',
        intent: {
          layer: 'system',
          kind: 'system.workflow.pin_used',
          target: { kind: 'workflow', id: workflowName },
          value: { nodeId: node.id, note: pinned.note },
        },
        context: { active_workflow_run_id: workflowName },
      });
    } catch { /* best-effort */ }
    return { ok: true, output, durationMs: 0 };
  }
  // Plugin kinds are dispatched before the core 22. A node without `kind`
  // never enters this branch, so the core chain below is unchanged.
  if (isPluginKindNode(node)) return executePluginKindNode(node, ctx, deps);
  if (isPromptNode(node)) return executePromptNode(node, ctx, deps);
  if (isBashNode(node)) return executeBashNode(node, ctx, deps);
  if (isSkillNode(node)) return executeSkillNode(node, ctx, deps);
  if (isCftNode(node)) return executeCftNode(node, ctx, deps);
  if (isApprovalNode(node)) return executeApprovalNode(node, ctx, deps);
  if (isIfNode(node)) return executeIfNode(node, ctx, deps);
  if (isSwitchNode(node)) return executeSwitchNode(node, ctx, deps);
  if (isIterationNode(node)) return executeIterationNode(node, ctx, deps);
  if (isClassifyNode(node)) return executeClassifyNode(node, ctx, deps);
  if (isExtractNode(node)) return executeExtractNode(node, ctx, deps);
  if (isSetNode(node)) return executeSetNode(node, ctx, deps);
  if (isFilterNode(node)) return executeFilterNode(node, ctx, deps);
  if (isTemplateNode(node)) return executeTemplateNode(node, ctx, deps);
  if (isHttpRequestNode(node)) return executeHttpRequestNode(node, ctx, deps);
  if (isShowroomNode(node)) return executeShowroomNode(node, ctx, deps);
  if (isTaskNode(node)) return executeTaskNode(node, ctx, deps);
  if (isScheduleTriggerNode(node)) return executeScheduleTriggerNode(node, ctx, deps);
  if (isWebhookTriggerNode(node)) return executeWebhookTriggerNode(node, ctx, deps);
  if (isDiscordTriggerNode(node)) return executeDiscordTriggerNode(node, ctx, deps);
  if (isTelegramTriggerNode(node)) return executeTelegramTriggerNode(node, ctx, deps);
  if (isManualTriggerNode(node)) return executeManualTriggerNode(node, ctx, deps);
  if (isChatTriggerNode(node)) return executeChatTriggerNode(node, ctx, deps);
  // Narrowing has exhausted all known variants; cast for the id access
  // in the error path. Validation in `validateWorkflow` makes this
  // unreachable at runtime — the cast is to satisfy TypeScript.
  const fallbackId = (node as { id: string }).id;
  return {
    ok: false,
    output: '',
    error: `unknown node variant for id '${fallbackId}'`,
    durationMs: 0,
  };
}

/** Surface-unification §D3 (2026-05-11) — `dryRun` covers every trigger
 *  variant (Schedule · Webhook · HTTP · Discord · Telegram · Manual ·
 *  Chat). HTTP is not strictly a trigger, but in dry-run we typically
 *  want to skip external IO too — callers that need real HTTP results
 *  during dry-run can leave dryRun=false and run normally. */
function isTriggerVariant(node: DagNode): boolean {
  return (
    isScheduleTriggerNode(node)
    || isWebhookTriggerNode(node)
    || isDiscordTriggerNode(node)
    || isTelegramTriggerNode(node)
    || isManualTriggerNode(node)
    || isChatTriggerNode(node)
  );
}

function variantOf(node: DagNode): string {
  if (isPluginKindNode(node)) return node.kind;
  const guards: ReadonlyArray<(node: DagNode) => boolean> = [
    isPromptNode, isBashNode, isSkillNode, isCftNode, isApprovalNode, isIfNode,
    isSwitchNode, isIterationNode, isClassifyNode, isExtractNode, isSetNode,
    isFilterNode, isTemplateNode, isHttpRequestNode, isShowroomNode, isTaskNode,
    isScheduleTriggerNode, isWebhookTriggerNode, isDiscordTriggerNode,
    isTelegramTriggerNode, isManualTriggerNode, isChatTriggerNode,
  ];
  const index = guards.findIndex((guard) => guard(node));
  return index < 0 ? 'unknown' : WORKFLOW_CORE_KINDS[index]!;
}

function generateRunId(): string {
  const ts = Date.now();
  const rnd = Math.random().toString(36).slice(2, 8);
  return `wf-${ts}-${rnd}`;
}

function defaultRunDir(runId: string): string {
  // `ELANOUS_WORKFLOWS_RUNS_DIR` overrides the root for tests + isolated
  // dogfood NEXUS sessions that don't want to commingle with the user's
  // primary `~/.elanous/workflows-runs/` (HANDOFF §4.4 follow-up). Mirrors
  // `workflowsRunsRoot()` in `src/nexus/api/workflows.ts`.
  const envRoot = process.env.ELANOUS_WORKFLOWS_RUNS_DIR?.trim();
  if (envRoot) return join(envRoot, runId);
  return join(elanousStateRoot(), 'workflows-runs', runId);
}

/** Resolve the run directory for persistence purposes.
 *  - explicit `opts.runDir` → that
 *  - explicit `opts.artifactsDir` only → null (legacy/test path; skip
 *    persistence to avoid touching the user's home dir from a test
 *    fixture)
 *  - neither → default `~/.elanous/workflows-runs/<runId>/`
 *  Tests opt back IN by passing `runDir: someTmp`. */
function resolveRunDir(opts: RunWorkflowOpts, runId: string): string | null {
  if (opts.runDir) return opts.runDir;
  if (opts.artifactsDir) return null;
  return defaultRunDir(runId);
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Directory may already exist or we may lack permissions; either
    // way the executor proceeds — bash nodes that depend on the dir
    // will surface the error themselves.
  }
}

interface RunHeader {
  runId: string;
  workflowName: string;
  arguments: string;
  startedAt: number;
}

interface RunFinal extends RunHeader {
  ok: boolean;
  error?: string;
  outputs: Record<string, NodeOutput>;
  completedAt: number;
}

/** Write `<runDir>/run.json` with the start-of-run header. The file
 *  is rewritten on completion with `ok` + `completedAt` + outputs. */
function persistRunHeader(runDir: string, header: RunHeader): void {
  try {
    const path = join(runDir, 'run.json');
    writeFileSync(
      path,
      JSON.stringify({ ...header, status: 'running' }, null, 2),
      'utf-8',
    );
  } catch {
    // Persistence is best-effort. If the disk is full or the path is
    // unwritable, the workflow itself should still proceed — surfacing
    // a hard failure here would punish the user for a side-channel.
  }
}

/** Write `<runDir>/nodes/<nodeId>.json` with the node's output. */
function persistNodeOutput(runDir: string, nodeId: string, result: NodeOutput): void {
  try {
    const safeId = nodeId.replace(/[^A-Za-z0-9._-]/g, '_');
    const path = join(runDir, 'nodes', `${safeId}.json`);
    writeFileSync(path, JSON.stringify(result, null, 2), 'utf-8');
  } catch {
    // best-effort
  }
}

/** Write `<runDir>/run.json` with the final run summary. Overwrites
 *  the header that was written at start time. */
function persistRunFinal(runDir: string, final: RunFinal): void {
  try {
    const path = join(runDir, 'run.json');
    writeFileSync(
      path,
      JSON.stringify({ ...final, status: final.ok ? 'done' : 'failed' }, null, 2),
      'utf-8',
    );
  } catch {
    // best-effort
  }
}
