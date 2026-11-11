import { claimCredentialRegistrationLinkToken, commitCredentialRegistrationBearer, consumeCredentialRegistrationBearer, issueCredentialRegistrationLinkToken, revokeCredentialRegistrationLinkToken } from '../../auth/setup-link-tokens.js';
import { credentialSetupOptions, credentialSetupOptionsWithHealth, oauthCredentialHealthOptions } from '../setup-status.js';
import { credentialHealthLabel, type CredentialHealthStatus } from '../config/secrets/cred-health.js';
import type { CredentialHealthObserver } from '../config/secrets/cred-health.js';
import { listCredentialSlotsAsync } from '../config/secrets/cred-slots.js';
import { hasCredentialSlotWriteReceipt, writeCredentialSlotBatchValue } from '../config/secrets/registry.js';
import { verifyServiceKey, type ServiceKeyVerification } from '../../setup/service-keys.js';
import { jsonResponse } from './json-response.js';
import { asRecord } from '../../primitives/guards.js';

export interface SetupCredentialDeps {
  dir?: string;
  now?: () => number;
  verify?: (service: string, value: string) => Promise<{ result: ServiceKeyVerification; httpStatus?: number }>;
  saveCredential?: (slot: string, value: string, receipt: { id: string; valueHash: string }) => void;
  authorizeOwner?: (req: Request) => boolean;
  /** Optional metadata-only observer; presence from the secret store alone never asserts validity. */
  healthObserver?: CredentialHealthObserver;
  oauthStorePath?: string;
}

function reconcileCredentialSubmission(receiptId: string, valueHash: string): 'committed' | 'not-committed' | 'unknown' {
  try {
    return hasCredentialSlotWriteReceipt(receiptId, valueHash) ? 'committed' : 'not-committed';
  } catch { return 'unknown'; }
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const lengthHeader = req.headers.get('content-length');
  if (lengthHeader !== null) {
    if (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > 8192) return null;
  }
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 8192) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(bytes);
    return asRecord(JSON.parse(text), { fallback: 'undefined' }) ?? null;
  } catch {
    try { await reader.cancel(); } catch { /* already closed */ }
    return null;
  }
}

/** Owner-authenticated metadata for the credential page. Values are never fetched. */
export async function handleCredentialSlotsGet(req: Request, deps: SetupCredentialDeps = {}): Promise<Response> {
  if (deps.authorizeOwner && !deps.authorizeOwner(req)) return jsonResponse({ error: 'unauthorized' }, 401);
  const options = deps.healthObserver ? credentialSetupOptionsWithHealth(deps.healthObserver) : credentialSetupOptions();
  const slots = await listCredentialSlotsAsync();
  const status = new Map(slots.map((row) => [row.id, row.present]));
  const oauth = oauthCredentialHealthOptions({ ...(deps.oauthStorePath ? { storePath: deps.oauthStorePath } : {}),
    ...(deps.now ? { now: deps.now() } : {}) });
  return jsonResponse({ credentials: options.map((row) => {
    const present = status.get(row.id) ?? false;
    const healthStatus: CredentialHealthStatus = !present ? 'missing' : row.healthStatus ?? 'unmeasured';
    return { ...row, present, healthStatus, healthLabel: credentialHealthLabel(healthStatus) };
  }), oauth: oauth.map((row) => ({ ...row, healthLabel: credentialHealthLabel(row.healthStatus) })) });
}

/** Mint a one-slot, ten-minute link. The token appears only in this response and URL fragment. */
export async function handleCredentialRegistrationLinkCreate(req: Request, deps: SetupCredentialDeps = {}): Promise<Response> {
  if (deps.authorizeOwner && !deps.authorizeOwner(req)) return jsonResponse({ error: 'unauthorized' }, 401);
  const body = await readJson(req);
  const slot = typeof body?.slot === 'string' ? body.slot : '';
  const option = credentialSetupOptions().find((row) => row.id === slot && row.registerable);
  if (!option) return jsonResponse({ error: 'unsupported_slot' }, 400);
  try {
    const issued = issueCredentialRegistrationLinkToken(slot, { ...(deps.dir ? { dir: deps.dir } : {}), ...(deps.now ? { now: deps.now() } : {}) });
    const url = new URL('/app/credentials/register/claim/', req.url);
    url.hash = `t=${issued.token}`;
    return jsonResponse({ slot, url: url.toString(), expiresAt: issued.expiresAt });
  } catch {
    return jsonResponse({ error: 'link_unavailable' }, 503);
  }
}

