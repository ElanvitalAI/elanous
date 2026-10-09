// fallback-chain.ts 계약 — 순수 판정이라 «전수»로 문다.
//
// ⛔ 이 스위트가 지키는 불변식 넷(codex-account-rotation.ts 에서 이어받은 것):
//   ① 사람이 명시했으면 안 바꾼다   ② 「모른다」로는 전환하지 않는다
//   ③ 결정론                        ④ 옵션을 «안 켜면» 종전과 동일

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_FALLBACK_CHAIN,
  decideFallback,
  describeFallback,
  isFallbackStep,
  normalizeFallbackChain,
  stayReasonWhenCodexAxisEnds,
  type FallbackStep,
  type RotationOutcome,
} from './fallback-chain.js';
import type { RotationCandidate } from './codex-account-rotation.js';
import { judgeClaudePtyMaturity } from './claude-pty-maturity.js';

const CAND: RotationCandidate = { name: 'work', storeKey: 'k', home: '/h/work', reached: undefined };
const CHAIN_BOTH: readonly FallbackStep[] = ['codex-rotate', 'grok'];

describe('normalizeFallbackChain — 「설정이 있다」와 「유효하다」는 다르다', () => {
  it('정상 배열을 그대로 받는다', () => {
    expect(normalizeFallbackChain(['codex-rotate', 'grok']))
      .toEqual({ chain: ['codex-rotate', 'grok'], dropped: [], usedDefault: false });
  });

  it('모르는 이름은 «버리되 조용히는 아니다» (오타 방어)', () => {
    const r = normalizeFallbackChain(['codex-rotate', 'gork', 'claude']);
    expect(r.chain).toEqual(['codex-rotate']);
    expect(r.dropped).toEqual(['gork', 'claude']);
  });

  it('중복은 접는다 (결정론)', () => {
    expect(normalizeFallbackChain(['grok', 'grok', 'codex-rotate']).chain).toEqual(['grok', 'codex-rotate']);
  });

  it('배열이 아니거나·비었거나·전부 무효면 기본 체인', () => {
    for (const bad of [undefined, null, 'grok', 42, {}, [], ['nope']]) {
      const r = normalizeFallbackChain(bad);
      expect(r.chain).toEqual(DEFAULT_FALLBACK_CHAIN);
      expect(r.usedDefault).toBe(true);
    }
  });

  it('⭐ 기본 체인에 grok 이 «들어 있다» — 설정을 안 쥔 우주가 죽지 않게 (대표 2026-08-20)', () => {
    // ⛔ 임시 격리 우주는 «빈» config 디렉토리를 받아 이 기본값으로 떨어진다.
    //    grok 이 없으면 codex `no-candidate` 에서 갈 곳이 없어 런이 죽었다.
    expect(DEFAULT_FALLBACK_CHAIN).toEqual(['codex-rotate', 'grok']);
  });

  it('⭐ 그래서 설정이 없는 우주도 codex 소진 시 grok 으로 넘어간다 (기본값이 무는 자리)', () => {
    const { chain } = normalizeFallbackChain(undefined);
    expect(decideFallback({ rotation: { reason: 'no-candidate' }, chain, grokAvailable: true }))
      .toEqual({ action: 'switch-backend', backend: 'grok' });
    expect(decideFallback({ rotation: { reason: 'no-candidate' }, chain, grokAvailable: false,
      claudePtyMaturity: { mature: true } }))
      .toEqual({ action: 'stay', why: 'grok-unavailable' });
  });

  it('isFallbackStep 은 아는 이름만 통과', () => {
    expect(isFallbackStep('grok')).toBe(true);
    expect(isFallbackStep('claude-pty')).toBe(true);
    expect(normalizeFallbackChain(['codex-rotate', 'grok', 'claude-pty']).chain)
      .toEqual(['codex-rotate', 'grok', 'claude-pty']);
    expect(isFallbackStep('codex-rotate')).toBe(true);
    expect(isFallbackStep('gpt')).toBe(false);
    expect(isFallbackStep(null)).toBe(false);
  });
});

