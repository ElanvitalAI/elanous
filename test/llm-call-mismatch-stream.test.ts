import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log.js';
import { PROVIDERS, streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from '../src/llm.js';
import type { LLMToolSpec } from '../src/llm/tool-spec.js';
import { LogStore, StoreSink } from '../src/mss/logging/log-store.js';
import { llmNetworkFetch } from '../src/session-runtime/llm-call-gateway.js';
import { resetProviderCircuitForTest } from '../src/session-runtime/provider-circuit.js';
import { setUserConfigOverlay } from '../src/user-config.js';

/**
 * Real streamLLMWithTools, real gateway, real log store in a temp state dir. Only the external LLM boundary is faked:
 * each scripted provider's transport is `llmNetworkFetch` over a replaced global fetch, so the attempt rows come from the
 * production gateway and the `requested*` fields come from the production call site in src/llm.ts.
 */
const originalFetch = globalThis.fetch;
const originalProviders = { ...PROVIDERS };
const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_LLM_MODE', 'XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LOCAL_LLM_URL'];
const savedEnv: Record<string, string | undefined> = {};
let tmp = '';
let store: LogStore;
let sink: StoreSink;
let unregister: () => void;
const hosts: string[] = [];

function transportProvider(name: string, host: string, behavior: 'fail' | 'ok'): LLMProvider {
  async function* script(): AsyncGenerator<LLMStreamEvent, void, unknown> {
    const response = await llmNetworkFetch(`https://${host}/v1/chat`, { method: 'POST', body: '{}' });
    if (behavior === 'fail') throw Object.assign(new Error('rate limit reached'), { status: response.status });
    yield { type: 'text', delta: 'done' };
  }
  return { name, defaultModel: `${name}-model`, available: () => true, streamChat: () => script(), async *chat() { yield 'done'; } };
}

beforeEach(() => {
  resetProviderCircuitForTest();
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  tmp = mkdtempSync(join(tmpdir(), 'llm-mismatch-stream-'));
  Object.assign(process.env, { HOME: tmp, XDG_CONFIG_HOME: tmp, CODEX_HOME: join(tmp, 'codex-home'), ELANOUS_LLM_MODE: 'real' });
  store = new LogStore(join(tmp, 'logs.db'), { instance: 'test:llm-mismatch' });
  sink = new StoreSink(store, 'test', { installExitHandlers: false });
  unregister = debug.registerSink(sink);
  hosts.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    hosts.push(new URL(String(input)).hostname);
    return new Response('{}', { status: hosts.length === 1 && String(input).includes('first.example.test') ? 429 : 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  unregister();
  sink.flush();
  store.close();
  globalThis.fetch = originalFetch;
  Object.assign(PROVIDERS, originalProviders);
  setUserConfigOverlay(null);
  resetProviderCircuitForTest();
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(tmp, { recursive: true, force: true });
});

const callRows = () => { sink.flush(); return store.query({ categories: ['llm.call'] }).sort((a, b) => a.id - b.id); };
const echoTool: LLMToolSpec = { name: 'echo', description: 'echo', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } };
/** One tool-loop turn: the turn budget is the number of scripted steps, which is the one echo tool. */
const ONE_TURN = [echoTool].length;
const run = (opts: Record<string, unknown> = {}) => streamLLMWithTools(
  [{ role: 'user', content: 'hello' }],
  { onText: () => {}, dispatchTool: async () => 'ok' },
  { tools: [echoTool], maxTurns: ONE_TURN, ...opts },
);
const stage = (first: LLMProvider, second: LLMProvider) => {
  setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
  PROVIDERS.grok = first;
  PROVIDERS.anthropic = second;
  PROVIDERS.gemini = transportProvider('gemini', 'unused.example.test', 'ok');
  PROVIDERS.local = transportProvider('local', 'unused.example.test', 'ok');
};

describe('mismatch warn through the real streamLLMWithTools path', () => {
  it('no fallback: the called provider is the requested one, so the store holds attempt rows and no mismatch row', async () => {
    stage(transportProvider('grok', 'ok.example.test', 'ok'), transportProvider('anthropic', 'unused.example.test', 'ok'));
    await run();
    const rows = callRows();
    expect(rows.map(row => `${row.event}:${JSON.parse(row.data as string).provider}`)).toEqual(['attempt:grok']);
  });

  it('fallback: the first provider fails, the second is called, and exactly one mismatch warn follows that attempt in the stored log', async () => {
    stage(transportProvider('grok', 'first.example.test', 'fail'), transportProvider('anthropic', 'second.example.test', 'ok'));
    await run();
    const rows = callRows();
    const parsed = rows.map(row => ({ event: row.event, level: row.level, data: JSON.parse(row.data as string) as Record<string, unknown> }));
    expect(parsed.map(row => `${row.event}:${row.data.provider}`)).toEqual(['attempt:grok', 'attempt:anthropic', 'mismatch:anthropic']);
    expect(parsed.at(-1)).toMatchObject({ level: 'warn', data: { requestedProvider: 'grok', provider: 'anthropic', requestedBy: 'stream-llm-with-tools' } });
    expect(hosts).toEqual(['first.example.test', 'second.example.test']);
  });

  it('model remap: a model the requested provider cannot serve reroutes the turn, and the stored log carries one mismatch warn after the attempt', async () => {
    const grok = transportProvider('grok', 'ok.example.test', 'ok');
    stage(grok, transportProvider('anthropic', 'second.example.test', 'ok'));
    await run({ initialProvider: grok, model: 'claude-sonnet-4-5' });
    const rows = callRows().map(row => ({ event: row.event, level: row.level, data: JSON.parse(row.data as string) as Record<string, unknown> }));
    expect(rows.map(row => `${row.event}:${row.data.provider}`)).toEqual(['attempt:anthropic', 'mismatch:anthropic']);
    expect(rows.at(-1)).toMatchObject({ level: 'warn', data: { requestedProvider: 'grok', requestedModel: 'claude-sonnet-4-5', provider: 'anthropic' } });
  });
});
