// NEXUS · image-generate endpoint (PLAN-ipad-notes-obsidian-typora §5
// popup synergy follow-up · PR Y2 · 2026-05-17).
//
// iPad CodeMirror editor 의 "+AI Image" toolbar button 이 POST 하는
// endpoint. OpenAI gpt-image-2 wrapper — prompt + size + quality 받아서
// base64 PNG response 받음 + vault attachments/<yyyy-MM-dd>/<hash>.png
// 으로 fs.writeFile + vault-relative path return. iOS 가 그 path 로
// `![[<path>]]` caret insert.
//
// Endpoint shape
//   POST /v1/image/generate
//   Content-Type: application/json
//   Body:
//     {
//       prompt:    string  (required · 1-4000 chars)
//       size?:     '1024x1024' | '1536x1024' | '1024x1536' | '2048x2048'
//                              (default '1024x1024')
//       quality?:  'auto' | 'low' | 'medium' | 'high' (default 'auto')
//     }
//
// Response (201)
//   {
//     ok:          true,
//     knowledgeId: 'attachments/2026-05-17/abc123.png',
//     path:        '/abs/path/to/vault/attachments/...png',
//     vaultLabel:  string,
//     savedAt:     ISO,
//     sizeBytes:   number,
//     mimeType:    'image/png',
//   }
//
// Error responses
//   400  — missing/invalid prompt or size
//   401  — checkAuth false
//   500  — OpenAI failure (rate limit, invalid key, network)
//   503  — vault not wired OR OPENAI_API_KEY missing
//
// OpenAI gpt-image-2 spec (verified via omni-crawl 2026-05-17):
//   - model: 'gpt-image-2'
//   - endpoint: POST https://api.openai.com/v1/images/generations
//   - params: model, prompt, n, size, quality, response_format,
//             background, output_compression
//   - response_format='b64_json' → response.data[0].b64_json (PNG bytes)
//   - organization verification required (Tier ≥ 5 for high rates)
//
// File layout convention
//   vault root/
//     attachments/
//       2026-05-17/
//         <sha256-first-12-chars>.png
//   - day bucket so vault tree doesn't explode at one dir level
//   - sha256(prompt+ts) for deterministic uniqueness without random
//   - .png because gpt-image-2 default; future variants pick by mime

import { assertVaultWriteAllowed } from '../../obsidian/vault-write-guard.js';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ObsidianVault } from '../../auto-research/obsidian-bridge.js';
import { debug } from '../../debug/log.js';

export interface ImageGenerateOpts {
  /** Vault to write into. runNexus wires from `discoverObsidianVault()`. */
  vault?: ObsidianVault;
  /** OpenAI API key. Defaults to OPENAI_API_KEY env. nil-able for tests
   *  that want to stub the fetch entirely. */
  openaiApiKey?: () => string | undefined;
  /** Same auth surface as sibling endpoints (notes-save etc). */
  checkAuth?: (req: Request) => boolean;
  /** Wall-clock seam for deterministic test hashes. */
  now?: () => number;
  /** Fetch seam — production passes globalThis.fetch, tests inject a
   *  fake that returns a canned OpenAI response. */
  fetchFn?: typeof fetch;
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '600',
};

const ALLOWED_SIZES = new Set([
  '1024x1024', '1536x1024', '1024x1536', '2048x2048', '3840x2160',
]);
const ALLOWED_QUALITIES = new Set(['auto', 'low', 'medium', 'high']);
const DEFAULT_SIZE = '1024x1024';
const DEFAULT_QUALITY = 'auto';
const MAX_PROMPT_LEN = 4000;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

function badRequest(reason: string): Response {
  return jsonResponse({ ok: false, error: 'bad_request', reason }, 400);
}

