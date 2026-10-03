// Archon-port T2.3 (2026-05-08) — Nexus workflow REST API.
//
// Endpoints (mounted under `/v1/workflows`):
//   GET    /v1/workflows                  list (project + global + builtin)
//   GET    /v1/workflows/{name}           detail (raw YAML + parsed def)
//   PUT    /v1/workflows/{name}           write (validates first)
//   DELETE /v1/workflows/{name}           remove
//   POST   /v1/workflows/validate         validate a YAML string only
//   POST   /v1/workflows/{name}/run       start a run, return runId
//                                          (SSE follow-up via /events?topics=workflow:<runId>)
//
// Wire policy: same as tasks-scheduler.ts — `checkAuth` from meta-api,
// `metaApi` opts (so NEXUS boots without it return 503), no behavior
// when metaApi is missing.
//
// Run dispatch:
//   1. discoverWorkflows / parseWorkflowYaml resolves the definition
//   2. WorkflowDeps assembled inline (callLLM ↔ src/llm.ts streamLLM,
//      runBash ↔ child_process spawn, runSkill / runCft / approval
//      stubbed for MVP — returning informative errors so the YAML
//      author sees what's not yet wired)
//   3. runWorkflow async generator emits events → in-memory ring
//      buffer keyed by runId. SSE consumers subscribe via the
//      existing event-bus.
//
// MVP simplifications (deferred to a follow-up PR):
//   - run history not persisted to disk (in-memory only)
//   - skill / cft / approval handlers return 'not wired in this
//     runtime' until a follow-up PR lands the bridge

import { requirePosixShellCommand } from '../../platform/default-shell.js';
import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import {
  deleteWorkflow,
  discoverWorkflows,
  findWorkflow,
  parseWorkflowYaml,
  runWorkflow,
  saveWorkflow,
  topoSort,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowRunMode,
  type NodeOutput,
  type RunWorkflowOpts,
} from '../../workflow-runtime/index.js';
import { buildRunCft, buildRunSkill } from '../../workflow-runtime/deps-bridge.js';
import {
  listPendingApprovals,
  rejectApproval,
  resolveApproval,
} from './workflow-approvals.js';
import { jsonResponse } from './http-server.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { publishWorkflowRunEvent } from './workflow-run-event-bridge.js';
import { runApprovalAcrossChannels } from './workflow-approval-multi-channel.js';

// ── Run registry (in-memory) ──────────────────────────────────────

interface RunRecord {
  runId: string;
  workflowName: string;
  mode: WorkflowRunMode;
  startedAt: number;
  events: WorkflowEvent[];
  /** Settled state: undefined while running, true on workflow_done,
   *  false on workflow_failed. */
  ok: boolean | undefined;
  /** Final outputs (set on workflow_done / workflow_failed). */
  outputs: Record<string, unknown>;
}

const RUN_REGISTRY = new Map<string, RunRecord>();
const RUN_REGISTRY_MAX = 100;

function rememberRun(rec: RunRecord): void {
  RUN_REGISTRY.set(rec.runId, rec);
  if (RUN_REGISTRY.size > RUN_REGISTRY_MAX) {
    // Evict oldest by startedAt
    const oldest = [...RUN_REGISTRY.values()]
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) RUN_REGISTRY.delete(oldest.runId);
  }
}

// ── Default WorkflowDeps wiring ────────────────────────────────────

/** Build the default deps used by /run. callLLM wires through the
 *  elanous LLM stack (src/llm.ts streamLLM). bash uses child_process.
 *  Skill/cft are bridged via deps-bridge.ts; approval registers a
 *  deferred Promise keyed by the runId so a later POST /approve can
 *  resolve it (§5.1 follow-up). */
