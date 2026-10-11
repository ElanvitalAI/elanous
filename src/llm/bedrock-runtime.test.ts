// BEDROCK-RUNTIME-PATH — runtime 경로(InvokeModelWithResponseStream) ⊕ eventstream 디코더 ⊕ 경로 표.
// ⛔ 실 AWS 호출 0 · 자격 값은 가짜다.
import { describe, expect, test } from 'bun:test';
import type { UserConfig } from '../user-config.js';
import type { LLMStreamEvent, LLMToolSpec } from '../llm.js';
import { LLM_TIER_MAP_BY_PROVIDER } from '../model-tier/llm-tier-map.js';
import {
  BEDROCK_MODELS,
  assertBedrockHost,
  bedrockRouteFor,
  bedrockRuntimeInvokeUrl,
  buildSignedBedrockRequest,
  redactAwsIdentifiers,
  resolveBedrockModelId,
} from './bedrock.js';
import {
  BedrockEventStreamError,
  BedrockRuntimeStreamError,
  bedrockRuntimeSseLines,
  crc32,
  decodeEventStream,
  decodeEventStreamFrame,
  encodeEventStreamFrame,
} from './bedrock-eventstream.js';
import { makeBedrockProvider } from './bedrock-provider.js';

const FAKE = { accessKeyId: 'AKIDFAKEFAKEFAKE', secretAccessKey: 'fake-secret-not-real' };
const ENV = { AWS_REGION: 'ap-northeast-2', AWS_ACCESS_KEY_ID: 'AKIDFAKE', AWS_SECRET_ACCESS_KEY: 'fake' };
const tools: LLMToolSpec[] = [{ name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const enc = new TextEncoder();

/** Anthropic 스트림 이벤트 하나 → runtime 이 보내는 eventstream 프레임 하나. */
function chunkFrame(event: unknown): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(event)).toString('base64');
  return encodeEventStreamFrame(
    { ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' },
    enc.encode(JSON.stringify({ bytes, p: 'abcd' })),
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const EVENTS = [
  { type: 'message_start', message: { usage: { input_tokens: 16, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 18214 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'O' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'K' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', usage: { output_tokens: 4 } },
  { type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 16, outputTokenCount: 4 } },
];
const RUNTIME_BYTES = concat(EVENTS.map(chunkFrame));

function sse(events: unknown[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** 바이트를 임의 크기로 잘라 흘리는 몸 — 청크 경계 ≠ 프레임 경계. */
function bodyOf(bytes: Uint8Array, chunk = 7): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); c.close(); },
  });
}

const MESSAGES = [
  { role: 'system' as const, content: 'You are a coding agent.' },
  { role: 'user' as const, content: 'first' },
  { role: 'assistant' as const, content: 'ok' },
  { role: 'user' as const, content: 'second' },
  { role: 'assistant' as const, content: 'done' },
  { role: 'user' as const, content: 'read a.ts' },
];

async function capture(model: string, response: () => Response, env: Record<string, string> = ENV) {
  const sent: { url: string; init: RequestInit; service?: string }[] = [];
  let service: string | undefined;
  const p = makeBedrockProvider({ provider: 'bedrock', model } as UserConfig['llm'], {
    env,
    resolveCredentials: async () => FAKE,
    sign: async (input) => { service = input.service; return { ...input.headers, authorization: 'AWS4-HMAC-SHA256 Credential=fake' }; },
    send: async (url, init) => { sent.push({ url, init, ...(service ? { service } : {}) }); return response(); },
  });
  const events: LLMStreamEvent[] = [];
  for await (const ev of p.streamChat!(MESSAGES, { tools })) events.push(ev);
  return { sent, events, body: JSON.parse(String(sent[0]?.init.body ?? '{}')) };
}

describe('route table (bedrock.ts BEDROCK_MODELS «route» column)', () => {
  test('5.5 aliases resolve to the global inference profile on runtime; mantle-served sonnet-5 stays on mantle', () => {
    for (const alias of ['claude-sonnet-5-5', 'bedrock/claude-sonnet-5-5', 'anthropic.claude-sonnet-5-5']) {
      expect(resolveBedrockModelId(alias)).toBe('global.anthropic.claude-sonnet-5-5');
    }
    expect(resolveBedrockModelId('bedrock/claude-haiku-5-5')).toBe('global.anthropic.claude-haiku-5-5');
    expect(bedrockRouteFor('global.anthropic.claude-sonnet-5-5')).toBe('runtime');
    expect(bedrockRouteFor('global.anthropic.claude-haiku-5-5')).toBe('runtime');
    // 접두가 붙은 id 는 표 밖이어도 runtime(데이터 거주 선택 보존).
    expect(resolveBedrockModelId('apac.anthropic.claude-sonnet-4-20250514-v1:0')).toBe('apac.anthropic.claude-sonnet-4-20250514-v1:0');
    expect(bedrockRouteFor('us.anthropic.claude-sonnet-5-5')).toBe('runtime');
    // mantle 이 실제로 내는 모델은 mantle 그대로.
    expect(resolveBedrockModelId('claude-sonnet-5')).toBe('anthropic.claude-sonnet-5');
    expect(bedrockRouteFor('anthropic.claude-sonnet-5')).toBe('mantle');
    // 표 밖 접두 없는 id 는 종전대로 mantle(엔드포인트가 판정).
    expect(bedrockRouteFor('anthropic.claude-haiku-4-5')).toBe('mantle');
  });

  test('table is self-consistent: runtime rows carry an inference-profile prefix, mantle rows do not', () => {
    for (const m of BEDROCK_MODELS) {
      expect(/^[a-z]{2,6}\.anthropic\./.test(m.id)).toBe(m.route === 'runtime');
      expect(bedrockRouteFor(m.id)).toBe(m.route);
    }
  });

  test('the bedrock tier ladder resolves to runtime ids (no mantle-only 5.5 id left)', () => {
    for (const spec of Object.values(LLM_TIER_MAP_BY_PROVIDER.bedrock)) {
      expect(resolveBedrockModelId(spec.model)).toBe(spec.model);
      expect(bedrockRouteFor(spec.model)).toBe('runtime');
    }
  });
});

describe('request building', () => {
  test('claude-sonnet-5-5 → runtime URL · global id in the path · SigV4 service "bedrock" · runtime body', async () => {
    const { sent, body, events } = await capture('claude-sonnet-5-5', () => new Response(bodyOf(RUNTIME_BYTES), { status: 200 }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://bedrock-runtime.ap-northeast-2.amazonaws.com/model/global.anthropic.claude-sonnet-5-5/invoke-with-response-stream');
    expect(sent[0]!.service).toBe('bedrock');
    expect(sent[0]!.init.redirect).toBe('error');
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers.accept).toBe('application/vnd.amazon.eventstream');
    expect(headers['anthropic-version']).toBeUndefined();
    expect(body.anthropic_version).toBe('bedrock-2023-05-31');
    expect(body.model).toBeUndefined();
    expect(body.stream).toBeUndefined();
    expect(events.length).toBeGreaterThan(0);
  });

  test('anthropic.claude-sonnet-5 → mantle URL · service bedrock-mantle · body bytes unchanged ({...body, stream:true})', async () => {
    let service: string | undefined;
    const signed = await buildSignedBedrockRequest({
      region: 'ap-northeast-2', body: { model: 'anthropic.claude-sonnet-5', messages: [{ role: 'user', content: 'x' }], max_tokens: 8 },
      resolveCredentials: async () => FAKE, env: {},
      sign: async (input) => { service = input.service; return input.headers; },
    });
    expect(signed.url).toBe('https://bedrock-mantle.ap-northeast-2.api.aws/anthropic/v1/messages');
    expect(service).toBe('bedrock-mantle');
    expect(signed.body).toBe(JSON.stringify({ model: 'anthropic.claude-sonnet-5', messages: [{ role: 'user', content: 'x' }], max_tokens: 8, stream: true }));
    expect(signed.headers['anthropic-version']).toBe('2023-06-01');
  });

  test('real SigV4 signer scopes the runtime request to service "bedrock" (credential scope)', async () => {
    const signed = await buildSignedBedrockRequest({
      region: 'ap-northeast-2', body: { model: 'global.anthropic.claude-haiku-5-5', messages: [], max_tokens: 8 },
      resolveCredentials: async () => FAKE, env: {},
    });
    expect(signed.headers.authorization).toContain('/ap-northeast-2/bedrock/aws4_request');
    expect(new URL(signed.url).hostname).toBe('bedrock-runtime.ap-northeast-2.amazonaws.com');
  });

  test('bearer token on runtime goes as Authorization: Bearer (no x-api-key)', async () => {
    const signed = await buildSignedBedrockRequest({
      region: 'us-east-1', body: { model: 'global.anthropic.claude-sonnet-5-5', messages: [] },
      env: { AWS_BEARER_TOKEN_BEDROCK: 'tok-fake' },
    });
    expect(signed.headers.authorization).toBe('Bearer tok-fake');
    expect(signed.headers['x-api-key']).toBeUndefined();
  });

  test('cache-marker parity: same conversation → identical messages/system/tools on mantle and runtime bodies', async () => {
    const mantle = await capture('anthropic.claude-sonnet-5', () => new Response(sse(EVENTS), { status: 200 }));
    const runtime = await capture('claude-sonnet-5-5', () => new Response(bodyOf(RUNTIME_BYTES), { status: 200 }));
    expect(runtime.body.messages).toEqual(mantle.body.messages);
    expect(runtime.body.system).toEqual(mantle.body.system);
    expect(runtime.body.tools).toEqual(mantle.body.tools);
    expect(JSON.stringify(runtime.body.system)).toContain('cache_control');
    expect(runtime.body.tools.at(-1).cache_control).toBeDefined();
    const marked = (runtime.body.messages as unknown[]).map((m) => JSON.stringify(m).includes('cache_control'));
    expect(marked[0]).toBe(true);
    expect(marked[marked.length - 2]).toBe(true);
    expect(marked[marked.length - 1]).toBe(false);
    // 몸에서 다른 칸은 «model·stream ↔ anthropic_version» 뿐.
    const { model: _m, stream: _s, ...m } = mantle.body;
    const { anthropic_version: _v, ...r } = runtime.body;
    expect(r).toEqual(m);
  });
});

describe('safety contract on the runtime path', () => {
  test('credential failure → zero sends', async () => {
    let sends = 0;
    const p = makeBedrockProvider({ provider: 'bedrock', model: 'claude-sonnet-5-5' } as UserConfig['llm'], {
      env: { AWS_REGION: 'us-east-1' },
      resolveCredentials: async () => { const e = new Error('nope'); e.name = 'CredentialsProviderError'; throw e; },
      send: async () => { sends++; return new Response(''); },
    });
    await expect((async () => { for await (const _ of p.streamChat!([{ role: 'user', content: 'x' }])) { /* */ } })()).rejects.toThrow(/CredentialsProviderError/);
    expect(sends).toBe(0);
  });

  test('host swap refused: bad region · model id that would alter the URL · foreign host — no credentials attached', async () => {
    expect(() => bedrockRuntimeInvokeUrl('us-east-1@evil.example/', 'global.anthropic.claude-sonnet-5-5')).toThrow(/리전/);
    expect(() => bedrockRuntimeInvokeUrl('us-east-1', 'global.anthropic.claude-x/../../evil')).toThrow(/모델 id/);
    expect(() => bedrockRuntimeInvokeUrl('us-east-1', 'x@evil.example')).toThrow(/모델 id/);
    expect(() => bedrockRuntimeInvokeUrl('us-east-1', 'a?b')).toThrow(/모델 id/);
    expect(() => assertBedrockHost('https://evil.example/model/x/invoke-with-response-stream', 'us-east-1', 'runtime')).toThrow(/자격을 붙이지 않는다/);
    expect(() => assertBedrockHost('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages', 'us-east-1', 'runtime')).toThrow();
    expect(() => assertBedrockHost('https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke-with-response-stream', 'us-east-1', 'runtime')).not.toThrow();
    // 콜론이 든 프로필 id 는 경로 조각으로 인코딩된다(호스트 불변).
    expect(bedrockRuntimeInvokeUrl('ap-northeast-2', 'apac.anthropic.claude-sonnet-4-20250514-v1:0'))
      .toBe('https://bedrock-runtime.ap-northeast-2.amazonaws.com/model/apac.anthropic.claude-sonnet-4-20250514-v1%3A0/invoke-with-response-stream');
    // 공급자 경유: URL 을 바꾸는 모델 id 면 서명·송신 0.
    let sends = 0; let signs = 0;
    const p = makeBedrockProvider({ provider: 'bedrock', model: 'global.anthropic.claude-x/../../evil' } as UserConfig['llm'], {
      env: ENV, resolveCredentials: async () => FAKE,
      sign: async ({ headers }) => { signs++; return headers; },
      send: async () => { sends++; return new Response(''); },
    });
    await expect((async () => { for await (const _ of p.streamChat!([{ role: 'user', content: 'x' }])) { /* */ } })()).rejects.toThrow(/모델 id/);
    expect(sends).toBe(0);
    expect(signs).toBe(0);
  });

  test('non-2xx runtime body: ARN and account id are masked in the error', async () => {
    const body = JSON.stringify({ message: 'User: arn:aws:iam::123456789012:user/x is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:ap-northeast-2:123456789012:inference-profile/global.anthropic.claude-sonnet-5-5' });
    const err = await capture('claude-sonnet-5-5', () => new Response(body, { status: 403 })).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('Bedrock API 403');
    expect(err?.message).toContain('bedrock:InvokeModelWithResponseStream');
    expect(err?.message).not.toContain('123456789012');
    expect(err?.message).not.toMatch(/arn:aws/);
  });

  test('in-stream exception frame → fixed-name error, masked detail', async () => {
    const bytes = concat([
      chunkFrame(EVENTS[0]),
      encodeEventStreamFrame(
        { ':message-type': 'exception', ':exception-type': 'throttlingException', ':content-type': 'application/json' },
        enc.encode(JSON.stringify({ message: 'Too many requests for arn:aws:bedrock:us-east-1:123456789012:inference-profile/x' })),
      ),
    ]);
    const err = await capture('claude-sonnet-5-5', () => new Response(bodyOf(bytes), { status: 200 })).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(BedrockRuntimeStreamError);
    expect(err?.name).toBe('BedrockRuntimeStreamError');
    expect((err as BedrockRuntimeStreamError).exceptionType).toBe('throttlingException');
    expect(err?.message).not.toContain('123456789012');
    expect(err?.message).not.toMatch(/arn:aws/);
  });
});

describe('response: eventstream → Anthropic events → usage', () => {
  test('text · tool_call · one usage event carrying cache write and read (rollup fields)', async () => {
    const { events } = await capture('claude-sonnet-5-5', () => new Response(bodyOf(RUNTIME_BYTES, 5), { status: 200 }));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('OK');
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({ id: 'toolu_1', name: 'Read', args: { path: 'a.ts' } });
    const usage = events.filter((e) => e.type === 'usage') as unknown as Array<{ usage: Record<string, number> }>;
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage).toMatchObject({ inputTokens: 16, outputTokens: 4, cacheCreationInputTokens: 18214, cacheReadInputTokens: 0 });
  });
});

describe('eventstream decoder', () => {
  const frame = chunkFrame({ type: 'message_stop' });

  test('crc32 matches the zlib reference vector', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });

  test('normal frame round-trips; chunk boundaries are irrelevant', async () => {
    const msg = decodeEventStreamFrame(frame);
    expect(msg.headers[':event-type']).toBe('chunk');
    expect(msg.headers[':message-type']).toBe('event');
    const lines: string[] = [];
    for await (const line of bedrockRuntimeSseLines(bodyOf(concat([frame, frame]), 3))) lines.push(line);
    expect(lines).toEqual(['data: {"type":"message_stop"}', 'data: {"type":"message_stop"}']);
  });

  test('broken message CRC → BedrockEventStreamError', async () => {
    const bad = frame.slice();
    bad[bad.length - 6] = bad[bad.length - 6]! ^ 0xff;   // 페이로드 1바이트
    expect(() => decodeEventStreamFrame(bad)).toThrow(/message CRC/);
    await expect((async () => { for await (const _ of decodeEventStream(bodyOf(bad))) { /* */ } })()).rejects.toBeInstanceOf(BedrockEventStreamError);
  });

  test('broken prelude CRC → refused before trusting the length field', async () => {
    const bad = frame.slice();
    bad[1] = bad[1]! ^ 0x01;   // total length 칸
    await expect((async () => { for await (const _ of decodeEventStream(bodyOf(bad))) { /* */ } })()).rejects.toThrow(/CRC|길이/);
  });

  test('truncated frame (stream ends mid-frame) → error, not a silent partial answer', async () => {
    const cut = concat([frame, frame.slice(0, frame.length - 5)]);
    const got: unknown[] = [];
    await expect((async () => { for await (const m of decodeEventStream(bodyOf(cut))) got.push(m); })()).rejects.toThrow(/잘렸다/);
    expect(got).toHaveLength(1);
    expect(() => decodeEventStreamFrame(frame.slice(0, 10))).toThrow(/잘렸다/);
  });

  test('redactAwsIdentifiers masks ARNs and 12-digit account ids', () => {
    expect(redactAwsIdentifiers('arn:aws:iam::123456789012:user/x and 123456789012')).toBe('arn:<redacted> and <account>');
  });
});