function dayBucket(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function buildRelPath(opts: { ts: number; prompt: string }): string {
  const day = dayBucket(opts.ts);
  const hash = createHash('sha256')
    .update(`${opts.prompt}::${opts.ts}`)
    .digest('hex')
    .slice(0, 12);
  return `attachments/${day}/${hash}.png`;
}

/** POST /v1/image/generate — generate an image via gpt-image-2 and
 *  persist into the vault attachments dir. */
export async function handleImageGenerate(
  req: Request,
  opts: ImageGenerateOpts,
): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (opts.checkAuth && !opts.checkAuth(req)) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
  }

  if (!opts.vault) {
    return jsonResponse({ ok: false, error: 'image_vault_not_wired' }, 503);
  }
  const apiKey = opts.openaiApiKey?.();
  if (!apiKey || apiKey.length === 0) {
    return jsonResponse({
      ok: false,
      error: 'openai_key_missing',
      reason: 'OPENAI_API_KEY env var required for gpt-image-2',
    }, 503);
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return badRequest('invalid JSON body'); }

  const b = body as {
    prompt?: unknown;
    negativePrompt?: unknown;
    size?: unknown;
    quality?: unknown;
  };

  if (typeof b.prompt !== 'string' || b.prompt.trim().length === 0) {
    return badRequest('prompt required (non-empty string)');
  }
  let prompt = b.prompt.trim();
  if (prompt.length > MAX_PROMPT_LEN) {
    return badRequest(`prompt too long (max ${MAX_PROMPT_LEN} chars)`);
  }
  // B5 (Y2 follow-up · 2026-05-17) — negative prompt support. OpenAI
  // Images API doesn't accept a dedicated negative_prompt parameter
  // (that's Stable Diffusion / Midjourney convention); the standard
  // workaround is to append an "Avoid: …" clause to the main prompt.
  // gpt-image-2 understands natural-language negative steering well
  // enough that this trivial concatenation works.
  if (typeof b.negativePrompt === 'string') {
    const neg = b.negativePrompt.trim();
    if (neg.length > 0) {
      const combined = `${prompt}\n\nAvoid: ${neg}`;
      if (combined.length > MAX_PROMPT_LEN) {
        return badRequest(`prompt + negativePrompt too long (combined > ${MAX_PROMPT_LEN} chars)`);
      }
      prompt = combined;
    }
  }
  const size = typeof b.size === 'string' ? b.size : DEFAULT_SIZE;
  if (!ALLOWED_SIZES.has(size)) {
    return badRequest(`size must be one of ${Array.from(ALLOWED_SIZES).join(', ')}`);
  }
  const quality = typeof b.quality === 'string' ? b.quality : DEFAULT_QUALITY;
  if (!ALLOWED_QUALITIES.has(quality)) {
    return badRequest(`quality must be one of ${Array.from(ALLOWED_QUALITIES).join(', ')}`);
  }

  const now = opts.now ?? Date.now;
  const ts = now();
  const savedAt = new Date(ts).toISOString();

  // ── OpenAI gpt-image-2 call ───────────────────────────────────────
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  let openaiResp: Response;
  try {
    openaiResp = await fetchFn('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt,
        n: 1,
        size,
        quality,
        response_format: 'b64_json',
      }),
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: 'openai_network_failure',
      reason: (err as Error).message ?? String(err),
    }, 500);
  }

  if (!openaiResp.ok) {
    let detail: unknown = null;
    try { detail = await openaiResp.json(); } catch { /* swallow */ }
    return jsonResponse({
      ok: false,
      error: 'openai_error',
      status: openaiResp.status,
      reason: detail ?? (await openaiResp.text().catch(() => 'unknown')),
    }, 500);
  }

  let openaiBody: { data?: Array<{ b64_json?: string }> };
  try {
    openaiBody = await openaiResp.json() as typeof openaiBody;
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: 'openai_response_malformed',
      reason: (err as Error).message ?? String(err),
    }, 500);
  }
  const b64 = openaiBody.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || b64.length === 0) {
    return jsonResponse({
      ok: false,
      error: 'openai_response_missing_image',
      reason: 'data[0].b64_json absent',
    }, 500);
  }

  // ── Write to vault attachments dir ───────────────────────────────
  const relPath = buildRelPath({ ts, prompt });
  const absPath = join(opts.vault.root, relPath);
  try {
    assertVaultWriteAllowed(absPath);   // ⛔ 격리 우주는 운영 볼트에 쓰지 않는다(아래 catch 가 500 과 사유로 돌려준다)
    mkdirSync(dirname(absPath), { recursive: true });
    const bytes = Buffer.from(b64, 'base64');
    writeFileSync(absPath, bytes);
    if (debug.enabled) {
      debug.log('image-generate.write', relPath, {
        vault: opts.vault.label,
        size,
        quality,
        promptChars: prompt.length,
        bytes: bytes.length,
      });
    }
    return jsonResponse({
      ok: true,
      knowledgeId: relPath,
      path: absPath,
      vaultLabel: opts.vault.label,
      savedAt,
      sizeBytes: bytes.length,
      mimeType: 'image/png',
    }, 201);
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: 'vault_write_failed',
      reason: (err as Error).message ?? String(err),
    }, 500);
  }
}