describe('decideFallback — ① 사람 의도가 이긴다 · ② 「모른다」로 안 움직인다', () => {
  it('explicit 이면 체인을 «타지 않는다»', () => {
    expect(decideFallback({ rotation: { reason: 'explicit' }, chain: CHAIN_BOTH, grokAvailable: true }))
      .toEqual({ action: 'stay', why: 'explicit' });
  });

  it('not-reached(안 찼거나 «모른다»)면 안 움직인다 — grok 이 있어도', () => {
    expect(decideFallback({ rotation: { reason: 'not-reached' }, chain: CHAIN_BOTH, grokAvailable: true }))
      .toEqual({ action: 'stay', why: 'not-reached' });
  });
});

describe('decideFallback — codex 축', () => {
  it('rotated 면 codex 계정을 갈아탄다 (종전 동작)', () => {
    expect(decideFallback({ rotation: { reason: 'rotated', to: CAND }, chain: CHAIN_BOTH, grokAvailable: true }))
      .toEqual({ action: 'codex-rotate', to: CAND });
  });

  it('회전한 자격이 이번 런에서 한도 실패하면 회전 답보다 다음 체인 칸을 우선한다', () => {
    expect(decideFallback({
      rotation: { reason: 'rotated', to: CAND }, chain: CHAIN_BOTH, currentStep: 'codex-rotate',
      currentCredentialRateLimited: true, grokAvailable: true,
    })).toEqual({ action: 'switch-backend', backend: 'grok' });
  });

  it('한도 실패 재판정은 현재 칸 없이 체인을 처음부터 다시 선택하지 않는다', () => {
    // 타입 계약상 이 입력은 만들 수 없다. 런타임 방어도 체인 처음으로 되돌아가지 않는다.
    expect(decideFallback({
      rotation: { reason: 'rotated', to: CAND }, chain: CHAIN_BOTH,
      currentCredentialRateLimited: true, grokAvailable: true,
    } as never)).toEqual({ action: 'stay', why: 'chain-exhausted' });
  });

  it('한도 실패여도 다음 체인 칸이 없으면 현재 자리에 머문다', () => {
    expect(decideFallback({
      rotation: { reason: 'rotated', to: CAND }, chain: ['codex-rotate'], currentStep: 'codex-rotate',
      currentCredentialRateLimited: true, grokAvailable: true,
    })).toEqual({ action: 'stay', why: 'chain-exhausted' });
  });

  it('체인이 codex-rotate 를 «뺐으면» 회전 답이 있어도 다음 칸으로', () => {
    expect(decideFallback({ rotation: { reason: 'rotated', to: CAND }, chain: ['grok'], grokAvailable: true }))
      .toEqual({ action: 'switch-backend', backend: 'grok' });
  });

  it('no-candidate → 체인의 다음 칸(grok)으로 넘어간다 ⭐ 이것이 이 파일의 이유', () => {
    expect(decideFallback({ rotation: { reason: 'no-candidate' }, chain: CHAIN_BOTH, grokAvailable: true }))
      .toEqual({ action: 'switch-backend', backend: 'grok' });
  });

  it('⛔ no-candidate 인데 체인에 grok 이 없으면 «쓸 계정 없음»으로 머문다 — chain-exhausted 가 아니다', () => {
    expect(decideFallback({ rotation: { reason: 'no-candidate' }, chain: ['codex-rotate'], grokAvailable: true }))
      .toEqual({ action: 'stay', why: 'no-candidate' });
  });

  it('stayReasonWhenCodexAxisEnds — no-candidate 는 chain-exhausted 가 아니고 disabled 는 disabled', () => {
    expect(stayReasonWhenCodexAxisEnds('no-candidate')).not.toBe('chain-exhausted');
    expect(stayReasonWhenCodexAxisEnds('no-candidate')).toBe('no-candidate');
    expect(stayReasonWhenCodexAxisEnds('disabled')).toBe('disabled');
    expect(stayReasonWhenCodexAxisEnds('reset-credit-available')).toBe('chain-exhausted');
  });
});

