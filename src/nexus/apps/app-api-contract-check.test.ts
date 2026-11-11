import { expect, test } from 'bun:test';
import { parseAppManifest } from './app-contract.js';
import { planAppApiRoleChecks } from './app-api-contract-check.js';

const manifest = `apiVersion: elanous.app/v0
slug: role-matrix
title: Role matrix
frontend: { kind: static-export }
tables: { notes: {} }
roles:
  owner: { via: nexus-session }
  viewer: { via: share-link }
  public: { via: public-read }
rpc:
  listNotes:
    sql: SELECT id FROM notes
    allow: [owner, viewer]
  publicStatus:
    sql: SELECT id FROM notes
    allow: [public]
actions:
  summarize: { builtin: summarize, input: { text: text }, output: { text: text }, uses: [cred:openai.api_key] }
credentials: [cred:openai.api_key]
`;

test('APP-API-CONTRACT-CHECK role matrix covers every route and both allowed and denied roles', () => {
  const parsed = parseAppManifest(manifest);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const cases = planAppApiRoleChecks(parsed.manifest);
  expect(cases).toHaveLength(12);
  expect(cases.every(item => item.method === 'POST')).toBe(true);
  expect(cases.filter(item => item.path === '/rpc/listNotes')).toEqual([
    { method: 'POST', path: '/rpc/listNotes', role: 'owner', auth: 'declared', expected: 'allow' },
    { method: 'POST', path: '/rpc/listNotes', role: 'viewer', auth: 'declared', expected: 'allow' },
    { method: 'POST', path: '/rpc/listNotes', role: 'anon', auth: 'anonymous', expected: 'deny' },
    { method: 'POST', path: '/rpc/listNotes', role: '__undeclared_role__', auth: 'undeclared', expected: 'deny' },
  ]);
  expect(cases.filter(item => item.auth === 'undeclared')).toHaveLength(3);
  expect(cases.filter(item => item.auth === 'undeclared').every(item => item.expected === 'deny')).toBe(true);
  expect(cases.find(item => item.path === '/rpc/publicStatus' && item.role === 'anon')?.expected).toBe('allow');
  expect(cases.filter(item => item.path === '/actions/summarize' && item.expected === 'allow').map(item => item.role)).toEqual(['owner']);
  expect(planAppApiRoleChecks(parsed.manifest)).toEqual(cases);
});

test('APP-API-CONTRACT-CHECK rejects a role absent from generated security schemes', () => {
  const parsed = parseAppManifest(manifest);
  if (!parsed.ok) throw new Error('fixture must parse');
  const broken = { ...parsed.manifest, roles: { owner: { via: 'nexus-session' } } };
  expect(() => planAppApiRoleChecks(broken)).toThrow('invalid role allow-list');
});
