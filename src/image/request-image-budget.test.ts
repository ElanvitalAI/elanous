// IMAGE-REQUEST-BUDGET (CEO 11-25 13:21 · seat OP) — a pasted 2576×168 terminal screenshot (~1.1 MB PNG) made the
// Codex request 1.7 M chars against a 400 k TEXT cap; compaction could not shrink the image and the turn failed.
// Expectations are independent literals (sizes · dimensions · note text), not product constants.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { getProviderForConfig, streamLLMWithTools, type LLMMessage } from '../llm.js';
import { enforceResponsesImageBudget, measureInlineImageChars, requestTextChars, summarizeRequestParts } from '../llm-request-images.js';
import { saveTokens } from '../oauth/store.js';
import { dispatchRead } from '../skills/tools/read.js';
import type { UserConfig } from '../user-config/types.js';
import { withFakeFetchDevice } from '../ux-sim/fake-fetch.js';
import { normalizeRequestImage, prepareRequestImage } from './request-image-normalize.js';

/** Deterministic noise (PNG cannot compress it) — a stand-in for a dense terminal screenshot. */
function noise(width: number, height: number, channels: 3 | 4): Buffer {
  const raw = Buffer.alloc(width * height * channels);
  let x = 0x2545f491;
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    raw[i] = x & 0xff;
  }
  return raw;
}

async function noisePng(width: number, height: number, channels: 3 | 4 = 3): Promise<Buffer> {
  return await sharp(noise(width, height, channels), { raw: { width, height, channels } }).png({ compressionLevel: 9 }).toBuffer();
}

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

function codexProvider(): ReturnType<typeof getProviderForConfig> {
  root = mkdtempSync(join(tmpdir(), 'image-budget-'));
  mkdirSync(join(root, 'codex-home'), { recursive: true });
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
  return getProviderForConfig({ llm: { provider: 'openai-codex', model: 'gpt-6.1-terra' } } as unknown as UserConfig);
}

const DONE = [
  { type: 'response.output_text.delta', delta: 'Seen.' },
  { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 2 } } },
];

