import { expect, test } from 'bun:test';
import { OUTPUT_KINDS, pickDefaultOutput } from './default-outputs.js';

test('six delegated requests pick the promised default artifact or a plain answer', () => {
  const cases = [
    ['이번 주 캠페인 결과 정리해 줘', 'report', 'report.md', '한 장 보고서'],
    ['10-08 데모 발표 자료 만들어 줘', 'slides', 'slides.md', '슬라이드'],
    ['경쟁사 세 곳 비교 조사', 'research', 'research.md', '조사 문서'],
    ['행사 공지 게시글 써 줘', 'post', 'post.md', '게시글 초안'],
    ['설치는 어떻게 해?', 'answer', '', '답'],
    ['마케터스 나이트 회고', 'report', 'report.md', '한 장 보고서'],
  ] as const;
  for (const [text, kind, fileName, cardTitle] of cases) {
    expect(pickDefaultOutput(text)).toEqual({ kind, fileName, cardTitle });
  }
});

test('explicit artifact format wins over a report activity in mixed requests', () => {
  expect(pickDefaultOutput('캠페인 결과 정리 발표 자료 만들어 줘'))
    .toEqual({ kind: 'slides', fileName: 'slides.md', cardTitle: '슬라이드' });
  expect(pickDefaultOutput('Summarize the results in a slide deck').kind).toBe('slides');
  expect(pickDefaultOutput('조사 결과 정리 게시글 써 줘').kind).toBe('post');
  expect(pickDefaultOutput('행사 요약 영상 만들어 줘').kind).toBe('video');
});

test('English task words, question endings and unmatched work follow the output table', () => {
  expect(Object.keys(OUTPUT_KINDS)).toEqual(['report', 'slides', 'research', 'post', 'video', 'answer']);
  expect(OUTPUT_KINDS.slides.guidance).toContain('장마다 --- 구분');
  expect(OUTPUT_KINDS.research.guidance).toContain('출처 링크 칸 필수');
  expect(OUTPUT_KINDS.post.guidance).toContain('게시는 승인 노드 뒤');
  for (const [text, kind] of [
    ['Summarize the week', 'report'], ['Make a presentation', 'slides'],
    ['Compare competitors', 'research'], ['Write a social media caption', 'post'],
    ['Create a short video', 'video'], ['행사 릴스 만들어 줘', 'video'],
    ['설치는 뭐', 'answer'], ['어떻게', 'answer'], ['How do I install?', 'answer'],
    ['이번 주 캠페인 준비해 줘', 'report'],
  ] as const) {
    expect(pickDefaultOutput(text).kind).toBe(kind);
  }
  expect(pickDefaultOutput('Create a short video')).toEqual({ kind: 'video', fileName: '', cardTitle: '영상' });
  expect(pickDefaultOutput('answer the questionnaire')).toMatchObject({ kind: 'report' });
});
