// OR-TOOLCHOICE-PASS (2026-10-10) — the OpenRouter request builder carries the caller's toolChoice
// as `tool_choice` (via toChatToolChoice), and nothing else moves:
//   · openrouter without toolChoice → body unchanged (no tool_choice key)
//   · codex · claude(anthropic) · grok (and the openai compat path) → body unchanged by this fix
// Fake fetch via spyOn (never mock.module).
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from './debug/log.js';
import { getProviderForConfig, openRouterToolChoice, toChatToolChoice, toResponsesToolChoice, type LLMToolSpec, type ToolChoice } from './llm.js';
import type { UserConfig } from './user-config.js';

const tools: LLMToolSpec[] = [{ name: 'demo', description: 'demo', parameters: { type: 'object', properties: { a: { type: 'string' } } } }];
const messages = [{ role: 'user' as const, content: 'hello' }];

async function captureBody(llm: Record<string, unknown>, opts: { toolChoice?: ToolChoice; tools?: LLMToolSpec[] | null }) {
  const bodies: string[] = [];
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response('data: [DONE]\n\n', { status: 200 });
  }) as typeof fetch);
  try {
    const provider = getProviderForConfig({ llm } as unknown as UserConfig);
    const streamOpts = {
      ...(opts.tools === null ? {} : { tools: opts.tools ?? tools }),
      ...(opts.toolChoice !== undefined ? { toolChoice: opts.toolChoice } : {}),
    };
    for await (const _ of provider.streamChat!(messages, streamOpts)) { /* consume */ }
    expect(bodies.length).toBeGreaterThan(0);
    return bodies[0]!;
  } finally {
    mock.mockRestore();
  }
}

const OR_GLM = { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', apiKey: 'test-key' };
const OR_KIMI = { provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3', apiKey: 'test-key' };

test('openrouter: toolChoice "required" → body.tool_choice === "required"', async () => {
  const body = JSON.parse(await captureBody(OR_GLM, { toolChoice: 'required' }));
  expect(body.tool_choice).toBe('required');
  expect(body.tools[0].function.name).toBe('demo');
});

test('openrouter: toolChoice {name} → toChatToolChoice shape', async () => {
  const body = JSON.parse(await captureBody(OR_GLM, { toolChoice: { name: 'demo' } }));
  expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'demo' } });
  expect(body.tool_choice).toEqual(toChatToolChoice({ name: 'demo' }) as object);
});

test('openrouter: toolChoice "auto"/"none" pass through verbatim', async () => {
  expect(JSON.parse(await captureBody(OR_GLM, { toolChoice: 'auto' })).tool_choice).toBe('auto');
  expect(JSON.parse(await captureBody(OR_GLM, { toolChoice: 'none' })).tool_choice).toBe('none');
});

test('openrouter: no toolChoice → body byte-identical to the pre-fix shape (no tool_choice key)', async () => {
  const raw = await captureBody(OR_GLM, {});
  const body = JSON.parse(raw);
  expect('tool_choice' in body).toBe(false);
  // Pre-fix key order: model · messages · tools · usage · provider · stream (sampling fields are omitted on OpenRouter).
  expect(Object.keys(body)).toEqual(['model', 'messages', 'tools', 'usage', 'provider', 'stream']);
  // Adding then removing tool_choice reproduces the exact bytes.
  const withChoice = JSON.parse(await captureBody(OR_GLM, { toolChoice: 'required' }));
  delete withChoice.tool_choice;
  expect(JSON.stringify(withChoice)).toBe(raw);
});

test('openrouter: toolChoice without tools → no tool_choice key (avoid 400 on tool-less requests)', async () => {
  const body = JSON.parse(await captureBody(OR_GLM, { toolChoice: 'required', tools: null }));
  expect('tool_choice' in body).toBe(false);
  expect('tools' in body).toBe(false);
});

