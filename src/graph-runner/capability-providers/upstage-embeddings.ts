import {
  emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityProvider, type GraphCapabilityRegistry,
} from '../capabilities.js';
import { getSecretAsync, selectBackendFromConfig } from '../../nexus/config/secrets/index.js';

// Source: OP #35843 / MK UPSTAGE-PLUGIN-INVENTORY.md P4, SHA aeae762d.
export const UPSTAGE_EMBEDDING_DIMENSIONS = 1024;
const MAX_EMBEDDING_INPUTS = 100;
export const UPSTAGE_EMBEDDING_MODELS = {
  query: 'solar-embedding-2-query', passage: 'solar-embedding-2-passage',
} as const;
type Purpose = keyof typeof UPSTAGE_EMBEDDING_MODELS;

export interface UpstageEmbeddingRequest {
  model: typeof UPSTAGE_EMBEDDING_MODELS[Purpose];
  input: string[];
  encoding_format: 'float';
}

/** P4 transport consumes U-0's shared credential and fake-server contract. */
export type UpstageEmbeddingTransport = (request: UpstageEmbeddingRequest, signal?: AbortSignal) => Promise<unknown>;

export interface UpstageEmbeddingTransportOptions {
  keyLookup?: (slot: string) => Promise<string | undefined>;
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

// Source: U-0 src/ocr/upstage.ts request budget; this ceiling also includes lookup and body reading.
const REQUEST_TIMEOUT_MS = 5 * 60_000;
// Source: inventory P4 permits 100 * 1024 numbers; 32 JSON bytes per number plus envelope fits this cap.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const KEY_SLOT = 'cred:upstage.api_key';

function embeddingEndpoint(env: Readonly<Record<string, string | undefined>>): string {
  if (env.NODE_ENV !== 'test' || !env.UPSTAGE_BASE_URL) return 'https://api.upstage.ai/v1/embeddings';
  const url = new URL(env.UPSTAGE_BASE_URL);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/v1') {
    throw new Error('Upstage test endpoint must be a loopback /v1 URL.');
  }
  return `${url.origin}/v1/embeddings`;
}

