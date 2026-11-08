// M1-2b (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// PWA ↔ daemon round-trip helpers. Stubs `fetch` so the tests stay
// network-isolated and exercise both happy + offline branches.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  fetchDaemonModelTier,
  hydrateFromDaemon,
  pushMonthlyCapToDaemon,
  pushLlmTierToDaemon,
  pushPresetToDaemon,
  pushTtsVoiceMappingToDaemon,
  pushSttTierToDaemon,
  type DaemonHttpConfig,
} from './model-tier-sync';
import { createFakeFetchDevice, type FakeFetchDevice } from '../test-devices/fake-fetch';

const CFG: DaemonHttpConfig = { baseUrl: 'http://localhost:31415', token: 'tk' };

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: FetchCall[] = [];
let fakeFetch: FakeFetchDevice | undefined;

function installFetch(
  responder: (call: FetchCall) => { status?: number; body?: unknown } | Error,
): void {
  fakeFetch?.restore();
  const respond = (request: { url: string; method: string; headers: Readonly<Record<string, string>>; body: string | null }) => {
    const url = request.url;
    const method = request.method;
    const headers = request.headers as Record<string, string>;
    let body: unknown;
    try { body = request.body ? JSON.parse(request.body) : undefined; } catch { body = request.body; }
    const call = { url, method, headers, body };
    calls.push(call);
    const r = responder(call);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return Response.json(r.body ?? {}, { status });
  };
  fakeFetch = createFakeFetchDevice([
    { url: '/v1/config/model-tier', method: 'GET', response: respond },
    { url: '/v1/config/model-tier', method: 'PUT', response: respond },
  ]);
}

function installLocalStorage(): void {
  const store = new Map<string, string>();
  const ls = {
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    setItem(k: string, v: string) { store.set(k, v); },
    removeItem(k: string) { store.delete(k); },
    clear() { store.clear(); },
    key(i: number) { return Array.from(store.keys())[i] ?? null; },
    get length() { return store.size; },
  };
  (globalThis as unknown as { window: object }).window = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = ls as Storage;
}

beforeEach(() => {
  calls = [];
  installLocalStorage();
});

afterEach(() => {
  fakeFetch?.restore();
  fakeFetch = undefined;
  delete (globalThis as unknown as { window?: object }).window;
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
});