/** One Codex turn with a 400 000-char guard; returns the posted bodies and whether compaction was asked for. */
async function guardedTurn(messages: LLMMessage[]): Promise<{ bodies: string[]; compactCalls: number; answer: string | null; error: string | null }> {
  const provider = codexProvider();
  const bodies: string[] = [];
  let compactCalls = 0;
  let answer: string | null = null;
  let error: string | null = null;
  await withFakeFetchDevice([{ url: 'https://chatgpt.com/backend-api/codex/responses', method: 'POST', response: (request) => {
    bodies.push(String(request.body));
    return sse(DONE);
  } }], async () => {
    try {
      answer = await streamLLMWithTools(messages, { onText: () => {}, dispatchTool: async () => ({}) }, {
        provider, model: 'gpt-6.1-terra', sessionId: 'image-budget-test', maxTurns: 1,
        tools: [{ name: 'Noop', description: 'noop', parameters: { type: 'object', properties: {} } }],
        requestSizeGuard: {
          maxChars: 400_000,
          compactMessages: async () => { compactCalls += 1; return null; },
        },
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  });
  return { bodies, compactCalls, answer, error };
}

test('a 2576×168 PNG of ~1.1 MB is downscaled to 2048×134 and fits the per-image budget', async () => {
  const png = await noisePng(2576, 168);
  expect(png.length).toBeGreaterThan(1_000_000);
  const normalized = await normalizeRequestImage(png, { mediaType: 'image/png' });
  expect(normalized.kind).toBe('image');
  if (normalized.kind !== 'image') return;
  expect(normalized.from).toEqual({ w: 2576, h: 168, bytes: png.length });
  expect(normalized.to.w).toBe(2048);
  expect(normalized.to.h).toBe(134);
  expect(normalized.mediaType).toBe('image/jpeg');
  expect(normalized.base64.length).toBeLessThan(1_500_000);
  expect(normalized.to.bytes).toBeLessThan(png.length);

  const prepared = await prepareRequestImage(png, '/tmp/clip-20261125-132107.png', { mediaType: 'image/png' });
  expect(prepared.block.type).toBe('image');
  expect(prepared.notice).toBe('<image_resize_notice>\nImage 1 of 1 in the preceding user message was resized from 2576x168 to 2048x134 pixels.\n</image_resize_notice>');
  expect(prepared.droppedNote).toBeUndefined();
});

test('a small PNG is sent as its original bytes (no re-encode, no notice)', async () => {
  const tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const prepared = await prepareRequestImage(Buffer.from(tiny, 'base64'), '/tmp/one.png');
  expect(prepared.block).toEqual({ type: 'image', mediaType: 'image/png', base64: tiny });
  expect(prepared.notice).toBeUndefined();
});

test('an image that cannot fit becomes a path note — never an error', async () => {
  const png = await noisePng(1200, 1200);
  const prepared = await prepareRequestImage(png, '/tmp/huge.png', { maxB64Chars: 40_000 });
  expect(prepared.block).toEqual({ type: 'text', text: '[image too large — sent as path only: /tmp/huge.png]' });
  expect(prepared.droppedNote).toBe('[image too large — sent as path only: /tmp/huge.png]');
  const garbage = await prepareRequestImage(Buffer.alloc(3_000_000, 7), '/tmp/broken.png');
  expect(garbage.block).toEqual({ type: 'text', text: '[image too large — sent as path only: /tmp/broken.png]' });
});

test('inline image payloads are measured apart from text', () => {
  const body = JSON.stringify({ input: [{ role: 'user', content: [
    { type: 'input_text', text: 'x'.repeat(1000) },
    { type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(50_000)}`, detail: 'auto' },
  ] }] });
  expect(measureInlineImageChars(body)).toEqual({ count: 1, chars: 50_000 });
  expect(requestTextChars(body)).toBe(body.length - 50_000);
});

test('wire budget: newest 8 images kept, older ones and oversize ones become a text note', () => {
  const img = (n: number) => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${'B'.repeat(n)}`, detail: 'auto' });
  const input = [
    ...Array.from({ length: 9 }, () => ({ role: 'user', content: [img(10)] })),
    { role: 'user', content: [{ type: 'input_text', text: 'look' }, img(1_600_000)] },
  ];
  const result = enforceResponsesImageBudget(input);
  expect(result.kept).toBe(8);
  expect(result.dropped).toBe(2);
  expect(result.droppedReasons).toEqual(['too-large', 'too-many']);
  expect(result.input[9]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_text', text: '[image too large — sent as path only]' }] });
  expect(result.input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: '[image too large — sent as path only]' }] });
  expect(input[0]!.content[0]).toEqual(img(10));
});

test('Codex guard: 125k text + a 1.46M-char image is sent (no compaction, not blocked)', async () => {
  const { bodies, compactCalls, answer, error } = await guardedTurn([
    { role: 'user', content: [
      { type: 'text', text: 'y'.repeat(125_000) },
      { type: 'image', mediaType: 'image/jpeg', base64: 'C'.repeat(1_460_000) },
    ] },
  ]);
  expect(error).toBeNull();
  expect(answer).toContain('Seen.');
  expect(compactCalls).toBe(0);
  expect(bodies.length).toBe(1);
  expect(bodies[0]!.length).toBeGreaterThan(1_500_000);
  const input = (JSON.parse(bodies[0]!) as { input: unknown[] }).input;
  const shape = summarizeRequestParts(input);
  expect(shape.inputImages).toBe(1);
  expect(shape.inputImageChars).toBe(1_460_000);
  expect(shape.base64InTextParts).toBe(0);
});

test('Codex guard: an oversize image is replaced by a note and the turn still completes', async () => {
  const { bodies, answer, error } = await guardedTurn([
    { role: 'user', content: [
      { type: 'text', text: 'what is this' },
      { type: 'image', mediaType: 'image/png', base64: 'D'.repeat(2_000_000) },
    ] },
  ]);
  expect(error).toBeNull();
  expect(answer).toContain('Seen.');
  expect(bodies.length).toBe(1);
  expect(bodies[0]!.length).toBeLessThan(100_000);
  expect(bodies[0]!).toContain('[image too large — sent as path only]');
});

test('Codex guard: the text cap is unchanged for text (450k chars of text is still blocked)', async () => {
  const { bodies, compactCalls, answer } = await guardedTurn([
    { role: 'user', content: 'z'.repeat(450_000) },
  ]);
  expect(compactCalls).toBe(1);
  expect(bodies.length).toBe(0);
  expect(answer ?? '').not.toContain('Seen.');
});

test('Read on a 2576×168 PNG reaches Codex as a downscaled input_image with the resize notice; no base64 in text', async () => {
  const provider = codexProvider();
  const pngPath = join(root, 'clip-20261125-132107.png');
  writeFileSync(pngPath, await noisePng(2576, 168));
  const bodies: Array<{ input: Array<Record<string, unknown>> }> = [];
  await withFakeFetchDevice([{ url: 'https://chatgpt.com/backend-api/codex/responses', method: 'POST', response: (request) => {
    bodies.push(JSON.parse(String(request.body)) as { input: Array<Record<string, unknown>> });
    if (bodies.length === 1) {
      return sse([
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_read', name: 'Read', arguments: JSON.stringify({ file_path: pngPath }) } },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } },
      ]);
    }
    return sse(DONE);
  } }], async () => {
    await streamLLMWithTools([{ role: 'user', content: 'read the screenshot' }], {
      onText: () => {},
      dispatchTool: async (_name, args) => await dispatchRead(args),
    }, {
      provider, model: 'gpt-6.1-terra', sessionId: 'image-budget-read', maxTurns: 3,
      tools: [{ name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
    });
  });
  expect(bodies.length).toBe(2);
  const output = bodies[1]!.input.find((item) => item.type === 'function_call_output') as { output: Array<Record<string, unknown>> };
  const image = output.output.find((part) => part.type === 'input_image') as { image_url: string };
  expect(image.image_url.startsWith('data:image/jpeg;base64,')).toBe(true);
  expect(image.image_url.length).toBeLessThan(1_500_000);
  expect(output.output.some((part) => part.type === 'input_text'
    && String(part.text).includes('resized from 2576x168 to 2048x134 pixels'))).toBe(true);
  expect(summarizeRequestParts(bodies[1]!.input).base64InTextParts).toBe(0);
});
