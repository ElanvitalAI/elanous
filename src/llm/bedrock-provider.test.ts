// BEDROCK-MODELS-ALL — 공급자 본체: mantle-openai 경로(비-Anthropic) ⊕ Anthropic·runtime 경로 보존.
// ⛔ 실 AWS 호출 0 · 자격 값은 가짜다.
import { describe, expect, test } from 'bun:test';
import type { UserConfig } from '../user-config.js';
import type { LLMStreamEvent, LLMToolSpec } from '../llm.js';
import { makeBedrockProvider } from './bedrock-provider.js';
import { encodeEventStreamFrame } from './bedrock-eventstream.js';

const FAKE = { accessKeyId: 'AKIDFAKEFAKEFAKE', secretAccessKey: 'fake-secret-not-real' };
const ENV = { AWS_REGION: 'ap-northeast-2', AWS_ACCESS_KEY_ID: 'AKIDFAKE', AWS_SECRET_ACCESS_KEY: 'fake' };
const tools: LLMToolSpec[] = [{ name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

const MESSAGES = [
  { role: 'system' as const, content: 'You are a coding agent.' },
  { role: 'user' as const, content: 'read a.ts' },
];

function openaiSse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

const OPENAI_CHUNKS = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'O' } }] },
  { choices: [{ index: 0, delta: { content: 'K' } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 } },
];

