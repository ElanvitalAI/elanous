/* ── Source detection ── */

export type SourceType =
  | 'x-post'
  | 'x-article'
  | 'youtube'
  | 'web'
  | 'github-repo'
  | 'github-pr'
  | 'github-issue'
  | 'github-commit'
  | 'local-file'
  | 'unknown';

export interface DetectedSource {
  type: SourceType;
  input: string;
  owner?: string;
  repo?: string;
  ref?: string;
  /** X URL parsed fields */
  tweetId?: string;
  articleId?: string;
  authorHandle?: string;
}

/* ── Summary format ── */

export type SummaryFormat =
  | 'essential'     // 간단 요약
  | 'rich'          // 심층 분석
  | 'rich-cards';   // 상세 카드형 (기본)

/* ── Output target ── */

export type OutputTarget =
  | 'obsidian'
  | 'markdown'
  | 'web'
  | 'web-deploy'
  | 'pdf';

/* ── Route decision ── */

export interface RouteDecision {
  format: SummaryFormat;
  targets: OutputTarget[];
  reason: string;
  /** "sum" 키워드 감지 시 summarize CLI 우선 사용 */
  useSummarize: boolean;
  /** "sum full" 키워드 시 summarize CLI가 추출+요약 모두 수행 (Grok 스킵) */
  summarizeFull: boolean;
  /** omni-crawl 컨텍스트 보강: 'force'=명시 요청, 'smart'=자동 판단(기본), false=비활성 */
  enrichWithCrawl: 'force' | 'smart' | false;
}

/* ── X API types ── */

/** 트윗에 첨부된 미디어 (video / animated_gif / photo) */
export interface TweetMedia {
  mediaKey: string;
  type: 'video' | 'animated_gif' | 'photo';
  /** 재생 길이 (ms) — video/gif만 */
  durationMs?: number;
  /** 최고 화질 MP4 직링크 (보관·재생용) — video/gif만 */
  bestMp4Url?: string;
  /**
   * 최저 비트레이트 MP4 직링크 (STT 전용).
   * 전사는 오디오만 쓰므로 4K를 받으면 수백 MB를 낭비한다 — 반드시 이쪽을 쓴다.
   */
  sttMp4Url?: string;
  previewImageUrl?: string;
}

export interface TweetMeta {
  text: string;
  author: string;
  authorHandle: string;
  createdAt: string;
  conversationId: string;
  viewCount: string;
  likeCount: string;
  retweetCount: string;
  replyCount: string;
  bookmarkCount: string;
  metrics: {
    impression_count: number;
    like_count: number;
    retweet_count: number;
    reply_count: number;
    bookmark_count: number;
  };
  /** note_tweet(장문) 사용 여부 — true면 text가 280자 제한 없는 전문 */
  isLongform: boolean;
  /** 첨부 미디어 */
  media: TweetMedia[];
  /** 첨부 영상 STT 전사 결과 (transcribeTweetMedia 실행 시 채워짐) */
  mediaTranscript?: string;
}

export interface Reply {
  text: string;
  author: string;
  likes: number;
  createdAt: string;
}

/* ── Digest result ── */

export interface DigestResult {
  markdown: string;
  title: string;
  source: DetectedSource;
  savedPaths: string[];
  signals: string[];
}

/* ── Sub-skill format mapping (for youtube-master delegation) ── */

export const FORMAT_TO_SUBSKILL: Record<SummaryFormat, string> = {
  essential: 'brief',
  rich: 'detailed',
  'rich-cards': 'cards',
};
