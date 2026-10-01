import type { FeedDraft, GraphApproval } from '@/lib/graph-approvals-api';

// Shape of MK's field-feed sample (feed-draft.json version 1) — only the fields the card reads.
export const sampleFeed: FeedDraft = {
  revision: 1, updatedBy: 'graph',
  brand: { name: 'Elanous', handle: 'elanous.ai', avatar: null },
  cover: { text: '브릴스 코스닥 상장', sub: '2026.10.01 · 현장 스케치', image: 'feed/slide-0.png' },
  slides: [
    { image: 'feed/slide-1.png', caption: '무대에서 진행되는 행사', include: true },
    { image: 'feed/slide-2.png', caption: '축하 인사', include: true },
    { image: 'feed/slide-3.png', caption: '기념 촬영', include: true },
  ],
  caption: { hook: '오늘 현장에서', body: '상장 기념식 현장을 담았습니다.' },
  hashtags: ['#코스닥', '#상장'],
  location: '한국거래소',
  reel: 'reel/reel-9x16.mp4',
};

export const feedItem: GraphApproval & { feed: FeedDraft } = {
  graphId: 'field-feed', runId: 'run-1', nodeId: 'post', since: new Date().toISOString(),
  message: '{"kind":"feed-preview"}', path: ['feed', 'post'], recent: [], feed: sampleFeed,
};
