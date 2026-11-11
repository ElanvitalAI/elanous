import type { LLMMessage, LLMOpts, LLMStreamEvent } from '../../llm.js';
import type { LLMUsage } from '../../prompt-cache/types.js';
import { estimateLlmCost } from '../../budget/llm-cost.js';
import { jsonResponse } from './json-response.js';

export const HQ_LLM_PROXY_PATH = '/v1/llm/proxy';
const PURPOSES = new Set(['review', 'implement', 'research', 'plan', 'summarize']);
const windows = new Map<string, number[]>();
const MAX_REQUEST_BYTES = 1_000_000;

export interface HqLlmResult { events: LLMStreamEvent[] | AsyncIterable<LLMStreamEvent>; usage: LLMUsage; billing?: 'subscription' | 'api' }
export interface HqLlmProxyDeps {
  authorize(request: Request): boolean;
  machine(request: Request): string | undefined;
  tailnet(request: Request): boolean;
  run(messages: LLMMessage[], opts: LLMOpts): Promise<HqLlmResult>;
  record(event: { event: 'llm-proxy-call'; at: string; host: string; seat: string; purpose: string; pr?: number; model: string; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; costBasis: 'subscription' | 'reported' | 'estimate' | 'unknown'; status: 'ok' | 'error' }): void;
  rateLimit?(machine: string): boolean;
}

export function allowHqLlmProxyCall(machine: string, now = Date.now()): boolean {
  const recent = (windows.get(machine) ?? []).filter(at => now - at < 60_000 && now >= at);
  if (recent.length >= 10) return false;
  recent.push(now);
  windows.set(machine, recent);
  return true;
}

