// 1121 FIRST-ANSWER-30S (#38265 REVIEW-2 ①) — does the early answer's output cap reach the provider REQUEST BODY?
// Drives the same layer the core turn calls (`streamLLMWithTools` → requestMaxTokens → provider adapter) with exactly
// the early-answer options, and reads the outgoing body from a fake fetch (no API calls). A field dropped between the
// layers fails here instead of passing silently.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from './elanous-config-dir.js';
import { getProviderForConfig, streamLLMWithTools, type LLMOpts } from './llm.js';
import { saveTokens } from './oauth/store.js';
import type { UserConfig } from './user-config/types.js';
import { withFakeFetchDevice, withRealProviderFakeFetchDevice } from './ux-sim/fake-fetch.js';
import {
  RESEARCH_EARLY_ANSWER_MAX_OUTPUT_TOKENS, RESEARCH_EARLY_ANSWER_REASONING_EFFORT,
} from './core-turn/research-policy.js';

/** The early-answer call options as run-core-turn.ts sends them (research usage role · no tools · light effort · a cap
 *  marked explicit). first-answer-30s.test.ts pins that run-core-turn really sends these two cap fields. */
const earlyAnswerOpts: LLMOpts = {
  tools: [], usageRole: 'research', researchTurn: true, longAnswer: false,
  reasoningEffort: RESEARCH_EARLY_ANSWER_REASONING_EFFORT, maxTokens: RESEARCH_EARLY_ANSWER_MAX_OUTPUT_TOKENS, maxTokensExplicit: true,
};
const messages = [{ role: 'user' as const, content: 'partial evidence → short answer' }];
const handlers = { onText() { /* fake stream */ }, dispatchTool: async () => 'unused' };
const OUTPUT_CAP_FIELDS = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as const;

/** Only the keys this file sets are restored — never the whole environment (other files share the process). */
const TOUCHED_ENV = ['XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_SUPPRESS_XDG_WARNING', 'ELANOUS_LLM_MODE', 'ELANOUS_RUN_ID', 'ELANOUS_CODEX_ACCOUNT'] as const;
const envBefore = Object.fromEntries(TOUCHED_ENV.map(key => [key, process.env[key]]));
afterEach(() => {
  for (const key of TOUCHED_ENV) {
    if (envBefore[key] === undefined) delete process.env[key];
    else process.env[key] = envBefore[key];
  }
});

test('grok (xAI chat/completions): the early-answer cap reaches the body as max_tokens, no auto-continuation', async () => {
  const bodies: Record<string, unknown>[] = [];
  await withRealProviderFakeFetchDevice([{ url: '/v1/chat/completions', method: 'POST', response: (request) => {
    bodies.push(JSON.parse(request.body ?? '{}') as Record<string, unknown>);
    // finish_reason=length: an automatic continuation would show up as a second request.
    const chunk = { choices: [{ delta: { content: '짧은 첫 답 (https://news.example/a).' }, finish_reason: 'length' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  } }], async () => {
    const provider = getProviderForConfig({ llm: { provider: 'grok', model: 'grok-4.7', apiKey: 'test-key' } } as unknown as UserConfig);
    await streamLLMWithTools(messages, handlers, { ...earlyAnswerOpts, provider, model: 'grok-4.7' });
  });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.max_tokens).toBe(RESEARCH_EARLY_ANSWER_MAX_OUTPUT_TOKENS);
});

test('openai-codex (Responses): the backend rejects an output cap, so the body carries none — pinned, not silent', async () => {
  const previousConfigDir = getElanousConfigDirOverride();
  const root = mkdtempSync(join(tmpdir(), 'early-answer-cap-codex-'));
  const bodies: Record<string, unknown>[] = [];
  try {
    mkdirSync(join(root, 'xdg', 'elanous'), { recursive: true });
    mkdirSync(join(root, 'codex-home'), { recursive: true });
    process.env.XDG_CONFIG_HOME = join(root, 'xdg');
    process.env.CODEX_HOME = join(root, 'codex-home');
    process.env.ELANOUS_SUPPRESS_XDG_WARNING = '1';
    process.env.ELANOUS_LLM_MODE = 'real';
    delete process.env.ELANOUS_RUN_ID;
    delete process.env.ELANOUS_CODEX_ACCOUNT;
    setElanousConfigDir(root);
    saveTokens('openai-codex', {
      accessToken: 'test-access-token', refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3_600_000, tokenType: 'Bearer',
    }, { authMode: 'chatgpt', mirrorCodex: false }, join(root, 'auth.json'));
    const provider = getProviderForConfig({ llm: { provider: 'openai-codex', model: 'gpt-6.1-terra' } } as unknown as UserConfig);
    await withFakeFetchDevice([{ url: 'https://chatgpt.com/backend-api/codex/responses', method: 'POST', response: (request) => {
      bodies.push(JSON.parse(String(request.body)) as Record<string, unknown>);
      return new Response([
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '짧은 첫 답 (https://news.example/a).' })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`,
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } }], async () => {
      // The adapter directly, with what requestMaxTokens hands Codex (the explicit cap, src/llm.ts requestMaxTokens).
      for await (const _ of provider.streamChat!(messages, { ...earlyAnswerOpts, model: 'gpt-6.1-terra' })) { /* consume */ }
    });
  } finally {
    if (previousConfigDir === undefined) resetElanousConfigDir();
    else setElanousConfigDir(previousConfigDir);
    rmSync(root, { recursive: true, force: true });
  }
  expect(bodies).toHaveLength(1);
  // src/llm.ts «Codex backend rejects max_output_tokens + temperature — omit.» On Codex the first answer is bounded only
  // by its instruction (≤ 4 sentences) and effort; if the adapter ever starts sending a cap, this pin must be revisited.
  for (const field of OUTPUT_CAP_FIELDS) expect(field in bodies[0]!).toBe(false);
});