const ANTHROPIC_EVENTS = [
  { type: 'message_start', message: { usage: { input_tokens: 16, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', usage: { output_tokens: 3 } },
  { type: 'message_stop' },
];
const anthropicSse = ANTHROPIC_EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

async function capture(model: string, response: () => Response) {
  const sent: { url: string; init: RequestInit }[] = [];
  let service: string | undefined;
  const p = makeBedrockProvider({ provider: 'bedrock', model } as UserConfig['llm'], {
    env: ENV,
    resolveCredentials: async () => FAKE,
    sign: async (input) => { service = input.service; return { ...input.headers, authorization: 'AWS4-HMAC-SHA256 Credential=fake' }; },
    send: async (url, init) => { sent.push({ url, init }); return response(); },
  });
  const events: LLMStreamEvent[] = [];
  for await (const ev of p.streamChat!(MESSAGES, { tools, maxTokens: 64 })) events.push(ev);
  return { sent, service, events, body: JSON.parse(String(sent[0]?.init.body ?? '{}')) };
}

describe('mantle-openai route (non-Anthropic models)', () => {
  test('bedrock/zai.glm-5 → /v1/chat/completions on the us-east-1 mantle host (user region ap-northeast-2 ignored)', async () => {
    const { sent, body } = await capture('bedrock/zai.glm-5', () => new Response(openaiSse(OPENAI_CHUNKS), { status: 200 }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions');
    expect(sent[0]!.init.redirect).toBe('error');
    expect(body.model).toBe('zai.glm-5');
  });

  test('bedrock/openai.gpt-6-sol → /openai/v1/chat/completions', async () => {
    const { sent, body } = await capture('bedrock/openai.gpt-6-sol', () => new Response(openaiSse(OPENAI_CHUNKS), { status: 200 }));
    expect(sent[0]!.url).toBe('https://bedrock-mantle.us-east-1.api.aws/openai/v1/chat/completions');
    expect(body.model).toBe('openai.gpt-6-sol');
    // OpenAI 추론 계열은 max_tokens 를 400 으로 거부한다 — max_completion_tokens 만 싣는다.
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body.max_tokens).toBeUndefined();
  });

  test('request body is an OpenAI chat.completions body (messages · tools · stream · usage opt-in), not an Anthropic one', async () => {
    const { body } = await capture('bedrock/deepseek.v3.2', () => new Response(openaiSse(OPENAI_CHUNKS), { status: 200 }));
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a coding agent.' });
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.messages[1]).toEqual({ role: 'user', content: 'read a.ts' });
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.name).toBe('Read');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(64);
    expect(body.system).toBeUndefined();
    expect(body.anthropic_version).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('cache_control');
  });

  test('SigV4 service in the signature scope is bedrock-mantle', async () => {
    const { service } = await capture('bedrock/qwen.qwen3-coder-next', () => new Response(openaiSse(OPENAI_CHUNKS), { status: 200 }));
    expect(service).toBe('bedrock-mantle');
  });

  test('SSE → text deltas ⊕ tool_call ⊕ usage tokens', async () => {
    const { events } = await capture('bedrock/zai.glm-5', () => new Response(openaiSse(OPENAI_CHUNKS), { status: 200 }));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('OK');
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({ id: 'call_1', name: 'Read', args: { path: 'a.ts' } });
    const usage = events.filter((e) => e.type === 'usage') as unknown as Array<{ usage: Record<string, number> }>;
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage).toMatchObject({ inputTokens: 21, outputTokens: 7 });
  });

  test('credential failure → zero sends · non-2xx masks ARN and account id', async () => {
    let sends = 0;
    const p = makeBedrockProvider({ provider: 'bedrock', model: 'bedrock/zai.glm-5' } as UserConfig['llm'], {
      env: ENV,
      resolveCredentials: async () => { const e = new Error('nope'); e.name = 'CredentialsProviderError'; throw e; },
      send: async () => { sends++; return new Response(''); },
    });
    await expect((async () => { for await (const _ of p.streamChat!(MESSAGES)) { /* */ } })()).rejects.toThrow(/CredentialsProviderError/);
    expect(sends).toBe(0);

    const denied = JSON.stringify({ message: 'User: arn:aws:iam::123456789012:user/x is not authorized' });
    const err = await capture('bedrock/zai.glm-5', () => new Response(denied, { status: 403 })).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('Bedrock API 403');
    expect(err?.message).not.toContain('123456789012');
    expect(err?.message).not.toMatch(/arn:aws/);
  });
});

describe('Anthropic paths are unchanged by the mantle-openai branch', () => {
  test('bedrock/claude-sonnet-5-5 stays on runtime (service bedrock · eventstream accept · anthropic body)', async () => {
    const frames = ANTHROPIC_EVENTS.map((e) => encodeEventStreamFrame(
      { ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' },
      new TextEncoder().encode(JSON.stringify({ bytes: Buffer.from(JSON.stringify(e)).toString('base64') })),
    ));
    const bytes = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    frames.reduce((o, f) => { bytes.set(f, o); return o + f.length; }, 0);
    const { sent, service, body, events } = await capture('bedrock/claude-sonnet-5-5', () => new Response(bytes, { status: 200 }));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('hi');
    expect(sent[0]?.url).toBe('https://bedrock-runtime.ap-northeast-2.amazonaws.com/model/global.anthropic.claude-sonnet-5-5/invoke-with-response-stream');
    expect(service).toBe('bedrock');
    expect((sent[0]!.init.headers as Record<string, string>).accept).toBe('application/vnd.amazon.eventstream');
    expect(body.anthropic_version).toBe('bedrock-2023-05-31');
    expect(body.messages).toBeDefined();
    expect(body.max_tokens).toBe(8192);   // 5.5 계열 = adaptive ⊕ effort → 하한 8192(종전과 같다)
  });

  test('anthropic.claude-sonnet-5 stays on the mantle messages endpoint (service bedrock-mantle · anthropic-version header · SSE → text)', async () => {
    const { sent, service, body, events } = await capture('anthropic.claude-sonnet-5', () => new Response(anthropicSse, { status: 200 }));
    expect(sent[0]!.url).toBe('https://bedrock-mantle.ap-northeast-2.api.aws/anthropic/v1/messages');
    expect(service).toBe('bedrock-mantle');
    expect((sent[0]!.init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    expect(body.model).toBe('anthropic.claude-sonnet-5');
    expect(body.stream).toBe(true);
    expect(JSON.stringify(body.system)).toContain('cache_control');
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('hi');
  });

  test('Anthropic non-2xx masks identifiers and keeps the same error shape', async () => {
    const denied = JSON.stringify({ message: 'arn:aws:iam::123456789012:user/x denied' });
    const err = await capture('anthropic.claude-sonnet-5', () => new Response(denied, { status: 403 })).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('Bedrock API 403');
    expect(err?.message).not.toContain('123456789012');
  });
});
