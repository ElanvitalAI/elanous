// PR-S1V.13 (sprint 22 §1.1 · 2026-04-30) — Daemon-wide streaming STT
// singleton.
//
// Mirrors `voice-rest-handler.ts` `initDaemonSttProvider` (batch / Whisper
// REST) but for the streaming-STT contract used by the PWA voice WS
// adapter. The two are intentionally separate singletons:
//
//   - batch  : `/v1/voice/transcribe` (request-scoped POST · Whisper REST)
//   - stream : `/v1/voice/ws`        (long-lived WS · realtime STT)
//
// Without this wire, PR #1223's daemon boot fell back to a stub
// `createStubPwaVoiceAdapter` because the only daemon-resident STT
// singleton was batch-only — incompatible with the streaming-only PWA
// adapter contract. Wiring this in lets the PWA WS endpoint operate
// end-to-end in dogfood.
//
// Provider resolution order (MEMORY pattern):
//   user-config voice.stt.provider > env STREAMING_STT_PROVIDER > default
// (default = 'openai-realtime-stt' — only one currently considered
// production-grade for browser-side realtime feedback).

import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config/reader.js';
import {
  createStreamingSTTProvider,
  resolveStreamingSTTProviderIdFromEnv,
  type StreamingSTTProvider,
  type StreamingSTTProviderId,
} from './streaming-stt/streaming-stt-provider.js';

let cached: StreamingSTTProvider | null = null;
let initInFlight: Promise<StreamingSTTProvider | null> | null = null;

const UNPAID_STT_DEFAULT: StreamingSTTProviderId = 'openai-realtime-stt';
const STT_FREE_FALLBACK: StreamingSTTProviderId = 'whisper-cpp-local';

function credentialResolves(name: string): boolean {
  return (process.env[name] ?? '').trim().length > 0;
}

/** Pure availability for a streaming STT id. Paid OpenAI needs its
 *  credential class; the local whisper fallback never does. Ids this
 *  predicate does not measure throw — a failed measurement is not "absent". */
export function isStreamingSttProviderUsableNow(id: StreamingSTTProviderId): boolean {
  switch (id) {
    case 'openai-realtime-stt':
      return credentialResolves('OPENAI_API_KEY');
    case 'whisper-cpp-local':
      return true;
    case 'gemini-live-stt':
    case 'elevenlabs-scribe-realtime':
      throw new Error(`streaming STT availability unmeasured: ${id}`);
  }
}

function resolveProviderId(): StreamingSTTProviderId {
  let configOverride: StreamingSTTProviderId | undefined;
  try {
    const cfg = getUserConfig();
    const v = cfg.voice?.stt?.provider;
    if (
      v === 'openai-realtime-stt'
      || v === 'gemini-live-stt'
      || v === 'whisper-cpp-local'
      || v === 'elevenlabs-scribe-realtime'
    ) {
      configOverride = v;
    }
  } catch {
    // user-config not loaded yet — fall through to env.
  }
  const explicitEnv = (process.env.STREAMING_STT_PROVIDER ?? '').trim().length > 0;
  const chosen = resolveStreamingSTTProviderIdFromEnv(
    UNPAID_STT_DEFAULT,
    configOverride ? { configOverride } : {},
  );
  const unpaidDefault = !configOverride && !explicitEnv && chosen === UNPAID_STT_DEFAULT;
  if (!unpaidDefault) return chosen;
  let usable = true;
  try {
    usable = isStreamingSttProviderUsableNow(chosen);
  } catch {
    return chosen;
  }
  if (usable) return chosen;
  return isStreamingSttProviderUsableNow(STT_FREE_FALLBACK) ? STT_FREE_FALLBACK : chosen;
}

/** G-VOX-1 (2026-06-02) — Read provider-specific user-config fields
 *  (apiKey · model · realtimeBaseModel) so the provider constructor
 *  picks them up. Without this read the constructor sees `cfg={id}`
 *  and falls through to env (legacy backward-compat only). Returns
 *  an empty record if user-config not yet loaded — safe no-op. */
