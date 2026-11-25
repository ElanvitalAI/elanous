// IMAGE-IN-STEER-FU (CEO 11-25 · 0.3.36 P1) — an image typed during a running turn (steer) reached the model only as
// the text token «[image 1]» on every provider (live smoke seat-state/OP/evidence/20261125/terra-image-smoke). These
// cases drive the real provider clients through the fake fetch device: a steer with an image attachment is pushed
// while a tool runs, and the request right after that tool result must carry the image as an image part in each
// provider's own wire shape — codex input_image · OpenAI-chat image_url (grok · OpenRouter · GLM) · Anthropic image
// block · Gemini inlineData — and the composer token must be gone from the text.
// Literals below are independent of the product (PNG bytes, wire field names, token text).
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from './elanous-config-dir.js';
import { getProviderForConfig, streamLLMWithTools, type LLMProvider } from './llm.js';
import { makeZaiCodingPlanProvider } from './llm/zai-coding-plan.js';
import { saveTokens } from './oauth/store.js';
import { buildInterjectionContent } from './chat/interjection.js';
import { createNextTuiSteerInbox, createNextTuiSteerRouter, loadSteerImages } from './repl/next-tui-steer.js';
import { clearPendingUserInput, drainPendingInterjections } from './session/pending-input.js';
import type { UserConfig } from './user-config/types.js';
import { withRealProviderFakeFetchDevice, type FakeFetchRoute } from './ux-sim/fake-fetch.js';

// A real 1×1 PNG, base64 literal.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOKEN = '[image 1: shot.png]';
const STEER_TEXT = `${TOKEN} what word is in this image?`;
const PROBE = [{ name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }];

