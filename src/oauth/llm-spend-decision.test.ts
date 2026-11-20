// 결정 함수 시험 — fallbackOrder 걷기·capPct·spendCap·creditOk·deny 이중·hostOnly·임대·unmeasured·되돌아오기.
import { describe, expect, test } from 'bun:test';
import { decideLlmSpend, SPEND_OBSERVATION_FUTURE_SKEW_MS, SPEND_OBSERVATION_MAX_AGE_MS, type LlmSpendDecisionRequest } from './llm-spend-decision.js';
import { defaultSpendPolicyDoc, resolveSpendRolePolicy } from '../nexus/llm-spend-policy/schema.js';
import type { LlmSpendPolicyDoc, LlmSpendRowState, SubscriptionRowPolicy } from '../nexus/llm-spend-policy/types.js';

const NOW = new Date('2026-11-20T03:00:00.000Z');
const LEASE_FUTURE = '2026-11-20T04:00:00.000Z';
const LEASE_PAST = '2026-11-20T02:00:00.000Z';

function subState(row: string, usedPct: number): LlmSpendRowState {
  return {
    row, provider: 'openai-codex',
    window: { status: 'measured', usedPct, resetAt: '2026-11-20T08:00:00Z', observedAt: NOW.toISOString() },
    lease: { leaseId: `lease-${row}`, expiresAt: LEASE_FUTURE },
  };
}

function acpState(row: string, usedPct: number): LlmSpendRowState {
  return { ...subState(row, usedPct), provider: 'claude-acp', device: { status: 'measured', alive: true, sessions: 1, observedAt: NOW.toISOString() } };
}

function creditState(row: string, over: { balanceUsd?: number; todayUsd?: number; monthUsd?: number; leaseExpiresAt?: string } = {}): LlmSpendRowState {
  return {
    row, provider: 'openrouter',
    balance: { status: 'measured', usd: over.balanceUsd ?? 50, totalCreditsUsd: 100, totalUsageUsd: 50, source: 'openrouter/credits', observedAt: NOW.toISOString() },
    autoTopUp: { status: 'unmeasured', reason: 'not-provided' },
    spend: { todayUsd: over.todayUsd ?? 10, monthUsd: over.monthUsd ?? 100, source: 'spend-ledger', observedAt: NOW.toISOString() },
    lease: { leaseId: `lease-${row}`, expiresAt: over.leaseExpiresAt ?? LEASE_FUTURE },
  };
}

const HOST: LlmSpendDecisionRequest = { execLocation: 'host', now: NOW };

/** 기본 문서의 모든 행에 «건강한» 상태를 깔아 주는 시험 픽스처. */
function healthyStates(): LlmSpendRowState[] {
  return [
    subState('codex-default', 10), subState('codex-team', 20), subState('codex-third', 30),
    { ...subState('claude-code-sub', 10), provider: 'anthropic' },
    acpState('claude-acp', 10),
    creditState('openrouter'),
  ];
}

describe('decideLlmSpend — fallbackOrder 걷기', () => {
  test('구독 창이 남았으면 첫 구독 행을 고른다', () => {
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), healthyStates(), { ...HOST });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') {
      expect(decided.row).toBe('codex-default');
      expect(decided.ledger.action).toBe('decision');
      expect(decided.ledger.to).toBe('codex-default');
      expect(decided.ledger.from).toBeNull();
    }
  });
  test('capPct 를 넘으면 다음 구독으로 넘어간다', () => {
    const states = healthyStates().map((state): LlmSpendRowState => state.row === 'codex-default' ? subState('codex-default', 96) : state);
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') {
      expect(decided.row).toBe('codex-team');
      expect(decided.reason).toContain('fallbackOrder 걷기');
    }
  });
  test('현재 행이 소진됐으면 그 행의 onExhausted 순서를 걷는다', () => {
    const states = healthyStates().map((state): LlmSpendRowState => state.row === 'codex-default' ? subState('codex-default', 96) : state);
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST, currentRow: 'codex-default' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') expect(decided.row).toBe('codex-team'); // onExhausted[0]
  });
  test('onExhausted 의 stop 을 만나면 멈춤도 정책이다', () => {
    const policy: LlmSpendPolicyDoc = {
      ...defaultSpendPolicyDoc(),
      providers: { ...defaultSpendPolicyDoc().providers, 'codex-default': { ...(defaultSpendPolicyDoc().providers['codex-default'] as SubscriptionRowPolicy), onExhausted: ['stop'] } },
    };
    const states = healthyStates().map((state): LlmSpendRowState => state.row === 'codex-default' ? subState('codex-default', 96) : state);
    const decided = decideLlmSpend(policy, states, { ...HOST, currentRow: 'codex-default' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') expect(decided.reason).toContain('on-exhausted-stop');
  });
  test('이전 행이 여전히 건강하면 그대로 머문다(전환 최소화)', () => {
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), healthyStates(), { ...HOST, currentRow: 'codex-team' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') {
      expect(decided.row).toBe('codex-team');
      expect(decided.switched).toBe(false);
      expect(decided.reason).toContain('stay');
    }
  });
});

