// PR-S1V.15 (sprint 22 §A · 2026-04-30) — Daemon TTS singleton tests.
//
// Mirrors `voice-streaming-stt-singleton.test.ts` (§1.1) for the
// synthesis singleton. Covers:
//   1. Resolves a usable free fallback or returns null when no provider is usable.
//   2. Caches the singleton — second init returns the same reference.
//   3. Resolves provider id from TTS_PROVIDER env override.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  getDaemonTtsProvider,
  initDaemonTtsProviderWithDepsForTesting,
  setDaemonTtsProviderForTesting,
} from '../src/voice/voice-tts-singleton';
import type { TTSProvider, TTSProviderId } from '../src/voice/tts/tts-provider';
import { setUserConfigOverlay } from '../src/user-config';

const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_PROVIDER = process.env.TTS_PROVIDER;
const ORIGINAL_EDGE_TTS_BIN = process.env.EDGE_TTS_BIN;

function restoreEnv(): void {
  if (ORIGINAL_KEY !== undefined) process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  else delete process.env.OPENAI_API_KEY;
  if (ORIGINAL_PROVIDER !== undefined) process.env.TTS_PROVIDER = ORIGINAL_PROVIDER;
  else delete process.env.TTS_PROVIDER;
  if (ORIGINAL_EDGE_TTS_BIN !== undefined) process.env.EDGE_TTS_BIN = ORIGINAL_EDGE_TTS_BIN;
  else delete process.env.EDGE_TTS_BIN;
}

const noExecutables = {
  which: () => null,
  exists: () => false,
  executable: () => false,
  platform: 'linux' as NodeJS.Platform,
};

const edgeTtsAvailable = {
  which: (name: string) => name === 'edge-tts' || name === 'sox' ? `/fixture/${name}` : null,
  exists: () => true,
  executable: () => true,
  platform: 'linux' as NodeJS.Platform,
};

function fakeProvider(id: TTSProviderId): TTSProvider {
  return { id, format: { sampleRate: 24000, channels: 1, bitsPerSample: 16 },
    synthesizeBatch: async () => ({ pcm: Buffer.alloc(0), format: { sampleRate: 24000, channels: 1, bitsPerSample: 16 }, charCount: 0 }) };
}

async function fakeAvailableProvider(id: TTSProviderId): Promise<TTSProvider> {
  if (id === 'openai-tts' && !process.env.OPENAI_API_KEY) throw new Error('OpenAI TTS unavailable');
  return fakeProvider(id);
}

describe('daemon TTS singleton', () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.TTS_PROVIDER;
    delete process.env.EDGE_TTS_BIN;
    // Isolate the real user-config: config `voice.tts.provider` wins over
    // env in resolveProviderId, so a machine whose ~/.elanous config pins a
    // provider (e.g. elevenlabs-tts) would otherwise mask the env/default
    // path these tests exercise. Strip the tts config so resolution falls
    // through to TTS_PROVIDER env → default 'openai-tts'.
    setUserConfigOverlay((c) => ({ ...c, voice: { ...c.voice, tts: {} } }));
    restore = setDaemonTtsProviderForTesting(null);
  });

  afterEach(() => {
    if (restore) restore();
    restore = null;
    setUserConfigOverlay(null);
    restoreEnv();
  });

  test('uses the free fallback when no paid credential is set and edge-tts is available', async () => {
    const p = await initDaemonTtsProviderWithDepsForTesting(edgeTtsAvailable, fakeAvailableProvider);
    expect(p?.id).toBe('edge-tts');
    expect(getDaemonTtsProvider()).toBe(p);
  });

  test('returns null when no paid credential or free fallback executable is available', async () => {
    const p = await initDaemonTtsProviderWithDepsForTesting(noExecutables, fakeAvailableProvider);
    expect(p).toBeNull();
    expect(getDaemonTtsProvider()).toBeNull();
  });

  test('caches the singleton — second init returns the same reference', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const a = await initDaemonTtsProviderWithDepsForTesting(edgeTtsAvailable, fakeAvailableProvider);
    expect(a).not.toBeNull();
    const b = await initDaemonTtsProviderWithDepsForTesting(edgeTtsAvailable, fakeAvailableProvider);
    expect(b).toBe(a);
    expect(getDaemonTtsProvider()).toBe(a);
  });

  test('respects TTS_PROVIDER env override', async () => {
    process.env.TTS_PROVIDER = 'macos-say';
    const p = await initDaemonTtsProviderWithDepsForTesting(noExecutables, fakeAvailableProvider);
    expect(p?.id).toBe('macos-say');
  });
});
