import { debug } from '../../debug/log.js';
import { GraphWizardInputError, generateGraphFromPrompt, type GraphWizardDeps, type GraphWizardTurn } from '../../graph-wizard/generate.js';
import { jsonResponse } from './json-response.js';

const MAX_PROMPT = 4000;
const MAX_YAML = 200_000;

/**
 * POST /v1/graphs/wizard {prompt, kind?, currentYaml?, history?}
 * → 200 {ok:true, id, yaml, base, baseReason, issues:[], attempts, summary, labels, steps, recipes, dryRun} · 422 {ok:false, …} · 400 빈 prompt.
 * (labels·steps·recipes·dryRun·baseReason 는 v2 추가 필드 — 기존 필드는 그대로.)
 * currentYaml 이 빈 문자열이면 «빈 캔버스»로 보고 새 그래프를 짓는다(의도) · 내용이 있는데 id 가 없거나 형식 밖이면 400.
 * 저장하지 않는다 — 저장은 POST /v1/graphs(새 그래프) 또는 PUT /v1/graphs/<id>/yaml(내 그래프).
 */
export async function handleGraphWizardPost(req: Request, deps: GraphWizardDeps = {}): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object');
    body = parsed as Record<string, unknown>;
  } catch { return jsonResponse({ error: 'bad_request', reason: 'json body required' }, 400); }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return jsonResponse({ error: 'bad_request', reason: 'prompt required' }, 400);
  if (prompt.length > MAX_PROMPT) return jsonResponse({ error: 'bad_request', reason: `prompt longer than ${MAX_PROMPT}` }, 400);
  if (body.kind !== undefined && body.kind !== 'harness' && body.kind !== 'workflow') {
    return jsonResponse({ error: 'bad_request', reason: 'kind must be harness or workflow' }, 400);
  }
  if (body.currentYaml !== undefined && (typeof body.currentYaml !== 'string' || body.currentYaml.length > MAX_YAML)) {
    return jsonResponse({ error: 'bad_request', reason: 'currentYaml must be a string' }, 400);
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
    const result = await generateGraphFromPrompt({
      prompt,
      ...(body.kind ? { kind: body.kind as 'harness' | 'workflow' } : {}),
      ...(typeof body.currentYaml === 'string' && body.currentYaml.trim() ? { currentYaml: body.currentYaml } : {}),
      ...(history ? { history } : {}),
    }, deps);
    return jsonResponse({ ...result, base: result.base ?? null }, result.ok ? 200 : 422);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof GraphWizardInputError) return jsonResponse({ error: 'bad_request', reason: message }, 400);
    debug.log('graph.wizard', 'error', { message });
    return jsonResponse({ error: 'wizard-failed', reason: message }, 502);
  }
}
