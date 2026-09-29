import { describe, expect, test } from 'bun:test';
import { decideCodexRotation } from './codex-account-rotation.js';
describe('크레딧 정책 — 크레딧이 더 남은 계정으로 (09-28)', () => {
  const cand = (name: string, creditBalance?: number, hasCredits?: boolean) => ({
    name, storeKey: `k-${name}`, home: `/h/${name}`, reached: true as const, usedPercent: 100,
    ...(creditBalance === undefined ? {} : { creditBalance }), ...(hasCredits === undefined ? {} : { hasCredits }),
  });
  const base = {
    current: { name: 'default', storeKey: 'openai-codex', home: '/h/default', source: 'default' },
    explicit: false, enabled: true, currentReached: true, currentUsedPercent: 100,
    resetCreditAvailability: 'unavailable', creditsAllowed: true,
  } as const;
  test('지금 계정 크레딧이 바닥나면 가장 많이 남은 계정으로 옮긴다', () => {
    const d = decideCodexRotation({ ...base, currentCreditBalance: 0, currentHasCredits: false, candidates: [cand('team', 29_998, true), cand('third', 25_000, true)] } as never);
    expect(d.reason).toBe('rotated');
    expect(d.to?.name).toBe('team');
  });
  test('다른 계정이 20% 넘게 많으면 옮기고, 비슷하면 머문다(흔들림 방지)', () => {
    expect(decideCodexRotation({ ...base, currentCreditBalance: 20_000, currentHasCredits: true, candidates: [cand('team', 29_998, true)] } as never).to?.name).toBe('team');
    expect(decideCodexRotation({ ...base, currentCreditBalance: 27_000, currentHasCredits: true, candidates: [cand('team', 29_998, true)] } as never).reason).toBe('credits-allowed');
  });
  test('잔액을 모르면 종전대로 머문다 · 크레딧 정책이 아니면 no-candidate', () => {
    expect(decideCodexRotation({ ...base, candidates: [cand('team')] } as never).reason).toBe('credits-allowed');
    expect(decideCodexRotation({ ...base, creditsAllowed: false, currentCreditBalance: 0, candidates: [cand('team', 29_998, true)] } as never).reason).toBe('no-candidate');
  });
  test('지금 계정 잔액을 입력으로 못 받으면 후보 목록의 같은 이름 줄에서 읽는다', () => {
    const d = decideCodexRotation({ ...base, candidates: [cand('default', 19_787, true), cand('team', 29_998, true), cand('third', 25_000, true)] } as never);
    expect(d.to?.name).toBe('team');
  });
});
