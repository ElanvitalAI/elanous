import { describe, expect, it, test } from 'bun:test';
import {
  decideBudget,
  decideLaunchBudget,
  formatCodexReason,
  formatGrokReason,
  readBudgetInputs,
  type DecideBudgetInput,
  readLiveGrokUsedPercent, readBudgetInputsLive,
} from './budget-gate.js';
import { DEFAULT_BUDGET_GATE_MAX_USED_PERCENT } from '../user-config.js';
import type { UsageSnapshot } from '../budget/types.js';

const MAX = { ...DEFAULT_BUDGET_GATE_MAX_USED_PERCENT };

function input(patch: {
  codex: { name: string; usedPercent?: number; reached?: boolean }[];
  grok?: number;
  onShortfall?: DecideBudgetInput['preference']['budgetGate']['onShortfall'];
  max?: DecideBudgetInput['maxUsedPercent'];
  chain?: DecideBudgetInput['preference']['chain'];
}): DecideBudgetInput {
  return {
    preference: {
      chain: patch.chain ?? [{ provider: 'openai-codex' }, { provider: 'grok' }],
      budgetGate: { onShortfall: patch.onShortfall ?? 'next-provider' },
    },
    codexCandidates: patch.codex,
    grokUsedPercent: patch.grok,
    maxUsedPercent: patch.max ?? MAX,
  };
}

describe('decideBudget', () => {
  it('⑴ codex 한 계정 85% · grok 7% → proceed openai-codex', () => {
    const decision = decideBudget(input({
      codex: [{ name: 'default', usedPercent: 85 }],
      grok: 7,
    }));
    expect(decision.action).toBe('proceed');
    expect(decision.provider).toBe('openai-codex');
    expect(decision.reasons[0]).toBe('codex: default 85% < 95');
    expect(decision.reasons.join(' ')).not.toContain('grok:');
  });

  it('⑵ codex 셋 100·95·96% · grok 7% → next-provider grok', () => {
    const decision = decideBudget(input({
      codex: [
        { name: 'default', usedPercent: 100 },
        { name: 'team', usedPercent: 95 },
        { name: 'third', usedPercent: 96 },
      ],
      grok: 7,
    }));
    expect(decision.action).toBe('next-provider');
    expect(decision.provider).toBe('grok');
    expect(decision.reasons).toEqual([
      'codex: default 100%·team 95%·third 96% ≥ 95',
      'grok: 7% < 48',
    ]);
  });

  it('⑶ ⑵ ⊕ grok 49% · onShortfall next-provider → stop', () => {
    const decision = decideBudget(input({
      codex: [
        { name: 'default', usedPercent: 100 },
        { name: 'team', usedPercent: 95 },
        { name: 'third', usedPercent: 96 },
      ],
      grok: 49,
      onShortfall: 'next-provider',
    }));
    expect(decision.action).toBe('stop');
    expect(decision.provider).toBeUndefined();
    expect(decision.reasons[1]).toBe('grok: 49% ≥ 48');
  });

  it('⑷ ⑶ ⊕ onShortfall wait-reset → wait-reset', () => {
    const decision = decideBudget(input({
      codex: [
        { name: 'default', usedPercent: 100 },
        { name: 'team', usedPercent: 95 },
        { name: 'third', usedPercent: 96 },
      ],
      grok: 49,
      onShortfall: 'wait-reset',
    }));
    expect(decision.action).toBe('wait-reset');
    expect(decision.reasons).toContain('grok: 49% ≥ 48');
  });

  it('⑸ codex 셋 ≥95 · grok 사용량 모름 → stop 이고 reasons 에 «grok: 모름»', () => {
    const decision = decideBudget(input({
      codex: [
        { name: 'default', usedPercent: 100 },
        { name: 'team', usedPercent: 95 },
        { name: 'third', reached: true },
      ],
      onShortfall: 'next-provider',
    }));
    expect(decision.action).toBe('stop');
    expect(decision.reasons.some((line) => line.includes('grok: 모름'))).toBe(true);
    expect(formatGrokReason(undefined, 48)).toBe('grok: 모름');
  });

  it('기본 상한에서 grok 48 을 지우면 ⑶ 이 stop 이 아니다', () => {
    const withoutGrokCap: DecideBudgetInput['maxUsedPercent'] = {
      'openai-codex': MAX['openai-codex']!,
      grok: undefined as unknown as number,
    };
    const decision = decideBudget(input({
      codex: [
        { name: 'default', usedPercent: 100 },
        { name: 'team', usedPercent: 95 },
        { name: 'third', usedPercent: 96 },
      ],
      grok: 49,
      onShortfall: 'next-provider',
      max: withoutGrokCap,
    }));
    expect(decision.action).not.toBe('stop');
    expect(decision.action).toBe('next-provider');
    expect(decision.provider).toBe('grok');
  });

  it('한도 도달(reached) 계정은 usedPercent 가 상한 아래여도 못 쓴다', () => {
    const decision = decideBudget(input({
      codex: [{ name: 'default', usedPercent: 10, reached: true }],
      grok: 7,
    }));
    expect(decision.action).toBe('next-provider');
    expect(decision.provider).toBe('grok');
    expect(formatCodexReason([{ name: 'default', usedPercent: 10, reached: true }], 95)).toContain('≥ 95');
  });

  it('첫 칸 grok 이 쓸 수 있으면 proceed', () => {
    const decision = decideBudget(input({
      chain: [{ provider: 'grok', model: 'grok-4.6' }, { provider: 'openai-codex' }],
      codex: [{ name: 'default', usedPercent: 100 }],
      grok: 7,
    }));
    expect(decision.action).toBe('proceed');
    expect(decision.provider).toBe('grok');
    expect(decision.model).toBe('grok-4.6');
  });
});

