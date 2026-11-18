// PR-S1V.2 (sprint 21-Parallel-Voice · 2026-04-29) — OpenAI Whisper STT
// REST batch provider.
//
// Wraps PCM Buffer (PR-S1V.1's audio-capture output) into a minimal WAV
// container and POSTs to `/v1/audio/transcriptions` as multipart/form-data.
// Whisper API does not accept raw PCM directly — the WAV header is the
// smallest format that the API recognizes (~44 bytes overhead).
//
// 차용 ref:
//   - hermes `tools/transcription_tools.py` — OpenAI provider 부분의 dispatch.
//   - OpenAI API docs (https://platform.openai.com/docs/api-reference/audio/createTranscription).
//   - claude-code-fork uses Anthropic's proprietary voice_stream WebSocket
//     (not portable) — elanous takes the public REST path instead.

import { debug } from '../../debug/log.js';
import { llmNetworkFetch } from '../../session-runtime/llm-call-gateway.js';
import {
  type OpenAIWhisperConfig,
  type STTOpts,
  type STTProvider,
  type STTProviderId,
  type STTResult,
} from '../stt-provider.js';

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MODEL = 'whisper-1';

// PCM format constants must match PR-S1V.1's audio-capture output.
const PCM_SAMPLE_RATE = 16000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;

