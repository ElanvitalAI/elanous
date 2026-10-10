// Korean message bundle.

import type { Messages } from './types.js';

export const messagesKo: Messages = {
  // Action labels
  ok: '확인',
  cancel: '취소',
  confirm: '확인',
  yes: '예',
  no: '아니오',
  back: '뒤로',
  next: '다음',
  done: '완료',
  edit: '수정',
  retry: '재시도',
  skip: '건너뛰기',
  close: '닫기',

  // Picker / select
  search: '검색',
  noResults: '결과 없음',
  selected: '선택됨',
  multiSelectHint: '스페이스: 토글 · Enter: 확정',

  // Wizard step
  stepLabel: '{total} 단계 중 {n}번째',
  required: '필수',
  optional: '선택',
  fieldLabel: '{label}',

  // Validation
  invalidEmail: '올바른 이메일 주소를 입력하세요.',
  invalidUrl: '올바른 URL을 입력하세요.',
  invalidNumber: '숫자를 입력하세요.',
  invalidPath: '경로가 올바르지 않거나 존재하지 않습니다.',
  invalidPort: '포트는 1에서 65535 사이여야 합니다.',
  invalidJson: '입력이 올바른 JSON이 아닙니다.',
  rangeError: '값은 {min}에서 {max} 사이여야 합니다.',
  patternError: '"{value}"이(가) 예상 형식과 일치하지 않습니다.',

  // Chat fallback
  chatNoSynthesisLead: '답을 끝까지 쓰지 못했습니다 — 도구를 {n}번 쓰는 동안 정리할 시간이 끝났습니다. 질문을 좁혀 다시 물어 주세요(예: 무엇 하나만).',
  chatFoldedInternalTail: '● 내부 기록 접힘 · {n}줄 · f 로 펼치기',

  // Async + status
  loading: '불러오는 중…',
  saving: '저장 중…',
  saved: '저장됨.',
  failed: '실패함.',
  retryingIn: '{n}초 후 재시도…',

  // Help / discovery
  pressForHelp: '? 키로 도움말 보기',
  topics: '주제',
  more: '더 보기',

  // Modal hints
  pressKeyToAction: '{key} 키를 눌러 {action}',
  pressEnter: 'Enter 누르기',
  pressEsc: 'Esc 키로 취소',

  // Markdown surface
  noContent: '내용 없음.',
  contentLoadFailed: '내용을 불러오지 못했습니다.',

  // A11y descriptors
  ariaProgress: '진행률 {percent}퍼센트.',
  ariaSpinner: '불러오는 중: {label}',
  ariaTable: '{cols}개 열과 {rows}개 행을 가진 표.',
  ariaPicker: '{count}개 옵션 중 하나를 선택하세요.',
  ariaModal: '대화 상자 열림.',
  ariaWizard: '마법사 열림.',
  ariaMarkdown: '마크다운 콘텐츠.',
  notificationLevelInfo: '알림',
  notificationLevelWarning: '경고',
  notificationLevelError: '오류',

  // Setup wizard — banner + completion
  setupBanner: 'elanous — 셋업 마법사',
  setupWritingTo: '저장 경로: {path}',
  setupComplete: '셋업 완료',
  setupErrorReportNotice: '오류가 나면 운영팀에 자동으로 알립니다(오류 내용·버전·무작위 설치 ID — 이름·메일 없이). 끄기: elanous config set errorReports.enabled false',
  setupRerunHint: '다시 실행: {cmd}',

  // Setup wizard — Step 1 (LLM provider)
  setupStepLLMTitle: 'LLM 공급자',
  setupStepLLMExcerpt: 'elanous 가 사용할 LLM 공급자를 선택하세요. 각 공급자는 API 키 (또는 Codex 의 OAuth) 가 필요합니다.',

  // Setup wizard — Step 2 (Skill directories)
  setupStepSkillsTitle: '스킬 디렉토리',
  setupStepSkillsExcerpt: '주로 사용하는 에이전트의 스킬 프리셋을 선택하세요. 추가 디렉토리 또는 "custom" 으로 직접 경로를 입력할 수 있습니다.',

  // Setup wizard — Step 3 (Obsidian vault)
  setupStepObsidianTitle: 'Obsidian 볼트',
  setupStepObsidianExcerpt: 'Obsidian 볼트 루트의 절대 경로. Obsidian 브라우저 패널과 vault-save 스킬에 사용됩니다.',
  setupStepObsidianSkipBehavior: '건너뛰기 → vault-save / obsidian-browser 스킬 비활성. 추후 `elanous setup obsidian` 으로 추가.',

  // Setup wizard — Step 4 (Telegram bot)
  setupStepTelegramTitle: 'Telegram 봇 (선택)',
  setupStepTelegramExcerpt: 'Telegram 봇으로 모바일에서 에이전트와 대화.',
  setupStepTelegramSkipBehavior: '건너뛰기 → 모바일 채팅 사용 불가. 추후 `elanous setup telegram` 으로 추가.',

  // Setup wizard — Step 5 (Discord bot)
  setupStepDiscordTitle: 'Discord 봇 (선택)',
  setupStepDiscordExcerpt: 'Discord 서버 / DM 에서 에이전트와 대화.',
  setupStepDiscordSkipBehavior: '건너뛰기 → Discord 채팅 사용 불가. 추후 `elanous setup discord` 으로 추가.',

  // Setup wizard — Step 6 (Wrap-up · Sprint 12)
  setupWrapUpTitle: '셋업 완료 — 검토 및 저장',
  setupWrapUpExcerpt: '아래 설정을 검토하세요. Y / Enter 로 저장, 또는 섹션 이름을 입력해 해당 단계만 수정.',
  setupWrapUpReviewHelp: 'Y / Enter ↵ 저장 · n 취소 · 또는 섹션 이름 (llm/skills/obsidian/telegram/discord/control)',
};
