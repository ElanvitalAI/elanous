// 호출 관문 시험 — 주입 가짜 observers 로 구독→구독→크레딧→멈춤 순서 · creditOk 거부 · hostOnly · 예약 정산 · 태그.
import { describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { gateLlmCall, llmSignalFromError, settleLlmCall, type LlmCallGateDeps, type LlmCallTag, type LlmSpendRecord } from './llm-call-gate.js';
import { createInMemoryGuardStore } from './llm-spend-guard.js';
import { createInMemoryReservationLedger } from './llm-spend-reservation.js';
import { defaultSpendPolicyDoc } from '../nexus/llm-spend-policy/schema.js';
import type { LlmSpendLedgerEntry, LlmSpendRowState } from '../nexus/llm-spend-policy/types.js';

const T0 = new Date('2026-11-20T03:00:00.000Z');
const LEASE = '2026-11-20T23:00:00.000Z';
const GLM = 'openrouter/z-ai/glm-5.3';
const SUBS = ['codex-default', 'codex-team', 'codex-third', 'claude-code-sub', 'claude-acp'] as const;

function subState(pct: Record<string, number>): LlmSpendRowState[] {
  return SUBS.map((row) => ({
    row, provider: 'x',
    window: { status: 'measured', usedPct: pct[row] ?? 10, observedAt: T0.toISOString() },
    lease: { leaseId: `l-${row}`, expiresAt: LEASE },
    ...(row === 'claude-acp' ? { device: { status: 'measured' as const, alive: true, sessions: 0, observedAt: T0.toISOString() } } : {}),
  }));
}
function creditState(todayUsd: number): LlmSpendRowState[] {
  return [{
    row: 'openrouter', provider: 'openrouter',
    balance: { status: 'measured', usd: 50, totalCreditsUsd: 100, totalUsageUsd: 50, source: 't', observedAt: T0.toISOString() },
    spend: { todayUsd, monthUsd: todayUsd, source: 't', observedAt: T0.toISOString() },
    lease: { leaseId: 'l-or', expiresAt: LEASE },
  }];
}

function setup(pct: Record<string, number>, todayUsd = 10) {
  const ledger: LlmSpendLedgerEntry[] = [];
  const spends: LlmSpendRecord[] = [];
  const tags: LlmCallTag[] = [];
  const reservations = createInMemoryReservationLedger();
  let n = 0;
  const state = { pct, todayUsd };
  const deps: LlmCallGateDeps = {
    readPolicy: async () => defaultSpendPolicyDoc(),
    observers: [() => subState(state.pct), () => creditState(state.todayUsd)],
    memory: createInMemoryGuardStore(), now: () => T0, reservations,
    appendLedger: (e) => { ledger.push(e); },
    newReservationId: () => `r${++n}`, newCallId: () => `c${n}`,
    recordSpend: (r) => { spends.push(r); }, recordUsageTag: (t) => { tags.push(t); },
  };
  return { deps, ledger, spends, tags, reservations, state };
}
const FULL = 100;

describe('gateLlmCall — 순서', () => {
  test('구독 → 구독 → 크레딧 → 멈춤 순서(행·공급자 리터럴)', async () => {
    const w = setup({});
    const req = { role: 'judgement', location: 'host', models: [GLM], estimateUsd: 5 } as const;

    const a = await gateLlmCall(req, w.deps);
    expect(a.outcome === 'go' && [a.row, a.provider, a.reservation]).toEqual(['codex-default', 'openai-codex', null]);

    w.state.pct = { 'codex-default': FULL };
    const b = await gateLlmCall(req, w.deps);
    expect(b.outcome === 'go' && [b.row, b.provider]).toEqual(['codex-team', 'openai-codex']);

    w.state.pct = Object.fromEntries(SUBS.map((r) => [r, FULL]));
    const c = await gateLlmCall(req, w.deps);
    expect(c.outcome === 'go' && [c.row, c.provider, c.model, c.reservation?.estimateUsd]).toEqual(['openrouter', 'openrouter', GLM, 5]);
    expect(c.ledgerLines.map((l) => [l.action, l.to])).toEqual([['switch', 'openrouter']]);

    w.state.todayUsd = 299; // 일 상한 300 − 299 − 예약 5 → 초과
    const d = await gateLlmCall(req, w.deps);
    expect(d.outcome).toBe('stop');
    expect(d.outcome === 'stop' && d.ledgerLines.map((l) => l.what)).toEqual(['stop']);
  });

  test('creditOk=false 역할(ta-child)은 구독이 다 찼을 때 크레딧 없이 멈춘다', async () => {
    const w = setup(Object.fromEntries(SUBS.map((r) => [r, FULL])));
    const r = await gateLlmCall({ role: 'ta-child', location: 'host', models: [GLM], estimateUsd: 1 }, w.deps);
    expect(r.outcome).toBe('stop');
    expect(r.skipped.find((s) => s.row === 'openrouter')?.why).toContain('creditOk');
    expect(w.reservations.snapshot(T0)).toEqual([]);
  });

  test('모델 후보가 둘이면 앞에서부터 멈춤이 아닌 첫 결정(없는 모델 → glm)', async () => {
    const w = setup(Object.fromEntries(SUBS.map((r) => [r, FULL])));
    const r = await gateLlmCall({ role: 'judgement', location: 'host', models: ['nope/none', GLM], estimateUsd: 1 }, w.deps);
    expect(r.outcome === 'go' && [r.row, r.model]).toEqual(['openrouter', GLM]);
  });
});

describe('gateLlmCall — hostOnly(claude-acp)', () => {
  const pct = { 'codex-default': FULL, 'codex-team': FULL, 'codex-third': FULL, 'claude-code-sub': FULL };
  test('host: claude-acp 선택', async () => {
    const r = await gateLlmCall({ role: 'judgement', location: 'host', estimateUsd: 1 }, setup(pct).deps);
    expect(r.outcome === 'go' && r.row).toBe('claude-acp');
  });
  test('pod: claude-acp 제외 → 크레딧으로 · skipped 에 claude-acp', async () => {
    const r = await gateLlmCall({ role: 'judgement', location: 'pod', models: [GLM], estimateUsd: 1 }, setup(pct).deps);
    expect(r.outcome === 'go' && r.row).toBe('openrouter');
    expect(r.skipped.some((s) => s.row === 'claude-acp')).toBe(true);
  });
});

describe('settleLlmCall — 정산 · 태그', () => {
  const FULL_ALL = Object.fromEntries(SUBS.map((r) => [r, FULL]));
  test('ok: 실제 3 으로 commit · 지출 기록 · 태그(role·seat)', async () => {
    const w = setup(FULL_ALL);
    const g = await gateLlmCall({ role: 'judgement', location: 'host', models: [GLM], estimateUsd: 5, seat: 'HAND-ELN-ELS-API' }, w.deps);
    if (g.outcome !== 'go') throw new Error('go expected');
    const s = await settleLlmCall(g.handle, { status: 'ok', actualUsd: 3 });
    expect(s).toEqual({ committed: true, released: false, spendRecorded: true, tagRecorded: true, errors: [] });
    expect(w.reservations.snapshot(T0)[0]).toMatchObject({ state: 'committed', usd: 3, row: 'openrouter' });
    expect(w.spends).toEqual([{ callId: 'c1', at: T0.toISOString(), row: 'openrouter', role: 'judgement', usd: 3 }]);
    expect(w.tags).toEqual([{ callId: 'c1', at: T0.toISOString(), role: 'judgement', seat: 'HAND-ELN-ELS-API', row: 'openrouter', provider: 'openrouter', model: GLM, status: 'ok', usd: 3 }]);
  });
  test('not-called: release(잔여 복구) · 지출 기록 0 · 태그는 남음', async () => {
    const w = setup(FULL_ALL);
    const g = await gateLlmCall({ role: 'judgement', location: 'host', models: [GLM], estimateUsd: 5 }, w.deps);
    if (g.outcome !== 'go') throw new Error('go expected');
    expect(w.reservations.snapshot(T0)).toHaveLength(1);
    const s = await settleLlmCall(g.handle, { status: 'not-called' });
    expect([s.committed, s.released, s.spendRecorded, s.tagRecorded]).toEqual([false, true, false, true]);
    expect(w.reservations.snapshot(T0)).toHaveLength(0);
    expect(w.spends).toEqual([]);
    expect(w.tags[0]).toMatchObject({ seat: null, status: 'not-called', usd: null });
  });
  test('actualUsd 모르면 추정액 5 로 commit(과소 계상 0) · 기록 슬롯이 throw 해도 예외 0', async () => {
    const w = setup(FULL_ALL);
    const deps = { ...w.deps, recordUsageTag: () => { throw new Error('sink down'); } };
    const g = await gateLlmCall({ role: 'judgement', location: 'host', models: [GLM], estimateUsd: 5 }, deps);
    if (g.outcome !== 'go') throw new Error('go expected');
    const s = await settleLlmCall(g.handle, { status: 'failed' });
    expect(s.committed).toBe(true);
    expect(s.tagRecorded).toBe(false);
    expect(s.errors).toEqual(['recordUsageTag: sink down']);
    expect(w.reservations.snapshot(T0)[0]).toMatchObject({ state: 'committed', usd: 5 });
  });
  test('구독 행 호출은 예약 0 · 지출 기록 0 · 태그만', async () => {
    const w = setup({});
    const g = await gateLlmCall({ role: 'judgement', location: 'host', seat: 'S1' }, w.deps);
    if (g.outcome !== 'go') throw new Error('go expected');
    const s = await settleLlmCall(g.handle, { status: 'ok' });
    expect([s.committed, s.released, s.spendRecorded, s.tagRecorded]).toEqual([false, false, false, true]);
    expect(w.tags[0]).toMatchObject({ row: 'codex-default', provider: 'openai-codex', seat: 'S1' });
  });
});

describe('gateLlmCall — fail-closed', () => {
  test('정책을 못 읽으면 멈춤', async () => {
    const w = setup({});
    const r = await gateLlmCall({ role: 'judgement', location: 'host' }, { ...w.deps, readPolicy: async () => { throw new Error('boom'); } });
    expect(r).toMatchObject({ outcome: 'stop' });
    expect(r.ledgerLines.map((l) => [l.action, l.what, l.reason.startsWith('policy-unreadable(')])).toEqual([['decision', 'stop', true]]); // 원장 사유 policy-unreadable
    expect(r.outcome === 'stop' && r.reason).toBe('policy-unreadable(정책 저장소를 못 읽음 — fail-closed 멈춤): boom');
  });
  test('관측기가 전부 throw 하면 모든 행이 모름 → 멈춤', async () => {
    const w = setup({});
    const bad = () => { throw new Error('probe down'); };
    const r = await gateLlmCall({ role: 'judgement', location: 'host' }, { ...w.deps, observers: [bad, bad] });
    expect(r.outcome).toBe('stop');
  });
  test('원장 쓰기 실패 + 크레딧 전환 → 멈춤 · 예약 0', async () => {
    const w = setup(Object.fromEntries(SUBS.map((r) => [r, FULL])));
    const r = await gateLlmCall({ role: 'judgement', location: 'host', models: [GLM], estimateUsd: 1 }, { ...w.deps, appendLedger: () => { throw new Error('disk full'); } });
    expect(r.outcome).toBe('stop');
    expect(w.reservations.snapshot(T0)).toEqual([]);
  });
});

describe('gateLlmCall — 켜짐은 데이터 유무(정책 정본)', () => {
  test('정책 없음 → pass-through · 선택 행 없음 · 원장 observe 1줄 · 관측기 안 건드림', async () => {
    const w = setup({});
    let observed = 0;
    const r = await gateLlmCall({ role: 'judgement', location: 'host', estimateUsd: 5 }, { ...w.deps, readPolicy: async () => null, observers: [() => { observed += 1; return []; }] });
    expect(r.outcome).toBe('pass-through');
    expect('row' in r).toBe(false);
    expect(r.ledgerLines.map((l) => [l.action, l.what, l.from, l.to])).toEqual([['observe', 'pass-through', null, null]]);
    expect(w.ledger).toHaveLength(1);
    expect(w.reservations.snapshot(T0)).toEqual([]);
    expect(w.deps.memory.load()).toEqual({ windows: {} }); // 기존 선택(기억)을 건드리지 않는다
    expect(observed).toBe(0);
  });
  test('정책 있음+유효 → 기존대로 가드(go)', async () => {
    const r = await gateLlmCall({ role: 'judgement', location: 'host' }, setup({}).deps);
    expect(r.outcome === 'go' && r.row).toBe('codex-default');
  });
  test('정책 있음+깨짐(readPolicy throw) → stop · 원장 사유 policy-unreadable', async () => {
    const w = setup({});
    const r = await gateLlmCall({ role: 'judgement', location: 'host' }, { ...w.deps, readPolicy: async () => { throw new Error('yaml broken'); } });
    expect(r.outcome).toBe('stop');
    expect(w.ledger[0]!.reason).toContain('policy-unreadable');
  });
});

describe('llmSignalFromError · settle 실제 신호', () => {
  test('429 usage_limit_reached + resets_at(epoch 초) → ISO', () => {
    const err = Object.assign(new Error('{"error":{"type":"usage_limit_reached","resets_at":1795200000}}'), { status: 429 });
    expect(llmSignalFromError(err)).toEqual({ kind: 'usage_limit_reached', resetsAt: '2026-11-20T18:40:00.000Z' });
  });
  test('402 → insufficient_credits · 일반 429/500 → undefined', () => {
    expect(llmSignalFromError(Object.assign(new Error('pay'), { status: 402 }))).toEqual({ kind: 'insufficient_credits' });
    expect(llmSignalFromError(Object.assign(new Error('rate'), { status: 429 }))).toBeUndefined();
    expect(llmSignalFromError(new Error('x'))).toBeUndefined();
  });
  test('settle 가 신호를 recordSignal 슬롯으로 넘긴다(row·provider 포함)', async () => {
    const w = setup({});
    const got: unknown[] = [];
    const g = await gateLlmCall({ role: 'judgement', location: 'host' }, { ...w.deps, recordSignal: (r) => { got.push(r); } });
    if (g.outcome !== 'go') throw new Error('go expected');
    const s = await settleLlmCall(g.handle, { status: 'failed', signal: { kind: 'usage_limit_reached', resetsAt: '2026-11-20T18:40:00.000Z' } });
    expect(s.signalRecorded).toBe(true);
    expect(got).toEqual([{ callId: 'c0', at: T0.toISOString(), row: 'codex-default', provider: 'openai-codex', signal: { kind: 'usage_limit_reached', resetsAt: '2026-11-20T18:40:00.000Z' } }]);
  });
});

// 결정 1건 = logs.db 이벤트 1줄(llm-gate/decision). 주입 deps 만 — 파일·~/.elanous 쓰기 0(debug 링 버퍼만 본다).
const gateEvents = () => debug.events(200).filter((e) => e.category === 'llm-gate' && e.event === 'decision');

describe('gateLlmCall — llm-gate/decision 이벤트', () => {
  test('go 1건 → 이벤트 1줄: runId(callId)·provider·row·synthetic 표지·사유 코드', async () => {
    debug.clear();
    const w = setup({});
    const g = await gateLlmCall({ role: 'judgement', location: 'host' }, w.deps);
    if (g.outcome !== 'go') throw new Error('go expected');
    const rows = gateEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toEqual({ runId: g.handle.callId, decision: 'chosen', provider: 'openai-codex', row: 'codex-default', synthetic: false, reason: 'choice' });
  });
  test('합성 실측 위에서 낸 결정은 synthetic: true · stop 도 1줄(provider 없음)', async () => {
    debug.clear();
    const w = setup({});
    const synth = subState({}).map((s) => ({ ...s, window: { ...s.window!, source: 'synthetic' } }));
    await gateLlmCall({ role: 'judgement', location: 'host' }, { ...w.deps, observers: [() => synth] });
    await gateLlmCall({ role: 'judgement', location: 'host' }, { ...w.deps, readPolicy: async () => { throw new Error('yaml broken'); } });
    const rows = gateEvents();
    expect(rows.map((r) => (r.data as { synthetic: boolean }).synthetic)).toEqual([true, false]);
    expect(rows[1]!.data).toMatchObject({ decision: 'stop', provider: null, row: null, reason: 'policy-unreadable' });
  });
  test('건너뛴 행의 합성 실측이 폴백을 부른 결정도 synthetic: true(선택된 행은 실측이어도)', async () => {
    debug.clear();
    const w = setup({ 'codex-default': 100 });
    const synth = subState({ 'codex-default': 100 }).map((s) => s.row === 'codex-default' ? { ...s, window: { ...s.window!, source: 'synthetic' } } : s);
    const g = await gateLlmCall({ role: 'judgement', location: 'host' }, { ...w.deps, observers: [() => synth, () => creditState(10)] });
    if (g.outcome !== 'go') throw new Error('go expected');
    expect(g.row).not.toBe('codex-default');
    expect(gateEvents()[0]!.data).toMatchObject({ decision: 'chosen', row: g.row, synthetic: true });
  });
  test('정책 없음(pass-through)은 이벤트 0 · 결과 불변', async () => {
    debug.clear();
    const r = await gateLlmCall({ role: 'judgement', location: 'host' }, { ...setup({}).deps, readPolicy: async () => null });
    expect(r.outcome).toBe('pass-through');
    expect(gateEvents()).toHaveLength(0);
  });
  test('비밀 모양 값(lease id·actor·seat·오류 메시지)은 이벤트에 나타나지 않는다', async () => {
    debug.clear();
    const w = setup({});
    const leased = subState({}).map((s) => ({ ...s, lease: { leaseId: 'sk-live-SECRET123', expiresAt: LEASE } }));
    await gateLlmCall({ role: 'judgement', location: 'host', actor: 'Bearer-TOKEN-xyz', seat: 'ghp_SEATSECRET' }, { ...w.deps, observers: [() => leased] });
    await gateLlmCall({ role: 'judgement', location: 'host' }, { ...w.deps, readPolicy: async () => { throw new Error('api_key=sk-ERRSECRET'); } });
    const text = JSON.stringify(gateEvents());
    expect(gateEvents()).toHaveLength(2);
    expect(text).not.toMatch(/SECRET|TOKEN|sk-|ghp_|api_key|Bearer/);
  });
});
