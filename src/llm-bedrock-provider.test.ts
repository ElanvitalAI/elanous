// BEDROCK-PROVIDER — 공급자 본체(요청 몸 꼴·응답 파싱·캐시·관측) ⊕ 불변식(다른 공급자·자동 선택 불변).
// ⛔ 실 AWS 호출 0 — 자격·서명·HTTP 전부 주입. 자격 값은 가짜다.
import { expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import {
  PROVIDERS,
  _remainingFallbackProviderNamesForTest,
  getProvider,
  getProviderForConfig,
  isModelCompatible,
  type LLMStreamEvent,
  type LLMToolSpec,
} from './llm.js';
import {
  CONFIG_LLM_PROVIDER_NAMES, PROVIDER_DEFAULT_MODEL, RUNTIME_LLM_PROVIDER_NAMES,
  inferRuntimeLlmModelFamily, isRuntimeLlmModelCompatibleWithProvider, type UserConfig,
} from './user-config.js';
import { resolveImplementationChildModel } from './self-dev/dev-cli.js';
import { childLlmSelectionEnv } from './agent/run-context.js';
import { makeBedrockProvider } from './llm/bedrock-provider.js';
import { podNamedChildProvider } from './task-orchestrator/surfaces/self-implement-pod.js';

const ENV: Record<string, string> = { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIDFAKE', AWS_SECRET_ACCESS_KEY: 'fake' };
const FAKE = { accessKeyId: 'AKIDFAKE', secretAccessKey: 'fake' };
const tools: LLMToolSpec[] = [{ name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

function sse(events: unknown[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const STREAM = sse([
  { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 4096, cache_creation_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', usage: { output_tokens: 30 } },
  { type: 'message_stop' },
]);

async function run(model?: string, opts: Record<string, unknown> = {}) {
  const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
  const provider = makeBedrockProvider({ provider: 'bedrock', ...(model ? { model } : {}) } as UserConfig['llm'], {
    env: ENV,
    resolveCredentials: async () => FAKE,
    sign: async ({ headers }) => ({ ...headers, authorization: 'AWS4-HMAC-SHA256 Credential=fake' }),
    send: async (url, init) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const events: LLMStreamEvent[] = [];
  const messages = [
    { role: 'system' as const, content: 'You are a coding agent.' },
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'ok' },
    { role: 'user' as const, content: 'read a.ts' },
  ];
  for await (const ev of provider.streamChat!(messages, { tools, ...opts })) events.push(ev);
  return { provider, sent, events };
}

test('request body: Anthropic messages shape on the Bedrock messages endpoint · bedrock model id · cache markers', async () => {
  const { sent, provider } = await run('claude-sonnet-5-5');
  expect(provider.name).toBe('bedrock');
  expect(sent).toHaveLength(1);
  const { url, headers, body } = sent[0]!;
  expect(url).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages');
  expect(headers['anthropic-version']).toBe('2023-06-01');
  expect(headers['anthropic-beta']).toBeUndefined();
  expect(body.model).toBe('anthropic.claude-sonnet-5-5');
  expect(body.stream).toBe(true);
  expect(body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
  // 캐시 4슬롯 — Anthropic 공급자와 같은 자리(system·tools 꼬리 · history).
  expect(JSON.stringify(body.system)).toContain('cache_control');
  expect(body.tools[0].name).toBe('Read');
  expect(body.tools.at(-1).cache_control).toBeDefined();
  expect(JSON.stringify(body.messages)).toContain('cache_control');
  // 5.5 계열 = adaptive ⊕ effort, temperature 없음.
  expect(body.temperature).toBeUndefined();
});

test('promptCache:false strips every cache marker', async () => {
  const { sent } = await run(undefined, { promptCache: false });
  expect(JSON.stringify(sent[0]!.body)).not.toContain('cache_control');
  expect(sent[0]!.body.model).toBe('anthropic.claude-sonnet-5-5');
});

test('response parsing: text · tool_call · one usage event with cachedInput', async () => {
  const logs: Array<[string, string, any]> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((c: string, e: string, d: any) => { logs.push([c, e, d]); }) as typeof debug.log);
  try {
    const { events } = await run('bedrock/claude-haiku-5-5');
    expect(events.filter((e) => e.type === 'text').map((e) => (e as any).delta).join('')).toBe('hello');
    const call = events.find((e) => e.type === 'tool_call') as any;
    expect(call).toMatchObject({ id: 'toolu_1', name: 'Read', args: { path: 'a.ts' } });
    const usage = events.filter((e) => e.type === 'usage') as any[];
    expect(usage).toHaveLength(1);
    expect(usage[0].usage.cacheReadInputTokens).toBe(4096);
    expect(usage[0].usage.outputTokens).toBe(30);
    const obs = logs.find(([c, e]) => c === 'llm.bedrock' && e === 'usage');
    expect(obs?.[2]).toMatchObject({ provider: 'bedrock', model: 'anthropic.claude-haiku-5-5', cachedInput: 4096, outputTokens: 30 });
    // ⛔ 자격 값이 관측에 실리지 않는다.
    expect(JSON.stringify(logs)).not.toContain('AKIDFAKE');
  } finally {
    spy.mockRestore();
  }
});

test('no region → unavailable and streamChat throws before any send', async () => {
  let sends = 0;
  const p = makeBedrockProvider({ provider: 'bedrock' } as UserConfig['llm'], {
    env: { AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_CONFIG_FILE: '/nonexistent/aws/config', AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/aws/credentials' },
    send: async () => { sends++; return new Response(''); },
  });
  expect(p.available()).toBe(false);
  await expect((async () => { for await (const _ of p.streamChat!([{ role: 'user', content: 'x' }])) { /* */ } })()).rejects.toThrow(/Bedrock unavailable/);
  expect(sends).toBe(0);
});

test('IMDS-only host (region, no credential signal) → available candidate; chain failure → zero sends, fixed name, no raw err.name in logs', async () => {
  const logs: Array<[string, string, any]> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((c: string, e: string, d: any) => { logs.push([c, e, d]); }) as typeof debug.log);
  let sends = 0;
  try {
    const p = makeBedrockProvider({ provider: 'bedrock' } as UserConfig['llm'], {
      env: { AWS_REGION: 'us-east-1', AWS_CONFIG_FILE: '/nonexistent/aws/config', AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/aws/credentials' },
      resolveCredentials: async () => { throw Object.assign(new Error('x'), { name: 'weird-name-with-secret-ish-AKIAXXXX' }); },
      send: async () => { sends++; return new Response(''); },
    });
    expect(p.available()).toBe(true);
    await expect((async () => { for await (const _ of p.streamChat!([{ role: 'user', content: 'x' }])) { /* */ } })()).rejects.toThrow(/CredentialResolutionError/);
    expect(sends).toBe(0);
    const failed = logs.find(([c, e]) => c === 'llm.bedrock' && e === 'credentials-unresolved');
    expect(failed?.[2]).toMatchObject({ provider: 'bedrock', errName: 'BedrockCredentialsUnresolvedError', credentialSignal: 'chain' });
    expect(JSON.stringify(logs)).not.toContain('weird-name');
  } finally {
    spy.mockRestore();
  }
  // 후보여도(실 프로세스 env 에 리전이 있어도) 자동 선택·폴백에는 안 들어간다.
  const savedRegion = process.env.AWS_REGION;
  process.env.AWS_REGION = 'us-east-1';
  try {
    expect(PROVIDERS.bedrock!.available()).toBe(true);
    expect(_remainingFallbackProviderNamesForTest([])).not.toContain('bedrock');
  } finally {
    if (savedRegion === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = savedRegion;
  }
});

test('explicit provider=bedrock routes to the bedrock provider (config)', () => {
  const p = getProviderForConfig({ llm: { provider: 'bedrock', model: 'anthropic.claude-sonnet-5-5' } } as UserConfig);
  expect(p.name).toBe('bedrock');
  expect(p.defaultModel).toBe('anthropic.claude-sonnet-5-5');
  const bare = getProviderForConfig({ llm: { provider: 'bedrock', model: 'claude-sonnet-5-5' } } as UserConfig);
  expect(bare.name).toBe('bedrock');
});

test('invariants: other providers unchanged · bedrock never chosen automatically', () => {
  const anth = getProviderForConfig({ llm: { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-test' } } as UserConfig);
  expect(anth.name).toBe('anthropic');
  expect(isModelCompatible('anthropic', 'claude-sonnet-5-5')).toBe(true);
  expect(isModelCompatible('grok', 'claude-sonnet-5-5')).toBe(false);
  expect(isModelCompatible('bedrock', 'gpt-6-sol')).toBe(false);
  expect(isModelCompatible('bedrock', 'claude-opus-5-5')).toBe(true);
  // 폴백·자동 후보에 없다(가용이어도).
  expect(_remainingFallbackProviderNamesForTest([])).not.toContain('bedrock');
  expect(PROVIDERS.bedrock?.name).toBe('bedrock');
  // 모델 이름만으로는 bedrock 을 고르지 않는다(리뷰 4R) — 명시 전용.
  let byModel = 'none';
  try { byModel = getProvider('anthropic.claude-sonnet-5-5').name; } catch { /* 가용 provider 0 인 기계 — 그래도 bedrock 은 아니다 */ }
  expect(byModel).not.toBe('bedrock');
  // llm.ts isModelCompatible('anthropic', 'anthropic.claude-…') 는 종전대로(registry 추론 null → 통과).
  expect(isModelCompatible('anthropic', 'anthropic.claude-sonnet-5-5')).toBe(true);
  // 1st-party claude id 의 계열은 그대로 anthropic.
  expect(inferRuntimeLlmModelFamily('claude-sonnet-5-5')).toBe('anthropic');
  expect(inferRuntimeLlmModelFamily('anthropic.claude-sonnet-5-5')).toBe('bedrock');
  expect(inferRuntimeLlmModelFamily('us.anthropic.claude-sonnet-5-5')).toBe('bedrock');
  expect(isRuntimeLlmModelCompatibleWithProvider('anthropic', 'anthropic.claude-sonnet-5-5')).toBe(false);
  expect(isRuntimeLlmModelCompatibleWithProvider('bedrock', 'claude-sonnet-5-5')).toBe(true);
});

test('--child-llm-provider bedrock resolves to the wire id; unknown model is refused', () => {
  expect(resolveImplementationChildModel('bedrock', 'claude-sonnet-5-5').resolvedId).toBe('anthropic.claude-sonnet-5-5');
  expect(resolveImplementationChildModel('bedrock', 'bedrock/claude-opus-5-5').resolvedId).toBe('anthropic.claude-opus-5-5');
  expect(resolveImplementationChildModel('bedrock', 'anthropic.claude-haiku-5-5').tier).toBe('cheap');
  // 표의 supportsThinking 이 해석 결과로 흘러간다(자식 추론 배선이 읽는 칸).
  expect(resolveImplementationChildModel('bedrock', 'claude-sonnet-5-5').supportsThinking).toBe(true);
  // 지역 접두(리뷰 2R) — 같은 모델로 받고 와이어 id 는 접두 그대로.
  expect(resolveImplementationChildModel('bedrock', 'us.anthropic.claude-sonnet-5-5').resolvedId).toBe('us.anthropic.claude-sonnet-5-5');
  expect(resolveImplementationChildModel('bedrock', 'global.anthropic.claude-opus-5-5').tier).toBe('flagship');
  expect(() => resolveImplementationChildModel('bedrock', 'gpt-6-sol')).toThrow(/알 수 없음/);
  // 다른 provider 해석은 그대로.
  expect(resolveImplementationChildModel('anthropic', 'claude-sonnet-5-5').resolvedId).toBe('claude-sonnet-5-5');
});

test('child env relays AWS_* only for bedrock', () => {
  const saved = { ...process.env };
  try {
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_PROFILE = 'work';
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = 'http://169.254.170.23/v1/credentials';
    process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = '/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token';
    const b = childLlmSelectionEnv({ provider: 'bedrock', model: 'anthropic.claude-sonnet-5-5', source: 'flag' });
    // ECS/EKS Pod Identity 자격 경로(codex 5R) — 토큰 «파일 경로»까지 넘어가야 replace-env 자식의 체인이 선다.
    expect(b.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBe('http://169.254.170.23/v1/credentials');
    expect(b.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE).toBe('/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token');
    expect(b).toMatchObject({ ELANOUS_LLM_PROVIDER: 'bedrock', ELANOUS_LLM_MODEL: 'anthropic.claude-sonnet-5-5', AWS_REGION: 'us-east-1', AWS_PROFILE: 'work' });
    const a = childLlmSelectionEnv({ provider: 'anthropic', model: 'claude-sonnet-5-5', source: 'flag' });
    expect(a.AWS_REGION).toBeUndefined();
    expect(a.AWS_PROFILE).toBeUndefined();
    expect(a.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE).toBeUndefined();
    // 상속 갈래(리뷰 1R) — 부모 env 가 bedrock 이면 같이 넘기고, 아니면 안 넘긴다.
    process.env.ELANOUS_LLM_PROVIDER = 'bedrock';
    expect(childLlmSelectionEnv()).toMatchObject({ ELANOUS_LLM_PROVIDER: 'bedrock', AWS_REGION: 'us-east-1', AWS_PROFILE: 'work' });
    process.env.ELANOUS_LLM_PROVIDER = 'grok';
    expect(childLlmSelectionEnv().AWS_REGION).toBeUndefined();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('provider name lists carry bedrock together (no single-list drift)', () => {
  expect(CONFIG_LLM_PROVIDER_NAMES).toContain('bedrock');
  expect(RUNTIME_LLM_PROVIDER_NAMES).toContain('bedrock');
  expect(PROVIDER_DEFAULT_MODEL.bedrock).toBe('anthropic.claude-sonnet-5-5');
  expect(Object.keys(PROVIDERS)).toContain('bedrock');
  // isKnownProviderName 경유 — 알려진 provider 라야 config 라우팅이 «unknown provider» 로 죽지 않는다.
  expect(getProviderForConfig({ llm: { provider: 'bedrock' } } as UserConfig).name).toBe('bedrock');
});

test('retry re-signs the request (SigV4 x-amz-date freshness) via fetchApiWithRetry', async () => {
  let signs = 0;
  let calls = 0;
  const seenAuth: string[] = [];
  const redirects: unknown[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url: any, init: any) => {
    calls++;
    seenAuth.push(String(init.headers.authorization));
    redirects.push(init.redirect);
    if (calls === 1) return new Response('{"message":"overloaded"}', { status: 500 });
    return new Response(STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch);
  try {
    const p = makeBedrockProvider({ provider: 'bedrock' } as UserConfig['llm'], {
      env: ENV,
      resolveCredentials: async () => FAKE,
      sign: async ({ headers }) => ({ ...headers, authorization: `sig-${++signs}` }),
    });
    const events: LLMStreamEvent[] = [];
    for await (const ev of p.streamChat!([{ role: 'user', content: 'x' }])) events.push(ev);
    expect(calls).toBe(2);
    expect(seenAuth).toEqual(['sig-1', 'sig-2']);
    // 재서명한 재시도도 리다이렉트를 따라가지 않는다.
    expect(redirects).toEqual(['error', 'error']);
    expect(events.some((e) => e.type === 'text')).toBe(true);
  } finally {
    fetchSpy.mockRestore();
  }
});

test('re-sign failure on retry is not retried again (credential error thrown as-is)', async () => {
  let calls = 0;
  let resolves = 0;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url: any, _init: any) => {
    calls++;
    return new Response('{"message":"overloaded"}', { status: 500 });
  }) as unknown as typeof fetch);
  try {
    const p = makeBedrockProvider({ provider: 'bedrock' } as UserConfig['llm'], {
      env: ENV,
      resolveCredentials: async () => {
        resolves++;
        if (resolves > 1) { const e = new Error('expired'); e.name = 'CredentialsProviderError'; throw e; }
        return FAKE;
      },
      sign: async ({ headers }) => ({ ...headers, authorization: 'sig' }),
    });
    await expect((async () => { for await (const _ of p.streamChat!([{ role: 'user', content: 'x' }])) { /* */ } })()).rejects.toThrow(/CredentialsProviderError/);
    expect(calls).toBe(1);
    expect(resolves).toBe(2);
  } finally {
    fetchSpy.mockRestore();
  }
});

test('credential chain failure surfaces as Bedrock unavailable without sending', async () => {
  let sends = 0;
  const p = makeBedrockProvider({ provider: 'bedrock' } as UserConfig['llm'], {
    env: { AWS_REGION: 'us-east-1' },
    resolveCredentials: async () => { const e = new Error('nope'); e.name = 'CredentialsProviderError'; throw e; },
    send: async () => { sends++; return new Response(''); },
  });
  await expect((async () => { for await (const _ of p.streamChat!([{ role: 'user', content: 'x' }])) { /* */ } })()).rejects.toThrow(/자격 체인이 자격을 못 풀었다 \(CredentialsProviderError\)/);
  expect(sends).toBe(0);
});

test('malicious AWS_REGION → unavailable and zero sends (no credentials leave the process)', async () => {
  let sends = 0;
  const p = makeBedrockProvider({ provider: 'bedrock' } as UserConfig['llm'], {
    env: { AWS_REGION: 'us-east-1@evil.example/', AWS_BEARER_TOKEN_BEDROCK: 'tok-fake', AWS_CONFIG_FILE: '/nonexistent/aws/config' },
    send: async () => { sends++; return new Response(''); },
  });
  expect(p.available()).toBe(false);
  await expect((async () => { for await (const _ of p.streamChat!([{ role: 'user', content: 'x' }])) { /* */ } })()).rejects.toThrow(/Bedrock unavailable/);
  expect(sends).toBe(0);
});

test('Pod path refuses bedrock until the Pod PR lands (fail-closed, no silent codex)', () => {
  const r = podNamedChildProvider('bedrock', { grokSubscription: true, grokApiKey: true, openrouterKey: true }, 'anthropic.claude-sonnet-5-5');
  expect(r.provider).toBeUndefined();
  expect(r.refuse).toMatch(/bedrock/);
});

test('requests never follow redirects (credential headers cannot leave the validated host)', async () => {
  const { sent } = await run();
  expect(sent).toHaveLength(1);
  const inits: RequestInit[] = [];
  const p = makeBedrockProvider({ provider: 'bedrock' } as UserConfig['llm'], {
    env: { AWS_REGION: 'us-east-1', AWS_BEARER_TOKEN_BEDROCK: 'tok-fake' },
    send: async (_url, init) => { inits.push(init); return new Response(STREAM, { status: 200 }); },
  });
  for await (const _ of p.streamChat!([{ role: 'user', content: 'x' }])) { /* */ }
  expect(inits[0]!.redirect).toBe('error');
  // 실제 fetch 동작: redirect:'error' 면 3xx 에서 TypeError 로 끊긴다(교차 호스트로 송신 0).
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 307, headers: { location: 'http://127.0.0.1:1/steal' } }) });
  try {
    await expect(fetch(`http://127.0.0.1:${server.port}/`, { method: 'POST', redirect: 'error', headers: { 'x-api-key': 'tok-fake' }, body: '{}' })).rejects.toThrow();
  } finally {
    server.stop(true);
  }
});

test('cache marker placement is byte-identical to the Anthropic provider (system · tools · history · anchor)', async () => {
  const messages = [
    { role: 'system' as const, content: 'You are a coding agent.' },
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'ok' },
    { role: 'user' as const, content: 'second' },
    { role: 'assistant' as const, content: 'done' },
    { role: 'user' as const, content: 'read a.ts' },
  ];
  let anthropicBody: any;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url: any, init: any) => {
    anthropicBody = JSON.parse(String(init.body));
    return new Response(STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch);
  try {
    const anth = getProviderForConfig({ llm: { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-test' } } as UserConfig);
    for await (const _ of anth.streamChat!(messages, { tools })) { /* */ }
  } finally {
    fetchSpy.mockRestore();
  }
  let bedrockBody: any;
  const p = makeBedrockProvider({ provider: 'bedrock', model: 'claude-sonnet-5-5' } as UserConfig['llm'], {
    env: { AWS_REGION: ' us-east-1 ', AWS_BEARER_TOKEN_BEDROCK: 'tok-fake' },
    send: async (_url, init) => { bedrockBody = JSON.parse(String(init.body)); return new Response(STREAM, { status: 200 }); },
  });
  for await (const _ of p.streamChat!(messages, { tools })) { /* */ }
  expect(bedrockBody.model).toBe('anthropic.claude-sonnet-5-5');
  expect(anthropicBody.model).toBe('claude-sonnet-5-5');
  // 모델 칸 말고는 같은 몸 — 캐시 표지 위치(system 꼬리 · tools 꼬리 · history · anchor)까지 그대로.
  const strip = ({ model: _m, ...rest }: any) => rest;
  expect(strip(bedrockBody)).toEqual(strip(anthropicBody));
  const marked = (bedrockBody.messages as any[]).map((m) => JSON.stringify(m).includes('cache_control'));
  expect(marked[0]).toBe(true);                       // anchor(messages[0])
  expect(marked[marked.length - 2]).toBe(true);       // history(N-2)
  expect(marked[marked.length - 1]).toBe(false);      // 마지막 user 턴엔 표지 없음
});
