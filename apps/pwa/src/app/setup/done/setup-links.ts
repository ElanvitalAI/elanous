// `/setup/done` "more setup?" 링크 표 (Phase 2 · 2026-05-19).
//
// 2026-07-07 분리: Next 15 static export 가 page.tsx 의 데이터 export
// ("SETUP_LINKS" is not a valid Page export field)를 거부 → 순수 데이터를
// co-located 모듈로 이동. 소비자: page.tsx + SettingsPanel.anchors.test.ts.

export interface SetupLinkCard {
  /** Anchor id Phase 3 에서 활성화 — 현재는 무시되고 `/settings` 로 navigates. */
  anchor: string;
  label: string;
  description: string;
  /** "안 쓰는 사람 많음" 카드는 collapsed 영역으로 (페르소나 등). */
  primary: boolean;
}

export const SETUP_LINKS: readonly SetupLinkCard[] = [
  // Primary — 많은 사용자가 곧장 셋업할 가능성
  {
    anchor: 'channels',
    label: 'Channels',
    description: 'Telegram / Discord 봇 연결',
    primary: true,
  },
  {
    anchor: 'voice',
    label: 'Voice',
    description: 'TTS · STT 모델 + voice 환경설정',
    primary: true,
  },
  {
    anchor: 'ios',
    label: 'iOS / mobile',
    description: 'PWA install · iOS companion 페어링',
    primary: true,
  },
  // Optional — 안 쓰는 사람 많음
  {
    anchor: 'personas',
    label: 'Personas',
    description: '4 인격 (default · contrarian · pragmatist · sage) 편집',
    primary: false,
  },
  {
    anchor: 'tools',
    label: 'Tool surface',
    description: 'chat 이 사용할 tool 셋 (readonly / chat / webterm / all)',
    primary: false,
  },
  {
    anchor: 'advanced',
    label: 'Advanced',
    description: 'Model tier · budget guard · OCR · 기타 카드 17 종',
    primary: false,
  },
];