describe('decideLlmSpend — 크레딧 행(spendCap·models·creditOk)', () => {
  function subsExhausted(states: LlmSpendRowState[]): LlmSpendRowState[] {
    return states.map((state) => state.row === 'codex-default' || state.row === 'codex-team' || state.row === 'codex-third' || state.row === 'claude-code-sub' || state.row === 'claude-acp'
      ? { ...state, window: { status: 'measured', usedPct: 100, observedAt: NOW.toISOString() } }
      : state);
  }
  test('구독이 모두 소진되고 spendCap 안이면 크레딧 행을 고른다(judgement · creditOk)', () => {
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), subsExhausted(healthyStates()), { ...HOST, role: 'judgement' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') {
      expect(decided.row).toBe('openrouter');
      expect(decided.model).toBe('openrouter/z-ai/glm-5.3');
    }
  });
  test('spendCap 을 넘으면 멈춘다(fail-closed)', () => {
    const states = subsExhausted(healthyStates());
    const over = states.map((state) => state.row === 'openrouter' ? creditState('openrouter', { todayUsd: 301 }) : state);
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), over, { ...HOST, role: 'judgement' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') {
      expect(decided.reason).toContain('spend-cap-exceeded:today');
      expect(decided.skipped.some((s) => s.row === 'openrouter' && s.why.includes('spend-cap-exceeded:today'))).toBe(true);
    }
  });
  test('역할 creditOk=false 면 크레딧을 쓰지 않고 멈춘다(ta-child)', () => {
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), subsExhausted(healthyStates()), { ...HOST, role: 'ta-child' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') {
      expect(decided.skipped.some((s) => s.row === 'openrouter' && s.why.includes('role-credit-not-ok'))).toBe(true);
    }
  });
  test('역할 절에 없는 역할은 creditOk 빠짐 = false 로 크레딧을 못 쓴다(hand-seat)', () => {
    expect(resolveSpendRolePolicy(defaultSpendPolicyDoc(), 'hand-seat').creditOk).toBe(false);
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), subsExhausted(healthyStates()), { ...HOST, role: 'hand-seat' });
    expect(decided.outcome).toBe('stop');
  });
  test('spendCap 빠짐 = 그 공급자 크레딧 0(fail-closed)', () => {
    const policy: LlmSpendPolicyDoc = {
      ...defaultSpendPolicyDoc(),
      providers: { ...defaultSpendPolicyDoc().providers, openrouter: { kind: 'credit', provider: 'openrouter', models: ['openrouter/z-ai/glm-5.3'], spendCap: {} } },
    };
    const decided = decideLlmSpend(policy, subsExhausted(healthyStates()), { ...HOST, role: 'judgement' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') expect(decided.skipped.some((s) => s.why.includes('spend-cap-missing'))).toBe(true);
  });
  test('spendCap 0 = 크레딧 0(fail-closed)', () => {
    const policy: LlmSpendPolicyDoc = {
      ...defaultSpendPolicyDoc(),
      providers: { ...defaultSpendPolicyDoc().providers, openrouter: { kind: 'credit', provider: 'openrouter', models: ['openrouter/z-ai/glm-5.3'], spendCap: { dailyUsd: 0 } } },
    };
    const decided = decideLlmSpend(policy, subsExhausted(healthyStates()), { ...HOST, role: 'judgement' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') expect(decided.skipped.some((s) => s.why.includes('spend-cap-zero'))).toBe(true);
  });
  test('요청 모델이 models 일치해야 크레딧 행을 쓴다', () => {
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), subsExhausted(healthyStates()), { ...HOST, role: 'judgement', model: 'openrouter/z-ai/glm-5.3' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') expect(decided.model).toBe('openrouter/z-ai/glm-5.3');
    const mismatch = decideLlmSpend(defaultSpendPolicyDoc(), subsExhausted(healthyStates()), { ...HOST, role: 'judgement', model: 'openrouter/openai/gpt-9' });
    expect(mismatch.outcome).toBe('stop');
    if (mismatch.outcome === 'stop') expect(mismatch.skipped.some((s) => s.why.includes('model-mismatch'))).toBe(true);
  });
  test('잔액이 0이면 크레딧 행을 못 쓴다', () => {
    const states = subsExhausted(healthyStates()).map((state) => state.row === 'openrouter' ? creditState('openrouter', { balanceUsd: 0 }) : state);
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST, role: 'judgement' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') expect(decided.skipped.some((s) => s.why.includes('balance-empty'))).toBe(true);
  });
});

// spendCap 초과 — deny 절대 describe 위의 spendCap 시험에서 직접 호출한다(헬퍼 없음).

describe('decideLlmSpend — deny 절대(YAML + 코드 상수 이중)', () => {
  test('YAML 역할 deny 는 모든 행에서 절대 넘지 않는다(모델 기준)', () => {
    const policy: LlmSpendPolicyDoc = {
      ...defaultSpendPolicyDoc(),
      roles: { ...defaultSpendPolicyDoc().roles, review: { prefer: [], creditOk: true, deny: ['glm'] } },
    };
    const decided = decideLlmSpend(policy, healthyStates(), { ...HOST, role: 'review', model: 'openrouter/z-ai/glm-5.3' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') {
      // 구독 행이든 크레딧 행이든 — 요청 모델이 deny(glm) 면 전부 건너뛴다.
      expect(decided.skipped.some((s) => s.row === 'codex-default' && s.why.includes('deny:glm'))).toBe(true);
      expect(decided.skipped.some((s) => s.row === 'openrouter' && s.why.includes('deny:glm'))).toBe(true);
    }
  });
  test('코드 상수(리뷰 GLM 금지)는 YAML deny 가 비어 있어도 막는다', () => {
    const policy: LlmSpendPolicyDoc = {
      ...defaultSpendPolicyDoc(),
      roles: { ...defaultSpendPolicyDoc().roles, review: { prefer: [], creditOk: true, deny: [] } },
    };
    const decided = decideLlmSpend(policy, healthyStates(), { ...HOST, role: 'review', model: 'openrouter/z-ai/glm-5.3' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') {
      expect(decided.skipped.some((s) => s.row === 'codex-default' && s.why.includes('코드 상수'))).toBe(true);
      expect(decided.skipped.some((s) => s.row === 'openrouter' && s.why.includes('코드 상수'))).toBe(true);
    }
  });
  test('코드 상수는 그 역할(review)에만 적용된다 — 다른 역할은 같은 모델을 쓴다', () => {
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), healthyStates(), { ...HOST, role: 'authoring', model: 'openrouter/z-ai/glm-5.3' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') {
      expect(decided.row).toBe('codex-default');
      expect(decided.model).toBe('openrouter/z-ai/glm-5.3');
      expect(decided.skipped.some((s) => s.why.includes('코드 상수'))).toBe(false);
    }
  });
});

describe('decideLlmSpend — hostOnly(ACP) 장치', () => {
  test('Pod 실행이면 hostOnly 장치가 제외된다', () => {
    const states = healthyStates().map((state): LlmSpendRowState =>
      state.row === 'codex-default' || state.row === 'codex-team' || state.row === 'codex-third' || state.row === 'claude-code-sub'
        ? { ...state, window: { status: 'measured', usedPct: 100, observedAt: NOW.toISOString() } }
        : state);
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { execLocation: 'pod', now: NOW, role: 'judgement' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') expect(decided.row).toBe('openrouter'); // claude-acp 제외 → 크레딧
    const decidedHost = decideLlmSpend(defaultSpendPolicyDoc(), states, { execLocation: 'host', now: NOW, role: 'judgement' });
    expect(decidedHost.outcome).toBe('choice');
    if (decidedHost.outcome === 'choice') expect(decidedHost.row).toBe('claude-acp'); // 호스트면 장치 OK
  });
  test('제외 사유가 skipped 관측에 남는다(선택 결과에도 건너뛴 이유가 보인다)', () => {
    const states = healthyStates().map((state): LlmSpendRowState =>
      state.row !== 'claude-acp' && state.row !== 'openrouter'
        ? { ...state, window: { status: 'measured', usedPct: 100, observedAt: NOW.toISOString() } }
        : state);
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { execLocation: 'pod', now: NOW, role: 'judgement' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') {
      expect(decided.row).toBe('openrouter');
      expect(decided.skipped.some((s) => s.row === 'claude-acp' && s.why.includes('host-only-device'))).toBe(true);
    }
  });
});

describe('decideLlmSpend — 임대(id·TTL) fail-closed', () => {
  test('임대가 만료됐으면 그 행을 못 쓰고, 남는 행이 없으면 멈춘다', () => {
    const states = healthyStates().map((state): LlmSpendRowState => {
      if (state.row === 'openrouter') return creditState('openrouter', { leaseExpiresAt: LEASE_PAST });
      return { ...state, window: { status: 'measured', usedPct: 100, observedAt: NOW.toISOString() } };
    });
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST, role: 'judgement' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') {
      expect(decided.skipped.some((s) => s.row === 'openrouter' && s.why.includes('lease-expired'))).toBe(true);
      expect(decided.reason).toContain('no-candidate');
    }
  });
  test('임대가 없으면(새 임대 0) 그 행은 fail-closed 로 건너뛴다', () => {
    const states = healthyStates().map((state): LlmSpendRowState => {
      if (state.row === 'openrouter') {
        const { lease: _lease, ...rest } = state;
        return rest;
      }
      return { ...state, window: { status: 'measured', usedPct: 100, observedAt: NOW.toISOString() } };
    });
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST, role: 'judgement' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') expect(decided.skipped.some((s) => s.row === 'openrouter' && s.why.includes('no-lease'))).toBe(true);
  });
});

describe('decideLlmSpend — unmeasured 상태(«모른다»를 «비었다»로 접지 않는다)', () => {
  test('구독 창이 unmeasured 면 그 행을 못 쓴다(다음 행으로)', () => {
    const states = healthyStates().map((state): LlmSpendRowState => state.row === 'codex-default'
      ? { row: 'codex-default', provider: 'openai-codex', window: { status: 'unmeasured', reason: '신호 없음' }, lease: { leaseId: 'l', expiresAt: LEASE_FUTURE } }
      : state);
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') expect(decided.row).toBe('codex-team');
  });
  test('전부 unmeasured 면 멈춘다', () => {
    const states = healthyStates().map((state): LlmSpendRowState => ({ row: state.row, provider: state.provider, lease: { leaseId: 'l', expiresAt: LEASE_FUTURE } }));
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST, role: 'judgement' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') {
      expect(decided.skipped.some((s) => s.why.includes('window-unmeasured'))).toBe(true);
      expect(decided.skipped.some((s) => s.why.includes('spend-unmeasured'))).toBe(true);
    }
  });
  test('크레딧 잔액이 unmeasured 면 상한 검증 없이는 못 쓴다', () => {
    const states = healthyStates().map((state): LlmSpendRowState => {
      if (state.row === 'openrouter') {
        const { balance: _b, ...rest } = state;
        return { ...rest, balance: { status: 'unmeasured', reason: 'management key 없음' } };
      }
      return { ...state, window: { status: 'measured', usedPct: 100, observedAt: NOW.toISOString() } };
    });
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST, role: 'judgement' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') expect(decided.skipped.some((s) => s.why.includes('balance-unmeasured'))).toBe(true);
  });
});

describe('decideLlmSpend — returnOnReset(되돌아오기)', () => {
  test('크레딧을 쓰다가 구독 창이 리셋 실측으로 돌아오면 구독 우선으로 되돌아온다', () => {
    const states = healthyStates(); // codex-default 창 10% — 리셋 뒤
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST, currentRow: 'openrouter', role: 'judgement' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') {
      expect(decided.row).toBe('codex-default');
      expect(decided.ledger.action).toBe('return');
      expect(decided.reason).toContain('return-on-reset');
    }
  });
  test('returnOnReset=false 면 건강한 크레딧 행에 머문다', () => {
    const policy: LlmSpendPolicyDoc = { ...defaultSpendPolicyDoc(), returnOnReset: false };
    const decided = decideLlmSpend(policy, healthyStates(), { ...HOST, currentRow: 'openrouter', role: 'judgement' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') {
      expect(decided.row).toBe('openrouter');
      expect(decided.switched).toBe(false);
    }
  });
  test('구독이 아직 소진 상태면 되돌아오지 않고 크레딧에 머문다', () => {
    const states = healthyStates().map((state): LlmSpendRowState =>
      state.row === 'codex-default' || state.row === 'codex-team' || state.row === 'codex-third' || state.row === 'claude-code-sub' || state.row === 'claude-acp'
        ? { ...state, window: { status: 'measured', usedPct: 100, observedAt: NOW.toISOString() } }
        : state);
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST, currentRow: 'openrouter', role: 'judgement' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') {
      expect(decided.row).toBe('openrouter');
      expect(decided.ledger.action).not.toBe('return');
    }
  });
});

describe('decideLlmSpend — 원장 줄(결정·전환·되돌아오기 각 1줄)', () => {
  test('전환은 action=switch 로 이전→이후를 남긴다', () => {
    const states = healthyStates().map((state): LlmSpendRowState => state.row === 'codex-default' ? subState('codex-default', 96) : state);
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST, currentRow: 'codex-default', actor: 'seat:HAND' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') {
      expect(decided.ledger.action).toBe('switch');
      expect(decided.ledger.from).toBe('codex-default');
      expect(decided.ledger.to).toBe('codex-team');
      expect(decided.ledger.actor).toBe('seat:HAND');
      expect(decided.ledger.at).toBe(NOW.toISOString());
    }
  });
  test('멈춤도 원장 줄이 나온다(what=stop)', () => {
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), [], { ...HOST, actor: 'seat:HAND' });
    expect(decided.outcome).toBe('stop');
    if (decided.outcome === 'stop') {
      expect(decided.ledger.what).toBe('stop');
      expect(decided.ledger.to).toBeNull();
      expect(decided.ledger.actor).toBe('seat:HAND');
    }
  });
});

