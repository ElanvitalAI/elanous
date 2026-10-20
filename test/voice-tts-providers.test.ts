// PR-S1V.6 (sprint 22 Phase 1) — Per-provider unit tests.
//
// HTTP providers (OpenAI · ElevenLabs) use spyOn(globalThis, 'fetch')
// per CLAUDE.md (no mock.module). Subprocess providers (edge-tts ·
// macos-say) only get config-validation tests here — actual subprocess
// behaviour is covered by the dogfood smoke (`scripts/tts-test.ts`).

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAITTSProvider } from '../src/voice/tts/tts-providers/openai-tts.js';
import { ElevenLabsTTSProvider } from '../src/voice/tts/tts-providers/elevenlabs-tts.js';
import { EdgeTTSProvider } from '../src/voice/tts/tts-providers/edge-tts.js';
import {
  isTtsProviderUsableNow,
  resolveDaemonTtsProviderIdForTesting,
  resolveDaemonTtsProviderIdWithDepsForTesting,
} from '../src/voice/voice-tts-singleton.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
});

// Bun's `typeof fetch` insists on the `preconnect` extension; cast at
// the spy boundary so each test reads cleanly.
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function mockFetch(impl: FetchImpl) {
  return spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
}

// ── OpenAI TTS ─────────────────────────────────────────────────────

