import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionLedger } from '../../decisions/decision-ledger.js';
import { MsgStore } from '../../msg/msg-store.js';
import { debug } from '../../debug/log.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { handleDecisions } from './decisions-route.js';
import { handleOpsBoard } from './ops-board-route.js';
import { decide as pwaDecide, listOpenDecisions as pwaListOpenDecisions } from '../../../apps/pwa/src/lib/decisions-api.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { isPublicRoute } from './public-routes.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'decisions-api-'));
  roots.push(root);
  const ledger = new DecisionLedger({ stateDir: root, now: () => new Date('2026-10-04T00:00:00Z'), resolveVersion: () => ({ released: null, dev: '0.2.13', codename: null }) });
  const first = ledger.raise({ title: '첫 결정', category: 'money', scqa: { s: '가'.repeat(220), c: '결정이 필요하다', q: '어느 쪽인가?', a: '지금 정한다' },
    options: [{ key: 'a', label: '진행', consequence: '진행한다' }, { key: 'b', label: '대기', consequence: '대기한다' }],
    recommendation: { option: 'a', why: '빠르다' }, raisedBy: { agent: 'OP', track: 'OP' }, alternative: 'b', dissent: '반대 의견',
    crossCheck: [{ seat: 'TC', at: '2026-10-04T00:00:00Z', note: '검토됨' }], pendingQuestion: '전문 첫 줄\n전문 둘째 줄', dueAt: '2026-10-05T00:00:00Z' });
  const second = ledger.raise({ title: '둘째 결정', category: 'other', scqa: { s: '상황', c: '문제' },
    options: [{ key: 'a', label: '예', consequence: '한다' }, { key: 'b', label: '아니오', consequence: '안 한다' }],
    recommendation: { skipped: true, reason: '보류' }, raisedBy: { agent: 'UX' }, crossCheckSkipped: '시간 부족' });
  return { ledger, first, second };
}
function dispatch(ledger: DecisionLedger, path: string, init: RequestInit = {}) {
  const opts = { metaApi: { bearerToken: 'owner-token', noAuth: false }, decisions: { ledger } } as unknown as NexusHttpServerOpts;
  return routeRequest(new Request(`http://nexus.test${path}`, init), opts, {} as never, null, createDevProxyRuntimeRef());
}
const auth = { authorization: 'Bearer owner-token' };
const post = (choice: string, note?: string) => ({ method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ choice, ...(note ? { note } : {}) }) });