describe('decideLlmSpend — 역할 절 확장(difficulty · creditSpendCap)', () => {
  const withRole = (role: Record<string, unknown>): LlmSpendPolicyDoc => ({ ...defaultSpendPolicyDoc(), roles: { judgement: { prefer: ['p-model'], creditOk: true, deny: [], ...role } } } as LlmSpendPolicyDoc);
  const allSubsFull = () => healthyStates().map((s) => s.row === 'openrouter' ? s : { ...s, window: { status: 'measured', usedPct: 100, observedAt: NOW.toISOString() } } as LlmSpendRowState);
  test('난이도 목록이 있으면 prefer 대신 쓴다(소총 일에 탱크 금지)', () => {
    const doc = withRole({ difficulty: { low: ['small-m'], high: ['big-m'] } });
    const low = decideLlmSpend(doc, healthyStates(), { ...HOST, role: 'judgement', difficulty: 'low' });
    expect(low.outcome === 'choice' && low.model).toBe('small-m');
    const high = decideLlmSpend(doc, healthyStates(), { ...HOST, role: 'judgement', difficulty: 'high' });
    expect(high.outcome === 'choice' && high.model).toBe('big-m');
    const none = decideLlmSpend(doc, healthyStates(), { ...HOST, role: 'judgement' });
    expect(none.outcome === 'choice' && none.model).toBe('p-model'); // 난이도 미지정 = prefer
    const mid = decideLlmSpend(doc, healthyStates(), { ...HOST, role: 'judgement', difficulty: 'mid' });
    expect(mid.outcome === 'choice' && mid.model).toBe('p-model'); // mid 목록 없음 = prefer
  });
  test('난이도 목록에도 deny 는 절대(리뷰 GLM 금지가 난이도 경로에서도 산다)', () => {
    const doc = { ...defaultSpendPolicyDoc(), roles: { review: { prefer: [], creditOk: true, deny: [], difficulty: { low: ['openrouter/z-ai/glm-5.3'] } } } } as LlmSpendPolicyDoc;
    const d = decideLlmSpend(doc, allSubsFull(), { ...HOST, role: 'review', difficulty: 'low' });
    expect(d.outcome).toBe('stop');
  });
  test('creditSpendCap: 역할 몫을 넘으면 크레딧 불가(전역 상한 아래여도)', () => {
    const doc = withRole({ prefer: [], creditSpendCap: { dailyUsd: 20 }, deny: [] });
    const states = allSubsFull().map((s) => s.row === 'openrouter' ? { ...s, spend: { ...s.spend!, byRole: { judgement: { todayUsd: 25 } } } } : s);
    const d = decideLlmSpend(doc, states, { ...HOST, role: 'judgement', model: 'openrouter/z-ai/glm-5.3' });
    expect(d.outcome).toBe('stop');
    expect(d.skipped.some((s) => s.why.includes('role-spend-cap-exceeded'))).toBe(true);
  });
  test('creditSpendCap 있고 역할 몫 지출 실측이 없으면 fail-closed', () => {
    const doc = withRole({ prefer: [], creditSpendCap: { dailyUsd: 20 }, deny: [] });
    const d = decideLlmSpend(doc, allSubsFull(), { ...HOST, role: 'judgement', model: 'openrouter/z-ai/glm-5.3' });
    expect(d.outcome).toBe('stop');
    expect(d.skipped.some((s) => s.why.includes('role-spend-unmeasured'))).toBe(true);
  });
  test('creditSpendCap 아래면 통과', () => {
    const doc = withRole({ prefer: [], creditSpendCap: { dailyUsd: 20 }, deny: [] });
    const states = allSubsFull().map((s) => s.row === 'openrouter' ? { ...s, spend: { ...s.spend!, byRole: { judgement: { todayUsd: 5 } } } } : s);
    const d = decideLlmSpend(doc, states, { ...HOST, role: 'judgement', model: 'openrouter/z-ai/glm-5.3' });
    expect(d.outcome === 'choice' && d.row).toBe('openrouter');
  });
});

