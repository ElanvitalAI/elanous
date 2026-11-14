// Upstage OCR — TypeScript port of `~/.claude/skills/photo-intake-ocr/
// scripts/upstage_ocr.py`.
//
// Why ported here: the photo-intake-ocr skill (user-side · Claude
// Code) calls Upstage from a Python script that runs in the user's
// shell. The monad-agent daemon needs the same capability server-
// side so the PWA's camera intake (R-OCR.1+ roadmap) can pipe
// `/v1/attachments` blobs through Upstage OCR without bouncing back
// to the Python script. Same API key + same env-var fallback chain;
// callers stay portable across both surfaces.
//
// API surface (Upstage 2026-05): POST
// https://api.upstage.ai/v1/document-digitization with
// `Authorization: Bearer <key>` and `multipart/form-data` carrying
// `model=ocr` + `document=<file blob>`. Response JSON has a `text`
// field with the recognized text (text-only mode) plus per-page /
// per-element layout when the full payload is requested.
//
// Cross-ref:
//   ~/.claude/skills/photo-intake-ocr/scripts/upstage_ocr.py (origin)
//   내부 문서 `ROADMAP-pwa-pre-ios-gap-2026-05-09` (R-OCR roadmap)

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getSecret, getSecretAsync } from '../nexus/config/secrets/index.js';

import { OcrProvider, ocrFailure } from './provider.js';
import type {
  OcrCapabilities,
  OcrInput,
  OcrResult,
} from './types.js';

const UPSTAGE_BASE_URL = 'https://api.upstage.ai/v1';

/** The URL override is deliberately unavailable outside an isolated test run. */
export function upstageBaseUrl(): string {
  if (process.env.NODE_ENV !== 'test') return UPSTAGE_BASE_URL;
  const override = process.env.UPSTAGE_BASE_URL;
  if (!override) return UPSTAGE_BASE_URL;
  const url = new URL(override);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' ||
    url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/v1')
    throw new Error('UPSTAGE_BASE_URL must be a loopback HTTP /v1 test server');
  return `${url.origin}/v1`;
}

/** Upstage 2026 model surface (verified 2026-05 via console docs +
 *  https://upstage.ai/pricing/api):
 *
 *    'ocr' / 'ocr-250904' — $0.0015/page · word-level bboxes +
 *      confidence + recognized text. Cheapest. No markdown / table
 *      structure — caller picks structure later.
 *    'document-parse' — $0.01/page (standard) · returns native
 *      HTML / Markdown / plain-text with tables + figures preserved.
 *      The right default for the PWA "photo → markdown" flow since
 *      it skips a downstream LLM cleanup pass.
 *    'document-parse' enhanced — $0.03/page · richer layout for
 *      complex PDFs. Caller opts in via `opts.parseMode='enhanced'`.
 *
 *  Default = `document-parse` (standard) since the primary elanous-
 *  agent use case is the camera → markdown intake; the cheaper `ocr`
 *  model is one assignment away for callers that don't need
 *  markdown. */
const DEFAULT_MODEL = 'document-parse';

export type UpstageModel = 'ocr' | 'document-parse' | (string & {});

/** Document-parse mode — only honored when model='document-parse'.
 *  The Python skill origin defaulted to 'ocr' so this never came up;
 *  the 2026-05 omni-crawl audit revealed `document-parse` is the
 *  better fit for our markdown flow. */
export type ParseMode = 'standard' | 'enhanced' | 'auto';

/** Upstage's published max accepted response time (CDN-fronted GPU
 *  inference). 5 minutes is generous; PWA callers will typically
 *  abort earlier via their own AbortSignal. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface UpstageOcrError {
  ok: false;
  /** Where the failure happened — `auth` (no key), `network` (fetch
   *  threw), `http` (non-2xx response), `parse` (unexpected JSON
   *  shape). */
  stage: 'auth' | 'network' | 'http' | 'parse';
  status?: number;
  message: string;
}

