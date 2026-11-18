// Local LLM compatibility tester.
//
// Runs a suite of probes against an OpenAI-compatible endpoint (LM
// Studio, llama.cpp server, ollama `/v1`, vLLM, etc.) and returns
// structured PASS/FAIL/SKIP per capability. Used by:
//
//   - `elanous local test` CLI subcommand (one-shot matrix print)
//   - `/local test` dashboard slash
//   - integration tests that point at a mocked fetch
//
// The probes are ordered from "must work for basic chat" (models,
// completion, streaming, system, multi-turn) to "nice-to-have for
// agentic features" (JSON mode, tool calls, vision, token usage).
// A failing early probe aborts the later ones that depend on it.
//
// No external deps — uses the global `fetch` so it works in both Bun
// and Node 18+. Streaming uses ReadableStream + TextDecoder directly
// to avoid pulling in the heavier src/llm.ts SSE parser just for a
// compat check.

import { llmNetworkFetch } from './session-runtime/llm-call-gateway.js';

export type CompatStatus = 'pass' | 'fail' | 'skip';

export interface CompatResult {
  /** Short identifier — used as the row key in the matrix output. */
  id: string;
  /** Human label shown in the matrix. */
  label: string;
  status: CompatStatus;
  /** Latency in milliseconds for the probe. 0 when skipped. */
  ms: number;
  /** Short one-line detail — the error message on fail, or a useful
   *  fact on pass (e.g. "12 tokens / 180ms"). */
  detail?: string;
  /** Raw extracted evidence — kept for the checklist so we can
   *  inspect exactly what the endpoint returned. Not printed by
   *  default. */
  raw?: unknown;
}

export interface CompatSummary {
  baseUrl: string;
  model: string;
  /** Wall-clock total of the whole probe run. */
  totalMs: number;
  results: CompatResult[];
  /** Count by status — handy for `${pass}/${total} pass` line. */
  counts: { pass: number; fail: number; skip: number };
}

export interface CompatOpts {
  /** Endpoint root, e.g. `http://192.168.0.50:1234`. The tester
   *  appends `/v1/...` itself, tolerating trailing slashes or an
   *  already-present `/v1`. */
  baseUrl: string;
  /** Model id to exercise (e.g. `mlx-community/gemma-4-26b-a4b-it`). */
  model: string;
  /** Optional bearer token. Most local servers ignore Authorization
   *  entirely, but LM Studio + vLLM can be configured to require one. */
  apiKey?: string;
  /** Cap individual HTTP call at this many ms. Default 60s — some
   *  MLX models take >30s to warm up on first prompt. */
  timeoutMs?: number;
  /** Emit each probe's result as soon as it finishes via this
   *  callback. Lets the CLI print progress without buffering the
   *  whole matrix. */
  onProgress?: (r: CompatResult) => void;
  /** Probe gate — set to false to skip this probe entirely. Helpful
   *  when an endpoint is known to not support vision, so we don't
   *  waste 30s on a doomed round-trip. Unset = run everything. */
  skip?: Partial<Record<ProbeId, boolean>>;
}

export type ProbeId =
  | 'models'
  | 'completion'
  | 'streaming'
  | 'system_prompt'
  | 'multi_turn'
  | 'json_mode'
  | 'tool_calls'
  | 'vision'
  | 'usage';

/** Resolve the endpoint root to a concrete path. Accepts:
 *    `http://host:1234`
 *    `http://host:1234/`
 *    `http://host:1234/v1`
 *    `http://host:1234/v1/`
 *    `http://host:1234/v1/chat/completions`  (trailing path ignored)
 *  Returns { base: '…/v1', chat: '…/v1/chat/completions', models: '…/v1/models' }. */
export function resolveLocalEndpoints(raw: string): {
  base: string; chat: string; models: string;
} {
  let b = raw.trim().replace(/\/+$/, '');
  // Strip /chat/completions if the user pasted the full URL
  b = b.replace(/\/chat\/completions$/, '');
  if (!/\/v\d+$/.test(b)) b = `${b}/v1`;
  return {
    base: b,
    chat: `${b}/chat/completions`,
    models: `${b}/models`,
  };
}

/** A 1x1 transparent PNG, base64-encoded. Used for the vision probe
 *  so we don't ship any real image data — some models choke on giant
 *  base64 payloads and we only care whether the multimodal wire
 *  format was accepted. */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