export function buildDefaultWorkflowDeps(runOpts: { runId: string }): WorkflowDeps {
  return {
    callLLM: async ({ prompt, model, provider: providerName, signal, onPartialChunk }) => {
      // Lazy require to avoid pulling llm.ts into the module graph
      // when the API is not exercised. streamLLM is the buffer-the-
      // stream convenience wrapper at src/llm.ts:3017 — signature
      // is (messages, onChunk, opts).
      const llm = require('../../llm.js') as typeof import('../../llm.js');
      // Provider resolution (HANDOFF §4.4 wire-through · 2026-05-08):
      // YAML's `provider: claude|openai|grok|gemini|local` field is
      // surfaced via ctx.resolvedProvider in workflow-runtime/executor
      // and propagated to callLLM by prompt.ts. Look up by id; fall
      // back to model-derived default when the name is unknown so a
      // typo can't crash the run.
      let provider = providerName ? llm.PROVIDERS[providerName] : undefined;
      if (!provider) provider = llm.resolveDefaultProvider(model);
      // Model compatibility (#1973 dogfood follow-up): if the hint's
      // family doesn't match the resolved provider, drop it.
      const safeModel = llm.isModelCompatible(provider.name, model) ? model : undefined;
      const opts: Parameters<typeof llm.streamLLM>[2] = {
        ...(safeModel !== undefined ? { model: safeModel } : {}),
        ...(signal !== undefined ? { signal } : {}),
        provider,
      };
      // V2.2-1 (2026-05-12) — forward each delta to the workflow-runtime
      // streaming consumer (chat trigger SSE) when one is attached. The
      // final return value still carries the full buffered text so
      // downstream nodes / output_format keep working unchanged.
      const full = await llm.streamLLM(
        [{ role: 'user', content: prompt }],
        onPartialChunk ? (delta: string) => onPartialChunk(delta) : () => {},
        opts,
      );
      return full;
    },
    runBash: async (body, opts) => {
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>(
        (resolve, reject) => {
          let stdout = '';
          let stderr = '';
          let timer: ReturnType<typeof setTimeout> | undefined;
          const child = spawn(requirePosixShellCommand('bash'), ['-c', body], {
            cwd: opts.cwd ?? process.cwd(),
          });
          if (opts.timeoutMs) {
            timer = setTimeout(() => {
              child.kill('SIGTERM');
            }, opts.timeoutMs);
          }
          if (opts.signal) {
            opts.signal.addEventListener('abort', () => {
              child.kill('SIGTERM');
            });
          }
          child.stdout.on('data', d => { stdout += String(d); });
          child.stderr.on('data', d => { stderr += String(d); });
          child.on('close', code => {
            if (timer) clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code ?? 0 });
          });
          child.on('error', err => {
            if (timer) clearTimeout(timer);
            reject(err);
          });
        },
      );
    },
    runSkill: buildRunSkill(),
    runCft: buildRunCft(),
    // HITL approval — BACKLOG #4 (2026-05-08): race the PWA modal
    // (registerApproval → POST /approve|/reject) against any HITL
    // channels wired into NEXUS (Pushcut from #2009; future
    // Telegram/Discord additions auto-join). Whichever path resolves
    // first wins; the loser is cancelled. Runtime callers get the
    // same Promise<string|undefined> shape as before — purely
    // additive when no HITL channels are configured.
    requestApproval: async (message: string, opts) => {
      // BACKLOG #4 (2026-05-11) — forward the per-node `delivery`
      // preference (yaml `approval.delivery`) so the race filters
      // HITL channels accordingly. Omitted preference = race all
      // surfaces (existing default).
      return runApprovalAcrossChannels({
        runId: runOpts.runId,
        message,
        ...(opts?.delivery !== undefined ? { delivery: opts.delivery } : {}),
      });
    },
  };
}

// ── REST handlers ──────────────────────────────────────────────────

export function handleWorkflowsList(
  req: Request,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const list = discoverWorkflows();
  return jsonResponse(
    {
      workflows: list.map(e => ({
        name: e.definition.name,
        description: e.definition.description,
        source: e.source.source,
        path: e.source.path,
        nodeCount: e.definition.nodes.length,
      })),
    },
    200,
  );
}