// B3 / Y2 image regenerate (PLAN-ipad-notes-obsidian-typora §5
// follow-up · 2026-05-17) — sibling endpoint for OpenAI Images Edits
// API. Accepts an existing image (base64) + prompt → applies the
// edit → saves result to vault attachments same as handleImageGenerate.
//
// Endpoint shape
//   POST /v1/image/edit
//   Body:
//     {
//       prompt:          string  (required · 1-4000 chars)
//       sourceBase64:    string  (required · PNG of existing image to edit)
//       maskBase64?:     string  (optional · PNG transparency mask)
//       size?:           '1024x1024' | '1536x1024' | '1024x1536'
//       quality?:        'auto' | 'low' | 'medium' | 'high'
//     }
//
// Response shape identical to /v1/image/generate. Caller (iPad image
// gen sheet "Regenerate" button) chains: pick existing inline image →
// new prompt → POST /v1/image/edit → caret replace with new wikilink.
export async function handleImageEdit(
  req: Request,
  opts: ImageGenerateOpts,
): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (opts.checkAuth && !opts.checkAuth(req)) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
  }

  if (!opts.vault) {
    return jsonResponse({ ok: false, error: 'image_vault_not_wired' }, 503);
  }
  const apiKey = opts.openaiApiKey?.();
  if (!apiKey || apiKey.length === 0) {
    return jsonResponse({
      ok: false,
      error: 'openai_key_missing',
      reason: 'OPENAI_API_KEY env var required for gpt-image-2 edits',
    }, 503);
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return badRequest('invalid JSON body'); }

  const b = body as {
    prompt?: unknown;
    sourceBase64?: unknown;
    maskBase64?: unknown;
    size?: unknown;
    quality?: unknown;
  };

  if (typeof b.prompt !== 'string' || b.prompt.trim().length === 0) {
    return badRequest('prompt required (non-empty string)');
  }
  if (typeof b.sourceBase64 !== 'string' || b.sourceBase64.length === 0) {
    return badRequest('sourceBase64 required (PNG bytes as base64)');
  }
  const prompt = b.prompt.trim();
  if (prompt.length > MAX_PROMPT_LEN) {
    return badRequest(`prompt too long (max ${MAX_PROMPT_LEN} chars)`);
  }
  const size = typeof b.size === 'string' ? b.size : DEFAULT_SIZE;
  if (!ALLOWED_SIZES.has(size)) {
    return badRequest(`size must be one of ${Array.from(ALLOWED_SIZES).join(', ')}`);
  }
  const quality = typeof b.quality === 'string' ? b.quality : DEFAULT_QUALITY;
  if (!ALLOWED_QUALITIES.has(quality)) {
    return badRequest(`quality must be one of ${Array.from(ALLOWED_QUALITIES).join(', ')}`);
  }
  let sourceBytes: Buffer;
  try {
    sourceBytes = Buffer.from(b.sourceBase64, 'base64');
    if (sourceBytes.length === 0) throw new Error('empty');
  } catch {
    return badRequest('sourceBase64 must be valid base64-encoded PNG bytes');
  }
  let maskBytes: Buffer | null = null;
  if (typeof b.maskBase64 === 'string' && b.maskBase64.length > 0) {
    try {
      maskBytes = Buffer.from(b.maskBase64, 'base64');
    } catch {
      return badRequest('maskBase64 must be valid base64-encoded PNG bytes when supplied');
    }
  }

  const now = opts.now ?? Date.now;
  const ts = now();
  const savedAt = new Date(ts).toISOString();

  // ── Build multipart form for OpenAI Images Edits ────────────────
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('quality', quality);
  form.append('n', '1');
  form.append('image', new Blob([new Uint8Array(sourceBytes)], { type: 'image/png' }), 'source.png');
  if (maskBytes) {
    form.append('mask', new Blob([new Uint8Array(maskBytes)], { type: 'image/png' }), 'mask.png');
  }

  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  let openaiResp: Response;
  try {
    openaiResp = await fetchFn('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        // Note: content-type set automatically by fetch for FormData
        // (includes the multipart boundary). Omit explicit header.
      },
      body: form,
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: 'openai_network_failure',
      reason: (err as Error).message ?? String(err),
    }, 500);
  }

  if (!openaiResp.ok) {
    let detail: unknown = null;
    try { detail = await openaiResp.json(); } catch { /* swallow */ }
    return jsonResponse({
      ok: false,
      error: 'openai_error',
      status: openaiResp.status,
      reason: detail ?? (await openaiResp.text().catch(() => 'unknown')),
    }, 500);
  }

  let openaiBody: { data?: Array<{ b64_json?: string }> };
  try {
    openaiBody = await openaiResp.json() as typeof openaiBody;
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: 'openai_response_malformed',
      reason: (err as Error).message ?? String(err),
    }, 500);
  }
  const b64 = openaiBody.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || b64.length === 0) {
    return jsonResponse({
      ok: false,
      error: 'openai_response_missing_image',
      reason: 'data[0].b64_json absent in edit response',
    }, 500);
  }

  const relPath = buildRelPath({ ts, prompt: `edit:${prompt}` });
  const absPath = join(opts.vault.root, relPath);
  try {
    assertVaultWriteAllowed(absPath);   // ⛔ 격리 우주는 운영 볼트에 쓰지 않는다(아래 catch 가 500 과 사유로 돌려준다)
    mkdirSync(dirname(absPath), { recursive: true });
    const bytes = Buffer.from(b64, 'base64');
    writeFileSync(absPath, bytes);
    if (debug.enabled) {
      debug.log('image-edit.write', relPath, {
        vault: opts.vault.label,
        size,
        quality,
        promptChars: prompt.length,
        sourceBytes: sourceBytes.length,
        maskBytes: maskBytes?.length ?? 0,
        bytes: bytes.length,
      });
    }
    return jsonResponse({
      ok: true,
      knowledgeId: relPath,
      path: absPath,
      vaultLabel: opts.vault.label,
      savedAt,
      sizeBytes: bytes.length,
      mimeType: 'image/png',
    }, 201);
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: 'vault_write_failed',
      reason: (err as Error).message ?? String(err),
    }, 500);
  }
}

// Re-export for caller convenience — same pattern as notes-save.
export const __TEST__ = { buildRelPath, dayBucket };

// Silence unused — `existsSync` was used in an earlier draft to skip
// duplicates; current path uses sha256(prompt+ts) so collisions are
// effectively impossible. Kept the import slot so future "skip on
// existing" follow-up doesn't need to re-add it.
void existsSync;