/** Run the full compatibility suite against the endpoint. Returns a
 *  fully populated summary — individual results include the raw body
 *  fragments so the checklist can show what actually came back. */
export async function runLocalLLMCompat(opts: CompatOpts): Promise<CompatSummary> {
  const { base, chat, models } = resolveLocalEndpoints(opts.baseUrl);
  const timeout = opts.timeoutMs ?? 60_000;
  const results: CompatResult[] = [];
  const t0 = Date.now();

  const record = (r: CompatResult): CompatResult => {
    results.push(r);
    opts.onProgress?.(r);
    return r;
  };

  const skipped = (id: ProbeId, label: string, why: string): CompatResult =>
    record({ id, label, status: 'skip', ms: 0, detail: why });

  // ── 1. GET /v1/models ───────────────────────────────────────
  const modelsRes = await probeModels(models, opts.apiKey, timeout, opts.model);
  record(modelsRes);

  // Early bailout: if the endpoint is unreachable, everything else
  // will fail with the same error. Skip the rest to save 60s.
  if (modelsRes.status === 'fail' && /ENETUNREACH|ECONNREFUSED|fetch failed|unreachable/i.test(modelsRes.detail ?? '')) {
    const unreachable = 'endpoint unreachable';
    return finalize([
      modelsRes,
      skipped('completion', 'basic completion', unreachable),
      skipped('streaming', 'SSE streaming', unreachable),
      skipped('system_prompt', 'system prompt', unreachable),
      skipped('multi_turn', 'multi-turn', unreachable),
      skipped('json_mode', 'response_format json', unreachable),
      skipped('tool_calls', 'tool calls', unreachable),
      skipped('vision', 'vision (image_url)', unreachable),
      skipped('usage', 'usage accounting', unreachable),
    ]);
  }

  // ── 2. Basic completion (non-stream) ────────────────────────
  const completion = opts.skip?.completion
    ? skipped('completion', 'basic completion', 'skipped by caller')
    : record(await probeCompletion(chat, opts.apiKey, opts.model, timeout));

  // ── 3. Streaming (SSE) ──────────────────────────────────────
  record(opts.skip?.streaming
    ? skipped('streaming', 'SSE streaming', 'skipped by caller')
    : await probeStreaming(chat, opts.apiKey, opts.model, timeout));

  // ── 4. System prompt honored ────────────────────────────────
  record(opts.skip?.system_prompt
    ? skipped('system_prompt', 'system prompt', 'skipped by caller')
    : await probeSystem(chat, opts.apiKey, opts.model, timeout));

  // ── 5. Multi-turn conversation ──────────────────────────────
  record(opts.skip?.multi_turn
    ? skipped('multi_turn', 'multi-turn', 'skipped by caller')
    : await probeMultiTurn(chat, opts.apiKey, opts.model, timeout));

  // ── 6. response_format: json_object ─────────────────────────
  record(opts.skip?.json_mode
    ? skipped('json_mode', 'response_format json', 'skipped by caller')
    : await probeJsonMode(chat, opts.apiKey, opts.model, timeout));

  // ── 7. Tool calls (function calling) ────────────────────────
  record(opts.skip?.tool_calls
    ? skipped('tool_calls', 'tool calls', 'skipped by caller')
    : await probeToolCalls(chat, opts.apiKey, opts.model, timeout));

  // ── 8. Vision (image_url multimodal) ────────────────────────
  record(opts.skip?.vision
    ? skipped('vision', 'vision (image_url)', 'skipped by caller')
    : await probeVision(chat, opts.apiKey, opts.model, timeout));

  // ── 9. Usage accounting ─────────────────────────────────────
  // Reuses the body from the completion probe so we don't pay for
  // another round-trip. When completion itself failed we mark
  // usage as skip with the completion's error.
  if (completion.status !== 'pass') {
    record(skipped('usage', 'usage accounting', 'depends on completion'));
  } else {
    const u = (completion.raw as any)?.usage;
    if (u && typeof u === 'object' && typeof u.total_tokens === 'number') {
      record({ id: 'usage', label: 'usage accounting', status: 'pass', ms: 0,
        detail: `prompt=${u.prompt_tokens ?? '?'} completion=${u.completion_tokens ?? '?'} total=${u.total_tokens}`,
        raw: u });
    } else {
      record({ id: 'usage', label: 'usage accounting', status: 'fail', ms: 0,
        detail: 'no usage field on completion response' });
    }
  }

  return finalize(results);

  function finalize(r: CompatResult[]): CompatSummary {
    const counts = { pass: 0, fail: 0, skip: 0 };
    for (const x of r) counts[x.status]++;
    return { baseUrl: base, model: opts.model, totalMs: Date.now() - t0, results: r, counts };
  }
}

