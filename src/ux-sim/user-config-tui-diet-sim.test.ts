import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateUserConfigTuiDiet, type UserConfigTuiDietSimulation } from './user-config-tui-diet-sim.js';

let root: string;
let result: UserConfigTuiDietSimulation;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ux-sim-user-config-tui-diet-'));
  result = simulateUserConfigTuiDiet(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('legacy TUI preferences fall back to fixed defaults', () => {
  expect({ sidetab: result.sidetab, unattended: result.unattended, slashAudience: result.slashAudience })
    .toEqual({ sidetab: 'collapsed', unattended: false, slashAudience: { role: 'owner', showBeta: false } });
});

test('legacy dashboard theme preference does not alter the fixed theme', () => {
  expect(result.dashboardTheme).toBeUndefined();
});

test('channel voice and APNs settings remain effective', () => {
  expect({ voice: result.channelVoiceReplyMode, notifications: result.notificationEnvironment })
    .toEqual({ voice: 'text', notifications: 'sandbox' });
  expect(result.pwaVoiceSttProvider).toBe('gemini-live-stt');
});

test('saving config preserves channel voice and APNs settings', () => {
  expect({ voice: result.savedChannelVoiceReplyMode, notifications: result.savedNotificationEnvironment })
    .toEqual({ voice: 'text', notifications: 'sandbox' });
  expect(result.savedPwaVoiceSttProvider).toBe('gemini-live-stt');
  expect(result.savedTui).toBeUndefined();
  expect(result.savedJsonVoiceSttProvider).toBe('gemini-live-stt');
  expect(result.savedDashboard).not.toHaveProperty('theme');
});