export interface UpstageOcrSuccess {
  ok: true;
  /** Plain extracted text — concatenated reading order. Empty
   *  string when the document has no detectable text (Upstage
   *  returns `text: ""`). Present for both `ocr` and
   *  `document-parse` model responses. */
  text: string;
  /** Markdown / HTML rendering — only present for `document-parse`
   *  responses. Upstage returns content under `content.markdown`
   *  and `content.html`; we surface the markdown for the camera-
   *  intake flow's primary use case (photo → markdown note).
   *  Empty string when the response shape doesn't include it. */
  markdown: string;
  /** HTML rendering — same source as `markdown` but in HTML.
   *  Surfaced separately for callers that want to preserve table
   *  formatting in a richer renderer. */
  html: string;
  /** Full Upstage payload — pages, elements, confidence scores,
   *  bboxes — for callers that need layout (table cells, reading
   *  order, figure regions). */
  raw: Record<string, unknown>;
}

export type UpstageOcrResult = UpstageOcrSuccess | UpstageOcrError;

export interface UpstageOcrOpts {
  /** File blob to OCR. Accepts Buffer (server-side fs.readFile),
   *  Uint8Array, or Blob (PWA upload pass-through). */
  file: Buffer | Uint8Array | Blob;
  /** Original filename — used for the multipart `filename=` field
   *  (Upstage cares about the extension to pick a parser). */
  filename: string;
  /** Mime type override; defaults to `application/octet-stream`
   *  (Upstage detects from the extension when present). */
  mimeType?: string;
  /** Model override — see DEFAULT_MODEL. */
  model?: UpstageModel;
  /** Parse mode (only honored when model='document-parse'). */
  parseMode?: ParseMode;
  /** Use the async endpoint (`/v1/document-digitization/async`)
   *  for large PDFs (1000-page max). Sync endpoint caps at 100
   *  pages. v1 default = sync (camera images = single page).
   *  Async returns a job id — callers poll separately; this v1
   *  doesn't implement polling, so leave as `false` until the
   *  large-PDF flow ships. */
  useAsync?: boolean;
  /** Optional API key override (tests). Production resolves from
   *  env / cache / shell — see resolveUpstageApiKey. */
  apiKey?: string;
  /** Timeout in ms. Defaults to 5 min. */
  timeoutMs?: number;
  /** Test seam — replace global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — replace the api-key resolver. */
  resolveApiKey?: () => string | null;
}

/** Resolve the Upstage API key from (in order):
 *  1. canonical shared slot `cred:upstage.api_key`
 *  2. legacy `UPSTAGE_API_KEY` env
 *  3. legacy `~/.cache/upstage_api_key` plain-text file
 *  4. Re-source `~/.zshrc` and `printenv UPSTAGE_API_KEY` (handles
 *     the case where the daemon was launched without the user's
 *     interactive shell env)
 *  Returns null when not found anywhere. */
export function resolveUpstageApiKey(): string | null {
  try {
    const slotKey = getSecret('cred:upstage.api_key')?.trim();
    if (slotKey) return slotKey;
  } catch { /* non-sync secret backend: legacy read-only sources remain available */ }
  const envKey = (process.env.UPSTAGE_API_KEY ?? '').trim();
  if (envKey) return envKey;

  const cachePath = joinPath(homedir(), '.cache', 'upstage_api_key');
  if (existsSync(cachePath)) {
    try {
      const cached = readFileSync(cachePath, 'utf8').trim();
      if (cached) return cached;
    } catch { /* swallow — fall through */ }
  }

  // Last resort — re-source the user's interactive shell. Production
  // daemons launched via launchd/systemd often don't inherit shell
  // exports. The Python origin script does the same dance.
  try {
    const out = spawnSync(
      'zsh',
      ['-lc', 'source ~/.zshrc >/dev/null 2>&1; printenv UPSTAGE_API_KEY'],
      { encoding: 'utf8', timeout: 3000 },
    );
    if (out.status === 0) {
      const fromShell = (out.stdout ?? '').trim();
      if (fromShell) return fromShell;
    }
  } catch { /* swallow */ }

  return null;
}

