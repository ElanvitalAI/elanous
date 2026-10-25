import { debug } from '../../debug/log.js';
import { GraphWizardInputError, designGraphVariantPlan, generateGraphFromPrompt, wizardInstalledPacks, type GraphWizardDeps, type GraphWizardTurn } from '../../graph-wizard/generate.js';
import { defaultGraphsDir } from '../../self-implement/graph-templates.js';
import { loadGraphTemplates } from '../../self-implement/graph-yaml.js';
import type { NexusEventBus } from './event-bus.js';
import { jsonResponse } from './json-response.js';

export function handleGraphWizardPacksGet(deps: GraphWizardDeps = {}): Response {
  return jsonResponse({ packs: wizardInstalledPacks(deps) });
}

const MAX_PROMPT = 4000;
const MAX_YAML = 200_000;

/** 호출 경계에서 variant 한 턴의 결말을 버스에 남긴다 — mode·reason ⊕ 조작 growth 좌표. */
function publishGraphCompose(eventBus: NexusEventBus | undefined, input: {
  readonly result: Awaited<ReturnType<typeof designGraphVariantPlan>>;
  readonly goal: string;
  readonly templateId: string;
}): void {
  const { result, goal, templateId } = input;
  eventBus?.publish({
    ts: Date.now(),
    kind: 'graph.compose',
    detail: {
      mode: result.mode,
      status: result.status,
      reason: result.reason,
      goal,
      templateId,
      ...(result.growth ? { growth: result.growth } : {}),
      ...(result.status === 'composed' ? { overlayId: result.variant.overlay.overlayId, patches: result.variant.patches.length } : {}),
    },
  });
}

/**
 * POST /v1/graphs/wizard {prompt, kind?, currentYaml?, history?} or
 * {mode:'variant', prompt, goal, templateId} for one validated L2 plan (no YAML generation).
 * → 200 {ok:true, id, yaml, base, baseReason, issues:[], attempts, summary, labels, steps, recipes, dryRun} · 422 {ok:false, …} · 400 빈 prompt.
 * (labels·steps·recipes·dryRun·baseReason 는 v2 추가 필드 — 기존 필드는 그대로.)
 * currentYaml 이 빈 문자열이면 «빈 캔버스»로 보고 새 그래프를 짓는다(의도) · 내용이 있는데 id 가 없거나 형식 밖이면 400.
 * 저장하지 않는다 — 저장은 POST /v1/graphs(새 그래프) 또는 PUT /v1/graphs/<id>/yaml(내 그래프).
 * variant 요청은 결말(mode·reason·조작 growth)을 주입된 버스에 `graph.compose` 이벤트로 남긴다.
 */
export async function handleGraphWizardPost(req: Request, deps: GraphWizardDeps = {}, eventBus?: NexusEventBus): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object');
    body = parsed as Record<string, unknown>;
  } catch { return jsonResponse({ error: 'bad_request', reason: 'json body required' }, 400); }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return jsonResponse({ error: 'bad_request', reason: 'prompt required' }, 400);
  if (prompt.length > MAX_PROMPT) return jsonResponse({ error: 'bad_request', reason: `prompt longer than ${MAX_PROMPT}` }, 400);
  if (body.mode !== undefined && body.mode !== 'variant') {
    return jsonResponse({ error: 'bad_request', reason: 'mode must be variant when supplied' }, 400);
  }
  if (body.kind !== undefined && body.kind !== 'harness' && body.kind !== 'workflow') {
    return jsonResponse({ error: 'bad_request', reason: 'kind must be harness or workflow' }, 400);
  }
  if (body.currentYaml !== undefined && (typeof body.currentYaml !== 'string' || body.currentYaml.length > MAX_YAML)) {
    return jsonResponse({ error: 'bad_request', reason: 'currentYaml must be a string' }, 400);
  }
  if (body.packId !== undefined && typeof body.packId !== 'string') {
    return jsonResponse({ error: 'bad_request', reason: 'packId must be a string' }, 400);
  }
  let history: GraphWizardTurn[] | undefined;
  if (body.history !== undefined) {
    if (!Array.isArray(body.history) || !body.history.every((t) => t && typeof t === 'object' &&
      ((t as GraphWizardTurn).role === 'user' || (t as GraphWizardTurn).role === 'assistant') && typeof (t as GraphWizardTurn).text === 'string')) {
      return jsonResponse({ error: 'bad_request', reason: 'history must be [{role, text}]' }, 400);
    }
    history = body.history as GraphWizardTurn[];
  }
  try {
    if (body.mode === 'variant') {
      if (typeof body.goal !== 'string' || !/^g_[a-z0-9_-]+$/i.test(body.goal) ||
          typeof body.templateId !== 'string' || !/^[a-z0-9-]+$/.test(body.templateId) ||
          body.kind === 'workflow' || body.currentYaml !== undefined || body.packId !== undefined || history !== undefined) {
        return jsonResponse({ error: 'bad_request', reason: 'variant requires goal and templateId; YAML, workflow, pack and history are unsupported' }, 400);
      }
      // Resolve the base on the server. Client-supplied graph YAML never becomes variant authority.
      const template = loadGraphTemplates(deps.graphsDir ?? defaultGraphsDir()).templates[body.templateId];
      if (!template) return jsonResponse({ error: 'bad_request', reason: `unknown templateId: ${body.templateId}` }, 400);
      const result = await designGraphVariantPlan({ goal: body.goal, prompt, template }, deps);
      publishGraphCompose(eventBus, { result, goal: body.goal, templateId: body.templateId });
      return jsonResponse(result);
    }
    const result = await generateGraphFromPrompt({
      prompt,
      ...(body.kind ? { kind: body.kind as 'harness' | 'workflow' } : {}),
      ...(typeof body.currentYaml === 'string' && body.currentYaml.trim() ? { currentYaml: body.currentYaml } : {}),
      ...(history ? { history } : {}),
      ...(typeof body.packId === 'string' ? { packId: body.packId } : {}),
    }, deps);
    return jsonResponse({ ...result, base: result.base ?? null }, result.ok ? 200 : 422);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof GraphWizardInputError) return jsonResponse({ error: 'bad_request', reason: message }, 400);
    debug.log('graph.wizard', 'error', { message });
    return jsonResponse({ error: 'wizard-failed', reason: message }, 502);
  }
}
