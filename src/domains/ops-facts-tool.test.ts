import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import { buildMemoryInjection, saveMemory } from '../memory.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import type { SeatsSources } from '../nexus/api/ops-seats.js';
import { buildCoreTools } from './core-tools.js';
import { dispatchDecisionsPending, dispatchOpsSeats } from './ops-facts-tool.js';

const owner: ToolRuntimeContext = { surface: 'dashboard', sessionId: 'owner-session', verifiedOwner: { id: 'owner' } };
const sources = (merged: SeatsSources['merged']): SeatsSources => ({
  channel: async () => [{ body: '**[UX]** work in progress', createdAt: '2026-10-02T02:00:00Z' }],
  merged,
  checklist: () => ({ current: [{ id: 'OPS1', title: 'red item', owner: 'UX', status: 'red', updatedAt: '', updatedBy: '' }], all: [{ id: 'OPS1', title: 'red item', owner: 'UX', status: 'red', updatedAt: '', updatedBy: '' }] }),
  openDecisionRaisers: () => ['UX'],
});

test('owner seats read builds injected rows, defaults to KST today, and keeps unreadable merged as null', async () => {
  let calledDate = '';
  const read = sources(async date => { calledDate = date; return [{ number: 123, title: 'OPS1 shipped', body: '', mergedAt: '2026-10-02T03:00:00Z' }]; });
  const board = await dispatchOpsSeats({}, owner, { seatsSources: () => read, today: () => '2026-10-02' });
  expect(calledDate).toBe('2026-10-02');
  expect(board).toMatchObject({ date: '2026-10-02', seats: [{ seat: 'OP' }, { seat: 'TC' }, { seat: 'MK' }, {
    seat: 'UX', now: { text: '**[UX]** work in progress' }, landed: [{ pr: 123, checklistId: 'OPS1' }],
    red: [{ id: 'OPS1', status: 'red' }], pendingDecisions: 1,
  }] });
  expect(board.note).toContain('null = 못 읽음(없다가 아님)');
  const unread = await dispatchOpsSeats({ date: '2026-10-01' }, owner, { seatsSources: () => sources(async () => null) });
  expect(unread.seats?.[3]?.landed).toBeNull();
  expect(unread.seats?.[3]?.red).toEqual([{ id: 'OPS1', title: 'red item', status: 'red' }]);
});

test('unauthenticated, declared owner, and external agent cannot reach either source', async () => {
  let seatsCalls = 0; let ledgerCalls = 0;
  const deps = { seatsSources: () => { seatsCalls++; return sources(async () => []); },
    listDecisions: () => { ledgerCalls++; return []; } };
  const core = buildCoreTools();
  for (const ctx of [undefined, { surface: 'dashboard' as const, sessionId: 'x', requestOrigin: 'owner' as const },
    { ...owner, requestOrigin: 'external-agent' as const }, { ...owner, sessionId: undefined }]) {
    expect(await dispatchOpsSeats({}, ctx, deps)).toEqual({ error: '오너 확인이 필요한 조회다' });
    expect(dispatchDecisionsPending(ctx, deps)).toEqual({ error: '오너 확인이 필요한 조회다' });
    expect(await core.dispatch('ops_seats', {}, undefined, ctx)).toEqual({ error: '오너 확인이 필요한 조회다' });
    expect(await core.dispatch('decisions_pending', {}, undefined, ctx)).toEqual({ error: '오너 확인이 필요한 조회다' });
  }
  expect(seatsCalls).toBe(0);
  expect(ledgerCalls).toBe(0);
});

test('invalid date is rejected before the seat sources are called', async () => {
  let calls = 0;
  expect(await dispatchOpsSeats({ date: '2026-02-30' }, owner, { seatsSources: () => { calls++; return sources(async () => []); } }))
    .toEqual({ error: 'KST 날짜는 YYYY-MM-DD 여야 한다' });
  expect(calls).toBe(0);
});

test('open decisions only, due first, minimal fields without SCQA, options, note, or agent', () => {
  const entry = (id: string, dueAt?: string, status: DecisionEntry['status'] = 'open'): DecisionEntry => ({
    id, title: '제목', category: 'scope', status, ...(dueAt ? { dueAt } : {}),
    raisedBy: { agent: 'PRIVATE_AGENT', track: 'O' }, scqa: { s: 'PRIVATE_SCQA', c: 'PRIVATE_SCQA' },
    options: [{ key: 'a', label: 'PRIVATE_OPTIONS', consequence: '' }], note: 'PRIVATE_NOTE',
    recommendation: { skipped: true, reason: '' }, history: [],
  });
  let filter: unknown;
  const result = dispatchDecisionsPending(owner, { listDecisions: f => { filter = f; return [entry('later', '2026-10-04T00:00:00Z'), entry('closed', undefined, 'decided'), entry('undated'), entry('first', '2026-10-03T00:00:00Z')]; } });
  expect(filter).toEqual({ status: 'open' });
  expect(result.items).toEqual([
    { id: 'first', title: '제목', category: 'scope', dueAt: '2026-10-03T00:00:00Z', raisedBy: { track: 'O' } },
    { id: 'later', title: '제목', category: 'scope', dueAt: '2026-10-04T00:00:00Z', raisedBy: { track: 'O' } },
    { id: 'undated', title: '제목', category: 'scope', dueAt: null, raisedBy: { track: 'O' } },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_SCQA|PRIVATE_OPTIONS|PRIVATE_NOTE|PRIVATE_AGENT|"scqa"|"options"|"note"/);
});

test('ledger failure is not an empty decisions list', () => {
  expect(dispatchDecisionsPending(owner, { listDecisions: () => { throw new Error('PRIVATE_CAUSE'); } }))
    .toEqual({ error: '결정 원장을 읽지 못했다', items: null });
});

test('real decision ledger reads through owner core dispatch, never changes its file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-facts-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    const ledger = new DecisionLedger({ stateDir: root, resolveVersion: () => ({ released: '0.2.9', dev: '0.2.10', codename: 'test' }) });
    const raised = ledger.raise({ title: '결정 제목', category: 'scope', scqa: { s: '상황', c: '난점' },
      options: [{ key: 'a', label: '선택 A', consequence: 'A 결과' }, { key: 'b', label: '선택 B', consequence: 'B 결과' }],
      recommendation: { skipped: true, reason: '이유' }, raisedBy: { agent: 'TC', track: 'O' }, dueAt: '2026-10-05T00:00:00Z' });
    const before = Bun.file(ledger.path);
    const content = await before.text();
    const result = await buildCoreTools().dispatch('decisions_pending', {}, undefined, owner);
    expect(result).toEqual({ items: [{ id: raised.id, title: '결정 제목', category: 'scope', dueAt: '2026-10-05T00:00:00.000Z', raisedBy: { track: 'O' } }] });
    expect(await Bun.file(ledger.path).text()).toBe(content);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale pinned memory names all three actual ledger tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-facts-memory-'));
  try {
    const entry = saveMemory({ type: 'reference', name: 'ops-now', description: 'status', body: '옛 상태', pinned: true, staleAfterMinutes: 1 }, root);
    const path = join(root, entry.filename);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^updated: .*$/m, 'updated: 2020-01-01T00:00:00.000Z'));
    const block = buildMemoryInjection('안녕', {}, root).block;
    for (const tool of ['ops_seats', 'decisions_pending', 'release_status']) expect(block).toContain(tool);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
