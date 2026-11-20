// 지출 가드 시험 — 구독 바닥 → onExhausted(다른 구독 → 크레딧 → 멈춤) · 창 리셋 실측 → 복귀 · 히스테리시스 · 원장 · 주입 시계.
import { describe, expect, test } from 'bun:test';
import {
  codexCandidatesToRowStates, createFileGuardStore, createInMemoryGuardStore, observeWindow, runLlmSpendGuard,
  WINDOW_RESET_DROP_PCT, type LlmSpendGuardDeps,
} from './llm-spend-guard.js';
import { defaultSpendPolicyDoc } from '../nexus/llm-spend-policy/schema.js';
import type { LlmSpendLedgerEntry, LlmSpendRowState } from '../nexus/llm-spend-policy/types.js';
import type { RotationCandidate } from './codex-account-rotation.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T0 = new Date('2026-11-20T03:00:00.000Z');
const LEASE = '2026-11-20T23:00:00.000Z';

interface World { now: Date; pct: Record<string, number>; resetAt: Record<string, string | undefined>; observedAt: Record<string, string | undefined>; today: number; month: number; }
function world(over: Partial<World> = {}): World {
  return { now: T0, pct: { 'codex-default': 10, 'codex-team': 10, 'codex-third': 10, 'claude-code-sub': 10, 'claude-acp': 10 }, resetAt: {}, observedAt: {}, today: 10, month: 100, ...over };
}
function states(w: World): LlmSpendRowState[] {
  const subs = Object.keys(w.pct).map((row): LlmSpendRowState => ({
    row, provider: 'x',
    window: { status: 'measured', usedPct: w.pct[row]!, ...(w.resetAt[row] ? { resetAt: w.resetAt[row] } : {}), observedAt: w.observedAt[row] ?? w.now.toISOString() },
    lease: { leaseId: `l-${row}`, expiresAt: LEASE },
  }));
  subs.push({
    row: 'openrouter', provider: 'openrouter',
    balance: { status: 'measured', usd: 50, totalCreditsUsd: 100, totalUsageUsd: 50, source: 't', observedAt: w.now.toISOString() },
    spend: { todayUsd: w.today, monthUsd: w.month, source: 't', observedAt: w.now.toISOString() },
    lease: { leaseId: 'l-or', expiresAt: LEASE },
  });
  return subs;
}
const ALL_FULL = { 'codex-default': 100, 'codex-team': 100, 'codex-third': 100, 'claude-code-sub': 100, 'claude-acp': 100 };

function harness(w: World, opts: { failLedger?: boolean } = {}) {
  const ledger: LlmSpendLedgerEntry[] = [];
  const memory = createInMemoryGuardStore();
  const deps: LlmSpendGuardDeps = {
    policy: defaultSpendPolicyDoc(), memory,
    readStates: () => states(w), now: () => w.now,
    appendLedger: (e) => { if (opts.failLedger) throw new Error('disk full'); ledger.push(e); },
  };
  const call = (role: 'judgement' | 'ta-child' | 'review' = 'judgement', model?: string) =>
    runLlmSpendGuard(deps, { role, execLocation: 'host', ...(model ? { model } : {}) });
  return { w, ledger, memory, deps, call };
}

describe('observeWindow — 창 리셋 실측(순수)', () => {
  test('직전 스냅샷 없으면 리셋을 추정하지 않는다', () => {
    const o = observeWindow(undefined, { status: 'measured', usedPct: 5, observedAt: T0.toISOString() }, T0);
    expect(o.reset).toBeNull();
  });
  test('리셋 시각이 지났고 값이 리셋 이전 관측이면 reset-elapsed(리셋 직후 0%)', () => {
    const prev = { usedPct: 99, resetAt: '2026-11-20T02:00:00Z', observedAt: '2026-11-20T01:00:00Z' };
    const o = observeWindow(prev, { status: 'measured', usedPct: 99, observedAt: '2026-11-20T01:30:00Z' }, T0);
    expect(o.reset).toBe('reset-elapsed');
    expect(o.window.status === 'measured' && o.window.usedPct).toBe(0);
  });
  test('리셋 시각이 지났어도 리셋 이후 새로 잰 값이 높으면 그 실측을 믿는다(리셋 아님)', () => {
    const prev = { usedPct: 99, resetAt: '2026-11-20T02:00:00Z', observedAt: '2026-11-20T01:00:00Z' };
    const o = observeWindow(prev, { status: 'measured', usedPct: 97, observedAt: '2026-11-20T02:30:00Z' }, T0);
    expect(o.reset).toBeNull();
    expect(o.window.status === 'measured' && o.window.usedPct).toBe(97);
  });
  test('사용률 하락 ≥ 임계 → usage-drop · 임계 미만 하락은 리셋 아님', () => {
    const prev = { usedPct: 96, observedAt: '2026-11-20T02:00:00Z' };
    expect(observeWindow(prev, { status: 'measured', usedPct: 96 - WINDOW_RESET_DROP_PCT, observedAt: T0.toISOString() }, T0).reset).toBe('usage-drop');
    expect(observeWindow(prev, { status: 'measured', usedPct: 96 - WINDOW_RESET_DROP_PCT + 1, observedAt: T0.toISOString() }, T0).reset).toBeNull();
  });
  test('리셋 시각이 뒤로 밀리고 사용률이 내려가면 reset-advanced', () => {
    const prev = { usedPct: 50, resetAt: '2026-11-20T05:00:00Z', observedAt: '2026-11-20T02:00:00Z' };
    const o = observeWindow(prev, { status: 'measured', usedPct: 40, resetAt: '2026-11-20T10:00:00Z', observedAt: T0.toISOString() }, T0);
    expect(o.reset).toBe('reset-advanced');
  });
  test('값이 없으면(unmeasured) 리셋 전에는 unmeasured 그대로 — 모름을 비었다로 접지 않는다', () => {
    const o = observeWindow({ usedPct: 50, resetAt: '2026-11-20T08:00:00Z', observedAt: '2026-11-20T02:00:00Z' }, { status: 'unmeasured', reason: 'x' }, T0);
    expect(o.window.status).toBe('unmeasured');
    expect(o.reset).toBeNull();
  });
});