/** Async callers can read a non-file secret backend before legacy sources. */
export async function resolveUpstageApiKeyAsync(): Promise<string | null> {
  try {
    const slotKey = (await getSecretAsync('cred:upstage.api_key'))?.trim();
    if (slotKey) return slotKey;
  } catch { /* preserve legacy read compatibility */ }
  return resolveUpstageApiKey();
}

function toBlob(file: Buffer | Uint8Array | Blob, mimeType: string): Blob {
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file;
  // Buffer / Uint8Array → Blob
  return new Blob([file as BlobPart], { type: mimeType });
}

/** Run Upstage OCR on a single file blob. Pure async function; no
 *  filesystem writes (caller is responsible for persisting the
 *  result). */
export async function runUpstageOcr(opts: UpstageOcrOpts): Promise<UpstageOcrResult> {
  const apiKey = opts.apiKey
    ?? (opts.resolveApiKey ? opts.resolveApiKey() : await resolveUpstageApiKeyAsync());
  if (!apiKey) {
    return {
      ok: false,
      stage: 'auth',
      message: 'Upstage 키 필요 · `eln setup upstage`',
    };
  }

  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const model = opts.model ?? DEFAULT_MODEL;
  const mimeType = opts.mimeType ?? 'application/octet-stream';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${upstageBaseUrl()}/document-digitization${opts.useAsync ? '/async' : ''}`;

  const form = new FormData();
  form.append('model', model);
  // Document-parse mode override — only forwarded when caller asked
  // for the parse model. Upstage rejects 'mode' on the OCR model.
  if (model === 'document-parse' && opts.parseMode) {
    form.append('mode', opts.parseMode);
  }
  // 2026-05-09 dogfood — explicitly request markdown + html + text in
  // the response. Without `output_formats` Upstage's `document-parse`
  // defaults to HTML only; the caller-side handler then sees
  // `markdown: ""` even though OCR succeeded with rich HTML output.
  // Sending a JSON array of formats matches Upstage's 2026 API spec
  // (see `~/.claude/skills/photo-intake-ocr/scripts/upstage_ocr.py`
  // origin script + console docs). Format is required to be a JSON
  // string, NOT a repeated form field.
  if (model === 'document-parse') {
    form.append('output_formats', JSON.stringify(['markdown', 'html', 'text']));
  }
  form.append('document', toBlob(opts.file, mimeType), opts.filename);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        // Don't set Content-Type — fetch + FormData computes the
        // multipart boundary header automatically. Manually setting
        // it (as the Python origin does) breaks the boundary
        // signature.
      },
      body: form,
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    return {
      ok: false,
      stage: 'network',
      message: 'Upstage OCR network request failed',
    };
  }
  clearTimeout(timer);

  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    return {
      ok: false,
      stage: 'http',
      status: res.status,
      message: `Upstage OCR HTTP ${res.status}`,
    };
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      stage: 'parse',
      message: 'Upstage OCR returned invalid JSON',
    };
  }

  // Document-parse responses nest the rendered output under
  // `content.{markdown,html,text}`; OCR responses surface plain
  // `text` at the top level. Read both shapes defensively so
  // callers don't have to branch on model.
  const text = typeof payload.text === 'string' ? payload.text : '';
  const content = (payload.content ?? {}) as Record<string, unknown>;
  const markdown = typeof content.markdown === 'string'
    ? content.markdown
    : (typeof payload.markdown === 'string' ? payload.markdown : '');
  const html = typeof content.html === 'string'
    ? content.html
    : (typeof payload.html === 'string' ? payload.html : '');
  // When document-parse returned only `content.text`, mirror it into
  // the top-level `text` field for parity with OCR responses.
  const finalText = text
    || (typeof content.text === 'string' ? content.text : '');
  return { ok: true, text: finalText, markdown, html, raw: payload };
}

// ───────────────── OcrProvider integration ─────────────────────

/** UpstageProvider — concrete OcrProvider wrapping `runUpstageOcr`.
 *  Declares the strengths Upstage is known for (Korean · tables ·
 *  handwriting · multilingual · low-quality scans) and the cost +
 *  output formats so the registry can pick it for matching tasks.
 *
 *  Add new providers (Tesseract · Apple VisionKit · Google Cloud
 *  Vision · Naver CLOVA · LLM Vision) by mirroring this shape:
 *  declare capabilities, implement run() / isAvailable(). The
 *  registry surface stays unchanged. */
export const UPSTAGE_CAPABILITIES: OcrCapabilities = {
  // Upstage's published language matrix (2026-05): Hangul / Hanja
  // primary; Hanzi / Kanji beta; multilingual auto. We declare the
  // top-level set; '*' acts as auto-detect for callers that just
  // pass a language hint without us tracking the full matrix.
  languages: ['*', 'ko', 'en', 'zh', 'ja'],
  outputs: ['text', 'markdown', 'html', 'layout', 'tables', 'bboxes', 'confidence'],
  inputs: ['image/*', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  strengths: ['korean', 'tables', 'handwriting', 'multilingual', 'low-quality', 'pdf-multipage'],
  // document-parse standard pricing as of 2026-05 omni-crawl audit.
  // Callers selecting model='ocr' get cheaper $0.0015/page but the
  // registry scores against the default model's cost — close enough
  // for tie-breaking purposes.
  costPerPageUsd: 0.01,
  async: true,
  emitsConfidence: true,
};

export class UpstageProvider extends OcrProvider {
  readonly name = 'upstage';
  readonly capabilities = UPSTAGE_CAPABILITIES;

  /** Constructor opts — production passes nothing; tests inject an
   *  `apiKeyResolver` to bypass the env / cache / shell chain. */
  constructor(
    private readonly providerOpts: {
      resolveApiKey?: () => string | null;
    } = {},
  ) {
    super();
  }

  isAvailable(): boolean | Promise<boolean> {
    if (this.providerOpts.resolveApiKey) return this.providerOpts.resolveApiKey() !== null;
    return resolveUpstageApiKeyAsync().then((key) => key !== null);
  }

  async run(input: OcrInput): Promise<OcrResult> {
    // Mime-type filter — Upstage accepts images + PDFs + a few
    // office formats. Reject anything else so the registry can
    // fall back to a different provider.
    const mime = input.mimeType ?? '';
    if (mime && !this.acceptsMime(mime)) {
      return ocrFailure(this.name, 'unsupported', `mime ${mime} not supported by Upstage`);
    }
    // Caller-tunable bits via providerOpts (escape hatch).
    const opts = (input.providerOpts ?? {}) as {
      model?: UpstageModel;
      parseMode?: ParseMode;
      useAsync?: boolean;
    };
    // Picking model: when caller asks for markdown explicitly, force
    // document-parse; when they only want text, drop to cheaper ocr.
    const inferredModel: UpstageModel = (() => {
      if (opts.model) return opts.model;
      if (input.preferredOutput === 'text') return 'ocr';
      return 'document-parse';
    })();
    const result = await runUpstageOcr({
      file: input.file,
      filename: input.filename,
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      model: inferredModel,
      ...(opts.parseMode !== undefined ? { parseMode: opts.parseMode } : {}),
      ...(opts.useAsync !== undefined ? { useAsync: opts.useAsync } : {}),
      ...(this.providerOpts.resolveApiKey !== undefined
        ? { resolveApiKey: this.providerOpts.resolveApiKey }
        : {}),
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    });
    if (!result.ok) {
      return ocrFailure(this.name, result.stage, result.message, result.status);
    }
    return {
      ok: true,
      provider: this.name,
      text: result.text,
      markdown: result.markdown,
      html: result.html,
      raw: result.raw,
    };
  }

  /** Accept image/*, application/pdf, and the documented office
   *  formats. Lowercase compare; subtype after `/` may include
   *  parameters (e.g. `image/jpeg; charset=binary`). */
  private acceptsMime(mime: string): boolean {
    const m = mime.toLowerCase().split(';')[0]!.trim();
    if (m.startsWith('image/')) return true;
    if (m === 'application/pdf') return true;
    if (m.startsWith('application/vnd.openxmlformats-officedocument.')) return true;
    if (m === 'application/x-hwp' || m === 'application/x-hwpx') return true;
    return false;
  }
}