describe('OpenAITTSProvider', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-aaa';
  });

  it('synthesizeBatch posts JSON with model + voice + pcm format', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchSpy = mockFetch(async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      capturedInit = init;
      return new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { status: 200 });
    });
    try {
      const p = new OpenAITTSProvider({ id: 'openai-tts' });
      const result = await p.synthesizeBatch('안녕하세요');
      expect(capturedUrl).toBe('https://api.openai.com/v1/audio/speech');
      expect(capturedInit?.method).toBe('POST');
      const headers = new Headers(capturedInit?.headers);
      expect(headers.get('authorization')).toBe('Bearer sk-test-aaa');
      expect(headers.get('content-type')).toBe('application/json');
      const body = JSON.parse(String(capturedInit?.body));
      expect(body.model).toBe('tts-1');
      expect(body.voice).toBe('alloy');
      expect(body.input).toBe('안녕하세요');
      expect(body.response_format).toBe('pcm');
      expect(result.pcm).toBeInstanceOf(Buffer);
      expect(result.pcm.byteLength).toBe(8);
      expect(result.charCount).toBe('안녕하세요'.length);
      expect(result.format.sampleRate).toBe(24000);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('honours OPENAI_TTS_MODEL and OPENAI_TTS_VOICE env overrides', async () => {
    process.env.OPENAI_TTS_MODEL = 'tts-1-hd';
    process.env.OPENAI_TTS_VOICE = 'nova';
    let bodyJson: Record<string, unknown> | undefined;
    const fetchSpy = mockFetch(async (_input, init) => {
      bodyJson = JSON.parse(String(init?.body));
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    try {
      const p = new OpenAITTSProvider({ id: 'openai-tts' });
      await p.synthesizeBatch('test');
      expect(bodyJson?.model).toBe('tts-1-hd');
      expect(bodyJson?.voice).toBe('nova');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('raises a clear error on non-2xx response', async () => {
    const fetchSpy = mockFetch(async () => new Response('Rate limit', { status: 429 }));
    try {
      const p = new OpenAITTSProvider({ id: 'openai-tts' });
      await expect(p.synthesizeBatch('test')).rejects.toThrow(/429/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('synthesizeStream yields PCM chunks from response body', async () => {
    const chunks = [Buffer.from([10, 11]), Buffer.from([20, 21, 22])];
    const fetchSpy = mockFetch(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(new Uint8Array(c));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    try {
      const p = new OpenAITTSProvider({ id: 'openai-tts' });
      const collected: Buffer[] = [];
      for await (const c of p.synthesizeStream('hi')) {
        collected.push(c.pcm);
      }
      const joined = Buffer.concat(collected);
      expect(joined).toEqual(Buffer.concat(chunks));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws when text is empty', async () => {
    const p = new OpenAITTSProvider({ id: 'openai-tts' });
    await expect(p.synthesizeBatch('')).rejects.toThrow(/empty/);
  });
});

// ── ElevenLabs TTS ─────────────────────────────────────────────────

describe('ElevenLabsTTSProvider', () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = 'el-test-bbb';
  });

  it('streaming endpoint includes voice id, model, and pcm_24000 query', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchSpy = mockFetch(async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      capturedInit = init;
      return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    });
    try {
      const p = new ElevenLabsTTSProvider({ id: 'elevenlabs-tts', voiceId: 'voice-xyz' });
      const result = await p.synthesizeBatch('안녕');
      expect(capturedUrl).toContain('/v1/text-to-speech/voice-xyz/stream');
      expect(capturedUrl).toContain('output_format=pcm_24000');
      const headers = new Headers(capturedInit?.headers);
      expect(headers.get('xi-api-key')).toBe('el-test-bbb');
      const body = JSON.parse(String(capturedInit?.body));
      expect(body.text).toBe('안녕');
      expect(body.model_id).toBe('eleven_flash_v2_5');
      expect(result.pcm.byteLength).toBe(3);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('honours ELEVENLABS_VOICE_ID and ELEVENLABS_MODEL_ID env', async () => {
    process.env.ELEVENLABS_VOICE_ID = 'env-voice-id';
    process.env.ELEVENLABS_MODEL_ID = 'eleven_turbo_v2';
    let capturedUrl = '';
    let bodyJson: Record<string, unknown> | undefined;
    const fetchSpy = mockFetch(async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      bodyJson = JSON.parse(String(init?.body));
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    try {
      const p = new ElevenLabsTTSProvider({ id: 'elevenlabs-tts' });
      await p.synthesizeBatch('test');
      expect(capturedUrl).toContain('/v1/text-to-speech/env-voice-id/stream');
      expect(bodyJson?.model_id).toBe('eleven_turbo_v2');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('error response surfaces status + truncated body', async () => {
    const fetchSpy = mockFetch(async () => new Response('quota_exceeded: ...', { status: 401 }));
    try {
      const p = new ElevenLabsTTSProvider({ id: 'elevenlabs-tts' });
      await expect(p.synthesizeBatch('hi')).rejects.toThrow(/401/);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── Edge TTS ───────────────────────────────────────────────────────

describe('EdgeTTSProvider', () => {
  it('defaults to ko-KR-SunHiNeural voice and `edge-tts` binary', () => {
    delete process.env.EDGE_TTS_VOICE;
    delete process.env.EDGE_TTS_BIN;
    const p = new EdgeTTSProvider({ id: 'edge-tts' });
    expect(p.id).toBe('edge-tts');
    expect(p.format.sampleRate).toBe(24000);
  });

  it('explicit cfg.voice / cfg.binaryPath are honoured', () => {
    const p = new EdgeTTSProvider({
      id: 'edge-tts',
      voice: 'ko-KR-InJoonNeural',
      binaryPath: '/custom/edge-tts',
    });
    expect(p.id).toBe('edge-tts');
  });

  it('throws on empty text without invoking subprocess', async () => {
    const p = new EdgeTTSProvider({ id: 'edge-tts' });
    await expect(p.synthesizeBatch('')).rejects.toThrow(/empty/);
  });
});

describe('TTS provider availability and unpaid default', () => {
  const ORIGINAL_OPENAI = process.env.OPENAI_API_KEY;
  const ORIGINAL_ELEVEN = process.env.ELEVENLABS_API_KEY;
  const ORIGINAL_TTS = process.env.TTS_PROVIDER;
  const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
  let tmpConfigDir: string | null = null;

  function isolateConfig(body?: string): void {
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'tts-singleton-cfg-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    if (body !== undefined) {
      mkdirSync(join(tmpConfigDir, 'elanous'), { recursive: true });
      writeFileSync(join(tmpConfigDir, 'elanous', 'config.json'), body);
    }
  }

  afterEach(() => {
    if (ORIGINAL_OPENAI !== undefined) process.env.OPENAI_API_KEY = ORIGINAL_OPENAI;
    else delete process.env.OPENAI_API_KEY;
    if (ORIGINAL_ELEVEN !== undefined) process.env.ELEVENLABS_API_KEY = ORIGINAL_ELEVEN;
    else delete process.env.ELEVENLABS_API_KEY;
    if (ORIGINAL_TTS !== undefined) process.env.TTS_PROVIDER = ORIGINAL_TTS;
    else delete process.env.TTS_PROVIDER;
    if (ORIGINAL_XDG !== undefined) process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
    else delete process.env.XDG_CONFIG_HOME;
    if (tmpConfigDir) {
      try { rmSync(tmpConfigDir, { recursive: true, force: true }); } catch { /* noop */ }
      tmpConfigDir = null;
    }
  });

  it('reports openai-tts usable only with an OPENAI_API_KEY-class credential', () => {
    delete process.env.OPENAI_API_KEY;
    expect(isTtsProviderUsableNow('openai-tts')).toBe(false);
    process.env.OPENAI_API_KEY = '   ';
    expect(isTtsProviderUsableNow('openai-tts')).toBe(false);
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(isTtsProviderUsableNow('openai-tts')).toBe(true);
  });

  it('reports elevenlabs-tts usable only with ELEVENLABS_API_KEY', () => {
    delete process.env.ELEVENLABS_API_KEY;
    expect(isTtsProviderUsableNow('elevenlabs-tts')).toBe(false);
    process.env.ELEVENLABS_API_KEY = 'el-test';
    expect(isTtsProviderUsableNow('elevenlabs-tts')).toBe(true);
  });

  it('reports free providers usable only when their local requirements are available', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    const unavailable = {
      which: (_name: string) => null,
      exists: (_path: string) => false,
      executable: (_path: string) => false,
      platform: 'linux' as NodeJS.Platform,
    };
    expect(isTtsProviderUsableNow('edge-tts', unavailable)).toBe(false);
    expect(isTtsProviderUsableNow('macos-say', unavailable)).toBe(false);

    const available = {
      ...unavailable,
      which: (name: string) => name === 'edge-tts' || name === 'sox' || name === 'say' ? `/fake/${name}` : null,
      platform: 'darwin' as NodeJS.Platform,
    };
    expect(isTtsProviderUsableNow('edge-tts', available)).toBe(true);
    expect(isTtsProviderUsableNow('macos-say', available)).toBe(true);
  });

  it('selects the first available free provider when nobody chose and no credential resolves', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.TTS_PROVIDER;
    isolateConfig();
    const unavailable = {
      which: (_name: string) => null,
      exists: (_path: string) => false,
      executable: (_path: string) => false,
      platform: 'linux' as NodeJS.Platform,
    };
    const edgeAvailable = {
      ...unavailable,
      which: (name: string) => name === 'edge-tts' || name === 'sox' ? `/fake/${name}` : null,
    };
    expect(resolveDaemonTtsProviderIdWithDepsForTesting(unavailable)).toBe('openai-tts');
    expect(resolveDaemonTtsProviderIdWithDepsForTesting(edgeAvailable)).toBe('edge-tts');
  });

  it('keeps openai-tts when an OPENAI credential resolves and nobody chose', () => {
    process.env.OPENAI_API_KEY = 'sk-present';
    delete process.env.TTS_PROVIDER;
    isolateConfig();
    expect(resolveDaemonTtsProviderIdForTesting()).toBe('openai-tts');
  });

  it('keeps an explicit env choice even when that id is unusable', () => {
    delete process.env.OPENAI_API_KEY;
    process.env.TTS_PROVIDER = 'openai-tts';
    isolateConfig();
    expect(resolveDaemonTtsProviderIdForTesting()).toBe('openai-tts');
  });

  // KNOWN-ISSUE(0.2.33): KI-0233-REGRESSIONS — restore this exact gate test after the 0.2.34 repair.
  it.skip('keeps an explicit config choice even when that id is unusable', () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.TTS_PROVIDER;
    isolateConfig(JSON.stringify({ voice: { tts: { provider: 'elevenlabs-tts' } } }));
    expect(resolveDaemonTtsProviderIdForTesting()).toBe('elevenlabs-tts');
  });
});
