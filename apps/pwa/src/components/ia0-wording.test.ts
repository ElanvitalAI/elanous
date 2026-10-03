import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const files = {
  'shell/sidebar-nav-items.ts': ["label: '대화 카드'", "hint: '대화 카드 데크 (스와이프 결정)'"],
  'card-swipe/SessionsDeckPanel.tsx': [
    '>대화 카드 데크</h1>',
    '{sessions.length} 대화 ·',
    'aria-label="대화 새로고침"',
    'aria-label="오래된 대화 포함"',
  ],
  'card-swipe/CardSweepView.tsx': [
    '진행 중인 대화 없음 · 새 대화를 시작하세요',
    'aria-label="대화 카드 데크 · 좌우 = 거절/승인 · 위 = 잠시 멈춤 · 아래 = 펼치기"',
  ],
  '../lib/chat-runtime.ts': ["description: '현재 대화 ID 보기'", "description: '현재 대화를 복사해 새 대화로 분기'"],
  'chat/ChatLayout.tsx': ['>이 대화는 지금 응답 중입니다</p>', 'aria-label="응답 중 알림 닫기"'],
  'settings/SettingsPanel.tsx': ['>대화</h2>', '>연결 (토큰 → 대화)</span>'],
  'voice/TailscaleSecurityBanner.tsx': ['title="이 창을 닫을 때까지 숨기기"'],
} as const;

const sources = Object.entries(files).map(([path, expected]) => ({
  path,
  expected,
  source: readFileSync(join(HERE, path), 'utf8'),
}));

const oldWordings = [
  "label: 'Sessions'",
  '세션 카드 데크',
  '활성 세션 없음',
  '현재 세션 ID 보기',
  '새 세션 ID 만들기',
  'This session is busy',
  'Dismiss busy-session notice',
  'refresh sessions',
  'include stale sessions',
  'session card deck',
  '>Session<',
  'Bindings (token → session)',
  '이 세션 동안 숨기기',
  '{sessions.length} 세션',
] as const;

test('IA0: old visible wording is absent from all targeted PWA sources', () => {
  for (const { path, source } of sources) {
    for (const old of oldWordings) {
      expect(source, `${path}: ${old}`).not.toContain(old);
    }
    expect(source, path).not.toMatch(/>Session<\/h2>/);
  }
});

test('IA0: each targeted source contains its replacement wording', () => {
  for (const { path, expected, source } of sources) {
    for (const wording of expected) {
      expect(source, `${path}: ${wording}`).toContain(wording);
    }
  }
});

test('IA0: the sidebar route remains /sessions', () => {
  const sidebar = sources.find(({ path }) => path === 'shell/sidebar-nav-items.ts');
  expect(sidebar?.source).toContain("href: '/sessions', label: '대화 카드'");
});