async function readBoundedBody(request: Request): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export async function handleHqLlmProxy(request: Request, deps: HqLlmProxyDeps): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);
  if (!deps.tailnet(request)) return jsonResponse({ error: 'tailnet-required' }, 403);
  if (!deps.authorize(request)) return jsonResponse({ error: 'unauthorized' }, 401);
  const host = deps.machine(request);
  if (!host) return jsonResponse({ error: 'machine-token-required' }, 401);
  if (!(deps.rateLimit ?? allowHqLlmProxyCall)(host)) return jsonResponse({ error: 'rate-limited' }, 429);
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) return jsonResponse({ error: 'request-too-large' }, 413);
  let body: Record<string, unknown>;
  try {
    const raw = await readBoundedBody(request);
    if (raw === null) return jsonResponse({ error: 'request-too-large' }, 413);
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  const seat = body?.seat;
  const purpose = body?.purpose;
  const pr = body?.pr;
  const messages = body?.messages;
  const model = body?.model;
  const options = body?.options;
  if (typeof seat !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(seat)
    || !Array.isArray(messages) || messages.length === 0 || messages.length > 100
    || !messages.every(message => message && typeof message === 'object' && !Array.isArray(message)
      && ['system', 'developer', 'user', 'assistant', 'tool'].includes((message as { role?: string }).role ?? ''))
    || (pr !== undefined && (!Number.isSafeInteger(pr) || Number(pr) < 1))
    || (model !== undefined && (typeof model !== 'string' || model.length > 100))
    || (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)))) return jsonResponse({ error: 'invalid-request' }, 400);
  if (typeof purpose !== 'string' || !PURPOSES.has(purpose)) return jsonResponse({ error: 'purpose-denied' }, 403);
  const recordBase = { event: 'llm-proxy-call' as const, at: new Date().toISOString(), host, seat, purpose,
    ...(pr === undefined ? {} : { pr: pr as number }), model: typeof model === 'string' ? model : 'gpt-6.1-terra' };
  const upstreamAbort = new AbortController();
  const onRequestAbort = () => upstreamAbort.abort();
  request.signal.addEventListener('abort', onRequestAbort, { once: true });
  if (request.signal.aborted) upstreamAbort.abort();
  try {
    const wire = options as Record<string, unknown> | undefined;
    const llmOptions: LLMOpts = { ...(typeof model === 'string' ? { model } : {}), signal: upstreamAbort.signal };
    if (wire) {
      if (wire.tools !== undefined) {
        if (!Array.isArray(wire.tools) || wire.tools.length > 100) {
          request.signal.removeEventListener('abort', onRequestAbort);
          return jsonResponse({ error: 'invalid-tools' }, 400);
        }
        llmOptions.tools = wire.tools as LLMOpts['tools'];
      }
      if (typeof wire.maxTokens === 'number' && Number.isSafeInteger(wire.maxTokens) && wire.maxTokens > 0 && wire.maxTokens <= 100_000) llmOptions.maxTokens = wire.maxTokens;
      if (typeof wire.temperature === 'number' && wire.temperature >= 0 && wire.temperature <= 2) llmOptions.temperature = wire.temperature;
      if (typeof wire.reasoningEffort === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(wire.reasoningEffort)) llmOptions.reasoningEffort = wire.reasoningEffort as LLMOpts['reasoningEffort'];
      if (typeof wire.sessionId === 'string' && wire.sessionId.length <= 128) llmOptions.sessionId = wire.sessionId;
      if (wire.toolChoice === 'auto' || wire.toolChoice === 'required' || wire.toolChoice === 'none') llmOptions.toolChoice = wire.toolChoice;
    }
    const result = await deps.run(messages as LLMMessage[], llmOptions);
    let recorded = false;
    const recordSuccess = () => {
      if (recorded) return;
      recorded = true;
      const estimate = estimateLlmCost({ model: recordBase.model, ...result.usage });
      const reported = result.usage.reportedCostUsd ?? result.usage.upstreamCostUsd;
      const costUsd = result.billing === 'subscription' ? 0
        : reported ?? (estimate.kind === 'known' ? estimate.usd : null);
      const costBasis = result.billing === 'subscription' ? 'subscription' as const
        : reported !== undefined ? 'reported' as const : estimate.kind === 'known' ? 'estimate' as const : 'unknown' as const;
      deps.record({ ...recordBase, inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null, costUsd, costBasis, status: 'ok' });
    };
    if (Array.isArray(result.events)) {
      request.signal.removeEventListener('abort', onRequestAbort);
      recordSuccess();
      const response = jsonResponse({ events: result.events, usage: result.usage }); response.headers.set('cache-control', 'no-store'); return response;
    }
    const encoder = new TextEncoder();
    let cancelled = false;
    const recordError = () => {
      if (recorded) return;
      recorded = true;
      try { deps.record({ ...recordBase, inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null, costUsd: null, costBasis: 'unknown', status: 'error' }); } catch { /* closed ledger */ }
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of result.events) {
            if (upstreamAbort.signal.aborted) throw new Error('client-aborted');
            controller.enqueue(encoder.encode(`${JSON.stringify({ event })}\n`));
          }
          if (upstreamAbort.signal.aborted) throw new Error('client-aborted');
          recordSuccess();
          controller.enqueue(encoder.encode(`${JSON.stringify({ usage: result.usage })}\n`));
        } catch {
          recordError();
          if (!cancelled && !upstreamAbort.signal.aborted) controller.enqueue(encoder.encode('{"error":"upstream-unavailable"}\n'));
        } finally {
          request.signal.removeEventListener('abort', onRequestAbort);
          if (!cancelled) controller.close();
        }
      },
      cancel() { cancelled = true; upstreamAbort.abort(); recordError(); request.signal.removeEventListener('abort', onRequestAbort); },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
  } catch {
    request.signal.removeEventListener('abort', onRequestAbort);
    deps.record({ ...recordBase, inputTokens: null, outputTokens: null, costUsd: null, costBasis: 'unknown', status: 'error' });
    return jsonResponse({ error: 'upstream-unavailable' }, 502);
  }
}
