// CEO 11-25 (seat OP · openai-codex · gpt-6.1-terra): «Read(clip-….png)» answered «I can't see the image».
// The Read tool returned a metadata line instead of image bytes. These cases drive the real Codex Responses
// client through the fake fetch device and check the wire body: a composer image attachment and a Read tool
// result on a .png must both arrive as `input_image` parts (upstream codex: ContentItem::InputImage in user
// messages, FunctionCallOutputContentItem::InputImage in view_image tool output).
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from './elanous-config-dir.js';
import { getProviderForConfig, streamLLMWithTools, type LLMMessage } from './llm.js';
import { saveTokens } from './oauth/store.js';
import { dispatchRead } from './skills/tools/read.js';
import type { UserConfig } from './user-config/types.js';
import { withFakeFetchDevice } from './ux-sim/fake-fetch.js';

// A real 1×1 PNG (signature · IHDR · IDAT · IEND), base64 literal independent of any product helper.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;
// A second, different PNG for the composer attachment (so the two parts are distinguishable on the wire).
const COMPOSER_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const envSnapshot = { ...process.env };
const previousConfigDir = getElanousConfigDirOverride();
let root = '';
afterEach(() => {
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

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}

test('Read on a .png returns image bytes (mediaType + dataB64); a fake .png stays a metadata line', async () => {
  root = mkdtempSync(join(tmpdir(), 'read-image-'));
  writeFileSync(join(root, 'clip.png'), Buffer.from(PNG_B64, 'base64'));
  writeFileSync(join(root, 'prose.png'), 'not an image at all');
  const image = await dispatchRead({ file_path: join(root, 'clip.png') });
  expect(image.kind).toBe('image');
  expect(image.mediaType).toBe('image/png');
  expect(image.dataB64).toBe(PNG_B64);
  const prose = await dispatchRead({ file_path: join(root, 'prose.png') });
  expect(prose.mediaType).toBeUndefined();
  expect(prose.dataB64).toBeUndefined();
  expect(prose.output.startsWith('[image: ')).toBe(true);
});

test('Codex request carries input_image for a composer attachment and for a Read tool result on a .png', async () => {
  root = mkdtempSync(join(tmpdir(), 'codex-image-input-'));
  mkdirSync(join(root, 'codex-home'), { recursive: true });
  const pngPath = join(root, 'clip-20261125-120022.png');
  writeFileSync(pngPath, Buffer.from(PNG_B64, 'base64'));
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

  const bodies: Array<{ input: Array<Record<string, unknown>> }> = [];
  const dispatched: string[] = [];
  const messages: LLMMessage[] = [{ role: 'user', content: [
    { type: 'text', text: 'What is in these two images?' },
    { type: 'image', mediaType: 'image/png', base64: COMPOSER_B64 },
  ] }];
  await withFakeFetchDevice([{ url: 'https://chatgpt.com/backend-api/codex/responses', method: 'POST', response: (request) => {
    bodies.push(JSON.parse(String(request.body)) as { input: Array<Record<string, unknown>> });
    if (bodies.length === 1) {
      return sse([
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_read_png', name: 'Read', arguments: JSON.stringify({ file_path: pngPath }) } },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } },
      ]);
    }
    return sse([
      { type: 'response.output_text.delta', delta: 'Two tiny squares.' },
      { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 4 } } },
    ]);
  } }], async () => {
    const answer = await streamLLMWithTools(messages, {
      onText: () => {},
      dispatchTool: async (name, args) => {
        dispatched.push(name);
        return await dispatchRead(args);
      },
    }, {
      provider,
      model: 'gpt-6.1-terra',
      sessionId: 'codex-image-input-test',
      tools: [{ name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
      maxTurns: 3,
    });
    expect(answer).toContain('Two tiny squares.');
  });

  expect(dispatched).toEqual(['Read']);
  expect(bodies.length).toBe(2);
  // Composer attachment → user message content part.
  const userMessage = bodies[0]!.input.find((item) => item.role === 'user') as { content: Array<Record<string, unknown>> };
  expect(userMessage.content).toContainEqual({ type: 'input_image', image_url: `data:image/png;base64,${COMPOSER_B64}`, detail: 'auto' });
  // Read tool result → function_call_output carrying the PNG as an input_image part.
  const output = bodies[1]!.input.find((item) => item.type === 'function_call_output') as { call_id: string; output: unknown };
  expect(output.call_id).toBe('call_read_png');
  expect(Array.isArray(output.output)).toBe(true);
  expect(output.output as Array<Record<string, unknown>>).toContainEqual({ type: 'input_image', image_url: PNG_DATA_URL, detail: 'auto' });
});
