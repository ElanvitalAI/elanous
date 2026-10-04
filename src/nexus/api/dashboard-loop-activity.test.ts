import { describe, expect, test } from 'bun:test';
import { handleDashboard, parseDashboardPath } from './dashboard.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';

const path = '/v1/dashboard/loop-activity';
const request = (suffix = '', init?: RequestInit) => new Request(`http://localhost${path}${suffix}`, init);
const activity = {
  since: '2026-10-03T12:00:00.000Z', until: '2026-10-04T12:00:00.000Z',
  nodes: [{ id: 'op-seat', kind: 'seat', title: 'OP', state: null, reason: null, lastAt: null, events: 1 }],
  edges: [{ from: 'orchestrator', to: 'op-seat', kind: 'request', count: 1, lastAt: '2026-10-04T11:00:00.000Z' }],
};

describe('dashboard loop-activity route', () => {
  test('registers the exact dashboard segment and retains existing segments', () => {
    expect(parseDashboardPath(path)).toBe('loop-activity');
    expect(parseDashboardPath(`${path}/extra`)).toBeNull();
    expect(parseDashboardPath('/v1/dashboard/loops')).toBe('loops');
    expect(parseDashboardPath('/v1/dashboard/summary')).toBe('summary');
  });

  test('authenticated GET defaults since to 24h and forwards an explicit window', async () => {
    const seen: string[] = [];
    const opts = { checkAuth: () => true, loopActivity: (({ since }: { since: string | Date }) => {
      seen.push(String(since));
      return activity;
    }) as typeof import('../../loops/activity.js').loopActivity };
    const defaultResponse = handleDashboard(request(), 'loop-activity', opts);
    expect(defaultResponse.status).toBe(200);
    expect(await defaultResponse.json()).toEqual({ ok: true, activity });
    const customResponse = handleDashboard(request('?since=2h'), 'loop-activity', opts);
    expect(await customResponse.json()).toEqual({ ok: true, activity });
    expect(seen).toEqual(['24h', '2h']);
  });

  test('auth and GET-only checks run before the read-only provider', async () => {
    let calls = 0;
    const loopActivity = (() => { calls++; return activity; }) as typeof import('../../loops/activity.js').loopActivity;
    const opts = { checkAuth: () => false, loopActivity };
    const unauthorized = handleDashboard(request(), 'loop-activity', opts);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ ok: false, error: 'unauthorized' });
    expect(handleDashboard(request('', { method: 'POST' }), 'loop-activity', { loopActivity }).status).toBe(405);
    expect(handleDashboard(request('', { method: 'OPTIONS' }), 'loop-activity', opts).status).toBe(204);
    expect(calls).toBe(0);
  });

  test('the NEXUS router reaches the existing dashboard handler', async () => {
    const seen: string[] = [];
    const opts = { metaApi: { bearerToken: 'owner-secret' }, dashboard: { checkAuth: () => true, loopActivity: (({ since }: { since: string | Date }) => {
      seen.push(String(since));
      return activity;
    }) as typeof import('../../loops/activity.js').loopActivity } } as unknown as NexusHttpServerOpts;
    const server = { requestIP: () => ({ address: '127.0.0.1' }) } as unknown as Parameters<typeof routeRequest>[2];
    const ref = { get: () => null } as Parameters<typeof routeRequest>[4];
    const denied = await routeRequest(request('?since=24h'), opts, server, null, ref);
    expect(denied?.status).toBe(401);
    expect(seen).toEqual([]);
    const response = await routeRequest(request('?since=24h', { headers: { authorization: 'Bearer owner-secret' } }), opts, server, null, ref);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true, activity });
    expect(seen).toEqual(['24h']);
  });
});
