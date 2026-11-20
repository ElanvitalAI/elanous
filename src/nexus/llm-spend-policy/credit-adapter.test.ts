// CC-1 잔액 어댑터 시험 — readOpenRouterCredit 관측 → 정책 조회 현황(잔액·자동 충전). 비밀 0 · 읽기 전용.
import { describe, expect, test } from 'bun:test';
import { creditObservationToRowState, mergeRowStates, readCreditRowStates } from './credit-adapter.js';
import { defaultSpendPolicyDoc } from './schema.js';

const NOW = () => new Date('2026-11-20T03:00:00Z');
const okFetch = (async () => new Response(JSON.stringify({ data: { total_credits: 100, total_usage: 40 } }), { status: 200 })) as unknown as typeof fetch;

describe('credit-adapter', () => {
  test('관측 measured → 잔액 60USD 로 옮긴다(자동 충전 not-provided 는 그대로 unmeasured)', async () => {
    const [state] = await readCreditRowStates(defaultSpendPolicyDoc(), { leases: { openrouter: 'fake-lease-value' }, fetchImpl: okFetch, now: NOW });
    expect(state!.row).toBe('openrouter');
    expect(state!.balance).toEqual({ status: 'measured', usd: 60, totalCreditsUsd: 100, totalUsageUsd: 40, source: 'openrouter-credits-derived', observedAt: '2026-11-20T03:00:00.000Z' });
    expect(state!.autoTopUp).toEqual({ status: 'unmeasured', reason: 'not-provided' });
  });
  test('임대 값은 상태·직렬화 어디에도 실리지 않는다', async () => {
    const states = await readCreditRowStates(defaultSpendPolicyDoc(), { leases: { openrouter: 'fake-lease-value' }, fetchImpl: okFetch, now: NOW });
    expect(JSON.stringify(states)).not.toContain('fake-lease-value');
  });
  test('임대 없으면 네트워크 0 · unmeasured(missing-management-lease)', async () => {
    let called = 0;
    const spy = (async () => { called += 1; return new Response('{}'); }) as unknown as typeof fetch;
    const [state] = await readCreditRowStates(defaultSpendPolicyDoc(), { fetchImpl: spy });
    expect(called).toBe(0);
    expect(state!.balance).toEqual({ status: 'unmeasured', reason: 'missing-management-lease' });
  });
  test('자동 충전이 measured{enabled,amountUsd,observedAt} 로 넓어진 관측도 받는다', () => {
    const state = creditObservationToRowState('openrouter', {
      provider: 'openrouter',
      balance: { status: 'unmeasured', reason: 'forbidden' },
      autoTopUp: { status: 'measured', enabled: true, amountUsd: 100, observedAt: '2026-11-20T03:00:00Z' },
    });
    expect(state.autoTopUp).toEqual({ status: 'measured', enabled: true, amountUsd: 100, observedAt: '2026-11-20T03:00:00Z' });
    expect(state.balance).toEqual({ status: 'unmeasured', reason: 'forbidden' });
  });
  test('모른다는 0 이 되지 않는다(응답 이상 → unmeasured)', async () => {
    const bad = (async () => new Response('{"data":{}}', { status: 200 })) as unknown as typeof fetch;
    const [state] = await readCreditRowStates(defaultSpendPolicyDoc(), { leases: { openrouter: 'x' }, fetchImpl: bad });
    expect(state!.balance).toEqual({ status: 'unmeasured', reason: 'invalid-response' });
  });
  test('직접 주입 상태가 어댑터 값을 칸 단위로 덮는다', () => {
    const merged = mergeRowStates(
      [{ row: 'openrouter', provider: 'openrouter', balance: { status: 'unmeasured', reason: 'x' } }],
      [{ row: 'openrouter', provider: 'openrouter', spend: { todayUsd: 1, observedAt: '2026-11-20T03:00:00Z' } }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.balance).toEqual({ status: 'unmeasured', reason: 'x' });
    expect(merged[0]!.spend?.todayUsd).toBe(1);
  });
});