export function handleWorkflowGet(
  req: Request,
  name: string,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const entry = findWorkflow(name);
  if (!entry) return jsonResponse({ error: 'not_found', name }, 404);
  // Re-read raw YAML so the editor can show the original text
  let yamlText = '';
  try {
    yamlText = require('fs').readFileSync(entry.source.path, 'utf-8') as string;
  } catch {
    /* fall through with empty yaml */
  }
  return jsonResponse(
    {
      name: entry.definition.name,
      source: entry.source.source,
      path: entry.source.path,
      yaml: yamlText,
      definition: entry.definition,
    },
    200,
  );
}

export async function handleWorkflowPut(
  req: Request,
  name: string,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'bad_request', reason: 'expected JSON body' }, 400);
  }
  const yamlText = (body as { yaml?: unknown }).yaml;
  const scopeRaw = (body as { scope?: unknown }).scope;
  if (typeof yamlText !== 'string') {
    return jsonResponse({ error: 'bad_request', reason: '`yaml` must be a string' }, 400);
  }
  const scope = scopeRaw === 'global' ? 'global' : 'project';
  const r = saveWorkflow(name, yamlText, { scope });
  if (!r.ok) {
    return jsonResponse(
      {
        error: 'invalid_workflow',
        validation: r.validation,
        reason: r.error,
      },
      422,
    );
  }
  return jsonResponse({ ok: true, path: r.path, scope }, 200);
}

export function handleWorkflowDelete(
  req: Request,
  name: string,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const scope = url.searchParams.get('scope') === 'global' ? 'global' : 'project';
  const r = deleteWorkflow(name, { scope });
  if (!r.ok) return jsonResponse({ error: 'delete_failed', reason: r.error }, 404);
  return jsonResponse({ ok: true, path: r.path, scope }, 200);
}

export async function handleWorkflowValidate(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'bad_request', reason: 'expected JSON body' }, 400);
  }
  const yamlText = (body as { yaml?: unknown }).yaml;
  if (typeof yamlText !== 'string') {
    return jsonResponse({ error: 'bad_request', reason: '`yaml` must be a string' }, 400);
  }
  const validation = parseWorkflowYaml(yamlText);
  return jsonResponse({ validation }, validation.ok ? 200 : 422);
}

/** Surface-unification §C1 (2026-05-11) — POST /v1/workflows/synth.
 *  Body: { intent: string, context?: string, preview?: boolean,
 *          scope?: 'project' | 'global' }.
 *  Wraps the R3 native skill (`synthWorkflowFromIntent`) so PWA can
 *  call the trigger-aware LLM synthesizer + render the C2 preview
 *  modal. Distinct from `/generate` because synth returns workflow
 *  name + trigger summary + repair flag in addition to YAML. */
