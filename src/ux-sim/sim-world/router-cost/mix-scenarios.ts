import { streamLLM, type LLMProvider } from '../../../llm.js';
import { createModelOrchestrationCore, DEFAULT_CORE_MODULES } from '../../../model-tier/model-orchestration.js';
import { createCoreAdvisor } from '../../../model-tier/advisor-checkpoints.js';
import { WINDOW_SNAPSHOT_TTL_MS } from '../../../model-tier/window-account-selector.js';
import { createSmartRouterTierGate } from '../../../plugins/smart-router/consumer.js';
import type { AccountState, CoreModules } from '../../../model-tier/orchestration-core.js';
import type { SimWorldScenario } from '../types.js';

const observed = WINDOW_SNAPSHOT_TTL_MS * 4;
const failure = (reason: string) => ({ ok: false as const, reason, diff: reason });
const work = { level: 'L5' as const, bloom: 'evaluate' as const, riskCategories: ['security' as const], reasons: [] };
const state = (remaining: number, stale = false): AccountState => ({
  active: { provider: 'openrouter', account: null }, candidates: [], selection: 'on',
  routerMix: { codex: { active: { provider: 'openai-codex', account: 'sub' }, selection: 'on',
    observedAtMs: stale ? observed - WINDOW_SNAPSHOT_TTL_MS - 1 : observed, readAtMs: observed,
    candidates: [{ provider: 'openai-codex', account: 'sub', billing: 'subscription', window: { remaining } }],
  } },
});

// jud-39528 mustFix ② 배선 이후 등급 게이트가 무등급(free)을 fail-closed 로 강등·거부한다(SMART-ROUTER-PLUGIN-TIERS).
// 이 시나리오가 검증하는 것은 자격 회원의 믹스 라우팅(싼 구현 + 구독 창 프리미엄 검문)이므로,
// 신뢰 호스트 seam(CoreModules.membership · 게이트 리졸버)으로 자격(pro) 회원 상태를 명시한다.
// 무등급 거부 경로는 router-gate-wiring.test.ts(free → strong_three_moments 거부)가 별도 검증.
const entitledResolver = { currentTier: () => 'pro' };
const entitledModules: CoreModules = {
  ...DEFAULT_CORE_MODULES,
  membership: () => 'pro',
  gate: createSmartRouterTierGate(entitledResolver),
};

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'ROUTER-OR-CODEX-MIX-CHOKEPOINT',
  title: 'cheap implementation, subscription-aware premium checkpoints and bounded provider failure',
  devices: ['ROUTER-COST-FAKE-PROVIDERS'],
  async run(ctx) {
    const fake = ctx.device<{ provider: (name: string, mode: 'measured' | 'unmeasured' | 'silent') => LLMProvider }>('ROUTER-COST-FAKE-PROVIDERS');
    const core = createModelOrchestrationCore(entitledModules);
    const input = { runId: 'mix-sim', provider: 'openrouter', work, accounts: state(0.8) };
    const implementation = core.decide({ ...input, moment: 'implement' });
    const [plan, judge] = await Promise.all([
      Promise.resolve(core.decide({ ...input, moment: 'design', checkpoint: 'plan' })),
      Promise.resolve(core.decide({ ...input, moment: 'judge', checkpoint: 'pre-complete' })),
    ]);
    ctx.recorder.event('router-mix:concurrent', { implement: implementation.provider, plan: plan.provider, judge: judge.provider });
    if (implementation.provider !== 'openrouter' || plan.provider !== 'openai-codex' || judge.provider !== 'openai-codex')
      return failure('mixed route mismatch');
    const afterRestart = createModelOrchestrationCore(entitledModules).decide({ ...input, moment: 'design', checkpoint: 'plan', accounts: state(0, true) });
    ctx.recorder.event('router-mix:restart-stale', { provider: afterRestart.provider });
    if (afterRestart.provider !== 'openrouter') return failure('stale subscription selected after restart');
    const readFailed = core.decide({ ...input, moment: 'design', checkpoint: 'plan',
      accounts: { ...state(0.8), routerMix: { codex: undefined, codexReadFailed: true } } });
    ctx.recorder.event('router-mix:window-read-failed', { provider: readFailed.provider, reason: readFailed.reason.at(-1) });
    if (!readFailed.reason.includes('account:router-or-codex-mix:codex-window-read-failed'))
      return failure('failed window read was consumed as absence');
    const calls: string[] = [];
    const advisor = createCoreAdvisor({ core, runId: 'mix-sim-advisor', provider: 'openrouter', work, mode: 'on',
      accounts: () => state(0.8), onceRegistry: new Set(),
      onError: (_moment, error) => ctx.recorder.event('router-mix:advisor-error', { name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : 'unknown' }),
      client: { async advise(request) {
        calls.push(request.provider);
        const answer = await streamLLM([{ role: 'user', content: 'sim' }], () => {},
          { provider: fake.provider(`router-mix-${request.provider}`, 'measured') });
        return { advice: answer };
      } },
    });
    if (!(await advisor.plan('goal')) || calls.join() !== 'openai-codex') return failure('premium checkpoint not consumed');
    ctx.recorder.event('router-mix:advisor-consumed', { provider: calls[0] });
    let timedOut = false;
    try { await streamLLM([{ role: 'user', content: 'sim' }], () => {}, { provider: fake.provider('router-mix-silent', 'silent'), streamFirstTokenTimeoutMs: 25, streamTotalTimeoutMs: 25 }); }
    catch { timedOut = true; }
    ctx.recorder.event('router-mix:provider-unresponsive', { timedOut });
    if (!timedOut) return failure('silent provider had no deadline');
    return { ok: true };
  },
}];
