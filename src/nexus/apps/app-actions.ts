import { transcribeAudioFile } from '../api/audio-stt.js';
import { SERVICE_KEY_CATALOG } from '../../setup/service-key-catalog.js';

export interface AppActionSecretBoundary {
  /** Resolves an app-declared credential reference. Implemented after APP-SECRET-SCOPE lands. */
  resolve(input: { appSlug: string; reference: string }): Promise<string | undefined>;
}
export interface AppActionDeclaration {
  readonly builtin: 'stt' | 'summarize' | 'tts';
  readonly uses: readonly string[];
}
export interface AppActionDeps {
  readonly secrets: AppActionSecretBoundary;
  readonly readAudioObject?: (input: { appSlug: string; reference: string }) => Promise<{ bytes: Uint8Array; mimeType: string; filename: string } | undefined>;
  readonly transcribe?: (input: { audio: Buffer; apiKey: string; mimeType: string; filename: string; language?: string }) => Promise<{ text: string; language?: string; durationMs?: number }>;
  readonly summarize?: (input: { text: string; apiKey: string }) => Promise<string>;
  readonly synthesize?: (input: { text: string; voiceId: string; modelId: string; apiKey: string }) => Promise<{ audio: Uint8Array; mimeType: string }>;
}
export interface AppActionInput { readonly audio?: Uint8Array | string; readonly mimeType?: string; readonly filename?: string; readonly text?: string; readonly language?: string; readonly voiceId?: string; readonly modelId?: string }
export type AppActionResult = { readonly text: string; readonly language?: string; readonly durationMs?: number } | { readonly audioBase64: string; readonly mimeType: string };

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 100_000;
const MAX_TTS_TEXT_CHARS = 5_000;
const MAX_TTS_AUDIO_BYTES = 10 * 1024 * 1024;
const CREDENTIAL_REF = /^cred:[a-z0-9][a-z0-9-]*\.[a-zA-Z][a-zA-Z0-9_-]*$/;
const APP_ATTACHABLE_SERVICE_IDS = new Set(SERVICE_KEY_CATALOG.filter(item => item.appAttachable).map(item => item.id));
const CREDENTIAL_SERVICE_IDS: Readonly<Record<string, string>> = { openai: 'openai-api' };

export class AppActionError extends Error {
  constructor(readonly code: 'invalid-app' | 'invalid-declaration' | 'credential-unavailable' | 'invalid-input' | 'provider-failed') {
    super(code);
    this.name = 'AppActionError';
  }
}

async function defaultTranscribe(input: { audio: Buffer; apiKey: string; mimeType: string; filename: string; language?: string }) {
  return transcribeAudioFile({
    audio: input.audio, mimeType: input.mimeType, filename: input.filename, apiKey: input.apiKey,
    ...(input.language ? { language: input.language } : {}),
  });
}

async function defaultSummarize(input: { text: string; apiKey: string }): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Summarize the user-provided text faithfully and concisely. Do not add facts.' },
        { role: 'user', content: input.text },
      ],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('summary provider rejected request');
  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null || !('choices' in payload) || !Array.isArray(payload.choices)) {
    throw new Error('summary provider returned invalid response');
  }
  const first = payload.choices[0];
  if (typeof first !== 'object' || first === null || !('message' in first) || typeof first.message !== 'object' || first.message === null
    || !('content' in first.message) || typeof first.message.content !== 'string' || !first.message.content.trim()) {
    throw new Error('summary provider returned no text');
  }
  return first.message.content.trim();
}

async function defaultSynthesize(input: { text: string; voiceId: string; modelId: string; apiKey: string }): Promise<{ audio: Uint8Array; mimeType: string }> {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': input.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ text: input.text, model_id: input.modelId }),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('tts provider rejected request');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_TTS_AUDIO_BYTES) throw new Error('tts audio exceeds limit');
  if (!response.body) throw new Error('tts provider returned no audio');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TTS_AUDIO_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('tts audio exceeds limit');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (total === 0) throw new Error('tts provider returned empty audio');
  const audio = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength; }
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return { audio, mimeType: mimeType?.startsWith('audio/') ? mimeType : 'audio/mpeg' };
}

