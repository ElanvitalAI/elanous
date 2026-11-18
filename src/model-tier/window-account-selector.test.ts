// COST-OPTIMIZER-WINDOW-AWARE — 창 인지 계정 선택기 시험. 순수 선택 · 거절 이벤트 · shadow 무변화 · on 전환 · 원장/이벤트에 원 계정 이름 0.
// 숫자는 모듈 상수에서 유도한다(NUMGUARD) · 시계·네트워크·LLM 0.
import { describe, expect, test } from 'bun:test';
import {
  MUST_LAST_RESERVE_SHARE, WINDOW_ACCOUNT_EVENT, WINDOW_SNAPSHOT_TTL_MS, accountIdHash, createWindowAwareAccountSelector, pickWindowAccount, unmeasuredWindowSignals,
} from './window-account-selector.js';
import { ACTIVE_ACCOUNT_SELECTOR, DEFAULT_CORE_MODULES, createModelOrchestrationCore } from './model-orchestration.js';
import { classifyWorkRisk } from './work-risk-router.js';
import { WORK_TIER_LADDER_CELL } from './work-tier-policy.js';
import { QUOTA_SIGNAL_MAX_AGE_MS } from '../budget/codex-reset-credit-state.js';
import { DEFAULT_ROTATION_THRESHOLD_PERCENT } from '../oauth/codex-account-rotation.js';
import type { AccountCandidate, AccountState, CoreDecisionInput } from './orchestration-core.js';
import type { ModelTier } from './types.js';

const P = 'fake';
const FAKE_LADDER: Readonly<Record<ModelTier, { model: string }>> = {
  budget: { model: 'fake-weak' }, balanced: { model: 'fake-balanced' }, better: { model: 'fake-mid' },
  best: { model: 'fake-strong' }, loaded: { model: 'fake-loaded' },
};
const CELL = WORK_TIER_LADDER_CELL.weak;
const READ_AT = WINDOW_SNAPSHOT_TTL_MS * 4;
const HALF = 1 / 2;
const ABOVE_RESERVE = MUST_LAST_RESERVE_SHARE + (1 - MUST_LAST_RESERVE_SHARE) / 2;
const BELOW_RESERVE = MUST_LAST_RESERVE_SHARE / 2;
const SECRET_NAME = 'ACCOUNT-NAME-MARKER-team';

const sub = (account: string, remaining: number, resetsAtMs?: number, extra: Partial<AccountCandidate> = {}): AccountCandidate =>
  ({ provider: P, account, billing: 'subscription', window: { remaining, ...(resetsAtMs === undefined ? {} : { resetsAtMs }) }, ...extra });
const state = (candidates: AccountCandidate[], extra: Partial<AccountState> = {}): AccountState => ({
  candidates, active: { provider: P, account: 'active' }, observedAtMs: READ_AT, readAtMs: READ_AT, ...extra,
});
const picked = (s: AccountState | undefined) => {
  const pick = pickWindowAccount(s, P, CELL);
  return pick.status === 'picked' ? `${pick.candidate.account}:${pick.rule}` : `refused:${pick.reason}`;
};

describe('sourced constants', () => {
  test('TTL equals the quota-signal freshness bound; reserve is what rotation leaves behind', () => {
    expect(WINDOW_SNAPSHOT_TTL_MS).toBe(QUOTA_SIGNAL_MAX_AGE_MS);
    expect(MUST_LAST_RESERVE_SHARE).toBeCloseTo((100 - DEFAULT_ROTATION_THRESHOLD_PERCENT) / 100);
  });
});

