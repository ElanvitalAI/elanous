// Phase 8 (sprint 22 · 2026-04-30) — Telegram voice message adapter.
//
// Telegram users send voice messages as `.ogg` Opus blobs (file_id +
// duration in the `voice` field of an incoming Update). monad-agent
// receives the file_id, downloads the Opus binary via Bot API, and
// pipes it through:
//
//   .ogg Opus  ──[sox/ffmpeg]──>  16kHz mono int16 PCM
//        │
//        v
//   STTProvider.transcribeBatch  ──>  transcript text
//        │
//        v
//   harness chat (caller-provided handler)  ──>  assistant reply text
//        │
//        v   (reply mode = 'auto' or 'voice')
//   TTSProvider.synthesizeBatch  ──>  24kHz mono int16 PCM
//        │
//        v
//   24kHz PCM ──[sox/ffmpeg]──>  .ogg Opus  ──>  bot.sendVoice
//
// The `process` flow is decoupled from the Telegram client itself —
// callers (telegram.ts message handler) plug in `downloadOgg` +
// `sendVoice` + `dispatchTranscript` callbacks so the adapter stays
// testable in isolation (no fetch / no spawn at the unit-test layer).
//
// `replyMode` semantics:
//   - 'auto' (default): user voice → voice reply; user text → text reply
//   - 'text': always text reply (even on voice msg)
//   - 'voice': always voice reply (even on text msg, when input text is wired)
//
// Reference: ROADMAP-voice-harness-bidirectional-2026-04-29.md §8.2.

import { spawn } from 'node:child_process';
import { debug } from '../../debug/log.js';
import type { STTProvider } from '../stt-provider.js';
import type { TTSProvider } from '../tts/tts-provider.js';
import {
  generateVoiceMessageReply,
  normalizeVoiceMessageReplyMode,
  transcribeVoiceMessageInput,
  type VoiceMessageCodec,
  type VoiceMessageReplyMode,
} from './voice-message-core.js';

// ── Public types ───────────────────────────────────────────────────

export type TelegramVoiceReplyMode = VoiceMessageReplyMode;

export interface TelegramVoiceTranscriptResult {
  transcript: string;
  language?: string;
  durationMs?: number;
}

export interface TelegramVoiceReply {
  /** Always populated — even in 'voice' mode we keep the text alongside
   *  for chat history / logging. */
  text: string;
  /** When the resolved replyMode is 'voice' (or 'auto' on a voice
   *  input), the .ogg Opus blob ready for `bot.sendVoice`. Null
   *  when the resolved mode is 'text'. */
  voiceOgg: Buffer | null;
}

export interface TelegramVoiceAdapter {
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly replyMode: TelegramVoiceReplyMode;
  /** Transcribe a `.ogg` Opus voice message buffer to text. Throws on
   *  STT failure. Returns durationMs/language when STT supplies them. */
  transcribeOgg(ogg: Buffer, opts?: { language?: string }): Promise<TelegramVoiceTranscriptResult>;
  /** Generate a reply for the given text. Resolves the actual mode
   *  ('auto' on a voice input → 'voice'; 'auto' on text → 'text';
   *  explicit 'text' / 'voice' override). */
  generateReply(replyText: string, opts: { fromVoice: boolean }): Promise<TelegramVoiceReply>;
}

export class TelegramVoiceUnavailableError extends Error {
  constructor(hint: string) {
    super(`Telegram voice unavailable — ${hint}`);
    this.name = 'TelegramVoiceUnavailableError';
  }
}

// ── Audio codec — sox subprocess (mockable) ───────────────────────

/** Hook seam — defaults to spawning `sox`. Tests inject a fake. */
export interface TelegramVoiceCodec extends VoiceMessageCodec {
  /** .ogg Opus → 16 kHz mono int16 PCM. */
  oggToPcm16k(ogg: Buffer): Promise<Buffer>;
  /** 24 kHz mono int16 PCM → .ogg Opus. */
  pcm24kToOgg(pcm: Buffer): Promise<Buffer>;
}

interface SoxBinarySpec {
  /** Override path (`sox` on PATH by default). */
  binaryPath?: string;
}