/** Runs only manifest-declared STT, summarize, and TTS actions; credentials cross one boundary and never enter results. */
export function createAppActions(deps: AppActionDeps) {
  return {
    async run(input: { appSlug: string; declaration: AppActionDeclaration; payload: AppActionInput }): Promise<AppActionResult> {
      const { appSlug, declaration, payload } = input;
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(appSlug) || appSlug.includes('--')) throw new AppActionError('invalid-app');
      const expectedCredential = declaration?.builtin === 'tts' ? 'cred:elevenlabs.api_key' : 'cred:openai.api_key';
      const expectedService = expectedCredential.slice('cred:'.length).split('.', 1)[0]!;
      if (!declaration || !['stt', 'summarize', 'tts'].includes(declaration.builtin)
        || !Array.isArray(declaration.uses) || declaration.uses.length !== 1
        || declaration.uses[0] !== expectedCredential || !CREDENTIAL_REF.test(declaration.uses[0]!)
        || !APP_ATTACHABLE_SERVICE_IDS.has(CREDENTIAL_SERVICE_IDS[expectedService] ?? expectedService)) {
        throw new AppActionError('invalid-declaration');
      }
      let apiKey: string | undefined;
      try { apiKey = await deps.secrets.resolve({ appSlug, reference: declaration.uses[0]! }); }
      catch { throw new AppActionError('credential-unavailable'); }
      if (typeof apiKey !== 'string' || !apiKey.trim()) throw new AppActionError('credential-unavailable');
      try {
        if (declaration.builtin === 'tts') {
          const text = payload.text;
          const voiceId = payload.voiceId;
          const modelId = payload.modelId ?? 'eleven_v3';
          if (typeof text !== 'string' || !text.trim() || text.length > MAX_TTS_TEXT_CHARS
            || typeof voiceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(voiceId)
            || !/^[A-Za-z0-9_-]{1,64}$/.test(modelId)) throw new AppActionError('invalid-input');
          const result = await (deps.synthesize ?? defaultSynthesize)({ text: text.trim(), voiceId, modelId, apiKey });
          if (!(result.audio instanceof Uint8Array) || result.audio.byteLength === 0 || result.audio.byteLength > MAX_TTS_AUDIO_BYTES
            || typeof result.mimeType !== 'string' || !/^audio\/[a-z0-9.+-]+$/.test(result.mimeType)) throw new Error('invalid TTS result');
          return { audioBase64: Buffer.from(result.audio).toString('base64'), mimeType: result.mimeType };
        }
        if (declaration.builtin === 'stt') {
          let audio = payload.audio;
          let mimeType = payload.mimeType;
          let filename = payload.filename;
          if (typeof audio === 'string') {
            if (!deps.readAudioObject || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/.test(audio)
              || audio.split('/').some(part => !part || part === '.' || part === '..')) throw new AppActionError('invalid-input');
            const object = await deps.readAudioObject({ appSlug, reference: audio }).catch(() => undefined);
            if (!object) throw new AppActionError('invalid-input');
            audio = object.bytes;
            mimeType = object.mimeType;
            filename = object.filename;
          }
          if (!(audio instanceof Uint8Array) || audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES
            || typeof mimeType !== 'string' || !/^audio\/(?:mpeg|mp3|mp4|mpga|m4a|wav|webm|ogg)$/.test(mimeType)
            || typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filename)
            || !/\.(?:mp3|mp4|mpga|m4a|wav|webm|ogg)$/i.test(filename)) throw new AppActionError('invalid-input');
          const result = await (deps.transcribe ?? defaultTranscribe)({
            audio: Buffer.from(audio), apiKey, mimeType, filename,
            ...(typeof payload.language === 'string' && payload.language.trim() ? { language: payload.language.trim() } : {}),
          });
          if (typeof result.text !== 'string') throw new Error('invalid transcription result');
          return { text: result.text, ...(result.language ? { language: result.language } : {}), ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}) };
        }
        if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > MAX_TEXT_CHARS) throw new AppActionError('invalid-input');
        const text = await (deps.summarize ?? defaultSummarize)({ text: payload.text, apiKey });
        if (typeof text !== 'string' || !text.trim()) throw new Error('invalid summary result');
        return { text: text.trim() };
      } catch (error) {
        if (error instanceof AppActionError) throw error;
        // Provider errors can contain request headers or credential material; expose a stable code only.
        throw new AppActionError('provider-failed');
      }
    },
  };
}

export interface AppActionHttpRuntime {
  authorize(request: Request, appSlug: string): boolean | Promise<boolean>;
  getDeclaration(appSlug: string, actionName: string): AppActionDeclaration | undefined | Promise<AppActionDeclaration | undefined>;
  run(input: { appSlug: string; declaration: AppActionDeclaration; payload: AppActionInput }): Promise<AppActionResult>;
}

async function readBoundedAudioBody(request: Request): Promise<Uint8Array | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AUDIO_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/** Owner-authenticated HTTP consumer for app.yaml action declarations. */
export async function handleAppActionRequest(request: Request, runtime: AppActionHttpRuntime): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = /^\/v1\/apps\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/actions\/([A-Za-z][A-Za-z0-9_-]{0,63})$/.exec(url.pathname);
  if (!match) return undefined;
  if (request.method.toUpperCase() !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });
  const [, appSlug, actionName] = match;
  if (!await runtime.authorize(request, appSlug!)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const declaration = await runtime.getDeclaration(appSlug!, actionName!);
  if (!declaration) return Response.json({ error: 'action-not-found' }, { status: 404 });
  let payload: unknown;
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (declaration.builtin === 'stt' && contentType && /^audio\/(?:mpeg|mp3|mp4|mpga|m4a|wav|webm|ogg)$/.test(contentType)) {
    const audio = await readBoundedAudioBody(request);
    if (!audio) return Response.json({ error: 'invalid-input' }, { status: 400 });
    payload = {
      audio, mimeType: contentType,
      filename: request.headers.get('x-audio-filename') ?? '',
      ...(request.headers.get('x-audio-language') ? { language: request.headers.get('x-audio-language')! } : {}),
    };
  } else {
    try { payload = await request.json(); } catch { return Response.json({ error: 'invalid-json' }, { status: 400 }); }
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return Response.json({ error: 'invalid-input' }, { status: 400 });
  try {
    const result = await runtime.run({ appSlug: appSlug!, declaration, payload: payload as AppActionInput });
    return Response.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    const code = error instanceof AppActionError ? error.code : 'provider-failed';
    const status = code === 'credential-unavailable' ? 503 : code === 'provider-failed' ? 502 : 400;
    return Response.json({ error: code }, { status });
  }
}
