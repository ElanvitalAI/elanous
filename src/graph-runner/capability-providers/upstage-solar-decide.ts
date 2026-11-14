import { resolveUpstageApiKeyAsync, upstageBaseUrl } from '../../ocr/upstage.js';
import { SOLAR_DECIDE, createSolarDecideProvider, type DecideInput, type DecideWireContract, type SharedUpstageTransport } from '../../../plugins/upstage-solar-decide/plugin.js';

function abortBound<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('shared Upstage request aborted')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort(); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

async function readBoundedJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error('shared Upstage response body missing');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await abortBound(signal, () => reader.read());
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new Error('shared Upstage response exceeds caller limit');
      parts.push(part.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder().decode(body));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Thin P6 adapter over U-0's single key resolver and test-only base-URL policy. */
export function createSharedSolarDecideTransport(options: {
  readonly signal: AbortSignal;
  readonly maxResponseBytes: number;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly resolveApiKey?: typeof resolveUpstageApiKeyAsync;
}): SharedUpstageTransport {
  if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0) throw new Error('positive response-byte limit required');
  let key: string | null = null;
  return {
    universe: process.env.NODE_ENV === 'test' ? 'test' : 'production',
    async hasCredential(ref) {
      if (ref !== SOLAR_DECIDE.credentialRef) return false;
      options.signal.throwIfAborted();
      key = await abortBound(options.signal, options.resolveApiKey ?? resolveUpstageApiKeyAsync);
      return Boolean(key?.trim());
    },
    async postJson(path, body) {
      options.signal.throwIfAborted();
      if (!key || path !== SOLAR_DECIDE.path) throw new Error('shared Upstage request unavailable');
      const response = await abortBound(options.signal, () => (options.fetchImpl ?? fetch)(`${upstageBaseUrl()}/systemone`, {
        method: 'POST', redirect: 'error', signal: options.signal,
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error('shared Upstage request failed');
      }
      return readBoundedJson(response, options.maxResponseBytes, options.signal);
    },
  };
}

/** Installed PluginHost action. Wire adapters are host-owned, not arbitrary user JSON. */
export function createSolarDecideUserAction(options: { wire?: DecideWireContract } = {}) {
  return async (input: DecideInput, limits: { timeoutMs: number; maxResponseBytes: number }) => {
    if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0
      || !Number.isSafeInteger(limits.maxResponseBytes) || limits.maxResponseBytes <= 0) {
      throw new Error('explicit positive timeout and response-byte limits required');
    }
    const transport = createSharedSolarDecideTransport({
      signal: AbortSignal.timeout(limits.timeoutMs), maxResponseBytes: limits.maxResponseBytes,
    });
    return createSolarDecideProvider({ transport, wire: options.wire })(input);
  };
}