export class OpenAIWhisperProvider implements STTProvider {
  readonly id: STTProviderId = 'openai-whisper';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(cfg: OpenAIWhisperConfig) {
    const apiKey = cfg.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    if (!apiKey) {
      throw new Error(
        'OpenAI API key not provided. Set OPENAI_API_KEY env var or pass cfg.apiKey to OpenAIWhisperProvider.',
      );
    }
    this.apiKey = apiKey;
    // TEMP DEBUG TRIAL (2026-04-29) — env override so dogfood can swap
    // models without code change. Try `gpt-4o-mini-transcribe` for
    // better Korean accuracy (still json/text response, no verbose_json).
    // `gpt-4o-transcribe` is highest quality but has known language-
    // enforcement bugs (community thread 1357014, Sep 2025) — keep
    // `whisper-1` as the safer default for Korean.
    const envModel = process.env.OPENAI_STT_MODEL?.trim();
    this.model = cfg.model ?? envModel ?? DEFAULT_MODEL;
    this.baseUrl = (cfg.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async transcribeBatch(audio: Buffer, opts: STTOpts = {}): Promise<STTResult> {
    if (audio.byteLength === 0) {
      throw new Error('OpenAIWhisperProvider.transcribeBatch: audio buffer is empty');
    }

    const wav = wrapPcmInWav(audio, {
      sampleRate: PCM_SAMPLE_RATE,
      channels: PCM_CHANNELS,
      bitsPerSample: PCM_BITS_PER_SAMPLE,
    });

    // TEMP DEBUG TRIAL (2026-04-29 · fix/voice-runtime-tdz-2) — dump
    // the WAV to /tmp so dogfood can play it back and confirm whether
    // the mic actually captured speech (vs Whisper-1 hallucinating
    // "시청해주셔서 감사합니다!" / "MBC 뉴스" YouTube/news outros on
    // silent input). Disable by setting OPENAI_STT_DEBUG_DUMP=0.
    const dumpEnabled = (process.env.OPENAI_STT_DEBUG_DUMP ?? '1') !== '0';
    if (dumpEnabled) {
      try {
        const fs = await import('node:fs/promises');
        const path = `/tmp/voice-debug-${Date.now()}.wav`;
        await fs.writeFile(path, wav);
        if (debug.enabled) debug.log('voice.stt', 'wav.dump', { path, bytes: wav.byteLength });
      } catch (err) {
        if (debug.enabled) debug.log('voice.stt', 'wav.dump-error', { err: String(err) }, { level: 'error' });
      }
    }

    const form = new FormData();
    // The filename extension is what the API uses to detect format —
    // `audio/wav` MIME alone is not enough on some endpoint versions.
    // Copy Buffer payload into a freshly allocated ArrayBuffer so the
    // Blob constructor sees a strict-typed `ArrayBuffer` BlobPart
    // (Buffer<ArrayBufferLike> is rejected under strict TS settings).
    const ab: ArrayBuffer = new ArrayBuffer(wav.byteLength);
    new Uint8Array(ab).set(wav);
    form.append('file', new Blob([ab], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.model);
    form.append('response_format', 'json');
    if (opts.language) form.append('language', opts.language);
    if (opts.prompt) form.append('prompt', opts.prompt);
    if (typeof opts.temperature === 'number') {
      form.append('temperature', String(opts.temperature));
    }

    const url = `${this.baseUrl}/v1/audio/transcriptions`;
    if (debug.enabled)
      debug.log('voice.stt', 'whisper.request', {
        url,
        model: this.model,
        bytes: audio.byteLength,
        wavBytes: wav.byteLength,
        language: opts.language,
      });

    const t0 = Date.now();
    const response = await llmNetworkFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    }, { provider: 'openai', model: this.model, role: 'aux', requestedBy: 'voice-stt' });
    const latencyMs = Date.now() - t0;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (debug.enabled)
        debug.log('voice.stt', 'whisper.error', {
          status: response.status,
          latencyMs,
          bodySnip: body.slice(0, 200),
        }, { level: 'error' });
      throw new Error(
        `OpenAI Whisper API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`,
      );
    }

    const data = (await response.json()) as {
      text?: string;
      language?: string;
      duration?: number;
    };
    if (typeof data.text !== 'string') {
      throw new Error(
        `OpenAI Whisper API returned no text field: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }

    const result: STTResult = {
      text: data.text,
      ...(typeof data.language === 'string' ? { language: data.language } : {}),
      ...(typeof data.duration === 'number'
        ? { durationMs: Math.round(data.duration * 1000) }
        : { durationMs: latencyMs }),
    };
    if (debug.enabled)
      debug.log('voice.stt', 'whisper.ok', {
        latencyMs,
        chars: result.text.length,
        language: result.language,
        model: this.model,
        // TEMP DEBUG TRIAL — first 80 chars so dogfood log shows whether
        // transcription is producing real text or garbage. Truncate to
        // protect against long transcripts in log.
        textSnip: result.text.slice(0, 80),
      });
    return result;
  }

  /** R6 FU.2 (2026-05-09) — file-mode entry point. Skips the WAV
   *  wrap/dump path (which assumes 16kHz int16 LE PCM input) and
   *  forwards the raw upload to Whisper. The OpenAI API accepts
   *  mp3 / mp4 / mpeg / mpga / m4a / wav / webm by sniffing the
   *  filename extension, so the caller passes the original
   *  filename and content-type alongside the buffer.
   *
   *  Used by `src/nexus/api/audio-stt.ts` for the Showroom audio
   *  context source (§6.3 follow-up). The PCM `transcribeBatch`
   *  remains the canonical entry for live mic dictation. */
  async transcribeFile(
    audio: Buffer,
    mimeType: string,
    filename: string,
    opts: STTOpts = {},
  ): Promise<STTResult> {
    if (audio.byteLength === 0) {
      throw new Error('OpenAIWhisperProvider.transcribeFile: audio buffer is empty');
    }
    const ab: ArrayBuffer = new ArrayBuffer(audio.byteLength);
    new Uint8Array(ab).set(audio);
    const form = new FormData();
    form.append(
      'file',
      new Blob([ab], { type: mimeType || 'application/octet-stream' }),
      filename,
    );
    form.append('model', this.model);
    form.append('response_format', 'json');
    if (opts.language) form.append('language', opts.language);
    if (opts.prompt) form.append('prompt', opts.prompt);
    if (typeof opts.temperature === 'number') {
      form.append('temperature', String(opts.temperature));
    }
    const url = `${this.baseUrl}/v1/audio/transcriptions`;
    const t0 = Date.now();
    const response = await llmNetworkFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    }, { provider: 'openai', model: this.model, role: 'aux', requestedBy: 'voice-stt' });
    const latencyMs = Date.now() - t0;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (debug.enabled) {
        debug.log('voice.stt', 'whisper.file-error', {
          status: response.status,
          latencyMs,
          bodySnip: body.slice(0, 200),
        }, { level: 'error' });
      }
      throw new Error(
        `OpenAI Whisper API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`,
      );
    }
    const data = (await response.json()) as {
      text?: string;
      language?: string;
      duration?: number;
    };
    if (typeof data.text !== 'string') {
      throw new Error(
        `OpenAI Whisper API returned no text field: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    const result: STTResult = {
      text: data.text,
      ...(typeof data.language === 'string' ? { language: data.language } : {}),
      ...(typeof data.duration === 'number'
        ? { durationMs: Math.round(data.duration * 1000) }
        : { durationMs: latencyMs }),
    };
    if (debug.enabled) {
      debug.log('voice.stt', 'whisper.file-ok', {
        latencyMs,
        chars: result.text.length,
        language: result.language,
        model: this.model,
        bytes: audio.byteLength,
        mimeType,
        filename,
      });
    }
    return result;
  }
}

// ── WAV wrapping ────────────────────────────────────────────────────

export type WavFormat = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
};

/**
 * Wrap raw PCM into a minimal WAV file. Standard 44-byte PCM header.
 * Exported for tests — caller code should not need this directly.
 *
 * Layout (little-endian unless noted):
 *   0..3  'RIFF'
 *   4..7  file size - 8
 *   8..11 'WAVE'
 *   12..15 'fmt '
 *   16..19 fmt chunk size = 16
 *   20..21 audio format = 1 (PCM)
 *   22..23 channels
 *   24..27 sample rate
 *   28..31 byte rate = sample rate * channels * bitsPerSample / 8
 *   32..33 block align = channels * bitsPerSample / 8
 *   34..35 bits per sample
 *   36..39 'data'
 *   40..43 data chunk size = pcm.byteLength
 *   44..   pcm bytes
 */
export function wrapPcmInWav(pcm: Buffer, fmt: WavFormat): Buffer {
  const { sampleRate, channels, bitsPerSample } = fmt;
  if (channels < 1) throw new Error('wrapPcmInWav: channels must be >= 1');
  if (bitsPerSample !== 8 && bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) {
    throw new Error(`wrapPcmInWav: bitsPerSample must be 8/16/24/32, got ${bitsPerSample}`);
  }
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.byteLength;
  const fileSizeMinus8 = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(fileSizeMinus8, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
