// 모델 오케스트레이션 코어 — 계약 시험. 가짜 사다리 · 가짜 ADVISOR 규칙 · 가짜 창 선택기를 «인터페이스로만» 끼운다.
// 숫자는 모듈 상수에서 유도한다(NUMGUARD) · 시계·네트워크·LLM 0.
import { describe, expect, test } from 'bun:test';
import { ACTIVE_ACCOUNT_SELECTOR, CORE_BASE_TIER, DEFAULT_CORE_MODULES, createModelOrchestrationCore } from './model-orchestration.js';
import { classifyWorkRisk } from './work-risk-router.js';
import { RED_ROUNDS_ESCALATE_AT, SAME_ERROR_ESCALATE_AT, STRONG_OUTPUT_MAX_TOKENS, WORK_TIER_LADDER_CELL } from './work-tier-policy.js';
import { ADVISOR_ESCALATE_RULE } from './advisor-checkpoints.js';
import type { AccountSelector, CoreDecisionInput, EscalateRule, ModelOrchestrationCore, WorkMoment } from './orchestration-core.js';
import type { ModelTier } from './types.js';

/** 대표 정정(20:1x)의 세 칸 — budget(약) · better(중) · best(강). 실제 id 가 아닌 가짜 이름. */
const FAKE_LADDER: Readonly<Record<ModelTier, { model: string }>> = {
  budget: { model: 'fake-weak' }, balanced: { model: 'fake-balanced' }, better: { model: 'fake-mid' },
  best: { model: 'fake-strong' }, loaded: { model: 'fake-loaded' },
};
const OTHER_LADDER: Readonly<Record<ModelTier, { model: string }>> = {
  budget: { model: 'other-weak' }, balanced: { model: 'other-balanced' }, better: { model: 'other-mid' },
  best: { model: 'other-strong' }, loaded: { model: 'other-loaded' },
};
const ladder = (provider: string) => (provider === 'fake' ? FAKE_LADDER : provider === 'other' ? OTHER_LADDER : undefined);

const PLAIN = classifyWorkRisk({ paths: ['src/tui/chat/status-line.ts'] });
const RISKY = classifyWorkRisk({ paths: ['src/self-implement/run-ledger.ts'] });

const input = (moment: WorkMoment, work = RISKY, extra: Partial<CoreDecisionInput> = {}): CoreDecisionInput =>
  ({ runId: 'run-hdr-core', moment, provider: 'fake', work, ...extra });

function core(modules: Parameters<typeof createModelOrchestrationCore>[0] = {}): ModelOrchestrationCore {
  return createModelOrchestrationCore({ ladder, ...modules });
}

describe('core contract — {tier, model, account, reason}', () => {
  test('base tier by risk × moment, resolved through the ladder cell only', () => {
    for (const work of [PLAIN, RISKY]) {
      for (const moment of ['design', 'judge', 'implement'] as const) {
        const decision = core().decide(input(moment, work));
        const expected = CORE_BASE_TIER[work === RISKY ? 'risky' : 'plain'][moment];
        expect(decision.tier).toBe(expected);
        expect(decision.cell).toBe(WORK_TIER_LADDER_CELL[expected]);
        expect(decision.model).toBe(FAKE_LADDER[WORK_TIER_LADDER_CELL[expected]].model);
        expect(decision.trigger).toBe('base');
        expect(decision.account).toBeNull();
        expect(decision.reason).toContain(`level:${work.level}`);
      }
    }
  });

  test('strong decisions carry the output cap; others do not', () => {
    expect(core().decide(input('design')).maxOutputTokens).toBe(STRONG_OUTPUT_MAX_TOKENS);
    expect(core().decide(input('implement')).maxOutputTokens).toBeUndefined();
  });

  test('a provider without a ladder yields model null, never an invented id', () => {
    const decision = core().decide({ ...input('implement'), provider: 'nope' });
    expect(decision.model).toBeNull();
    expect(decision.reason).toContain('no-tier-ladder');
  });

  test('built-in mix policy: each failure trigger moves exactly one step', () => {
    for (const failures of [{ sameErrorCount: SAME_ERROR_ESCALATE_AT }, { redRounds: RED_ROUNDS_ESCALATE_AT }, { riskyFirstDesign: true }]) {
      const fromWeak = core().decide(input('implement', PLAIN, { failures }));
      expect(fromWeak.tier).toBe('mid');
      const fromMid = core().decide(input('implement', RISKY, { failures }));
      expect(fromMid.tier).toBe('strong');
      // 다음 결정은 계기가 없으면 기준으로 — 내림은 상태 없이 일어난다.
      expect(core().decide(input('implement', PLAIN)).tier).toBe('weak');
    }
  });
});