export async function handleWorkflowSynth(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'bad_request', reason: 'expected JSON body' }, 400);
  }
  const intent = (body as { intent?: unknown }).intent;
  if (typeof intent !== 'string' || intent.trim().length === 0) {
    return jsonResponse({ error: 'bad_request', reason: '`intent` required' }, 400);
  }
  const { synthWorkflowFromIntent } = await import('../../workflow-synth/index.js');
  const synthOpts: Parameters<typeof synthWorkflowFromIntent>[0] = { intent };
  const context = (body as { context?: unknown }).context;
  if (typeof context === 'string') synthOpts.context = context;
  const preview = (body as { preview?: unknown }).preview;
  synthOpts.preview = preview === undefined ? true : preview === true;
  const scope = (body as { scope?: unknown }).scope;
  if (scope === 'project' || scope === 'global') synthOpts.scope = scope;
  try {
    const deps = buildDefaultWorkflowDeps({ runId: 'synth' });
    const result = await synthWorkflowFromIntent(synthOpts, { callLLM: deps.callLLM });
    return jsonResponse(result, result.ok ? 200 : 422);
  } catch (err) {
    return jsonResponse(
      { error: 'synth_failed', reason: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
}

/** ROADMAP Tier 1 W1 (2026-05-11) — POST /v1/workflows/generate.
 *  Body: { prompt: string, model?, provider?, skills?, currentYaml? }.
 *  Calls the LLM via the nl-generator dispatcher and returns the
 *  produced YAML + any validation warnings. The PWA renders warnings
 *  in a banner so users can still edit invalid output rather than
 *  losing the LLM round-trip. */
export async function handleWorkflowGenerate(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'bad_request', reason: 'expected JSON body' }, 400);
  }
  const prompt = (body as { prompt?: unknown }).prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return jsonResponse({ error: 'bad_request', reason: '`prompt` required' }, 400);
  }
  const { generateWorkflow } = await import('../../workflow/nl-generator.js');
  const genReq: Parameters<typeof generateWorkflow>[0] = { prompt };
  const model = (body as { model?: unknown }).model;
  if (typeof model === 'string') genReq.model = model;
  const provider = (body as { provider?: unknown }).provider;
  if (typeof provider === 'string') genReq.provider = provider;
  const skills = (body as { skills?: unknown }).skills;
  if (Array.isArray(skills)) genReq.skills = skills.filter((s) => typeof s === 'string');
  const currentYaml = (body as { currentYaml?: unknown }).currentYaml;
  if (typeof currentYaml === 'string') genReq.currentYaml = currentYaml;
  try {
    const result = await generateWorkflow(genReq);
    return jsonResponse(result, 200);
  } catch (err) {
    return jsonResponse(
      { error: 'llm_failed', reason: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
}

export async function handleWorkflowRunStart(
  req: Request,
  name: string,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const entry = findWorkflow(name);
  if (!entry) return jsonResponse({ error: 'not_found', name }, 404);
  const body = await readJsonBody(req);
  const args =
    body && typeof body === 'object' && typeof (body as { arguments?: unknown }).arguments === 'string'
      ? ((body as { arguments: string }).arguments)
      : '';
  // Surface-unification §D3 (2026-05-11) — `dryRun` skips trigger nodes
  // so the PWA "▶ Run now" button runs the dependent chain straight
  // through. Default false preserves the production wire.
  const dryRun: boolean = Boolean(body && typeof body === 'object' && (body as { dryRun?: unknown }).dryRun === true);
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const { onlyNode, fromNode, fromRunId } = input;
  if ('usePins' in input || (onlyNode !== undefined && (fromNode !== undefined || fromRunId !== undefined))
    || (onlyNode !== undefined && (typeof onlyNode !== 'string' || !onlyNode.trim()))
    || (fromNode !== undefined && (typeof fromNode !== 'string' || !fromNode.trim()))
    || (fromRunId !== undefined && (typeof fromRunId !== 'string' || !fromRunId.trim()))
    || (fromNode === undefined) !== (fromRunId === undefined)
    || (input.mode !== undefined && input.mode !== 'test')) {
    return jsonResponse({ error: 'bad_request', reason: 'invalid run selection' }, 400);
  }
  if ((onlyNode && !entry.definition.nodes.some(n => n.id === onlyNode))
    || (fromNode && !entry.definition.nodes.some(n => n.id === fromNode))) {
    return jsonResponse({ error: 'bad_request', reason: 'unknown selected node' }, 400);
  }
  let previousOutputs: Record<string, NodeOutput> | undefined;
  if (typeof fromRunId === 'string') {
    const previous = RUN_REGISTRY.get(fromRunId);
    if (previous) {
      if (previous.workflowName !== name || previous.ok === undefined) {
        return jsonResponse({ error: 'bad_request', reason: 'source run must be settled for this workflow' }, 400);
      }
      const terminal = previous.events.find(e => e.type === 'workflow_done' || e.type === 'workflow_failed');
      previousOutputs = terminal?.type === 'workflow_done' ? terminal.outputs
        : terminal?.type === 'workflow_failed' ? terminal.partial : {};
    } else {
      const disk = readRunOutputSnapshot(fromRunId);
      if (!disk || disk.workflowName !== name || (disk.status !== 'done' && disk.status !== 'failed')) {
        return jsonResponse({ error: 'bad_request', reason: 'source run must be settled for this workflow' }, 400);
      }
      previousOutputs = disk.outputs;
    }
    let order: string[];
    try { order = topoSort(entry.definition.nodes); }
    catch { return jsonResponse({ error: 'bad_request', reason: 'invalid workflow topology' }, 400); }
    const upstream = order.slice(0, order.indexOf(fromNode as string));
    if (upstream.some(id => previousOutputs?.[id] === undefined)) {
      return jsonResponse({ error: 'bad_request', reason: 'source run missing upstream outputs' }, 400);
    }
  }
  const mode: WorkflowRunMode = input.mode === 'test' ? 'test' : onlyNode ? 'only' : fromNode ? 'from' : 'full';
  const runId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record: RunRecord = {
    runId,
    workflowName: name,
    mode,
    startedAt: Date.now(),
    events: [],
    ok: undefined,
    outputs: {},
  };
  rememberRun(record);

  // Fire-and-forget — caller polls GET /v1/workflows/runs/{id} or
  // subscribes via SSE (`?topics=workflow.run.` since §15.8(b)).
  void (async () => {
    const deps = buildDefaultWorkflowDeps({ runId });
    try {
      const runOpts: RunWorkflowOpts = {
        workflow: entry.definition, arguments: args, runId, dryRun, mode,
        ...(typeof onlyNode === 'string' ? { onlyNode } : {}),
        ...(typeof fromNode === 'string' ? { fromNode } : {}),
        ...(previousOutputs ? { previousOutputs } : {}),
      };
      for await (const runtimeEvent of runWorkflow(runOpts, deps)) {
        const evt = { ...runtimeEvent, mode };
        record.events.push(evt);
        // §15.8(b) — fan into NexusEventBus → PWA invalidates queries
        // on push instead of polling. No-op when bus is unwired
        // (handleWorkflowRunStart is also exercised in unit tests).
        publishWorkflowRunEvent({ runId, workflowName: name }, evt);
        if (evt.type === 'workflow_done') {
          record.ok = true;
          record.outputs = mapOutputs(evt.outputs);
        } else if (evt.type === 'workflow_failed') {
          record.ok = false;
          record.outputs = mapOutputs(evt.partial);
        }
      }
    } catch (err) {
      record.ok = false;
      const failEvt = {
        type: 'workflow_failed' as const,
        error: err instanceof Error ? err.message : String(err),
        partial: {},
        mode,
      };
      record.events.push(failEvt);
      publishWorkflowRunEvent({ runId, workflowName: name }, failEvt);
    }
  })();

  return jsonResponse({ ok: true, runId, mode }, 202);
}

export function handleWorkflowRunGet(
  req: Request,
  runId: string,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const rec = RUN_REGISTRY.get(runId);
  if (rec) {
    return jsonResponse(
      {
        runId: rec.runId,
        workflowName: rec.workflowName,
        mode: rec.mode,
        startedAt: rec.startedAt,
        ok: rec.ok,
        events: rec.events,
        outputs: rec.outputs,
      },
      200,
    );
  }
  // Caveat #2 follow-up (2026-05-08): cache miss → disk fallback.
  // Run files are written by the executor to ~/.elanous/workflows-runs/
  // <runId>/{run.json, nodes/<id>.json}; if Nexus restarted between the
  // run's start and this GET, the in-memory registry is empty but the
  // disk record survives.
  const onDisk = loadRunFromDisk(runId);
  if (onDisk) return jsonResponse(onDisk, 200);
  return jsonResponse({ error: 'not_found', runId }, 404);
}

/** Caveat #2 follow-up — list every run that has a `run.json` on
 *  disk under `~/.elanous/workflows-runs/`. Sorted newest-first by
 *  startedAt. Each entry is a thin summary so a UI can paginate
 *  before fetching the full record via GET /runs/<id>. */
export function handleWorkflowRunsList(
  req: Request,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const runs = listRunsFromDisk();
  return jsonResponse({ runs }, 200);
}

// ── §5.1 approval surface ────────────────────────────────────────

/** GET /v1/workflows/runs/pending — read-only list of approvals
 *  blocking executor progress right now. Lets a polling UI discover
 *  which runs are waiting on a human + the message to render. */
export function handleWorkflowApprovalsPending(
  req: Request,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  return jsonResponse({ pending: listPendingApprovals() }, 200);
}

/** POST /v1/workflows/runs/:runId/approve — body `{response?: string}`.
 *  Resolves the deferred Promise the executor is parked on. When the
 *  workflow's approval node has `capture_response: true`, the body is
 *  surfaced as the node's `output`. Empty body → resolves with
 *  undefined (executor treats as bare approval). */
export async function handleWorkflowApprovalApprove(
  req: Request,
  runId: string,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const body = await readJsonBody(req);
  const response =
    body && typeof body === 'object' && typeof (body as { response?: unknown }).response === 'string'
      ? ((body as { response: string }).response)
      : undefined;
  const ok = resolveApproval(runId, response);
  if (!ok) return jsonResponse({ error: 'not_pending', runId }, 404);
  return jsonResponse({ ok: true, runId, decision: 'approved' }, 200);
}

/** POST /v1/workflows/runs/:runId/reject — body `{reason?: string}`.
 *  Rejects the deferred Promise → the executor sees a thrown error,
 *  which fails the approval node and the workflow as a whole. */
export async function handleWorkflowApprovalReject(
  req: Request,
  runId: string,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const body = await readJsonBody(req);
  const reason =
    body && typeof body === 'object' && typeof (body as { reason?: unknown }).reason === 'string'
      ? ((body as { reason: string }).reason)
      : undefined;
  const ok = rejectApproval(runId, reason);
  if (!ok) return jsonResponse({ error: 'not_pending', runId }, 404);
  return jsonResponse({ ok: true, runId, decision: 'rejected' }, 200);
}

// ── helpers ────────────────────────────────────────────────────────

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function mapOutputs(
  outputs: Record<string, { output: unknown }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(outputs)) {
    out[k] = v.output;
  }
  return out;
}

/** Test-only: clear the in-memory run registry between cases. */
export function _resetWorkflowRunRegistryForTest(): void {
  RUN_REGISTRY.clear();
}

// ── Disk-backed run hydration (Caveat #2 follow-up) ───────────────

/** Default location where the executor writes per-run state. Mirrors
 *  `defaultRunDir(runId)` inside `src/workflow-runtime/executor.ts`.
 *
 *  Precedence: test override > `ELANOUS_WORKFLOWS_RUNS_DIR` env > home.
 *  Tests prefer `_setWorkflowRunsRootForTest` because Node's
 *  `os.homedir()` caches its result on first call, so flipping
 *  `process.env.HOME` mid-process doesn't move the root. The env var
 *  is for runtime callers (e.g., dogfood NEXUS) — see HANDOFF §4.4. */
let workflowsRunsRootOverride: string | null = null;

function workflowsRunsRoot(): string {
  if (workflowsRunsRootOverride) return workflowsRunsRootOverride;
  const envRoot = process.env.ELANOUS_WORKFLOWS_RUNS_DIR?.trim();
  if (envRoot) return envRoot;
  return join(elanousStateRoot(), 'workflows-runs');
}

/** Test-only: override the root the disk loader walks. Pass `null` to
 *  reset to the default (homedir-based) value. */
export function _setWorkflowRunsRootForTest(root: string | null): void {
  workflowsRunsRootOverride = root;
}

interface DiskRunSummary {
  runId: string;
  workflowName: string;
  startedAt: number;
  completedAt?: number;
  ok?: boolean;
  /** `running` runs older than `STALE_RUNNING_AFTER_MS` get reported
   *  as `orphaned` — the process most likely crashed before writing
   *  the final `run.json` (e.g. SIGKILL or a bun panic). UI can use
   *  this to stop polling + offer a "delete" action. */
  status: 'running' | 'orphaned' | 'done' | 'failed' | 'unknown';
  arguments?: string;
}

/** A `running` record whose startedAt is older than this is treated
 *  as orphaned. 30 min is generous for long LLM workflows but short
 *  enough that abandoned runs don't pollute the list across sessions. */
const STALE_RUNNING_AFTER_MS = 30 * 60 * 1000;

function readRunOutputSnapshot(runId: string): {
  workflowName: string;
  status: string;
  outputs: Record<string, NodeOutput>;
} | null {
  if (!/^wf-[A-Za-z0-9-]+$/.test(runId) || runId.includes('..')) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(workflowsRunsRoot(), runId, 'run.json'), 'utf-8')) as {
      workflowName?: string; status?: string; outputs?: Record<string, NodeOutput>;
    };
    if (!parsed.workflowName || !parsed.status || !parsed.outputs || typeof parsed.outputs !== 'object') return null;
    return { workflowName: parsed.workflowName, status: parsed.status, outputs: parsed.outputs };
  } catch { return null; }
}

