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


import { checkRecordedAppApiCalls, type RecordedAppApiCall } from './app-api-contract-check.js';
import { createFakeAppHost } from '../../ux-sim/fake-app-host.js';

function implementationContract() {
  const parsed = parseAppManifest(manifest);
  if (!parsed.ok) throw new Error('fixture must parse');
  return parsed.manifest;
}

const validSummary: RecordedAppApiCall = {
  method: 'POST', path: '/actions/summarize', role: 'owner', status: 200,
  response: { ok: true, text: 'fixture summary' },
};

test('fake app host version drift produces a location and successful independent rerun receipt', () => {
  const host = createFakeAppHost([{ slug: 'role-matrix', current: 'broken', versions: [
    { id: 'broken', files: { '/actions/summarize': JSON.stringify({ ok: true, text: 42 }) } },
    { id: 'fixed', files: { '/actions/summarize': JSON.stringify(validSummary.response) } },
  ] }]);
  const capture = (): RecordedAppApiCall => {
    const response = host.fetch('role-matrix.app.sim.invalid', validSummary.path);
    return { ...validSummary, status: response.status, response: JSON.parse(response.body) };
  };
  const first = checkRecordedAppApiCalls(implementationContract(), [capture()]);
  expect(first).toEqual({ world: 'simulation', ok: false, checkedCalls: 1,
    mismatches: [{ path: '/calls/0/response/@field:0', reason: 'response-type' }],
    rerun: { callIndexes: [0] } });
  host.deploy('role-matrix', 'fixed');
  const second = checkRecordedAppApiCalls(implementationContract(), first.rerun.callIndexes.map(() => capture()));
  expect(second).toEqual({ world: 'simulation', ok: true, checkedCalls: 1, mismatches: [], rerun: { callIndexes: [] } });
  expect(first.ok).toBe(false);
});

test('recorded route, method, role leak, missing fields and RPC envelope mismatches retain call ordinals', () => {
  const calls: RecordedAppApiCall[] = [
    { ...validSummary, path: '/actions/not-declared?secret=sim-only' },
    { ...validSummary, method: 'GET' },
    { ...validSummary, role: '__injected_role__' },
    { ...validSummary, response: { ok: true } },
    { ...validSummary, response: [] },
    { method: 'POST', path: '/rpc/listNotes', role: 'owner', status: 200, response: { rows: 'wrong' } },
  ];
  const result = checkRecordedAppApiCalls(implementationContract(), calls);
  expect(result.mismatches).toEqual([
    { path: '/calls/0/path', reason: 'route' },
    { path: '/calls/1/method', reason: 'method' },
    { path: '/calls/2/status', reason: 'status' },
    { path: '/calls/3/response/@field:0', reason: 'missing-field' },
    { path: '/calls/4/response', reason: 'response-type' },
    { path: '/calls/5/response/rows', reason: 'response-type' },
  ]);
  expect(result.rerun.callIndexes).toEqual([0, 1, 2, 3, 4, 5]);
  expect(JSON.stringify(result)).not.toContain('sim-only');
  expect(checkRecordedAppApiCalls(implementationContract(), calls)).toEqual(result);
});

test('allowed, anonymous public, and denied captured calls match the implementation role matrix', () => {
  expect(checkRecordedAppApiCalls(implementationContract(), [
    validSummary,
    { ...validSummary, role: 'viewer', status: 403, response: { error: 'forbidden' } },
    { ...validSummary, role: 'injected', status: 403, response: { error: 'forbidden' } },
    { method: 'POST', path: '/rpc/publicStatus', role: 'anon', status: 200, response: { rows: [] } },
  ]).ok).toBe(true);
});

test('async action receipts check the accepted job envelope and deduplicate replay indexes', () => {
  const contract = { ...implementationContract(), actions: {
    render: { builtin: 'generate', async: true, spend: 'confirmed', input: {}, output: {} },
  } };
  const accepted = { ...validSummary, path: '/actions/render', status: 202, response: { ok: true, jobId: 'fake-job' } };
  expect(checkRecordedAppApiCalls(contract, [accepted]).ok).toBe(true);
  const bad = checkRecordedAppApiCalls(contract, [{ ...accepted, response: {} }]);
  expect(bad.mismatches).toHaveLength(2);
  expect(bad.rerun.callIndexes).toEqual([0]);
  expect(checkRecordedAppApiCalls(contract, [{ ...accepted, status: 200 }]).mismatches[0]?.reason).toBe('status');
});


test('empty capture cannot pass and a changed output contract invalidates an old response', () => {
  expect(checkRecordedAppApiCalls(implementationContract(), []).ok).toBe(false);
  const changed = { ...implementationContract(), actions: { summarize: {
    builtin: 'summarize', input: { text: 'text' }, output: { text: 'text', revision: 'int' },
  } } };
  expect(checkRecordedAppApiCalls(changed, [validSummary]).mismatches).toEqual([
    { path: '/calls/0/response/@field:1', reason: 'missing-field' },
  ]);
  expect(checkRecordedAppApiCalls(changed, [{ ...validSummary, response: { ok: true, text: 'summary', revision: 1.5 } }]).ok).toBe(false);
  expect(checkRecordedAppApiCalls(changed, [{ ...validSummary, response: { ok: true, text: 'summary', revision: 2 } }]).ok).toBe(true);
});