describe('M1-2b · fetchDaemonModelTier', () => {
  test('parses voice.stt + monthlyUsdCap', async () => {
    installFetch(() => ({
      body: {
        modelTier: { voice: { stt: 'best' } },
        budget: { monthlyUsdCap: 25 },
      },
    }));
    const r = await fetchDaemonModelTier(CFG);
    expect(r).toEqual({ stt: 'best', monthlyUsdCap: 25 });
    expect(calls[0]?.url).toBe('http://localhost:31415/v1/config/model-tier');
    expect(calls[0]?.headers.authorization).toBe('Bearer tk');
  });

  test('empty daemon response → empty state object', async () => {
    installFetch(() => ({ body: {} }));
    expect(await fetchDaemonModelTier(CFG)).toEqual({});
  });

  test('non-OK → null', async () => {
    installFetch(() => ({ status: 500, body: { error: 'boom' } }));
    expect(await fetchDaemonModelTier(CFG)).toBeNull();
  });

  test('fetch throws (offline) → null', async () => {
    installFetch(() => new TypeError('Failed to fetch'));
    expect(await fetchDaemonModelTier(CFG)).toBeNull();
  });

  test('empty baseUrl → null without calling fetch', async () => {
    installFetch(() => ({ body: {} }));
    expect(await fetchDaemonModelTier({ baseUrl: '' })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('invalid tier value dropped on read', async () => {
    installFetch(() => ({ body: { modelTier: { voice: { stt: 'ultra' } } } }));
    expect(await fetchDaemonModelTier(CFG)).toEqual({});
  });
});

describe('M1-2b · hydrateFromDaemon', () => {
  test('merges daemon stt + local audioMinPerDay', async () => {
    localStorage.setItem(
      'elanous.model-tier.prefs',
      JSON.stringify({ stt: 'balanced', audioMinPerDay: 10 }),
    );
    installFetch(() => ({ body: { modelTier: { voice: { stt: 'best' } } } }));
    const merged = await hydrateFromDaemon(CFG);
    expect(merged?.stt).toBe('best');
    expect(merged?.audioMinPerDay).toBe(10);
  });

  test('daemon empty · local tier preserved', async () => {
    localStorage.setItem(
      'elanous.model-tier.prefs',
      JSON.stringify({ stt: 'better', audioMinPerDay: 3 }),
    );
    installFetch(() => ({ body: {} }));
    const merged = await hydrateFromDaemon(CFG);
    expect(merged?.stt).toBe('better');
    expect(merged?.audioMinPerDay).toBe(3);
  });

  test('daemon unreachable → null (caller falls back to local read)', async () => {
    installFetch(() => new TypeError('Failed to fetch'));
    expect(await hydrateFromDaemon(CFG)).toBeNull();
  });
});

describe('M1-2b · pushSttTierToDaemon', () => {
  test('happy path · writes localStorage + PUT body · returns synced', async () => {
    installFetch(() => ({ body: { modelTier: { voice: { stt: 'best' } } } }));
    const status = await pushSttTierToDaemon(CFG, 'best');
    expect(status).toBe('synced');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(calls[1]?.body).toEqual({ modelTier: { voice: { stt: 'best' } } });
    // localStorage written first (optimistic).
    expect(JSON.parse(localStorage.getItem('elanous.model-tier.prefs')!).stt).toBe('best');
  });

  test('null tier clears only STT · localStorage cleared too', async () => {
    localStorage.setItem(
      'elanous.model-tier.prefs',
      JSON.stringify({ stt: 'best', audioMinPerDay: 0 }),
    );
    installFetch(() => ({ body: {} }));
    const status = await pushSttTierToDaemon(CFG, null);
    expect(status).toBe('synced');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(calls[1]?.body).toEqual({ modelTier: { voice: {} } });
    // resetModelTierPrefs clears the localStorage entry entirely.
    expect(localStorage.getItem('elanous.model-tier.prefs')).toBeNull();
  });

  test('offline → "offline" status · localStorage still has user intent', async () => {
    installFetch(() => new TypeError('Failed to fetch'));
    const status = await pushSttTierToDaemon(CFG, 'loaded');
    expect(status).toBe('offline');
    // Optimistic local write still landed.
    expect(JSON.parse(localStorage.getItem('elanous.model-tier.prefs')!).stt).toBe('loaded');
  });

  test('5xx → "error" status', async () => {
    installFetch(() => ({ status: 500 }));
    expect(await pushSttTierToDaemon(CFG, 'best')).toBe('error');
  });

  test('empty baseUrl → offline (never makes a request)', async () => {
    installFetch(() => ({ body: {} }));
    expect(await pushSttTierToDaemon({ baseUrl: '' }, 'best')).toBe('offline');
    expect(calls).toHaveLength(0);
  });
});

describe('M1-2b · preserve daemon-only model tiers', () => {
  test('changing an owned tier preserves embedding/vision and other daemon-only fields', async () => {
    installFetch((call) => call.method === 'GET'
      ? { body: { modelTier: {
        voice: { stt: 'balanced', ttsVoice: { chat: 'voice-1' } },
        embedding: 'best', vision: 'loaded', profile: 'custom', preset: 'meeting',
      } } }
      : { body: {} });

    expect(await pushLlmTierToDaemon(CFG, 'best')).toBe('synced');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(calls[1]?.body).toEqual({ modelTier: {
      voice: { stt: 'balanced', ttsVoice: { chat: 'voice-1' } },
      llm: 'best', embedding: 'best', vision: 'loaded', profile: 'custom', preset: 'meeting',
    } });
  });

  test('resetting an owned tier preserves daemon-only fields and other tiers', async () => {
    installFetch((call) => call.method === 'GET'
      ? { body: { modelTier: {
        voice: { stt: 'best', tts: 'better', ttsVoice: { chat: 'voice-1' } },
        llm: 'balanced', embedding: 'best', vision: 'loaded', profile: 'custom', preset: 'meeting',
      } } }
      : { body: {} });

    expect(await pushSttTierToDaemon(CFG, null)).toBe('synced');
    expect(calls[1]?.body).toEqual({ modelTier: {
      voice: { tts: 'better', ttsVoice: { chat: 'voice-1' } },
      llm: 'balanced', embedding: 'best', vision: 'loaded', profile: 'custom', preset: 'meeting',
    } });
  });

  test('clearing preset preserves daemon-only fields and removes only preset', async () => {
    installFetch((call) => call.method === 'GET'
      ? { body: { modelTier: {
        voice: { stt: 'best', ttsVoice: { chat: 'voice-1' } },
        llm: 'balanced', embedding: 'best', vision: 'loaded', profile: 'custom', preset: 'meeting',
      } } }
      : { body: {} });

    expect(await pushPresetToDaemon(CFG, null)).toBe('synced');
    expect(calls[1]?.body).toEqual({ modelTier: {
      voice: { stt: 'best', ttsVoice: { chat: 'voice-1' } },
      llm: 'balanced', embedding: 'best', vision: 'loaded', profile: 'custom',
    } });
  });

  test('an empty local modelTier request never clears an existing daemon tree', async () => {
    installFetch((call) => call.method === 'GET'
      ? { body: { modelTier: {
        voice: { stt: 'best', ttsVoice: { chat: 'voice-1' } },
        llm: 'balanced', embedding: 'best', vision: 'loaded', profile: 'custom', preset: 'meeting',
      } } }
      : { body: {} });

    expect(await pushTtsVoiceMappingToDaemon(CFG, {})).toBe('synced');
    expect(calls[1]?.body).toEqual({ modelTier: {
      voice: { stt: 'best', ttsVoice: { chat: 'voice-1' } },
      llm: 'balanced', embedding: 'best', vision: 'loaded', profile: 'custom', preset: 'meeting',
    } });
  });
});

describe('M1-2b · pushMonthlyCapToDaemon', () => {
  test('positive cap → PUT body shape', async () => {
    installFetch(() => ({ body: {} }));
    expect(await pushMonthlyCapToDaemon(CFG, 25)).toBe('synced');
    expect(calls[0]?.body).toEqual({ budget: { monthlyUsdCap: 25 } });
  });

  test('null cap clears budget', async () => {
    installFetch(() => ({ body: {} }));
    expect(await pushMonthlyCapToDaemon(CFG, null)).toBe('synced');
    expect(calls[0]?.body).toEqual({ budget: null });
  });
});
