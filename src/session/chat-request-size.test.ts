import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS, type LLMProvider } from '../llm.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import { appendMessage, createSession } from './index.js';
import { runTurn } from './chat.js';
import { saveTokens } from '../oauth/store.js';

type FetchCapture = { body: Record<string, unknown>; wireJson: string };

let root = '';
let previousFetch: typeof fetch;
let captures: FetchCapture[] = [];
const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_SESSION_ROOT', 'ELANOUS_TEST_FAKE_LLM'] as const;
let savedEnv: Partial<Record<typeof envKeys[number], string>> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tui-request-size-compact-'));
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.CODEX_HOME = join(root, 'codex');
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  captures = [];
  resetAutoCompactStateForTest();
  saveTokens('openai-codex', {
    accessToken: 'test-access-token', refreshToken: 'test-refresh-token', expiresAt: null,
  }, { mirrorCodex: false, codexHome: process.env.CODEX_HOME });
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const wireJson = String(init?.body ?? '');
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(wireJson) as Record<string, unknown>; } catch { /* non-JSON fetches are still captured */ }
    captures.push({ body, wireJson });
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"compact summary"}',
      '',
      'data: {"choices":[{"delta":{"content":"compact summary"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  resetAutoCompactStateForTest();
  for (const key of envKeys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('Codex TUI request-size compact', () => {
  test('over-cap first request compacts the persisted session and sends current text plus image once', async () => {
    const model = 'gpt-5.6-terra';
    const codex = PROVIDERS['openai-codex']!;
    const provider: LLMProvider = {
      ...codex,
      // Test-only cap injection at the provider boundary. Keep the production
      // compactMessages closure from runTurn and the real Codex fetch path.
      streamChat(messages, opts = {}) {
        const guard = opts.requestSizeGuard;
        if (!guard) throw new Error('runTurn did not attach the Codex request-size guard');
        guard.maxChars = 2_000;
        return codex.streamChat!(messages, opts);
      },
    };
    const session = createSession({ provider: provider.name, model, source: 'tui' });
    for (let i = 0; i < 8; i++) {
      appendMessage(session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `older-${i} ${'history '.repeat(70)}`,
        ts: new Date().toISOString(),
      });
    }

    const latestText = 'latest request text after compaction';
    const imageBase64 = 'aW1hZ2UtYnl0ZXM=';
    const statusLines: string[] = [];
    const userConfig = {
      llm: { provider: 'openai-codex', model, goalLoop: { enabled: false }, memoryJudge: { enabled: false, crossRecall: false } },
      chat: {
        autoCompact: {
          enabled: true, triggerRatio: 0.9, preserveLastN: 2, preserveFirstN: 0,
          partial: true, workingBudgetTokens: 128_000,
        },
        compact: { archiveEnabled: false },
      },
    } as never;

    await runTurn({
      userConfig,
      sessionId: session.id,
      userText: latestText,
      userImages: [{ type: 'image', mediaType: 'image/png', base64: imageBase64 }],
      systemPrompt: 'request-size test system prompt',
      skipMemoryInjection: true,
      provider,
      onStatusLine: line => statusLines.push(line),
    });

    const request = [...captures].reverse().find((capture: FetchCapture) => Array.isArray(capture.body.input)
      && JSON.stringify(capture.body.input).includes(imageBase64));
    expect(request).toBeDefined();
    const wire = request!.wireJson;
    expect(wire.split(latestText)).toHaveLength(2);
    expect(wire.split(imageBase64)).toHaveLength(2);
    expect(wire.length).toBeLessThanOrEqual(2_000);
    const measuredLine = statusLines.find(line => line.includes('/ 2,000 · compact'));
    expect(measuredLine).toBeDefined();
    const measuredChars = Number(measuredLine!.match(/^ctx ([\d,]+)/)?.[1]?.replaceAll(',', ''));
    expect(measuredChars).toBe(request!.wireJson.length);
    expect(measuredChars).toBeLessThanOrEqual(2_000);
  });
});
