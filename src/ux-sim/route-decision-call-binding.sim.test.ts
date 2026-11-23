// ROUTER-OR-CODEX-MIX-CHOKEPOINT(OP #132227) — 시뮬 장면: 구독 창 → 코어 decide → llm.usage 결속.
// 정본 요구: «라우팅 결정마다 decisionId 를 부여하고 같은 id 가 LLM 호출 원장(llm.usage) 줄까지 이어짐».
// terra r1 mustFix ④⑤(PR 39662 r2) — 실제 상담 클라이언트(streamLlmAdvisorClient → streamLLM)를 돌리고
// 외부 LLM 경계(PROVIDERS fake)만 모킹한다. r1 의 스텁 client.advise 는 logAgentTurnUsage 를 직접 불러
// 운영 호출 경로의 ID 전파가 끊겨도 통과했다. ⑤ 창 상태 2장면으로 창→결정→호출 결속을 관찰한다.
// 시계·네트워크·실LLM 0 — PROVIDERS fake 가 외부 경계 전부. 숫자 단언 출처는 각 주석(NUMGUARD).
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { PROVIDERS, type LLMProvider } from '../llm.js';
import { debug } from '../debug/log.js';
import { coreAdvisorForGoalLoop, streamLlmAdvisorClient } from '../core-turn/core-advisor-wiring.js';
import { setUserConfigOverlay } from '../user-config.js';
import { createCoreAdvisor } from '../model-tier/advisor-checkpoints.js';
import { DEFAULT_CORE_MODULES, createModelOrchestrationCore } from '../model-tier/model-orchestration.js';
import { workTierUsageFields } from '../model-tier/work-tier-policy.js';
import type { AccountState, CoreDecisionLedgerRecord, WorkSignals } from '../model-tier/orchestration-core.js';
import type { ModelTier } from '../model-tier/types.js';

const PROVIDER = 'openai-codex';
const FAKE_LADDER: Readonly<Record<ModelTier, { readonly model: string }>> = {
  budget: { model: 'fake-weak' }, balanced: { model: 'fake-balanced' }, better: { model: 'fake-mid' },
  best: { model: 'fake-strong' }, loaded: { model: 'fake-loaded' },
};
// L5(위험) 설계 일감 — ADVISOR 규칙이 계획 순간에 강 상담을 제안하는 조건(advisor-checkpoints: isRiskyLevel).
const RISKY_WORK: WorkSignals = { level: 'L5', bloom: 'create', riskCategories: ['persistence'], reasons: [] };
const READ_AT = 1_000_000; // 임의 고정 — 시계 없음(스냅숏 나이만 계산).

afterEach(() => setUserConfigOverlay(null));

function fakeLlmProvider(name: string, called: string[]): LLMProvider {
  return {
    name, defaultModel: 'fixture-model', available: () => true,
    async *chat() { called.push(`${name}:chat`); yield 'fixture advice'; },
    async *streamChat() { called.push(`${name}:stream`); yield { type: 'text', delta: 'fixture advice' }; },
  };
}