describe('decideLaunchBudget only', () => {
  it('unmeasured candidates proceed at launch while decideBudget still stops', () => {
    const unknown = input({ codex: [{ name: 'default' }] });
    expect(decideBudget(unknown).action).toBe('stop');
    expect(decideLaunchBudget(unknown)).toEqual(expect.objectContaining({
      decision: expect.objectContaining({ action: 'proceed', provider: 'openai-codex' }),
      unmeasuredProvider: 'openai-codex',
    }));
    expect(decideLaunchBudget(input({ codex: [], chain: [{ provider: 'grok' }] })).unmeasuredProvider).toBe('grok');
  });

  it('reached and measured exhaustion do not become unmeasured', () => {
    const exhausted = input({ codex: [{ name: 'default', reached: true }], grok: 48 });
    expect(decideLaunchBudget(exhausted).decision.action).toBe('stop');
    expect(decideLaunchBudget(exhausted).unmeasuredProvider).toBeUndefined();
    const mixed = input({ codex: [{ name: 'default', reached: true }, { name: 'team' }], grok: 48 });
    expect(decideLaunchBudget(mixed).unmeasuredProvider).toBe('openai-codex');
  });
});

describe('readBudgetInputs', () => {
  it('기존 resolve·inspect·snapshot 을 불러 판정 입력을 조립한다', () => {
    const snapshot: UsageSnapshot = {
      provider: 'grok',
      windows: [{ kind: 'weekly', windowMinutes: 10080, limit: 100, used: 7, remainingPercent: 93, resetsAt: 0 }],
      fetchedAt: 1,
      source: 'oauth-api',
    };
    const inputs = readBudgetInputs({
      config: {
        tools: { selfImplement: { childLlm: { mode: 'auto', chain: [{ provider: 'openai-codex' }, { provider: 'grok' }] } } },
        llm: { provider: 'auto' },
        harness: { budgetGate: { minHeadroomPercent: 15, onShortfall: 'wait-reset', maxUsedPercent: { ...MAX } } },
      } as never,
      inspectCodex: () => ({
        candidates: [
          { name: 'default', storeKey: 'k', home: '/h', reached: undefined, usedPercent: 85 },
        ],
      }) as never,
      grokSnapshot: () => snapshot,
    });
    expect(inputs.preference.chain.map((entry) => entry.provider)).toEqual(['openai-codex', 'grok']);
    expect(inputs.preference.budgetGate.onShortfall).toBe('wait-reset');
    expect(inputs.codexCandidates).toEqual([{ name: 'default', usedPercent: 85 }]);
    expect(inputs.grokUsedPercent).toBe(7);
    expect(inputs.maxUsedPercent).toEqual(MAX);
    const decision = decideBudget(inputs);
    expect(decision.action).toBe('proceed');
    expect(decision.provider).toBe('openai-codex');
  });

  it('grok 스냅숏이 없으면 grokUsedPercent 는 모름', () => {
    const inputs = readBudgetInputs({
      config: {
        tools: { selfImplement: {} },
        llm: { provider: 'auto', fallbackChain: ['codex-rotate', 'grok'] },
      } as never,
      inspectCodex: () => ({ candidates: [] }) as never,
      grokSnapshot: () => undefined,
    });
    expect(inputs.grokUsedPercent).toBeUndefined();
    expect(inputs.maxUsedPercent['openai-codex']).toBe(95);
    expect(inputs.maxUsedPercent.grok).toBe(48);
  });
});

