/** Service setup metadata shared by the CLI, runtime key loader, and manual. */
export interface ServiceKeyCatalogEntry {
  id: string;
  label: string;
  kind: 'api-key' | 'subscription' | 'oauth' | 'cli' | 'local';
  envNames: readonly string[];
  setupUrl: string;
  usedBy: string;
  cost: 'account-plan' | 'usage-based' | 'plan-dependent' | 'local';
  verification: string;
  demoRequired: boolean;
}

export const SERVICE_KEY_CATALOG: readonly ServiceKeyCatalogEntry[] = [
  { id: 'codex', label: 'OpenAI Codex', kind: 'subscription', envNames: [], setupUrl: 'https://platform.openai.com/docs/codex/auth', usedBy: '씬 1 리서치 · 사이드탭 미션', cost: 'account-plan', verification: 'elanous auth status', demoRequired: true },
  { id: 'claude-code', label: 'Claude Code', kind: 'subscription', envNames: [], setupUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview', usedBy: '씬 1 비교 · 사이드탭 미션', cost: 'account-plan', verification: 'claude auth status', demoRequired: true },
  { id: 'exa', label: 'Exa', kind: 'api-key', envNames: ['EXA_API_KEY'], setupUrl: 'https://dashboard.exa.ai/api-keys', usedBy: '씬 1 리서치 · 씬 2 흡수', cost: 'usage-based', verification: 'POST /search · 상태 코드만', demoRequired: true },
  { id: 'firecrawl', label: 'Firecrawl', kind: 'api-key', envNames: ['FIRECRAWL_API_KEY'], setupUrl: 'https://www.firecrawl.dev/app/api-keys', usedBy: '씬 2 흡수', cost: 'usage-based', verification: 'POST /v2/scrape · 상태 코드만', demoRequired: true },
  { id: 'xai', label: 'xAI / Grok API', kind: 'api-key', envNames: ['XAI_API_KEY', 'GROK_API_KEY'], setupUrl: 'https://console.x.ai/', usedBy: '씬 2 흡수 · Grok API', cost: 'usage-based', verification: 'GET /v1/models · 상태 코드만', demoRequired: true },
  { id: 'tavily', label: 'Tavily', kind: 'api-key', envNames: ['TAVILY_API_KEY', 'TAVILY_KEY'], setupUrl: 'https://app.tavily.com/home', usedBy: '웹 검색 대체 경로', cost: 'usage-based', verification: 'POST /search · 상태 코드만', demoRequired: false },
  { id: 'openrouter', label: 'OpenRouter · GLM', kind: 'api-key', envNames: ['OPENROUTER_API_KEY'], setupUrl: 'https://openrouter.ai/keys', usedBy: 'GLM · OpenRouter 모델', cost: 'usage-based', verification: 'GET /api/v1/key · 상태 코드만', demoRequired: true },
  { id: 'linear', label: 'Linear API', kind: 'api-key', envNames: ['LINEAR_API_KEY'], setupUrl: 'https://linear.app/settings/api', usedBy: '씬 2 능동 비서', cost: 'plan-dependent', verification: 'GraphQL viewer · 상태 코드만', demoRequired: true },
  { id: 'telegram', label: 'Telegram bot', kind: 'api-key', envNames: ['ELANOUS_TELEGRAM_BOT_TOKEN'], setupUrl: 'https://t.me/BotFather', usedBy: '씬 2 · 씬 3 채널', cost: 'local', verification: 'getMe · 상태 코드만', demoRequired: true },
  { id: 'telegram-chat', label: 'Telegram chat ID', kind: 'api-key', envNames: ['ELANOUS_TELEGRAM_CHAT_ID'], setupUrl: 'https://core.telegram.org/bots/features#botfather', usedBy: '데모 알림 대상', cost: 'local', verification: 'getChat · 상태 코드만 · 미발송', demoRequired: true },
  { id: 'google-workspace', label: 'Google Workspace', kind: 'oauth', envNames: [], setupUrl: 'https://developers.google.com/workspace/guides/get-started', usedBy: 'Gmail · Drive 커넥터', cost: 'account-plan', verification: '로그인 상태 확인 · 토큰 미표시', demoRequired: false },
  { id: 'aside', label: 'Aside browser', kind: 'cli', envNames: [], setupUrl: 'https://github.com/elanous-ai/aside', usedBy: '브라우저 자동화', cost: 'plan-dependent', verification: 'aside status', demoRequired: true },
  { id: 'github', label: 'GitHub CLI', kind: 'cli', envNames: [], setupUrl: 'https://cli.github.com/', usedBy: '공개 저장소 · 개발 플러그인', cost: 'local', verification: 'gh auth status', demoRequired: true },
  { id: 'video-render', label: 'Video render', kind: 'local', envNames: [], setupUrl: 'https://ffmpeg.org/download.html', usedBy: '데모 하이라이트 렌더', cost: 'local', verification: 'ffmpeg -version', demoRequired: false },
  { id: 'openai-api', label: 'OpenAI API', kind: 'api-key', envNames: ['OPENAI_API_KEY'], setupUrl: 'https://platform.openai.com/api-keys', usedBy: 'OpenAI 모델 · Codex API-key 경로', cost: 'usage-based', verification: 'GET /v1/models · 상태 코드만', demoRequired: false },
  { id: 'anthropic-api', label: 'Anthropic API', kind: 'api-key', envNames: ['ANTHROPIC_API_KEY'], setupUrl: 'https://console.anthropic.com/settings/keys', usedBy: 'Claude API', cost: 'usage-based', verification: 'GET /v1/models · 상태 코드만', demoRequired: false },
  { id: 'gemini-api', label: 'Google Gemini API', kind: 'api-key', envNames: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], setupUrl: 'https://aistudio.google.com/app/apikey', usedBy: 'Gemini 모델', cost: 'usage-based', verification: '모델 목록 · 상태 코드만', demoRequired: false },
  { id: 'opengateway', label: 'OpenGateway', kind: 'api-key', envNames: ['OPENGATEWAY_API_KEY'], setupUrl: 'https://apis.opengateway.ai/', usedBy: 'OpenAI 호환 모델 대체 경로', cost: 'usage-based', verification: 'GET /v1/models · 상태 코드만', demoRequired: false },
  { id: 'supadata', label: 'Supadata', kind: 'api-key', envNames: ['SUPADATA_API_KEY'], setupUrl: 'https://supadata.ai/', usedBy: 'YouTube 자막', cost: 'usage-based', verification: '자막 API · 상태 코드만', demoRequired: false },
  { id: 'elevenlabs', label: 'ElevenLabs', kind: 'api-key', envNames: ['ELEVENLABS_API_KEY'], setupUrl: 'https://elevenlabs.io/app/settings/api-keys', usedBy: '음성 합성', cost: 'usage-based', verification: 'GET /v1/user · 상태 코드만', demoRequired: false },
  { id: 'brave-search', label: 'Brave Search', kind: 'api-key', envNames: ['BRAVE_API_KEY'], setupUrl: 'https://brave.com/search/api/', usedBy: '웹 검색 대체 경로', cost: 'usage-based', verification: '검색 API · 상태 코드만', demoRequired: false },
  { id: 'youtube-data', label: 'YouTube Data API', kind: 'api-key', envNames: ['YOUTUBE_API_KEY'], setupUrl: 'https://console.cloud.google.com/apis/credentials', usedBy: 'YouTube 메타데이터', cost: 'usage-based', verification: 'videos.list · 상태 코드만', demoRequired: false },
  { id: 'apify', label: 'Apify', kind: 'api-key', envNames: ['APIFY_TOKEN'], setupUrl: 'https://console.apify.com/account/integrations', usedBy: 'X 수집', cost: 'usage-based', verification: '사용자 API · 상태 코드만', demoRequired: false },
  { id: 'eodhd', label: 'EODHD', kind: 'api-key', envNames: ['EODHD_API_KEY'], setupUrl: 'https://eodhd.com/financial-apis/', usedBy: '시장 시세', cost: 'usage-based', verification: '시장 API · 상태 코드만', demoRequired: false },
  { id: 'fds', label: 'FDS market data', kind: 'api-key', envNames: ['FDS_API_KEY'], setupUrl: 'https://elanous.ai', usedBy: '시장 시세', cost: 'plan-dependent', verification: '연결 미니 호출 · 상태 코드만', demoRequired: false },
  { id: 'upstage', label: 'Upstage', kind: 'api-key', envNames: ['UPSTAGE_API_KEY'], setupUrl: 'https://console.upstage.ai/api-keys', usedBy: '문서 파싱', cost: 'usage-based', verification: '문서 API · 상태 코드만', demoRequired: false },
] as const;

export function renderServiceKeyCatalogMarkdown(): string {
  const rows = SERVICE_KEY_CATALOG.map(item => `| ${item.id} | ${item.label} | ${item.kind} | ${item.envNames.join(', ') || '로그인/설치'} | ${item.setupUrl} | ${item.cost} | ${item.usedBy} | ${item.verification} | ${item.demoRequired ? '씬 사용' : '선택'} |`);
  return ['| id | 서비스 | 인증 | 환경 이름 | 설정 위치 | 비용 유형 | 사용처 | 최소 확인 | 판정 |', '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}
