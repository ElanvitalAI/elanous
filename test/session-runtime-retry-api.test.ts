// ── fetchApiWithRetry tests (Coding Pipeline P3 followup) ──
//
// Stubs global fetch with a queue of canned responses so we can drive
// 429 / 503 / network / quota / abort scenarios deterministically.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  fetchApiWithRetry,
  ApiHttpError,
} from '../src/session-runtime/retry-api.js';
import { DoomLoopTracker } from '../src/session-runtime/retry-policy.js';
import { createFakeFetchDevice, type FakeFetchDevice } from '../src/ux-sim/fake-fetch.js';

type Canned =
  | { kind: 'response'; status: number; body: string; headers?: Record<string, string> }
  | { kind: 'error'; err: Error };

let queue: Canned[] = [];
let device: FakeFetchDevice;
let calls = 0;

function makeResponse(c: Extract<Canned, { kind: 'response' }>): Response {
  // Bun's `Response` works fine — give it an empty body for 5xx so
  // .text() returns '' rather than null.
  return new Response(c.body, {
    status: c.status,
    headers: c.headers ?? {},
  });
}

beforeEach(() => {
  calls = 0;
  queue = [];
  device = createFakeFetchDevice([{ url: 'https://x/', method: 'GET', response: () => {
    calls++;
    const next = queue.shift();
    if (!next) {
      throw new Error('fetch queue exhausted');
    }
    if (next.kind === 'error') throw next.err;
    return makeResponse(next);
  } }]);
});

afterEach(() => {
  device.restore();
});

describe('fetchApiWithRetry — happy path', () => {
  test('200 OK returns the response on first attempt', async () => {
    queue.push({ kind: 'response', status: 200, body: 'ok' });
    const res = await fetchApiWithRetry('https://x', {}, {
      provider: 'test',
      errorPrefix: 'Test API',
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});

describe('fetchApiWithRetry — retry classes', () => {
  test('429 → retries until success (rate-limit)', async () => {
    queue.push({ kind: 'response', status: 429, body: 'too many', headers: { 'retry-after': '0' } });
    queue.push({ kind: 'response', status: 200, body: 'ok' });
    const res = await fetchApiWithRetry('https://x', {}, {
      provider: 'test',
      errorPrefix: 'Test API',
      maxAttempts: 3,
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test('503 → retries until success (overloaded)', async () => {
    queue.push({ kind: 'response', status: 503, body: 'busy' });
    queue.push({ kind: 'response', status: 200, body: 'ok' });
    const res = await fetchApiWithRetry('https://x', {}, {
      provider: 'test',
      errorPrefix: 'Test API',
      maxAttempts: 3,
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test('network error (fetch failed) → retries', async () => {
    queue.push({ kind: 'error', err: new Error('fetch failed') });
    queue.push({ kind: 'response', status: 200, body: 'ok' });
    const res = await fetchApiWithRetry('https://x', {}, {
      provider: 'test',
      errorPrefix: 'Test API',
      maxAttempts: 3,
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test('maxAttempts exhausted → throws last ApiHttpError', async () => {
    queue.push({ kind: 'response', status: 503, body: 'busy' });
    queue.push({ kind: 'response', status: 503, body: 'busy' });
    queue.push({ kind: 'response', status: 503, body: 'busy' });
    let thrown: unknown = null;
    try {
      await fetchApiWithRetry('https://x', {}, {
        provider: 'test',
        errorPrefix: 'Test API',
        maxAttempts: 3,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiHttpError);
    expect((thrown as ApiHttpError).status).toBe(503);
    expect(calls).toBe(3);
  });
});

describe('fetchApiWithRetry — abort classes', () => {
  test('context_length_exceeded (400 with that body) → aborts immediately', async () => {
    queue.push({ kind: 'response', status: 400, body: 'context_length_exceeded: too long' });
    let thrown: unknown = null;
    try {
      await fetchApiWithRetry('https://x', {}, {
        provider: 'test',
        errorPrefix: 'Test API',
        maxAttempts: 4,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiHttpError);
    expect((thrown as ApiHttpError).status).toBe(400);
    expect(calls).toBe(1);
  });

  test('quota (402) → aborts, no retry (ask-user)', async () => {
    queue.push({ kind: 'response', status: 402, body: 'billing required' });
    let thrown: unknown = null;
    try {
      await fetchApiWithRetry('https://x', {}, {
        provider: 'test',
        errorPrefix: 'Test API',
        maxAttempts: 4,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiHttpError);
    expect((thrown as ApiHttpError).status).toBe(402);
    expect(calls).toBe(1);
  });

  test('AbortError propagates immediately', async () => {
    const abortErr = new Error('user abort');
    abortErr.name = 'AbortError';
    queue.push({ kind: 'error', err: abortErr });
    let thrown: unknown = null;
    try {
      await fetchApiWithRetry('https://x', {}, {
        provider: 'test',
        errorPrefix: 'Test API',
        maxAttempts: 4,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(abortErr);
    expect(calls).toBe(1);
  });
});

describe('fetchApiWithRetry — doom-loop interaction', () => {
  test('shared tracker triggers doom on 3rd identical 503 → ask-user → throw', async () => {
    const tracker = new DoomLoopTracker(3);
    queue.push({ kind: 'response', status: 503, body: 'busy' });
    queue.push({ kind: 'response', status: 503, body: 'busy' });
    queue.push({ kind: 'response', status: 503, body: 'busy' });
    let thrown: unknown = null;
    try {
      await fetchApiWithRetry('https://x', {}, {
        provider: 'test',
        errorPrefix: 'Test API',
        maxAttempts: 5,
        doomTracker: tracker,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiHttpError);
    // After 3 retries, doom kicks in and decideRetry returns ask-user → abort.
    expect(calls).toBe(3);
  });
});

describe('ApiHttpError', () => {
  test('has decideRetry-friendly fields (code, status, retryAfter)', () => {
    const err = new ApiHttpError({
      status: 429,
      bodyText: 'rate limited',
      provider: 'anthropic',
      errorPrefix: 'Anthropic API',
      retryAfter: '5',
    });
    expect(err.status).toBe(429);
    expect(err.code).toBe('429');
    expect(err.errno).toBe('429');
    expect(err.retryAfter).toBe('5');
    expect(err.message).toContain('Anthropic API 429');
    expect(err.message).toContain('rate limited');
    expect(err.name).toBe('ApiHttpError');
  });
});
