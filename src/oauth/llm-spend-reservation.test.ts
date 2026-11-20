// 예약 원장 + 동시성 시험 — #39172 JUD must②: 동시 호출이 같은 잔여 상한을 둘 다 쓰지 못한다.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemoryGuardStore, runLlmSpendGuard, type LlmSpendGuardDeps } from './llm-spend-guard.js';
import { createFileReservationLedger, createInMemoryReservationLedger, withSpendLock } from './llm-spend-reservation.js';
import { defaultSpendPolicyDoc } from '../nexus/llm-spend-policy/schema.js';
import type { LlmSpendLedgerEntry, LlmSpendPolicyDoc, LlmSpendRowState } from '../nexus/llm-spend-policy/types.js';

const T0 = new Date('2026-11-20T03:00:00.000Z');
const LEASE = '2026-11-20T23:00:00.000Z';
const MODEL = 'openrouter/z-ai/glm-5.3';

function policy(): LlmSpendPolicyDoc {
  const base = defaultSpendPolicyDoc();
  const or = base.providers.openrouter as { spendCap: object };
  return {
    ...base,
    providers: { ...base.providers, openrouter: { ...or, spendCap: { dailyUsd: 100, monthlyUsd: 1000 } } }, // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    roles: { judgement: { prefer: [], creditOk: true, deny: [] } },
  } as unknown as LlmSpendPolicyDoc;
}
function states(todayUsd: number, balanceUsd = 1000): LlmSpendRowState[] { // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
  const subs = ['codex-default', 'codex-team', 'codex-third', 'claude-code-sub', 'claude-acp'].map((row): LlmSpendRowState => ({
    row, provider: 'x', window: { status: 'measured', usedPct: 100, observedAt: T0.toISOString() }, lease: { leaseId: `l-${row}`, expiresAt: LEASE },
  }));
  subs.push({
    row: 'openrouter', provider: 'openrouter',
    balance: { status: 'measured', usd: balanceUsd, observedAt: T0.toISOString() } as never,
    spend: { todayUsd, monthUsd: 0, source: 't', observedAt: T0.toISOString() },
    lease: { leaseId: 'l-or', expiresAt: LEASE },
  });
  return subs;
}
function mkDeps(todayUsd: number, ledger = createInMemoryReservationLedger(), opts: { slowRead?: boolean } = {}) {
  const written: LlmSpendLedgerEntry[] = [];
  const deps: LlmSpendGuardDeps = {
    policy: policy(), memory: createInMemoryGuardStore(), reservations: ledger, now: () => T0,
    readStates: () => states(todayUsd),
    appendLedger: async (e) => { if (opts.slowRead) await new Promise((r) => setTimeout(r, 1)); written.push(e); },
  };
  return { deps, ledger, written };
}
const req = (estimateUsd: number | undefined) => ({ role: 'judgement' as const, execLocation: 'host' as const, model: MODEL, ...(estimateUsd !== undefined ? { estimateUsd } : {}) });

describe('예약 원장 — reserve · commit · release', () => {
  test('잔여(100-90=10) 안에서 reserve 성공 → 다음 호출은 예약분이 빠진 잔여로 판정', async () => {
    const { deps } = mkDeps(90); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    const a = await runLlmSpendGuard(deps, req(6)); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(a.decision.outcome).toBe('choice');
    expect(a.reservation?.estimateUsd).toBe(6);
    const b = await runLlmSpendGuard(deps, req(6)); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(b.decision.outcome).toBe('stop'); // 90+6(예약)+6 > 100
    expect(b.reservation).toBeUndefined();
  });
  test('release 하면 잔여가 돌아온다', async () => {
    const { deps } = mkDeps(90); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    const a = await runLlmSpendGuard(deps, req(6)); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(a.reservation!.release()).toBe(true);
    expect(a.reservation!.release()).toBe(false); // 두 번 해제 불가
    const b = await runLlmSpendGuard(deps, req(6)); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(b.decision.outcome).toBe('choice');
  });
  test('commit 은 실제 지출액으로 바뀌어 실측이 따라잡기 전까지 합에 남는다 · 실측이 따라잡으면 이중 계산 0', async () => {
    const { deps, ledger } = mkDeps(90); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    const a = await runLlmSpendGuard(deps, req(6)); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(a.reservation!.commit(4)).toBe(true); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(ledger.snapshot()[0]).toMatchObject({ state: 'committed', usd: 4 });
    // 실측(observedAt=T0)이 commit 시각(T0)을 포함 → 이중 계산 안 함: 90 + 0 + 6 ≤ 100
    const b = await runLlmSpendGuard(deps, req(6)); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(b.decision.outcome).toBe('choice');
  });
  test('잘못된 추정액(NaN·음수·미지정)은 크레딧 거부 — 예약 0', async () => {
    const { deps, ledger } = mkDeps(0);
    for (const est of [NaN, -1, undefined]) {
      const r = await runLlmSpendGuard(deps, req(est));
      expect(r.decision.outcome).toBe('stop');
    }
    expect(ledger.snapshot().length).toBe(0);
  });
  test('원장 reserve 자체가 거부되면(중복 id 등) 멈춤', async () => {
    const { deps } = mkDeps(0);
    const r1 = await runLlmSpendGuard({ ...deps, newReservationId: () => 'dup' }, req(1)); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(r1.decision.outcome).toBe('choice');
    const r2 = await runLlmSpendGuard({ ...deps, newReservationId: () => 'dup' }, req(1)); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(r2.decision.outcome).toBe('stop');
    expect(r2.decision.reason).toContain('reserve-failed');
  });
});