describe('runLlmSpendGuard — 구독 바닥 → onExhausted', () => {
  test('첫 호출: 첫 구독 선택 · 원장 1줄(decision)', async () => {
    const h = harness(world());
    const r = await h.call();
    expect(r.decision.outcome === 'choice' && r.decision.row).toBe('codex-default');
    expect(h.ledger.length).toBe(1);
    expect(h.ledger[0]!.action).toBe('decision');
  });
  test('같은 행에 머무는 호출은 원장 줄이 늘지 않는다(stay)', async () => {
    const h = harness(world());
    await h.call(); await h.call(); await h.call();
    expect(h.ledger.length).toBe(1);
  });
  test('capPct 도달 → 다른 구독(team)으로 전환 · 원장 switch', async () => {
    const h = harness(world());
    await h.call();
    h.w.pct['codex-default'] = 96;
    const r = await h.call();
    expect(r.decision.outcome === 'choice' && r.decision.row).toBe('codex-team');
    expect(h.ledger.map((e) => e.action)).toEqual(['decision', 'switch']);
  });
  test('구독 전부 소진 → 크레딧(spendCap 아래 · models 일치) · switch 원장', async () => {
    const h = harness(world());
    await h.call();
    Object.assign(h.w.pct, ALL_FULL);
    const r = await h.call('judgement', 'openrouter/z-ai/glm-5.3');
    expect(r.decision.outcome === 'choice' && r.decision.row).toBe('openrouter');
    expect(h.ledger.at(-1)!.to).toBe('openrouter');
  });
  test('models 불일치면 크레딧을 쓰지 않고 멈춘다', async () => {
    const h = harness(world({ pct: ALL_FULL }));
    const r = await h.call('judgement', 'openrouter/other/model');
    expect(r.decision.outcome).toBe('stop');
    expect(r.decision.outcome === 'stop' && r.decision.skipped.some((s) => s.why.includes('model-mismatch'))).toBe(true);
  });
  test('spendCap(일 300) 초과 → 멈춤(fail-closed) · 원장 stop 1줄 · 반복 호출은 줄 0', async () => {
    const h = harness(world({ pct: ALL_FULL, today: 300 }));
    const a = await h.call(); const b = await h.call(); const c = await h.call();
    expect([a, b, c].every((r) => r.decision.outcome === 'stop')).toBe(true);
    expect(h.ledger.length).toBe(1);
    expect(h.ledger[0]!.what).toBe('stop');
    expect(h.ledger[0]!.reason).toContain('spend-cap-exceeded:today');
  });
  test('월 spendCap 은 정책에 없으면 일 상한만 · 월 지출이 커도 일 상한 아래면 통과(정책 값 그대로)', async () => {
    const h = harness(world({ pct: ALL_FULL, today: 299, month: 99999 }));
    expect((await h.call()).decision.outcome).toBe('choice');
  });
  test('ta-child(creditOk=false) 는 소진 때 크레딧 없이 멈춘다', async () => {
    const h = harness(world({ pct: ALL_FULL }));
    const r = await h.call('ta-child');
    expect(r.decision.outcome).toBe('stop');
  });
  test('크레딧 전환 원장 쓰기가 실패하면 fail-closed 멈춤(안 보이는 지출 0)', async () => {
    const h = harness(world({ pct: ALL_FULL }), { failLedger: true });
    const r = await h.call('judgement');
    expect(r.decision.outcome).toBe('stop');
    expect(r.decision.outcome === 'stop' && r.decision.reason).toContain('ledger-write-failed');
    expect(r.ledgerWritten).toBe(false);
  });
  test('리뷰 GLM 금지 — 크레딧 모델이 glm 이면 리뷰는 멈춘다(결정 함수 deny 그대로)', async () => {
    const h = harness(world({ pct: ALL_FULL }));
    const r = await h.call('review');
    expect(r.decision.outcome).toBe('stop');
  });
});

