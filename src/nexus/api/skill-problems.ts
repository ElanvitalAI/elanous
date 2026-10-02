// SK2 (PWA) — 색인이 못 읽은 스킬을 PWA 에도 «안내 ⊕ 확인 뒤 수리»로.
// GET  /v1/skills/problems           → { items: [{ id, name, code, fixable, hint? }] } — 경로 대신 해시 id 만 내보낸다
// POST /v1/skills/problems/repair    → body { id } · 고칠 수 있는 것만 고친다(남의 도구 파일 — PWA 가 먼저 확인을 받는다)
import { createHash } from 'node:crypto';
import { debug } from '../../debug/log.js';
import { getSkillIndex, skillIndexProblems, type SkillIndexProblem } from '../../skills/index.js';
import { applySkillRepair, planSkillRepair } from '../../skills/repair.js';
import { jsonResponse } from './json-response.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';

export const SKILL_PROBLEMS_PATH = '/v1/skills/problems';

export interface SkillProblemsDeps {
  problems?: () => SkillIndexProblem[];
}

function problemId(p: SkillIndexProblem): string {
  return createHash('sha256').update(`${p.dir}\u0000${p.name}`).digest('hex').slice(0, 16);
}

function current(deps: SkillProblemsDeps): SkillIndexProblem[] {
  if (deps.problems) return deps.problems();
  getSkillIndex();
  return skillIndexProblems();
}

export async function handleSkillProblems(req: Request, metaApi: MetaApiOpts, deps: SkillProblemsDeps = {}): Promise<Response> {
  if (!checkAuth(req, metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
  const pathname = new URL(req.url).pathname;
  if (pathname === SKILL_PROBLEMS_PATH) {
    if (req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);
    const items = current(deps).map((p) => {
      const plan = planSkillRepair(p);
      return {
        id: problemId(p), name: p.name, code: p.code,
        fixable: plan.kind === 'fixable' || plan.kind === 'fixable-permission',
        ...(plan.kind === 'permission' || plan.kind === 'manual' ? { hint: plan.hint.replace(p.dir, '…') } : {}),
      };
    });
    return jsonResponse({ items });
  }
  if (pathname === `${SKILL_PROBLEMS_PATH}/repair`) {
    if (req.method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);
    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: 'bad_request' }, 400); }
    const id = body && typeof body === 'object' && typeof (body as { id?: unknown }).id === 'string' ? (body as { id: string }).id : '';
    const problem = current(deps).find((p) => problemId(p) === id);
    if (!problem) return jsonResponse({ error: 'not-found' }, 404);
    const plan = planSkillRepair(problem);
    if (plan.kind !== 'fixable' && plan.kind !== 'fixable-permission') return jsonResponse({ error: 'not-fixable', hint: plan.hint.replace(problem.dir, '…') }, 409);
    const result = applySkillRepair(plan);
    debug.log('skills.repair', 'pwa-request', { name: problem.name, ok: result.ok });
    return result.ok ? jsonResponse({ ok: true, name: problem.name }) : jsonResponse({ ok: false, reason: result.reason }, 409);
  }
  return jsonResponse({ error: 'not-found' }, 404);
}
