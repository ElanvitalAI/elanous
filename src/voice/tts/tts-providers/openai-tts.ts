// PR-S1V.6 (sprint 22 Phase 1 · 2026-04-29) — OpenAI TTS provider.
//
// POST `/v1/audio/speech` with `response_format=pcm` returns raw 24 kHz ·
// 16-bit signed mono LE PCM — exactly the contract `audio-player.ts`
// expects, so no decode / resample step is needed in this path. The
// streaming variant reads `response.body` chunks straight through.
//
// Models:
//   - `tts-1` (default · ~$15/1M chars · low latency, multilingual incl. Korean)
//   - `tts-1-hd` (~$30/1M chars · higher fidelity, slightly higher latency)
//
// Voices: alloy (default), echo, fable, onyx, nova, shimmer. Korean
// pronunciation is acceptable on all six; `nova` and `shimmer` are
// often preferred subjectively.
//
// Reference: ROADMAP §2.3 · OpenAI API docs platform.openai.com/docs/api-reference/audio/createSpeech.

import { debug } from '../../../debug/log.js';
import { llmNetworkFetch } from '../../../session-runtime/llm-call-gateway.js';
import { isVoiceCostId, type VoiceCostId } from '../../../models/voice-costs.js';
import { globalVoiceCostTracker } from '../../cost-tracker.js';
import {
  DEFAULT_TTS_PCM_FORMAT,
  type OpenAITTSConfig,
  type TTSOpts,
  type TTSPcmFormat,
  type TTSProvider,
  type TTSProviderId,
  type TTSResult,
  type TTSStreamChunk,
} from '../tts-provider.js';

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MODEL = 'tts-1';
const DEFAULT_VOICE = 'alloy';

export class OpenAITTSProvider implements TTSProvider {
  readonly id: TTSProviderId = 'openai-tts';
  readonly format: TTSPcmFormat = DEFAULT_TTS_PCM_FORMAT;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultVoice: string;
  private readonly baseUrl: string;

  constructor(cfg: OpenAITTSConfig) {
    const apiKey = cfg.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    if (!apiKey) {
      throw new Error(
        'OpenAI API key not provided. Set OPENAI_API_KEY env var or pass cfg.apiKey to OpenAITTSProvider.',
      );
    }
    this.apiKey = apiKey;
    const envModel = process.env.OPENAI_TTS_MODEL?.trim();
    this.model = cfg.model ?? envModel ?? DEFAULT_MODEL;
    const envVoice = process.env.OPENAI_TTS_VOICE?.trim();
    this.defaultVoice = cfg.voice ?? envVoice ?? DEFAULT_VOICE;
    this.baseUrl = (cfg.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async synthesizeBatch(text: string, opts: TTSOpts = {}): Promise<TTSResult> {
    if (!text) {
      throw new Error('OpenAITTSProvider.synthesizeBatch: text is empty');
    }
    const response = await this.sendRequest(text, opts);
    const ab = await response.arrayBuffer();
    const pcm = Buffer.from(ab);
    this.recordCost(text.length);
    return { pcm, format: this.format, charCount: text.length };
  }

  async *synthesizeStream(text: string, opts: TTSOpts = {}): AsyncIterable<TTSStreamChunk> {
    if (!text) {
      throw new Error('OpenAITTSProvider.synthesizeStream: text is empty');
    }
    const response = await this.sendRequest(text, opts);
    const body = response.body;
    if (!body) {
      throw new Error('OpenAI TTS stream: response body missing');
    }
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          yield { pcm: Buffer.from(value) };
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    this.recordCost(text.length);
  }

  private async sendRequest(text: string, opts: TTSOpts): Promise<Response> {
    const voice = opts.voice ?? this.defaultVoice;
    const body = {
      model: this.model,
      input: text,
      voice,
      response_format: 'pcm',
      ...(typeof opts.speed === 'number' ? { speed: opts.speed } : {}),
    };
    const url = `${this.baseUrl}/v1/audio/speech`;
    if (debug.enabled)
      debug.log('voice.tts.openai', 'request', {
        url, model: this.model, voice, chars: text.length,
      });
    const t0 = Date.now();
    const response = await llmNetworkFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, { provider: 'openai', model: this.model, role: 'aux', requestedBy: 'voice-tts' });
    const latencyMs = Date.now() - t0;
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (debug.enabled)
        debug.log('voice.tts.openai', 'error', {
          status: response.status, latencyMs, bodySnip: errBody.slice(0, 200),
        }, { level: 'error' });
      throw new Error(
        `OpenAI TTS API error: ${response.status} ${response.statusText}${errBody ? ` — ${errBody}` : ''}`,
      );
    }
    if (debug.enabled)
      debug.log('voice.tts.openai', 'ok', { latencyMs, model: this.model, voice });
    return response;
  }

  private recordCost(charCount: number): void {
    const costId = this.model === 'tts-1-hd' ? 'openai-tts-hd' : 'openai-tts';
    if (!isVoiceCostId(costId)) {
      // voice-costs.ts hasn't registered this model yet — log + skip
      // rather than throwing so a missing pricing entry can't break
      // synthesis itself.
      if (debug.enabled)
        debug.log('voice.tts.openai', 'cost.skip-unregistered', { providerId: costId, model: this.model });
      return;
    }
    try {
      globalVoiceCostTracker().recordTts({
        providerId: costId as VoiceCostId,
        charCount,
      });
    } catch (err) {
      if (debug.enabled)
        debug.log('voice.tts.openai', 'cost.error', { err: String(err) }, { level: 'error' });
    }
  }
}