async function boundedJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (length > limit || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Upstage embedding response unavailable or too large.');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error('Upstage embedding response too large.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** Uses U-0's single slot and test URL contract; never writes keys or probes cache/shell sources. */
export function createUpstageEmbeddingTransport(options: UpstageEmbeddingTransportOptions = {}): UpstageEmbeddingTransport {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const limit = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > REQUEST_TIMEOUT_MS ||
    !Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RESPONSE_BYTES) throw new Error('Invalid embedding request budget.');
  const lookup = options.keyLookup ?? (async (slot: string) => { selectBackendFromConfig(); return getSecretAsync(slot); });
  return async (request, signal) => {
    const controller = new AbortController();
    let rejectAbort!: (reason: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = () => { controller.abort(); rejectAbort(new Error('Upstage embedding request cancelled or timed out.')); };
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const work = async () => {
        controller.signal.throwIfAborted();
        const env = options.env ?? process.env;
        const endpoint = embeddingEndpoint(env);
        let stored: string | undefined;
        try { stored = await lookup(KEY_SLOT); } catch { /* Read-only env compatibility follows a missing slot. */ }
        controller.signal.throwIfAborted();
        const key = stored?.trim() || env.UPSTAGE_API_KEY?.trim();
        if (!key) throw new Error('Upstage key required; run eln secret slot setup upstage.');
        const response = await (options.fetchImpl ?? fetch)(endpoint, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
        controller.signal.throwIfAborted();
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new Error('Upstage embedding HTTP request failed.');
        }
        return boundedJson(response, limit, controller.signal);
      };
      return await Promise.race([work(), aborted]);
    } catch {
      throw new Error('Upstage embeddings request failed; check eln secret slot setup upstage.');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseInput(raw: unknown): { request: UpstageEmbeddingRequest; purpose: Purpose } | { error: string } {
  if (!record(raw)) return { error: 'Upstage embeddings input must be an object.' };
  // graph-v2 injects type/context metadata; it is never included in the HTTP request.
  if (Object.keys(raw).some(key => !['input', 'purpose', 'model', 'consent', 'context', 'type'].includes(key))) {
    return { error: 'Only input, purpose, model and consent are accepted. Configure the shared credential with eln secret slot setup upstage.' };
  }
  if (raw.model === 'embedding-query' || raw.model === 'embedding-passage') {
    const replacement = raw.model === 'embedding-query' ? UPSTAGE_EMBEDDING_MODELS.query : UPSTAGE_EMBEDDING_MODELS.passage;
    return { error: `Unsupported legacy embedding model; use ${replacement}.` };
  }
  const purpose = raw.purpose ?? (raw.model === UPSTAGE_EMBEDDING_MODELS.passage ? 'passage' : 'query');
  if (purpose !== 'query' && purpose !== 'passage') return { error: 'Embedding purpose must be query or passage.' };
  const model = UPSTAGE_EMBEDDING_MODELS[purpose];
  if (raw.model !== undefined && raw.model !== model) return { error: `Use ${model} for the requested embedding purpose.` };
  const input = typeof raw.input === 'string' ? [raw.input] : raw.input;
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_EMBEDDING_INPUTS ||
    !input.every((text): text is string => typeof text === 'string' && text.trim().length > 0)) {
    return { error: 'Provide a nonempty text or a supported batch of nonempty texts.' };
  }
  if (raw.consent !== true) return { error: '이 텍스트를 Upstage로 보내 처리합니다. 동의한 경우 consent: true를 지정하세요.' };
  return { request: { model, input: [...input], encoding_format: 'float' }, purpose };
}

function embeddingsFromResponse(raw: unknown, request: UpstageEmbeddingRequest): number[][] | undefined {
  if (!record(raw) || (raw.model !== undefined && raw.model !== request.model) ||
    !Array.isArray(raw.data) || raw.data.length !== request.input.length) return;
  const vectors: number[][] = [];
  const indexes = new Set<number>();
  for (const row of raw.data) {
    if (!record(row) || typeof row.index !== 'number' || !Number.isInteger(row.index) ||
      row.index < 0 || row.index >= request.input.length || indexes.has(row.index) ||
      !Array.isArray(row.embedding) || row.embedding.length !== UPSTAGE_EMBEDDING_DIMENSIONS ||
      !row.embedding.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) return;
    indexes.add(row.index);
    vectors[row.index] = [...row.embedding];
  }
  return vectors;
}

export function createUpstageEmbeddingsProvider(request: UpstageEmbeddingTransport = createUpstageEmbeddingTransport()): GraphCapabilityProvider {
  return async context => {
    const parsed = parseInput(context.nodeInput ?? context.input);
    if ('error' in parsed) return { ok: false, outcome: 'failed', error: parsed.error };
    if (context.signal?.aborted) return { ok: false, outcome: 'failed', error: 'Upstage embeddings request cancelled.' };
    try {
      const raw = await request(parsed.request, context.signal);
      if (context.signal?.aborted) return { ok: false, outcome: 'failed', error: 'Upstage embeddings request cancelled.' };
      const embeddings = embeddingsFromResponse(raw, parsed.request);
      if (!embeddings) return { ok: false, outcome: 'failed', error: 'Upstage embeddings returned an invalid model, index, or vector.' };
      return { ok: true, outcome: 'ok', result: {
        model: parsed.request.model, purpose: parsed.purpose, dimensions: UPSTAGE_EMBEDDING_DIMENSIONS, embeddings,
      }, evidence: { provider: 'upstage', model: parsed.request.model, purpose: parsed.purpose, count: embeddings.length } };
    } catch {
      // Provider/HTTP errors may contain credentials or document text. Never forward their raw message/body.
      return { ok: false, outcome: 'failed', error: 'Upstage embeddings request failed. Check eln secret slot setup upstage and retry.' };
    }
  };
}

export function createUpstageEmbeddingsRegistry(request: UpstageEmbeddingTransport = createUpstageEmbeddingTransport()): GraphCapabilityRegistry {
  const registry = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'upstage.embeddings@1', input: { type: 'object' },
    output: { type: 'object', required: ['model', 'purpose', 'dimensions', 'embeddings'] },
  });
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'upstage-embeddings', tier: 'byok', provides: ['upstage.embeddings@1'],
    secretRefs: ['cred:upstage.api_key'], invoke: createUpstageEmbeddingsProvider(request),
  });
}
