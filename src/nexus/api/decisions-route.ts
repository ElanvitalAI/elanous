import { debug } from '../../debug/log.js';
import { DecisionLedger, type DecisionEntry } from '../../decisions/decision-ledger.js';
import { jsonResponse } from './json-response.js';

export const DECISIONS_PATH = '/v1/decisions';

export interface DecisionsRouteDeps {
  authorize?: (request: Request) => boolean;
  ledger?: Pick<DecisionLedger, 'list' | 'decide'>;
}

export async function handleDecisions(req: Request, deps: DecisionsRouteDeps = {}): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  if (pathname !== DECISIONS_PATH && !/^\/v1\/decisions\/[^/]+\/decide$/.test(pathname)) return jsonResponse({ error: 'not-found' }, 404);
  if (!deps.authorize?.(req)) {
    debug.log('decisions.api', 'rejected', { reason: 'unauthorized' });
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const ledger = deps.ledger ?? new DecisionLedger();
  if (pathname === DECISIONS_PATH) {
    if (req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);
    if (new URL(req.url).searchParams.get('status') !== 'open') {
      debug.log('decisions.api', 'rejected', { reason: 'invalid-status' });
      return jsonResponse({ error: 'bad_request' }, 400);
    }
    const decisions = ledger.list({ status: 'open' }).map(entry => ({
      id: entry.id,
      title: entry.title,
      situation: entry.scqa.s.slice(0, 200),
      options: entry.options.map(option => ({ id: option.key, label: option.label })),
      recommendation: entry.recommendation,
      raisedAt: entry.raisedAt,
      dueAt: entry.dueAt,
    }));
    debug.log('decisions.api', 'listed', { count: decisions.length });
    return jsonResponse({ decisions });
  }
  if (req.method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);
  let id: string;
  try { id = decodeURIComponent(pathname.slice(DECISIONS_PATH.length + 1, -'/decide'.length)); }
  catch {
    debug.log('decisions.api', 'rejected', { reason: 'invalid-id' });
    return jsonResponse({ error: 'not-found' }, 404);
  }
  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !('choice' in body) || typeof body.choice !== 'string' || !body.choice
    || ('note' in body && body.note !== undefined && typeof body.note !== 'string')) {
    debug.log('decisions.api', 'rejected', { id, reason: 'invalid-body' });
    return jsonResponse({ error: 'bad_request' }, 400);
  }
  const { choice, note } = body as { choice: string; note?: string };
  try {
    const entry: DecisionEntry = ledger.decide(id, choice, { kind: 'human' }, note);
    debug.log('decisions.api', 'decided', { id });
    return jsonResponse(entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = message.startsWith('decision not found:') ? 404
      : message.startsWith('decision already closed:') ? 409
      : message.startsWith('option not found:') || message.startsWith('note ') ? 400 : 0;
    if (!status) throw error;
    const reason = status === 404 ? 'not-found' : status === 409 ? 'already-decided' : 'bad_request';
    debug.log('decisions.api', 'rejected', { id, reason });
    return jsonResponse({ error: reason }, status);
  }
}