describe('live grok usage and empty chain (2026-09-27 실물)', () => {
  test('스냅숏이 «모름»이면 실제 조회 값으로 채운다 — 조회 행에서 grok 만 고른다', async () => {
    const used = await readLiveGrokUsedPercent(async () => ({
      rows: [
        { provider: 'codex', credits: { usedPercent: 99 } },
        { provider: 'grok', credits: { usedPercent: 7 } },
      ],
    }));
    expect(used).toBe(7);
  });

  test('조회가 실패하거나 값이 null 이면 «모름»(undefined)', async () => {
    expect(await readLiveGrokUsedPercent(async () => { throw new Error('offline'); })).toBeUndefined();
    expect(await readLiveGrokUsedPercent(async () => ({ rows: [{ provider: 'grok', credits: { usedPercent: null } }] }))).toBeUndefined();
  });

  test('readBudgetInputsLive — 스냅숏 «모름» ⊕ 실제 7% 면 grok 으로 next-provider', async () => {
    const inputs = await readBudgetInputsLive({
      config: { tools: { selfImplement: { childLlm: { mode: 'auto', chain: [{ provider: 'openai-codex' }, { provider: 'grok' }] } } }, llm: {} } as never,
      inspectCodex: (() => ({ candidates: [{ name: 'team', usedPercent: 95 }, { name: 'third', usedPercent: 99 }] })) as never,
      grokSnapshot: () => undefined,
      readLiveGrok: async () => 7,
    });
    expect(inputs.grokUsedPercent).toBe(7);
    const decision = decideBudget(inputs);
    expect(decision.action).toBe('next-provider');
    expect(decision.provider).toBe('grok');
  });

  test('체인이 비면 stop 이되 이유를 비워 두지 않는다', () => {
    const decision = decideBudget({
      preference: { mode: 'auto', chain: [], budgetGate: { minHeadroomPercent: 15, onShortfall: 'next-provider' }, source: { mode: 'inferred', chain: 'fallbackChain' } },
      codexCandidates: [],
      grokUsedPercent: undefined,
      maxUsedPercent: { 'openai-codex': 95, grok: 48 },
    } as never);
    expect(decision.action).toBe('stop');
    expect(decision.reasons.some((line) => line.startsWith('chain: 비었음'))).toBe(true);
  });
});


