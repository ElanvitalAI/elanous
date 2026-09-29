// ⛔⭐⭐⭐ `S4` — 리밋이면 다른 계정으로 넘긴다 (대표 결정 2026-08-05).
//
// 결정 넷을 여기서 «전수»로 잠근다:
//   ① 전환«만» 자동이다 — 리셋 크레딧 소비는 이 축에 «없다»
//   ② 기본 ON · config 로만 꺼진다
//   ③ 사람이 명시한 계정은 «안» 넘긴다 — 의도가 이긴다
//   ④ ⛔ **낡은 문면 정정 (2026-08-20)** — 종전 이 줄은 *"「모른다」로는 «안» 넘긴다"* 였다.
//      그러나 아래 두 시험이 그 «반대»를 문다(`현재 사용률이 null이어도 … 쓸 후보로 넘긴다`).
//      ✅ 현재 계약 = ***「모르면 «쓸 수 있는» 후보로 넘긴다」*** — 못 재는 자격 위에 머무는 쪽이 더 위험하다.
//      📌 이 줄이 늙어 있어서 2026-08-20 수리 때 사람이 「계약을 깨는가」로 한 번 멈췄다.
//
// ⭐ 판정이 순수 함수라 실물(스토어·네트워크) 없이 전수로 문다.

import { describe, expect, mock, test } from 'bun:test';

const defaultOutboundCalls: Array<{ text: string; kind: string | undefined }> = [];
mock.module('../../src/domains/outbound-alert.js', () => ({
  sendOutbound(text: string, kind?: string): boolean {
    defaultOutboundCalls.push({ text, kind });
    return true;
  },
}));
import {
  decideCodexRotation, applyRotation, observeRotation, codexAccountRotationEnabled, readCodexAccountRotationConfig, rotatedChildEnv,
  DEFAULT_ROTATION_THRESHOLD_PERCENT_BY_ACCOUNT, codexAccountThresholdPercent, type RotationCandidate,
} from '../../src/oauth/codex-account-rotation';
import { quotaSignalDir } from '../../src/budget/codex-reset-credit-state';
import { debug } from '../../src/debug/log';
import type { CodexAccountResolution } from '../../src/oauth/codex-account';
import { decideFallback } from '../../src/oauth/fallback-chain';

const current: CodexAccountResolution = {
  name: 'default', storeKey: 'openai-codex', home: '/h/A', source: 'default',
};
const cand = (name: string, reached: boolean | undefined, home = `/h/${name}`, usedPercent?: number): RotationCandidate =>
  ({ name, storeKey: `openai-codex:${name}`, home, reached, usedPercent });

const base = {
  current,
  explicit: false,
  enabled: true,
  currentReached: true as boolean | undefined,
  resetCreditAvailability: 'unavailable' as const,
  candidates: [] as RotationCandidate[],
};