describe('pickWindowAccount — pure rules', () => {
  test('the subscription window that resets soonest wins; unknown reset ranks after known resets', () => {
    expect(picked(state([sub('late', HALF, READ_AT * 3), sub('soon', HALF, READ_AT * 2), sub('unknown', 1)]))).toBe('soon:subscription-resets-soonest');
    expect(picked(state([sub('b', HALF), sub('a', 1)]))).toBe('a:subscription-remaining');
  });

  test('an exhausted window is skipped', () => {
    expect(picked(state([sub('empty', 0, READ_AT), sub('full', 1, READ_AT * 2)]))).toBe('full:subscription-resets-soonest');
  });

  test('the reserve is respected unless the window surely resets before it must last', () => {
    expect(picked(state([sub('low', BELOW_RESERVE, READ_AT), sub('ok', ABOVE_RESERVE, READ_AT * 2)]))).toBe('ok:subscription-resets-soonest');
    // 버틸 시각 전에 리셋이 오면 예비 몫은 버려질 몫이다 — 그 창을 먼저 쓴다.
    expect(picked(state([sub('low', BELOW_RESERVE, READ_AT, { mustLastUntilMs: READ_AT * 2 }), sub('ok', ABOVE_RESERVE, READ_AT * 2)])))
      .toBe('low:subscription-resets-soonest');
    // 버틸 시각이 리셋보다 앞이면(리셋 전에 버텨야 함) 예비 몫을 지킨다.
    expect(picked(state([sub('low', BELOW_RESERVE, READ_AT * 2, { mustLastUntilMs: READ_AT })]))).toBe('refused:all-exhausted');
  });

  test('prepaid comes before API; API is ordered by costRank (unknown rank last)', () => {
    const prepaid: AccountCandidate = { provider: P, account: 'pre', billing: 'prepaid' };
    const apiCheap: AccountCandidate = { provider: P, account: 'api-z', billing: 'api', costRank: 1 };
    const apiDear: AccountCandidate = { provider: P, account: 'api-a', billing: 'api', costRank: 2 };
    const apiUnknown: AccountCandidate = { provider: P, account: 'api-0', billing: 'api' };
    expect(picked(state([apiCheap, prepaid, sub('empty', 0)]))).toBe('pre:prepaid');
    expect(picked(state([apiUnknown, apiDear, apiCheap]))).toBe('api-z:api-cost-rank');
  });

  test('other providers, tiers outside the cell and unknown billing are not candidates', () => {
    expect(picked(state([{ ...sub('other', 1), provider: 'other' }]))).toBe('refused:no-candidates');
    expect(picked(state([sub('wrong-tier', 1, undefined, { tiers: [WORK_TIER_LADDER_CELL.strong] })]))).toBe('refused:no-candidates');
    expect(picked(state([{ provider: P, account: 'u', billing: 'unknown' }]))).toBe('refused:all-exhausted');
  });

  test('missing, stale, future, unattributed and explicit snapshots refuse', () => {
    expect(picked(undefined)).toBe('refused:no-snapshot');
    expect(picked(state([sub('a', 1)], { observedAtMs: undefined }))).toBe('refused:stale-snapshot');
    expect(picked(state([sub('a', 1)], { readAtMs: undefined }))).toBe('refused:stale-snapshot');
    expect(picked(state([sub('a', 1)], { observedAtMs: READ_AT - WINDOW_SNAPSHOT_TTL_MS - 1 }))).toBe('refused:stale-snapshot');
    expect(picked(state([sub('a', 1)], { observedAtMs: READ_AT - WINDOW_SNAPSHOT_TTL_MS }))).toBe('a:subscription-remaining');
    expect(picked(state([sub('a', 1)], { observedAtMs: READ_AT + 1 }))).toBe('refused:stale-snapshot');
    expect(picked(state([sub('a', 1)], { active: null }))).toBe('refused:no-active-account');
    expect(picked(state([sub('a', 1)], { active: { provider: P, account: null } }))).toBe('refused:no-active-account');
    expect(picked(state([sub('a', 1)], { explicit: true }))).toBe('refused:explicit-account');
    expect(picked(state([]))).toBe('refused:no-candidates');
  });
});

const WORK = classifyWorkRisk({ paths: ['src/tui/chat/status-line.ts'] });
const input = (accounts?: AccountState): CoreDecisionInput =>
  ({ runId: 'run-cow', moment: 'implement', provider: P, work: WORK, ...(accounts ? { accounts } : {}) });

function harness() {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const selector = createWindowAwareAccountSelector({ emit: (category, event, data) => { if (category === WINDOW_ACCOUNT_EVENT) events.push({ event, data }); } });
  const core = createModelOrchestrationCore({ ladder: (p) => (p === P ? FAKE_LADDER : undefined), accounts: selector });
  const baseline = createModelOrchestrationCore({ ladder: (p) => (p === P ? FAKE_LADDER : undefined), accounts: ACTIVE_ACCOUNT_SELECTOR });
  return { events, core, baseline };
}

const WINDOWS = [sub(SECRET_NAME, 1, READ_AT), sub('active', HALF, READ_AT * 2)];

