// GOAL-ORCHESTRATION-VOICE — the voice node: the reduced brief → one mp3 (ElevenLabs) saved next to the run receipt,
// then handed to the publish node as $ORCH_VOICE_FILE. Voice never fails a run: no key, a TTS error or a timeout all end
// in «voice skipped» and the run goes on to publish the PDF.
// The key is resolved here, inside the product (env → the service-key cache ~/.cache/elevenlabs_api_key → the secret
// store `elevenlabs.apiKey`), and only ever travels in the request header — it is never logged, returned or written.
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Speech is cut to about this many characters (cost bound · a ~2 minute listen). */
export const VOICE_MAX_CHARS = 1_500;
/** Seulki — native Korean (Seoul) narrator in the ElevenLabs library; the brief is read in Korean, never English narration. */
export const DEFAULT_VOICE_ID = 'ksaI0TCD9BstzEzlxj4q';
/** Korean-capable long-form model (reads Korean naturally). */
export const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** Text → mp3 bytes. Injected in tests; `elevenLabsTts()` builds the real one. */
export type Tts = (text: string, signal?: AbortSignal) => Promise<Uint8Array>;
export interface VoiceResult { readonly ok: boolean; readonly file?: string; readonly chars: number; readonly bytes?: number; readonly why?: string }

/** Share of Hangul among letters (0..1). */
export function hangulRatio(text: string): number {
  const letters = text.match(/[\p{L}]/gu) ?? [];
  if (letters.length === 0) return 0;
  return (text.match(/[\u3131-\u318e\uac00-\ud7a3]/gu) ?? []).length / letters.length;
}
/** The language the result must be written and spoken in: Korean when the goal is Korean. */
export const goalLanguage = (goal: string): 'Korean' | undefined => hangulRatio(goal) >= 0.3 ? 'Korean' : undefined;

/** Markdown brief → plain sentences for speech, cut at a sentence end near `max` characters. Source notes are dropped. */
export function speechText(markdown: string, max = VOICE_MAX_CHARS): string {
  const lines = markdown.split('\n')
    .map((l) => l.replace(/[*_]*\((?:출처|source|sources)\s*:[^)]*\)[*_]*/giu, '').replace(/!\[[^\]]*\]\([^)]*\)/gu, '').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/^\s*(#{1,6}|[-*+]|\d+[.)]|>)\s+/u, '').replace(/[*_`~|]/gu, '').replace(/\s+/gu, ' ').trim())
    .filter((l) => l && !/^-{3,}$/u.test(l));
  const text = lines.map((l) => (/[.!?。…:]$/u.test(l) ? l : `${l}.`)).join(' ');
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('다. '));
  return (end > max * 0.6 ? cut.slice(0, end + 1) : cut).trim();
}

/** The ElevenLabs key through the product's own sources. Returns undefined when none is configured. */
export async function resolveElevenLabsKey(env: NodeJS.ProcessEnv = process.env, deps: { cacheDir?: string; getSecret?: (id: string) => Promise<string | undefined> } = {}): Promise<string | undefined> {
  const fromEnv = env.ELEVENLABS_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const cacheDir = deps.cacheDir ?? (env.ELANOUS_KEY_CACHE_DIR?.trim() || join(homedir(), '.cache'));
  const cached = join(cacheDir, 'elevenlabs_api_key');
  try {
    if (existsSync(cached) && lstatSync(cached).isFile()) { const v = readFileSync(cached, 'utf8').trim(); if (v) return v; }
  } catch { /* unreadable cache = no key from here */ }
  try {
    const getSecret = deps.getSecret ?? (async (id: string) => (await import('../nexus/config/secrets/index.js')).getSecretAsync(id));
    const v = (await getSecret('elevenlabs.apiKey'))?.trim();
    if (v) return v;
  } catch { /* secret store missing */ }
  return undefined;
}

/** The real TTS (ElevenLabs mp3). undefined when no key is configured. */
export async function elevenLabsTts(env: NodeJS.ProcessEnv = process.env): Promise<Tts | undefined> {
  const key = await resolveElevenLabsKey(env);
  if (!key) return undefined;
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE_ID;
  const modelId = env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
  return async (text, signal) => {
    const { llmNetworkFetch } = await import('../session-runtime/llm-call-gateway.js');
    const r = await llmNetworkFetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: modelId }), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
    }, { provider: 'elevenlabs', model: modelId, role: 'aux', requestedBy: 'orchestrate-voice' });
    if (!r.ok) throw new Error(`TTS provider answered ${r.status}`);
    const audio = new Uint8Array(await r.arrayBuffer());
    if (audio.byteLength === 0) throw new Error('TTS provider returned empty audio');
    if (audio.byteLength > MAX_AUDIO_BYTES) throw new Error('TTS audio exceeds limit');
    return audio;
  };
}

/** The voice node. Never throws: every failure is a skipped voice with a reason. */
export async function runVoice(brief: string, outFile: string, tts: Tts | undefined, signal?: AbortSignal, opts: { language?: 'Korean' } = {}): Promise<VoiceResult> {
  const text = speechText(brief);
  if (!text) return { ok: false, chars: 0, why: 'empty brief' };
  // A Korean goal is spoken in Korean only — an English brief is skipped rather than narrated in English.
  if (opts.language === 'Korean' && hangulRatio(text) < 0.5) return { ok: false, chars: text.length, why: 'brief is not in Korean' };
  if (!tts) return { ok: false, chars: text.length, why: 'no ElevenLabs key configured' };
  try {
    const audio = await tts(text, signal);
    writeFileSync(outFile, audio);
    return { ok: true, file: outFile, chars: text.length, bytes: audio.byteLength };
  } catch (error) {
    return { ok: false, chars: text.length, why: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
  }
}
