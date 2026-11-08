import type { AppGenerationBackend } from './app-jobs.js';
import { createAppCredentialCapability, isAppCredentialCapability, type AppCredentialCapability } from './app-credential-capability.js';
import { createHiggsfieldCliSessionBackend, type HiggsfieldCliSessionBackendOptions } from './higgsfield-cli-session.js';

const API_ORIGIN = 'https://api.higgsfield.ai';
const REQUEST_TIMEOUT_MS = 30_000;
const LEGACY_CLI_SESSION_MARKER = 'internal:cli-session:voice-note';
/** Opaque, process-local capability; unlike a string it cannot be forged through app secret storage. */
const HIGGSFIELD_CLI_SESSION_CREDENTIAL = createAppCredentialCapability();
const HIGGSFIELD_VOICE_NOTE_CREDENTIALS = new Set(['cred:higgsfield.key_id', 'cred:higgsfield.secret']);
const HIGGSFIELD_CREDENTIAL_FIELDS = ['key_id', 'secret'] as const;

/** Returns a virtual app-scoped capability, never a key or persisted secret value. */
export function higgsfieldCliSessionCredentialForApp(appSlug: string, reference: string): AppCredentialCapability | undefined {
  return appSlug === 'voice-note' && HIGGSFIELD_VOICE_NOTE_CREDENTIALS.has(reference)
    ? HIGGSFIELD_CLI_SESSION_CREDENTIAL
    : undefined;
}

export async function resolveHiggsfieldAppCredentialForApp(
  appSlug: string,
  reference: string,
  readStoredField: (field: typeof HIGGSFIELD_CREDENTIAL_FIELDS[number]) => Promise<string | undefined>,
): Promise<{ readonly handled: false } | { readonly handled: true; readonly value?: string | AppCredentialCapability }> {
  if (appSlug !== 'voice-note' || !HIGGSFIELD_VOICE_NOTE_CREDENTIALS.has(reference)) return { handled: false };
  const [keyId, secret] = await Promise.all(HIGGSFIELD_CREDENTIAL_FIELDS.map(readStoredField));
  const hasKeyId = typeof keyId === 'string' && !!keyId.trim();
  const hasSecret = typeof secret === 'string' && !!secret.trim();
  if (hasKeyId !== hasSecret) return { handled: true };
  if (!hasKeyId) return { handled: true, value: HIGGSFIELD_CLI_SESSION_CREDENTIAL };
  return { handled: true, value: reference.endsWith('.key_id') ? keyId : secret };
}

export interface HiggsfieldAppCredentials {
  readonly appSlug?: string;
  readonly keyId: string | AppCredentialCapability;
  readonly secret: string | AppCredentialCapability;
}

