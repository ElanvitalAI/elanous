import { describe, expect, test } from 'bun:test';
import { readOpenRouterCredit } from './provider-credit-read.js';

describe('OpenRouter credit observation', () => {
  test('uses a management lease only for the fixed read-only endpoint', async () => {
    let calls = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      expect(url).toBe('https://openrouter.ai/api/v1/credits');
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-lease');
      return Response.json({ data: { total_credits: 100.5, total_usage: 25.75, auto_top_up: true } });
    }) as unknown as typeof fetch;
    expect(await readOpenRouterCredit('fake-lease', { fetchImpl, now: () => new Date('2026-01-01T00:00:00Z') })).toEqual({
      provider: 'openrouter', balance: { status: 'measured', usd: 74.75, totalCreditsUsd: 100.5, totalUsageUsd: 25.75, source: 'openrouter-credits-derived', observedAt: '2026-01-01T00:00:00.000Z' },
      autoTopUp: { status: 'unmeasured', reason: 'not-provided' },
    });
    expect(calls).toBe(1);
  });
  test('missing credential does not call the network', async () => {
    const fetchImpl = (() => { throw new Error('should not call'); }) as unknown as typeof fetch;
    expect((await readOpenRouterCredit(undefined, { fetchImpl })).balance).toEqual({ status: 'unmeasured', reason: 'missing-management-lease' });
  });
  test('rejects malformed amounts rather than inventing a balance', async () => {
    for (const data of [{ total_credits: 2 }, { total_credits: -1, total_usage: 0 }, { total_credits: '2', total_usage: 0 }]) {
      const fetchImpl = (async () => Response.json({ data })) as unknown as typeof fetch;
      expect((await readOpenRouterCredit('fake', { fetchImpl })).balance).toEqual({ status: 'unmeasured', reason: 'invalid-response' });
    }
  });
  test('does not expose exceptions or upstream error bodies', async () => {
    const throws = (async () => { throw new Error('fake-lease'); }) as unknown as typeof fetch;
    const denied = (async () => new Response('fake-lease', { status: 403 })) as unknown as typeof fetch;
    expect(JSON.stringify(await readOpenRouterCredit('fake-lease', { fetchImpl: throws }))).not.toContain('fake-lease');
    expect((await readOpenRouterCredit('fake-lease', { fetchImpl: denied })).balance).toEqual({ status: 'unmeasured', reason: 'forbidden' });
  });
});