describe('회전 판정 — 결정 넷', () => {
  test('✅ 찼고 리셋 크레딧이 없으면 갈 곳으로 넘긴다', () => {
    const d = decideCodexRotation({ ...base, candidates: [cand('team', undefined)] });
    expect(d.reason).toBe('rotated');
    expect(d.to?.name).toBe('team');
  });

  test('✅ 찼고 쓸 수 있는 리셋 크레딧이 있어도 쓸 후보를 먼저 고른다', () => {
    const d = decideCodexRotation({ ...base, resetCreditAvailability: 'available', candidates: [cand('team', undefined)] });
    expect(d.reason).toBe('rotated');
    expect(d.to?.name).toBe('team');
    expect(applyRotation(current, d).name).toBe('team');
  });

  test('✅ 찼고 쓸 후보가 없을 때만 리셋 크레딧 사유로 머문다', () => {
    const d = decideCodexRotation({ ...base, resetCreditAvailability: 'available', candidates: [] });
    expect(d.reason).toBe('reset-credit-available');
    expect(d.to).toBeUndefined();
    expect(applyRotation(current, d)).toEqual(current);
  });

  test('✅ 찼고 리셋 크레딧 조회를 못 했으면 모른다는 사유로 기존 후보를 고른다', () => {
    const d = decideCodexRotation({ ...base, resetCreditAvailability: 'unknown', candidates: [cand('team', undefined)] });
    expect(d.reason).toBe('reset-credit-unknown');
    expect(d.to?.name).toBe('team');
    expect(applyRotation(current, d).name).toBe('team');
  });

  test('✅ 조회 불가 사유도 fallback 체인에서 기존처럼 실제 계정 전환으로 이어진다', () => {
    const rotation = decideCodexRotation({ ...base, resetCreditAvailability: 'unknown', candidates: [cand('team', undefined)] });
    expect(rotation.reason).toBe('reset-credit-unknown');
    const fallback = decideFallback({
      rotation: { reason: rotation.reason as 'reset-credit-unknown', to: rotation.to! },
      chain: ['codex-rotate'],
      grokAvailable: false,
    });
    expect(fallback.action).toBe('codex-rotate');
    if (fallback.action === 'codex-rotate') expect(fallback.to.name).toBe('team');
  });

  test('✅ 쓸 후보가 없을 때의 리셋 크레딧은 기본으로 Grok 체인을 타고, 머무름은 입력으로만 켠다', () => {
    const rotation = decideCodexRotation({ ...base, resetCreditAvailability: 'available', candidates: [] });
    expect(rotation.reason).toBe('reset-credit-available');
    const input = {
      rotation: { reason: 'reset-credit-available' } as const, chain: ['codex-rotate', 'grok'] as const, grokAvailable: true,
    };
    expect(decideFallback(input)).toEqual({ action: 'switch-backend', backend: 'grok' });
    expect(decideFallback({ ...input, stayOnResetCreditAvailable: true }))
      .toEqual({ action: 'stay', why: 'reset-credit-available' });
  });

  test('⛔ 임계 미달이면 리셋 크레딧 유무와 무관하게 그대로 머문다', () => {
    for (const resetCreditAvailability of ['available', 'unavailable', 'unknown'] as const) {
      expect(decideCodexRotation({
        ...base, currentReached: undefined, currentUsedPercent: 9, resetCreditAvailability, candidates: [cand('team', undefined)],
      }).reason).toBe('not-reached');
    }
  });

  test('⛔ ③ 사람이 «명시»한 계정은 안 넘긴다 — 찼어도', () => {
    const d = decideCodexRotation({ ...base, explicit: true, candidates: [cand('team', undefined)] });
    expect(d.reason).toBe('explicit');
    expect(d.to).toBeUndefined();
  });

  test('⛔ ② config 로 끄면 안 넘긴다', () => {
    const d = decideCodexRotation({ ...base, enabled: false, candidates: [cand('team', undefined)] });
    expect(d.reason).toBe('disabled');
  });

  test('✅ 현재 사용률이 undefined면 기본 계정에 고정하지 않고 쓸 후보로 넘긴다', () => {
    const d = decideCodexRotation({
      ...base, currentReached: undefined, currentUsedPercent: undefined, candidates: [cand('team', undefined)],
    });
    expect(d.reason).toBe('rotated');
    expect(d.to?.name).toBe('team');
  });

  test('✅ 현재 사용률이 null이어도 기본 계정에 고정하지 않고 쓸 후보로 넘긴다', () => {
    const d = decideCodexRotation({
      ...base, currentReached: undefined, currentUsedPercent: null as unknown as undefined, candidates: [cand('team', undefined)],
    });
    expect(d.reason).toBe('rotated');
    expect(d.to?.name).toBe('team');
  });

  // 🆕 `OBS-T188` (2026-08-20 · [F] 발견 · 대표 지시) — 「못 쟀다」가 「비어 있다」로 접히면
  //   소진된 자격 위에 머문다. 판정 «입력»을 만들 때 그 홈의 신호가 «이 계정의 것»인지 묻는다.
  test('🆕 정본이 홈을 모르는 계정(source=default)의 신호는 «이 계정 것»으로 귀속하지 않는다', async () => {
    const store = await import('../../src/oauth/codex-account-store');
    expect(store.signalAttributableToAccount({ source: 'store' })).toBe(true);
    expect(store.signalAttributableToAccount({ source: 'env' })).toBe(true);
    // ⛔ 아래 둘이 이 시험의 «본체» — 근거 없이 ~/.codex 로 떨어진 홈의 0% 는 측정값이 아니다.
    expect(store.signalAttributableToAccount({ source: 'default' })).toBe(false);
    expect(store.signalAttributableToAccount({ source: 'none' })).toBe(false);
  });

  // 🆕⛔⭐ `OBS-T188` — ***호출부 배선을 무는 통합 시험을 「못 썼다」*** (무인 리뷰 must-fix · 2026-08-20).
  //
  //   리뷰 지적은 «정당하다»: 아래 두 시험은 헬퍼와 순수 판정기만 각각 물어서,
  //   두 호출부의 `currentSignalAttributable &&` 를 «되돌려도» 통과한다.
  //
  //   ⛔ 그런데 그 상황(`source=default`)을 시험에서 «만들 수가 없었다». 두 번 시도해 갈린 사실:
  //     ⑴ `saveTokens` 는 언제나 codexHome 을 기록한다 ⇒ source='store'(귀속됨)
  //     ⑵ 정본에서 그 필드를 지워도 «기본 계정은 홈 규칙이 다르다»(store.ts:96
  //        "기본 계정의 홈 — 종전 규칙 그대로") ⇒ 여전히 source='store'
  //   ⇒ 📌 ***실전의 그 상태(「auth 는 있는데 정본이 홈을 모른다」)는 정상 경로로는 안 만들어진다.***
  //     그것이 바로 이 버그가 «오래 안 잡힌» 이유이기도 하다.
  //
  //   ✅ 대신 «라이브»가 배선을 물었다(실물 · 같은 트리 · 같은 명령):
  //        전:  provider codex status → 회전 not-reached   · 사용=0%   · "정상이다"
  //        후:  provider codex status → 회전 rotated→team · 사용=?%
  //   ⛔ 그래서 이 자리는 「시험이 없다」가 아니라 ***「시험으로는 못 무는 자리이고, 그 사실을 적어 둔다」***다.
  //   🩹 다음 판이 이 축을 다시 만지면 ⑴⑵ 를 «먼저» 풀어야 통합 시험이 선다.

  test('🆕 귀속 안 되는 홈이면 사용률을 모르는 것으로 보고 쓸 후보로 넘긴다', () => {
    // 실측 재현(2026-08-20): default 가 「사용=0% · 찼나=모름」인데 실제 호출은 소진된 third 로 나갔다.
    // 귀속 판정을 거치면 두 입력이 모두 undefined 가 되어 아래처럼 회전한다.
    const d = decideCodexRotation({
      ...base, currentReached: undefined, currentUsedPercent: undefined, candidates: [cand('team', undefined)],
    });
    expect(d.reason).toBe('rotated');
    expect(d.to?.name).toBe('team');
    // ⛔ 그리고 「0% 로 접힌 경우」는 그 반대로 «머문다» — 이 대비가 이 버그의 전부다.
    const folded = decideCodexRotation({
      ...base, currentReached: undefined, currentUsedPercent: 0, candidates: [cand('team', undefined)],
    });
    expect(folded.reason).toBe('not-reached');
  });

  test('⛔ 후보도 «찼으면» 그리로 안 넘긴다', () => {
    const d = decideCodexRotation({ ...base, candidates: [cand('team', true)] });
    expect(d.reason).toBe('no-candidate');
  });

  test('💳 크레딧 허가(09-28)면 갈 곳이 없어도 «no-candidate» 가 아니라 머문다(credits-allowed) · 잔량 계정이 있으면 그쪽이 먼저', () => {
    const stay = decideCodexRotation({ ...base, creditsAllowed: true, candidates: [cand('team', true)] });
    expect(stay.reason).toBe('credits-allowed');
    expect(stay.to).toBeUndefined();
    const rotated = decideCodexRotation({ ...base, creditsAllowed: true, candidates: [cand('team', true), cand('third', undefined)] });
    expect(rotated.reason).toBe('rotated');
    expect(rotated.to?.name).toBe('third');
    const off = decideCodexRotation({ ...base, creditsAllowed: false, candidates: [cand('team', true)] });
    expect(off.reason).toBe('no-candidate');
  });

  test('⭐ 96%는 기본 95% 임계를 넘어 team으로 미리 회전한다', () => {
    const d = decideCodexRotation({
      ...base,
      currentReached: undefined,
      currentUsedPercent: 96,
      thresholdPercent: 95,
      candidates: [cand('team', undefined, '/h/team', 2)],
    });
    expect(d.reason).toBe('rotated');
    expect(d.to?.name).toBe('team');
  });

  test('⭐ 50% override는 60% 현재 계정을 떠나고 사용률 미설정 team 후보를 고른다', () => {
    const d = decideCodexRotation({
      ...base,
      currentReached: undefined,
      currentUsedPercent: 60,
      thresholdPercent: 50,
      candidates: [cand('default', undefined, '/h/A', 60), cand('team', undefined, '/h/team')],
    });
    expect(d.reason).toBe('rotated');
    expect(d.to?.name).toBe('team');
  });

  test('동명 후보 20%·100%는 개별 상태를 적용해 첫 후보를 고른다', () => {
    const first = cand('team', undefined, '/h/team-first', 20);
    const second = cand('team', undefined, '/h/team-second', 100);
    const decision = decideCodexRotation({ ...base, candidates: [first, second] });
    expect(decision.reason).toBe('rotated');
    expect(decision.to).toBe(first);
    expect(decision.accountThresholds?.map(({ status }) => status)).toEqual([
      'reached', 'below-threshold', 'threshold-reached',
    ]);
  });

  test('⛔ 임계와 같으면 전환하고, 임계 이상 후보는 고르지 않는다', () => {
    const d = decideCodexRotation({
      ...base,
      currentReached: undefined,
      currentUsedPercent: 95,
      thresholdPercent: 95,
      candidates: [cand('full', undefined, '/h/full', 95), cand('team', undefined, '/h/team', 2)],
    });
    expect(d.reason).toBe('rotated');
    expect(d.to?.name).toBe('team');
  });

  test('⛔ 임계 미달인 현재 계정의 반환은 종전처럼 not-reached다', () => {
    expect(decideCodexRotation({ ...base, currentReached: undefined, currentUsedPercent: 9 }).reason).toBe('not-reached');
  });

  test('⭐ 범위 밖·비수 임계는 기본 95%를 쓴다', () => {
    for (const thresholdPercent of [0, 101, Number.NaN]) {
      expect(decideCodexRotation({
        ...base,
        currentReached: undefined,
        currentUsedPercent: 95,
        thresholdPercent,
        candidates: [cand('team', undefined)],
      }).reason).toBe('rotated');
    }
  });

  test('default 계정 기본 60%와 계정별 명시값·전역 95%의 우선순위', () => {
    expect(DEFAULT_ROTATION_THRESHOLD_PERCENT_BY_ACCOUNT).toEqual({ default: 60 });
    expect(codexAccountThresholdPercent('default', {})).toBe(60);
    expect(codexAccountThresholdPercent('default', { thresholdPercent: 80 })).toBe(60);
    expect(codexAccountThresholdPercent('team', {})).toBe(95);
    expect(codexAccountThresholdPercent('team', { thresholdPercent: 80 })).toBe(80);
    expect(codexAccountThresholdPercent('default', { thresholdPercentByAccount: { default: 50 } })).toBe(50);
    expect(codexAccountThresholdPercent('default', { thresholdPercentByAccount: { default: 0 } })).toBe(60);
    expect(codexAccountThresholdPercent('team', { thresholdPercent: 80, thresholdPercentByAccount: { team: 101 } })).toBe(80);
    expect(codexAccountThresholdPercent('toString', {})).toBe(95);
  });

  test('판정에 사용한 default 기본값·계정별 설정·전역 임계와 후보 상태를 함께 낸다', () => {
    const decision = decideCodexRotation({
      ...base, currentReached: undefined, currentUsedPercent: 60,
      thresholdPercent: 90,
      thresholdPercentByAccount: { alpha: 70, team: 0 },
      candidates: [cand('alpha', undefined, '/h/alpha', 70), cand('team', undefined, '/h/team', 85)],
    });
    expect(decision.reason).toBe('rotated');
    expect(decision.to?.name).toBe('team');
    expect(decision.accountThresholds).toEqual([
      { name: 'default', thresholdPercent: 60, source: 'account-default', status: 'threshold-reached', usedPercent: 60 },
      { name: 'alpha', thresholdPercent: 70, source: 'account-override', status: 'threshold-reached', usedPercent: 70 },
      { name: 'team', thresholdPercent: 90, source: 'global', status: 'below-threshold', usedPercent: 85 },
    ]);
  });

  test('default 60% 도달은 떠나고 후보에서도 제외하며 team 은 전역 95%까지 쓴다', () => {
    const leaving = decideCodexRotation({
      ...base, currentReached: undefined, currentUsedPercent: 60,
      candidates: [cand('team', undefined, '/h/team', 60)],
    });
    expect(leaving.reason).toBe('rotated');
    expect(leaving.to?.name).toBe('team');
    const fromTeam = decideCodexRotation({
      ...base, current: { ...current, name: 'team' }, currentReached: true,
      candidates: [cand('default', undefined, '/h/A', 60)],
    });
    expect(fromTeam.reason).toBe('no-candidate');
  });

  test('⭐ 계정별 정수 임계는 현재 계정의 회전 시작과 후보 제외에 각각 적용한다', () => {
    const d = decideCodexRotation({
      ...base,
      currentReached: undefined,
      currentUsedPercent: 80,
      thresholdPercent: 95,
      thresholdPercentByAccount: { default: 80, alpha: 40 },
      candidates: [cand('alpha', undefined, '/h/alpha', 40), cand('team', undefined, '/h/team', 90)],
    });
    expect(d.reason).toBe('rotated');
    expect(d.to?.name).toBe('team');
  });

  test('⛔ 소수·범위 밖·비수 계정별 임계는 정규화된 전역 임계로 폴백한다', () => {
    const invalidOverrides = [80.5, 0, 101, Number.NaN];
    for (const override of invalidOverrides) {
      const d = decideCodexRotation({
        ...base,
        currentReached: undefined,
        currentUsedPercent: 95,
        thresholdPercent: 95,
        thresholdPercentByAccount: { default: override, alpha: override },
        candidates: [cand('alpha', undefined, '/h/alpha', 95), cand('team', undefined, '/h/team', 94)],
      });
      expect(d.reason, String(override)).toBe('rotated');
      expect(d.to?.name, String(override)).toBe('team');
    }
  });

  test('⛔ 홈을 모르는 계정은 후보가 아니다 — 모르는 곳으로 안 넘긴다', () => {
    const d = decideCodexRotation({ ...base, candidates: [cand('ghost', undefined, '')] });
    expect(d.reason).toBe('no-candidate');
  });

  test('⛔ 자기 자신으로는 안 넘긴다', () => {
    const d = decideCodexRotation({ ...base, candidates: [cand('default', undefined, '/h/A')] });
    expect(d.reason).toBe('no-candidate');
  });

  test('⭐ 후보가 여럿이면 «결정론»으로 고른다 — 이름 오름차순', () => {
    const cands = [cand('zeta', undefined), cand('alpha', undefined), cand('mid', undefined)];
    expect(decideCodexRotation({ ...base, candidates: cands }).to?.name).toBe('alpha');
    // 순서를 바꿔 넣어도 같은 답 — 사후에 「왜 이 계정인가」를 재구성할 수 있다
    expect(decideCodexRotation({ ...base, candidates: cands.slice().reverse() }).to?.name).toBe('alpha');
  });

  test('⛔ 갈 곳이 아예 없으면 «그대로 둔다» — 넘길 데 없다고 죽지 않는다', () => {
    const d = decideCodexRotation({ ...base, candidates: [] });
    expect(d.reason).toBe('no-candidate');
    expect(applyRotation(current, d)).toEqual(current);
  });
});

