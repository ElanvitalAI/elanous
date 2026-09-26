// Phase 8 (sprint 22 · 2026-04-30) — Telegram voice adapter unit tests.

import { describe, expect, it } from 'bun:test';
import {
  createTelegramVoiceAdapter,
  TelegramVoiceUnavailableError,
  normalizeTelegramVoiceReplyMode,
  type TelegramVoiceCodec,
} from '../src/voice/channel-adapters/telegram-voice-adapter';
import type { STTProvider } from '../src/voice/stt-provider';
import type { TTSProvider } from '../src/voice/tts/tts-provider';

function fakeCodec(): { codec: TelegramVoiceCodec; oggToPcm: Buffer[]; pcm24kIn: Buffer[] } {
  const oggToPcm: Buffer[] = [];
  const pcm24kIn: Buffer[] = [];
  return {
    codec: {
      async oggToPcm16k(ogg) {
        oggToPcm.push(ogg);
        // Fake PCM that mimics the input length so test can verify forwarding.
        return Buffer.from(`PCM16k(${ogg.toString()})`);
      },
      async pcm24kToOgg(pcm) {
        pcm24kIn.push(pcm);
        return Buffer.from(`OGG(${pcm.toString()})`);
      },
    },
    oggToPcm,
    pcm24kIn,
  };
}

function fakeStt(): { provider: STTProvider; calls: Array<{ pcm: Buffer; lang?: string }>; nextResult: { text: string; language?: string } } {
  const calls: Array<{ pcm: Buffer; lang?: string }> = [];
  const handle = { nextResult: { text: '안녕하세요', language: 'ko' } };
  const provider: STTProvider = {
    id: 'openai-whisper',
    async transcribeBatch(pcm, opts) {
      calls.push({ pcm, lang: opts?.language });
      return handle.nextResult;
    },
  };
  return { provider, calls, ...handle };
}

function fakeTts(): { provider: TTSProvider; calls: string[]; nextPcm: Buffer } {
  const calls: string[] = [];
  const handle = { nextPcm: Buffer.from('TTS-PCM-24K') };
  const provider: TTSProvider = {
    id: 'openai-tts',
    format: { sampleRate: 24000, channels: 1, bitsPerSample: 16 },
    async synthesizeBatch(text) {
      calls.push(text);
      return { pcm: handle.nextPcm, format: { sampleRate: 24000, channels: 1, bitsPerSample: 16 }, charCount: text.length };
    },
  };
  return { provider, calls, ...handle };
}

describe('createTelegramVoiceAdapter — availability', () => {
  it('reports unavailable when sttProvider missing', () => {
    const { codec } = fakeCodec();
    const a = createTelegramVoiceAdapter({ sttProvider: null, codec });
    expect(a.available).toBe(false);
    expect(a.unavailableReason).toContain('sttProvider');
  });

  it('available with sttProvider supplied', () => {
    const { codec } = fakeCodec();
    const { provider } = fakeStt();
    const a = createTelegramVoiceAdapter({ sttProvider: provider, codec });
    expect(a.available).toBe(true);
    expect(a.unavailableReason).toBeNull();
  });

  it('default replyMode = auto', () => {
    const { codec } = fakeCodec();
    const { provider } = fakeStt();
    const a = createTelegramVoiceAdapter({ sttProvider: provider, codec });
    expect(a.replyMode).toBe('auto');
  });

  it('explicit replyMode preserved', () => {
    const { codec } = fakeCodec();
    const { provider } = fakeStt();
    const a = createTelegramVoiceAdapter({ sttProvider: provider, codec, replyMode: 'voice' });
    expect(a.replyMode).toBe('voice');
  });

  it('transcribeOgg rejects when adapter unavailable', async () => {
    const { codec } = fakeCodec();
    const a = createTelegramVoiceAdapter({ sttProvider: null, codec });
    await expect(a.transcribeOgg(Buffer.from('x'))).rejects.toThrow(TelegramVoiceUnavailableError);
  });
});

