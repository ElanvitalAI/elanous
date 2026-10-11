import { afterAll, expect, mock, test } from 'bun:test';
import { debug } from '../debug/log.js';
import * as detailSwitch from '../live/detail-switch.js';

const originalDetailSwitch = { ...detailSwitch };
const events: Array<{ reason?: string; what?: string }> = [];
mock.module('../live/detail-switch.js', () => ({ ...originalDetailSwitch, emitDecision: (event: { reason?: string; what?: string }) => { events.push(event); } }));
afterAll(() => { mock.module('../live/detail-switch.js', () => originalDetailSwitch); });
const { observeRotation, decideCodexRotation } = await import('./codex-account-rotation.js');

test('rotation decision reason names the richest account but never its credit amount (public capture shows reason text verbatim)', () => {
  observeRotation({ reason: 'credits-allowed', to: { name: 'team', creditBalance: 16812.4 }, accountThresholds: [] } as never, 'default');
  const reason = events.at(-1)?.reason ?? '';
  expect(reason).toContain('team');
  expect(reason).not.toMatch(/\d/);
});

test('CODEX-ORDER ① — creditPace.active 여도 구독이 남은 다른 계정이 있으면 그 계정으로 rotated', async () => {
  const { decideCodexRotation } = await import('./codex-account-rotation.js');
  const current = { name: 'default', storeKey: 'openai-codex', home: '/h/default', source: 'default' } as const;
  const full = { name: 'team', storeKey: 'k-team', home: '/h/team', reached: true, usedPercent: 100, creditBalance: 60_000, hasCredits: true };
  const fresh = { name: 'third', storeKey: 'k-third', home: '/h/third', reached: false, usedPercent: 5 };
  const d = decideCodexRotation({
    current, explicit: false, enabled: true, currentReached: true, currentUsedPercent: 100,
    currentCreditBalance: 5_000, currentHasCredits: true, resetCreditAvailability: 'available',
    candidates: [full, fresh], creditPace: { active: true },
  });
  expect(d.reason).toBe('rotated');
  expect(d.to?.name).toBe('third');
});

test('CODEX-ORDER — 다른 계정 리셋권이 크레딧보다 먼저이며 이름순 첫 후보가 관측된다', () => {
  const originalLog = debug.log;
  const rotations: Record<string, unknown>[] = [];
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data: Record<string, unknown>) => {
    if (category === 'oauth.codex-account' && event === 'rotation') rotations.push(data);
  }) as typeof debug.log;
  try {
    const base = {
      current: { name: 'default', storeKey: 'openai-codex', home: '/h/default', source: 'default' as const },
      explicit: false, enabled: true, currentReached: true, currentUsedPercent: 100,
      resetCreditAvailability: 'unavailable' as const, creditsAllowed: true,
      creditPace: { active: true }, currentCreditBalance: 100, currentHasCredits: true,
      candidates: [
        { name: 'zeta', storeKey: 'k-zeta', home: '/h/zeta', reached: true, usedPercent: 100, resetCreditAvailability: 'available' as const },
        { name: 'team', storeKey: 'k-team', home: '/h/team', reached: true, usedPercent: 100, resetCreditAvailability: 'unavailable' as const },
        { name: 'alpha', storeKey: 'k-alpha', home: '/h/alpha', reached: true, usedPercent: 100, resetCreditAvailability: 'available' as const },
      ],
    };
    const decision = decideCodexRotation(base);
    expect(decision.reason).toBe('reset-credit-available');
    expect(decision.resetCreditAccount).toBe('alpha');
    observeRotation(decision, 'default');
    expect(rotations.at(-1)).toMatchObject({ reason: 'reset-credit-available', resetCreditAccount: 'alpha' });

    const unknown = decideCodexRotation({ ...base, candidates: base.candidates.map((candidate) => ({
      ...candidate, resetCreditAvailability: 'unknown' as const,
    })) });
    expect(unknown.reason).toBe('credit-pace');
    expect(unknown.resetCreditAccount).toBeUndefined();
  } finally {
    (debug as { log: typeof debug.log }).log = originalLog;
  }
});