describe('decideLlmSpend — acp-device(헬스·동시 세션)', () => {
  const noSubs = (device: LlmSpendRowState['device']): LlmSpendRowState[] => healthyStates().map((s) =>
    s.row === 'claude-acp' ? { ...s, device } : s.row === 'openrouter' || s.row === 'claude-acp' ? s : { ...s, window: { status: 'measured', usedPct: 100, observedAt: NOW.toISOString() } } as LlmSpendRowState);
  test('헬스 실패면 다음 후보(크레딧)', () => {
    const d = decideLlmSpend(defaultSpendPolicyDoc(), noSubs({ status: 'measured', alive: false, sessions: 0, observedAt: NOW.toISOString() }), { ...HOST, role: 'judgement' });
    expect(d.outcome === 'choice' && d.row).toBe('openrouter');
    expect(d.skipped.some((s) => s.row === 'claude-acp' && s.why.includes('device-health-failed'))).toBe(true);
  });
  test('동시 세션 상한이 차면 다음 후보', () => {
    const d = decideLlmSpend(defaultSpendPolicyDoc(), noSubs({ status: 'measured', alive: true, sessions: 4, observedAt: NOW.toISOString() }), { ...HOST, role: 'judgement' });
    expect(d.outcome === 'choice' && d.row).toBe('openrouter');
    expect(d.skipped.some((s) => s.why.includes('device-sessions-full'))).toBe(true);
  });
  test('헬스 미실측이면 «모른다» = 못 쓴다', () => {
    const d = decideLlmSpend(defaultSpendPolicyDoc(), noSubs(undefined), { ...HOST, role: 'judgement' });
    expect(d.skipped.some((s) => s.why.includes('device-health-unmeasured'))).toBe(true);
  });
  test('세션 여유 + 헬스 OK 면 호스트에서 장치를 고른다', () => {
    const d = decideLlmSpend(defaultSpendPolicyDoc(), noSubs({ status: 'measured', alive: true, sessions: 3, observedAt: NOW.toISOString() }), { ...HOST, role: 'judgement' });
    expect(d.outcome === 'choice' && d.row).toBe('claude-acp');
  });
});