describe('createTelegramVoiceAdapter — transcribeOgg', () => {
  it('decodes ogg via codec then sends PCM to STT', async () => {
    const { codec, oggToPcm } = fakeCodec();
    const { provider, calls } = fakeStt();
    const a = createTelegramVoiceAdapter({ sttProvider: provider, codec });
    const result = await a.transcribeOgg(Buffer.from('OGG-A'));
    expect(oggToPcm.map((b) => b.toString())).toEqual(['OGG-A']);
    expect(calls.length).toBe(1);
    expect(calls[0].pcm.toString()).toBe('PCM16k(OGG-A)');
    expect(result.transcript).toBe('안녕하세요');
    expect(result.language).toBe('ko');
  });

  it('forwards opts.language → STT', async () => {
    const { codec } = fakeCodec();
    const { provider, calls } = fakeStt();
    const a = createTelegramVoiceAdapter({ sttProvider: provider, codec });
    await a.transcribeOgg(Buffer.from('x'), { language: 'en' });
    expect(calls[0].lang).toBe('en');
  });

  it('falls back to opts.voiceLanguage from adapter when transcribe lang missing', async () => {
    const { codec } = fakeCodec();
    const { provider, calls } = fakeStt();
    const a = createTelegramVoiceAdapter({ sttProvider: provider, codec, voiceLanguage: 'ko' });
    await a.transcribeOgg(Buffer.from('x'));
    expect(calls[0].lang).toBe('ko');
  });
});

describe('createTelegramVoiceAdapter — generateReply replyMode resolution', () => {
  it("'auto' + fromVoice=true → voice", async () => {
    const { codec, pcm24kIn } = fakeCodec();
    const { provider } = fakeStt();
    const tts = fakeTts();
    const a = createTelegramVoiceAdapter({ sttProvider: provider, ttsProvider: tts.provider, codec });
    const reply = await a.generateReply('네, 알겠습니다', { fromVoice: true });
    expect(reply.text).toBe('네, 알겠습니다');
    expect(reply.voiceOgg).not.toBeNull();
    expect(pcm24kIn.length).toBe(1);
    expect(tts.calls).toEqual(['네, 알겠습니다']);
  });

  it("'auto' + fromVoice=false → text only", async () => {
    const { codec, pcm24kIn } = fakeCodec();
    const { provider } = fakeStt();
    const tts = fakeTts();
    const a = createTelegramVoiceAdapter({ sttProvider: provider, ttsProvider: tts.provider, codec });
    const reply = await a.generateReply('hi', { fromVoice: false });
    expect(reply.text).toBe('hi');
    expect(reply.voiceOgg).toBeNull();
    expect(pcm24kIn.length).toBe(0);
    expect(tts.calls.length).toBe(0);
  });

  it("'text' overrides → text even on voice input", async () => {
    const { codec } = fakeCodec();
    const { provider } = fakeStt();
    const tts = fakeTts();
    const a = createTelegramVoiceAdapter({ sttProvider: provider, ttsProvider: tts.provider, codec, replyMode: 'text' });
    const reply = await a.generateReply('안녕', { fromVoice: true });
    expect(reply.voiceOgg).toBeNull();
    expect(tts.calls.length).toBe(0);
  });

  it("'voice' overrides → voice even on text input", async () => {
    const { codec } = fakeCodec();
    const { provider } = fakeStt();
    const tts = fakeTts();
    const a = createTelegramVoiceAdapter({ sttProvider: provider, ttsProvider: tts.provider, codec, replyMode: 'voice' });
    const reply = await a.generateReply('안녕', { fromVoice: false });
    expect(reply.voiceOgg).not.toBeNull();
    expect(tts.calls).toEqual(['안녕']);
  });

  it('falls back to text-only when ttsProvider missing (any mode)', async () => {
    const { codec } = fakeCodec();
    const { provider } = fakeStt();
    const a = createTelegramVoiceAdapter({ sttProvider: provider, codec, replyMode: 'voice' });
    const reply = await a.generateReply('안녕', { fromVoice: true });
    expect(reply.voiceOgg).toBeNull();
    expect(reply.text).toBe('안녕');
  });
});

describe('normalizeTelegramVoiceReplyMode', () => {
  it('preserves text / voice', () => {
    expect(normalizeTelegramVoiceReplyMode('text')).toBe('text');
    expect(normalizeTelegramVoiceReplyMode('voice')).toBe('voice');
  });
  it('preserves auto', () => {
    expect(normalizeTelegramVoiceReplyMode('auto')).toBe('auto');
  });
  it('coerces unknown / wrong types to auto', () => {
    expect(normalizeTelegramVoiceReplyMode('weird')).toBe('auto');
    expect(normalizeTelegramVoiceReplyMode(undefined)).toBe('auto');
    expect(normalizeTelegramVoiceReplyMode(123)).toBe('auto');
    expect(normalizeTelegramVoiceReplyMode(null)).toBe('auto');
  });
});
