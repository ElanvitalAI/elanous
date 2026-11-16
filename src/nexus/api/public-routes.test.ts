import { expect, test } from 'bun:test';
import { isPublicRoute } from './public-routes.js';

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