describe('decideFallback — reset-credit-available (사람만 쓸 수 있는 권은 머무름 근거가 아니다)', () => {
  const resetCredit = { reason: 'reset-credit-available' } as const;
  const input = { rotation: resetCredit, chain: CHAIN_BOTH, grokAvailable: true };

  it('기본은 no-candidate 와 같이 체인의 다음 칸(grok)으로 간다', () => {
    expect(decideFallback(input)).toEqual({ action: 'switch-backend', backend: 'grok' });
    expect(decideFallback({ ...input, stayOnResetCreditAvailable: false }))
      .toEqual({ action: 'switch-backend', backend: 'grok' });
  });

  it('머무름 설정을 켜면 종전대로 stay — 같은 입력이 설정에 따라 갈라진다', () => {
    expect(decideFallback({ ...input, stayOnResetCreditAvailable: true }))
      .toEqual({ action: 'stay', why: 'reset-credit-available' });
  });

  it('not-reached 는 머무름 설정과 무관하게 그대로 머문다', () => {
    expect(decideFallback({
      rotation: { reason: 'not-reached' }, chain: CHAIN_BOTH, grokAvailable: true, stayOnResetCreditAvailable: true,
    })).toEqual({ action: 'stay', why: 'not-reached' });
    expect(decideFallback({
      rotation: { reason: 'not-reached' }, chain: CHAIN_BOTH, grokAvailable: true, stayOnResetCreditAvailable: false,
    })).toEqual({ action: 'stay', why: 'not-reached' });
  });
});

describe('decideFallback — disabled 의 의미 (회전을 껐다 ≠ grok 도 싫다)', () => {
  it('회전을 끄고 grok 만 쓰는 구성이 동작한다', () => {
    expect(decideFallback({ rotation: { reason: 'disabled' }, chain: ['grok'], grokAvailable: true }))
      .toEqual({ action: 'switch-backend', backend: 'grok' });
  });

  it('⛔ 체인에 grok 이 없으면 disabled 로 남는다 (무변경 보장)', () => {
    // ⛔ 여기서 «리터럴»을 쓰는 것이 의도다 — 이 시험이 재는 것은 「grok 이 없는 체인」이고,
    //    기본 체인은 2026-08-20 부터 grok 을 «담는다». 기본값을 참조하면 이 축이 죽는다.
    expect(decideFallback({ rotation: { reason: 'disabled' }, chain: ['codex-rotate'], grokAvailable: true }))
      .toEqual({ action: 'stay', why: 'disabled' });
  });
});

describe('decideFallback — grok 자격이 «없을» 때', () => {
  it('넘어가려다 자격이 없으면 그 사실을 값으로 남긴다', () => {
    expect(decideFallback({ rotation: { reason: 'no-candidate' }, chain: CHAIN_BOTH, grokAvailable: false }))
      .toEqual({ action: 'stay', why: 'grok-unavailable' });
  });

  it('⛔ 「갈 곳 없음」과 「grok 없음」을 «다른 값»으로 둔다', () => {
    const noStep = decideFallback({ rotation: { reason: 'no-candidate' }, chain: ['codex-rotate'], grokAvailable: false });
    const noCred = decideFallback({ rotation: { reason: 'no-candidate' }, chain: CHAIN_BOTH, grokAvailable: false });
    expect(noStep).not.toEqual(noCred);
  });
});