// BUDGET-GATE(10-05 00:0x) — 발사 관문이 «codex 구독 % ≥ 95» 만 보고 전 자리 발사를 막았다.
// 정책 credits ⊕ 잔액이 확인된 계정이 있으면 Pod 배분(planPodAccounts)과 같은 결론(codex 로 계속)이어야 한다.
describe('codex credits policy (BUDGET-GATE)', () => {
  const full = [
    { name: 'default', usedPercent: 97, creditBalance: 150_826, hasCredits: true },
    { name: 'team', usedPercent: 100 },
    { name: 'third', usedPercent: 100 },
  ];
  const credits = (codex: DecideBudgetInput['codexCandidates'], allowed: boolean): DecideBudgetInput => ({
    ...input({ codex: [], grok: 60, onShortfall: 'wait-reset' }),
    codexCandidates: codex,
    ...(allowed ? { codexCreditsAllowed: true } : {}),
  });

  test('정책 credits ⊕ 잔액>0 ⊕ 구독 97/100/100 → codex 로 proceed · 이유에 잔액', () => {
    const { decision } = decideLaunchBudget(credits(full, true));
    expect(decision.action).toBe('proceed');
    expect(decision.provider).toBe('openai-codex');
    expect(decision.reasons[0]).toContain('credits allowed (balance 150826)');
    expect(decideBudget(credits(full, true)).action).toBe('proceed');
  });

  test('정책 fallback(크레딧 불허) → 지금처럼 막힌다', () => {
    expect(decideLaunchBudget(credits(full, false)).decision.action).toBe('wait-reset');
  });

  test('잔액 0 · 잔액 모름 · hasCredits=false → 막힌다(크레딧은 돈 — fail-closed)', () => {
    for (const codex of [
      [{ name: 'default', usedPercent: 97, creditBalance: 0 }],
      [{ name: 'default', usedPercent: 97 }],
      [{ name: 'default', usedPercent: 97, creditBalance: 500, hasCredits: false }],
    ]) {
      expect(decideLaunchBudget(credits(codex, true)).decision.action).toBe('wait-reset');
    }
  });

  test('구독 잔량이 남은 계정이 있으면 크레딧 줄을 붙이지 않는다(회전이 먼저)', () => {
    const { decision } = decideLaunchBudget(credits([{ name: 'team', usedPercent: 40 }, ...full.slice(0, 1)], true));
    expect(decision.action).toBe('proceed');
    expect(decision.reasons[0]).not.toContain('credits allowed');
  });

  test('readBudgetInputs 가 회전 점검의 creditsAllowed·잔액을 운반한다', () => {
    const inputs = readBudgetInputs({
      config: { tools: { selfImplement: {} }, llm: { provider: 'auto', fallbackChain: ['codex-rotate'] } } as never,
      inspectCodex: () => ({
        policy: { policy: 'credits', source: 'config' },
        candidates: [{ name: 'default', storeKey: 'k', home: '/h', usedPercent: 97, creditBalance: 150_826, hasCredits: true }],
      }) as never,
      grokSnapshot: () => undefined,
    });
    expect(inputs.codexCreditsAllowed).toBe(true);
    expect(inputs.codexCandidates).toEqual([{ name: 'default', usedPercent: 97, creditBalance: 150_826, hasCredits: true }]);
    expect(decideLaunchBudget(inputs).decision.provider).toBe('openai-codex');
    const fallbackPolicy = readBudgetInputs({
      config: { tools: { selfImplement: {} }, llm: { provider: 'auto', fallbackChain: ['codex-rotate'] } } as never,
      inspectCodex: () => ({ policy: { policy: 'fallback', source: 'default' }, candidates: [] }) as never,
      grokSnapshot: () => undefined,
    });
    expect(fallbackPolicy.codexCreditsAllowed).toBeUndefined();
  });

  test('Pod 배분과 같은 결론 — 둘 다 «찬 계정을 크레딧으로»', async () => {
    const { planPodAccounts } = await import('../task-orchestrator/surfaces/pod-account-broker.js');
    const rotation = full.map((c) => ({ ...c, storeKey: c.name, home: `/h/${c.name}` }));
    const pod = planPodAccounts(rotation as never, { excludeAt: 95, creditsAllowed: true });
    expect(pod.creditAccounts?.[0]).toBe('default');
    expect(decideLaunchBudget(credits(full, true)).decision.provider).toBe('openai-codex');
    const podOff = planPodAccounts(rotation as never, { excludeAt: 95, creditsAllowed: false });
    expect(podOff.usable).toEqual([]);
    expect(decideLaunchBudget(credits(full, false)).decision.action).not.toBe('proceed');
  });
});