// ── Probes ──────────────────────────────────────────────────

async function probeModels(
  url: string, apiKey: string | undefined, timeoutMs: number, expectedModel: string,
): Promise<CompatResult> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, {
      headers: authHeaders(apiKey),
    }, timeoutMs);
    if (!res.ok) {
      return { id: 'models', label: 'GET /v1/models', status: 'fail',
        ms: Date.now() - t0, detail: `HTTP ${res.status}` };
    }
    const body = await res.json() as { data?: Array<{ id: string }> };
    const ids = Array.isArray(body.data) ? body.data.map(m => m.id) : [];
    const found = ids.includes(expectedModel);
    return {
      id: 'models', label: 'GET /v1/models',
      status: found ? 'pass' : 'fail',
      ms: Date.now() - t0,
      detail: found
        ? `${ids.length} model(s), target present`
        : `target model not listed (found: ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', …' : ''})`,
      raw: ids,
    };
  } catch (err: any) {
    return { id: 'models', label: 'GET /v1/models', status: 'fail',
      ms: Date.now() - t0, detail: err?.message ?? String(err) };
  }
}

async function probeCompletion(
  url: string, apiKey: string | undefined, model: string, timeoutMs: number,
): Promise<CompatResult> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly the word: OK' }],
        max_tokens: 10,
        temperature: 0,
      }),
    }, timeoutMs);
    if (!res.ok) {
      const body = await res.text();
      return { id: 'completion', label: 'basic completion', status: 'fail',
        ms: Date.now() - t0, detail: `HTTP ${res.status}: ${body.slice(0, 120)}` };
    }
    const body = await res.json() as any;
    const text = body?.choices?.[0]?.message?.content ?? '';
    return {
      id: 'completion', label: 'basic completion',
      status: typeof text === 'string' && text.trim().length > 0 ? 'pass' : 'fail',
      ms: Date.now() - t0,
      detail: typeof text === 'string'
        ? `${text.trim().slice(0, 40).replace(/\s+/g, ' ')}`
        : 'no content field',
      raw: body,
    };
  } catch (err: any) {
    return { id: 'completion', label: 'basic completion', status: 'fail',
      ms: Date.now() - t0, detail: err?.message ?? String(err) };
  }
}

async function probeStreaming(
  url: string, apiKey: string | undefined, model: string, timeoutMs: number,
): Promise<CompatResult> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Count from one to three, comma separated.' }],
        max_tokens: 30,
        temperature: 0,
        stream: true,
      }),
    }, timeoutMs);
    if (!res.ok || !res.body) {
      return { id: 'streaming', label: 'SSE streaming', status: 'fail',
        ms: Date.now() - t0, detail: `HTTP ${res.status}` };
    }
    // Drain the SSE stream; accept either proper `data: …` framing
    // or concatenated JSON chunks (LM Studio has both modes).
    const chunks: string[] = [];
    let dataLines = 0;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // Strip CRs so we split cleanly on \n\n (SSE record separator).
      const records = buf.split(/\r?\n\r?\n/);
      buf = records.pop() ?? '';
      for (const rec of records) {
        for (const line of rec.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          dataLines++;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') chunks.push(delta);
          } catch { /* tolerate */ }
        }
      }
      if (chunks.length >= 3) break;  // seen enough to call it streaming
    }
    const text = chunks.join('');
    const ok = dataLines >= 2 && text.trim().length > 0;
    return {
      id: 'streaming', label: 'SSE streaming',
      status: ok ? 'pass' : 'fail',
      ms: Date.now() - t0,
      detail: ok
        ? `${dataLines} event(s), text="${text.trim().slice(0, 40)}"`
        : `insufficient stream (${dataLines} events, ${chunks.length} deltas)`,
    };
  } catch (err: any) {
    return { id: 'streaming', label: 'SSE streaming', status: 'fail',
      ms: Date.now() - t0, detail: err?.message ?? String(err) };
  }
}

