import { describe, expect, test } from 'bun:test';
import { createModelOrchestrationCore, DEFAULT_CORE_MODULES } from './model-orchestration.js';
import { createSmartRouterTierGate } from '../plugins/smart-router/consumer.js';
import { createCoreAdvisor } from './advisor-checkpoints.js';
import { WINDOW_SNAPSHOT_TTL_MS } from './window-account-selector.js';
import type { AccountState, CoreDecisionInput } from './orchestration-core.js';
import { readRouterMixSnapshot } from './account-window-snapshot.js';

const NOW = WINDOW_SNAPSHOT_TTL_MS * 4;
const work = { level: 'L5' as const, bloom: 'evaluate' as const, riskCategories: ['security' as const], reasons: [] };
const codex = (remaining: number): AccountState => ({
  active: { provider: 'openai-codex', account: 'codex-a' }, selection: 'on', observedAtMs: NOW, readAtMs: NOW,
  candidates: [{ provider: 'openai-codex', account: 'codex-a', billing: 'subscription', window: { remaining } }],
});
const mixed = (remaining: number, selection: 'on' | 'shadow' = 'on'): AccountState => ({
  active: { provider: 'openrouter', account: null }, candidates: [], selection, routerMix: { codex: codex(remaining) },
});
// 등급(jud-39528 mustFix ①②): 스위트 기본 코어는 pro — 게이트와 routerMix 좌석 모두 pro 회원.
const core = createModelOrchestrationCore({
  ...DEFAULT_CORE_MODULES, membership: () => 'pro', gate: createSmartRouterTierGate({ currentTier: () => 'pro' }),
});

