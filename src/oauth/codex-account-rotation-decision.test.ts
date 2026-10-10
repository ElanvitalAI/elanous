import { afterAll, expect, mock, test } from 'bun:test';
import * as detailSwitch from '../live/detail-switch.js';

const originalDetailSwitch = { ...detailSwitch };
const events: Array<{ reason?: string; what?: string }> = [];
mock.module('../live/detail-switch.js', () => ({ ...originalDetailSwitch, emitDecision: (event: { reason?: string; what?: string }) => { events.push(event); } }));
afterAll(() => { mock.module('../live/detail-switch.js', () => originalDetailSwitch); });
const { observeRotation } = await import('./codex-account-rotation.js');

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
