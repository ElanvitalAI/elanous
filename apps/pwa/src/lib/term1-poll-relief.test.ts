// TERM1 · 10-02 — 운영 데몬이 `/v1/terminals` 에 1.7~6.6초를 쓰는 동안 모든 탭이 8초마다 물었다. 클라이언트가 덜 묻게 한다.
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ACTIVITY_POLL_MAX_MS, nextActivityDelay, startActivityPolling } from '@/components/shell/use-shell-activity';
import { DaemonClient } from './daemon-client';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('TERM1 poll relief', () => {
  test('the activity poll backs off to four times a slow answer (capped) and keeps the base rate when fast', () => {
    expect(nextActivityDelay(8_000, 200)).toBe(8_000);
    expect(nextActivityDelay(8_000, 6_600)).toBe(26_400);
    expect(nextActivityDelay(8_000, 40_000)).toBe(ACTIVITY_POLL_MAX_MS);
  });

  test('a hidden tab asks the daemon nothing', async () => {
    const fetchImpl = mock(async () => new Response(JSON.stringify({ subjects: [] }), { status: 200 }));
    const stop = startActivityPolling(() => {}, { fetchImpl, listProgressFrames: async () => ({ logs: [] }), isHidden: () => true }, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    stop();
  });

  test('the first activity poll can wait so the page entry stays free', async () => {
    const fetchImpl = mock(async () => new Response(JSON.stringify({ subjects: [] }), { status: 200 }));
    const stop = startActivityPolling(() => {}, { fetchImpl, listProgressFrames: async () => ({ logs: [] }), isHidden: () => false, firstDelayMs: 40 }, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    stop();
  });

  test('concurrent terminal-list GETs share one request; other paths and writes do not', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      calls += 1;
      const url = String(input);
      if (url.endsWith('/v1/terminals')) await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ subjects: [{ id: url }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new DaemonClient({ baseUrl: 'http://localhost:31415', token: '', provider: '' });
    const a = client.fetchJson('/v1/terminals');
    const b = client.fetchJson('/v1/terminals');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    release?.();
    expect(await a).toEqual(await b);
    await client.fetchJson('/v1/terminals/x');
    await client.fetchJson('/v1/health');
    expect(calls).toBe(3);
    // after it settles, the next ask is a fresh request
    const c = client.fetchJson('/v1/terminals');
    await new Promise((resolve) => setTimeout(resolve, 0));
    release?.();
    await c;
    expect(calls).toBe(4);
  });
});
