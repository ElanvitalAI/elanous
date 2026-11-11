import { streamLLM, type LLMMessage } from '../../llm.js';
import { budgetModel } from '../../llm/model-defaults.js';
import { fetchJina } from '../../../skills/omni-crawl/src/free.js';

export const KCB_EVENT_CODE = 'KCB1114';
export const KCB_TRY_MAX_ATTEMPTS = 3;
export const KCB_TRY_MAX_INPUT_CHARS = 800;
export const KCB_TRY_MAX_OUTPUT_TOKENS = 256;

export type KcbTryExampleId = 'article-brief' | 'system-diagram' | 'day-plan';

export const KCB_TRY_EXAMPLES: ReadonlyArray<{ id: KcbTryExampleId; title: string; hint: string }> = [
  { id: 'article-brief', title: '기사 링크 → 30초 브리핑', hint: '기사 링크를 붙여 넣으세요.' },
  { id: 'system-diagram', title: '3줄 → 시스템 도면', hint: '만들고 싶은 시스템을 세 줄로 적어 주세요.' },
  { id: 'day-plan', title: '오늘 일정 정리', hint: '오늘 할 일을 적어 주세요.' },
];

export function kcbTryTask(exampleId: KcbTryExampleId): string {
  return exampleId === 'article-brief'
    ? '입력에 있는 기사 내용만 사용하여 한국어 30초 브리핑을 작성하라. URL만 있으면 본문을 읽은 척하지 말고 링크만 받았다고 밝힌 뒤 제목·본문을 요청하라.'
    : exampleId === 'system-diagram'
      ? '입력의 요구를 간단한 Mermaid flowchart 코드로 그려라. 요구에 없는 기능은 만들지 말라.'
      : '입력의 일정만 사용하여 우선순위가 보이는 오늘의 짧은 일정표를 작성하라.';
}

/** Retrieved article text is an explicitly labelled excerpt within the user-message budget. */
export function kcbArticleExcerpt(link: string, title: string, content: string): string {
  const source = `출처 URL${link.length > 160 ? ' 앞부분' : ''}: ${link.slice(0, 160)}\n`;
  const heading = `제목 발췌: ${title.slice(0, 120)}\n본문 발췌: `;
  return source + heading + content.slice(0, KCB_TRY_MAX_INPUT_CHARS - source.length - heading.length);
}

export function kcbTryMessages(exampleId: KcbTryExampleId, input: string): LLMMessage[] {
  if (!input.trim() || input.length > KCB_TRY_MAX_INPUT_CHARS) throw new Error('invalid-try-input');
  return [
    { role: 'system', content: `짧고 명확하게 한국어로 답하라. 제공되지 않은 사실이나 방문하지 않은 링크의 내용을 추측하지 말라. ${kcbTryTask(exampleId)}` },
    { role: 'user', content: input },
  ];
}

/** The demo uses one short text generation, with both input and output bounded. */
export async function runKcbTryExample(exampleId: KcbTryExampleId, input: string, signal?: AbortSignal): Promise<string> {
  if (!input.trim() || input.length > KCB_TRY_MAX_INPUT_CHARS) throw new Error('invalid-try-input');
  let groundedInput = input;
  if (exampleId === 'article-brief') {
    const link = /^https?:\/\/\S+$/i.test(input.trim()) ? input.trim() : null;
    if (link) {
      const article = await fetchJina(link, { timeoutMs: 8_000 });
      if (!article) throw new Error('article-unavailable');
      groundedInput = kcbArticleExcerpt(link, article.title, article.content);
    }
  }
  return streamLLM(kcbTryMessages(exampleId, groundedInput), () => {},
    { model: budgetModel(), maxTokens: KCB_TRY_MAX_OUTPUT_TOKENS, signal });
}