test('openrouter Kimi (moonshotai/*): forced choice is lowered to "auto"; auto/none unchanged', async () => {
  expect(JSON.parse(await captureBody(OR_KIMI, { toolChoice: 'required' })).tool_choice).toBe('auto');
  expect(JSON.parse(await captureBody(OR_KIMI, { toolChoice: { name: 'demo' } })).tool_choice).toBe('auto');
  expect(JSON.parse(await captureBody(OR_KIMI, { toolChoice: 'none' })).tool_choice).toBe('none');
  expect(openRouterToolChoice('moonshotai/kimi-k3', undefined)).toBeUndefined();
  expect(openRouterToolChoice('z-ai/glm-5.3', 'required')).toBe('required');
});

test('openrouter: tool-choice-sent is observed under llm.openrouter only when tool_choice is set', async () => {
  const logs: Array<{ category: string; event: string; data: any }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
    logs.push({ category, event, data });
  }) as typeof debug.log);
  try {
    await captureBody(OR_GLM, {});
    expect(logs.filter((l) => l.event === 'tool-choice-sent')).toHaveLength(0);
    await captureBody(OR_GLM, { toolChoice: 'required' });
    const sent = logs.filter((l) => l.event === 'tool-choice-sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.category).toBe('llm.openrouter');
    expect(sent[0]!.data).toMatchObject({ model: 'z-ai/glm-5.3', toolChoice: 'required' });
  } finally {
    log.mockRestore();
  }
});

// ── Invariants: paths outside OpenRouter are untouched by this fix ─────────────────────────────

test('invariant: claude(anthropic) body ignores toolChoice exactly as before (byte-identical)', async () => {
  const llm = { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-test' };
  const without = await captureBody(llm, {});
  for (const tc of ['required', 'auto', { name: 'demo' }] as ToolChoice[]) {
    expect(await captureBody(llm, { toolChoice: tc })).toBe(without);
  }
  expect('tool_choice' in JSON.parse(without)).toBe(false);
});

test('invariant: grok and the openai compat path still drop toolChoice (byte-identical)', async () => {
  for (const llm of [
    { provider: 'grok', model: 'grok-4.7', apiKey: 'xai-test' },
    { provider: 'openai', model: 'gpt-5.6', apiKey: 'sk-test' },
  ]) {
    const without = await captureBody(llm, {});
    for (const tc of ['required', { name: 'demo' }] as ToolChoice[]) {
      expect(await captureBody(llm, { toolChoice: tc })).toBe(without);
    }
    expect('tool_choice' in JSON.parse(without)).toBe(false);
  }
});

test('invariant: codex body keeps its Responses-API tool_choice (toResponsesToolChoice) and is otherwise unchanged', async () => {
  // The Responses-API body (where toResponsesToolChoice applies) is the OAuth path; with only an
  // apiKey codex falls back to /chat/completions. Give the test its own OAuth mirror in an isolated
  // HOME/CODEX_HOME instead of depending on whatever ~/.codex/auth.json the host happens to have.
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, CODEX_HOME: process.env.CODEX_HOME };
  const root = mkdtempSync(join(tmpdir(), 'or-toolchoice-codex-'));
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = root;
  process.env.CODEX_HOME = join(root, 'codex-home');
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const jwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt, refresh_token: 'mirror-refresh' } }));
  try {
    const llm = { provider: 'openai-codex', model: 'gpt-5.6', apiKey: 'sk-test' };
    const without = JSON.parse(await captureBody(llm, {}));
    expect('tool_choice' in without).toBe(false);
    expect('input' in without).toBe(true); // Responses-API shape, not /chat/completions
    for (const tc of ['required', { name: 'demo' }] as ToolChoice[]) {
      const body = JSON.parse(await captureBody(llm, { toolChoice: tc }));
      expect(body.tool_choice).toBe(toResponsesToolChoice(tc) as string);
      delete body.tool_choice;
      expect(body).toEqual(without);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
