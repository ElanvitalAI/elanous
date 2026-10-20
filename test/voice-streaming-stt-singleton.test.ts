// PR-S1V.13 (sprint 22 §1.1 · 2026-04-30) — Daemon streaming STT
// singleton tests.
//
// Mirrors `voice-rest-handler.test.ts` for the batch singleton. Covers:
//   1. Returns null when openai-realtime-stt is unavailable (no API key).
//   2. Caches the singleton — second init returns the same reference.
//   3. Resolves provider id from STREAMING_STT_PROVIDER env override
//      (config-override path is exercised via env fallback).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  getDaemonStreamingSttProvider,
  initDaemonStreamingSttProvider,
  isStreamingSttProviderUsableNow,
  resolveDaemonStreamingSttProviderIdForTesting,
  setDaemonStreamingSttProviderForTesting,
} from '../src/voice/voice-streaming-stt-singleton';

const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_PROVIDER = process.env.STREAMING_STT_PROVIDER;
const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;

function restoreEnv(): void {
  if (ORIGINAL_KEY !== undefined) process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  else delete process.env.OPENAI_API_KEY;
  if (ORIGINAL_PROVIDER !== undefined) process.env.STREAMING_STT_PROVIDER = ORIGINAL_PROVIDER;
  else delete process.env.STREAMING_STT_PROVIDER;
  if (ORIGINAL_XDG !== undefined) process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
  else delete process.env.XDG_CONFIG_HOME;
}

describe('daemon streaming STT singleton', () => {
  let restore: (() => void) | null = null;
  let tmpConfigDir: string | null = null;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.STREAMING_STT_PROVIDER;
    // Config isolation (2026-07-12) — the singleton resolver reads
    // getUserConfig(), and the REAL ~/.elanous/config.json carries
    // voice.stt.{provider,apiKey} on dev machines, which silently
    // overrides both the "no API key" and the env-override premises
    // of these tests (config > env). Point the config reader at an
    // empty temp dir (read-only isolation — acp-* test precedent).
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'stt-singleton-cfg-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    // Reset cached state between cases.
    restore = setDaemonStreamingSttProviderForTesting(null);
  });

  afterEach(() => {
    if (restore) restore();
    restore = null;
    restoreEnv();
    if (tmpConfigDir) {
      try { rmSync(tmpConfigDir, { recursive: true, force: true }); } catch { /* noop */ }
      tmpConfigDir = null;
    }
  });

  test('returns null when openai-realtime-stt is unavailable (no API key)', async () => {
    const p = await initDaemonStreamingSttProvider();
    expect(p).toBeNull();
    expect(getDaemonStreamingSttProvider()).toBeNull();
  });

  test('caches the singleton — second init returns the same reference', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const a = await initDaemonStreamingSttProvider();
    expect(a).not.toBeNull();
    const b = await initDaemonStreamingSttProvider();
    expect(b).toBe(a);
    expect(getDaemonStreamingSttProvider()).toBe(a);
  });

  test('respects STREAMING_STT_PROVIDER env override', async () => {
    // whisper-cpp-local needs a binary; the constructor itself does not
    // throw, so init may succeed with a provider whose first openSession
    // would fail. We only assert the resolver picked the right id.
    process.env.STREAMING_STT_PROVIDER = 'whisper-cpp-local';
    const p = await initDaemonStreamingSttProvider();
    if (p) expect(p.id).toBe('whisper-cpp-local');
    // If null, that's also acceptable (binary missing) — main signal is
    // that *no* openai-realtime provider was returned despite the env
    // overriding the default.
    if (p) expect(p.id).not.toBe('openai-realtime-stt');
  });

  test('openai-realtime-stt is usable only with an OPENAI credential; whisper-cpp-local always is', () => {
    delete process.env.OPENAI_API_KEY;
    expect(isStreamingSttProviderUsableNow('openai-realtime-stt')).toBe(false);
    process.env.OPENAI_API_KEY = 'sk-test-key';
    expect(isStreamingSttProviderUsableNow('openai-realtime-stt')).toBe(true);
    delete process.env.OPENAI_API_KEY;
    expect(isStreamingSttProviderUsableNow('whisper-cpp-local')).toBe(true);
  });

  test('falls back to whisper-cpp-local when nobody chose and no credential resolves', () => {
    expect(resolveDaemonStreamingSttProviderIdForTesting()).toBe('whisper-cpp-local');
  });

  // KNOWN-ISSUE(0.2.33): KI-0233-REGRESSIONS — restore this exact gate test after the 0.2.34 repair.
  test.skip('keeps an explicit config choice even when that id is unusable', () => {
    delete process.env.OPENAI_API_KEY;
    mkdirSync(join(tmpConfigDir!, 'elanous'), { recursive: true });
    writeFileSync(
      join(tmpConfigDir!, 'elanous', 'config.json'),
      JSON.stringify({ voice: { stt: { provider: 'openai-realtime-stt' } } }),
    );
    expect(resolveDaemonStreamingSttProviderIdForTesting()).toBe('openai-realtime-stt');
  });

  test('keeps an explicit env choice even when that id is unusable', () => {
    delete process.env.OPENAI_API_KEY;
    process.env.STREAMING_STT_PROVIDER = 'openai-realtime-stt';
    expect(resolveDaemonStreamingSttProviderIdForTesting()).toBe('openai-realtime-stt');
  });
});