describe('runLlmSpendGuard — 창 리셋 실측 → 구독 우선 복귀', () => {
  async function onCredit() {
    const h = harness(world({ resetAt: { 'codex-default': '2026-11-20T05:00:00Z' }, pct: { ...ALL_FULL, 'codex-default': 97 } }));
    h.w.observedAt['codex-default'] = T0.toISOString();
    const r = await h.call();
    expect(r.decision.outcome === 'choice' && r.decision.row).toBe('openrouter');
    return h;
  }
  test('리셋 시각 경과 → 다음 호출부터 구독 복귀 · return 원장 1줄 + 관측 표기', async () => {
    const h = await onCredit();
    h.w.now = new Date('2026-11-20T05:10:00.000Z'); // 리셋 지남 · 신호는 낡은 값 그대로
    const r = await h.call();
    expect(r.decision.outcome === 'choice' && r.decision.row).toBe('codex-default');
    expect(r.resets['codex-default']).toBe('reset-elapsed');
    const last = h.ledger.at(-1)!;
    expect(last.action).toBe('return');
    expect(last.reason).toContain('reset-elapsed');
    expect(h.ledger.filter((e) => e.action === 'return').length).toBe(1);
  });
  test('사용률 하락 관측 → 복귀', async () => {
    const h = await onCredit();
    h.w.pct['codex-default'] = 5; h.w.observedAt['codex-default'] = undefined;
    const r = await h.call();
    expect(r.decision.outcome === 'choice' && r.decision.row).toBe('codex-default');
    expect(r.resets['codex-default']).toBe('usage-drop');
  });
  test('리셋 안 됐으면(리셋 시각 전·값 그대로) 크레딧에 머문다', async () => {
    const h = await onCredit();
    h.w.now = new Date('2026-11-20T04:00:00.000Z'); h.w.observedAt['codex-default'] = h.w.now.toISOString();
    const r = await h.call();
    expect(r.decision.outcome === 'choice' && r.decision.row).toBe('openrouter');
    expect(h.ledger.filter((e) => e.action === 'return').length).toBe(0);
  });
  test('플래핑 방지 — 복귀 직후 capPct 근처로 올라가도 한 번 떠나면 여유(10%p) 안쪽에서는 안 돌아온다', async () => {
    const h = await onCredit();
    h.w.pct['codex-default'] = 3; h.w.observedAt['codex-default'] = undefined;
    await h.call(); // 복귀
    h.w.pct['codex-default'] = 96; await h.call(); // 다시 소진 → 크레딧
    h.w.pct['codex-default'] = 93; await h.call(); // 94↓ 이지만 여유(85) 안쪽 → 머문다
    h.w.pct['codex-default'] = 92; const r = await h.call();
    expect(r.decision.outcome === 'choice' && r.decision.row).toBe('openrouter');
    expect(h.ledger.map((e) => e.action)).toEqual(['decision', 'return', 'switch']);
  });
  test('멈춤 → 해소(구독 회복)는 resume 원장 1줄', async () => {
    const h = harness(world({ pct: ALL_FULL, today: 300 }));
    await h.call();
    h.w.pct['codex-default'] = 1; h.w.observedAt['codex-default'] = undefined;
    const r = await h.call();
    expect(r.decision.outcome).toBe('choice');
    expect(h.ledger.length).toBe(2);
    expect(h.ledger[1]!.reason).toContain('resume-after-stop');
  });
});

describe('기억 · 매퍼', () => {
  test('파일 기억 — 원자 저장 후 다시 읽으면 같다 · 깨진 파일은 빈 기억', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-'));
    const path = join(dir, 'm.json');
    const store = createFileGuardStore(path);
    expect(store.load()).toEqual({ windows: {} });
    store.save({ currentRow: 'codex-team', windows: { 'codex-team': { usedPct: 3, observedAt: 'x' } } });
    expect(createFileGuardStore(path).load().currentRow).toBe('codex-team');
    expect(readFileSync(path, 'utf8')).not.toContain('token');
    require('node:fs').writeFileSync(path, '{broken');
    expect(createFileGuardStore(path).load()).toEqual({ windows: {} });
  });
  test('codex 후보 → 행 상태: reached=100 · 사용률 · 모름=unmeasured · 임대 없으면 미주입', () => {
    const base = { storeKey: 'k', home: '/h' };
    const cands: RotationCandidate[] = [
      { name: 'team', ...base, reached: true },
      { name: 'third', ...base, reached: undefined, usedPercent: 42 },
      { name: 'new', ...base, reached: undefined },
    ];
    const out = codexCandidatesToRowStates(cands, T0.toISOString(), { team: { leaseId: 'l', expiresAt: LEASE } });
    expect(out.map((s) => s.row)).toEqual(['codex-team', 'codex-third', 'codex-new']);
    expect(out[0]!.window).toMatchObject({ status: 'measured', usedPct: 100 });
    expect(out[1]!.window).toMatchObject({ status: 'measured', usedPct: 42 });
    expect(out[2]!.window?.status).toBe('unmeasured');
    expect(out[0]!.lease).toBeDefined();
    expect(out[1]!.lease).toBeUndefined();
  });
});