describe('route-decision-call-binding — 실제 호출 경로에서 decisionId 가 결정 원장에서 llm.usage 한 줄까지 이어진다', () => {
  test('실제 상담 클라이언트(외부 LLM 경계만 모킹) — 같은 decisionId 가 llm.usage 줄에 실린다 (terra r1 mustFix ④)', async () => {
    const oldCodex = PROVIDERS['openai-codex'];
    const called: string[] = [];
    PROVIDERS['openai-codex'] = fakeLlmProvider(PROVIDER, called);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const sinks = spyOn(debug, 'isAnySinkEnabled').mockReturnValue(true);
    const records: CoreDecisionLedgerRecord[] = [];
    try {
      // 무제한 등급 게이트 stub — 이 장면은 결속(decisionId 전파)을 본다(등급별 거부는 router-gate-wiring 스위트 담당).
      const core = createModelOrchestrationCore({ ...DEFAULT_CORE_MODULES, gate: { name: 'test-unrestricted', review: () => ({ allowed: true, reason: null }) }, ladder: () => FAKE_LADDER });
      // 구독 창 스냅숏 — Codex 구독 창이 남았고 fresh(router mix 계기).
      const accounts = () => ({
        candidates: [{ provider: PROVIDER, account: 'sub-team', billing: 'subscription' as const, window: { remaining: 1, resetsAtMs: READ_AT * 2 } }],
        active: { provider: PROVIDER, account: 'sub-team' },
        observedAtMs: READ_AT, readAtMs: READ_AT, selection: 'on' as const,
        routerMix: { codex: {
          candidates: [{ provider: PROVIDER, account: 'sub-team', billing: 'subscription' as const, window: { remaining: 1, resetsAtMs: READ_AT * 2 } }],
          active: { provider: PROVIDER, account: 'sub-team' }, observedAtMs: READ_AT, readAtMs: READ_AT, selection: 'on' as const,
        } },
      });
      const advisor = createCoreAdvisor({
        core, runId: 'run-realpath-r2', provider: PROVIDER, work: RISKY_WORK, mode: 'on', accounts,
        // 실제 제품 상담 클라이언트 — createCoreAdvisor → runWithWorkTierContext → streamLLM → llm.usage 까지 운영 경로.
        client: streamLlmAdvisorClient(),
        record: (record) => { records.push(record); },
        onceRegistry: new Set(),
      });
      const advice = await advisor.plan('objective fixture');
      expect(advice?.moment).toBe('plan'); // 상담이 실제로 일어났다(결속이 있어야 할 호출).

      // ① 결정 원장 줄에 decisionId 가 있다.
      expect(records).toHaveLength(1); // NUMGUARD: advisor.plan 은 런당 1회 상담(onceRegistry).
      const decisionId = records[0]!.decisionId;
      expect(typeof decisionId).toBe('string');
      expect(decisionId!.startsWith('run-realpath-r2#d')).toBe(true); // 형식 = `${runId}#d${seq}`

      // ② 실제 호출 경로가 외부 LLM 경계(fake transport)까지 갔다 — 스텁이 아니라 streamLLM 이 불렸다.
      expect(called).toContain(`${PROVIDER}:stream`);

      // ③ llm.usage 한 줄에 «같은» decisionId 가 실려 있다(운영 경로 전파 결속).
      const rows = log.mock.calls.filter(([category, event]) => category === 'llm.usage' && event === 'llm-usage');
      expect(rows).toHaveLength(1); // NUMGUARD: 상담 1회 = 사용량 줄 1개(streamLLM 완료 시 1줄).
      const usage = rows[0]![2] as Record<string, unknown>;
      expect(usage.routeDecisionId).toBe(decisionId);
      // ④ 결속 칸은 문맥(context) 결정에서만 — 등급·계기·출처 칸과 함께.
      expect(usage.workTier).toBe('strong');
      expect(usage.workTierTrigger).toBe('advisor:plan');
      expect(usage.workTierSource).toBe('context');
    } finally {
      sinks.mockRestore();
      log.mockRestore();
      if (oldCodex) PROVIDERS['openai-codex'] = oldCodex;
    }
  });

  test('창 상태 2장면 — 창이 코어 결정을 바꾸고 각 결정의 호출 원장에 같은 id 가 결속된다 (terra r1 mustFix ⑤)', async () => {
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'openrouter' },
      harness: { ...config.harness, difficultyRouter: 'on', routerMix: 'on' } }));
    // 회원 등급 심 — 실제 코어의 등급 게이트(smart-router-tiers)·창 인식 인가(router.subscription_window_aware)는
    // envMembershipResolver 로 process.env.ELANOUS_ROUTER_TIER 를 본다(consumer.ts — 제품 원천 그대로).
    // pro 로 두 장면 모두 상담 계기·창 인식을 허용해야 창→결정 영향이 관찰된다(free 면 r13 설계대로 계기·창 인식 자체가 건너뛴다).
    const oldTier = process.env.ELANOUS_ROUTER_TIER;
    process.env.ELANOUS_ROUTER_TIER = 'pro';
    const oldRouter = PROVIDERS.openrouter;
    const oldCodex = PROVIDERS['openai-codex'];
    const called: string[] = [];
    PROVIDERS.openrouter = fakeLlmProvider('openrouter', called);
    PROVIDERS['openai-codex'] = fakeLlmProvider('openai-codex', called);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const sinks = spyOn(debug, 'isAnySinkEnabled').mockReturnValue(true);
    const now = Date.now();
    // 창 상태만 바꾼 두 장면 — 계정·후보 구조는 동일, remaining 0.8(남음) vs 0(소진).
    const scene = (remaining: number): AccountState => ({
      active: { provider: 'openrouter', account: null }, candidates: [], selection: 'on',
      routerMix: { codex: {
        active: { provider: 'openai-codex', account: 'codex-a' }, selection: 'on', readAtMs: now, observedAtMs: now,
        candidates: [{ provider: 'openai-codex', account: 'codex-a', billing: 'subscription', window: { remaining } }],
      } },
    });
    try {
      const consult = async (runId: string, state: AccountState) => {
        const advisor = coreAdvisorForGoalLoop({ userText: '대상 경로: src/security/access.ts\n위험 등급: L5',
          env: { ELANOUS_RUN_ID: runId }, readAccounts: () => state });
        expect(advisor).toBeTruthy();
        await advisor!.plan('goal');
      };
      await consult('mixcp-window-a', scene(0.8)); // 장면 A: codex 구독 창 남음 → 구독 경유 결정
      await consult('mixcp-window-b', scene(0));   // 장면 B: 창 소진(remaining 0) → 창 셀렉터 거부

      // ① 창→결정: 두 장면의 코어 결정 provider 가 다르다(창 상태가 라우팅 결정에 영향을 준다).
      const decisions = log.mock.calls
        .filter(([category, event]) => category === 'harness.route-decision' && event === 'decision')
        .map(([, , data]) => data as { runId?: string; decisionId?: string; provider: string; reason: string[] });
      expect(decisions).toHaveLength(2); // NUMGUARD: 장면당 상담 1회(plan) — 결정 줄 2개.
      const [a, b] = decisions;
      // terra r2 mustFix ④ — 결속 단언이 공허하게 통과하지 않게 양 장면의 결정 id 는 비어 있지 않은 문자열이다.
      expect(typeof a!.decisionId).toBe('string');
      expect((a!.decisionId ?? '').length).toBeGreaterThan(0);
      expect(typeof b!.decisionId).toBe('string');
      expect((b!.decisionId ?? '').length).toBeGreaterThan(0);
      expect(a!.provider).toBe('openai-codex'); // 창 남음 → 구독 창 계정으로 상담
      expect(b!.provider).toBe('openrouter');   // 창 소진 → 라우터 유지(창 셀렉터 all-exhausted 거부)
      expect(a!.provider).not.toBe(b!.provider);
      // terra r2 mustFix ② — 창 상태가 결정에 관여한 흔적이 «결정 이유»에 남는다(창 로직이 무시되면 통과 불가).
      expect(b!.reason.join(' | ')).toMatch(/exhaust|window|창|denied/i); // 소진 장면: 창 거부 이유

      // ② 결정→호출: 각 장면의 호출(llm.usage) 줄에 «그 장면의» 결정 id 가 실린다.
      const rows = log.mock.calls.filter(([category, event]) => category === 'llm.usage' && event === 'llm-usage');
      expect(rows).toHaveLength(2); // NUMGUARD: 장면당 상담 1회 = 사용량 줄 1개.
      const bound = rows.map(([, , data]) => (data as Record<string, unknown>).routeDecisionId as string | undefined);
      // terra r2 mustFix ④ — 호출 줄 id 도 비어 있지 않은 문자열이어야 «같은 id» 단언이 결속을 증명한다.
      expect(typeof bound[0]).toBe('string');
      expect((bound[0] ?? '').length).toBeGreaterThan(0);
      expect(typeof bound[1]).toBe('string');
      expect((bound[1] ?? '').length).toBeGreaterThan(0);
      expect(bound[0]).toBe(a!.decisionId);
      expect(bound[1]).toBe(b!.decisionId);
      // 결정 문맥 칸 — model-lookup 아님: 두 호출 모두 결정을 거쳐갔다(창→결정→호출 종단).
      expect(rows.map(([, , data]) => (data as Record<string, unknown>).workTierSource)).toEqual(['context', 'context']);
      // 호출 경로도 장면을 따라간다(창 남음 → codex transport, 소진 → openrouter transport).
      expect(called).toContain('openai-codex:stream');
      expect(called).toContain('openrouter:stream');
    } finally {
      sinks.mockRestore();
      log.mockRestore();
      if (oldTier === undefined) delete process.env.ELANOUS_ROUTER_TIER; else process.env.ELANOUS_ROUTER_TIER = oldTier;
      if (oldRouter) PROVIDERS.openrouter = oldRouter;
      if (oldCodex) PROVIDERS['openai-codex'] = oldCodex;
    }
  });

  test('결정 없는 호출(model-lookup)은 routeDecisionId/decisionId 칸 없음 유지', () => {
    // 결정 문맥 밖의 호출 — 칸을 지어 내지 않는다(하위호환).
    const fields = workTierUsageFields(PROVIDER, 'gpt-6-luna');
    expect('decisionId' in fields || 'routeDecisionId' in fields).toBe(false);
    expect(fields).toEqual({ workTier: 'weak', workTierTrigger: 'base', workTierSource: 'model-lookup' });
  });
});