export function createSoxTelegramVoiceCodec(spec: SoxBinarySpec = {}): TelegramVoiceCodec {
  const bin = spec.binaryPath ?? 'sox';
  const oggToPcm16k = (ogg: Buffer) => runSoxConversion(bin, ogg, [
    '-q',
    '-t', 'ogg', '-',
    '-t', 'raw', '-r', '16000', '-e', 'signed', '-b', '16', '-c', '1',
    '-',
  ]);
  const pcm24kToOgg = (pcm: Buffer) => runSoxConversion(bin, pcm, [
    '-q',
    '-t', 'raw', '-r', '24000', '-e', 'signed', '-b', '16', '-c', '1', '-',
    '-t', 'ogg', '-C', '-1',
    '-',
  ]);
  return {
    oggToPcm16k,
    pcm24kToOgg,
    inputToPcm16k: oggToPcm16k,
    pcm24kToOutput: pcm24kToOgg,
  };
}

async function runSoxConversion(bin: string, input: Buffer, args: string[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`sox exited with code ${code}: ${stderr.trim()}`));
      }
    });
    child.stdin.end(input);
  });
}

// ── Adapter factory ────────────────────────────────────────────────

export interface TelegramVoiceAdapterOpts {
  sttProvider: STTProvider | null | undefined;
  ttsProvider?: TTSProvider | null | undefined;
  replyMode?: TelegramVoiceReplyMode;
  /** Optional override of the codec — defaults to sox via PATH.
   *  Tests inject a fake to avoid real subprocesses. */
  codec?: TelegramVoiceCodec;
  /** Default STT language hint (ISO 639-1). user-config can override. */
  voiceLanguage?: string;
}

export function createTelegramVoiceAdapter(opts: TelegramVoiceAdapterOpts): TelegramVoiceAdapter {
  const replyMode: TelegramVoiceReplyMode = opts.replyMode ?? 'auto';
  const codec = (() => {
    const raw = opts.codec ?? createSoxTelegramVoiceCodec();
    return {
      ...raw,
      inputToPcm16k: raw.inputToPcm16k ?? ((ogg: Buffer) => raw.oggToPcm16k(ogg)),
      pcm24kToOutput: raw.pcm24kToOutput ?? ((pcm: Buffer) => raw.pcm24kToOgg(pcm)),
    };
  })();

  if (!opts.sttProvider) {
    const reason = 'sttProvider not supplied — Telegram voice requires an STT provider for transcription';
    if (debug.enabled)
      debug.log('voice.telegram.adapter', 'unavailable', { reason });
    return {
      available: false,
      unavailableReason: reason,
      replyMode,
      transcribeOgg: () => Promise.reject(new TelegramVoiceUnavailableError(reason)),
      generateReply: () => Promise.reject(new TelegramVoiceUnavailableError(reason)),
    };
  }

  const stt = opts.sttProvider;
  const tts = opts.ttsProvider ?? null;

  async function transcribeOgg(ogg: Buffer, opts2: { language?: string } = {}): Promise<TelegramVoiceTranscriptResult> {
    if (debug.enabled)
      debug.log('voice.telegram.adapter', 'transcribe.begin', { bytes: ogg.byteLength });
    const lang = opts2.language ?? opts.voiceLanguage;
    const result = await transcribeVoiceMessageInput(
      codec,
      stt,
      ogg,
      lang ? { language: lang } : {},
    );
    if (debug.enabled)
      debug.log('voice.telegram.adapter', 'transcribe.ok', {
        chars: result.transcript.length, language: result.language ?? null,
      });
    return result;
  }

  async function generateReply(replyText: string, opts2: { fromVoice: boolean }): Promise<TelegramVoiceReply> {
    if (debug.enabled && tts)
      debug.log('voice.telegram.adapter', 'reply.tts.begin', { chars: replyText.length });
    const reply = await generateVoiceMessageReply(
      codec,
      tts,
      replyMode,
      replyText,
      opts2,
    );
    if (debug.enabled && reply.voiceBlob)
      debug.log('voice.telegram.adapter', 'reply.tts.ok', { oggBytes: reply.voiceBlob.byteLength });
    return { text: reply.text, voiceOgg: reply.voiceBlob };
  }

  return {
    available: true,
    unavailableReason: null,
    replyMode,
    transcribeOgg,
    generateReply,
  };
}

// ── Reply mode normalization ───────────────────────────────────────

export function normalizeTelegramVoiceReplyMode(v: unknown): TelegramVoiceReplyMode {
  return normalizeVoiceMessageReplyMode(v);
}
