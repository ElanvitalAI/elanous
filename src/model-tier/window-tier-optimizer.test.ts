// COST-OPTIMIZER-WINDOW-AWARE (ROSTER-0334 P2-11 · 주인 TC-H-CC-1 · 판정 JUD-3 · 증거 우주 시뮬) —
// 구독 창 리셋·남은 몫·크레딧 반영 등급 배정 시험.
//
// S: 창 인지 계정 선택기는 «같은 등급 안»에서만 창 상태를 본다(src/model-tier/window-account-selector.ts) —
//    등급(강/중/약)은 일감 신호 × 순간 × 올림으로만 배정되고(model-orchestration ①~③) 구독 창은 못 본다.
// C: 배정 등급 칸의 구독 창이 전부 소진(남은 몫 ≤ 예비 몫)이어도 등급은 그대로다 — 프리미엄 일감이
//    크레딧·선불·API 를 태우거나 막힌다. 아래 등급에 «안 쓰면 리셋에 사라지는» 창이 남아 있어도.
// Q: 등급을 구독 창 리셋·남은 몫·크레딧으로 어떻게 다시 배정하나?
// A: windowAwareTierAssignment(current, provider, accounts) —
//      ① 배정 칸에 «쓸 수 있는» 창(남은 몫 > 예비 몫 · 리셋이 버텨야 할 시각 전에 «확실히» 오면 예비 0)이 있으면 그대로.
//      ② 없으면 아래 등급(높은 것부터) 중 그런 창이 있는 곳으로 «한 번» 내린다(계정 선택기가 그 칸 안에서 창을 고른다).
//      ③ 어디에도 창이 없으면 크레딧 보유(credits.available)면 그대로(크레딧이 지출을 받는다) ·
//        아니면 최하 등급(약)으로(선불·API 의 실지출을 가장 싼 모델로).
//    스냅숏 없음 · 후보 없음 · 활성 계정 없음 · 사람 명시(explicit) · 낡은 스냅숏(TTL)은 등급을 못 고친다(그대로).
//    코어 decide() 통합은 창 인지 계정 전환과 같은 프로+ 게이트(router.subscription_window_aware · jud-39528 ②) 안.
// 출처: ROSTER-0334 P2-11 · #39423 스냅숷트 판 · seat-state/ELN-DOGFOOD/ASK-RIFLE-NOT-TANK-HARNESS-1117.md §소구점.
// NUMGUARD: 시뮬 우주(합성) — 상한은 MUST_LAST_RESERVE_SHARE/WINDOW_SNAPSHOT_TTL_MS 유도 · NOW 는 #39423 시험과 같은 축.

import { describe, expect, it } from 'bun:test';
import type { AccountCandidate, AccountState } from './orchestration-core.js';
import type { ModelTier } from './types.js';
import { createModelOrchestrationCore, DEFAULT_CORE_MODULES } from './model-orchestration.js';
import { MUST_LAST_RESERVE_SHARE, WINDOW_SNAPSHOT_TTL_MS } from './window-account-selector.js';
import { WORK_TIER_CLASSES } from './work-tier-policy.js';
import { windowAwareTierAssignment } from './window-tier-optimizer.js';

const PROVIDER = 'openai-codex';
// 출처: #39423 FIXTURE — 시뮬 우주 합성 기준 시각(ms) · 오피스토어 시험과 같은 축.
const NOW = 1_735_000_000_000;
/** 리셋 시각·버팀 시각 축 — 신호 나이 상한(1시간) 안의 합성 값들(유도). */
const RESET_SOON = NOW + WINDOW_SNAPSHOT_TTL_MS / 12;
const MUST_LAST = NOW + WINDOW_SNAPSHOT_TTL_MS / 2;

interface FixOptions {
  readonly window?: { readonly remaining: number; readonly resetsAtMs?: number };
  readonly mustLastUntilMs?: number;
  readonly credits?: { readonly available: boolean };
  readonly tiers?: readonly ModelTier[];
}