describe('decideLlmSpend — 소진 기울기 기반 역할 이동', () => {
  // codex-default: used 50% · cap 95 · 기울기 15%/h → 3h 에 도달 · 리셋 8h 뒤(03:00 + 8 = 11:00) → 도달이 리셋보다 이름
  const burning = (slope: number, resetIso = '2026-11-20T11:00:00Z'): LlmSpendRowState[] => healthyStates().map((s) => s.row === 'codex-default'
    ? { ...s, window: { status: 'measured', usedPct: 50, resetAt: resetIso, slopePctPerHour: slope, observedAt: NOW.toISOString() } } as LlmSpendRowState : s);
  test('도달 예상이 리셋보다 이르면 shiftOrder 앞 역할(ta-child)이 그 구독에서 빠진다', () => {
    const d = decideLlmSpend(defaultSpendPolicyDoc(), burning(15), { ...HOST, role: 'ta-child' });
    expect(d.outcome === 'choice' && d.row).toBe('codex-team');
    expect(d.skipped.some((s) => s.row === 'codex-default' && s.why.includes('burn-shift'))).toBe(true);
  });
  test('우선순위 높은 역할(review)은 그 구독에 남는다', () => {
    const d = decideLlmSpend(defaultSpendPolicyDoc(), burning(15), { ...HOST, role: 'review' });
    expect(d.outcome === 'choice' && d.row).toBe('codex-default');
  });
  test('기울기가 완만해 리셋 전 도달이 없으면 이동 0(원래 배합 복귀)', () => {
    const d = decideLlmSpend(defaultSpendPolicyDoc(), burning(1), { ...HOST, role: 'ta-child' });
    expect(d.outcome === 'choice' && d.row).toBe('codex-default');
  });
  test('기울기 미실측이면 이동 판정 보류(이동 0)', () => {
    const states = healthyStates();
    const d = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST, role: 'ta-child' });
    expect(d.outcome === 'choice' && d.row).toBe('codex-default');
  });
  test('더 급하면 shiftOrder 에서 더 많은 역할이 빠진다(hand-seat 도)', () => {
    // 도달 0.5h · 리셋 8h → ratio < 0.25 → 3개
    const states = healthyStates().map((s) => s.row === 'codex-default'
      ? { ...s, window: { status: 'measured', usedPct: 90, resetAt: '2026-11-20T11:00:00Z', slopePctPerHour: 10, observedAt: NOW.toISOString() } } as LlmSpendRowState : s);
    const d = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST, role: 'hand-seat' });
    expect(d.outcome === 'choice' && d.row).toBe('codex-team');
  });
  test('shiftOrder 를 YAML 로 바꾸면 이동 순서가 따라간다', () => {
    const doc = { ...defaultSpendPolicyDoc(), shiftOrder: ['review'] } as LlmSpendPolicyDoc;
    const d = decideLlmSpend(doc, burning(15), { ...HOST, role: 'review' });
    expect(d.outcome === 'choice' && d.row).toBe('codex-team');
  });
  test('리셋이 지난(시각 비어) 실측은 이동 판정 불가 — 이동 0', () => {
    const d = decideLlmSpend(defaultSpendPolicyDoc(), burning(15, '2026-11-20T02:00:00Z'), { ...HOST, role: 'ta-child' });
    expect(d.outcome === 'choice' && d.row).toBe('codex-default');
  });
});

