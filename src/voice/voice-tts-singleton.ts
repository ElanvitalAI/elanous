// PR-S1V.15 (sprint 22 §A · 2026-04-30) — Daemon-wide TTS singleton.
//
// Mirrors `voice-streaming-stt-singleton.ts` (§1.1) and
// `voice-rest-handler.ts` `initDaemonSttProvider` (batch STT) for the
// synthesis side. Initialised once at daemon boot so the PWA TTS
// bridge (§1.2 / §B follow-up) can synthesise response text into
// browser-bound PCM frames without re-instantiating a provider per
// turn.
//
// Provider resolution order (MEMORY pattern — user-config wins over env):
//   user-config voice.tts.provider > env TTS_PROVIDER > default 'openai-tts'

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import {
  createTTSProvider,
  resolveTTSProviderIdFromEnv,
  type TTSProvider,
  type TTSProviderId,
} from './tts/tts-provider.js';

let cached: TTSProvider | null = null;
let initInFlight: Promise<TTSProvider | null> | null = null;

const UNPAID_TTS_DEFAULT: TTSProviderId = 'openai-tts';
const TTS_FREE_FALLBACK: readonly TTSProviderId[] = ['edge-tts', 'macos-say'];

function credentialResolves(name: string): boolean {
  return (process.env[name] ?? '').trim().length > 0;
}

interface TtsAvailabilityDeps {
  which(name: string): string | null;
  exists(path: string): boolean;
  executable(path: string): boolean;
  platform: NodeJS.Platform;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const defaultTtsAvailabilityDeps: TtsAvailabilityDeps = {
  which: (name) => Bun.which(name),
  exists: existsSync,
  executable: isExecutableFile,
  platform: process.platform,
};

/** Paid ids need credentials; free ids need their local executables. */
export function isTtsProviderUsableNow(
  ...[id, deps = defaultTtsAvailabilityDeps]: [TTSProviderId, TtsAvailabilityDeps?]
): boolean {
  switch (id) {
    case 'openai-tts':
      return credentialResolves('OPENAI_API_KEY');
    case 'elevenlabs-tts':
      return credentialResolves('ELEVENLABS_API_KEY');
    case 'edge-tts': {
      const binary = process.env.EDGE_TTS_BIN?.trim();
      return (binary ? deps.exists(binary) && deps.executable(binary) : deps.which('edge-tts') !== null)
        && deps.which('sox') !== null;
    }
    case 'macos-say':
      return deps.platform === 'darwin' && deps.which('say') !== null;
  }
}

function resolveProviderId(deps: TtsAvailabilityDeps = defaultTtsAvailabilityDeps): TTSProviderId {
  let configOverride: TTSProviderId | undefined;
  try {
    const cfg = getUserConfig();
    const v = cfg.voice?.tts?.provider;
    if (
      v === 'openai-tts'
      || v === 'elevenlabs-tts'
      || v === 'edge-tts'
      || v === 'macos-say'
    ) {
      configOverride = v;
    }
  } catch {
    // user-config not loaded yet — fall through to env.
  }
  const explicitEnv = (process.env.TTS_PROVIDER ?? '').trim().length > 0;
  const chosen = resolveTTSProviderIdFromEnv(
    UNPAID_TTS_DEFAULT,
    configOverride ? { configOverride } : {},
  );
  const unpaidDefault = !configOverride && !explicitEnv && chosen === UNPAID_TTS_DEFAULT;
  if (!unpaidDefault) return chosen;
  let usable = true;
  try {
    usable = isTtsProviderUsableNow(chosen, deps);
  } catch {
    return chosen;
  }
  if (usable) return chosen;
  const free = TTS_FREE_FALLBACK.find((id) => isTtsProviderUsableNow(id, deps));
  if (free) return free;
  debug.log('voice.tts', 'no-usable-provider', { tried: [chosen, ...TTS_FREE_FALLBACK] });
  return chosen;
}

/** config화 (2026-07-12) — `voice.tts.voiceId` 를 provider 생성자에
 *  전달. elevenlabs 는 `voiceId`(UUID), 나머지는 `voice`(이름) 필드.
 *  미설정이면 각 프로바이더의 env(`ELEVENLABS_VOICE_ID` 등) → 기본값
 *  체인이 그대로 동작한다. */
function readTtsVoiceIdFromConfig(): string | undefined {
  try {
    const v = getUserConfig().voice?.tts?.voiceId?.trim();
    return v && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

async function instantiateForId(
  id: TTSProviderId,
): Promise<TTSProvider> {
  const voiceId = readTtsVoiceIdFromConfig();
  switch (id) {
    case 'openai-tts':
      return createTTSProvider({ id, ...(voiceId ? { voice: voiceId } : {}) });
    case 'elevenlabs-tts':
      return createTTSProvider({ id, ...(voiceId ? { voiceId } : {}) });
    case 'edge-tts':
      return createTTSProvider({ id, ...(voiceId ? { voice: voiceId } : {}) });
    case 'macos-say':
      return createTTSProvider({ id, ...(voiceId ? { voice: voiceId } : {}) });
  }
}

/**
 * Initialise the daemon-wide TTS singleton. Returns null when the
 * resolved provider is unavailable (missing API key, missing local
 * binary, etc.) — caller surfaces that as a `voice: TTS inactive` log.
 *
 * Concurrent callers share a single in-flight promise. After
 * resolution the cached provider (or null) sticks until the process
 * exits or `setDaemonTtsProviderForTesting` is invoked.
 */
/** Test seam — the id `initDaemonTtsProvider` will instantiate. */
export function resolveDaemonTtsProviderIdForTesting(): TTSProviderId {
  return resolveProviderId();
}

/** Resolve with a fake local executable probe without touching the host PATH. */
export function resolveDaemonTtsProviderIdWithDepsForTesting(deps: TtsAvailabilityDeps): TTSProviderId {
  return resolveProviderId(deps);
}

export async function initDaemonTtsProvider(): Promise<TTSProvider | null> {
  if (cached) return cached;
  if (initInFlight) return initInFlight;
  initInFlight = (async () => {
    const id = resolveProviderId();
    try {
      const provider = await instantiateForId(id);
      cached = provider;
      if (debug.enabled) {
        debug.log('voice.tts.singleton', 'init.ok', {
          providerId: provider.id,
        });
      }
      return provider;
    } catch (err) {
      if (debug.enabled) {
        debug.log('voice.tts.singleton', 'init.unavailable', {
          providerId: id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    } finally {
      initInFlight = null;
    }
  })();
  return initInFlight;
}

/** Sync getter — returns the cached singleton or null. Call after
 *  `initDaemonTtsProvider` has resolved. */
export function getDaemonTtsProvider(): TTSProvider | null {
  return cached;
}

/** Test seam — replace the cached provider directly (or reset to null).
 *  Returns a restore function that puts the previous state back. */
export function setDaemonTtsProviderForTesting(
  p: TTSProvider | null,
): () => void {
  const prev = cached;
  const prevInit = initInFlight;
  cached = p;
  initInFlight = null;
  return () => {
    cached = prev;
    initInFlight = prevInit;
  };
}