describe('module slots — plugged in through the interface only', () => {
  test('fake ADVISOR rule runs before the mix policy and the first proposal wins', () => {
    const calls: string[] = [];
    const fakeAdvisor: EscalateRule = {
      name: 'fake-advisor',
      propose: ({ input: i, base }) => { calls.push(`${i.moment}:${base}`); return i.checkpoint ? { trigger: `advisor:${i.checkpoint}`, target: 'strong' } : null; },
    };
    const c = core({ escalate: [fakeAdvisor] });
    const consulted = c.decide(input('implement', PLAIN, { checkpoint: 'same-error', failures: { sameErrorCount: SAME_ERROR_ESCALATE_AT } }));
    expect(consulted).toMatchObject({ tier: 'strong', trigger: 'advisor:same-error', maxOutputTokens: STRONG_OUTPUT_MAX_TOKENS });
    const handsOn = c.decide(input('implement', PLAIN, { failures: { sameErrorCount: SAME_ERROR_ESCALATE_AT } }));
    expect(handsOn).toMatchObject({ tier: 'mid', trigger: 'same-error-twice' });
    expect(calls).toEqual(['implement:weak', 'implement:weak']);
  });

  test('a throwing rule is skipped and recorded, not fatal', () => {
    const broken: EscalateRule = { name: 'broken', propose: () => { throw new Error('boom'); } };
    const decision = core({ escalate: [broken] }).decide(input('implement', PLAIN));
    expect(decision.tier).toBe('weak');
    expect(decision.reason).toContain('rule-failed:broken');
  });

  test('fake window selector picks the account and its provider ladder', () => {
    const seen: string[] = [];
    const fakeWindow: AccountSelector = {
      name: 'fake-window',
      select: ({ input: i, tier, cell }) => {
        seen.push(`${tier}:${cell}`);
        const soonest = [...(i.accounts?.candidates ?? [])].sort((a, b) => (a.window?.resetsAtMs ?? Infinity) - (b.window?.resetsAtMs ?? Infinity))[0];
        return soonest ? { provider: soonest.provider, account: soonest.account, reason: 'resets-soonest' } : { provider: i.provider, account: null, reason: 'none' };
      },
    };
    const decision = core({ accounts: fakeWindow }).decide(input('implement', RISKY, {
      accounts: {
        active: { provider: 'fake', account: 'fake-a' },
        candidates: [
          { provider: 'fake', account: 'fake-a', billing: 'subscription', window: { remaining: 0.5, resetsAtMs: 2 } },
          { provider: 'other', account: 'other-b', billing: 'subscription', window: { remaining: 0.5, resetsAtMs: 1 } },
        ],
      },
    }));
    expect(decision).toMatchObject({ provider: 'other', account: 'other-b', model: OTHER_LADDER.better.model });
    expect(decision.reason).toContain('account:fake-window:resets-soonest');
    expect(seen).toEqual(['mid:better']);
  });

  test('default account selector keeps the active account', () => {
    const decision = core({ accounts: ACTIVE_ACCOUNT_SELECTOR }).decide(input('implement', PLAIN, {
      accounts: { active: { provider: 'fake', account: 'fake-a' }, candidates: [] },
    }));
    expect(decision).toMatchObject({ provider: 'fake', account: 'fake-a' });
  });

  test('the default modules carry the ADVISOR rule', () => {
    expect(DEFAULT_CORE_MODULES.escalate).toEqual([ADVISOR_ESCALATE_RULE]);
  });
});

describe('decision ledger record', () => {
  test('allowed fields only — no prompt text, no round', () => {
    const c = core();
    const i = input('implement', RISKY);
    const decision = c.decide(i);
    const prose = 'PROSE-MARKER-hdr';
    const record = c.decisionRecord({ ...decision, prompt: prose } as never, { ...i, userText: prose } as never,
      { mode: 'shadow', applied: false, skip: 'shadow', launched: { provider: 'fake', model: 'fake-current', text: prose } as never });
    expect(Object.keys(record).sort()).toEqual(['account', 'accountApplied', 'applied', 'appliedAccount', 'bloom', 'cell', 'kind', 'launched', 'level', 'mode',
      'model', 'moment', 'provider', 'reason', 'riskCategories', 'runId', 'skip', 'tier', 'trigger', 'unmeasured'].sort());
    expect(JSON.stringify(record)).not.toContain(prose);
    expect(record).not.toHaveProperty('round');
  });
});
