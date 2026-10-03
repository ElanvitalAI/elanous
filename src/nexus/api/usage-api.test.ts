import { expect, test } from 'bun:test';
import type { UnifiedUsageReport } from '../../budget/types.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { createUsageHandler } from './usage-api.js';

const report: UnifiedUsageReport = {
  accountCounts: { codex: 2, grok: 0, openrouter: 0 },
  rows: [
    {
      provider: 'codex', accountName: 'work', accountCount: 2, soleAccount: false,
      credits: { status: 'ok', usedPercent: 75, periodType: 'weekly', periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-10-08T00:00:00.000Z', monthlyLimit: null, used: 75, onDemandCap: null, onDemandUsed: null, prepaidBalance: null, balance: null, hasCredits: null, unlimited: null },
      subscription: { status: 'available', remainingPercent: 25, resetsAt: 1791417600000, windowKind: 'weekly' },
      resetCredits: { status: 'available', expiresAt: '2026-10-07T00:00:00.000Z', hasUnknownExpiry: false },
    },
    {
      provider: 'codex', accountName: 'home', accountCount: 2, soleAccount: false,
      credits: { status: 'error', detail: 'sk-secret eyJ.payload person@example.org' },
      subscription: { status: 'unavailable', reason: 'query-does-not-supply' },
      resetCredits: { status: 'unavailable', detail: 'sk-secret eyJ.payload person@example.org' },
    },
  ],
};

function request(handler: () => Promise<Response>, auth = true, method = 'GET') {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  return routeRequest(new Request('http://localhost/v1/usage', {
    method,
    headers: auth ? { authorization: 'Bearer owner-token', 'sec-fetch-site': 'cross-site' }
      : { 'sec-fetch-site': 'cross-site' },
  }), {
    state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    metaApi: { bearerToken: 'owner-token', noAuth: false }, usageHandler: handler,
  }, { requestIP: () => ({ address: '203.0.113.1' }) } as never,
  null, createDevProxyRuntimeRef());
}

test('/v1/usage authenticates before method checking and calls the handler only for GET', async () => {
  let calls = 0;
  const expected = { ok: true, rows: ['unchanged'] };
  const handler = async () => {
    calls++;
    return new Response(JSON.stringify(expected), { status: 200, headers: { 'cache-control': 'private, max-age=30' } });
  };

  const denied = await request(handler, false, 'POST');
  expect(denied?.status).toBe(401);
  expect(await denied?.json()).toEqual({ error: 'unauthorized' });
  const deniedGet = await request(handler, false);
  expect(deniedGet?.status).toBe(401);
  expect(await deniedGet?.json()).toEqual({ error: 'unauthorized' });
  expect(calls).toBe(0);

  for (const method of ['POST', 'PUT', 'DELETE']) {
    const rejected = await request(handler, true, method);
    expect(rejected?.status).toBe(405);
    expect(await rejected?.json()).toEqual({ error: 'method-not-allowed' });
    expect(calls).toBe(0);
  }

  const response = await request(handler);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual(expected);
  expect(response?.headers.get('cache-control')).toBe('private, max-age=30');
  expect(calls).toBe(1);
});

test('GET /v1/usage serves owner account usage', async () => {
  let calls = 0;
  const handler = createUsageHandler(async () => { calls++; return report; }, () => Date.parse('2026-10-06T00:00:00.000Z'));
  const response = await request(handler);
  expect(response?.status).toBe(200);
  const body = await response!.json();
  expect(body.ok).toBe(true);
  expect(body.accountCounts).toEqual(report.accountCounts);
  expect(body.rows).toHaveLength(report.rows.length);
  expect(body.rows[0]).toMatchObject({
    provider: 'codex', account: '계정 1', accountCount: 2,
    credits: { usedPercent: 75, periodEnd: '2026-10-08T00:00:00.000Z', resetsInMs: 172_800_000 },
    subscription: { remainingPercent: 25, resetsAt: 1791417600000, resetsInMs: 172_800_000, windowKind: 'weekly' },
    resetCredits: { status: 'available', expiresAt: '2026-10-07T00:00:00.000Z' },
  });
  expect(calls).toBe(1);
  expect(JSON.stringify(body)).not.toMatch(/sk-|eyJ|@/i);
  expect(body.rows[1].credits).toEqual({ status: 'error' });
  expect(body.rows[1].resetCredits).toEqual({ status: 'unavailable' });
});

test('30-second cache shares the first result, then refreshes at expiry', async () => {
  let now = 1_000;
  let calls = 0;
  const handler = createUsageHandler(async () => { calls++; return report; }, () => now);
  const first = await (await request(handler))!.json();
  now += 29_999;
  expect(await (await request(handler))!.json()).toEqual(first);
  expect(calls).toBe(1);
  now += 1;
  expect((await request(handler))?.status).toBe(200);
  expect(calls).toBe(2);
});

test('concurrent GETs share one in-flight collection', async () => {
  let calls = 0;
  let release!: (value: UnifiedUsageReport) => void;
  const handler = createUsageHandler(() => {
    calls++;
    return new Promise<UnifiedUsageReport>((resolve) => { release = resolve; });
  });
  const first = request(handler);
  const second = request(handler);
  await Promise.resolve();
  expect(calls).toBe(1);
  release(report);
  expect((await first)?.status).toBe(200);
  expect((await second)?.status).toBe(200);
});

test('collection failure returns a safe reason at HTTP 200 and retries next time', async () => {
  let calls = 0;
  const handler = createUsageHandler(async () => {
    calls++;
    if (calls === 1) throw new Error('sk-secret eyJ.payload person@example.org');
    return report;
  });
  const failed = await request(handler);
  expect(failed?.status).toBe(200);
  const text = await failed!.text();
  expect(JSON.parse(text)).toEqual({ ok: false, reason: 'usage-collection-failed' });
  expect(text).not.toMatch(/sk-|eyJ|@/i);
  expect((await (await request(handler))!.json()).ok).toBe(true);
  expect(calls).toBe(2);
});

test('synchronous collection exceptions also return a safe 200 failure', async () => {
  const response = await request(createUsageHandler(() => { throw new Error('sk-secret person@example.org'); }));
  expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({ ok: false, reason: 'usage-collection-failed' });
});

test('TC condition: no account name, email or token ever leaves — only ordinal labels per provider', async () => {
  const names = ['person@example.org', 'sk-1234567890abcdefghijklmnop', 'work', 'desk-work', '개인'];
  const withNames: UnifiedUsageReport = { ...report, rows: names.map((accountName) => ({ ...report.rows[0]!, accountName })) };
  const body = await (await createUsageHandler(async () => withNames)()).text();
  for (const name of names) expect(body).not.toContain(name);
  expect(JSON.parse(body).rows.map((row: { account: string }) => row.account)).toEqual(['계정 1', '계정 2', '계정 3', '계정 4', '계정 5']);
  expect(JSON.parse(body).rows[0]).not.toHaveProperty('accountName');
  const single: UnifiedUsageReport = { ...report, rows: [{ ...report.rows[0]!, accountName: 'only-one' }] };
  expect((await (await createUsageHandler(async () => single)()).json()).rows[0].account).toBe('계정');
});

test('an unavailable subscription reason outside the fixed set is reported as unknown (no free text)', async () => {
  const leaky: UnifiedUsageReport = { ...report, rows: [{ ...report.rows[0]!, subscription: { status: 'unavailable', reason: 'failed for person@example.org with sk-abcdef1234567890abcd' as never } }] };
  const body = await (await createUsageHandler(async () => leaky)()).text();
  expect(body).not.toMatch(/@|sk-/);
  expect(JSON.parse(body).rows[0].subscription).toEqual({ status: 'unavailable', reason: 'unknown' });
  const known: UnifiedUsageReport = { ...report, rows: [{ ...report.rows[0]!, subscription: { status: 'unavailable', reason: 'not-a-subscription' } }] };
  expect((await (await createUsageHandler(async () => known)()).json()).rows[0].subscription.reason).toBe('not-a-subscription');
});

test('provider period labels cannot smuggle credentials into the response', async () => {
  const unsafe: UnifiedUsageReport = {
    ...report,
    rows: [{ ...report.rows[0]!, credits: {
      ...report.rows[0]!.credits,
      status: 'ok', usedPercent: 75, periodType: 'ghp_1234567890abcdefghijklmnop',
      periodStart: null, periodEnd: null, monthlyLimit: null, used: null, onDemandCap: null,
      onDemandUsed: null, prepaidBalance: null, balance: null, hasCredits: null, unlimited: null,
    } }],
  };
  const body = await (await createUsageHandler(async () => unsafe)()).text();
  expect(body).not.toContain('ghp_');
  expect(JSON.parse(body).rows[0].credits.periodType).toBeNull();
});
