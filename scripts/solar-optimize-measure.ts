/** Same-head Solar Pro 4 A/B. Run with --simulate on test hosts; the credential owner runs --live. */
import { getUserConfig } from '../src/user-config.js';
import { getProviderForConfig, type LLMStreamEvent } from '../src/llm.js';
import { resolveChatSystemPrompt } from '../src/prompt-library/registry.js';
import { isSolarPro4Model } from '../src/prompt-library/providers/solar.js';
import { GPT_CHAT_VARIANT } from '../src/prompt-library/providers/gpt.js';
import { SOLAR_CHAT_VARIANT } from '../src/prompt-library/providers/solar.js';

const model = 'openrouter/upstage/solar-pro4';
const live = process.argv.includes('--live');

type Case = 'korean' | 'json' | 'tool';
type Arm = 'baseline' | 'optimized';
type Row = { arm: Arm; case: Case; success: boolean; latencyMs: number | null; costUsd: number | null; inputTokens: number | null; outputTokens: number | null; error?: string };
const cases: Case[] = ['korean', 'json', 'tool'];
const originalFetch = globalThis.fetch;
const jsonSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const toolSchema = { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false };
const jsonFormat = { type: 'json_schema' as const, json_schema: { name: 'result', strict: true as const, schema: jsonSchema } };
const lookupTool = { name: 'lookup', description: 'Look up a fact', parameters: toolSchema };

function same(value: unknown, expected: unknown): boolean { return JSON.stringify(value) === JSON.stringify(expected); }

/** Validate the exact response contract rather than one favorable field. */
export function validateSolarMeasureResult(kind: Case, events: LLMStreamEvent[]): boolean {
  const toolCalls = events.filter((event): event is Extract<LLMStreamEvent, { type: 'tool_call' }> => event.type === 'tool_call');
  const answer = events.filter((event): event is Extract<LLMStreamEvent, { type: 'text' }> => event.type === 'text').map((event) => event.delta).join('');
  if (kind === 'tool') return toolCalls.length === 1 && toolCalls[0]!.name === 'lookup' && same(toolCalls[0]!.args, { key: 'solar' }) && answer.trim() === '';
  if (toolCalls.length > 0) return false;
  if (kind === 'json') {
    try { return same(JSON.parse(answer), { ok: true }); } catch { return false; }
  }
  return /^안녕하세요[.!。！]*$/u.test(answer.trim());
}

/** The fake endpoint must prove the actual provider wire differs as intended. */
export function solarMeasureWireViolations(body: Record<string, unknown>, arm: Arm, kind: Case): string[] {
  const violations: string[] = [];
  const messages = body.messages as Array<{ role?: string; content?: string }> | undefined;
  const expectedPrompt = arm === 'optimized' ? SOLAR_CHAT_VARIANT : GPT_CHAT_VARIANT;
  const expectedRequest = kind === 'json' ? '[json] Return {"ok":true}.' : kind === 'tool' ? '[tool] Call lookup with key solar.' : '한국어로 안녕하세요라고 답하세요.';
  if (body.model !== 'upstage/solar-pro4') violations.push('model');
  if (!same(messages, [{ role: 'system', content: expectedPrompt }, { role: 'user', content: expectedRequest }])) violations.push('messages/prompt');
  if (arm === 'optimized' ? body.max_tokens !== 256 : 'max_tokens' in body || 'max_completion_tokens' in body) violations.push('budget');
  const provider = body.provider as { require_parameters?: unknown } | undefined;
  if (provider?.require_parameters !== true) violations.push('provider.require_parameters');
  if (kind === 'json' ? !same(body.response_format, jsonFormat) : 'response_format' in body) violations.push('response_format');
  const expectedTools = kind === 'tool' ? [{ type: 'function', function: lookupTool }] : undefined;
  if (kind === 'tool' ? !same(body.tools, expectedTools) : 'tools' in body) violations.push('tools');
  return violations;
}

