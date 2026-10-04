import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionLedger } from '../../decisions/decision-ledger.js';
import { debug } from '../../debug/log.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { handleDecisions } from './decisions-route.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { isPublicRoute } from './public-routes.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'decisions-api-'));
  roots.push(root);
  const ledger = new DecisionLedger({ stateDir: root, now: () => new Date('2026-10-04T00:00:00Z'), resolveVersion: () => ({ released: null, dev: '0.2.13', codename: null }) });
  const first = ledger.raise({ title: '첫 결정', category: 'scope', scqa: { s: '가'.repeat(220), c: '결정이 필요하다' },
    options: [{ key: 'a', label: '진행', consequence: '진행한다' }, { key: 'b', label: '대기', consequence: '대기한다' }],
    recommendation: { option: 'a', why: '빠르다' }, raisedBy: { agent: 'OP' } });
  const second = ledger.raise({ title: '둘째 결정', category: 'other', scqa: { s: '상황', c: '문제' },
    options: [{ key: 'a', label: '예', consequence: '한다' }, { key: 'b', label: '아니오', consequence: '안 한다' }],
    recommendation: { skipped: true, reason: '보류' }, raisedBy: { agent: 'UX' } });
  return { ledger, first, second };
}
function dispatch(ledger: DecisionLedger, path: string, init: RequestInit = {}) {
  const opts = { metaApi: { bearerToken: 'owner-token', noAuth: false }, decisions: { ledger } } as unknown as NexusHttpServerOpts;
  return routeRequest(new Request(`http://nexus.test${path}`, init), opts, {} as never, null, createDevProxyRuntimeRef());
}
const auth = { authorization: 'Bearer owner-token' };
const post = (choice: string, note?: string) => ({ method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ choice, ...(note ? { note } : {}) }) });

test('GET is owner-only, dispatched outside non-GET block, open-only and situation capped at 200', async () => {
  const { ledger, first, second } = fixture();
  expect(isPublicRoute('GET', '/v1/decisions', { setupMode: false })).toBe(false);
  expect((await dispatch(ledger, '/v1/decisions?status=open'))?.status).toBe(401);
  expect((await dispatch(ledger, '/v1/decisions?status=open', { headers: { authorization: 'Bearer wrong' } }))?.status).toBe(401);
  const response = await dispatch(ledger, '/v1/decisions?status=open', { headers: auth });
  expect(response?.status).toBe(200);
  const body = await response?.json() as { decisions: Array<Record<string, unknown>> };
  expect(body.decisions).toHaveLength(2);
  expect(body.decisions.find(item => item.id === first.id)).toEqual({
    id: first.id, title: '첫 결정', situation: '가'.repeat(200), options: [{ id: 'a', label: '진행' }, { id: 'b', label: '대기' }],
    recommendation: { option: 'a', why: '빠르다' }, raisedAt: first.raisedAt,
  });
  expect(body.decisions.map(item => item.id)).toContain(second.id);
  expect(debug.events(20)).toContainEqual(expect.objectContaining({ category: 'decisions.api', event: 'listed', data: expect.objectContaining({ count: 2 }) }));
  expect((await dispatch(ledger, '/v1/decisions?status=decided', { headers: auth }))?.status).toBe(400);
});

test('POST decides in the real temporary ledger as human; missing, closed and invalid choices map to 404/409/400', async () => {
  const { ledger, first, second } = fixture();
  const path = (id: string) => `/v1/decisions/${encodeURIComponent(id)}/decide`;
  expect(isPublicRoute('POST', path(first.id), { setupMode: false })).toBe(false);
  expect((await dispatch(ledger, path(first.id), { method: 'POST', body: JSON.stringify({ choice: 'a' }) }))?.status).toBe(401);
  expect(ledger.show(first.id).status).toBe('open');
  expect((await dispatch(ledger, path('missing'), post('a')))?.status).toBe(404);
  expect((await dispatch(ledger, path(first.id), post('z')))?.status).toBe(400);
  expect(ledger.show(first.id).status).toBe('open');
  const response = await dispatch(ledger, path(first.id), post('a', '선택 이유'));
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ id: first.id, status: 'decided', choice: 'a', decidedBy: { kind: 'human' } });
  expect(ledger.show(first.id)).toMatchObject({ status: 'decided', decidedBy: { kind: 'human' }, choice: 'a', note: '선택 이유' });
  expect((await dispatch(ledger, path(first.id), post('b')))?.status).toBe(409);
  expect((await dispatch(ledger, path(second.id), { method: 'POST', headers: auth, body: '{}' }))?.status).toBe(400);
  const listed = await dispatch(ledger, '/v1/decisions?status=open', { headers: auth });
  expect((await listed?.json() as { decisions: Array<{ id: string }> }).decisions.map(item => item.id)).toEqual([second.id]);
  const events = debug.events(30).filter(event => event.category === 'decisions.api');
  expect(events).toContainEqual(expect.objectContaining({ event: 'decided', data: expect.objectContaining({ id: first.id }) }));
  for (const reason of ['not-found', 'bad_request', 'already-decided']) {
    expect(events).toContainEqual(expect.objectContaining({ event: 'rejected', data: expect.objectContaining({ reason }) }));
  }
  expect(JSON.stringify(events)).not.toContain('선택 이유');
});

test('route handler fails closed without an injected authorization check, even with a ledger', async () => {
  const { ledger, first } = fixture();
  expect((await handleDecisions(new Request('http://nexus.test/v1/decisions?status=open'), { ledger })).status).toBe(401);
  expect((await handleDecisions(new Request(`http://nexus.test/v1/decisions/${first.id}/decide`, post('a')), { ledger })).status).toBe(401);
  expect(ledger.show(first.id).status).toBe('open');
});
