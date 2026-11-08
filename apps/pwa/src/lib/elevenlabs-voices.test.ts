// M2-2b-v2 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 2) —
// Voice library PWA client tests.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  __resetVoiceLibraryMemoForTests,
  fetchVoiceLibrary,
  filterVoices,
  loadRecentVoiceIds,
  rememberRecentVoiceId,
} from './elevenlabs-voices';
import { createFakeFetchDevice, type FakeFetchDevice } from '../test-devices/fake-fetch';

interface FetchCall { url: string; headers: Record<string, string>; }
let calls: FetchCall[] = [];
let fakeFetch: FakeFetchDevice | undefined;

function installFetch(
  responder: (call: FetchCall) => { status?: number; body?: unknown } | Error,
): void {
  fakeFetch?.restore();
  fakeFetch = createFakeFetchDevice([{
    url: '/v1/elevenlabs/voices',
    response: (request) => {
      const call = { url: request.url, headers: { ...request.headers } };
      calls.push(call);
      const r = responder(call);
      if (r instanceof Error) throw r;
      return Response.json(r.body ?? {}, { status: r.status ?? 200 });
    },
  }]);
}

function installLocalStorage(): void {
  // Install only `localStorage` — not `window` — to avoid leaking a
  // partial window shim into sibling SSR-safety tests (peer-id etc.)
  // that expect `typeof window === 'undefined'`.
  const store = new Map<string, string>();
  const ls = {
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    setItem(k: string, v: string) { store.set(k, v); },
    removeItem(k: string) { store.delete(k); },
    clear() { store.clear(); },
    key(i: number) { return Array.from(store.keys())[i] ?? null; },
    get length() { return store.size; },
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = ls as Storage;
}

beforeEach(() => {
  calls = [];
  __resetVoiceLibraryMemoForTests();
  installLocalStorage();
});

afterEach(() => {
  fakeFetch?.restore();
  fakeFetch = undefined;
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
});

describe('M2-2b-v2 · fetchVoiceLibrary', () => {
  test('happy path returns voices + configured flag', async () => {
    installFetch(() => ({
      body: {
        voices: [
          { id: 'r', name: 'Rachel', accent: 'American', gender: 'female' },
          { id: 'a', name: 'Adam', accent: 'British', gender: 'male' },
        ],
        configured: true,
        fromCache: false,
      },
    }));
    const lib = await fetchVoiceLibrary({ baseUrl: 'http://localhost:31415' });
    expect(lib?.voices).toHaveLength(2);
    expect(lib?.configured).toBe(true);
  });

  test('empty baseUrl → null without fetching', async () => {
    installFetch(() => ({ body: {} }));
    expect(await fetchVoiceLibrary({ baseUrl: '' })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('5xx → null', async () => {
    installFetch(() => ({ status: 500 }));
    expect(await fetchVoiceLibrary({ baseUrl: 'http://localhost:31415' })).toBeNull();
  });

  test('fetch throws → null', async () => {
    installFetch(() => new TypeError('offline'));
    expect(await fetchVoiceLibrary({ baseUrl: 'http://localhost:31415' })).toBeNull();
  });

  test('memoizes within TTL', async () => {
    let n = 0;
    installFetch(() => { n++; return { body: { voices: [], configured: false } }; });
    await fetchVoiceLibrary({ baseUrl: 'http://localhost:31415' });
    await fetchVoiceLibrary({ baseUrl: 'http://localhost:31415' });
    expect(n).toBe(1);
  });

  test('Bearer header sent when token configured', async () => {
    installFetch(() => ({ body: { voices: [], configured: true } }));
    await fetchVoiceLibrary({ baseUrl: 'http://localhost:31415', token: 'tk' });
    expect(calls[0]?.headers.authorization).toBe('Bearer tk');
  });
});

describe('M2-2b-v2 · filterVoices', () => {
  const voices = [
    { id: 'r', name: 'Rachel', accent: 'American', gender: 'female', description: 'calm narration' },
    { id: 'a', name: 'Adam', accent: 'British', gender: 'male', description: 'deep narration' },
    { id: 'y', name: 'Yumi', language: 'ko', gender: 'female', description: 'warm Korean' },
  ];

  test('empty query → all voices', () => {
    expect(filterVoices(voices, '').map((v) => v.id).sort()).toEqual(['a', 'r', 'y']);
  });

  test('matches by name (case-insensitive)', () => {
    expect(filterVoices(voices, 'rachel').map((v) => v.id)).toEqual(['r']);
    expect(filterVoices(voices, 'RACHEL').map((v) => v.id)).toEqual(['r']);
  });

  test('matches by accent / gender / description', () => {
    expect(filterVoices(voices, 'british').map((v) => v.id)).toEqual(['a']);
    expect(filterVoices(voices, 'female').map((v) => v.id).sort()).toEqual(['r', 'y']);
    expect(filterVoices(voices, 'narration').map((v) => v.id).sort()).toEqual(['a', 'r']);
    expect(filterVoices(voices, 'korean').map((v) => v.id)).toEqual(['y']);
  });

  test('no match → empty', () => {
    expect(filterVoices(voices, 'zzz')).toEqual([]);
  });
});

describe('M2-2b-v2 · recent voice ids', () => {
  test('empty initially', () => {
    expect(loadRecentVoiceIds()).toEqual([]);
  });

  test('most recent first · dedupes', () => {
    rememberRecentVoiceId('a');
    rememberRecentVoiceId('b');
    rememberRecentVoiceId('a'); // bumps to front
    expect(loadRecentVoiceIds()).toEqual(['a', 'b']);
  });

  test('capped at 5', () => {
    for (const id of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7']) {
      rememberRecentVoiceId(id);
    }
    const recent = loadRecentVoiceIds();
    expect(recent).toHaveLength(5);
    expect(recent[0]).toBe('v7');
    expect(recent[4]).toBe('v3');
  });

  test('empty/invalid ids ignored', () => {
    rememberRecentVoiceId('');
    rememberRecentVoiceId('  ');
    rememberRecentVoiceId('valid');
    expect(loadRecentVoiceIds()).toEqual(['valid']);
  });
});
