import { createHash, randomBytes } from 'node:crypto';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';
import { setCredentialSlotAsync } from '../config/secrets/cred-slots.js';
import { verifyServiceKey } from '../../setup/service-keys.js';
import { scanCredentialImports, type CredentialImportScan } from '../../setup/cred-import-scan.js';
import { jsonResponse } from './json-response.js';

const AUTH_URL = 'https://openrouter.ai/auth';
const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
// Source: 내부 문서 `OPENROUTER-KEY-SUPPLY-FLOW` §보안 계약.
const FLOW_TTL_MS = 600_000;
// Source: 내부 문서 `OPENROUTER-KEY-SUPPLY-FLOW` §보안 계약.
const IMPORT_TTL_MS = 600_000;
export type Flow = { verifier: string; expiresAt: number; expiryTimer?: NodeJS.Timeout };
const flows = new Map<string, Flow>();
interface ImportCandidate { value: string; expiresAt: number; expiryTimer?: NodeJS.Timeout }
const imports = new Map<string, ImportCandidate>();

function privateJson(body: unknown, status = 200): Response {
  const response = jsonResponse(body, status);
  response.headers.set('cache-control', 'no-store');
  return response;
}

function privateRedirect(destination: URL): Response {
  return new Response(null, { status: 303, headers: {
    location: destination.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  } });
}

function maskedLastFour(value: string): string {
  return value.length <= 4 ? '••••' : value.slice(-4);
}

function scheduleExpiryTimer(
  callback: () => void,
  delayMs: number,
  schedule: OpenRouterOAuthDeps['scheduleExpiry'] = setNodeTimeout,
): NodeJS.Timeout {
  return schedule(callback, delayMs) as NodeJS.Timeout;
}

export interface OpenRouterOAuthDeps {
  now?: () => number;
  fetch?: typeof fetch;
  verify?: (key: string) => Promise<{ result: string; httpStatus?: number }>;
  save?: (key: string) => Promise<void>;
  flows?: Map<string, Flow>;
  importCandidates?: Map<string, ImportCandidate>;
  scanImports?: () => CredentialImportScan;
  env?: NodeJS.ProcessEnv;
  scheduleExpiry?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  cancelExpiry?: (timer: NodeJS.Timeout) => void;
}

/** Candidate metadata is safe for the browser; raw values stay in this Nexus process. */
export function handleOpenRouterImportCandidates(req: Request, deps: OpenRouterOAuthDeps = {}): Response {
  const now = deps.now ?? Date.now;
  const pending = deps.importCandidates ?? imports;
  const cancelExpiry = deps.cancelExpiry ?? clearNodeTimeout;
  for (const [id, candidate] of pending) if (candidate.expiresAt <= now()) {
    pending.delete(id);
    if (candidate.expiryTimer) cancelExpiry(candidate.expiryTimer);
  }
  const env = deps.env ?? process.env;
  const scan = (deps.scanImports ?? (() => scanCredentialImports({ existingSlots: [] })))();
  const candidates: Array<{ name: string; source: string; value: string }> = [];
  for (const proposal of scan.proposals) {
    if (proposal.slot !== 'cred:openrouter.api_key' || proposal.reason) continue;
    const value = scan.readSelected([proposal.id])[proposal.slot];
    if (typeof value === 'string' && value.trim()) {
      const source = proposal.sourcePath.includes('#llm.') ? 'Elanous 설정'
        : /\.(?:zshrc|bashrc|bash_profile|profile)$/.test(proposal.sourcePath) ? 'shell 시작 파일' : 'dotenv 파일';
      candidates.push({ name: proposal.name, source, value });
    }
  }
  const liveEnv = env.OPENROUTER_API_KEY?.trim();
  if (liveEnv) candidates.push({ name: 'OPENROUTER_API_KEY', source: 'process environment', value: liveEnv });
  const metadata = candidates.map(candidate => {
    // Source: 내부 문서 `OPENROUTER-KEY-SUPPLY-FLOW` §보안 계약.
    const id = randomBytes(18).toString('base64url');
    const entry: ImportCandidate = { value: candidate.value, expiresAt: now() + IMPORT_TTL_MS };
    pending.set(id, entry);
    const expiryTimer = scheduleExpiryTimer(() => {
      if (pending.get(id) === entry) pending.delete(id);
    }, IMPORT_TTL_MS, deps.scheduleExpiry);
    entry.expiryTimer = expiryTimer;
    expiryTimer.unref?.();
    return { id, name: candidate.name, source: candidate.source, lastFour: maskedLastFour(candidate.value) };
  });
  return privateJson({ candidates: metadata });
}