describe('claude-pty 성숙 관문과 명시 체인', () => {
  const chain = ['codex-rotate', 'grok', 'claude-pty'] as const;
  const sample = { runCount: 10, completedCount: 8, unknownScreenCount: 0, interventionCount: 1 };
  const input = { rotation: { reason: 'no-candidate' } as const, chain, grokAvailable: false };

  it('10런·8완주·unknown 0·개입 1이면 grok 자격 부재 뒤 claude 로 전환한다', () => {
    expect(judgeClaudePtyMaturity(sample)).toEqual({ mature: true });
    expect(decideFallback({ ...input, claudePtyMaturity: judgeClaudePtyMaturity(sample) }))
      .toEqual({ action: 'switch-backend', backend: 'claude' });
    expect(describeFallback({ action: 'switch-backend', backend: 'claude' })).toContain('claude');
  });

  it('10런·6완주는 미성숙으로 멈춘다', () => {
    const maturity = judgeClaudePtyMaturity({ ...sample, completedCount: 6 });
    expect(maturity).toEqual({ mature: false, why: 'completion-below-70' });
    const decision = decideFallback({ ...input, claudePtyMaturity: maturity });
    expect(decision).toEqual({ action: 'stay', why: 'claude-pty-immature' });
    expect(describeFallback(decision)).toContain('claude-pty-immature');
  });

  it('표본 없음·못 읽음이면 전환하지 않으며 미달과 다른 판정값을 준다', () => {
    expect(judgeClaudePtyMaturity(null)).toEqual({ mature: false, why: 'sample-unreadable' });
    expect(judgeClaudePtyMaturity({ ...sample, completedCount: Number.NaN }))
      .toEqual({ mature: false, why: 'sample-unreadable' });
    expect(judgeClaudePtyMaturity({ ...sample, completedCount: 11 }))
      .toEqual({ mature: false, why: 'sample-unreadable' });
    expect(decideFallback(input)).toEqual({ action: 'stay', why: 'claude-pty-immature' });
    expect(decideFallback({ ...input, claudePtyMaturity: judgeClaudePtyMaturity(null) }))
      .toEqual({ action: 'stay', why: 'claude-pty-immature' });
  });

  it('표본·완주·화면 unknown·개입 관문은 등호에서 통과하고 바깥에서 각각 거부한다', () => {
    expect(judgeClaudePtyMaturity({ ...sample, runCount: 9 })).toEqual({ mature: false, why: 'too-few-samples' });
    expect(judgeClaudePtyMaturity({ ...sample, completedCount: 7, unknownScreenCount: 1, interventionCount: 2 }))
      .toEqual({ mature: true });
    expect(judgeClaudePtyMaturity({ ...sample, unknownScreenCount: 2 }))
      .toEqual({ mature: false, why: 'unknown-screen-above-10' });
    expect(judgeClaudePtyMaturity({ ...sample, interventionCount: 3 }))
      .toEqual({ mature: false, why: 'intervention-above-0.2' });
  });

  it('claude-pty 가 앞 칸이어도 미성숙이면 뒤의 grok 으로 간다', () => {
    expect(decideFallback({ rotation: { reason: 'no-candidate' }, chain: ['codex-rotate', 'claude-pty', 'grok'], grokAvailable: true }))
      .toEqual({ action: 'switch-backend', backend: 'grok' });
  });

  it('grok 자격이 있으면 기존 grok 우선이고 한도 실패의 다음 칸은 claude', () => {
    const maturity = judgeClaudePtyMaturity(sample);
    expect(decideFallback({ ...input, grokAvailable: true, claudePtyMaturity: maturity }))
      .toEqual({ action: 'switch-backend', backend: 'grok' });
    expect(decideFallback({ ...input, grokQuota: 'exhausted', grokAvailable: true, claudePtyMaturity: maturity }))
      .toEqual({ action: 'switch-backend', backend: 'claude' });
    expect(decideFallback({ ...input, currentStep: 'grok', currentCredentialRateLimited: true, claudePtyMaturity: maturity }))
      .toEqual({ action: 'switch-backend', backend: 'claude' });
  });
});

describe('③ 결정론 — 같은 입력이면 같은 답', () => {
  it('20회 반복해도 동일', () => {
    const input = { rotation: { reason: 'no-candidate' } as RotationOutcome, chain: CHAIN_BOTH, grokAvailable: true };
    const first = decideFallback(input);
    for (let i = 0; i < 20; i += 1) expect(decideFallback(input)).toEqual(first);
  });
});