function fixCandidate(account: string, options: FixOptions = {}): AccountCandidate {
  return {
    provider: PROVIDER,
    account,
    billing: 'subscription',
    ...(options.window === undefined ? {} : { window: options.window }),
    ...(options.mustLastUntilMs === undefined ? {} : { mustLastUntilMs: options.mustLastUntilMs }),
    ...(options.credits === undefined ? {} : { credits: options.credits }),
    ...(options.tiers === undefined ? {} : { tiers: options.tiers }),
  };
}

function fixState(
  candidates: readonly AccountCandidate[],
  options: { readonly active?: string | null; readonly explicit?: boolean; readonly stale?: boolean } = {},
): AccountState {
  return {
    candidates,
    active: { provider: PROVIDER, account: options.active === undefined ? (candidates[0]?.account ?? null) : options.active },
    selection: 'on',
    readAtMs: NOW,
    ...(options.explicit === true ? { explicit: true } : {}),
    ...(options.stale === true ? { observedAtMs: NOW - WINDOW_SNAPSHOT_TTL_MS - 1 } : { observedAtMs: NOW }),
  };
}

describe('windowAwareTierAssignment — 등급 배정 창 반영 (COST-OPTIMIZER-WINDOW-AWARE P2-11)', () => {
  it('배정 칸에 쓸 수 있는 창이 있으면 등급을 못 고친다(그대로)', () => {
    // 강 칸 창: 예비 몫보다 크다 → 그대로.
    const usableBest = fixState([fixCandidate('sub-best', { window: { remaining: MUST_LAST_RESERVE_SHARE + 0.2 }, tiers: ['best'] })]);
    expect(windowAwareTierAssignment('strong', PROVIDER, usableBest)).toBe(null);
    // 경계 — 예비 몫을 «조금» 넘으면 쓸 수 있다(초과만).
    const justAbove = fixState([fixCandidate('sub-best', { window: { remaining: MUST_LAST_RESERVE_SHARE + 0.01 }, tiers: ['best'] })]);
    expect(windowAwareTierAssignment('strong', PROVIDER, justAbove)).toBe(null);
  });

  it('창 소진 → 쓸 수 있는 창이 있는 «가장 높은» 아래 등급으로 한 번 내린다', () => {
    // 강 소진 · 중 사용 가능 → 중.
    const state = fixState([
      fixCandidate('sub-best', { window: { remaining: MUST_LAST_RESERVE_SHARE / 2 }, tiers: ['best'] }),
      fixCandidate('sub-better', { window: { remaining: MUST_LAST_RESERVE_SHARE + 0.1 }, tiers: ['better'] }),
    ]);
    expect(windowAwareTierAssignment('strong', PROVIDER, state)).toEqual({
      from: 'strong',
      to: 'mid',
      reason: expect.stringContaining('window:step-down:strong->mid'),
    });
    // 강·중 소진 · 약 사용 가능 → 약(마른 중은 건너뛴다).
    const skipped = fixState([
      fixCandidate('sub-best', { window: { remaining: 0 }, tiers: ['best'] }),
      fixCandidate('sub-better', { window: { remaining: MUST_LAST_RESERVE_SHARE / 2 }, tiers: ['better'] }),
      fixCandidate('sub-budget', { window: { remaining: MUST_LAST_RESERVE_SHARE + 0.1 }, tiers: ['budget'] }),
    ]);
    expect(windowAwareTierAssignment('strong', PROVIDER, skipped)).toEqual({
      from: 'strong',
      to: 'weak',
      reason: expect.stringContaining('window:step-down:strong->weak'),
    });
  });

  it('남은 몫 경계 — 예비 몫 «이하» 는 못 쓴다 · 창 리셋이 버팀 전에 확실히 오면 통째로 쓴다', () => {
    // 예비 몫과 «같으면» 못 쓴다(초과만) → 아래 등급으로.
    const atReserve = fixState([
      fixCandidate('sub-best', { window: { remaining: MUST_LAST_RESERVE_SHARE }, tiers: ['best'] }),
      fixCandidate('sub-better', { window: { remaining: MUST_LAST_RESERVE_SHARE + 0.1 }, tiers: ['better'] }),
    ]);
    expect(windowAwareTierAssignment('strong', PROVIDER, atReserve)).toEqual({
      from: 'strong',
      to: 'mid',
      reason: expect.stringContaining('window:step-down'),
    });
    // 리셋이 버팀 시각 전에 온다 → 예비 0 → 조금 남아도 통째로 쓴다(쓰지 않으면 사라진다).
    const resetsBeforeMustLast = fixState([
      fixCandidate('sub-best', { window: { remaining: MUST_LAST_RESERVE_SHARE / 4, resetsAtMs: RESET_SOON }, mustLastUntilMs: MUST_LAST, tiers: ['best'] }),
    ]);
    expect(windowAwareTierAssignment('strong', PROVIDER, resetsBeforeMustLast)).toBe(null);
  });

  it('스냅숏 없음 · 후보 없음 · 활성 계정 없음 · 사람 명시 · 낡은 스냅숏(TTL)은 못 고친다', () => {
    expect(windowAwareTierAssignment('strong', PROVIDER, undefined)).toBe(null);
    expect(windowAwareTierAssignment('strong', PROVIDER, fixState([]))).toBe(null);
    expect(windowAwareTierAssignment('strong', PROVIDER, fixState([fixCandidate('sub-best', { window: { remaining: 0 } })], { active: null }))).toBe(null);
    // 사람이 계정을 명시했다 — 의도가 이긴다.
    const explicit = fixState([
      fixCandidate('sub-best', { window: { remaining: 0 } }),
      fixCandidate('sub-better', { window: { remaining: MUST_LAST_RESERVE_SHARE + 0.1 } }),
    ], { explicit: true });
    expect(windowAwareTierAssignment('strong', PROVIDER, explicit)).toBe(null);
    // 관측이 낡았다(나이 > 신호 상한) — 창을 지어내지 않는다.
    const stale = fixState([
      fixCandidate('sub-best', { window: { remaining: 0 } }),
      fixCandidate('sub-better', { window: { remaining: MUST_LAST_RESERVE_SHARE + 0.1 } }),
    ], { stale: true });
    expect(windowAwareTierAssignment('strong', PROVIDER, stale)).toBe(null);
  });

  it('크레딧 반영 — 창 어디에도 없으면: 보유(credits.available)면 그대로 · 아니면 최하(약)로', () => {
    const dry: readonly AccountCandidate[] = [
      fixCandidate('sub-best', { window: { remaining: 0 }, tiers: ['best'] }),
      fixCandidate('sub-better', { window: { remaining: MUST_LAST_RESERVE_SHARE / 2 }, tiers: ['better'] }),
      fixCandidate('sub-budget', { window: { remaining: MUST_LAST_RESERVE_SHARE / 2 }, tiers: ['budget'] }),
    ];
    // 크레딧 보유 → 그대로(크레딧이 지출을 받는다 — 회전 판정의 원천).
    expect(windowAwareTierAssignment('strong', PROVIDER, fixState([...dry, fixCandidate('credit-fund', { credits: { available: true } })]))).toBe(null);
    // 크레딧 «없음» 표시 → 최하(약)로(선불·API 실지출을 가장 싼 모델로).
    const noCredits = fixState([...dry, fixCandidate('credit-dry', { credits: { available: false } })]);
    expect(windowAwareTierAssignment('strong', PROVIDER, noCredits)).toEqual({
      from: 'strong',
      to: 'weak',
      reason: expect.stringContaining('window:dry:no-credits:strong->weak'),
    });
    // 이미 최하(약)면 더 내릴 곳이 없다.
    expect(windowAwareTierAssignment('weak', PROVIDER, noCredits)).toBe(null);
    // 다른 provider 의 크레딧은 이 배정의 원천이 아니다.
    const otherProvider: AccountCandidate = { ...fixCandidate('credit-other', { credits: { available: true } }), provider: 'openrouter' };
    expect(windowAwareTierAssignment('strong', PROVIDER, fixState([...dry, otherProvider]))).toEqual({
      from: 'strong',
      to: 'weak',
      reason: expect.stringContaining('window:dry:no-credits:strong->weak'),
    });
  });

  it('코어 decide() 시뮬 — 실 배정 경로: 강 창 소진 → 중 창으로 내리고 계정을 «전환»한다(프로+ 게이트 안)', () => {
    const previous = process.env.ELANOUS_ROUTER_TIER;
    process.env.ELANOUS_ROUTER_TIER = 'pro'; // jud-39528 ② — 창 반영(계정 전환·등급 배정)은 프로+.
    try {
      const core = createModelOrchestrationCore(DEFAULT_CORE_MODULES);
      // 시뮬 사건: 위험 설계 일감(강 배정) — 강 칸 창 소진 · 중 칸 창 사용 가능(더 늦은 리셋).
      const accounts = fixState([
        // 등급 칸(tiers)을 명시한다 — 생략은 «모름»이라 «모든 칸에 속함»으로 헤아려져(c.f. selector usable) 스텝다운 판정을 못 한다.
        fixCandidate('sub-best', { window: { remaining: MUST_LAST_RESERVE_SHARE / 2 }, tiers: ['best'] }),
        fixCandidate('sub-better', { window: { remaining: MUST_LAST_RESERVE_SHARE + 0.3, resetsAtMs: MUST_LAST }, tiers: ['better'] }),
      ]);
      const decision = core.decide({
        runId: 'p211-synth-1',
        moment: 'design',
        provider: PROVIDER,
        work: { level: 'L5', bloom: 'evaluate', riskCategories: ['security'], reasons: [] },
        accounts,
      });
      expect(decision.tier).toBe('mid');
      expect(decision.cell).toBe('better');
      expect(decision.account).toBe('sub-better');
      expect(decision.reason.some((line) => line.includes('window:step-down:strong->mid'))).toBe(true);
      // 프로+ 없이(free)는 등급 배정 반영도 없다 — 게이트 밖(jud-39528 ② seam 과 한 몸).
      process.env.ELANOUS_ROUTER_TIER = 'free';
      const freeDecision = core.decide({
        runId: 'p211-synth-2',
        moment: 'design',
        provider: PROVIDER,
        work: { level: 'L5', bloom: 'evaluate', riskCategories: ['security'], reasons: [] },
        accounts,
      });
      expect(freeDecision.tier).toBe('strong');
      expect(freeDecision.account).toBe('sub-best');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_ROUTER_TIER;
      else process.env.ELANOUS_ROUTER_TIER = previous;
    }
  });

  it('코어 decide() 시뮬 — 창 어디에도 없고 크레딧 보유 → 강 유지 · 크레딧도 없으면 최하(약) 배정', () => {
    const previous = process.env.ELANOUS_ROUTER_TIER;
    process.env.ELANOUS_ROUTER_TIER = 'pro';
    try {
      const core = createModelOrchestrationCore(DEFAULT_CORE_MODULES);
      const work = { level: 'L5', bloom: 'evaluate', riskCategories: ['security'], reasons: [] } as const;
      const dryAll: readonly AccountCandidate[] = [
        fixCandidate('sub-best', { window: { remaining: 0 }, credits: { available: true } }),
        fixCandidate('sub-better', { window: { remaining: MUST_LAST_RESERVE_SHARE / 2 } }),
      ];
      // 크레딧 보유 → 강 유지(크레딧이 받는다) · 계정은 활성 그대로(전환 없음 — all-exhausted 회전).
      const kept = core.decide({ runId: 'p211-synth-3', moment: 'design', provider: PROVIDER, work, accounts: fixState(dryAll) });
      expect(kept.tier).toBe('strong');
      // 크레딧 없음 → 최하(약).
      const noCredits = core.decide({
        runId: 'p211-synth-4',
        moment: 'design',
        provider: PROVIDER,
        work,
        accounts: fixState([
          fixCandidate('sub-best', { window: { remaining: 0 }, credits: { available: false } }),
          fixCandidate('sub-better', { window: { remaining: 0 } }),
        ]),
      });
      expect(noCredits.tier).toBe('weak');
      expect(noCredits.cell).toBe('budget');
      expect(noCredits.reason.some((line) => line.includes('window:dry:no-credits:strong->weak'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_ROUTER_TIER;
      else process.env.ELANOUS_ROUTER_TIER = previous;
    }
  });

  it('등급 축 회귀 — WORK_TIER_CLASSES 순서(약→중→강)를 바꾸지 않는다(배정 축 원문)', () => {
    expect([...WORK_TIER_CLASSES]).toEqual(['weak', 'mid', 'strong']);
  });
});