/** Explicit owner confirmation imports one scanned candidate; its value never crosses the response. */
export async function handleOpenRouterImportConfirm(req: Request, deps: OpenRouterOAuthDeps = {}): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'bad_request' }, 400); }
  const id = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).id : undefined;
  if (typeof id !== 'string' || !id) return jsonResponse({ error: 'bad_request' }, 400);
  const now = deps.now ?? Date.now;
  const pending = deps.importCandidates ?? imports;
  const candidate = pending.get(id);
  pending.delete(id);
  if (candidate?.expiryTimer) (deps.cancelExpiry ?? clearTimeout)(candidate.expiryTimer);
  if (!candidate || candidate.expiresAt <= now()) return jsonResponse({ error: 'candidate_expired' }, 404);
  let verification: Awaited<ReturnType<NonNullable<OpenRouterOAuthDeps['verify']>>>;
  try { verification = await (deps.verify ?? (value => verifyServiceKey('openrouter', value)))(candidate.value); }
  catch { return jsonResponse({ error: 'verification_unavailable' }, 503); }
  if (verification.result !== 'verified') return jsonResponse({ error: 'verification_failed' }, 422);
  try { await (deps.save ?? (value => setCredentialSlotAsync('cred:openrouter.api_key', value)))(candidate.value); }
  catch { return jsonResponse({ error: 'save_failed' }, 503); }
  return jsonResponse({ saved: true, verification: 'verified', lastFour: maskedLastFour(candidate.value) });
}

/** Start OAuth on Nexus so the browser only carries the authorization code, never the API key. */
export function handleOpenRouterOAuthStart(req: Request, deps: OpenRouterOAuthDeps = {}): Response {
  const now = deps.now ?? Date.now;
  const store = deps.flows ?? flows;
  const cancelExpiry = deps.cancelExpiry ?? clearNodeTimeout;
  // Source: 내부 문서 `OPENROUTER-KEY-SUPPLY-FLOW` §보안 계약.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // Source: 내부 문서 `OPENROUTER-KEY-SUPPLY-FLOW` §보안 계약.
  const state = randomBytes(32).toString('base64url');
  const expiresAt = now() + FLOW_TTL_MS;
  for (const [key, flow] of store) if (flow.expiresAt <= now()) {
    store.delete(key);
    if (flow.expiryTimer) cancelExpiry(flow.expiryTimer);
  }
  const flow: Flow = { verifier, expiresAt };
  store.set(state, flow);
  const expiryTimer = scheduleExpiryTimer(() => {
    if (store.get(state) === flow) store.delete(state);
  }, FLOW_TTL_MS, deps.scheduleExpiry);
  flow.expiryTimer = expiryTimer;
  expiryTimer.unref?.();
  const callback = new URL('/v1/credentials/openrouter/oauth/callback', req.url);
  // State is embedded in callback_url so it returns with the authorization code even
  // when the provider does not echo an independent OAuth `state` parameter.
  callback.searchParams.set('state', state);
  const authorize = new URL(AUTH_URL);
  authorize.searchParams.set('callback_url', callback.toString());
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('key_label', 'Elanous');
  // OpenRouter documents returning this unchanged; callback_url also embeds it so
  // the callback remains bound if an intermediary preserves only that URL.
  authorize.searchParams.set('state', state);
  return privateJson({ authorizationUrl: authorize.toString(), expiresAt }, 200);
}

/** Consume state before exchanging; the plaintext key is verified and saved only on the Nexus host. */
export async function handleOpenRouterOAuthCallback(req: Request, deps: OpenRouterOAuthDeps = {}): Promise<Response> {
  const now = deps.now ?? Date.now;
  const store = deps.flows ?? flows;
  const url = new URL(req.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const flow = store.get(state);
  store.delete(state);
  if (flow?.expiryTimer) (deps.cancelExpiry ?? clearTimeout)(flow.expiryTimer);
  const destination = new URL('/app/credentials/', url.origin);
  if (!flow || flow.expiresAt <= now() || !state || !code || url.searchParams.has('error')) {
    destination.searchParams.set('openrouter', 'failed');
    return privateRedirect(destination);
  }
  try {
    const response = await (deps.fetch ?? fetch)(EXCHANGE_URL, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: flow.verifier, code_challenge_method: 'S256' }),
    });
    if (!response.ok) throw new Error('exchange failed');
    const payload = await response.json() as { key?: unknown };
    const key = typeof payload.key === 'string' ? payload.key : '';
    if (!key || /[\r\n\0]/.test(key)) throw new Error('invalid exchange response');
    const verification = await (deps.verify ?? (value => verifyServiceKey('openrouter', value)))(key);
    if (verification.result !== 'verified') throw new Error('key verification failed');
    await (deps.save ?? (value => setCredentialSlotAsync('cred:openrouter.api_key', value)))(key);
    destination.searchParams.set('openrouter', 'connected');
  } catch {
    destination.searchParams.set('openrouter', 'failed');
  }
  return privateRedirect(destination);
}