/** Read `<root>/<runId>/run.json` and translate into the same shape as
 *  GET /runs/<id> serves from memory. Returns null when the file is
 *  missing or unreadable. Events are reconstructed minimally from the
 *  per-node files so the consumer still sees a node_done sequence. */
function loadRunFromDisk(runId: string): {
  runId: string;
  workflowName: string;
  startedAt: number;
  ok: boolean | undefined;
  events: WorkflowEvent[];
  outputs: Record<string, unknown>;
  mode?: WorkflowRunMode;
} | null {
  if (!runId || runId.includes('/') || runId.includes('..')) return null;
  const root = workflowsRunsRoot();
  const runDir = join(root, runId);
  const runJsonPath = join(runDir, 'run.json');
  if (!existsSync(runJsonPath)) return null;
  try {
    const raw = readFileSync(runJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      runId?: string;
      workflowName?: string;
      startedAt?: number;
      completedAt?: number;
      ok?: boolean;
      status?: string;
      mode?: WorkflowRunMode;
      outputs?: Record<string, { output?: unknown }>;
    };
    if (!parsed.runId || !parsed.workflowName) return null;
    const outputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.outputs ?? {})) {
      outputs[k] = (v as { output?: unknown })?.output;
    }
    // Reconstruct a minimal events sequence from the per-node files
    // so a polling client still sees the node_done sequence even
    // though the live run.json doesn't store events.
    const events: WorkflowEvent[] = [];
    events.push({ type: 'workflow_start', workflow: parsed.workflowName, runId: parsed.runId,
      ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}) });
    const nodesDir = join(runDir, 'nodes');
    // Iterate `parsed.outputs` keys instead of `readdirSync(nodesDir)`
    // so the reconstructed node_done sequence is in execution order
    // (run.json's outputs object is written in insertion order by the
    // executor — `for (const id of order)`). Using readdirSync sorted
    // alphabetically would surface `confirm` before `route-to-digest`
    // even though `confirm depends_on [route-to-digest]`. Caught via
    // dogfood (2026-05-08 quick-summary run on dogfood NEXUS).
    const orderedIds = Object.keys(parsed.outputs ?? {});
    for (const nodeId of orderedIds) {
      const safeId = nodeId.replace(/[^A-Za-z0-9._-]/g, '_');
      const filePath = join(nodesDir, `${safeId}.json`);
      let nodeData: { ok: boolean; output?: unknown; error?: string; durationMs?: number } | null = null;
      if (existsSync(filePath)) {
        try {
          nodeData = JSON.parse(readFileSync(filePath, 'utf-8'));
        } catch {
          nodeData = null;
        }
      }
      // Fallback: derive from run.json's outputs entry when the per-
      // node file is missing / unreadable. Keeps the events sequence
      // complete even if /nodes/ was wiped.
      if (!nodeData) {
        const fromRun = (parsed.outputs ?? {})[nodeId] as
          | { ok?: boolean; output?: unknown; error?: string; durationMs?: number }
          | undefined;
        if (!fromRun) continue;
        nodeData = {
          ok: fromRun.ok ?? (parsed.status === 'done'),
          output: fromRun.output ?? '',
          ...(fromRun.error !== undefined ? { error: fromRun.error } : {}),
          durationMs: fromRun.durationMs ?? 0,
        };
      }
      events.push({
        type: 'node_done',
        nodeId,
        ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
        result: {
          ok: nodeData.ok,
          output: nodeData.output ?? '',
          durationMs: nodeData.durationMs ?? 0,
          ...(nodeData.error !== undefined ? { error: nodeData.error } : {}),
        },
      });
    }
    if (parsed.status === 'done') {
      events.push({
        type: 'workflow_done',
        ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
        outputs: Object.fromEntries(
          Object.entries(parsed.outputs ?? {}).map(([k, v]) => [
            k,
            { ok: true, output: (v as { output?: unknown })?.output ?? '', durationMs: 0 },
          ]),
        ),
      });
    } else if (parsed.status === 'failed') {
      events.push({
        type: 'workflow_failed',
        ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
        error: 'failed (see node events)',
        partial: Object.fromEntries(
          Object.entries(parsed.outputs ?? {}).map(([k, v]) => [
            k,
            { ok: false, output: (v as { output?: unknown })?.output ?? '', durationMs: 0 },
          ]),
        ),
      });
    }
    return {
      runId: parsed.runId,
      workflowName: parsed.workflowName,
      ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
      startedAt: parsed.startedAt ?? 0,
      ok: parsed.status === 'done' ? true : parsed.status === 'failed' ? false : undefined,
      events,
      outputs,
    };
  } catch {
    return null;
  }
}