function readSttUserConfigFields(): {
  apiKey?: string;
  model?: string;
  realtimeBaseModel?: string;
} {
  try {
    const stt = getUserConfig().voice?.stt;
    if (!stt) return {};
    return {
      ...(stt.apiKey ? { apiKey: stt.apiKey } : {}),
      ...(stt.model ? { model: stt.model } : {}),
      ...(stt.realtimeBaseModel ? { realtimeBaseModel: stt.realtimeBaseModel } : {}),
    };
  } catch {
    return {};
  }
}

async function instantiateForId(
  id: StreamingSTTProviderId,
): Promise<StreamingSTTProvider> {
  const extras = readSttUserConfigFields();
  switch (id) {
    case 'openai-realtime-stt':
      return createStreamingSTTProvider({
        id,
        ...(extras.apiKey ? { apiKey: extras.apiKey } : {}),
        ...(extras.model ? { model: extras.model } : {}),
        ...(extras.realtimeBaseModel ? { realtimeBaseModel: extras.realtimeBaseModel } : {}),
      });
    // ⚠ cross-provider leak 수리 (2026-07-12): `voice.stt.apiKey`/`model`
    // 은 문서화된 의미가 OpenAI 필드다 (apiKey doc: "OpenAI API key for
    // openai-realtime-stt"). 활성 프로바이더가 gemini/scribe 일 때 이
    // 값을 그대로 주입하면 OpenAI 키가 GEMINI_API_KEY/xi-api-key 로,
    // `gpt-realtime-whisper` 가 남의 model_id 로 들어가 auth/모델 에러.
    // 비-OpenAI 프로바이더는 각자의 env 체인(GEMINI_API_KEY ·
    // ELEVENLABS_API_KEY·ELEVENLABS_STT_MODEL_ID 등)을 탄다.
    case 'gemini-live-stt':
      return createStreamingSTTProvider({ id });
    case 'whisper-cpp-local':
      return createStreamingSTTProvider({ id });
    case 'elevenlabs-scribe-realtime':
      return createStreamingSTTProvider({ id });
  }
}

/**
 * Initialise the daemon-wide streaming STT singleton. Returns null when
 * the resolved provider is unavailable (missing API key, missing local
 * binary, etc.) — the caller surfaces that as a `voice ws: UNAVAILABLE`
 * boot log so the user knows what env / config to set.
 *
 * Concurrent callers share a single in-flight promise. After resolution
 * the cached provider (or null) sticks until the process exits or
 * `setDaemonStreamingSttProviderForTesting` is invoked.
 */
/** Test seam — the id `initDaemonStreamingSttProvider` will instantiate. */
export function resolveDaemonStreamingSttProviderIdForTesting(): StreamingSTTProviderId {
  return resolveProviderId();
}

export async function initDaemonStreamingSttProvider(): Promise<StreamingSTTProvider | null> {
  if (cached) return cached;
  if (initInFlight) return initInFlight;
  initInFlight = (async () => {
    const id = resolveProviderId();
    try {
      const provider = await instantiateForId(id);
      cached = provider;
      if (debug.enabled) {
        debug.log('voice.streaming-stt.singleton', 'init.ok', {
          providerId: provider.id,
        });
      }
      return provider;
    } catch (err) {
      if (debug.enabled) {
        debug.log('voice.streaming-stt.singleton', 'init.unavailable', {
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
 *  `initDaemonStreamingSttProvider` has resolved. */
export function getDaemonStreamingSttProvider(): StreamingSTTProvider | null {
  return cached;
}

/** Test seam — replace the cached provider directly (or reset to null).
 *  Returns a restore function that puts the previous state back. */
export function setDaemonStreamingSttProviderForTesting(
  p: StreamingSTTProvider | null,
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