async function probeSystem(
  url: string, apiKey: string | undefined, model: string, timeoutMs: number,
): Promise<CompatResult> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a parrot. You must echo back the user\'s exact text verbatim, no punctuation, no extras.' },
          { role: 'user', content: 'PINEAPPLE' },
        ],
        max_tokens: 20,
        temperature: 0,
      }),
    }, timeoutMs);
    if (!res.ok) {
      return { id: 'system_prompt', label: 'system prompt', status: 'fail',
        ms: Date.now() - t0, detail: `HTTP ${res.status}` };
    }
    const body = await res.json() as any;
    const text = String(body?.choices?.[0]?.message?.content ?? '').toUpperCase();
    const ok = text.includes('PINEAPPLE');
    return {
      id: 'system_prompt', label: 'system prompt',
      status: ok ? 'pass' : 'fail',
      ms: Date.now() - t0,
      detail: ok ? 'system instruction honored' : `got: "${text.slice(0, 40)}"`,
    };
  } catch (err: any) {
    return { id: 'system_prompt', label: 'system prompt', status: 'fail',
      ms: Date.now() - t0, detail: err?.message ?? String(err) };
  }
}

async function probeMultiTurn(
  url: string, apiKey: string | undefined, model: string, timeoutMs: number,
): Promise<CompatResult> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'user', content: 'My favorite number is 42.' },
          { role: 'assistant', content: 'Got it — I\'ll remember 42.' },
          { role: 'user', content: 'What\'s my favorite number? Answer with only the digits.' },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
    }, timeoutMs);
    if (!res.ok) {
      return { id: 'multi_turn', label: 'multi-turn', status: 'fail',
        ms: Date.now() - t0, detail: `HTTP ${res.status}` };
    }
    const body = await res.json() as any;
    const text = String(body?.choices?.[0]?.message?.content ?? '');
    const ok = /\b42\b/.test(text);
    return {
      id: 'multi_turn', label: 'multi-turn',
      status: ok ? 'pass' : 'fail',
      ms: Date.now() - t0,
      detail: ok ? 'recalled prior turn' : `got: "${text.slice(0, 40)}"`,
    };
  } catch (err: any) {
    return { id: 'multi_turn', label: 'multi-turn', status: 'fail',
      ms: Date.now() - t0, detail: err?.message ?? String(err) };
  }
}

async function probeJsonMode(
  url: string, apiKey: string | undefined, model: string, timeoutMs: number,
): Promise<CompatResult> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'user', content: 'Return a JSON object with keys "a" (value 1) and "b" (value 2). No other text.' },
        ],
        max_tokens: 40,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    }, timeoutMs);
    if (!res.ok) {
      const body = await res.text();
      // Servers that don't support response_format often 400 here —
      // treat that as a SKIP rather than FAIL since the feature is
      // optional for most elanous flows.
      if (res.status === 400 || res.status === 422) {
        return { id: 'json_mode', label: 'response_format json', status: 'skip',
          ms: Date.now() - t0, detail: `rejected (HTTP ${res.status})` };
      }
      return { id: 'json_mode', label: 'response_format json', status: 'fail',
        ms: Date.now() - t0, detail: `HTTP ${res.status}: ${body.slice(0, 80)}` };
    }
    const body = await res.json() as any;
    const text = String(body?.choices?.[0]?.message?.content ?? '').trim();
    try {
      const parsed = JSON.parse(text);
      const ok = parsed && typeof parsed === 'object' && parsed.a === 1 && parsed.b === 2;
      return {
        id: 'json_mode', label: 'response_format json',
        status: ok ? 'pass' : 'fail',
        ms: Date.now() - t0,
        detail: ok ? 'valid JSON + correct keys' : `got keys: ${Object.keys(parsed ?? {}).join(',')}`,
      };
    } catch {
      return { id: 'json_mode', label: 'response_format json', status: 'fail',
        ms: Date.now() - t0, detail: `non-JSON output: "${text.slice(0, 40)}"` };
    }
  } catch (err: any) {
    return { id: 'json_mode', label: 'response_format json', status: 'fail',
      ms: Date.now() - t0, detail: err?.message ?? String(err) };
  }
}