describe('router mix at the real orchestration core', () => {
  test('only a strong checkpoint consumes fresh Codex subscription remaining', () => {
    const input: CoreDecisionInput = { runId: 'mix', moment: 'implement', provider: 'openrouter', work, accounts: mixed(0.7) };
    expect(core.decide(input)).toMatchObject({ tier: 'mid', provider: 'openrouter', account: null });
    expect(core.decide({ ...input, moment: 'design', checkpoint: 'plan' })).toMatchObject({ tier: 'strong', provider: 'openai-codex', account: 'codex-a' });
    expect(core.decide({ ...input, moment: 'judge', checkpoint: 'pre-complete' })).toMatchObject({ tier: 'strong', provider: 'openai-codex' });
    expect(core.decide({ ...input, moment: 'design', checkpoint: 'plan', accounts: mixed(0) })).toMatchObject({ tier: 'strong', provider: 'openrouter', account: null });
  });

  test('stale, failed, explicit and shadow observations do not silently switch', () => {
    const input: CoreDecisionInput = { runId: 'mix', moment: 'design', checkpoint: 'plan', provider: 'openrouter', work, accounts: mixed(0.8) };
    expect(core.decide({ ...input, accounts: { ...mixed(0.8), routerMix: { codex: undefined } } }).provider).toBe('openrouter');
    expect(core.decide({ ...input, accounts: { ...mixed(0.8), routerMix: { codex: { ...codex(0.8), observedAtMs: NOW - WINDOW_SNAPSHOT_TTL_MS - 1 } } } }).provider).toBe('openrouter');
    expect(core.decide({ ...input, accounts: { ...mixed(0.8), explicit: true } }).provider).toBe('openrouter');
    expect(core.decide({ ...input, accounts: mixed(0.8, 'shadow') }).provider).toBe('openrouter');
  });

  test('mustFix ② (jud-39528) free 등급은 routerMix 계정 전환이 거부 — 일반 라우팅(openrouter) 유지', () => {
    const freeCore = createModelOrchestrationCore({ ...DEFAULT_CORE_MODULES, membership: () => 'free' });
    const input: CoreDecisionInput = { runId: 'mix-free', moment: 'design', checkpoint: 'plan', provider: 'openrouter', work, accounts: mixed(0.8) };
    const d = freeCore.decide(input);
    expect(d.provider).toBe('openrouter');
    expect(d.account).toBeNull();
    expect(d.reason.some(r => r.startsWith('router-mix:denied'))).toBe(true);
    // 대조 — 같은 입력이 pro 멤버십에서는 Codex 구독 창으로 전환(기존 동작).
    expect(core.decide(input)).toMatchObject({ provider: 'openai-codex', account: 'codex-a' });
  });

  test('mustFix ② r13 (jud-39528 JUD-2 HOLD 8929e2809624) free 등급은 창 인식 선택기 자체를 건너뛴다 — 계정 전환 0', () => {
    const freeCore = createModelOrchestrationCore({ ...DEFAULT_CORE_MODULES, membership: () => 'free' });
    // 기존 회귀(mustFix ② 초회)는 기본 후보가 빈 fixture 라 구멍이 가려졌다 — 이번은 창 인식 가능한
    // 동일 공급자(openrouter) 후보가 있고 selection=on 이라 기본 창 인식 선택기가 전환할 수 있는 상태.
    const accounts: AccountState = {
      active: { provider: 'openrouter', account: 'router-a' }, selection: 'on', observedAtMs: NOW, readAtMs: NOW,
      candidates: [
        { provider: 'openrouter', account: 'router-a', billing: 'subscription', window: { remaining: 0.1 } },
        { provider: 'openrouter', account: 'router-b', billing: 'subscription', window: { remaining: 0.9 } },
      ],
    };
    const input: CoreDecisionInput = { runId: 'mix-free-window', moment: 'design', checkpoint: 'plan', provider: 'openrouter', work, accounts };
    const d = freeCore.decide(input);
    expect(d.provider).toBe('openrouter');
    // 활성 계정 고정 — 무료 등급 거부 시 창 인식 전환 0(루터-b 로 바뀌면 RED).
    expect(d.account).toBe('router-a');
    expect(d.reason.some(r => r.startsWith('window-aware:denied:router.subscription_window_aware'))).toBe(true);
    expect(d.reason.some(r => r.startsWith('account:active-account:'))).toBe(true);
    expect(d.reason.some(r => r.includes(':switched:'))).toBe(false);
    // 대조 — 같은 입력이 pro 멤버십에서는 창 인식 선택이 그대로 살아 router-b 로 전환(기존 동작 유지).
    expect(core.decide(input)).toMatchObject({ provider: 'openrouter', account: 'router-b' });
  });

  test('advisor never claims an alternate Codex account it cannot apply', () => {
    const base = mixed(0);
    const accounts: AccountState = { ...base, routerMix: { codex: {
      ...codex(0), candidates: [...codex(0).candidates,
        { provider: 'openai-codex', account: 'codex-b', billing: 'subscription', window: { remaining: 0.8 } }],
    } } };
    const decision = core.decide({ runId: 'alternate', moment: 'design', checkpoint: 'plan', provider: 'openrouter', work, accounts });
    expect(decision.provider).toBe('openrouter');
    expect(decision.account).toBeNull();
  });

  test('advisor consumes the decision and sends only checkpoint requests to Codex', async () => {
    const calls: string[] = [];
    const advisor = createCoreAdvisor({ core, runId: 'mix-advisor', provider: 'openrouter', work, mode: 'on',
      accounts: () => mixed(0.8), onceRegistry: new Set(),
      client: { advise: async request => { calls.push(request.provider); return { advice: 'ok' }; } }, });
    expect((await advisor.plan('goal'))?.text).toBe('ok');
    expect(calls).toEqual(['openai-codex']);
  });

  test('Codex snapshot I/O failure is explicit and blocks a premium call', async () => {
    const accounts = readRouterMixSnapshot('openrouter', {
      config: () => ({ harness: { routerMix: 'on' } }), inspectCodex: () => { throw new Error('fixture read failure'); }, emit: () => {},
    });
    expect(accounts?.routerMix?.codexReadFailed).toBe(true);
    const reasons = core.decide({ runId: 'fail', moment: 'design', checkpoint: 'plan', provider: 'openrouter', work, accounts }).reason;
    expect(reasons).toContain('account:router-or-codex-mix:codex-window-read-failed');
    const calls: string[] = [];
    const skips: (string | null)[] = [];
    const advisor = createCoreAdvisor({ core, runId: 'fail-advisor', provider: 'openrouter', work, mode: 'on',
      accounts: () => accounts, onceRegistry: new Set(),
      client: { advise: async request => { calls.push(request.provider); return { advice: 'wrong' }; } },
      record: row => { skips.push(row.skip); },
    });
    expect(await advisor.plan('goal')).toBeUndefined();
    expect(calls).toEqual([]);
    expect(skips).toEqual(['account-window-read-failed']);
  });
});