describe('describeFallback — 관측 한 줄 (⛔ 토큰·홈 경로를 안 넣는다)', () => {
  it('세 갈래를 사람 말로 낸다', () => {
    expect(describeFallback({ action: 'codex-rotate', to: CAND })).toContain('work');
    expect(describeFallback({ action: 'switch-backend', backend: 'grok' })).toContain('grok');
    expect(describeFallback({ action: 'stay', why: 'explicit' })).toContain('explicit');
  });

  it('계정 «홈 경로»는 새지 않는다', () => {
    expect(describeFallback({ action: 'codex-rotate', to: CAND })).not.toContain('/h/work');
  });
});

// ── grok «잔량» 축 (B · 2026-08-19 대표 지시 「B 먼저 세우고 A 켜라」) ──────────────
//
// ⛔ 이 절이 지키는 불변식 셋:
//   ⑤ 「자격 없음」과 「잔량 소진」이 «다른 값»이다
//   ⑥ 「모른다」를 「소진」으로 접지 않는다 — 통과시키고 관측에 남긴다
//   ⑦ 생략하면 종전과 «똑같다»(옵션을 안 켠 사용자 무변경)

import { grokQuotaFromCreditAxis, grokQuotaFromUsageSnapshot } from './fallback-chain.js';

describe('grok 잔량 축 — decideFallback', () => {
  const chain = ['codex-rotate', 'grok'] as const;
  const exhaustedCodex = { reason: 'no-candidate' } as const;

  it('⑤ 자격 없음과 잔량 소진이 «다른 사유»로 남는다', () => {
    const noCred = decideFallback({ rotation: exhaustedCodex, chain, grokAvailable: false, grokQuota: 'usable' });
    expect(noCred).toEqual({ action: 'stay', why: 'grok-unavailable' });

    const spent = decideFallback({ rotation: exhaustedCodex, chain, grokAvailable: true, grokQuota: 'exhausted' });
    expect(spent).toEqual({ action: 'stay', why: 'grok-exhausted' });
  });

  it('⑥ 「모른다」는 «통과»한다 — 못 읽었다고 갈 곳을 없애지 않는다', () => {
    expect(decideFallback({ rotation: exhaustedCodex, chain, grokAvailable: true, grokQuota: 'unknown' }))
      .toEqual({ action: 'switch-backend', backend: 'grok' });
  });

  it('⑦ grokQuota 를 «생략»하면 종전과 똑같다', () => {
    expect(decideFallback({ rotation: exhaustedCodex, chain, grokAvailable: true }))
      .toEqual({ action: 'switch-backend', backend: 'grok' });
  });

  it('잔량이 있으면 간다', () => {
    expect(decideFallback({ rotation: exhaustedCodex, chain, grokAvailable: true, grokQuota: 'usable' }))
      .toEqual({ action: 'switch-backend', backend: 'grok' });
  });

  it('⛔ 자격이 «먼저»다 — 자격이 없으면 잔량이 소진이어도 grok-unavailable 이다', () => {
    expect(decideFallback({ rotation: exhaustedCodex, chain, grokAvailable: false, grokQuota: 'exhausted' }))
      .toEqual({ action: 'stay', why: 'grok-unavailable' });
  });

  it('체인에 grok 이 «없으면» 잔량과 무관하게 no-candidate 로 머문다', () => {
    expect(decideFallback({ rotation: exhaustedCodex, chain: ['codex-rotate'], grokAvailable: true, grokQuota: 'usable' }))
      .toEqual({ action: 'stay', why: 'no-candidate' });
  });
});