describe('decideLlmSpend — 되돌아오기 히스테리시스(플래핑 방지)', () => {
  function onCredit(defaultPct: number): LlmSpendRowState[] {
    return healthyStates().map((state) => state.row === 'codex-default' ? subState('codex-default', defaultPct) : state);
  }
  const subsOthersFull = (states: LlmSpendRowState[]) => states.map((state) =>
    ['codex-team', 'codex-third', 'claude-code-sub', 'claude-acp'].includes(state.row)
      ? { ...state, window: { status: 'measured' as const, usedPct: 100, observedAt: NOW.toISOString() } } : state);

  test('capPct 바로 아래(94/95)에서는 크레딧에서 구독으로 돌아오지 않는다(여유 안쪽)', () => {
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), subsOthersFull(onCredit(94)), { ...HOST, role: 'judgement', currentRow: 'openrouter' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') { expect(decided.row).toBe('openrouter'); expect(decided.ledger.action).toBe('decision'); }
  });
  test('capPct − 여유(85) 이하로 내려오면 복귀한다(return 원장)', () => {
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), subsOthersFull(onCredit(85)), { ...HOST, role: 'judgement', currentRow: 'openrouter' });
    expect(decided.outcome).toBe('choice');
    if (decided.outcome === 'choice') { expect(decided.row).toBe('codex-default'); expect(decided.ledger.action).toBe('return'); }
  });
  test('여유 안쪽 구독이 앞서도 여유 통과한 구독으로 복귀한다(걷기 순서 무시 아님 — 통과한 첫 행)', () => {
    const states = subsOthersFull(onCredit(90)).map((state) => state.row === 'codex-team' ? subState('codex-team', 10) : state);
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), states, { ...HOST, role: 'judgement', currentRow: 'openrouter' });
    expect(decided.outcome === 'choice' && decided.row).toBe('codex-team');
  });
  test('returnHysteresisPct 덮어쓰기(0 이면 게이트만)', () => {
    const decided = decideLlmSpend(defaultSpendPolicyDoc(), subsOthersFull(onCredit(94)), { ...HOST, role: 'judgement', currentRow: 'openrouter', returnHysteresisPct: 0 });
    expect(decided.outcome === 'choice' && decided.row).toBe('codex-default');
  });
});

