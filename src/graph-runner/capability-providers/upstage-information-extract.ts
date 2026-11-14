import { getSecretAsync, selectBackendFromConfig } from '../../nexus/config/secrets/index.js';
import { upstageBaseUrl } from '../../ocr/upstage.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityRegistry } from '../capabilities.js';

const SECRET_REF = 'cred:upstage.api_key';
const CONTRACT = 'document.information-extract@1';
const OPERATION_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;

type Schema = Record<string, unknown>;
type SecretLookup = (id: string) => Promise<string | undefined>;
export interface UpstageInformationExtractOptions {
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  lookupSecret?: SecretLookup;
  /** A loopback endpoint is allowed only in a test universe. */
  testEndpoint?: string;
  /** Shorten the real deadline in a test universe; production always uses the fixed limit. */
  testTimeoutMs?: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Supported schema subset is checked before upload so unsupported constraints cannot appear validated. */
function supportedSchema(value: unknown): value is Schema {
  if (!record(value) || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(value.type))) return false;
  const allowed = new Set(['type', 'properties', 'required', 'items', 'enum', 'description', 'additionalProperties']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) return false;
  if (value.type === 'object') {
    if (!record(value.properties)) return false;
    if (Object.values(value.properties).some((child) => !supportedSchema(child))) return false;
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((key) =>
      typeof key !== 'string' || !Object.hasOwn(value.properties as object, key)))) return false;
    if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') return false;
  } else if (value.properties !== undefined || value.required !== undefined || value.additionalProperties !== undefined) return false;
  if (value.type === 'array') {
    if (!supportedSchema(value.items)) return false;
  } else if (value.items !== undefined) return false;
  return value.description === undefined || typeof value.description === 'string';
}

/** JSON object key order is not part of its value; enum comparison must preserve that rule. */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => jsonEqual(item, right[index]));
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

function matches(schema: Schema, value: unknown): boolean {
  const type = schema.type;
  if (type === 'object') {
    if (!record(value)) return false;
    const properties = schema.properties as Record<string, Schema>;
    if ((schema.required as string[] | undefined)?.some((key) => !Object.hasOwn(value, key))) return false;
    for (const [key, field] of Object.entries(value)) {
      const child = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (!child && schema.additionalProperties === false) return false;
      if (child && !matches(child, field)) return false;
    }
  } else if (type === 'array') {
    if (!Array.isArray(value) || !value.every((item) => matches(schema.items as Schema, item))) return false;
  } else if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return false;
  } else if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  } else if (type === 'null') {
    if (value !== null) return false;
  } else if (typeof value !== type) return false;
  return !Array.isArray(schema.enum) || schema.enum.some((choice) => jsonEqual(choice, value));
}

function validDocumentDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 70_000_000) return false;
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  const encoded = match?.[1];
  if (!encoded) return false;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const payload = encoded.slice(0, encoded.length - padding);
  const remainder = payload.length % 4;
  if (remainder === 1 || (padding > 0 && (encoded.length % 4 !== 0 || remainder !== 4 - padding))) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (remainder === 2) return (alphabet.indexOf(payload.at(-1)!) & 15) === 0;
  if (remainder === 3) return (alphabet.indexOf(payload.at(-1)!) & 3) === 0;
  return true;
}

function endpointFor(options: UpstageInformationExtractOptions): string {
  if (!options.testEndpoint) return `${upstageBaseUrl()}/information-extraction`;
  const url = new URL(options.testEndpoint);
  if (process.env.NODE_ENV !== 'test' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.protocol !== 'http:' || url.pathname !== '/v1/information-extraction' || url.search || url.hash)
    throw new Error('test_endpoint_forbidden');
  return url.href;
}

function timeoutFor(options: UpstageInformationExtractOptions): number {
  if (options.testTimeoutMs === undefined) return OPERATION_TIMEOUT_MS;
  if (process.env.NODE_ENV !== 'test' || !Number.isSafeInteger(options.testTimeoutMs)
    || options.testTimeoutMs < 1 || options.testTimeoutMs > OPERATION_TIMEOUT_MS) throw new Error('test_timeout_forbidden');
  return options.testTimeoutMs;
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, secret));
  if (record(value)) return Object.entries(value).some(([name, item]) => name.includes(secret) || containsSecret(item, secret));
  return false;
}