test('notice transport is private; CLI messages appear and owner reply reaches the original seat without touching the ledger', async () => {
  const { ledger, first } = fixture();
  const root = mkdtempSync(join(tmpdir(), 'ops-board-'));
  roots.push(root);
  const path = join(root, 'messages.db');
  const store = new MsgStore(path);
  const notice = store.post({ from: 'TC', to: 'CEO', body: '조율 채널 요약', kind: 'notice' });
  const unrelated = store.post({ from: 'UX', to: 'MK', body: '비공개' });
  const seatNotice = store.post({ from: 'OP', to: 'CEO', body: 'OP 자리 공지', kind: 'notice' });
  const loopNotice = store.post({ from: 'DIG-LOOP', to: 'CEO', body: '루프 보고', kind: 'coordination-summary' });
  const followUp = store.post({ from: 'TC', to: 'CEO', body: '추가 의견', kind: 'reply' });
  store.close();
  const opts = { metaApi: { bearerToken: 'owner-token', noAuth: false }, decisions: { ledger }, opsBoard: { openStore: () => new MsgStore(path) } } as unknown as NexusHttpServerOpts;
  const request = (init: RequestInit = {}, address = '100.100.1.2', host = '100.100.1.1') => routeRequest(new Request(`http://${host}/v1/ops-board/notices`, init), opts,
    { requestIP: () => ({ address }) } as never, null, createDevProxyRuntimeRef());
  expect(isPublicRoute('GET', '/v1/ops-board/notices', { setupMode: false })).toBe(false);
  expect((await request({ headers: auth }, '203.0.113.5'))?.status).toBe(403);
  expect((await request({ headers: auth }, '100.63.1.1'))?.status).toBe(403);
  expect((await request({ headers: auth }, '100.128.0.1'))?.status).toBe(403);
  expect((await request({ headers: auth }, '100.100.1.2', 'public.example'))?.status).toBe(403);
  expect((await routeRequest(new Request('http://100.100.1.1/v1/ops-board/notices', { headers: auth }), opts, {} as never, null, createDevProxyRuntimeRef()))?.status).toBe(403);
  expect((await request())?.status).toBe(401);
  const noAuthOpts = { ...opts, metaApi: { ...opts.metaApi, noAuth: true } } as NexusHttpServerOpts;
  expect((await routeRequest(new Request('http://100.100.1.1/v1/ops-board/notices', { headers: auth }), noAuthOpts,
    { requestIP: () => ({ address: '100.100.1.2' }) } as never, null, createDevProxyRuntimeRef()))?.status).toBe(401);
  expect((await request({ method: 'POST', body: JSON.stringify({ noticeId: notice.id, body: '답변' }) }))?.status).toBe(401);
  const listed = await request({ headers: auth });
  expect((await listed?.json() as { notices: Array<{ id: number }> }).notices.map(row => row.id)).toEqual([notice.id, seatNotice.id, loopNotice.id, followUp.id]);
  expect((await request({ method: 'POST', headers: auth, body: JSON.stringify({ noticeId: unrelated.id, body: '답변' }) }))?.status).toBe(404);
  expect((await request({ method: 'POST', headers: auth, body: JSON.stringify({ noticeId: notice.id, body: ' ' }) }))?.status).toBe(400);
  const loopReply = await request({ method: 'POST', headers: auth, body: JSON.stringify({ noticeId: loopNotice.id, body: '루프 확인' }) });
  expect(await loopReply?.json()).toMatchObject({ reply: { from: 'CEO', to: 'DIG-LOOP', body: '루프 확인' } });
  const seatReply = await request({ method: 'POST', headers: auth, body: JSON.stringify({ noticeId: seatNotice.id, body: 'OP 확인' }) });
  expect(await seatReply?.json()).toMatchObject({ reply: { from: 'CEO', to: 'OP', body: 'OP 확인' } });
  const replied = await request({ method: 'POST', headers: auth, body: JSON.stringify({ noticeId: notice.id, body: '답변' }) });
  expect(replied?.status).toBe(201);
  expect(await replied?.json()).toMatchObject({ reply: { from: 'CEO', to: 'TC', body: '답변', kind: 'reply' } });
  const verify = new MsgStore(path);
  expect(verify.list('TC').map(row => row.body)).toEqual(['답변']);
  expect(verify.list('CEO').map(row => row.id)).toEqual([notice.id, seatNotice.id, loopNotice.id, followUp.id]);
  expect(verify.list('DIG-LOOP').map(row => row.body)).toEqual(['루프 확인']);
  expect(verify.list('OP').map(row => row.body)).toEqual(['OP 확인']);
  expect(verify.getCursor('CEO')).toBe(0);
  verify.close();
  expect(ledger.show(first.id).status).toBe('open');
  expect((await handleOpsBoard(new Request('http://nexus.test/v1/ops-board/notices'), { authorize: () => false })).status).toBe(401);
});