async function probeToolCalls(
  url: string, apiKey: string | undefined, model: string, timeoutMs: number,
): Promise<CompatResult> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'user', content: 'What is the weather in Seoul right now? Use the get_weather tool.' },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Fetch current weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string', description: 'City name' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: 'auto',
        max_tokens: 100,
        temperature: 0,
      }),
    }, timeoutMs);
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 400 || res.status === 422) {
        return { id: 'tool_calls', label: 'tool calls', status: 'skip',
          ms: Date.now() - t0, detail: `rejected (HTTP ${res.status})` };
      }
      return { id: 'tool_calls', label: 'tool calls', status: 'fail',
        ms: Date.now() - t0, detail: `HTTP ${res.status}: ${body.slice(0, 80)}` };
    }
    const body = await res.json() as any;
    const msg = body?.choices?.[0]?.message;
    const calls = msg?.tool_calls;
    if (Array.isArray(calls) && calls.length > 0) {
      const fn = calls[0]?.function;
      return {
        id: 'tool_calls', label: 'tool calls', status: 'pass',
        ms: Date.now() - t0,
        detail: `${fn?.name}(${String(fn?.arguments ?? '').slice(0, 40)})`,
        raw: calls,
      };
    }
    // Fallback: model may emit a textual JSON tool call. That's
    // non-native but still signals some awareness — mark skip with
    // the evidence so the checklist reflects it.
    return {
      id: 'tool_calls', label: 'tool calls', status: 'fail',
      ms: Date.now() - t0,
      detail: `no tool_calls; content="${String(msg?.content ?? '').slice(0, 50)}"`,
    };
  } catch (err: any) {
    return { id: 'tool_calls', label: 'tool calls', status: 'fail',
      ms: Date.now() - t0, detail: err?.message ?? String(err) };
  }
}

async function probeVision(
  url: string, apiKey: string | undefined, model: string, timeoutMs: number,
): Promise<CompatResult> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Is this an image? Answer yes or no.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } },
          ],
        }],
        max_tokens: 10,
        temperature: 0,
      }),
    }, timeoutMs);
    if (!res.ok) {
      const body = await res.text();
      // 400/422 on vision = model doesn't support multimodal. That's
      // expected for most text-only models — record as SKIP.
      if (res.status === 400 || res.status === 422) {
        return { id: 'vision', label: 'vision (image_url)', status: 'skip',
          ms: Date.now() - t0, detail: `model rejected image (HTTP ${res.status})` };
      }
      return { id: 'vision', label: 'vision (image_url)', status: 'fail',
        ms: Date.now() - t0, detail: `HTTP ${res.status}: ${body.slice(0, 80)}` };
    }
    const body = await res.json() as any;
    const text = String(body?.choices?.[0]?.message?.content ?? '');
    return {
      id: 'vision', label: 'vision (image_url)',
      status: text.length > 0 ? 'pass' : 'fail',
      ms: Date.now() - t0,
      detail: text.length > 0 ? `replied: "${text.slice(0, 40)}"` : 'empty content',
    };
  } catch (err: any) {
    return { id: 'vision', label: 'vision (image_url)', status: 'fail',
      ms: Date.now() - t0, detail: err?.message ?? String(err) };
  }
}

// ── Helpers ─────────────────────────────────────────────────

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function fetchWithTimeout(
  url: string, init: RequestInit, timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const request = { ...init, signal: ac.signal };
    if (init.method !== 'POST') return await fetch(url, request); // model discovery is not inference
    let model: string | undefined;
    try { model = (JSON.parse(String(init.body)) as { model?: string }).model; } catch { /* preserve malformed request behavior */ }
    return await llmNetworkFetch(url, request,
      { provider: 'local', model, role: 'aux', requestedBy: 'local-llm-compat', selectionSource: 'explicit' });
  } finally {
    clearTimeout(timer);
  }
}

// ── Presentation helpers ────────────────────────────────────

/** Render the matrix as plain text — used by the CLI + checklist.
 *  No ANSI (that's left to the caller so it works unchanged in a log
 *  file or a terminal).  Each row: `PASS  label                    detail`. */
export function renderCompatMatrix(summary: CompatSummary): string {
  const lines: string[] = [];
  lines.push(`Local LLM compatibility`);
  lines.push(`  endpoint : ${summary.baseUrl}`);
  lines.push(`  model    : ${summary.model}`);
  lines.push(`  elapsed  : ${summary.totalMs}ms`);
  lines.push('');
  const labelW = Math.max(20, ...summary.results.map(r => r.label.length));
  for (const r of summary.results) {
    const status = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
    const ms = r.ms > 0 ? `${r.ms}ms`.padStart(7) : '       ';
    lines.push(`  ${status}  ${r.label.padEnd(labelW)}  ${ms}  ${r.detail ?? ''}`);
  }
  lines.push('');
  const { pass, fail, skip } = summary.counts;
  lines.push(`  total: ${summary.results.length}   pass=${pass}  fail=${fail}  skip=${skip}`);
  return lines.join('\n');
}
