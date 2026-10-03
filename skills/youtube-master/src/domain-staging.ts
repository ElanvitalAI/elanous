/**
 * 인박스 도메인 분류 라우터 — RFC-multicontent-publishing-feed-board-2026-07-23 택소노미 사본.
 * intake 결과를 00. Inbox/ 아래 번호 도메인 폴더로 분류 저장(소스 아닌 domain 기준). 3스킬 동기 사본
 * (youtube-master·omni-crawl·omni-digest). 토글 OBSIDIAN_STAGING_BY_DOMAIN=0 이면 legacy 경로 유지.
 *   폴더: 01. Daily Notes(유지) · 02. Agentic · 03. AI · 04. Stocks · 05. Tech · 06. Growth · 07. Other · 98. Archiving(구 소스폴더)
 *   domain 6종 slug: agentic·ai·stocks·tech·growth·other (frontmatter category 진실원·여기선 키워드 폴백 분류).
 */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  agentic: ['claude', 'codex', 'mcp', 'openclaw', 'subagent', 'cursor', 'vibecoding', 'vibe coding', 'coding', '코딩', '에이전트', 'agentic', 'agent tool', 'cli', 'terminal', '로컬 llm', 'local llm', '프롬프트', 'prompt', 'n8n', '자동화 에이전트', 'claude code', 'codex cli', 'anthropic sdk'],
  stocks: ['주식', '투자', '종목', 'stock', '반도체', 'hbm', '하이닉스', '삼성전자', 'nvidia', '엔비디아', 'tsmc', 'etf', '수급', 'ipo', '매크로', '금리', '환율', '배당', '실적', '증시', '코스피', '나스닥', 's&p', '밸류에이션', '실적발표'],
  ai: ['anthropic', 'openai', 'gemini', 'gpt', '인공지능', '생성형', 'ai 모델', 'llm 모델', '머신러닝', '딥러닝', 'ai 쇼핑', 'ai 산업', 'ai 연구', 'kimi', 'llama', 'mistral', 'ai tool'],
  tech: ['하드웨어', '스페이스x', 'spacex', 'cpu', 'gpu', '칩셋', '반도체 산업', '맥북', 'macbook', 'mac studio', 'm5 max', 'm4 max', '디바이스', '테크 산업'],
  growth: ['마인드셋', '자기계발', '부의', '리더십', '생산성', '비즈니스', 'business', 'leadership', 'productivity', '습관', '경영', '투자철학', '부자', '멘탈'],
};

/** domain slug → 인박스 번호 폴더명 (01. Daily Notes 는 유지·도메인은 02~07). */
const DOMAIN_DIR: Record<string, string> = {
  agentic: '02. Agentic',
  ai: '03. AI',
  stocks: '04. Stocks',
  tech: '05. Tech',
  growth: '06. Growth',
  other: '07. Other',
};

/** genre·keywords·title·본문 등 신호를 합쳐 가장 매칭 많은 domain 선택(무매칭=other). */
export function classifyDomain(signals: (string | undefined | null)[]): string {
  const hay = signals.filter(Boolean).join(' ').toLowerCase();
  let best = 'other';
  let bestScore = 0;
  for (const [domain, kws] of Object.entries(DOMAIN_KEYWORDS)) {
    let score = 0;
    for (const k of kws) if (hay.includes(k.toLowerCase())) score++;
    if (score > bestScore) {
      bestScore = score;
      best = domain;
    }
  }
  return best;
}

/** OBSIDIAN_STAGING_BY_DOMAIN=0 이 아니면 도메인 분류 저장 활성(기본 ON). */
export function stagingEnabled(): boolean {
  return (process.env.OBSIDIAN_STAGING_BY_DOMAIN ?? '1') !== '0';
}

/** 도메인 저장 서브디렉토리(볼트 루트 상대) — 00. Inbox/0N. <Domain>. */
export function stagingSubdir(domain: string): string {
  return `00. Inbox/${DOMAIN_DIR[domain] ?? DOMAIN_DIR.other}`;
}
