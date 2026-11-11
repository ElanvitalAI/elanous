// β (BACKLOG-pwa-mobile-readiness §6.1 6 metric · 2026-05-12) —
// Cross-component source-level grep wire test.
//
// MANUAL §5 PR review 체크리스트: "logger 호출 없으면 = 빠진 PR".
// 6 BACKLOG-targeted user-signal boundary 마다 `userIntentLogger.emit`
// 또는 SW 의 `/v1/user-intents/emit` POST 가 존재함을 grep 으로 고정.
// 단위 + 통합 통과해도 wire 자체는 별 가드 필요 (feedback_source_level_grep_test_value).
//
// 6 boundary:
//   #1 IntentPanel onTap        → ShowroomLayout
//   #2 Mobile route selection   → MobileBottomTabs
//   #3 Voice intake submit      → ShowroomVoiceIntake
//   #4 Camera intake send       → ShowroomCameraIntake
//   #5 Push action tap          → public/sw.js (fetch /v1/user-intents/emit)
//   #6 Chat route mount         → ChatPanel

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = apps/pwa/src/components ; PWA_SRC = apps/pwa/src
const PWA_SRC = join(HERE, '..');
const PWA_PKG = join(PWA_SRC, '..');

function readSrc(rel: string): string {
  return readFileSync(join(PWA_SRC, rel), 'utf8');
}

const SHOWROOM_LAYOUT_SRC = readSrc('components/showroom/ShowroomLayout.tsx');
const MOBILE_TABS_SRC     = readSrc('components/shell/MobileBottomTabs.tsx');
const VOICE_INTAKE_SRC    = readSrc('components/showroom/ShowroomVoiceIntake.tsx');
const CAMERA_INTAKE_SRC   = readSrc('components/showroom/ShowroomCameraIntake.tsx');
const CHAT_PANEL_SRC       = readSrc('components/chat/ChatPanel.tsx');
const SW_SRC              = readFileSync(join(PWA_PKG, 'public', 'sw.js'), 'utf8');

const USER_INTENT_LOGGER_IMPORT_RE =
  /import\s*\{[^}]*userIntentLogger[^}]*\}\s*from\s*['"]@\/lib\/user-intent-logger['"]/;

describe('PWA mobile-readiness · userIntentLogger emit wires', () => {
  test('#1 ShowroomLayout imports userIntentLogger + emits pwa.selection.intent_button_tap', () => {
    expect(SHOWROOM_LAYOUT_SRC).toMatch(USER_INTENT_LOGGER_IMPORT_RE);
    expect(SHOWROOM_LAYOUT_SRC).toContain("'pwa.selection.intent_button_tap'");
    expect(SHOWROOM_LAYOUT_SRC).toContain("userIntentLogger.emit");
  });

  test('#2 MobileBottomTabs emits route selection for direct tabs and sheet links', () => {
    expect(MOBILE_TABS_SRC).toMatch(USER_INTENT_LOGGER_IMPORT_RE);
    expect(MOBILE_TABS_SRC).toContain("'pwa.navigation.bottom_tab_open'");
    expect(MOBILE_TABS_SRC).toContain('userIntentLogger.emit');
    expect(MOBILE_TABS_SRC).toContain('onClick={() => recordNavigation(group.items[0]!.href)}');
    expect(MOBILE_TABS_SRC).toContain('recordNavigation(item.href); setOpen(null);');
  });

  test('#3 ShowroomVoiceIntake imports userIntentLogger + emits pwa.utterance.voice_send after intake OK', () => {
    expect(VOICE_INTAKE_SRC).toMatch(USER_INTENT_LOGGER_IMPORT_RE);
    expect(VOICE_INTAKE_SRC).toContain("'pwa.utterance.voice_send'");
    expect(VOICE_INTAKE_SRC).toContain("userIntentLogger.emit");
  });

  test('#4 ShowroomCameraIntake imports userIntentLogger + emits route-specific camera gesture', () => {
    expect(CAMERA_INTAKE_SRC).toMatch(USER_INTENT_LOGGER_IMPORT_RE);
    expect(CAMERA_INTAKE_SRC).toContain("'pwa.gesture.camera_attach_session'");
    expect(CAMERA_INTAKE_SRC).toContain("'pwa.gesture.camera_intake_save'");
    expect(CAMERA_INTAKE_SRC).toContain("userIntentLogger.emit");
  });

  test('#5 sw.js POSTs to /v1/user-intents/emit with pwa.selection.push_action_tap on notificationclick action', () => {
    // SW can't import the typed logger; the POST shape must match the
    // MANUAL §3 convention so the daemon-side fan-out treats it the
    // same as in-page emits.
    expect(SW_SRC).toContain('/v1/user-intents/emit');
    expect(SW_SRC).toContain("'pwa.selection.push_action_tap'");
    expect(SW_SRC).toContain("layer: 'selection'");
  });

  test('#6 ChatPanel emits pwa.navigation.chat_opened on standalone route mount', () => {
    expect(CHAT_PANEL_SRC).toMatch(USER_INTENT_LOGGER_IMPORT_RE);
    expect(CHAT_PANEL_SRC).toContain("'pwa.navigation.chat_opened'");
    expect(CHAT_PANEL_SRC).toContain('if (!props.showConversationList) return;');
    expect(CHAT_PANEL_SRC).toContain('userIntentLogger.emit');
    // Mount signal stays in useEffect so SSR does not double-emit.
    expect(CHAT_PANEL_SRC).toMatch(/useEffect\s*\(/);
  });

  test('all 6 emit kinds follow MANUAL §3 <surface>.<layer>.<verb> convention', () => {
    const KINDS = [
      'pwa.selection.intent_button_tap',
      'pwa.navigation.bottom_tab_open',
      'pwa.utterance.voice_send',
      'pwa.gesture.camera_attach_session',
      'pwa.gesture.camera_intake_save',
      'pwa.selection.push_action_tap',
      'pwa.navigation.chat_opened',
    ];
    const CONVENTION_RE = /^pwa\.(utterance|gesture|selection|navigation|ambient|device_state|system)\.[a-z_]+$/;
    for (const kind of KINDS) {
      expect(kind).toMatch(CONVENTION_RE);
    }
  });
});