const envSnapshot = { ...process.env };
const previousConfigDir = getElanousConfigDirOverride();
let root = '';
const sessions: string[] = [];
afterEach(() => {
  for (const sid of sessions.splice(0)) clearPendingUserInput(sid);
  for (const key of Object.keys(process.env)) if (!(key in envSnapshot)) delete process.env[key];
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (previousConfigDir === undefined) resetElanousConfigDir();
  else setElanousConfigDir(previousConfigDir);
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function setup(): string {
  root = mkdtempSync(join(tmpdir(), 'steer-image-'));
  const png = join(root, 'shot.png');
  writeFileSync(png, Buffer.from(PNG_B64, 'base64'));
  process.env.ELANOUS_SUPPRESS_XDG_WARNING = '1';
  delete process.env.ELANOUS_RUN_ID;
  setElanousConfigDir(root);
  return png;
}

function sse(events: unknown[], done = false): Response {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const chatToolCall = () => sse([{ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: 'probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }], true);
const chatText = () => sse([{ choices: [{ index: 0, delta: { content: 'ZEBRA' }, finish_reason: 'stop' }] }], true);

/** One turn: the first request asks for `probe`; during the tool the person steers with the PNG attached. */
async function steerTurn(name: string, provider: LLMProvider, model: string, routes: (record: (body: string) => void) => FakeFetchRoute[]): Promise<string[]> {
  const png = join(root, 'shot.png');
  const sid = `steer-image-${name}`;
  sessions.push(sid);
  const inbox = createNextTuiSteerInbox(sid, () => {});
  const bodies: string[] = [];
  await withRealProviderFakeFetchDevice(routes((body) => bodies.push(body)), async () => {
    await streamLLMWithTools([{ role: 'user', content: 'look at what I send next' }], {
      onText() {},
      dispatchTool: async () => {
        expect(inbox.push('steer-1', STEER_TEXT, false, undefined, [{ path: png, token: TOKEN }], root)).toBe(true);
        return 'probe ok';
      },
    }, { provider, model, sessionId: sid, tools: PROBE, maxTurns: 3, drainPendingUserInput: () => drainPendingInterjections(sid) });
  });
  return bodies;
}

function assertTokenReplaced(body: string): void {
  expect(body).not.toContain('[image 1: shot.png]');
  expect(body).toContain('[attached image 1] what word is in this image?');
}

test('codex (Responses): the request after a steer carries input_image', async () => {
  setup();
  mkdirSync(join(root, 'codex-home'), { recursive: true });
  process.env.CODEX_HOME = join(root, 'codex-home');
  delete process.env.ELANOUS_CODEX_ACCOUNT;
  saveTokens('openai-codex', { accessToken: 'test-access-token', refreshToken: 'test-refresh-token', expiresAt: Date.now() + 3_600_000, tokenType: 'Bearer' },
    { authMode: 'chatgpt', mirrorCodex: false }, join(root, 'auth.json'));
  const provider = getProviderForConfig({ llm: { provider: 'openai-codex', model: 'gpt-6.1-terra' } } as unknown as UserConfig);
  const bodies = await steerTurn('codex', provider, 'gpt-6.1-terra', (record) => [{ url: 'https://chatgpt.com/backend-api/codex/responses', method: 'POST', response: (request) => {
    record(String(request.body));
    return JSON.parse(String(request.body)).input.some((i: { type?: string }) => i.type === 'function_call_output')
      ? sse([{ type: 'response.output_text.delta', delta: 'ZEBRA' }, { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 1 } } }])
      : sse([{ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_probe', name: 'probe', arguments: '{}' } },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
  } }]);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).not.toContain(PNG_B64);
  const input = JSON.parse(bodies[1]!).input as Array<{ role?: string; content?: Array<Record<string, unknown>> }>;
  const last = input.filter((item) => item.role === 'user').at(-1)!;
  expect(last.content).toContainEqual({ type: 'input_image', image_url: `data:image/png;base64,${PNG_B64}`, detail: 'auto' });
  assertTokenReplaced(bodies[1]!);
});

for (const variant of [
  { name: 'grok', url: ['https://api.x.ai/v1/chat/completions', 'https://cli-chat-proxy.grok.com/v1/chat/completions'], model: 'grok-4.7',
    make: () => getProviderForConfig({ llm: { provider: 'grok', model: 'grok-4.7', apiKey: 'test-key' } } as unknown as UserConfig) },
  { name: 'openrouter', url: ['https://openrouter.ai/api/v1/chat/completions'], model: 'openrouter/z-ai/glm-5.3-flash',
    make: () => getProviderForConfig({ llm: { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3-flash', apiKey: 'test-key' } } as unknown as UserConfig) },
  { name: 'glm', url: ['https://api.z.ai/api/coding/paas/v4/chat/completions'], model: 'glm-5.3',
    make: () => makeZaiCodingPlanProvider({ provider: 'glm', model: 'glm-5.3' } as never, { key: () => 'test-key', quotaSnapshot: () => null } as never) },
]) {
  test(`${variant.name} (OpenAI chat): the request after a steer carries image_url`, async () => {
    setup();
    const bodies = await steerTurn(variant.name, variant.make(), variant.model, (record) => variant.url.map((url) => ({ url, method: 'POST', response: (request) => {
      record(String(request.body));
      return String(request.body).includes('"tool_call_id"') ? chatText() : chatToolCall();
    } })));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toContain(PNG_B64);
    const messages = JSON.parse(bodies[1]!).messages as Array<{ role: string; content: unknown }>;
    const last = messages.filter((m) => m.role === 'user').at(-1)!;
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content as Array<Record<string, unknown>>).toContainEqual(expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ url: `data:image/png;base64,${PNG_B64}` }) }));
    assertTokenReplaced(bodies[1]!);
  });
}

test('anthropic (Messages): the request after a steer carries an image block', async () => {
  setup();
  const provider = getProviderForConfig({ llm: { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'test-key' } } as unknown as UserConfig);
  const toolUse = () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_probe', name: 'probe', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const text = () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ZEBRA' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const bodies = await steerTurn('anthropic', provider, 'claude-sonnet-4-5', (record) => [{ url: 'https://api.anthropic.com/v1/messages', method: 'POST', response: (request) => {
    record(String(request.body));
    return String(request.body).includes('"tool_result"') ? text() : toolUse();
  } }]);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).not.toContain(PNG_B64);
  const messages = JSON.parse(bodies[1]!).messages as Array<{ role: string; content: unknown }>;
  const withImage = messages.filter((m) => m.role === 'user' && Array.isArray(m.content)
    && (m.content as Array<{ type: string }>).some((b) => b.type === 'image'));
  expect(withImage).toHaveLength(1);
  expect(withImage[0]!.content as Array<Record<string, unknown>>).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } });
  assertTokenReplaced(bodies[1]!);
});

test('gemini (native): the request after a steer carries inlineData', async () => {
  setup();
  const provider = getProviderForConfig({ llm: { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'test-key' } } as unknown as UserConfig);
  const bodies = await steerTurn('gemini', provider, 'gemini-2.5-flash', (record) => [{ url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent', method: 'POST', response: (request) => {
    record(String(request.body));
    return String(request.body).includes('functionResponse')
      ? sse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'ZEBRA' }] }, finishReason: 'STOP' }] }])
      : sse([{ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'probe', args: {} } }] }, finishReason: 'STOP' }] }]);
  } }]);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).not.toContain(PNG_B64);
  const contents = JSON.parse(bodies[1]!).contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  const parts = contents.filter((c) => c.role === 'user').flatMap((c) => c.parts);
  expect(parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: PNG_B64 } });
  assertTokenReplaced(bodies[1]!);
});