describe('selector in the core', () => {
  test('every refusal keeps the active account and emits one event', () => {
    const cases: [AccountState | undefined, string][] = [
      [undefined, 'no-snapshot'],
      [state(WINDOWS, { observedAtMs: undefined }), 'stale-snapshot'],
      [state(WINDOWS, { active: null }), 'no-active-account'],
      [state(WINDOWS, { explicit: true }), 'explicit-account'],
      [state([]), 'no-candidates'],
      [state([sub('empty', 0)]), 'all-exhausted'],
    ];
    for (const [accounts, reason] of cases) {
      const h = harness();
      const decision = h.core.decide(input(accounts ? { ...accounts, selection: 'on' } : undefined));
      const expected = h.baseline.decide(input(accounts));
      expect({ provider: decision.provider, account: decision.account }).toEqual({ provider: expected.provider, account: expected.account });
      expect(h.events).toEqual([{ event: 'refused', data: expect.objectContaining({ reason, mode: accounts ? 'on' : 'shadow' }) }]);
      expect(decision.reason).toContain(`account:window-aware:refused:${reason}`);
    }
  });

  test('shadow (default) changes nothing but the reason line; chosen account appears only as kind and hash', () => {
    for (const selection of [undefined, 'shadow'] as const) {
      const h = harness();
      const accounts = state(WINDOWS, selection ? { selection } : {});
      const decision = h.core.decide(input(accounts));
      const expected = h.baseline.decide(input(accounts));
      expect({ ...decision, reason: [], unmeasured: undefined }).toEqual({ ...expected, reason: [], unmeasured: undefined });
      expect(decision.account).toBe('active');
      expect(decision.reason).toContain(`account:window-aware:shadow:subscription:${accountIdHash(P, SECRET_NAME)}:subscription-resets-soonest`);
      expect(h.events.map((e) => e.event)).toEqual(['shadow']);
    }
  });

  test('on switches to the chosen account inside the same provider', () => {
    const h = harness();
    const decision = h.core.decide(input(state(WINDOWS, { selection: 'on' })));
    expect(decision).toMatchObject({ provider: P, account: SECRET_NAME, model: FAKE_LADDER[CELL].model });
    expect(decision.reason).toContain(`account:window-aware:switched:subscription:${accountIdHash(P, SECRET_NAME)}:subscription-resets-soonest`);
    expect(h.events.map((e) => e.event)).toEqual(['picked']);
    const kept = harness().core.decide(input(state([sub('active', 1)], { selection: 'on' })));
    expect(kept.account).toBe('active');
    expect(kept.reason.some((r) => r.startsWith('account:window-aware:kept:'))).toBe(true);
  });

  test('ledger record and events carry no raw account names', () => {
    const h = harness();
    const i = input(state(WINDOWS, { selection: 'on' }));
    const decision = h.core.decide(i);
    const record = h.core.decisionRecord(decision, { ...i, runId: 'run-cow' },
      { mode: 'shadow', applied: false, skip: 'shadow', launched: { provider: P, model: null } });
    expect(record.account).toBe(accountIdHash(P, SECRET_NAME));
    expect(JSON.stringify(record)).not.toContain(SECRET_NAME);
    expect(JSON.stringify(h.events)).not.toContain(SECRET_NAME);
    expect(JSON.stringify(h.events)).not.toContain('"active"');
  });

  test('unmeasured lists only the signals no candidate of the provider carries', () => {
    expect(unmeasuredWindowSignals(undefined, P)).toEqual(['resetsAtMs', 'costRank', 'mustLastUntilMs']);
    expect(unmeasuredWindowSignals(state([sub('a', 1, READ_AT)]), P)).toEqual(['costRank', 'mustLastUntilMs']);
    expect(unmeasuredWindowSignals(state([sub('a', 1, READ_AT, { mustLastUntilMs: READ_AT, costRank: 1 })]), P)).toEqual([]);
    const decision = harness().core.decide(input(state([sub('a', 1, READ_AT)])));
    expect(decision.unmeasured).toEqual(['costRank', 'mustLastUntilMs']);
    expect(decision.reason).toContain('unmeasured:costRank+mustLastUntilMs');
  });

  test('the process default modules carry the window-aware selector', () => {
    expect(DEFAULT_CORE_MODULES.accounts?.name).toBe('window-aware');
  });
});
