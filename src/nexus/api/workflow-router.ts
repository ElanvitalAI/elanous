// NEXUS · POST /v1/workflows/route — LLM-based workflow routing
// (BACKLOG #7 production wiring · 2026-05-08)
//
// Single-shot routing endpoint. Caller posts a user message + optional
// context; we discover the available workflows, build the Archon-
// style router prompt (`buildWorkflowRouterPrompt` from
// `src/skills/llm-router.ts`), call the LLM once, and parse the
// response into a workflow name (or null when the LLM couldn't
// confidently pick).
//
// Why expose as a separate REST endpoint (not auto-route inside
// `/run`)?
//   1. Cost ceiling — caller decides when to spend an LLM call;
//      regex-based `detectSkillTrigger` stays the cheap fast path.
//   2. Caller-side caching — same user message in a session
//      shouldn't re-pay; let the caller (PWA / CLI) cache.
//   3. Surfacing — a router decision can be presented to the user
//      ("did you mean code-review?") before invoking, instead of
//      auto-firing on uncertain matches.
//
// Wire shape:
//   POST /v1/workflows/route
//   body: { userMessage: string, context?: RouteContext, model?: string,
//           provider?: string }
//   200: { name: string | null, error?: string, reasoning?: string }
//
// `name` is set when the LLM emitted a valid `/invoke-workflow <name>`
// AND `<name>` matched a discovered workflow. `error` carries the
// "Unknown candidate" hint when the LLM picked a nonexistent name.
// `reasoning` is the LLM's full response for debugging (caller can
// hide it in production UIs).

import { jsonResponse } from './json-response.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { discoverWorkflows } from '../../workflow-runtime/discovery.js';
import {
  routeWithFallback,
  type CascadeResult,
  type RouteContext,
} from '../../skills/llm-router.js';

/** Local JSON body reader — inline to avoid circular import via
 *  workflows.ts (which has its own private copy). */
async function readJsonBody(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return null; }
}

export interface WorkflowRouteRequest {
  userMessage: string;
  context?: RouteContext;
  model?: string;
  provider?: string;
}

export interface WorkflowRouteResponse {
  name: string | null;
  error?: string;
  /** Raw LLM response (or short regex-match note) — debug aid. */
  reasoning?: string;
  /** Which path picked the workflow. 'regex' = no LLM call (cost win
   *  · ~0ms). 'llm' = LLM was called once. 'none' = empty discovery.
   *  Caller telemetry — drives the cost ceiling decision recorded in
   *  HANDOFF §4.2 (regex first → LLM escalate). */
  source: CascadeResult['source'];
}

/** Inject a fake LLM caller for tests. Returns the LLM's full response
 *  text (whatever it generated for the routing prompt). */
export type RouterLLMCaller = (
  prompt: string,
  opts: { model?: string; provider?: string },
) => Promise<string>;

/** Internal default — uses the same `streamLLM` the workflow runtime
 *  itself uses, so the routing call inherits the user's configured
 *  default provider. Lazy require to avoid pulling llm.ts when the
 *  endpoint isn't exercised. */
async function defaultLLMCaller(
  prompt: string,
  opts: { model?: string; provider?: string },
): Promise<string> {
  const llm = await import('../../llm.js');
  let provider = opts.provider ? llm.PROVIDERS[opts.provider] : undefined;
  if (!provider) provider = llm.resolveDefaultProvider(opts.model);
  const safeModel = llm.isModelCompatible(provider.name, opts.model) ? opts.model : undefined;
  const sopts: Parameters<typeof llm.streamLLM>[2] = {
    ...(safeModel !== undefined ? { model: safeModel } : {}),
    provider,
    // Routing decisions don't need creativity; prefer terse output.
    temperature: 0,
  };
  return llm.streamLLM(
    [{ role: 'user', content: prompt }],
    () => { /* buffer-only */ },
    sopts,
  );
}

/** Pure dispatcher — extracted so tests can drive routing without
 *  spinning up an HTTP server.
 *
 *  Cascade: `routeWithFallback` runs the regex pass first (cheap,
 *  no I/O) and only invokes `llm` when regex misses or is ambiguous.
 *  See `src/skills/llm-router.ts` top-of-section comment for the
 *  cost rationale. */
export async function routeWorkflow(
  req: WorkflowRouteRequest,
  llm: RouterLLMCaller = defaultLLMCaller,
): Promise<WorkflowRouteResponse> {
  const entries = discoverWorkflows();
  const candidates = entries.map((entry) => ({
    name: entry.definition.name,
    description: entry.definition.description ?? '',
  }));
  if (candidates.length === 0) {
    return { name: null, source: 'none', error: 'no workflows discovered' };
  }

  const llmCallOpts: { model?: string; provider?: string } = {};
  if (req.model !== undefined) llmCallOpts.model = req.model;
  if (req.provider !== undefined) llmCallOpts.provider = req.provider;

  const result = await routeWithFallback({
    userMessage: req.userMessage,
    candidates,
    llm,
    llmCallOpts,
    ...(req.context !== undefined ? { context: req.context } : {}),
    invokeCommand: '/invoke-workflow',
  });

  return {
    name: result.name,
    source: result.source,
    ...(result.reasoning !== undefined ? { reasoning: result.reasoning } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/** POST /v1/workflows/route handler. */
export async function handleWorkflowRoute(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  const userMessage = (body as { userMessage?: unknown }).userMessage;
  if (typeof userMessage !== 'string' || userMessage.trim().length === 0) {
    return jsonResponse({ error: 'userMessage required' }, 400);
  }

  const request: WorkflowRouteRequest = { userMessage };
  const ctx = (body as { context?: unknown }).context;
  if (ctx && typeof ctx === 'object') {
    request.context = ctx as RouteContext;
  }
  const model = (body as { model?: unknown }).model;
  if (typeof model === 'string') request.model = model;
  const provider = (body as { provider?: unknown }).provider;
  if (typeof provider === 'string') request.provider = provider;

  const result = await routeWorkflow(request);
  return jsonResponse(result, 200);
}