async function boundedResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
  if (!response.body) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('operation_aborted');
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
      chunks.push(part.value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(data));
  } finally {
    signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {});
  }
}

/** A graph provider for one explicitly consented document and a caller supplied JSON schema. */
export function createUpstageInformationExtractRegistry(options: UpstageInformationExtractOptions = {}): GraphCapabilityRegistry {
  const endpoint = endpointFor(options);
  const timeoutMs = timeoutFor(options);
  const fetcher = options.fetcher ?? fetch;
  const lookup = options.lookupSecret ?? (async (id: string) => { selectBackendFromConfig(); return getSecretAsync(id); });
  let registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: CONTRACT,
    input: { type: 'object', required: ['documentDataUrl', 'schemaName', 'schema', 'consentToUpstage'],
      properties: { documentDataUrl: { type: 'string' }, schemaName: { type: 'string' }, schema: { type: 'object' },
        consentToUpstage: { type: 'boolean' } } },
    output: { type: 'object' },
  });
  registry = registerGraphCapabilityProviderDeclaration(registry, {
    id: 'upstage-information-extract', provides: [CONTRACT], tier: 'byok', secretRefs: [SECRET_REF],
    invoke: async (context) => {
      const input = (context.nodeInput ?? context.input) as Record<string, unknown>;
      if (input.consentToUpstage !== true) return { ok: false, outcome: 'failed', error: 'consent_required' };
      const { documentDataUrl, schemaName, schema } = input;
      if (!validDocumentDataUrl(documentDataUrl)) return { ok: false, outcome: 'failed', error: 'invalid_document' };
      if (typeof schemaName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(schemaName) || !supportedSchema(schema))
        return { ok: false, outcome: 'failed', error: 'unsupported_schema' };
      const deadline = new AbortController();
      const signal = context.signal ? AbortSignal.any([deadline.signal, context.signal]) : deadline.signal;
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      let rejectAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new Error('operation_aborted'));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener('abort', rejectAbort, { once: true });
      });
      try {
        return await Promise.race([aborted, (async () => {
        const key = (await lookup(SECRET_REF))?.trim();
        if (signal.aborted) throw new Error('operation_aborted');
        if (!key?.trim()) return { ok: false, outcome: 'failed', error: 'upstage_key_required' };
        const response = await fetcher(endpoint, { method: 'POST', redirect: 'error',
          signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'information-extract', messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: documentDataUrl } },
          ] }], response_format: { type: 'json_schema', json_schema: { name: schemaName, schema } } }),
        });
        if (!response.ok) return { ok: false, outcome: 'failed', error: 'upstage_http_error',
          evidence: { status: response.status } };
        const body = await boundedResponseJson(response, signal);
        const choices = record(body) && body.choices;
        const message = Array.isArray(choices) && record(choices[0]) && choices[0].message;
        const content = record(message) && message.content;
        if (typeof content !== 'string') return { ok: false, outcome: 'failed', error: 'invalid_response' };
        let extracted: unknown;
        try { extracted = JSON.parse(content); }
        catch { return { ok: false, outcome: 'failed', error: 'invalid_json' }; }
        if (!matches(schema, extracted)) return { ok: false, outcome: 'failed', error: 'schema_mismatch' };
        if (containsSecret(extracted, key)) return { ok: false, outcome: 'failed', error: 'secret_echo_refused' };
        return { ok: true, outcome: 'ok', result: extracted, evidence: { source: 'upstage-information-extract' } };
        })()]);
      } catch (error) {
        return { ok: false, outcome: 'failed', error: signal.aborted ? 'operation_aborted'
          : error instanceof Error && error.message === 'response_too_large' ? 'response_too_large' : 'upstage_request_failed' };
      } finally {
        clearTimeout(timer);
        if (rejectAbort) signal.removeEventListener('abort', rejectAbort);
      }
    },
  });
  return registry;
}