describe('회전 관측 — 후보 수', () => {
  test('⭐ 후보 0개·전부 불가·성공·조기 관측 미상을 서로 구별하고 기존 결정을 보존한다', () => {
    const originalLog = debug.log;
    const payloads: Array<Record<string, unknown>> = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data: Record<string, unknown>, ...rest: unknown[]) => {
      if (category === 'oauth.codex-account' && event === 'rotation') payloads.push(data);
      return (originalLog as (...args: unknown[]) => unknown).call(debug, category, event, data, ...rest);
    }) as typeof debug.log;
    try {
      const noCandidates = decideCodexRotation({ ...base, candidates: [] });
      expect(noCandidates.reason).toBe('no-candidate');
      expect(applyRotation(current, noCandidates)).toEqual(current);
      observeRotation(noCandidates, current.name);

      const exhausted = decideCodexRotation({ ...base, candidates: [cand('full', true), cand('also-full', true)] });
      expect(exhausted.reason).toBe('no-candidate');
      expect(applyRotation(current, exhausted)).toEqual(current);
      observeRotation(exhausted, current.name);

      const rotated = decideCodexRotation({ ...base, candidates: [cand('team', undefined), cand('spare', undefined)] });
      expect(rotated.reason).toBe('rotated');
      expect(rotated.to?.name).toBe('spare');
      expect(applyRotation(current, rotated).name).toBe('spare');
      observeRotation(rotated, current.name);

      observeRotation({ reason: 'explicit' }, current.name);

      expect(payloads).toEqual([
        { from: 'default', to: undefined, reason: 'no-candidate', candidateCount: 0 },
        { from: 'default', to: undefined, reason: 'no-candidate', candidateCount: 2 },
        { from: 'default', to: 'spare', reason: 'rotated', candidateCount: 2 },
        { from: 'default', to: undefined, reason: 'explicit', candidateCount: 'unknown' },
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });
});

describe('회전 설정 판독 근거 — disabled 관측만 남긴다', () => {
  test('명시적 false·키 없음·읽기 실패·true를 이름 있는 상태로 구분하면서 변경 전 boolean과 기존 ON 정책을 보존한다', () => {
    const inputs = [
      { name: 'explicit-false', readConfig: () => ({ llm: { codexAccountRotation: false } }), beforeEnabled: false, after: { enabled: false, state: 'explicit-false' } },
      { name: 'missing', readConfig: () => ({ llm: {} }), beforeEnabled: true, after: { enabled: true, state: 'missing' } },
      { name: 'access-failed', readConfig: () => { throw new Error('config unreadable'); }, beforeEnabled: true, after: { enabled: true, state: 'access-failed' } },
      { name: 'enabled', readConfig: () => ({ llm: { codexAccountRotation: true } }), beforeEnabled: true, after: { enabled: true, state: 'enabled' } },
    ] as const;

    for (const input of inputs) {
      expect(codexAccountRotationEnabled(input.readConfig), input.name).toBe(input.beforeEnabled);
      expect(readCodexAccountRotationConfig(input.readConfig), input.name).toEqual(input.after);
    }
  });

  test('disabled만 explicit-false 근거를 직렬화하고 기존 판정·관측 키를 보존한다', () => {
    const originalLog = debug.log;
    const payloads: Array<Record<string, unknown>> = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'oauth.codex-account' && event === 'rotation') payloads.push(data);
    }) as typeof debug.log;
    try {
      const disabled = decideCodexRotation({ ...base, enabled: false, disabledProvenance: 'explicit-false' });
      const enabled = decideCodexRotation({ ...base, enabled: true, disabledProvenance: 'missing', candidates: [] });
      expect(disabled).toMatchObject({ reason: 'disabled', candidateCount: 0, disabledProvenance: 'explicit-false' });
      expect(enabled).toMatchObject({ reason: 'no-candidate', candidateCount: 0 });
      expect(enabled.to).toBeUndefined();
      observeRotation(disabled, current.name);
      observeRotation(enabled, current.name);
      expect(payloads).toEqual([
        { from: 'default', to: undefined, reason: 'disabled', candidateCount: 0, disabledProvenance: 'explicit-false' },
        { from: 'default', to: undefined, reason: 'no-candidate', candidateCount: 0 },
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });
});

describe('회전 결과 접기', () => {
  test('⭐ 넘겼으면 출처가 «rotated» — 「사람이 골랐다」고 말하지 않는다', () => {
    const d = decideCodexRotation({ ...base, candidates: [cand('team', undefined)] });
    const next = applyRotation(current, d);
    expect(next.name).toBe('team');
    expect(next.storeKey).toBe('openai-codex:team');
    expect(next.home).toBe('/h/team');
    expect(next.source).toBe('rotated');
  });

  test('⛔ 안 넘겼으면 «한 바이트도» 안 바뀐다', () => {
    for (const d of [
      decideCodexRotation({ ...base, explicit: true }),
      decideCodexRotation({ ...base, enabled: false }),
      decideCodexRotation({ ...base, currentReached: undefined }),
    ]) {
      expect(applyRotation(current, d)).toEqual(current);
    }
  });
});

// ⛔⭐⭐ 위는 «판정»만 문다. 「그 판정이 실행 경로에 있는가」는 다른 축이다(배선 규율).
//   여기서 스토어 셸(resolveCodexAccountForRun)이 실제로 그 판정을 거치는지 문다.
describe('배선 — 스토어 셸이 그 판정을 «실제로» 거친다', () => {
  const { mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync, readFileSync } = require('node:fs') as typeof import('node:fs');
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join, resolve } = require('node:path') as typeof import('node:path');

  test('✅ 현재 홈의 리셋 크레딧보다 쓸 후보를 먼저 고르고 다른 홈 상태는 무시한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rotate-credit-home-'));
    const priorState = process.env.ELANOUS_STATE_DIR;
    const priorStateSource = process.env.ELANOUS_STATE_DIR_SOURCE;
    const priorHome = process.env.CODEX_HOME;
    try {
      process.env.ELANOUS_STATE_DIR = root;
      delete process.env.ELANOUS_STATE_DIR_SOURCE;
      const homeA = join(root, 'home-A');
      const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;
      const { saveTokens } = await import('../../src/oauth/store');
      const store = join(root, 'auth.json');
      const t = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', t, { mirrorCodex: false, codexHome: homeA }, store);
      saveTokens('openai-codex:team', t, { mirrorCodex: false, codexHome: homeB }, store);
      writeFileSync(join(homeA, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-token', account_id: 'account-1' } }));
      const { writeQuotaSignal, readAvailabilityState, writeAvailabilityState } = await import('../../src/budget/codex-reset-credit-state');
      const { observeResetCreditAvailability } = await import('../../src/budget/codex-reset-credits');
      writeQuotaSignal('rate_limit_reached', homeA);
      writeQuotaSignal(undefined, homeB);
      const observed = await observeResetCreditAvailability({
        authFilePath: join(homeA, 'auth.json'),
        fetchImpl: async () => new Response(JSON.stringify({ credits: [], available_count: 1, total_earned_count: 0 }), { status: 200 }),
        readPrevious: () => readAvailabilityState(homeA),
        writeCurrent: (count) => writeAvailabilityState(count, homeA),
      });
      expect(observed.ok).toBe(true);
      writeAvailabilityState(0, homeB);
      const store2 = await import('../../src/oauth/codex-account-store');
      store2._resetCodexRotationPinForTesting();
      store2._setRotationConfigReaderForTesting(() => ({}));
      const available = store2.inspectCodexRotation(process.env, { storePath: store });
      expect(available.reason).toBe('rotated');
      expect(available.to).toBe('team');
      expect(store2.resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('team');

      const observedUnavailable = await observeResetCreditAvailability({
        authFilePath: join(homeA, 'auth.json'),
        fetchImpl: async () => new Response(JSON.stringify({ credits: [], available_count: 0, total_earned_count: 0 }), { status: 200 }),
        readPrevious: () => readAvailabilityState(homeA),
        writeCurrent: (count) => writeAvailabilityState(count, homeA),
      });
      expect(observedUnavailable.ok).toBe(true);
      writeAvailabilityState(1, homeB);
      store2._resetCodexRotationPinForTesting();
      const unavailable = store2.inspectCodexRotation(process.env, { storePath: store });
      expect(unavailable.reason).toBe('rotated');
      expect(unavailable.to).toBe('team');
      expect(store2.resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('team');
    } finally {
      if (priorState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = priorState;
      if (priorStateSource === undefined) delete process.env.ELANOUS_STATE_DIR_SOURCE; else process.env.ELANOUS_STATE_DIR_SOURCE = priorStateSource;
      if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
      const store2 = await import('../../src/oauth/codex-account-store');
      store2._setRotationConfigReaderForTesting(null);
      store2._resetCodexRotationPinForTesting();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test('⛔ 오래된 available 관측은 unknown으로 정규화되어 회전을 막지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rotate-credit-stale-'));
    const priorState = process.env.ELANOUS_STATE_DIR;
    const priorStateSource = process.env.ELANOUS_STATE_DIR_SOURCE;
    const priorHome = process.env.CODEX_HOME;
    try {
      process.env.ELANOUS_STATE_DIR = root;
      delete process.env.ELANOUS_STATE_DIR_SOURCE;
      const homeA = join(root, 'home-A');
      const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;
      const { saveTokens } = await import('../../src/oauth/store');
      const { writeQuotaSignal, writeAvailabilityState } = await import('../../src/budget/codex-reset-credit-state');
      const store = join(root, 'auth.json');
      const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', tokens, { mirrorCodex: false, codexHome: homeA }, store);
      saveTokens('openai-codex:team', tokens, { mirrorCodex: false, codexHome: homeB }, store);
      writeQuotaSignal('rate_limit_reached', homeA);
      writeQuotaSignal(undefined, homeB);
      writeAvailabilityState(1, homeA);
      const availabilityKey = createHash('sha256').update(realpathSync(resolve(homeA))).digest('hex').slice(0, 12);
      const availabilityPath = join(quotaSignalDir(), `codex-reset-credit-availability-${availabilityKey}.json`);
      const stale = JSON.parse(readFileSync(availabilityPath, 'utf8')) as { availableCount: number; observedAt: string };
      writeFileSync(availabilityPath, `${JSON.stringify({ ...stale, observedAt: new Date(Date.now() - 61 * 60 * 1000).toISOString() })}\n`);
      const store2 = await import('../../src/oauth/codex-account-store');
      store2._resetCodexRotationPinForTesting();
      store2._setRotationConfigReaderForTesting(() => ({}));
      const decision = store2.inspectCodexRotation(process.env, { storePath: store });
      expect(decision.reason).toBe('reset-credit-unknown');
      expect(decision.to).toBe('team');
      expect(store2.resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('team');
    } finally {
      if (priorState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = priorState;
      if (priorStateSource === undefined) delete process.env.ELANOUS_STATE_DIR_SOURCE; else process.env.ELANOUS_STATE_DIR_SOURCE = priorStateSource;
      if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
      const store2 = await import('../../src/oauth/codex-account-store');
      store2._setRotationConfigReaderForTesting(null);
      store2._resetCodexRotationPinForTesting();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test('✅ reset-credits observe 명령은 named account의 정본 홈 auth.json을 조회하고 같은 홈에 기록한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rotate-credit-cli-'));
    const prior = {
      state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME, xdg: process.env.XDG_CONFIG_HOME,
      account: process.env.ELANOUS_CODEX_ACCOUNT, accountHome: process.env.ELANOUS_CODEX_ACCOUNT_HOME,
    };
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const output: string[] = [];
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.XDG_CONFIG_HOME = root;
      process.env.CODEX_HOME = join(root, 'default-home');
      process.env.ELANOUS_CODEX_ACCOUNT = 'team';
      delete process.env.ELANOUS_CODEX_ACCOUNT_HOME;
      const teamHome = join(root, 'team-home');
      mkdirSync(process.env.CODEX_HOME, { recursive: true });
      mkdirSync(teamHome, { recursive: true });
      const { authStorePath, saveTokens } = await import('../../src/oauth/store');
      const store = authStorePath();
      saveTokens('openai-codex:team', { accessToken: 'team-access', refreshToken: 'team-refresh', expiresAt: null },
        { mirrorCodex: false, codexHome: teamHome }, store);
      writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { access_token: 'default-access' } }));
      writeFileSync(join(teamHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'team-access', account_id: 'team-account' } }));
      let authorization = '';
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get('Authorization') ?? '';
        return new Response(JSON.stringify({ credits: [], available_count: 1, total_earned_count: 0 }), { status: 200 });
      }) as typeof fetch;
      console.log = (...args: unknown[]) => { output.push(args.join(' ')); };

      const { program } = await import('../../src/index');
      await program.parseAsync(['node', 'elanous', 'provider', 'codex', 'reset-credits', 'observe'], { from: 'node' });

      const { readAvailabilityState } = await import('../../src/budget/codex-reset-credit-state');
      const { inspectCodexRotation } = await import('../../src/oauth/codex-account-store');
      expect(authorization).toBe('Bearer team-access');
      expect(readAvailabilityState(teamHome)).toBe(1);
      expect(readAvailabilityState(process.env.CODEX_HOME)).toBeUndefined();
      expect(inspectCodexRotation(process.env, { storePath: store }).currentHome).toBe(teamHome);
      expect(output.some((line) => line.includes('to=1'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      if (prior.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prior.state;
      if (prior.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior.home;
      if (prior.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prior.xdg;
      if (prior.account === undefined) delete process.env.ELANOUS_CODEX_ACCOUNT; else process.env.ELANOUS_CODEX_ACCOUNT = prior.account;
      if (prior.accountHome === undefined) delete process.env.ELANOUS_CODEX_ACCOUNT_HOME; else process.env.ELANOUS_CODEX_ACCOUNT_HOME = prior.accountHome;
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test('⛔ A 가 찼고 team 이 안 찼으면 «team 으로» 넘어간다 (실물 스토어·신호)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rotate-wire-'));
    const priorState = process.env.ELANOUS_STATE_DIR;
    const priorStateSource = process.env.ELANOUS_STATE_DIR_SOURCE;
    const priorHome = process.env.CODEX_HOME;
    try {
      process.env.ELANOUS_STATE_DIR = root;
      delete process.env.ELANOUS_STATE_DIR_SOURCE;
      const homeA = join(root, 'home-A');
      const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;

      const { saveTokens } = await import('../../src/oauth/store');
      const store = join(root, 'auth.json');
      const t = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', t, { mirrorCodex: false, codexHome: homeA }, store);
      saveTokens('openai-codex:team', t, { mirrorCodex: false, codexHome: homeB }, store);

      const { writeQuotaSignal } = await import('../../src/budget/codex-reset-credit-state');
      writeQuotaSignal('rate_limit_reached', homeA);   // A 는 찼다
      writeQuotaSignal(undefined, homeB);              // B 는 안 찼다

      const { resolveCodexAccountForRun } = await import('../../src/oauth/codex-account-store');
      const picked = resolveCodexAccountForRun({} as NodeJS.ProcessEnv, { storePath: store });
      expect(picked.name).toBe('team');
      expect(picked.storeKey).toBe('openai-codex:team');
      expect(picked.source).toBe('rotated');

      // ⛔ 그리고 사람이 «명시»하면 안 넘어간다 — 같은 상태에서
      const explicit = resolveCodexAccountForRun(
        { ELANOUS_CODEX_ACCOUNT: 'default' } as NodeJS.ProcessEnv, { storePath: store });
      expect(explicit.name).toBe('default');
    } finally {
      if (priorState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = priorState;
      if (priorStateSource === undefined) delete process.env.ELANOUS_STATE_DIR_SOURCE; else process.env.ELANOUS_STATE_DIR_SOURCE = priorStateSource;
      if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

// ⛔⭐⭐⭐ 리뷰 must-fix — 위 배선 테스트도 «판정 셸»까지만 간다.
//   「회전된 계정의 토큰이 실제로 갱신되고 «그 계정의 홈»으로 미러되는가」는 진입점을 통과해야 답한다.
describe('진입점 — loadFreshCodexAuthState 가 «넘어간 계정»으로 갱신·미러한다', () => {
  const { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');

  const jwt = (expSec: number, tag: string): string => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64({ exp: expSec, tag })}.sig`;
  };

  test('⛔ A 가 찼으면 team 의 토큰으로 갱신하고, 미러는 «team 의 홈»으로만 간다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rotate-entry-'));
    const prior = { state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME, xdg: process.env.XDG_CONFIG_HOME, run: process.env.ELANOUS_RUN_ID };
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.XDG_CONFIG_HOME = root;          // 정본 스토어를 격리로
      process.env.ELANOUS_RUN_ID = 'run-rotate-test';
      const homeA = join(root, 'home-A'); const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;

      const { saveTokens, loadTokens } = await import('../../src/oauth/store');
      const nowSec = Math.floor(Date.now() / 1000);
      // A · team 둘 다 「곧 만료」 — 갱신이 돌게 한다
      saveTokens('openai-codex', { accessToken: jwt(nowSec + 30, 'A'), refreshToken: 'A-R', expiresAt: Date.now() + 30_000 },
        { authMode: 'chatgpt', mirrorCodex: false, codexHome: homeA });
      saveTokens('openai-codex:team', { accessToken: jwt(nowSec + 30, 'B'), refreshToken: 'B-R', expiresAt: Date.now() + 30_000 },
        { authMode: 'chatgpt', mirrorCodex: false, codexHome: homeB });
      // Refresh responses do not include id_token, so mirror only a pre-existing
      // Codex CLI auth.json and preserve its CLI-owned fields while rotating tokens.
      writeFileSync(join(homeB, 'auth.json'), JSON.stringify({
        OPENAI_API_KEY: null,
        auth_mode: 'chatgpt',
        tokens: { id_token: 'team-id-token', account_id: 'team-account', access_token: 'old', refresh_token: 'old-r' },
      }));

      const { writeQuotaSignal } = await import('../../src/budget/codex-reset-credit-state');
      writeQuotaSignal('rate_limit_reached', homeA);
      writeQuotaSignal(undefined, homeB);

      const { _resetCodexRotationPinForTesting } = await import('../../src/oauth/codex-account-store');
      _resetCodexRotationPinForTesting();

      const calls: Array<Record<string, unknown>> = [];
      const fetchImpl: any = async (_u: string, init: any) => {
        calls.push(Object.fromEntries(new URLSearchParams(init.body as string).entries()));
        return { status: 200, json: async () => ({ access_token: jwt(nowSec + 3600, 'NEW'), refresh_token: 'NEW-R', expires_in: 3600 }) };
      };
      const { loadFreshCodexAuthState } = await import('../../src/oauth/codex');
      await loadFreshCodexAuthState({ fetchImpl });

      // ⭐ team 의 refresh 토큰으로 갱신했다 — A 의 것이 아니다
      expect(calls[0].refresh_token).toBe('B-R');
      // ⭐ 영속도 team 키로 갔고 A 는 그대로다
      expect(loadTokens('openai-codex:team')?.tokens.refreshToken).toBe('NEW-R');
      expect(loadTokens('openai-codex')?.tokens.refreshToken).toBe('A-R');
      // ⭐ 미러는 team 의 홈에만 — A 의 홈은 «안 생겼다»
      expect(JSON.parse(readFileSync(join(homeB, 'auth.json'), 'utf8')).tokens.refresh_token).toBe('NEW-R');
      expect(() => readFileSync(join(homeA, 'auth.json'), 'utf8')).toThrow();
    } finally {
      _restore(prior);
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
      const { _resetCodexRotationPinForTesting } = await import('../../src/oauth/codex-account-store');
      _resetCodexRotationPinForTesting();
    }
  });

  test('⛔ 한 런은 «한 계정» — 도중에 신호가 바뀌어도 안 갈아탄다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rotate-pin-'));
    const prior = { state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME, xdg: process.env.XDG_CONFIG_HOME, run: process.env.ELANOUS_RUN_ID };
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.ELANOUS_RUN_ID = 'run-pin-test';
      const homeA = join(root, 'home-A'); const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;

      const { saveTokens } = await import('../../src/oauth/store');
      const store = join(root, 'auth.json');
      const t = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', t, { mirrorCodex: false, codexHome: homeA }, store);
      saveTokens('openai-codex:team', t, { mirrorCodex: false, codexHome: homeB }, store);

      const { writeQuotaSignal } = await import('../../src/budget/codex-reset-credit-state');
      const { resolveCodexAccountForRun, _resetCodexRotationPinForTesting } = await import('../../src/oauth/codex-account-store');
      _resetCodexRotationPinForTesting();

      writeQuotaSignal('rate_limit_reached', homeA);
      expect(resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('team');

      // 런 «도중»에 신호가 뒤집혀도 — 같은 런은 같은 계정이어야 한다
      writeQuotaSignal(undefined, homeA);
      expect(resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('team');
    } finally {
      _restore(prior);
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
      const { _resetCodexRotationPinForTesting } = await import('../../src/oauth/codex-account-store');
      _resetCodexRotationPinForTesting();
    }
  });
});

function _restore(p: { state?: string; home?: string; xdg?: string; run?: string }): void {
  const set = (k: string, v?: string) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('ELANOUS_STATE_DIR', p.state); set('CODEX_HOME', p.home); set('XDG_CONFIG_HOME', p.xdg); set('ELANOUS_RUN_ID', p.run);
}

// ⛔ 리뷰 should-fix — 종전엔 «주입한» rotationEnabled 만 물어서, 「config 가 실제로 그 값을
//   만드는가」와 「설정 읽기가 실패하면 ON 인가」를 안 봤다. 배선 회귀를 못 잡는다.
describe('config 배선 — 기본 ON · false 로만 꺼진다 · 읽기 실패해도 ON', () => {
  test('⛔ 설정 읽기가 «던져도» 회전은 켜진 채로 남는다 — 설정 하나가 LLM 경로를 멈추면 안 된다', async () => {
    const { codexAccountRotationEnabled } = await import('../../src/oauth/codex-account-rotation');
    expect(codexAccountRotationEnabled(() => { throw new Error('config 손상'); })).toBe(true);
  });

  test('⭐ 미설정·true 는 ON · «false 만» 끈다', async () => {
    const { codexAccountRotationEnabled } = await import('../../src/oauth/codex-account-rotation');
    expect(codexAccountRotationEnabled(() => ({}))).toBe(true);
    expect(codexAccountRotationEnabled(() => ({ llm: {} }))).toBe(true);
    expect(codexAccountRotationEnabled(() => ({ llm: { codexAccountRotation: true } }))).toBe(true);
    expect(codexAccountRotationEnabled(() => ({ llm: { codexAccountRotation: false } }))).toBe(false);
  });

  test('⭐ config 값 → enabled 매핑 — false 만 끈다', async () => {
    const { decideCodexRotation } = await import('../../src/oauth/codex-account-rotation');
    const inp = {
      current: { name: 'default', storeKey: 'openai-codex', home: '/h/A', source: 'default' as const },
      explicit: false, currentReached: true as boolean | undefined,
      resetCreditAvailability: 'unavailable' as const,
      candidates: [{ name: 'team', storeKey: 'openai-codex:team', home: '/h/B', reached: undefined }],
    };
    // undefined(미설정)·true 는 ON — 이 매핑이 `!== false` 계약이다
    for (const v of [undefined, true]) {
      expect(decideCodexRotation({ ...inp, enabled: v !== false }).reason).toBe('rotated');
    }
    expect(decideCodexRotation({ ...inp, enabled: false }).reason).toBe('disabled');
  });
});

describe('계정별 임계 설정 배선 — store 판정에 전달된다', () => {
  const { mkdtempSync, rmSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');

  test('default 핀은 60%에 해제되어 다른 계정으로 넘어간다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rotation-default-pin-'));
    const prior = { state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME, run: process.env.ELANOUS_RUN_ID };
    const storeModule = await import('../../src/oauth/codex-account-store');
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.ELANOUS_RUN_ID = 'run-default-60-pin';
      const homeA = join(root, 'home-A'); const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;
      const store = join(root, 'auth.json');
      const { saveTokens } = await import('../../src/oauth/store');
      const token = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', token, { mirrorCodex: false, codexHome: homeA }, store);
      saveTokens('openai-codex:team', token, { mirrorCodex: false, codexHome: homeB }, store);
      const { writeQuotaSignal } = await import('../../src/budget/codex-reset-credit-state');
      storeModule._setRotationConfigReaderForTesting(() => ({}));
      storeModule._resetCodexRotationPinForTesting();
      writeQuotaSignal(undefined, 59, homeA);
      writeQuotaSignal(undefined, 0, homeB);
      expect(storeModule.resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('default');
      writeQuotaSignal(undefined, 60, homeA);
      expect(storeModule.inspectCodexRotation(process.env, { storePath: store }).thresholdPercent).toBe(60);
      expect(storeModule.resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('team');
    } finally {
      storeModule._setRotationConfigReaderForTesting(null);
      storeModule._resetCodexRotationPinForTesting();
      _restore(prior);
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test('⭐ 현재 계정 override는 회전시키고, 명시된 다른 임계는 default 기본값보다 우선한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rotation-threshold-by-account-'));
    const prior = { state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME, run: process.env.ELANOUS_RUN_ID };
    const storeModule = await import('../../src/oauth/codex-account-store');
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.ELANOUS_RUN_ID = 'run-threshold-by-account';
      const homeA = join(root, 'home-A'); const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;
      const store = join(root, 'auth.json');
      const { saveTokens } = await import('../../src/oauth/store');
      const token = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', token, { mirrorCodex: false, codexHome: homeA }, store);
      saveTokens('openai-codex:team', token, { mirrorCodex: false, codexHome: homeB }, store);
      const { writeQuotaSignal } = await import('../../src/budget/codex-reset-credit-state');
      writeQuotaSignal(undefined, 80, homeA);
      writeQuotaSignal(undefined, 10, homeB);

      storeModule._setRotationConfigReaderForTesting(() => ({ llm: {
        codexAccountRotationThresholdPercent: 95,
        codexAccountRotationThresholdPercentByAccount: { default: 80 },
      } }));
      storeModule._resetCodexRotationPinForTesting();
      expect(storeModule.resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('team');

      storeModule._setRotationConfigReaderForTesting(() => ({ llm: {
        codexAccountRotationThresholdPercent: 95,
        codexAccountRotationThresholdPercentByAccount: { default: 95, team: 80 },
      } }));
      storeModule._resetCodexRotationPinForTesting();
      expect(storeModule.resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('default');
    } finally {
      storeModule._setRotationConfigReaderForTesting(null);
      storeModule._resetCodexRotationPinForTesting();
      _restore(prior);
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

// ⛔⭐⭐⭐ 리뷰 must-fix — 표면(`account list`)이 회전 «전» 값을 찍으면, 리밋으로 넘어간 뒤에도
//   사람에게 옛 계정을 말한다. `#7135` 4R 에 고쳤던 「표면과 런타임이 갈린다」의 재발이다.
describe('표면 — 회전까지 반영해서 말한다', () => {
  const { mkdtempSync, rmSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');

  test('⛔ 넘어갔으면 표면도 team ⊕ source=rotated 를 말한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rotate-view-'));
    const prior = { state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME, run: process.env.ELANOUS_RUN_ID };
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.ELANOUS_RUN_ID = 'run-view-test';
      const homeA = join(root, 'home-A'); const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;

      const { saveTokens } = await import('../../src/oauth/store');
      const store = join(root, 'auth.json');
      const t = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', t, { mirrorCodex: false, codexHome: homeA }, store);
      saveTokens('openai-codex:team', t, { mirrorCodex: false, codexHome: homeB }, store);

      const { writeQuotaSignal } = await import('../../src/budget/codex-reset-credit-state');
      writeQuotaSignal('rate_limit_reached', homeA);
      writeQuotaSignal(undefined, homeB);

      const { activeCodexAccountView, _resetCodexRotationPinForTesting } = await import('../../src/oauth/codex-account-store');
      _resetCodexRotationPinForTesting();
      const view = activeCodexAccountView(process.env, store);
      expect(view.name).toBe('team');                 // ⛔ 종전 표면은 'default' 를 말했다
      expect(view.source).toBe('rotated');            // 「사람이 골랐다」가 아니다
      expect(view.home).toBe(homeB);                  // 실효 홈도 넘어간 계정의 것
    } finally {
      _restore(prior);
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
      const { _resetCodexRotationPinForTesting } = await import('../../src/oauth/codex-account-store');
      _resetCodexRotationPinForTesting();
    }
  });
});

// ⛔⭐⭐⭐ 리뷰 must-fix — 표면이 «설정을 안 읽고» 회전을 켜면, config false 인데도 표면이 먼저
//   회전·핀하고 런타임이 그 핀을 재사용한다 ⇒ 설정이 «표면 경유»로 무력화된다.
//   순수 매핑 테스트로는 이 경로를 못 잡는다 — 실물 표면 → 핀 → 진입점으로 문다.
describe('config false — 표면 경유로도 «무력화되지 않는다»', () => {
  const { mkdtempSync, rmSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');

  test('⛔ codexAccountRotation:false 면 «표면을 먼저 불러도» 넘어가지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rotate-off-'));
    const prior = { state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME, run: process.env.ELANOUS_RUN_ID };
    const store2 = await import('../../src/oauth/codex-account-store');
    const originalLog = debug.log;
    const payloads: Array<Record<string, unknown>> = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'oauth.codex-account' && event === 'rotation') payloads.push(data);
    }) as typeof debug.log;
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.ELANOUS_RUN_ID = 'run-off-test';
      const homeA = join(root, 'home-A'); const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;

      const { saveTokens } = await import('../../src/oauth/store');
      const store = join(root, 'auth.json');
      const t = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', t, { mirrorCodex: false, codexHome: homeA }, store);
      saveTokens('openai-codex:team', t, { mirrorCodex: false, codexHome: homeB }, store);

      const { writeQuotaSignal } = await import('../../src/budget/codex-reset-credit-state');
      writeQuotaSignal('rate_limit_reached', homeA);
      writeQuotaSignal(undefined, homeB);

      // 설정이 «꺼짐»이라고 말한다
      store2._setRotationConfigReaderForTesting(() => ({ llm: { codexAccountRotation: false } }));

      const { activeCodexAccountView, resolveCodexAccountForRun, _resetCodexRotationPinForTesting } =
        await import('../../src/oauth/codex-account-store');
      _resetCodexRotationPinForTesting();

      // ⭐ 표면을 «먼저» 부른다 — 종전엔 여기서 회전·핀이 박혔다
      expect(activeCodexAccountView(process.env, store).name).toBe('default');
      // ⭐ 그리고 런타임도 그대로다(핀 재사용으로도 안 넘어간다)
      expect(resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('default');
      expect(payloads).toEqual([
        { from: 'default', to: undefined, reason: 'disabled', candidateCount: 'unknown', disabledProvenance: 'explicit-false' },
        { from: 'default', to: undefined, reason: 'disabled', candidateCount: 'unknown', disabledProvenance: 'explicit-false' },
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
      store2._setRotationConfigReaderForTesting(null);
      _restore(prior);
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
      const { _resetCodexRotationPinForTesting } = await import('../../src/oauth/codex-account-store');
      _resetCodexRotationPinForTesting();
    }
  });
});

// ⛔⭐⭐ 리뷰 must-fix — 종전엔 codex.ts 가 설정을 «다시 읽어» 주입해서, 「설정 읽기는 해석기 안
//   한 자리」라는 배선을 호출자가 스스로 깼다. 그 우회가 사라졌는지는 «진입점»에서 물어야 한다.
describe('진입점도 config false 를 지킨다 — 호출자가 설정을 다시 읽지 않는다', () => {
  const { mkdtempSync, rmSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');

  test('⛔ config false 면 loadFreshCodexAuthState 도 «기본 계정»의 토큰을 쓴다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rotate-entry-off-'));
    const prior = { state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME, xdg: process.env.XDG_CONFIG_HOME, run: process.env.ELANOUS_RUN_ID };
    const store2 = await import('../../src/oauth/codex-account-store');
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.XDG_CONFIG_HOME = root;
      process.env.ELANOUS_RUN_ID = 'run-entry-off';
      const homeA = join(root, 'home-A'); const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;

      const { saveTokens } = await import('../../src/oauth/store');
      const nowSec = Math.floor(Date.now() / 1000);
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const jwt = (exp: number, tag: string) => `${b64({ alg: 'none' })}.${b64({ exp, tag })}.sig`;
      saveTokens('openai-codex', { accessToken: jwt(nowSec + 30, 'A'), refreshToken: 'A-R', expiresAt: Date.now() + 30_000 },
        { authMode: 'chatgpt', mirrorCodex: false, codexHome: homeA });
      saveTokens('openai-codex:team', { accessToken: jwt(nowSec + 30, 'B'), refreshToken: 'B-R', expiresAt: Date.now() + 30_000 },
        { authMode: 'chatgpt', mirrorCodex: false, codexHome: homeB });

      const { writeQuotaSignal } = await import('../../src/budget/codex-reset-credit-state');
      writeQuotaSignal('rate_limit_reached', homeA);   // A 는 찼다 — 켜져 있으면 넘어갈 상황
      writeQuotaSignal(undefined, homeB);

      store2._setRotationConfigReaderForTesting(() => ({ llm: { codexAccountRotation: false } }));
      store2._resetCodexRotationPinForTesting();

      const calls: string[] = [];
      const fetchImpl: any = async (_u: string, init: any) => {
        calls.push(String(new URLSearchParams(init.body as string).get('refresh_token')));
        return { status: 200, json: async () => ({ access_token: jwt(nowSec + 3600, 'N'), refresh_token: 'N-R', expires_in: 3600 }) };
      };
      const { loadFreshCodexAuthState } = await import('../../src/oauth/codex');
      await loadFreshCodexAuthState({ fetchImpl, mirrorCodex: false });
      // ⛔ 꺼져 있으므로 A 의 토큰으로 갱신해야 한다 — 종전 우회에서는 B-R 이 나갔다
      expect(calls[0]).toBe('A-R');
    } finally {
      store2._setRotationConfigReaderForTesting(null);
      store2._resetCodexRotationPinForTesting();
      _restore(prior);
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

// ⛔⭐⭐ 리뷰 should-fix — 종전 기본 reader 는 `require()` 였다. ESM 에서 그것이 «없으면»
//   fail-soft 가 예외를 삼켜 ***config false 가 영영 무시된다*** — 노브가 no-op 이 된다.
//   ⇒ 주입한 reader 만 무는 테스트로는 그 경로를 «원리상» 못 본다. 실제 기본 reader 를 문다.
describe('기본 설정 reader — «실제 설정 파일»을 읽어 false 가 먹는다', () => {
  const { mkdtempSync, rmSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');

  test('⛔ 던지지 않는다 — 기본 reader 가 실제로 읽힌다(종전 require() 는 ESM 에서 없을 수 있었다)', async () => {
    const store2 = await import('../../src/oauth/codex-account-store');
    store2._setRotationConfigReaderForTesting(null);
    const { codexAccountRotationEnabled } = await import('../../src/oauth/codex-account-rotation');
    const { getUserConfig } = await import('../../src/user-config');
    expect(typeof codexAccountRotationEnabled(getUserConfig)).toBe('boolean');
  });

  test('⭐ 실제 설정 파일에 false 를 쓰면 «판정도 false» — 동어반복이 아니라 파일→판정을 문다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-rot-'));
    try {
      const file = join(dir, 'config.json');
      writeFileSync(file, JSON.stringify({ llm: { provider: 'openai-codex', codexAccountRotation: false } }));
      const { getUserConfig } = await import('../../src/user-config');
      const { codexAccountRotationEnabled } = await import('../../src/oauth/codex-account-rotation');
      expect(codexAccountRotationEnabled(() => getUserConfig(file))).toBe(false);

      writeFileSync(file, JSON.stringify({ llm: { provider: 'openai-codex' } }));   // 미설정 → ON
      expect(codexAccountRotationEnabled(() => getUserConfig(file))).toBe(true);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

// ⛔⭐ 리뷰 should-fix — 위 테스트는 `getUserConfig` 를 helper 에 «직접» 넘겨서, 모듈의 «기본
//   configReader 배선»은 안 탄다. 그 배선이 끊겨도(예: 다시 require 로 회귀) 못 잡는다.
//   ⇒ 심을 «비우고» 해석기를 실제로 돌려 기본 경로가 도는지 문다.
describe('기본 configReader 배선 — 심 없이 해석기가 실제로 돈다', () => {
  const { mkdtempSync, rmSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');

  test('⛔ 심 없이도 회전 판정이 «던지지 않고» 실제 설정(미설정=ON)대로 넘어간다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rot-default-reader-'));
    const prior = { state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME, run: process.env.ELANOUS_RUN_ID };
    const store2 = await import('../../src/oauth/codex-account-store');
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.ELANOUS_RUN_ID = 'run-default-reader';
      const homeA = join(root, 'home-A'); const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;

      const { saveTokens } = await import('../../src/oauth/store');
      const s = join(root, 'auth.json');
      const t = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', t, { mirrorCodex: false, codexHome: homeA }, s);
      saveTokens('openai-codex:team', t, { mirrorCodex: false, codexHome: homeB }, s);
      const { writeQuotaSignal } = await import('../../src/budget/codex-reset-credit-state');
      writeQuotaSignal('rate_limit_reached', homeA);
      writeQuotaSignal(undefined, homeB);

      store2._setRotationConfigReaderForTesting(null);   // ⭐ 심 «없음» — 기본 배선을 탄다
      store2._resetCodexRotationPinForTesting();
      // 이 머신의 실제 설정은 미설정(=ON)이다 ⇒ 넘어가야 한다. 던지면 그 자체가 배선 결함이다.
      expect(store2.resolveCodexAccountForRun(process.env, { storePath: s }).name).toBe('team');
    } finally {
      store2._setRotationConfigReaderForTesting(null);
      store2._resetCodexRotationPinForTesting();
      _restore(prior);
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

// ⛔⭐⭐⭐⭐⭐ 2026-08-07 — **회전이 «경로 B»(codex 바이너리)에 안 닿아 유료 크레딧이 나가던 자리.**
//   RFC §8 ⑴ 이 경로 둘을 갈라 놨는데, 회전은 경로 A(API)만 바꾸고 있었다.
//   ⇒ ACP 자식이 리밋 걸린 계정으로 계속 쐈고, 그 계정에 잔액이 있으면 «유료»로 나간다.
describe('회전이 자식 env 로 따라간다 — 크레딧 유출 차단', () => {
  test('✅ 회전했으면 그 홈을 CODEX_HOME 으로 낸다', () => {
    expect(rotatedChildEnv('rotated', '/h/team')).toEqual({ CODEX_HOME: '/h/team' });
  });

  test('✅ reset-credit-unknown으로 고른 후보의 홈을 자식에 낸다', () => {
    const decision = decideCodexRotation({ ...base, resetCreditAvailability: 'unknown', candidates: [cand('team', undefined)] });
    const resolved = applyRotation(current, decision);
    expect(decision.reason).toBe('reset-credit-unknown');
    expect(rotatedChildEnv(resolved.source, resolved.home)).toEqual({ CODEX_HOME: '/h/team' });
  });

  test('✅ no-switch 결과도 실제로 유지한 계정의 홈을 자식에 낸다', () => {
    for (const decision of [
      decideCodexRotation({ ...base, currentReached: undefined, currentUsedPercent: 9, candidates: [cand('team', undefined)] }),
      decideCodexRotation({ ...base, enabled: false, candidates: [cand('team', undefined)] }),
      decideCodexRotation({ ...base, candidates: [] }),
    ]) {
      const resolved = applyRotation(current, decision);
      expect(resolved).toEqual(current);
      expect(rotatedChildEnv(resolved.source, resolved.home)).toEqual({ CODEX_HOME: '/h/A' });
    }
  });

  // ⛔ 모르는 곳으로 자식을 보내지 않는다 — 회전 «후보» 규칙(홈 모르면 후보 아님)과 같은 규율.
  test('⛔ 계정 출처와 무관하게 홈을 모르면 자식에 내지 않는다', () => {
    expect(rotatedChildEnv('rotated', undefined)).toEqual({});
    expect(rotatedChildEnv('default', '')).toEqual({});
    expect(rotatedChildEnv('env', '   ')).toEqual({});
  });

  test('⭐ 앞뒤 공백은 다듬어 낸다 — 자식 env 에 깨진 경로를 싣지 않는다', () => {
    expect(rotatedChildEnv('default', '  /h/A  ')).toEqual({ CODEX_HOME: '/h/A' });
  });
});

// ⛔⭐⭐⭐⭐⭐ **배선 시험** — 리뷰 must-fix.
//   위의 순수 함수 시험은 「그 함수가 옳은가」만 답하고 ***「그 함수가 실행 경로에 있는가」는
//   구조적으로 못 답한다*** — ACP spawn 한 줄을 지워도 전부 통과한다(Goodhart).
//   ⇒ 그래서 «주입한 spawn 팩토리»가 실제로 받는 env 를 문다.
describe('배선 — ACP 자식이 «실제로» 회전된 홈을 받는다', () => {
  const { mkdtempSync, mkdirSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');

  /** 회전이 서도록 격리 우주를 세우고, spawn 이 받은 env 를 잡아 돌려준다.
   *  `rotate:false` 면 A 도 «안 찼다»로 두어 회전이 «안 서는» 경우를 만든다. */
  async function captureSpawnEnv(
    agentEnv?: Record<string, string>,
    opts: { rotate?: boolean } = {},
  ): Promise<Record<string, string> | undefined> {
    const root = mkdtempSync(join(tmpdir(), 'rotate-acp-'));
    const prior = { state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME, xdg: process.env.XDG_CONFIG_HOME, run: process.env.ELANOUS_RUN_ID };
    try {
      process.env.ELANOUS_STATE_DIR = root;
      process.env.XDG_CONFIG_HOME = root;
      delete process.env.ELANOUS_RUN_ID;
      const homeA = join(root, 'home-A'); const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;

      const { saveTokens } = await import('../../src/oauth/store');
      const t = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', t, { authMode: 'chatgpt', mirrorCodex: false, codexHome: homeA });
      saveTokens('openai-codex:team', t, { authMode: 'chatgpt', mirrorCodex: false, codexHome: homeB });

      const { writeQuotaSignal } = await import('../../src/budget/codex-reset-credit-state');
      writeQuotaSignal(opts.rotate === false ? undefined : 'rate_limit_reached', homeA);
      writeQuotaSignal(undefined, homeB);              // B 는 안 찼다

      const { _resetCodexRotationPinForTesting } = await import('../../src/oauth/codex-account-store');
      _resetCodexRotationPinForTesting();

      const { CodexAppServerAgent } = await import('../../src/acp/codex-app-server-agent');
      let seen: Record<string, string> | undefined;
      const agent = new CodexAppServerAgent({
        backendId: 'codex-app-server',
        cwd: root,
        ...(agentEnv ? { env: agentEnv } : {}),
        // ⛔ spawn 을 «잡고» 던진다 — 실제 codex 바이너리를 띄우지 않는다.
        _spawnFactory: ((opts: { env?: Record<string, string> }) => {
          seen = opts.env;
          throw new Error('captured');
        }) as never,
      } as never);
      // newSession() 이 doStart() 를 태운다. 팩토리가 던지므로 여기서 거부되고, 그건 «예정된» 것이다.
      await (agent as { newSession(): Promise<unknown> }).newSession().catch(() => {});
      return seen;
    } finally {
      _restore(prior);
      const { _resetCodexRotationPinForTesting } = await import('../../src/oauth/codex-account-store');
      _resetCodexRotationPinForTesting();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  test('✅ 회전이 섰으면 spawn 이 받는 env 에 «team 의 홈»이 실린다', async () => {
    const env = await captureSpawnEnv();
    expect(env?.CODEX_HOME).toMatch(/home-B$/);
  });

  // ⛔ 리뷰 must-fix ② — 해석 입력이 process.env 뿐이면 이 명시를 «못 보고» 결정 ③ 이 뚫린다.
  test('⛔ 호출자가 env 로 계정을 «명시»하면 회전이 그 자식에 안 실린다 — 의도가 이긴다', async () => {
    const env = await captureSpawnEnv({ ELANOUS_CODEX_ACCOUNT: 'default' });
    expect(env?.CODEX_HOME).toMatch(/home-A$/);
    expect(env?.ELANOUS_CODEX_ACCOUNT).toBe('default');
  });

  test('✅ 회전이 «안 서면» 자식은 유지 계정의 홈을 받는다', async () => {
    const env = await captureSpawnEnv(undefined, { rotate: false });
    expect(env?.CODEX_HOME).toMatch(/home-B$/);
  });
});

// ⛔⭐⭐⭐⭐ **조회가 판정을 «오염»시키면 안 된다** (`G2` · 2026-08-07).
//   `resolveCodexAccountForRun` 은 부를 때마다 `rotation` 관측을 «쓴다». 그래서 조회 명령이
//   그것을 부르면 ***사람이 상태를 볼 때마다 회전 통계가 늘어난다*** — 운영자는 그 수로
//   「회전이 도나」를 읽으므로, 판정층이 피판정층을 오염시키는 형태다.
//   ⇒ `inspectCodexRotation` 은 «같은 답»을 내되 관측도 고정도 안 한다.
describe('조회 전용 회전 판정 — 관측·고정을 «안» 한다', () => {
  const { mkdtempSync, mkdirSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');

  test('⭐ 실행 경로와 «같은 답»을 내고, 관측은 «하나도» 안 남긴다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rotate-inspect-'));
    const prior = { state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME, xdg: process.env.XDG_CONFIG_HOME, run: process.env.ELANOUS_RUN_ID };
    try {
      process.env.ELANOUS_STATE_DIR = root;
      delete process.env.ELANOUS_RUN_ID;
      const homeA = join(root, 'home-A'); const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;

      const { saveTokens } = await import('../../src/oauth/store');
      const store = join(root, 'auth.json');
      const t = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', t, { mirrorCodex: false, codexHome: homeA }, store);
      saveTokens('openai-codex:team', t, { mirrorCodex: false, codexHome: homeB }, store);

      const { writeQuotaSignal } = await import('../../src/budget/codex-reset-credit-state');
      writeQuotaSignal('rate_limit_reached', homeA);
      writeQuotaSignal(undefined, homeB);

      const store2 = await import('../../src/oauth/codex-account-store');
      store2._resetCodexRotationPinForTesting();
      // ⛔⭐ config 도 «격리»한다(리뷰 must-fix) — 안 하면 실제 사용자 설정
      //   (`codexAccountRotation:false` 등)에 따라 이 시험이 «사람마다» 달라진다.
      store2._setRotationConfigReaderForTesting(() => ({}));

      // ⭐ 관측을 «세어» 본다 — debug.log 를 잡는다
      const { debug } = await import('../../src/debug/log');
      // ⛔ `debug.log` 는 «메서드»다 — 바인딩 없이 부르면 this 를 잃고 던진다(내가 처음에 그랬다).
      const originalUnbound = debug.log;
      const original = debug.log.bind(debug);
      let rotationLogs = 0;
      (debug as { log: typeof debug.log }).log = ((cat: string, ev: string, ...rest: unknown[]) => {
        if (cat === 'oauth.codex-account' && ev === 'rotation') rotationLogs += 1;
        return (original as (...a: unknown[]) => unknown)(cat, ev, ...rest);
      }) as typeof debug.log;
      try {
        // ⛔⭐ 셋을 «각각 독립»으로 문다(리뷰 must-fix) — 중간에 카운터를 리셋하면
        //   「inspect 가 관측·핀을 둘 다 남겨도 통과」하는 Goodhart 가 된다.

        // ① inspect «직후» — 관측 0건
        rotationLogs = 0;
        const seen = store2.inspectCodexRotation(process.env, { storePath: store });
        expect(rotationLogs).toBe(0);
        expect(seen.reason).toBe('reset-credit-unknown');
        expect(seen.to).toBe('team');
        expect(seen.current.name).toBe('default');

        // ② resolve «직후» — 관측 1건 (대조군: 실행 경로는 «남긴다»)
        rotationLogs = 0;
        store2._resetCodexRotationPinForTesting();
        const actual = store2.resolveCodexAccountForRun(process.env, { storePath: store });
        expect(rotationLogs).toBe(1);
        // ⭐ 그리고 «같은 답»인지 반환값으로 직접 대조한다 — 로그 수만 보면 갈려도 통과한다
        expect(actual.name).toBe(seen.to as string);
        expect(actual.source).toBe('rotated');

        // ③ inspect 는 «핀도» 안 만든다 — 런 신원을 주고 inspect 한 뒤,
        //    실행 경로가 여전히 «재판정»하는지(=핀이 없어 관측을 낸다) 로 확인한다.
        process.env.ELANOUS_RUN_ID = 'run-inspect-should-not-pin';
        store2._resetCodexRotationPinForTesting();
        rotationLogs = 0;
        store2.inspectCodexRotation(process.env, { storePath: store });
        expect(rotationLogs).toBe(0);
        store2.resolveCodexAccountForRun(process.env, { storePath: store });
        expect(rotationLogs).toBe(1);          // 핀이 없었으므로 재판정했다
        store2.resolveCodexAccountForRun(process.env, { storePath: store });
        expect(rotationLogs).toBe(1);          // 이번엔 «실행 경로»가 만든 핀을 읽어 조용하다
      } finally {
        (debug as { log: typeof debug.log }).log = originalUnbound;
      }
    } finally {
      _restore(prior);
      const store2 = await import('../../src/oauth/codex-account-store');
      store2._setRotationConfigReaderForTesting(null);
      store2._resetCodexRotationPinForTesting();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

describe('Codex 계정 이벤트 outbound', () => {
  const { mkdtempSync, mkdirSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');

  test('기본 sender는 ESM 정적 import의 기존 sendOutbound 경로를 호출한다', async () => {
    defaultOutboundCalls.length = 0;
    const store2 = await import('../../src/oauth/codex-account-store');
    store2._setCodexAccountOutboundSenderForTesting(null);
    store2.notifyCodexResetCreditConsumed({ name: 'team' }, 2, { storePath: join(tmpdir(), 'no-codex-account-store') });
    expect(defaultOutboundCalls).toHaveLength(1);
    expect(defaultOutboundCalls[0].kind).toBe('alert');
    expect(defaultOutboundCalls[0].text).toContain('account: team');
  });

  test('회전·리셋 소비에만 사용량 스냅샷을 보내고 실패해도 업무 결과를 보존한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-account-outbound-'));
    const prior = { state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME };
    const sent: string[] = [];
    try {
      process.env.ELANOUS_STATE_DIR = root;
      const homeA = join(root, 'home-A'); const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;
      const { saveTokens } = await import('../../src/oauth/store');
      const { writeQuotaSignal, writeAvailabilityState } = await import('../../src/budget/codex-reset-credit-state');
      const store = join(root, 'auth.json');
      const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', tokens, { mirrorCodex: false, codexHome: homeA }, store);
      saveTokens('openai-codex:team', tokens, { mirrorCodex: false, codexHome: homeB }, store);
      writeQuotaSignal('rate_limit_reached', 100, homeA);
      writeQuotaSignal(undefined, 24, homeB);
      writeAvailabilityState(0, homeA);
      writeAvailabilityState(1, homeB);

      const store2 = await import('../../src/oauth/codex-account-store');
      store2._setRotationConfigReaderForTesting(() => ({}));
      store2._setCodexAccountOutboundSenderForTesting((text) => { sent.push(text); return true; });
      store2._resetCodexRotationPinForTesting();
      const rotated = store2.resolveCodexAccountForRun({} as NodeJS.ProcessEnv, { storePath: store });
      expect(rotated.name).toBe('team');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('from: default');
      expect(sent[0]).toContain('to: team');
      expect(sent[0]).toContain('reason: rotated');
      expect(sent[0]).toContain('accountCount: 2');
      expect(sent[0]).toContain('default=100% resetCredit=unavailable');
      expect(sent[0]).toContain('team=24% resetCredit=available');
      // ⛔⭐⭐ **「어디서 읽었나」가 «수 옆에» 있어야 한다**(`OBS-T113`).
      //   🚨 종전엔 `usage: default=unknown team=unknown third=unknown` 한 줄이 사람에게 도달하는
      //     «유일한» 진단이었고, 그 줄로는 ***「낡았나 · 없나 · 다른 우주를 봤나 · 옛 코드인가」***를
      //     원리상 못 갈랐다 — 두 세션이 그 줄 하나로 «세 번» 서로 다른 진단을 냈다.
      expect(sent[0]).toContain(`@ ${quotaSignalDir()}`);

      store2._resetCodexRotationPinForTesting();
      writeQuotaSignal(undefined, 10, homeA);
      store2.resolveCodexAccountForRun({} as NodeJS.ProcessEnv, { storePath: store });
      expect(sent).toHaveLength(1);

      store2.notifyCodexResetCreditConsumed(rotated, 2, { storePath: store });
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('account: team');
      expect(sent[1]).toContain('remaining: 2');
      expect(sent[1]).toContain('accountCount: 2');
      expect(sent[1]).toContain('default=10% resetCredit=unavailable');
      expect(sent[1]).toContain('team=24% resetCredit=available');

      store2._setCodexAccountOutboundSenderForTesting(() => { throw new Error('outbound unavailable'); });
      const { debug } = await import('../../src/debug/log');
      const originalDebugLog = debug.log;
      let outboundFailures = 0;
      (debug as { log: typeof debug.log }).log = ((category: string, event: string, ...rest: unknown[]) => {
        if (category === 'oauth.codex-account' && event === 'outbound-failed') outboundFailures += 1;
        return (originalDebugLog as (...args: unknown[]) => unknown).call(debug, category, event, ...rest);
      }) as typeof debug.log;
      try {
        store2._resetCodexRotationPinForTesting();
        writeQuotaSignal('rate_limit_reached', 100, homeA);
        const stillRotated = store2.resolveCodexAccountForRun({} as NodeJS.ProcessEnv, { storePath: store });
        expect(stillRotated.name).toBe('team');
        expect(() => store2.notifyCodexResetCreditConsumed(stillRotated, 1, { storePath: store })).not.toThrow();
        expect(outboundFailures).toBe(2);
      } finally {
        (debug as { log: typeof debug.log }).log = originalDebugLog;
      }

      store2._setCodexAccountOutboundSenderForTesting((text) => { sent.push(text); return true; });
      let snapshotFailures = 0;
      (debug as { log: typeof debug.log }).log = ((category: string, event: string, ...rest: unknown[]) => {
        if (category === 'oauth.codex-account' && event === 'outbound-failed') snapshotFailures += 1;
        return (originalDebugLog as (...args: unknown[]) => unknown).call(debug, category, event, ...rest);
      }) as typeof debug.log;
      try {
        store2._setCodexAccountUsageSnapshotReaderForTesting(() => {
          throw new Error('usage snapshot unavailable');
        });
        store2._resetCodexRotationPinForTesting();
        writeQuotaSignal('rate_limit_reached', 100, homeA);
        const preservedRotation = store2.resolveCodexAccountForRun({} as NodeJS.ProcessEnv, { storePath: store });
        expect(preservedRotation.name).toBe('team');
        expect(sent).toHaveLength(2);
        expect(snapshotFailures).toBe(1);
      } finally {
        store2._setCodexAccountUsageSnapshotReaderForTesting(null);
        (debug as { log: typeof debug.log }).log = originalDebugLog;
      }
    } finally {
      const store2 = await import('../../src/oauth/codex-account-store');
      store2._setCodexAccountOutboundSenderForTesting(null);
      store2._setCodexAccountUsageSnapshotReaderForTesting(null);
      store2._setRotationConfigReaderForTesting(null);
      store2._resetCodexRotationPinForTesting();
      if (prior.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prior.state;
      if (prior.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior.home;
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  // 대표 2026-08-17: "회전을 끄라는 게 아니라 텔레그램 알림만 끄라고 한 것입니다."
  // 종전엔 노브가 하나뿐이라 알림을 끄면 «회전(= 구독 과금 경로)»까지 죽었다.
  // 이 테스트가 무는 것은 정확히 그 분리다 — 회전은 살고 발송만 죽는다.
  test('llm.codexAccountAlerts:false 는 «발송만» 끄고 회전은 그대로 돈다 (⊕ 억제를 관측에 남긴다)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-alerts-off-'));
    const prior = { state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME };
    const sent: string[] = [];
    try {
      process.env.ELANOUS_STATE_DIR = root;
      const homeA = join(root, 'home-A'); const homeB = join(root, 'home-B');
      mkdirSync(homeA, { recursive: true }); mkdirSync(homeB, { recursive: true });
      process.env.CODEX_HOME = homeA;
      const { saveTokens } = await import('../../src/oauth/store');
      const { writeQuotaSignal, writeAvailabilityState } = await import('../../src/budget/codex-reset-credit-state');
      const store = join(root, 'auth.json');
      const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      saveTokens('openai-codex', tokens, { mirrorCodex: false, codexHome: homeA }, store);
      saveTokens('openai-codex:team', tokens, { mirrorCodex: false, codexHome: homeB }, store);
      writeQuotaSignal('rate_limit_reached', 100, homeA);
      writeAvailabilityState(1, homeB);

      const store2 = await import('../../src/oauth/codex-account-store');
      store2._setCodexAccountOutboundSenderForTesting((text) => { sent.push(text); return true; });

      const { debug } = await import('../../src/debug/log');
      const originalDebugLog = debug.log;
      let suppressed = 0;
      let suppressedKnob: unknown;
      (debug as { log: typeof debug.log }).log = ((category: string, event: string, ...rest: unknown[]) => {
        if (category === 'oauth.codex-account' && event === 'outbound-suppressed') {
          suppressed += 1;
          suppressedKnob = (rest[0] as { knob?: unknown } | undefined)?.knob;
        }
        return (originalDebugLog as (...args: unknown[]) => unknown).call(debug, category, event, ...rest);
      }) as typeof debug.log;

      try {
        // ⓐ 알림만 끈다 — 회전 노브는 «안 건드린다».
        store2._setRotationConfigReaderForTesting(() => ({ llm: { codexAccountAlerts: false } }));
        store2._resetCodexRotationPinForTesting();
        const rotated = store2.resolveCodexAccountForRun({} as NodeJS.ProcessEnv, { storePath: store });
        expect(rotated.name).toBe('team');   // 회전은 «살아 있다»
        expect(sent).toHaveLength(0);         // 발송은 «없다»
        expect(suppressed).toBe(1);           // 그리고 «조용히» 사라지지 않았다
        expect(suppressedKnob).toBe('llm.codexAccountAlerts');

        // ⓑ 리셋-크레딧 알림도 같은 스위치를 따른다.
        store2.notifyCodexResetCreditConsumed(rotated, 2, { storePath: store });
        expect(sent).toHaveLength(0);
        expect(suppressed).toBe(2);

        // ⓒ 기본값은 ON — 칸을 안 주면 종전대로 나간다.
        store2._setRotationConfigReaderForTesting(() => ({}));
        store2._resetCodexRotationPinForTesting();
        const stillRotated = store2.resolveCodexAccountForRun({} as NodeJS.ProcessEnv, { storePath: store });
        expect(stillRotated.name).toBe('team');
        expect(sent).toHaveLength(1);
        expect(suppressed).toBe(2);
      } finally {
        (debug as { log: typeof debug.log }).log = originalDebugLog;
      }
    } finally {
      const store2 = await import('../../src/oauth/codex-account-store');
      store2._setCodexAccountOutboundSenderForTesting(null);
      store2._setRotationConfigReaderForTesting(null);
      store2._resetCodexRotationPinForTesting();
      if (prior.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prior.state;
      if (prior.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior.home;
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

describe('default 계정 60% 는 «상한» — 더 엄한 전역을 따른다 (2026-09-27 지시)', () => {
  test('전역 없음·95 → 60 · 전역 42 → 42 · 계정별 명시가 이긴다 · 다른 계정은 전역', () => {
    expect(codexAccountThresholdPercent('default', {})).toBe(60);
    expect(codexAccountThresholdPercent('default', { thresholdPercent: 95 })).toBe(60);
    expect(codexAccountThresholdPercent('default', { thresholdPercent: 42 })).toBe(42);
    expect(codexAccountThresholdPercent('default', { thresholdPercent: 42, thresholdPercentByAccount: { default: 80 } })).toBe(80);
    expect(codexAccountThresholdPercent('team', { thresholdPercent: 0 })).toBe(95);
  });
});
