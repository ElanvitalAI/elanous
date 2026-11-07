// R6 FU.2 · §6.3 audio bridge — daemon STT endpoint (2026-05-09).
//
// `POST /v1/audio/stt` — accept a multipart audio file, forward it to
// the configured `STTProvider` (default `openai-whisper`), return the
// transcript text + language + duration. The Showroom audio context
// source uses this to auto-fill `ShowroomAudioContext.transcript` when
// the user picks an audio file.
//
// Backend reuse: elanous TUI's voice dictation already runs OpenAI
// Whisper (`whisper-1`) — same provider abstraction, same
// OPENAI_API_KEY, same cost posture (~$0.006/min for whisper-1).
// `whisper-cpp` / local STT is a future PR (provider enum already
// reserves the slot; no infra change required to swap).

import { OpenAIWhisperProvider } from '../../voice/stt-providers/openai-whisper.js';
import type { STTProviderId, STTResult } from '../../voice/stt-provider.js';

export interface AudioSttRouteOpts {
  /** Optional auth check — production routes through the same shape
   *  as `/v1/personas`. Tests pass undefined to skip. */
  checkAuth?: (req: Request) => boolean;
  /** Override the provider id. Default `openai-whisper`. */
  providerId?: STTProviderId;
  /** Override the OpenAI API key (test seam — production reads
   *  `OPENAI_API_KEY` env). */
  apiKey?: string;
  /** Override the model id (e.g. `gpt-4o-transcribe`). Default
   *  inherits from the provider. */
  model?: string;
  /** Provider seam for loopback/fake-provider simulation. */
  transcribe?: (input: { audio: Buffer; mimeType: string; filename: string; apiKey?: string; model?: string; language?: string }) => Promise<STTResult>;
}

export async function transcribeAudioFile(input: { audio: Buffer; mimeType: string; filename: string; apiKey?: string; model?: string; language?: string }): Promise<STTResult> {
  const cfg: { id: 'openai-whisper'; apiKey?: string; model?: string } = { id: 'openai-whisper' };
  if (input.apiKey) cfg.apiKey = input.apiKey;
  if (input.model) cfg.model = input.model;
  return new OpenAIWhisperProvider(cfg).transcribeFile(input.audio, input.mimeType, input.filename, { ...(input.language ? { language: input.language } : {}) });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // R6 FU.2 — PWA dev mode is cross-origin; mirror the SSE +
      // role-judge CORS posture so a self-verify pass succeeds
      // without manual origin patching.
      'access-control-allow-origin': '*',
    },
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '600',
    },
  });
}

/** Resolve the provider id from env > opts > default. Exported for
 *  tests so the resolution table is locked. */
export function resolveAudioSttProviderId(opts: AudioSttRouteOpts): STTProviderId {
  const env = process.env.ELANOUS_AUDIO_STT_PROVIDER;
  if (env === 'openai-whisper' || env === 'openai-realtime' ||
      env === 'elevenlabs-scribe' || env === 'whisper-cpp') {
    return env;
  }
  return opts.providerId ?? 'openai-whisper';
}

/** Handle one upload turn. The route accepts a multipart form body
 *  with `file` + optional `language`. Validation rejects empty / non-
 *  audio uploads early so the provider isn't paid for a no-op call. */
export async function handleAudioStt(
  req: Request,
  opts: AudioSttRouteOpts = {},
): Promise<Response> {
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return corsPreflight();
  if (opts.checkAuth && !opts.checkAuth(req)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  if (method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }
  const providerId = resolveAudioSttProviderId(opts);
  if (providerId !== 'openai-whisper') {
    return jsonResponse({
      error: 'provider-not-implemented',
      providerId,
      hint: 'Only openai-whisper is wired in this PR (FU.2 · 2026-05-09).',
    }, 501);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return jsonResponse({
      error: 'invalid-multipart',
      detail: e instanceof Error ? e.message : String(e),
    }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return jsonResponse({ error: 'file-required' }, 400);
  }
  if (file.size === 0) {
    return jsonResponse({ error: 'file-empty' }, 400);
  }
  // Whisper REST batch caps at 25 MB. Reject early so we don't ship
  // a known-failing call.
  const MAX_BYTES = 25 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    return jsonResponse({
      error: 'file-too-large',
      sizeBytes: file.size,
      maxBytes: MAX_BYTES,
    }, 413);
  }
  const filename =
    (file as Blob & { name?: string }).name ?? 'audio.bin';
  const mimeType = file.type || 'application/octet-stream';
  const language = typeof form.get('language') === 'string'
    ? (form.get('language') as string)
    : undefined;
  // 2026-05-13 — iOS voice (PR12) opt-in 으로 premium 모델 (`gpt-realtime-whisper`)
  // 선택 가능. 우선순위: URL `?model=` > form `model=` > opts.model >
  // env `OPENAI_STT_MODEL` > whisper-1 default.
  const urlObj = new URL(req.url);
  const queryModel = urlObj.searchParams.get('model')?.trim() ?? '';
  const formModel = typeof form.get('model') === 'string' ? (form.get('model') as string).trim() : '';
  const requestedModel = queryModel || formModel || '';
  const arrayBuffer = await file.arrayBuffer();
  const audio = Buffer.from(arrayBuffer);
  if (!opts.transcribe && !opts.apiKey && !process.env.OPENAI_API_KEY) {
    return jsonResponse({
      error: 'provider-config',
      detail: 'OpenAI API key not provided.',
    }, 500);
  }
  let result: STTResult;
  try {
    result = await (opts.transcribe ?? transcribeAudioFile)({
      audio, mimeType, filename,
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(requestedModel ? { model: requestedModel } : opts.model ? { model: opts.model } : {}),
      ...(language ? { language } : {}),
    });
  } catch (e) {
    return jsonResponse({
      error: 'stt-failed',
      detail: e instanceof Error ? e.message : String(e),
    }, 502);
  }
  return jsonResponse({
    ok: true,
    text: result.text,
    ...(result.language ? { language: result.language } : {}),
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    providerId,
    ...(requestedModel ? { model: requestedModel } : {}),
  }, 200);
}
