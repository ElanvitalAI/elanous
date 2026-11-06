// NEXUS · POST /v1/skills/route — LLM-based skill routing
// (HANDOFF §4.2 follow-up · mirrors POST /v1/workflows/route).
//
// Same single-shot routing pattern as the workflow endpoint:
// caller posts userMessage + optional context; we read the in-process
// skill index, build a router prompt, run the regex → LLM cascade
// (`routeWithFallback` from `src/skills/llm-router.ts`), and return
// the picked skill name.
//
// Why a separate REST endpoint (and not auto-routing inside chat)?
//   1. Cost ceiling — caller decides when to spend an LLM call. The
//      cascade's regex pass turns LLM into the exception, not the
//      default.
//   2. Caller-side caching — same user message in a session shouldn't
//      re-pay; let the caller (PWA / CLI) cache.
//   3. Surfacing — a router decision can be presented to the user
//      ("did you mean omni-digest?") before invoking, instead of
//      auto-firing on uncertain matches.
//
// Wire shape:
//   POST /v1/skills/route
//   body: { userMessage: string, context?: RouteContext, model?: string,
//           provider?: string }
//   200: { name: string|null, source: 'regex'|'llm'|'none',
//          reasoning?: string, error?: string }
//
// `name` is set when the cascade resolved a skill from the user's
// message (regex hit OR LLM picked a valid name). `error` carries the
// "Unknown candidate" hint when the LLM picked a nonexistent name or
// when the LLM call itself threw.

import { jsonResponse } from './json-response.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { getSkillIndex, type SkillIndexEntry } from '../../skills/index.js';
import {
  routeWithFallback,
  type CascadeResult,
  type RouteContext,
} from '../../skills/llm-router.js';

async function readJsonBody(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return null; }
}

export interface SkillRouteRequest {
  userMessage: string;
  context?: RouteContext;
  model?: string;
  provider?: string;
}

export interface SkillRouteResponse {
  name: string | null;
  /** Which path picked the skill. 'regex' = no LLM call (cost win
   *  · ~0ms). 'llm' = LLM called once. 'none' = empty discovery. */
  source: CascadeResult['source'];
  /** Raw LLM response (or short regex-match note) — debug aid. */
  reasoning?: string;
  /** Surfaced when the LLM picked a name not in the candidate list,
   *  or when the LLM call itself threw. */
  error?: string;
}

/** Inject a fake LLM caller for tests. Same shape as the workflow
 *  router — kept identical so test rigs can be shared. */
export type RouterLLMCaller = (
  prompt: string,
  opts: { model?: string; provider?: string },
) => Promise<string>;

/** Internal default — uses `streamLLM` so the routing call inherits
 *  the user's configured default provider. Lazy require to avoid
 *  pulling llm.ts when the endpoint isn't exercised. */
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
    temperature: 0,
  };
  return llm.streamLLM(
    [{ role: 'user', content: prompt }],
    () => { /* buffer-only */ },
    sopts,
  );
}

/** Inject a fake skill loader for tests. Production path uses
 *  `getSkillIndex()` which scans the configured skill dirs; tests
 *  hand-roll an entry list to drive routing without disk fixtures. */
export type SkillIndexLoader = () => readonly SkillIndexEntry[];

/** Pure dispatcher — extracted so tests can drive routing without
 *  spinning up an HTTP server. The cascade runs the regex pass first
 *  (using each skill's frontmatter `triggers:` directly — NOT the
 *  4-line conv parser that workflows use) and only invokes `llm`
 *  when regex misses or is ambiguous. */
export async function routeSkill(
  req: SkillRouteRequest,
  llm: RouterLLMCaller = defaultLLMCaller,
  loadIndex: SkillIndexLoader = getSkillIndex,
): Promise<SkillRouteResponse> {
  const entries = loadIndex();
  const candidates = entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    // Skills carry explicit triggers in frontmatter (separate from
    // the prose description). Pass them through so the cascade's
    // regex pass uses authored intent directly instead of trying to
    // parse them out of the description.
    triggers: entry.triggers,
  }));
  if (candidates.length === 0) {
    return { name: null, source: 'none', error: 'no skills discovered' };
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
    invokeCommand: '/invoke-skill',
  });

  return {
    name: result.name,
    source: result.source,
    ...(result.reasoning !== undefined ? { reasoning: result.reasoning } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/** POST /v1/skills/route handler. */
export async function handleSkillRoute(
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

  const request: SkillRouteRequest = { userMessage };
  const ctx = (body as { context?: unknown }).context;
  if (ctx && typeof ctx === 'object') {
    request.context = ctx as RouteContext;
  }
  const model = (body as { model?: unknown }).model;
  if (typeof model === 'string') request.model = model;
  const provider = (body as { provider?: unknown }).provider;
  if (typeof provider === 'string') request.provider = provider;

  const result = await routeSkill(request);
  return jsonResponse(result, 200);
}