export interface HiggsfieldAppFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface UploadTicket {
  readonly upload_url: string;
  readonly upload_headers: Record<string, string>;
  readonly public_url: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeHttpsUrl(value: unknown, field: string, allowedOrigin?: string): string {
  if (typeof value !== 'string') throw new Error(`Higgsfield ${field} is missing`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Higgsfield ${field} is invalid`); }
  if (url.protocol !== 'https:' || url.username || url.password || (allowedOrigin && url.origin !== allowedOrigin)) {
    throw new Error(`Higgsfield ${field} is unsafe`);
  }
  return url.toString();
}

function requireCredentials(credentials: { readonly keyId: string; readonly secret: string }): string {
  if (!credentials.keyId.trim() || !credentials.secret.trim() || /[\r\n]/.test(credentials.keyId + credentials.secret)) {
    throw new Error('Higgsfield app credentials are unavailable');
  }
  return `${credentials.keyId}:${credentials.secret}`;
}

async function jsonResponse(response: Response, label: string): Promise<unknown> {
  if (!response.ok) throw new Error(`Higgsfield ${label} failed (${response.status})`);
  try { return await response.json(); } catch { throw new Error(`Higgsfield ${label} returned invalid JSON`); }
}

/** App-key REST adapter. It uploads the image by signed URL, then uses the documented Seedance image input path.
 * Marketing Studio product creation has no documented REST endpoint; this adapter intentionally uses the
 * image-reference fallback and never invokes the globally authenticated Higgsfield CLI.
 */
export function createHiggsfieldAppBackend(
  credentials: HiggsfieldAppCredentials,
  options: { readonly fetch?: HiggsfieldAppFetch; readonly apiOrigin?: string; readonly cliSession?: Omit<HiggsfieldCliSessionBackendOptions, 'appSlug'> } = {},
): AppGenerationBackend {
  const hasCapability = isAppCredentialCapability(credentials.keyId) || isAppCredentialCapability(credentials.secret);
  if (hasCapability) {
    if (credentials.appSlug !== 'voice-note' || credentials.keyId !== HIGGSFIELD_CLI_SESSION_CREDENTIAL
      || credentials.secret !== HIGGSFIELD_CLI_SESSION_CREDENTIAL) {
      throw new Error('Higgsfield CLI session capability is not authorized for this app');
    }
    return createHiggsfieldCliSessionBackend({ appSlug: 'voice-note', ...options.cliSession, allowSpend: true });
  }
  if (credentials.keyId === LEGACY_CLI_SESSION_MARKER || credentials.secret === LEGACY_CLI_SESSION_MARKER) {
    throw new Error('Higgsfield CLI session requires an in-memory app capability');
  }
  const keyId = credentials.keyId;
  const secret = credentials.secret;
  if (typeof keyId !== 'string' || typeof secret !== 'string') {
    throw new Error('Higgsfield app credential pair is invalid');
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiOrigin = options.apiOrigin ?? API_ORIGIN;
  if (new URL(apiOrigin).protocol !== 'https:') throw new Error('Higgsfield API origin must use HTTPS');
  const authorization = `Key ${requireCredentials({ keyId, secret })}`;

  return {
    async submit(input) {
      const mimeType = input.mimeType;
      if (!/^image\/(?:jpeg|png|webp)$/.test(mimeType) || input.image.byteLength === 0) {
        throw new Error('Higgsfield image input is invalid');
      }
      const ticketValue = await jsonResponse(await fetcher(`${apiOrigin}/files/generate-upload-url`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ content_type: mimeType }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      }), 'signed upload request');
      if (!object(ticketValue) || !object(ticketValue.upload_headers)) throw new Error('Higgsfield signed upload ticket is invalid');
      const ticket = ticketValue as unknown as UploadTicket;
      const uploadUrl = safeHttpsUrl(ticket.upload_url, 'upload URL');
      const publicUrl = safeHttpsUrl(ticket.public_url, 'public upload URL');
      const uploadHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(ticket.upload_headers)) {
        if (!/^[a-z0-9-]+$/i.test(name) || typeof value !== 'string') throw new Error('Higgsfield upload headers are invalid');
        uploadHeaders[name] = value;
      }
      const uploadBody = new ArrayBuffer(input.image.byteLength);
      new Uint8Array(uploadBody).set(input.image);
      const uploaded = await fetcher(uploadUrl, {
        method: 'PUT', headers: uploadHeaders, body: uploadBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error',
      });
      if (!uploaded.ok) throw new Error(`Higgsfield signed upload failed (${uploaded.status})`);

      const receiptValue = await jsonResponse(await fetcher(`${apiOrigin}/bytedance/seedance-2.0/image-to-video`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: input.prompt, image_url: publicUrl }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      }), 'generation submit');
      if (!object(receiptValue) || typeof receiptValue.request_id !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(receiptValue.request_id)) throw new Error('Higgsfield request ID is invalid');
      if (typeof receiptValue.status_url === 'string') safeHttpsUrl(receiptValue.status_url, 'status URL', new URL(apiOrigin).origin);
      return receiptValue.request_id;
    },
    async poll(requestId) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error('Higgsfield request ID is invalid');
      const result = await jsonResponse(await fetcher(`${apiOrigin}/requests/${encodeURIComponent(requestId)}/status`, {
        headers: { authorization }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error',
      }), 'status request');
      if (!object(result) || typeof result.status !== 'string') throw new Error('Higgsfield status response is invalid');
      const video = object(result.video) ? result.video : undefined;
      const url = video?.url;
      if (result.status === 'completed' && typeof url === 'string') {
        return { status: result.status, resultUrl: safeHttpsUrl(url, 'result URL') };
      }
      return { status: result.status };
    },
  };
}

export async function downloadHiggsfieldResult(
  value: string,
  maxBytes: number,
  fetcher: HiggsfieldAppFetch = globalThis.fetch,
): Promise<{ readonly bytes: Uint8Array; readonly contentType: 'video/mp4' | 'video/webm' } | undefined> {
  const urlText = safeHttpsUrl(value, 'result URL');
  const host = new URL(urlText).hostname.toLowerCase();
  if (!host.endsWith('.cloudfront.net') && !host.endsWith('.higgsfield.ai')) throw new Error('Higgsfield result host is unsafe');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return undefined;
  const response = await fetcher(urlText, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' });
  if (!response.ok || !response.body) return undefined;
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime !== 'video/mp4' && mime !== 'video/webm') return undefined;
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(chunk);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.byteLength ? { bytes, contentType: mime } : undefined;
}
