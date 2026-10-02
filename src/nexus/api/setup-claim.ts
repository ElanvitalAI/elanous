import { claimSetupLinkToken } from '../../auth/setup-link-tokens.js';
import { jsonResponse } from './json-response.js';

/** A setup link is its own credential; this handler never reads the owner bearer. */
export async function handleSetupClaim(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'bad_request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof (body as Record<string, unknown>).t !== 'string'
    || !(body as { t: string }).t.trim()) {
    return jsonResponse({ error: 'bad_request' }, 400);
  }

  const result = claimSetupLinkToken((body as { t: string }).t);
  if (!result.ok) return jsonResponse({ error: result.reason }, 401);
  return jsonResponse({ scope: 'setup', bearer: result.bearer, expiresAt: result.expiresAt });
}