describe('동시성 — Promise.all 로 N 호출 → 잔여를 초과해 허용되는 호출 0', () => {
  for (const [label, slow] of [['빠른 원장', false], ['느린 원장(await 사이 끼어들기 유도)', true]] as const) {
    test(`${label}: 잔여 10 · 호출당 3 · 20 호출 → 정확히 3건 허용(합 ≤ 잔여)`, async () => {
      const { deps, ledger } = mkDeps(90, undefined, { slowRead: slow }); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
      const results = await Promise.all(Array.from({ length: 20 }, () => runLlmSpendGuard(deps, req(3)))); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
      const allowed = results.filter((r) => r.decision.outcome === 'choice');
      expect(allowed.length).toBe(3);
      const reservedSum = ledger.snapshot(T0).reduce((a, e) => a + e.usd, 0);
      expect(reservedSum).toBeLessThanOrEqual(10); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
      expect(90 + reservedSum).toBeLessThanOrEqual(100); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    });
  }
  test('같은 잔여를 노리는 2 호출 — 하나만 허용', async () => {
    const { deps } = mkDeps(95); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    const [a, b] = await Promise.all([runLlmSpendGuard(deps, req(5)), runLlmSpendGuard(deps, req(5))]); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect([a, b].filter((r) => r.decision.outcome === 'choice').length).toBe(1);
  });
  test('withSpendLock — 겹치지 않고 호출 순서대로 · 앞이 throw 해도 다음은 진행', async () => {
    const key = {};
    const order: string[] = [];
    const mk = (n: string, fail = false) => withSpendLock(key, async () => {
      order.push(`start-${n}`); await new Promise((r) => setTimeout(r, 2)); order.push(`end-${n}`);
      if (fail) throw new Error('boom');
    });
    const results = await Promise.allSettled([mk('a', true), mk('b'), mk('c')]);
    expect(order).toEqual(['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c']);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
  });
});

describe('파일 원장 — 원자 쓰기 · fail-closed', () => {
  test('reserve → 다시 열어도 같다 · commit · release', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rsv-')), 'sub', 'ledger.json');
    const a = createFileReservationLedger(path);
    expect(a.reserve({ id: 'x', row: 'openrouter', estimateUsd: 2, at: T0.toISOString() })).toBe(true); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(a.reserve({ id: 'x', row: 'openrouter', estimateUsd: 2, at: T0.toISOString() })).toBe(false); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(a.reserve({ id: 'n', row: 'openrouter', estimateUsd: NaN, at: T0.toISOString() })).toBe(false);
    expect(createFileReservationLedger(path).snapshot(T0)).toHaveLength(1);
    expect(a.commit('x', 1, T0.toISOString())).toBe(true); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(JSON.parse(readFileSync(path, 'utf8')).entries[0]).toMatchObject({ state: 'committed', usd: 1 });
    expect(a.release('x')).toBe(false); // committed 는 해제 불가
  });
  test('깨진 파일 → reserve 거부 · snapshot 이 모든 행을 막는다(fail-closed)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rsv-')), 'ledger.json');
    writeFileSync(path, '{not json');
    const ledger = createFileReservationLedger(path);
    expect(ledger.reserve({ id: 'x', row: 'openrouter', estimateUsd: 1, at: T0.toISOString() })).toBe(false); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    const { deps } = mkDeps(0, ledger);
    const r = await runLlmSpendGuard(deps, req(1)); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(r.decision.outcome).toBe('stop');
  });
  test('파일 원장 위 동시성도 초과 0', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rsv-')), 'ledger.json');
    const { deps } = mkDeps(90, createFileReservationLedger(path)); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    const results = await Promise.all(Array.from({ length: 12 }, () => runLlmSpendGuard(deps, req(4)))); // 출처: #39172 JUD(msg 109296 must②) 동시성 시험 픽스처
    expect(results.filter((r) => r.decision.outcome === 'choice').length).toBe(2);
  });
});
