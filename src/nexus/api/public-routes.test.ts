import { expect, test } from 'bun:test';
import { isPublicRoute, PUBLIC_ROUTES } from './public-routes.js';

test('deployment grants reach only their self-verified handlers', () => {
  const context = { setupMode: false };
  const base = '/v1/members/deployment-grants';
  const id = '11111111-1111-4111-8111-111111111111';
  expect(isPublicRoute('POST', base, context)).toBe(true);
  expect(isPublicRoute('POST', base + '/introspect', context)).toBe(true);
  expect(isPublicRoute('DELETE', base + '/' + id, context)).toBe(true);
  expect(isPublicRoute('GET', base, context)).toBe(false);
  expect(isPublicRoute('DELETE', base, context)).toBe(false);
  expect(isPublicRoute('DELETE', base + '/introspect', context)).toBe(false);
  expect(isPublicRoute('DELETE', base + '/' + id + '/extra', context)).toBe(false);
  expect(isPublicRoute('DELETE', base + '/not-a-uuid', context)).toBe(false);
});

test('deployment approval routes admit only exact UUIDv4 paths and methods', () => {
  const context = { setupMode: false };
  const base = '/v1/members/deployment-approvals';
  const id = '11111111-1111-4111-8111-111111111111';
  expect(isPublicRoute('POST', base + '/intents', context)).toBe(true);
  expect(isPublicRoute('POST', base + '/intents/' + id + '/poll', context)).toBe(true);
  expect(isPublicRoute('GET', base + '/' + id, context)).toBe(true);
  expect(isPublicRoute('POST', base + '/' + id + '/approve', context)).toBe(true);
  expect(isPublicRoute('GET', base + '/intents', context)).toBe(false);
  expect(isPublicRoute('GET', base + '/intents/' + id + '/poll', context)).toBe(false);
  expect(isPublicRoute('POST', base + '/' + id, context)).toBe(false);
  expect(isPublicRoute('GET', base + '/' + id + '/approve', context)).toBe(false);
  expect(isPublicRoute('POST', base + '/intents/' + id + '/poll/extra', context)).toBe(false);
  expect(isPublicRoute('GET', base + '/not-a-uuid', context)).toBe(false);
  expect(isPublicRoute('GET', base + '/11111111-1111-1111-8111-111111111111', context)).toBe(false);
});

test('the member app-name routes are on the allowlist with exactly their methods, and only these two paths', () => {
  const context = { setupMode: false };
  expect(isPublicRoute('POST', '/v1/members/app-slot/name', context)).toBe(true);
  expect(isPublicRoute('GET', '/v1/members/app-slot/name-check', context)).toBe(true);
  for (const [method, path] of [['GET', '/v1/members/app-slot/name'], ['DELETE', '/v1/members/app-slot/name'], ['PUT', '/v1/members/app-slot/name'],
    ['POST', '/v1/members/app-slot/name-check'], ['DELETE', '/v1/members/app-slot/name-check'], ['POST', '/v1/members/app-slot/name/extra'],
    ['GET', '/v1/members/app-slot/name-checks'], ['POST', '/v1/members/app-slot/names']] as const) {
    expect(isPublicRoute(method, path, context), `${method} ${path}`).toBe(false);
  }
});

test('webchat handoff is one self-verified exact GET entry like the member home', () => {
  const context = { setupMode: false };
  expect(isPublicRoute('GET', '/v1/members/home', context)).toBe(true);
  expect(isPublicRoute('GET', '/v1/members/webchat-handoff', context)).toBe(true);
  const handoff = PUBLIC_ROUTES.filter((r) => r.method === 'GET' && r.path === '/v1/members/webchat-handoff');
  expect(handoff).toHaveLength(1);
  expect(handoff[0]).toMatchObject({ match: 'exact', selfVerified: true });
  for (const [method, path] of [['POST', '/v1/members/webchat-handoff'], ['PUT', '/v1/members/webchat-handoff'],
    ['DELETE', '/v1/members/webchat-handoff'], ['GET', '/v1/members/webchat-handoff/extra'],
    ['GET', '/v1/members/webchat-handoffs']] as const) {
    expect(isPublicRoute(method, path, context), `${method} ${path}`).toBe(false);
  }
});
