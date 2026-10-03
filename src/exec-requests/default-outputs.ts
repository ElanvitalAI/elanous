export const OUTPUT_KINDS = {
  report: { fileName: 'report.md', cardTitle: '한 장 보고서', guidance: '보고·정리·요약·회고 → 한 장 보고서', words: ['보고', '정리', '요약', '회고', 'report', 'summary', 'summarize', 'recap', 'brief'] },
  slides: { fileName: 'slides.md', cardTitle: '슬라이드', guidance: '발표·자료·덱·피치 → 슬라이드(장마다 --- 구분)', words: ['발표', '자료', '덱', '피치', 'presentation', 'slides', 'slide', 'deck', 'pitch'] },
  research: { fileName: 'research.md', cardTitle: '조사 문서', guidance: '조사·비교·경쟁사·시장 → 조사 문서(출처 링크 칸 필수)', words: ['조사', '비교', '경쟁사', '시장', 'research', 'compare', 'comparison', 'competitor', 'competitors', 'market'] },
  post: { fileName: 'post.md', cardTitle: '게시글 초안', guidance: '게시글·캡션·공지·SNS → 게시글 초안(게시는 승인 노드 뒤)', words: ['게시글', '캡션', '공지', 'SNS', 'post', 'caption', 'announcement', 'social media'] },
  video: { fileName: '', cardTitle: '영상', guidance: '영상·릴스·쇼츠 → 영상(그래프가 있을 때만)', words: ['영상', '릴스', '쇼츠', 'video', 'reels', 'shorts'] },
  answer: { fileName: '', cardTitle: '답', guidance: '단순한 질문 → 답 그대로(산출물 없음)', words: [] },
} as const;

export type OutputKind = keyof typeof OUTPUT_KINDS;

export function pickDefaultOutput(text: string): { kind: OutputKind; fileName: string; cardTitle: string } {
  const normalized = text.toLowerCase();
  // Explicit artifact formats outrank activity words such as 정리, 요약 and 비교.
  for (const kind of ['slides', 'post', 'video', 'research', 'report'] as const) {
    const entry = OUTPUT_KINDS[kind];
    if (entry.words.some(word => /[a-z]/i.test(word)
      ? new RegExp(`(^|[^a-z])${word.toLowerCase()}(?=$|[^a-z])`).test(normalized)
      : normalized.includes(word))) {
      return { kind, fileName: entry.fileName, cardTitle: entry.cardTitle };
    }
  }
  const kind = /(?:[?？]|뭐|어떻게)\s*$/.test(text) ? 'answer' : 'report';
  return { kind, fileName: OUTPUT_KINDS[kind].fileName, cardTitle: OUTPUT_KINDS[kind].cardTitle };
}
