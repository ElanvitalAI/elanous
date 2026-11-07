// PR Y2 (PLAN §5 popup synergy follow-up · 2026-05-17) — tests for the
// daemon-side image-generate endpoint (gpt-image-2 wrapper + vault
// attachments PNG write). Covers validation surface + happy path with
// fetch seam stubbed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectMalformedJson400 } from './helpers/http-error-contract';

import { handleImageGenerate } from '../src/nexus/api/image-generate.js';
import type { ObsidianVault } from '../src/auto-research/obsidian-bridge.js';

let tmpRoot: string;
let testVault: ObsidianVault;

// 1x1 transparent PNG, base64. Same bytes the daemon would persist
// from a real gpt-image-2 b64_json response.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-image-gen-test-'));
  testVault = { root: tmpRoot, isSimulated: true, label: 'test-vault' };
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* swallow */ }
});

function makePost(body: unknown): Request {
  return new Request('http://localhost/v1/image/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function stubOpenAI(b64: string = TINY_PNG_B64): typeof fetch {
  return (async (url: any, init: any) => {
    expect(String(url)).toContain('api.openai.com/v1/images/generations');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('gpt-image-2');
    expect(body.response_format).toBe('b64_json');
    return new Response(
      JSON.stringify({ data: [{ b64_json: b64 }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

describe('handleImageGenerate · CORS preflight', () => {
  test('OPTIONS → 204', async () => {
    const req = new Request('http://localhost/v1/image/generate', { method: 'OPTIONS' });
    const res = await handleImageGenerate(req, { vault: testVault });
    expect(res.status).toBe(204);
  });
});

describe('handleImageGenerate · dep injection', () => {
  test('omitted vault → 503', async () => {
    const res = await handleImageGenerate(
      makePost({ prompt: 'cat' }),
      { openaiApiKey: () => 'sk-test' },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('image_vault_not_wired');
  });

  test('missing openaiApiKey → 503', async () => {
    const res = await handleImageGenerate(
      makePost({ prompt: 'cat' }),
      { vault: testVault, openaiApiKey: () => undefined },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('openai_key_missing');
  });
});

describe('handleImageGenerate · validation', () => {
  const opts = () => ({
    vault: testVault,
    openaiApiKey: () => 'sk-test',
    fetchFn: stubOpenAI(),
  });

  test('missing prompt → 400', async () => {
    const res = await handleImageGenerate(makePost({}), opts());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toContain('prompt required');
  });

  test('empty prompt → 400', async () => {
    const res = await handleImageGenerate(makePost({ prompt: '   ' }), opts());
    expect(res.status).toBe(400);
  });

  test('prompt > 4000 chars → 400', async () => {
    const long = 'x'.repeat(4001);
    const res = await handleImageGenerate(makePost({ prompt: long }), opts());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toContain('too long');
  });

  test('invalid size → 400', async () => {
    const res = await handleImageGenerate(
      makePost({ prompt: 'cat', size: '13x37' }),
      opts(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toContain('size must be one of');
  });

  test('invalid quality → 400', async () => {
    const res = await handleImageGenerate(
      makePost({ prompt: 'cat', quality: 'ultra' }),
      opts(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toContain('quality must be one of');
  });

  test('invalid JSON body → 400', async () => {
    const req = new Request('http://localhost/v1/image/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    const res = await handleImageGenerate(req, opts());
    await expectMalformedJson400(res);
  });
});

describe('handleImageGenerate · auth', () => {
  test('checkAuth returns false → 401', async () => {
    const res = await handleImageGenerate(
      makePost({ prompt: 'cat' }),
      {
        vault: testVault,
        openaiApiKey: () => 'sk-test',
        checkAuth: () => false,
        fetchFn: stubOpenAI(),
      },
    );
    expect(res.status).toBe(401);
  });
});

describe('handleImageGenerate · happy path', () => {
  test('valid request → PNG written + 201 response shape', async () => {
    const res = await handleImageGenerate(
      makePost({ prompt: 'a calico cat on a window sill at sunset' }),
      {
        vault: testVault,
        openaiApiKey: () => 'sk-test',
        fetchFn: stubOpenAI(),
        now: () => new Date('2026-05-17T12:34:56Z').getTime(),
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as {
      ok: boolean; knowledgeId: string; path: string;
      sizeBytes: number; mimeType: string;
    };
    expect(body.ok).toBe(true);
    expect(body.mimeType).toBe('image/png');
    expect(body.knowledgeId.startsWith('attachments/2026-05-17/')).toBe(true);
    expect(body.knowledgeId.endsWith('.png')).toBe(true);
    expect(existsSync(body.path)).toBe(true);
    const written = statSync(body.path);
    expect(written.size).toBeGreaterThan(0);
    expect(body.sizeBytes).toBe(written.size);
    // Verify the raw bytes were what we stubbed (PNG signature 0x89 0x50…).
    const buf = readFileSync(body.path);
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  test('two identical prompts at different ts produce different files', async () => {
    let counter = 0;
    const tsFn = () => 1700000000000 + counter++;
    const r1 = await handleImageGenerate(
      makePost({ prompt: 'duplicate prompt' }),
      {
        vault: testVault,
        openaiApiKey: () => 'sk-test',
        fetchFn: stubOpenAI(),
        now: tsFn,
      },
    );
    const r2 = await handleImageGenerate(
      makePost({ prompt: 'duplicate prompt' }),
      {
        vault: testVault,
        openaiApiKey: () => 'sk-test',
        fetchFn: stubOpenAI(),
        now: tsFn,
      },
    );
    const b1 = await r1.json() as { knowledgeId: string };
    const b2 = await r2.json() as { knowledgeId: string };
    expect(b1.knowledgeId).not.toBe(b2.knowledgeId);
  });
});

describe('handleImageGenerate · OpenAI errors', () => {
  test('OpenAI non-200 → 500 with reason', async () => {
    const fetchFn = (async () => new Response(
      JSON.stringify({ error: { message: 'rate limit' } }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const res = await handleImageGenerate(
      makePost({ prompt: 'cat' }),
      { vault: testVault, openaiApiKey: () => 'sk-test', fetchFn },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('openai_error');
    expect(body.status).toBe(429);
  });

  test('OpenAI response missing b64_json → 500', async () => {
    const fetchFn = (async () => new Response(
      JSON.stringify({ data: [{}] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const res = await handleImageGenerate(
      makePost({ prompt: 'cat' }),
      { vault: testVault, openaiApiKey: () => 'sk-test', fetchFn },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('openai_response_missing_image');
  });

  test('fetch throws → 500 with network failure error', async () => {
    const fetchFn = (async () => { throw new Error('ENETDOWN'); }) as unknown as typeof fetch;
    const res = await handleImageGenerate(
      makePost({ prompt: 'cat' }),
      { vault: testVault, openaiApiKey: () => 'sk-test', fetchFn },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('openai_network_failure');
  });

  // B5 (Y2 follow-up · 2026-05-17) — negative prompt support.
  test('negativePrompt appended as "Avoid: …" to main prompt', async () => {
    let capturedPrompt: string = '';
    const fetchFn = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body as string) as { prompt: string };
      capturedPrompt = body.prompt;
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const res = await handleImageGenerate(
      makePost({ prompt: 'a sunset', negativePrompt: 'text, watermark' }),
      { vault: testVault, openaiApiKey: () => 'sk-test', fetchFn },
    );
    expect(res.status).toBe(201);
    expect(capturedPrompt).toContain('a sunset');
    expect(capturedPrompt).toContain('Avoid: text, watermark');
  });

  test('negativePrompt empty/whitespace → omitted from prompt', async () => {
    let capturedPrompt: string = '';
    const fetchFn = (async (_url: any, init: any) => {
      capturedPrompt = (JSON.parse(init.body as string) as { prompt: string }).prompt;
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const res = await handleImageGenerate(
      makePost({ prompt: 'a sunset', negativePrompt: '   ' }),
      { vault: testVault, openaiApiKey: () => 'sk-test', fetchFn },
    );
    expect(res.status).toBe(201);
    expect(capturedPrompt).toBe('a sunset');
    expect(capturedPrompt).not.toContain('Avoid');
  });

  test('prompt + negative combined > MAX_PROMPT_LEN → 400', async () => {
    const longPrompt = 'a'.repeat(3990);
    const longNeg = 'b'.repeat(30);
    const res = await handleImageGenerate(
      makePost({ prompt: longPrompt, negativePrompt: longNeg }),
      { vault: testVault, openaiApiKey: () => 'sk-test' },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toContain('combined');
  });
});

// B3 / Y2 follow-up — handleImageEdit (OpenAI Images Edits endpoint
// + vault write). Tests the validation + multipart form construction
// + happy path round-trip via fetch seam.
describe('handleImageEdit · validation', () => {
  function makeEditPost(body: unknown): Request {
    return new Request('http://localhost/v1/image/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function opts(): { vault: ObsidianVault; openaiApiKey: () => string } {
    return {
      vault: testVault,
      openaiApiKey: () => 'sk-test',
    };
  }

  test('missing prompt → 400', async () => {
    const { handleImageEdit } = await import('../src/nexus/api/image-generate.js');
    const res = await handleImageEdit(makeEditPost({ sourceBase64: TINY_PNG_B64 }), opts());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('bad_request');
    expect(body.reason).toContain('prompt');
  });

  test('missing sourceBase64 → 400', async () => {
    const { handleImageEdit } = await import('../src/nexus/api/image-generate.js');
    const res = await handleImageEdit(makeEditPost({ prompt: 'add flowers' }), opts());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('bad_request');
    expect(body.reason).toContain('sourceBase64');
  });

  test('invalid base64 in sourceBase64 → 400', async () => {
    const { handleImageEdit } = await import('../src/nexus/api/image-generate.js');
    // empty string after decode → caught as "empty"
    const res = await handleImageEdit(
      makeEditPost({ prompt: 'x', sourceBase64: '' }),
      opts(),
    );
    expect(res.status).toBe(400);
  });

  test('vault not wired → 503', async () => {
    const { handleImageEdit } = await import('../src/nexus/api/image-generate.js');
    const res = await handleImageEdit(
      makeEditPost({ prompt: 'x', sourceBase64: TINY_PNG_B64 }),
      { openaiApiKey: () => 'sk-test' },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('image_vault_not_wired');
  });

  test('OPENAI_API_KEY missing → 503', async () => {
    const { handleImageEdit } = await import('../src/nexus/api/image-generate.js');
    const res = await handleImageEdit(
      makeEditPost({ prompt: 'x', sourceBase64: TINY_PNG_B64 }),
      { vault: testVault, openaiApiKey: () => undefined },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('openai_key_missing');
  });
});

describe('handleImageEdit · happy path', () => {
  function makeEditPost(body: unknown): Request {
    return new Request('http://localhost/v1/image/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function stubOpenAIEdit(b64: string = TINY_PNG_B64): typeof fetch {
    return (async (url: any, init: any) => {
      expect(String(url)).toContain('api.openai.com/v1/images/edits');
      expect(init?.method).toBe('POST');
      // Multipart body — verify it carries the form parts we sent.
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('gpt-image-2');
      expect(typeof form.get('prompt')).toBe('string');
      expect(form.get('image')).toBeDefined();
      return new Response(
        JSON.stringify({ data: [{ b64_json: b64 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
  }

  test('valid request → 201 + vault attachments path', async () => {
    const { handleImageEdit } = await import('../src/nexus/api/image-generate.js');
    const res = await handleImageEdit(
      makeEditPost({ prompt: 'add a rainbow', sourceBase64: TINY_PNG_B64 }),
      {
        vault: testVault,
        openaiApiKey: () => 'sk-test',
        fetchFn: stubOpenAIEdit(),
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; knowledgeId: string; sizeBytes: number };
    expect(body.ok).toBe(true);
    expect(body.knowledgeId).toMatch(/^attachments\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{12}\.png$/);
    expect(body.sizeBytes).toBeGreaterThan(0);
    // Verify the file actually landed.
    const absPath = join(tmpRoot, body.knowledgeId);
    expect(existsSync(absPath)).toBe(true);
  });

  test('mask supplied → multipart includes mask part', async () => {
    const { handleImageEdit } = await import('../src/nexus/api/image-generate.js');
    let sawMask = false;
    const fetchFn = (async (_url: any, init: any) => {
      const form = init?.body as FormData;
      sawMask = form.get('mask') !== null;
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const res = await handleImageEdit(
      makeEditPost({
        prompt: 'x', sourceBase64: TINY_PNG_B64, maskBase64: TINY_PNG_B64,
      }),
      { vault: testVault, openaiApiKey: () => 'sk-test', fetchFn },
    );
    expect(res.status).toBe(201);
    expect(sawMask).toBe(true);
  });

  test('OpenAI 4xx → 500 with openai_error', async () => {
    const { handleImageEdit } = await import('../src/nexus/api/image-generate.js');
    const fetchFn = (async () => new Response(
      JSON.stringify({ error: { message: 'rate_limited' } }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const res = await handleImageEdit(
      makeEditPost({ prompt: 'x', sourceBase64: TINY_PNG_B64 }),
      { vault: testVault, openaiApiKey: () => 'sk-test', fetchFn },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('openai_error');
    expect(body.status).toBe(429);
  });
});

// Suppress unused var warning on TINY_PNG_B64 + statSync in import line
// (used above).
void statSync;
void readFileSync;