describe('grokQuotaFromCreditAxis — 「모른다」를 「소진」으로 접지 않는다', () => {
  it('축이 없으면 unknown', () => {
    expect(grokQuotaFromCreditAxis(null)).toBe('unknown');
    expect(grokQuotaFromCreditAxis(undefined)).toBe('unknown');
  });

  it('필드가 전부 null 이면 unknown — ⛔ exhausted 가 «아니다»', () => {
    expect(grokQuotaFromCreditAxis({ unlimited: null, hasCredits: null, usedPercent: null })).toBe('unknown');
  });

  it('unlimited 가 이긴다', () => {
    expect(grokQuotaFromCreditAxis({ unlimited: true, hasCredits: false, usedPercent: 100 })).toBe('usable');
  });

  // ⛔⭐ 2026-08-19 실측으로 «뒤집었다» — grok 의 hasCredits 는 `prepaidBalance > 0`(선불 잔액)이라
  //   ***구독 사용자는 선불 0 이 «정상»***이다. 그것을 「소진」으로 읽으면 90% 남았는데 폴백을 막는다.
  //   📏 실측: usedPercent=10 · prepaidBalance=0 · hasCredits=false  ⇒ 정답은 usable
  it('⭐ usedPercent 가 hasCredits 보다 «앞»이다 — 선불 0 을 「소진」으로 읽지 않는다', () => {
    expect(grokQuotaFromCreditAxis({ hasCredits: false, usedPercent: 10 })).toBe('usable');
    expect(grokQuotaFromCreditAxis({ hasCredits: true, usedPercent: 100 })).toBe('exhausted');
  });

  it('사용률을 «못 읽을» 때만 선불 잔액을 본다 — 그때는 그것이 유일한 재료다', () => {
    expect(grokQuotaFromCreditAxis({ hasCredits: false })).toBe('exhausted');
    expect(grokQuotaFromCreditAxis({ hasCredits: true })).toBe('usable');
  });

  it('usedPercent 는 임계로 가른다 (기본 100)', () => {
    expect(grokQuotaFromCreditAxis({ usedPercent: 99.9 })).toBe('usable');
    expect(grokQuotaFromCreditAxis({ usedPercent: 100 })).toBe('exhausted');
    expect(grokQuotaFromCreditAxis({ usedPercent: 95 }, 95)).toBe('exhausted');
  });

  it('⛔ 유한하지 않은 수는 unknown — NaN 을 0 으로 읽지 않는다', () => {
    expect(grokQuotaFromCreditAxis({ usedPercent: Number.NaN })).toBe('unknown');
  });
});

describe('grokQuotaFromUsageSnapshot — 공급자 판정이 «우리 산술보다» 앞선다', () => {
  it('스냅샷이 없으면 unknown', () => {
    expect(grokQuotaFromUsageSnapshot(null)).toBe('unknown');
    expect(grokQuotaFromUsageSnapshot(undefined)).toBe('unknown');
  });

  it('⭐ 공급자가 「찼다」고 «말하면» 그것이 이긴다 — credits 가 있다고 해도', () => {
    expect(grokQuotaFromUsageSnapshot({
      rateLimitReached: 'rate_limit_reached',
      credits: { hasCredits: true, unlimited: true },
    })).toBe('exhausted');
  });

  it('credits 가 없으면 unknown — ⛔ exhausted 가 «아니다»', () => {
    expect(grokQuotaFromUsageSnapshot({})).toBe('unknown');
  });

  it('unlimited 가 hasCredits 보다 앞이다', () => {
    expect(grokQuotaFromUsageSnapshot({ credits: { unlimited: true, hasCredits: false } })).toBe('usable');
  });

  // ⛔⭐ 뒤집었다 — 스냅샷 경로엔 사용률 창이 없고, `hasCredits` 는 브랜드마다 «다른 것»을 뜻한다.
  //   ⇒ 그 하나로 「소진」을 «단정하지 않는다». 「모른다」가 정직하고, 「모른다」는 통과다.
  it('hasCredits=false «하나»로는 소진을 단정하지 않는다 — unknown 이다', () => {
    expect(grokQuotaFromUsageSnapshot({ credits: { hasCredits: false, unlimited: false } })).toBe('unknown');
    expect(grokQuotaFromUsageSnapshot({ credits: { hasCredits: true, unlimited: false } })).toBe('usable');
  });

  it('⛔ 빈 문자열 rateLimitReached 는 「말하지 않은 것」이다', () => {
    expect(grokQuotaFromUsageSnapshot({ rateLimitReached: '', credits: { hasCredits: true, unlimited: false } }))
      .toBe('usable');
  });
});