function fakeResponse(body: Record<string, unknown>): Response {
  const message = (body.messages as Array<{ content?: string }>).at(-1)?.content ?? '';
  const kind: Case = message.includes('[json]') ? 'json' : message.includes('[tool]') ? 'tool' : 'korean';
  const delta = kind === 'tool'
    ? { tool_calls: [{ index: 0, id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"key":"solar"}' } }] }
    : { content: kind === 'json' ? '{"ok":true}' : '안녕하세요' };
  const sse = `data: ${JSON.stringify({ choices: [{ delta, ...(kind === 'tool' ? { finish_reason: 'tool_calls' } : {}) }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`;
  return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function installFakeFetch(captures: Record<string, unknown>[]): void {
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    captures.push(body);
    return fakeResponse(body);
  }) as unknown as typeof fetch;
}

async function run(arm: Arm, kind: Case, captures: Record<string, unknown>[]): Promise<Row> {
  process.env.ELANOUS_SOLAR_OPTIMIZE = arm === 'optimized' ? '1' : '0';
  const prompt = resolveChatSystemPrompt({ model, config: { taskVariant: 'default' } });
  const cfg = getUserConfig();
  const provider = getProviderForConfig({ ...cfg, llm: { ...cfg.llm, provider: 'openrouter', model, apiKey: live ? undefined : 'simulation-only' } } as never);
  const request = kind === 'json' ? '[json] Return {"ok":true}.' : kind === 'tool' ? '[tool] Call lookup with key solar.' : '한국어로 안녕하세요라고 답하세요.';
  const opts = kind === 'json' ? {
    // Source: benchmark contract fixture; this is a caller budget, not a model default.
    maxTokens: 256,
    responseFormat: jsonFormat,
  } : kind === 'tool' ? {
    // Source: benchmark contract fixture; the caller supplies the same budget to both arms.
    maxTokens: 256,
    tools: [lookupTool],
  } : { maxTokens: 256 };
  const started = performance.now();
  const events: LLMStreamEvent[] = [];
  try {
    for await (const event of provider.streamChat!([
      { role: 'system', content: prompt.text },
      { role: 'user', content: request },
    ], opts)) events.push(event);
    const usage = events.filter((event): event is Extract<LLMStreamEvent, { type: 'usage' }> => event.type === 'usage').at(-1)?.usage;
    return { arm, case: kind, success: validateSolarMeasureResult(kind, events), latencyMs: live ? Math.round(performance.now() - started) : null, costUsd: live ? usage?.reportedCostUsd ?? null : null, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null };
  } catch (error) {
    return { arm, case: kind, success: false, latencyMs: live ? Math.round(performance.now() - started) : null, costUsd: null, inputTokens: null, outputTokens: null, error: String(error) };
  }
}

async function main(): Promise<void> {
  if (!live && !process.argv.includes('--simulate')) throw new Error('Pass --simulate or --live');
  if (!isSolarPro4Model(model)) throw new Error('Solar model matcher failed');
  const captures: Record<string, unknown>[] = [];
  if (!live) installFakeFetch(captures);
  try {
  const rows: Row[] = [];
  for (const kind of cases) for (const arm of ['baseline', 'optimized'] as const) rows.push(await run(arm, kind, captures));
  if (!live) {
    const expected = cases.flatMap((kind) => (['baseline', 'optimized'] as const).map((arm) => ({ kind, arm })));
    if (captures.length !== expected.length) throw new Error(`simulation captured ${captures.length} requests; expected ${expected.length}`);
    for (const [index, item] of expected.entries()) {
      const violations = solarMeasureWireViolations(captures[index]!, item.arm, item.kind);
      if (violations.length > 0) throw new Error(`simulation ${item.arm}/${item.kind} wire mismatch: ${violations.join(', ')}`);
    }
  }
  const summary = (['baseline', 'optimized'] as const).map((arm) => {
    const selected = rows.filter((row) => row.arm === arm);
    const costs = selected.map((row) => row.costUsd);
    return { arm, successes: selected.filter((row) => row.success).length, attempts: selected.length,
      medianLatencyMs: live ? selected.map((row) => row.latencyMs as number).sort((a, b) => a - b)[Math.floor(selected.length / 2)] : null,
      costUsd: costs.every((cost): cost is number => cost !== null) ? (costs as number[]).reduce((a, b) => a + b, 0) : null };
  });
  console.log(JSON.stringify({ mode: live ? 'live' : 'simulated', model, head: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(), summary, rows,
    ...(live ? {} : { wire: captures.map((body, index) => ({ arm: index % 2 ? 'optimized' : 'baseline', case: cases[Math.floor(index / 2)], maxTokens: body.max_tokens ?? null, requireParameters: (body.provider as { require_parameters?: boolean } | undefined)?.require_parameters ?? null })) }) }, null, 2));
  if (rows.some((row) => !row.success)) process.exitCode = 1;
  } finally {
  globalThis.fetch = originalFetch;
  delete process.env.ELANOUS_SOLAR_OPTIMIZE;
  }
}
if (import.meta.main) await main();