describe('decideLlmSpend — 지출 실측 fail-closed(#39172 JUD must①)', () => {
  const SRC = '출처: #39172 JUD(msg 109296 must①) 시험 픽스처';
  const capDoc = (roleCap?: { dailyUsd?: number; monthlyUsd?: number }): LlmSpendPolicyDoc => {
    const base = defaultSpendPolicyDoc();
    const or = base.providers.openrouter as { spendCap: object };
    return {
      ...base,
      providers: { ...base.providers, openrouter: { ...or, spendCap: { dailyUsd: 100, monthlyUsd: 1000 } } }, // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
      roles: { judgement: { prefer: [], creditOk: true, deny: [], ...(roleCap ? { creditSpendCap: roleCap } : {}) } },
    } as unknown as LlmSpendPolicyDoc;
  };
  const MODEL = 'openrouter/z-ai/glm-5.3';
  const subsFull = (): LlmSpendRowState[] => healthyStates().map((s) => s.row === 'openrouter' ? s : { ...s, window: { status: 'measured', usedPct: 100, observedAt: NOW.toISOString() } } as LlmSpendRowState);
  const withSpend = (spend: Record<string, unknown> | undefined): LlmSpendRowState[] =>
    subsFull().map((s) => {
      if (s.row !== 'openrouter') return s;
      const { spend: _drop, ...rest } = s;
      return (spend === undefined ? rest : { ...rest, spend: { source: 't', observedAt: NOW.toISOString(), ...spend } }) as LlmSpendRowState;
    });
  const run = (doc: LlmSpendPolicyDoc, states: LlmSpendRowState[], extra: Partial<LlmSpendDecisionRequest> = {}) =>
    decideLlmSpend(doc, states, { ...HOST, role: 'judgement', model: MODEL, ...extra });
  const why = (d: ReturnType<typeof run>) => d.skipped.map((s) => s.why).join('|');

  test('기준선 — 전부 실측·신선하면 통과', () => {
    const d = run(capDoc(), withSpend({ todayUsd: 10, monthUsd: 100 })); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(d.outcome === 'choice' && d.row).toBe('openrouter');
  });
  test('today 미측정(undefined) → spend-unmeasured 거부(0 으로 접지 않는다)', () => {
    const d = run(capDoc(), withSpend({ monthUsd: 100 })); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(d.outcome).toBe('stop');
    expect(why(d)).toContain('spend-unmeasured');
  });
  test('month 미측정 → spend-unmeasured 거부', () => {
    const d = run(capDoc(), withSpend({ todayUsd: 10 })); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(d.outcome).toBe('stop');
    expect(why(d)).toContain('month');
  });
  for (const [label, bad] of [['NaN', NaN], ['Infinity', Infinity], ['음수', -1]] as const) {
    test(`today=${label} → 거부`, () => {
      const d = run(capDoc(), withSpend({ todayUsd: bad, monthUsd: 100 })); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
      expect(d.outcome).toBe('stop');
      expect(why(d)).toContain('spend-unmeasured');
    });
  }
  test('month=NaN → 거부', () => {
    const d = run(capDoc(), withSpend({ todayUsd: 10, monthUsd: NaN })); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(d.outcome).toBe('stop');
  });
  test('spend 블록 자체가 없으면 거부', () => {
    expect(run(capDoc(), withSpend(undefined)).outcome).toBe('stop');
  });
  test('observedAt 없음/깨짐 → 거부', () => {
    const d = run(capDoc(), withSpend({ todayUsd: 10, monthUsd: 100, observedAt: undefined })); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(d.outcome).toBe('stop');
    expect(why(d)).toContain('spend-unmeasured');
    expect(run(capDoc(), withSpend({ todayUsd: 10, monthUsd: 100, observedAt: 'garbage' })).outcome).toBe('stop'); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
  });
  test('오래된 observedAt(창 밖) → spend-stale 거부 · 창 경계(정확히 창 길이)는 통과 · 1ms 초과는 거부', () => {
    const at = (ageMs: number) => new Date(NOW.getTime() - ageMs).toISOString();
    const ok = run(capDoc(), withSpend({ todayUsd: 10, monthUsd: 100, observedAt: at(SPEND_OBSERVATION_MAX_AGE_MS) })); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(ok.outcome).toBe('choice');
    const stale = run(capDoc(), withSpend({ todayUsd: 10, monthUsd: 100, observedAt: at(SPEND_OBSERVATION_MAX_AGE_MS + 1) })); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(stale.outcome).toBe('stop');
    expect(why(stale)).toContain('spend-stale');
  });
  test('spendMaxAgeMs 로 창을 좁힐 수 있다', () => {
    const d = run(capDoc(), withSpend({ todayUsd: 10, monthUsd: 100, observedAt: new Date(NOW.getTime() - 5000).toISOString() }), { spendMaxAgeMs: 1000 }); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(why(d)).toContain('spend-stale');
  });
  test('미래 observedAt(허용 오차 초과) → 거부 · 오차 안쪽은 통과', () => {
    const fut = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(run(capDoc(), withSpend({ todayUsd: 10, monthUsd: 100, observedAt: fut(SPEND_OBSERVATION_FUTURE_SKEW_MS + 1) })).outcome).toBe('stop'); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(run(capDoc(), withSpend({ todayUsd: 10, monthUsd: 100, observedAt: fut(SPEND_OBSERVATION_FUTURE_SKEW_MS) })).outcome).toBe('choice'); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
  });
  test('경계값 — 지출 = 상한 직전(99.99)은 통과 · 상한과 같으면(100) 거부', () => {
    expect(run(capDoc(), withSpend({ todayUsd: 99.99, monthUsd: 100 })).outcome).toBe('choice'); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(run(capDoc(), withSpend({ todayUsd: 100, monthUsd: 100 })).outcome).toBe('stop'); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(run(capDoc(), withSpend({ todayUsd: 10, monthUsd: 1000 })).outcome).toBe('stop'); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
  });
  test('경계값 — 추정액 포함: 실측+추정 = 상한이면 통과 · 초과면 거부 · NaN/음수 추정은 거부', () => {
    const states = withSpend({ todayUsd: 90, monthUsd: 100 }); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(run(capDoc(), states, { estimateUsd: 10 }).outcome).toBe('choice');
    expect(run(capDoc(), states, { estimateUsd: 10.01 }).outcome).toBe('stop');
    expect(run(capDoc(), states, { estimateUsd: NaN }).outcome).toBe('stop');
    expect(run(capDoc(), states, { estimateUsd: -1 }).outcome).toBe('stop');
  });
  test('역할 몫 — 상한 설정된 필드의 실측이 없거나 NaN 이면 거부(today·month 각각)', () => {
    const doc = capDoc({ dailyUsd: 20, monthlyUsd: 200 }); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    const sp = (mine: Record<string, number>) => withSpend({ todayUsd: 10, monthUsd: 100, byRole: { judgement: mine } }); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(run(doc, sp({ todayUsd: 5, monthUsd: 50 })).outcome).toBe('choice'); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    const noMonth = run(doc, sp({ todayUsd: 5 })); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(noMonth.outcome).toBe('stop');
    expect(why(noMonth)).toContain('role-spend-unmeasured');
    expect(run(doc, sp({ monthUsd: 50 })).outcome).toBe('stop'); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(run(doc, sp({ todayUsd: NaN, monthUsd: 50 })).outcome).toBe('stop'); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(run(doc, sp({ todayUsd: 20, monthUsd: 50 })).outcome).toBe('stop'); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
  });
  test('잔액이 NaN 이면 거부', () => {
    const states = withSpend({ todayUsd: 10, monthUsd: 100 }).map((s) => s.row === 'openrouter' ? { ...s, balance: { status: 'measured', usd: NaN, observedAt: NOW.toISOString() } } as LlmSpendRowState : s); // 출처: #39172 JUD(msg 109296 must①) 시험 픽스처
    expect(run(capDoc(), states).outcome).toBe('stop');
  });
  test(`(${SRC})`, () => { expect(SRC.length).toBeGreaterThan(0); });
});