/** Owner-authenticated cancellation also invalidates any bearer already exchanged from the link. */
export async function handleCredentialRegistrationLinkRevoke(req: Request, deps: SetupCredentialDeps = {}): Promise<Response> {
  if (deps.authorizeOwner && !deps.authorizeOwner(req)) return jsonResponse({ error: 'unauthorized' }, 401);
  const body = await readJson(req);
  const token = typeof body?.t === 'string' ? body.t : '';
  const revoked = revokeCredentialRegistrationLinkToken(token, {
    ...(deps.dir ? { dir: deps.dir } : {}), ...(deps.now ? { now: deps.now() } : {}),
    reconcileSubmission: reconcileCredentialSubmission,
  });
  return revoked ? jsonResponse({ revoked: true }) : jsonResponse({ error: 'unknown' }, 404);
}

/** Claim exchange is self-authenticating and never accepts the generic 24-hour setup bearer. */
export async function handleCredentialRegistrationClaim(req: Request, deps: SetupCredentialDeps = {}): Promise<Response> {
  const body = await readJson(req);
  const token = typeof body?.t === 'string' ? body.t : '';
  const result = claimCredentialRegistrationLinkToken(token, { ...(deps.dir ? { dir: deps.dir } : {}), ...(deps.now ? { now: deps.now() } : {}) });
  if (!result.ok) return jsonResponse({ error: result.reason }, 401);
  const option = credentialSetupOptions().find((row) => row.id === result.slot);
  if (!option) return jsonResponse({ error: 'unsupported_slot' }, 401);
  return jsonResponse({ slot: result.slot, label: option.label, field: option.field, setupUrl: option.setupUrl, bearer: result.bearer, expiresAt: result.expiresAt });
}

/** A short-lived scoped bearer authorizes exactly one verified write to its slot. */
export async function handleCredentialRegistrationSubmit(req: Request, deps: SetupCredentialDeps = {}): Promise<Response> {
  const body = await readJson(req);
  const slot = typeof body?.slot === 'string' ? body.slot : '';
  const value = typeof body?.value === 'string' ? body.value : '';
  const option = credentialSetupOptions().find((row) => row.id === slot && row.registerable);
  if (!option || !value.trim() || value.includes('\0')) return jsonResponse({ error: 'bad_request' }, 400);
  const authorization = req.headers.get('authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const consumed = consumeCredentialRegistrationBearer(bearer, slot, { ...(deps.dir ? { dir: deps.dir } : {}), ...(deps.now ? { now: deps.now() } : {}), submissionValue: value });
  if (!consumed.ok) return jsonResponse({ error: consumed.reason }, consumed.reason === 'wrong-slot' ? 403 : 401);

  const serviceId = option.service === 'openai' ? 'openai-api' : option.service;
  let verification: Awaited<ReturnType<NonNullable<SetupCredentialDeps['verify']>>>;
  try { verification = await (deps.verify ?? ((service, secret) => verifyServiceKey(service, secret)))(serviceId, value); }
  catch { return jsonResponse({ error: 'verification-unavailable' }, 503); }
  if (verification.result !== 'verified') {
    return jsonResponse({ error: 'verification-failed', verification: verification.result, ...(verification.httpStatus === undefined ? {} : { httpStatus: verification.httpStatus }) }, 422);
  }
  try {
    const committed = commitCredentialRegistrationBearer(bearer, slot, value, (receipt) => (deps.saveCredential ?? ((id, secret, marker) => writeCredentialSlotBatchValue({ [id]: secret }, marker)))(slot, value, receipt), {
      ...(deps.dir ? { dir: deps.dir } : {}), ...(deps.now ? { now: deps.now() } : {}),
      isCommitted: hasCredentialSlotWriteReceipt,
    });
    if (!committed.ok) return jsonResponse({ error: committed.reason }, 401);
  }
  catch { return jsonResponse({ error: 'save-failed' }, 503); }
  return jsonResponse({ saved: true, slot, verification: 'verified', ...(verification.httpStatus === undefined ? {} : { httpStatus: verification.httpStatus }) });
}
