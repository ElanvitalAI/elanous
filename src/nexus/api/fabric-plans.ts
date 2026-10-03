import { effectiveInstanceRoot } from '../../instance/resolve.js';
import {
  approveFabricPlan,
  createFabricPlan,
  loadFabricPlan,
  type FabricPlan,
} from '../../self-dev/fabric-plan-core.js';
import { jsonResponse } from './json-response.js';

export interface FabricPlansRouteOpts {
  create?: (root: string, request: string) => Promise<FabricPlan>;
}

/** This route never launches a plan. Only approval writes the fabric execution-candidate ledger. */
export async function handleFabricPlans(req: Request, opts: FabricPlansRouteOpts = {}): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  const root = effectiveInstanceRoot();
  if (pathname === '/v1/fabric/decompose') {
    if (req.method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);
    let body: unknown;
    try { body = await req.json(); }
    catch { return jsonResponse({ error: 'invalid_json' }, 400); }
    const request = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).request : undefined;
    if (typeof request !== 'string' || !request.trim()) return jsonResponse({ error: 'invalid_request' }, 400);
    try {
      const plan = await (opts.create ?? createFabricPlan)(root, request);
      return jsonResponse({ plan }, 201);
    } catch (error) {
      return jsonResponse({ error: 'decomposition_failed', reason: error instanceof Error ? error.message : String(error) }, 422);
    }
  }
  const match = /^\/v1\/fabric\/plans\/([^/]+)(\/approve)?$/.exec(pathname);
  if (!match) return jsonResponse({ error: 'not-found' }, 404);
  let id: string;
  try { id = decodeURIComponent(match[1]!); }
  catch { return jsonResponse({ error: 'invalid_plan_id' }, 400); }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return jsonResponse({ error: 'invalid_plan_id' }, 400);
  if (!match[2]) {
    if (req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);
    const plan = loadFabricPlan(root, id);
    return plan ? jsonResponse({ plan }) : jsonResponse({ error: 'not-found' }, 404);
  }
  if (req.method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);
  // The ledger transition is atomic and rejects a second approval; no draft is executable.
  try {
    return jsonResponse({ candidate: approveFabricPlan(root, id) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('fabric plan not found:')) return jsonResponse({ error: 'not-found' }, 404);
    if (error instanceof Error && error.message === 'fabric plan already approved') return jsonResponse({ error: 'already-approved' }, 409);
    throw error;
  }
}
