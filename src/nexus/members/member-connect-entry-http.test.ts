import { expect, test } from 'bun:test';
import { routeRequest } from '../api/http-server.js';
import { createDevProxyRuntimeRef } from '../api/admin-dev-proxy.js';
import { isPublicRoute } from '../api/public-routes.js';

test('Nexus default-deny passes only the four exact member-connect entry methods to the verified handler', async () => {
  const calls: string[] = [];
  const options = { membersApi: { handle: async (request: Request) => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json({ handled: true });
  } } } as never;
  const cases = [
    ['POST', '/v1/members/connect/start'],
    ['GET', '/v1/members/connect/approve'],
    ['POST', '/v1/members/connect/approve'],
    ['POST', '/v1/members/connect/poll'],
  ] as const;
  for (const [method, path] of cases) {
    expect(isPublicRoute(method, path, { setupMode: false })).toBe(true);
    const result = await routeRequest(new Request(`https://api.elanous.ai${path}`, { method }),
      options, {} as never, null, createDevProxyRuntimeRef());
    expect(result?.status).toBe(200);
  }
  expect(calls).toEqual(cases.map(([method, path]) => `${method} ${path}`));
  expect(isPublicRoute('PUT', '/v1/members/connect/approve', { setupMode: false })).toBe(false);
  expect(isPublicRoute('POST', '/v1/members/connect/approve/extra', { setupMode: false })).toBe(false);
});

test('member connect receives the socket caller key rather than a forwarded header', async () => {
  const keys: string[] = [];
  const options = { membersApi: { handle: async (_request: Request, networkKey: string) => {
    keys.push(networkKey);
    return Response.json({ handled: true });
  } } } as never;
  const request = new Request('https://api.elanous.ai/v1/members/connect/start', {
    method: 'POST', headers: { 'x-forwarded-for': '198.51.100.99' },
  });
  const server = { requestIP: () => ({ address: '203.0.113.7' }) } as never;
  expect((await routeRequest(request, options, server, null, createDevProxyRuntimeRef()))?.status).toBe(200);
  expect(keys).toEqual(['203.0.113.7']);
});

test('member connect separates public callers through the local Caddy proxy and fails closed on ambiguous forwarding', async () => {
  const keys: string[] = [];
  const options = { membersApi: { handle: async (_request: Request, networkKey: string) => {
    keys.push(networkKey);
    return Response.json({ handled: true });
  } } } as never;
  const proxy = { requestIP: () => ({ address: '127.0.0.1' }) } as never;
  const send = async (headers: Record<string, string>) => {
    const request = new Request('https://api.elanous.ai/v1/members/connect/start', { method: 'POST', headers });
    expect((await routeRequest(request, options, proxy, null, createDevProxyRuntimeRef()))?.status).toBe(200);
  };
  await send({ 'x-forwarded-for': '203.0.113.7' });
  await send({ 'x-forwarded-for': '198.51.100.9', 'x-real-ip': '198.51.100.9' });
  await send({ 'x-real-ip': '192.0.2.10' });
  await send({ 'x-forwarded-for': '203.0.113.7, 198.51.100.9' });
  await send({ 'x-forwarded-for': 'not-an-ip' });
  await send({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.9' });
  await send({});
  expect(keys).toEqual(['203.0.113.7', '198.51.100.9', '192.0.2.10',
    'unknown', 'unknown', 'unknown', 'unknown']);
});