test('eighteen decision responses are recorded in the temporary ledger without changing the card route', async () => {
  const { ledger } = fixture();
  const cards = Array.from({ length: 18 }, (_, index) => ledger.raise({
    title: `묶음 ${index + 1}`, category: 'other', scqa: { s: '상황', c: '결정 필요' },
    options: [{ key: 'a', label: '진행', consequence: '진행' }, { key: 'b', label: '대기', consequence: '대기' }],
    recommendation: { option: 'a', why: '권고 이유' }, raisedBy: { agent: 'OP' },
  }));
  const client = { fetchResponse: (path: string, init?: RequestInit) => dispatch(ledger, path, { ...init, headers: { ...auth, ...init?.headers } }).then(response => response!) };
  const visible = await pwaListOpenDecisions(client);
  expect(cards.every(card => visible.some(item => item.id === card.id))).toBe(true);
  for (const card of cards) {
    expect(await pwaDecide(client, card.id, 'a', '대표 의견')).toHaveProperty('decidedAt');
  }
  expect(cards.map(card => ledger.show(card.id).note)).toEqual(Array(18).fill('대표 의견'));
  expect(cards.every(card => ledger.show(card.id).status === 'decided')).toBe(true);
});

test('GET is owner-only, open-only, and returns full decision card material', async () => {
  const { ledger, first, second } = fixture();
  expect(isPublicRoute('GET', '/v1/decisions', { setupMode: false })).toBe(false);
  expect((await dispatch(ledger, '/v1/decisions?status=open'))?.status).toBe(401);
  expect((await dispatch(ledger, '/v1/decisions?status=open', { headers: { authorization: 'Bearer wrong' } }))?.status).toBe(401);
  const response = await dispatch(ledger, '/v1/decisions?status=open', { headers: auth });
  expect(response?.status).toBe(200);
  const body = await response?.json() as { decisions: Array<Record<string, unknown>> };
  expect(body.decisions).toHaveLength(2);
  const item = body.decisions.find(row => row.id === first.id)!;
  expect(item).toMatchObject({
    id: first.id, title: '첫 결정', situation: '가'.repeat(200),
    options: [{ id: 'a', label: '진행', consequence: '진행한다' }, { id: 'b', label: '대기', consequence: '대기한다' }],
    recommendation: { option: 'a', why: '빠르다' }, raisedAt: first.raisedAt, dueAt: first.dueAt,
    category: 'money', raisedBy: { agent: 'OP', track: 'OP' }, alternative: 'b', dissent: '반대 의견',
    crossCheck: [{ seat: 'TC', at: '2026-10-04T00:00:00.000Z', note: '검토됨' }], pendingQuestion: '전문 첫 줄\n전문 둘째 줄',
  });
  expect(item.scqa).toEqual(first.scqa);
  expect(item.scqa).toMatchObject({ s: '가'.repeat(220), c: '결정이 필요하다', q: '어느 쪽인가?', a: '지금 정한다' });
  expect(item.irreversible).toBe(true);
  expect(body.decisions.find(row => row.id === second.id)).toMatchObject({ irreversible: false, crossCheckSkipped: '시간 부족' });
  expect(debug.events(20)).toContainEqual(expect.objectContaining({ category: 'decisions.api', event: 'listed', data: expect.objectContaining({ count: 2 }) }));
  expect((await dispatch(ledger, '/v1/decisions?status=decided', { headers: auth }))?.status).toBe(400);
});

test('S longer than 200 characters is not cut in SCQA while legacy situation remains capped', async () => {
  const { ledger, first } = fixture();
  const response = await dispatch(ledger, '/v1/decisions?status=open', { headers: auth });
  const body = await response?.json() as { decisions: Array<{ id: string; situation: string; scqa: { s: string } }> };
  const card = body.decisions.find(item => item.id === first.id)!;
  expect(card.situation).toBe('가'.repeat(200));
  expect(card.scqa.s).toBe('가'.repeat(220));
});

test('list carries consequences and irreversible flag from the ledger card rule', async () => {
  const { ledger, first, second } = fixture();
  const response = await dispatch(ledger, '/v1/decisions?status=open', { headers: auth });
  const body = await response?.json() as { decisions: Array<{ id: string; irreversible: boolean; options: Array<{ consequence: string }> }> };
  expect(body.decisions.find(item => item.id === first.id)).toMatchObject({ irreversible: true, options: [{ consequence: '진행한다' }, { consequence: '대기한다' }] });
  expect(body.decisions.find(item => item.id === second.id)?.irreversible).toBe(false);
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