/** Enumerate every <root>/<runId>/run.json on disk, return summaries
 *  sorted newest-first by startedAt. Best-effort — entries that fail
 *  to parse are skipped. */
function listRunsFromDisk(): DiskRunSummary[] {
  const root = workflowsRunsRoot();
  if (!existsSync(root)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const summaries: DiskRunSummary[] = [];
  for (const e of entries) {
    if (!/^wf-/.test(e)) continue; // skip stray dirs
    const runDir = join(root, e);
    try {
      const st = statSync(runDir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const runJson = join(runDir, 'run.json');
    if (!existsSync(runJson)) continue;
    try {
      const parsed = JSON.parse(readFileSync(runJson, 'utf-8')) as Partial<DiskRunSummary>;
      if (!parsed.runId || !parsed.workflowName) continue;
      let status: DiskRunSummary['status'] = (parsed.status as DiskRunSummary['status']) ?? 'unknown';
      // Stale-running detection: a `running` record whose startedAt
      // is older than STALE_RUNNING_AFTER_MS likely crashed before
      // the executor wrote the final run.json. Surface as `orphaned`
      // so the UI can stop polling + offer a delete action. The
      // on-disk file stays as `status: running` — we only override
      // for the listing view.
      if (
        status === 'running'
        && typeof parsed.startedAt === 'number'
        && Date.now() - parsed.startedAt > STALE_RUNNING_AFTER_MS
      ) {
        status = 'orphaned';
      }
      const summary: DiskRunSummary = {
        runId: parsed.runId,
        workflowName: parsed.workflowName,
        startedAt: parsed.startedAt ?? 0,
        status,
        ...(parsed.completedAt !== undefined ? { completedAt: parsed.completedAt } : {}),
        ...(parsed.ok !== undefined ? { ok: parsed.ok } : {}),
        ...(parsed.arguments !== undefined ? { arguments: parsed.arguments } : {}),
      };
      summaries.push(summary);
    } catch {
      // unreadable / partial — skip
    }
  }
  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return summaries;
}
