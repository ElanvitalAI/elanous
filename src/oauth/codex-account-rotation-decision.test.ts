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
