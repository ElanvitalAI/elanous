import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { setUserConfigOverlay } from '../user-config.js';
import {
  isTtsProviderUsableNow,
  resolveDaemonTtsProviderIdWithDepsForTesting,
} from './voice-tts-singleton.js';

const original = {
  openaiKey: process.env.OPENAI_API_KEY,
  elevenlabsKey: process.env.ELEVENLABS_API_KEY,
  edgeBin: process.env.EDGE_TTS_BIN,
  provider: process.env.TTS_PROVIDER,
};

function fakeDeps(
  platform: NodeJS.Platform,
  names: string[] = [],
  paths: string[] = [],
  executablePaths: string[] = paths,
) {
  return {
    platform,
    which: (name: string) => names.includes(name) ? `/bin/${name}` : null,
    exists: (path: string) => paths.includes(path),
    executable: (path: string) => executablePaths.includes(path),
  };
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('TTS provider availability and free fallback', () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.EDGE_TTS_BIN;
    delete process.env.TTS_PROVIDER;
    setUserConfigOverlay((c) => ({ ...c, voice: { ...c.voice, tts: {} } }));
  });

  afterEach(() => {
    restore('OPENAI_API_KEY', original.openaiKey);
    restore('ELEVENLABS_API_KEY', original.elevenlabsKey);
    restore('EDGE_TTS_BIN', original.edgeBin);
    restore('TTS_PROVIDER', original.provider);
    setUserConfigOverlay(null);
  });

  test('edge-tts needs both edge-tts and sox on PATH', () => {
    expect(isTtsProviderUsableNow('edge-tts', fakeDeps('linux', ['sox']))).toBe(false);
    expect(isTtsProviderUsableNow('edge-tts', fakeDeps('linux', ['edge-tts']))).toBe(false);
    expect(isTtsProviderUsableNow('edge-tts', fakeDeps('linux', ['edge-tts', 'sox']))).toBe(true);
  });

  test('EDGE_TTS_BIN must exist and still needs sox', () => {
    process.env.EDGE_TTS_BIN = '/custom/edge-tts';
    expect(isTtsProviderUsableNow('edge-tts', fakeDeps('linux', ['edge-tts', 'sox']))).toBe(false);
    expect(isTtsProviderUsableNow('edge-tts', fakeDeps('linux', [], ['/custom/edge-tts']))).toBe(false);
    expect(isTtsProviderUsableNow('edge-tts', fakeDeps('linux', ['sox'], ['/custom/edge-tts']))).toBe(true);
  });

  test('EDGE_TTS_BIN must be an executable file, not a directory or non-executable file', () => {
    process.env.EDGE_TTS_BIN = '/custom/edge-tts';
    expect(isTtsProviderUsableNow('edge-tts', fakeDeps('linux', ['sox'], ['/custom/edge-tts'], []))).toBe(false);
    expect(isTtsProviderUsableNow('edge-tts', fakeDeps('linux', ['sox'], ['/custom/edge-tts']))).toBe(true);
  });

  test('default EDGE_TTS_BIN probe rejects directories and non-executable files', () => {
    const dir = mkdtempSync(join(process.cwd(), '.elanous-test-edge-bin-'));
    try {
      const file = join(dir, 'edge-tts');
      writeFileSync(file, '#!/bin/sh\n');
      process.env.EDGE_TTS_BIN = dir;
      expect(isTtsProviderUsableNow('edge-tts')).toBe(false);
      process.env.EDGE_TTS_BIN = file;
      chmodSync(file, 0o644);
      expect(isTtsProviderUsableNow('edge-tts')).toBe(false);
      chmodSync(file, 0o755);
      if (Bun.which('sox')) expect(isTtsProviderUsableNow('edge-tts')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('macos-say needs darwin and say', () => {
    expect(isTtsProviderUsableNow('macos-say', fakeDeps('linux', ['say']))).toBe(false);
    expect(isTtsProviderUsableNow('macos-say', fakeDeps('darwin'))).toBe(false);
    expect(isTtsProviderUsableNow('macos-say', fakeDeps('darwin', ['say']))).toBe(true);
  });

  test('paid provider credential checks are unchanged', () => {
    const deps = fakeDeps('linux');
    expect(isTtsProviderUsableNow('openai-tts', deps)).toBe(false);
    expect(isTtsProviderUsableNow('elevenlabs-tts', deps)).toBe(false);
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ELEVENLABS_API_KEY = 'test-key';
    expect(isTtsProviderUsableNow('openai-tts', deps)).toBe(true);
    expect(isTtsProviderUsableNow('elevenlabs-tts', deps)).toBe(true);
  });

  test('selects only an installed free provider in fallback order', () => {
    expect(resolveDaemonTtsProviderIdWithDepsForTesting(fakeDeps('darwin', ['say']))).toBe('macos-say');
    expect(resolveDaemonTtsProviderIdWithDepsForTesting(fakeDeps('darwin', ['edge-tts', 'sox', 'say']))).toBe('edge-tts');
    process.env.OPENAI_API_KEY = 'test-key';
    expect(resolveDaemonTtsProviderIdWithDepsForTesting(fakeDeps('darwin', ['say']))).toBe('openai-tts');
  });

  test('linux without free binaries returns original choice and logs all tried ids', () => {
    const before = debug.events().length;
    expect(resolveDaemonTtsProviderIdWithDepsForTesting(fakeDeps('linux', ['sox']))).toBe('openai-tts');
    expect(debug.events().slice(before)).toContainEqual(expect.objectContaining({
      category: 'voice.tts',
      event: 'no-usable-provider',
      data: expect.objectContaining({ tried: ['openai-tts', 'edge-tts', 'macos-say'] }),
    }));
  });

  test('explicit env and config provider selections remain unchanged even if unavailable', () => {
    const deps = fakeDeps('linux');
    process.env.TTS_PROVIDER = 'edge-tts';
    expect(resolveDaemonTtsProviderIdWithDepsForTesting(deps)).toBe('edge-tts');
    setUserConfigOverlay((c) => ({ ...c, voice: { ...c.voice, tts: { provider: 'macos-say' } } }));
    expect(resolveDaemonTtsProviderIdWithDepsForTesting(deps)).toBe('macos-say');
  });
});
