// PR-S1V.6 (sprint 22 Phase 1 · 2026-04-29) — ElevenLabs Flash v2.5 TTS
// provider.
//
// POST `/v1/text-to-speech/{voice_id}/stream?output_format=pcm_24000`
// returns raw 24 kHz · 16-bit signed mono LE PCM directly — same shape
// as OpenAI TTS, no decode pass needed. Flash v2.5 is multilingual
// (Korean included) with low latency suited for streaming.
//
// Voice id: defaults to Rachel (`21m00Tcm4TlvDq8ikWAM` · multilingual,
// female, neutral) — override via `ELEVENLABS_VOICE_ID` env to a
// Korean-tuned voice if dogfood prefers one.
//
// API key: `ELEVENLABS_API_KEY` (already provisioned per HANDOFF §3.2).
//
// Reference: ROADMAP §2.5 · elevenlabs.io/docs/api-reference/text-to-speech/convert-as-stream.

import { debug } from '../../../debug/log.js';
import { llmNetworkFetch } from '../../../session-runtime/llm-call-gateway.js';
import { isVoiceCostId } from '../../../models/voice-costs.js';
import { globalVoiceCostTracker } from '../../cost-tracker.js';
import {
  DEFAULT_TTS_PCM_FORMAT,
  type ElevenLabsTTSConfig,
  type TTSOpts,
  type TTSPcmFormat,
  type TTSProvider,
  type TTSProviderId,
  type TTSResult,
  type TTSStreamChunk,
} from '../tts-provider.js';

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel · multilingual
const COST_ID = 'elevenlabs-tts-flash-v2.5' as const;

export class ElevenLabsTTSProvider implements TTSProvider {
  readonly id: TTSProviderId = 'elevenlabs-tts';
  readonly format: TTSPcmFormat = DEFAULT_TTS_PCM_FORMAT;

  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly defaultVoiceId: string;
  private readonly baseUrl: string;

  constructor(cfg: ElevenLabsTTSConfig) {
    const apiKey = cfg.apiKey ?? process.env.ELEVENLABS_API_KEY ?? '';
    if (!apiKey) {
      throw new Error(
        'ElevenLabs API key not provided. Set ELEVENLABS_API_KEY env var or pass cfg.apiKey to ElevenLabsTTSProvider.',
      );
    }
    this.apiKey = apiKey;
    this.modelId = cfg.modelId ?? process.env.ELEVENLABS_MODEL_ID?.trim() ?? DEFAULT_MODEL_ID;
    this.defaultVoiceId = cfg.voiceId ?? process.env.ELEVENLABS_VOICE_ID?.trim() ?? DEFAULT_VOICE_ID;
    this.baseUrl = (process.env.ELEVENLABS_BASE_URL?.trim() ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async synthesizeBatch(text: string, opts: TTSOpts = {}): Promise<TTSResult> {
    if (!text) {
      throw new Error('ElevenLabsTTSProvider.synthesizeBatch: text is empty');
    }
    const response = await this.sendRequest(text, opts);
    const ab = await response.arrayBuffer();
    const pcm = Buffer.from(ab);
    this.recordCost(text.length);
    return { pcm, format: this.format, charCount: text.length };
  }

  async *synthesizeStream(text: string, opts: TTSOpts = {}): AsyncIterable<TTSStreamChunk> {
    if (!text) {
      throw new Error('ElevenLabsTTSProvider.synthesizeStream: text is empty');
    }
    const response = await this.sendRequest(text, opts);
    const body = response.body;
    if (!body) {
      throw new Error('ElevenLabs TTS stream: response body missing');
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
    const voiceId = opts.voice ?? this.defaultVoiceId;
    // ElevenLabs has no direct `speed` knob on the Flash family — speed
    // is applied client-side via the audio-player or accepted as a no-op
    // here so the cross-provider `opts.speed` shape stays uniform.
    const body = {
      text,
      model_id: this.modelId,
    };
    const url = `${this.baseUrl}/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`;
    if (debug.enabled)
      debug.log('voice.tts.elevenlabs', 'request', {
        url, modelId: this.modelId, voiceId, chars: text.length,
      });
    const t0 = Date.now();
    const response = await llmNetworkFetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/pcm',
      },
      body: JSON.stringify(body),
    }, { provider: 'elevenlabs', model: this.modelId, role: 'aux', requestedBy: 'voice-tts' });
    const latencyMs = Date.now() - t0;
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (debug.enabled)
        debug.log('voice.tts.elevenlabs', 'error', {
          status: response.status, latencyMs, bodySnip: errBody.slice(0, 300),
        }, { level: 'error' });
      throw new Error(
        `ElevenLabs TTS API error: ${response.status} ${response.statusText}${errBody ? ` — ${errBody}` : ''}`,
      );
    }
    if (debug.enabled)
      debug.log('voice.tts.elevenlabs', 'ok', {
        latencyMs, modelId: this.modelId, voiceId,
      });
    return response;
  }

  private recordCost(charCount: number): void {
    if (!isVoiceCostId(COST_ID)) return;
    try {
      globalVoiceCostTracker().recordTts({ providerId: COST_ID, charCount });
    } catch (err) {
      if (debug.enabled)
        debug.log('voice.tts.elevenlabs', 'cost.error', { err: String(err) }, { level: 'error' });
    }
  }

  // Suppress `opts.speed` unused-warning via discriminator; included
  // here to keep the contract documented.
  static readonly _SPEED_NOTE = 'opts.speed is accepted but currently ignored — Flash v2.5 has no speed knob; apply via audio-player playback rate if needed';
}