test('steer IPC: attachments parse; malformed or seat-mail attachments are refused; a missing image becomes a visible note', () => {
  const png = setup();
  const router = createNextTuiSteerRouter();
  const got: unknown[] = [];
  router.listen('turn-1', (request) => got.push(request));
  expect(router.receive({ type: 'elanous.next-tui.steer', turnId: 'turn-1', steerId: 's1', text: STEER_TEXT, attachments: [{ path: png, token: TOKEN }] })).toBe(true);
  expect(got).toEqual([{ kind: 'steer', steerId: 's1', text: STEER_TEXT, attachments: [{ path: png, token: TOKEN }] }]);
  expect(router.receive({ type: 'elanous.next-tui.steer', turnId: 'turn-1', steerId: 's2', text: 'x', attachments: [{ token: TOKEN }] })).toBe(false);
  expect(router.receive({ type: 'elanous.next-tui.steer', turnId: 'turn-1', steerId: 's3', text: 'x', attachments: 'not-a-list' })).toBe(false);
  expect(router.receive({ type: 'elanous.next-tui.steer', turnId: 'turn-1', steerId: 's4', text: 'x',
    seatMail: { msgId: 7, from: 'TC' }, attachments: [{ path: png }] })).toBe(false);
  expect(got).toHaveLength(1);

  const missing = loadSteerImages('[image 2: gone.png] and [image 1: shot.png]', [
    { path: join(root, 'gone.png'), token: '[image 2: gone.png]' }, { path: png, token: TOKEN }], root);
  expect(missing.text).toBe('[image not attached: gone.png · not found] and [attached image 1]');
  expect(missing.images).toEqual([{ mediaType: 'image/png', base64: PNG_B64 }]);
  expect(missing.dropped).toEqual([{ path: join(root, 'gone.png'), reason: 'not found' }]);
});

test('interjection content: images ride as parts before the framed text; text-only stays a string', () => {
  expect(typeof buildInterjectionContent(['plain line'], 'mid-turn')).toBe('string');
  const parts = buildInterjectionContent([{ kind: 'operator', text: 'look', images: [{ mediaType: 'image/png', base64: PNG_B64 }] }], 'mid-turn');
  expect(Array.isArray(parts)).toBe(true);
  const list = parts as Array<{ type: string; text?: string; mediaType?: string; base64?: string }>;
  expect(list[0]).toEqual({ type: 'image', mediaType: 'image/png', base64: PNG_B64 });
  expect(list).toHaveLength(2);
  expect(list[1]!.type).toBe('text');
  expect(list[1]!.text).toContain('<user_query>\nlook\n</user_query>');
});
