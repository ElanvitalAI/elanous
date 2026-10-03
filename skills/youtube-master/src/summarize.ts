import { env, requireEnv } from './env.js';
import { compactTranscript } from './util.js';
import type { SummaryConfig } from './types.js';

/* ── Prompt builders per format ── */

function buildBriefPrompt(transcript: string, meta: { title: string; channel: string; videoUrl: string }): string {
  return `다음 자막을 바탕으로 간단 요약을 한국어 마크다운으로 작성하세요.

[중요] 반드시 리포트 본문 시작 전에 아래 2줄을 정확히 출력하세요:
GENRE: {주장르#세부장르} (Tech, Business, Readership, 자기개발 중 택1, 세부장르 포함)
KEYWORDS: {키워드1}, {키워드2}, {키워드3}

[Sections]
1. Executive Summary — 불릿 6~10개 (핵심만)
2. SCQA — Situation/Complication/Question/Answer 각 1줄
3. Key Insights — 인사이트 5개
4. Action Items — 시청 후 바로 할 일/적용 아이디어 3~5개

[Style]
- 장황하지 않게, 핵심 위주
- 표/타임라인/장문의 상세분석은 생략

영상: ${meta.title} (${meta.channel})
URL: ${meta.videoUrl}

[Transcript]
${compactTranscript(transcript, 7000)}`;
}

function buildCardsPrompt(
  transcript: string,
  meta: { title: string; channel: string; videoUrl: string },
  timelineHint: string,
): string {
  const timelineSection = timelineHint
    ? `7. Timeline — 주요 타임라인 요약 (아래 타임스탬프 참고 데이터에서 5~10개 핵심 구간을 선별하여 요약. 반드시 제공된 마크다운 링크 형식을 그대로 사용)\n\n[타임스탬프 참고 데이터]\n${timelineHint}\n`
    : '';

  return `다음 자막을 바탕으로, 카드 스타일의 한국어 마크다운 요약을 작성하세요.

[중요] 반드시 리포트 본문 시작 전에 아래 2줄을 정확히 출력하세요:
GENRE: {주장르#세부장르} (Tech, Business, Readership, 자기개발 중 택1, 세부장르 포함)
KEYWORDS: {키워드1}, {키워드2}, {키워드3}

이 리포트의 목표: 영상을 보지 않아도 핵심 논지, 근거, 맥락을 완전히 이해할 수 있는 수준의 상세 요약.

[Sections — 반드시 이 구조와 이모지를 정확히 따르세요]

1. 🎯 한 줄 결론 — 가장 중요한 한 문장 (마크다운 헤딩 없이 이모지+볼드로 시작)

2. ✅ 한눈에 정리 — 핵심 포인트 5~8개 불릿 (마크다운 헤딩 없이 이모지로 시작)

3. 멀티카드 상세 섹션 — **5~7개 카드**. 반드시 아래 형식과 예시를 따르세요:

### 🟪 카드 1 — [주제 제목]

[도입 단락: 이 주제의 맥락과 핵심 주장을 1~2문장으로]

#### 1) [소주제 A]
- 핵심 포인트 1
- 핵심 포인트 2
- 핵심 포인트 3

[소주제 A에 대한 부연 설명 단락. 발화자가 든 근거, 수치, 비유를 상세히.]

#### 2) [소주제 B]
- 핵심 포인트 1
- 핵심 포인트 2

[소주제 B에 대한 부연 설명 단락.]

#### 3) [소주제 C]
- 핵심 포인트 1
- 핵심 포인트 2

[결론/시사점 단락]

### 🟦 카드 2 — [주제 제목]
(🟪/🟦 교대 반복, 동일 구조)

   규칙:
   - 카드는 **5~7개** (절대 8개 이상 만들지 마세요)
   - 카드 수가 적은 대신, 각 카드의 깊이와 분량을 극대화
   - 반드시 ### (h3) 마크다운 헤딩 + 이모지 + "카드 N — 제목" 형식
   - 🟪과 🟦을 교대 사용
   - 각 카드 내부에 #### (h4) 소제목 2~4개 + 불릿 포인트 + 설명 단락을 혼합
   - 한 카드 안에서 소제목으로 구조를 잡고, 불릿으로 핵심을 짚고, 단락으로 맥락을 보충
   - 발화자가 든 예시, 비유, 수치, 사례를 빠짐없이 포함
   - 읽는 사람이 "이 카드만 읽으면 그 주제는 완전히 이해했다"고 느껴야 함
   - 영상을 안 봐도 될 만큼 상세해야 함 — 단순 한 줄 요약 금지

4. 💡 이렇게 보면 됩니다 — 실무 적용, 해석 포인트, 시청 후 행동 제안 (이모지로 시작)

5. 저장용 보강 섹션
   - Table of Contents
   - SCQA
   - Data & Evidence
   - Key Insights & Takeaways
   - Practical Implications
${timelineSection}
[Style]
- 카드 헤딩은 반드시 ### (h3) 마크다운 헤딩 사용
- 한눈에 읽히면서도 AI가 파싱하기 좋은 마크다운 구조
- 자연스럽고 읽기 쉬운 톤, 단 밀도와 상세함을 최우선
- 카드 안에서 발화자의 원래 논리 흐름을 최대한 살려서 서술
- 표가 유용하면 간단한 마크다운 표 사용 가능
- Timeline은 제공된 마크다운 링크 형식을 그대로 유지 (예: [MM:SS](URL))

영상: ${meta.title} (${meta.channel})
URL: ${meta.videoUrl}

[Transcript]
${compactTranscript(transcript, 16000)}`;
}

function buildDetailedPrompt(
  transcript: string,
  meta: { title: string; channel: string; videoUrl: string },
  timelineHint: string,
): string {
  return `다음 자막을 바탕으로 심층 분석 리포트를 한국어 마크다운으로 작성하세요.

[중요] 반드시 리포트 본문 시작 전에 아래 2줄을 정확히 출력하세요:
GENRE: {주장르#세부장르} (Tech, Business, Readership, 자기개발 중 택1, 세부장르 포함)
KEYWORDS: {키워드1}, {키워드2}, {키워드3}

[Sections]
1. 🎯 한 줄 결론 — 가장 중요한 한 문장
2. ✅ 한눈에 정리 — 핵심 포인트 5~8개 불릿
3. 🟪/🟦 멀티카드 상세 섹션 — 5~7개 카드 (### h3 헤딩 + 🟪/🟦 교대). 각 카드 내부에 #### h4 소제목 2~4개 + 불릿 + 설명 단락 혼합. 영상을 안 봐도 완전히 이해 가능한 깊이
4. 💡 이렇게 보면 됩니다 — 실무 적용, 해석 포인트
5. 저장용 보강 섹션
   - Table of Contents
   - SCQA (Situation/Complication/Question/Answer)
   - Data & Evidence — 영상에서 언급된 수치, 통계, 사례를 표로 정리
   - Key Insights & Takeaways
   - Practical Implications
6. 심층 분석
   - 발화자의 핵심 논지와 근거 구조
   - 논리적 취약점이나 누락된 관점 (있다면)
   - 다른 영상/자료와 비교할 포인트
${timelineHint ? `7. Timeline — 주요 타임라인 요약\n\n[타임스탬프 참고 데이터]\n${timelineHint}\n` : ''}
[Style]
- 밀도 높은 분석 리포트 톤
- 표를 적극 활용
- 영상을 안 봐도 완전한 이해가 가능해야 함

영상: ${meta.title} (${meta.channel})
URL: ${meta.videoUrl}

[Transcript]
${compactTranscript(transcript, 18000)}`;
}

/* ── Cloud STT 전용 프롬프트 (cards 형식이지만 SCQA 생략) ── */

function buildCloudSttPrompt(cfg: SummaryConfig): string {
  return `다음은 YouTube 영상의 STT 전사본이다. 이를 바탕으로 카드 스타일의 한국어 마크다운 리포트를 작성하라.

[중요] 반드시 리포트 본문 시작 전에 아래 2줄을 정확히 출력하세요:
GENRE: {주장르#세부장르} (Tech, Business, Readership, 자기개발 중 택1, 세부장르 포함)
KEYWORDS: {키워드1}, {키워드2}, {키워드3}

이 리포트의 목표: 영상을 보지 않아도 핵심 논지, 근거, 맥락을 완전히 이해할 수 있는 수준의 상세 요약.

[Sections — 반드시 이 구조와 이모지를 정확히 따라라]

1. 🎯 한 줄 결론 — 가장 중요한 한 문장 (마크다운 헤딩 없이 이모지+볼드로 시작)

2. ✅ 한눈에 정리 — 핵심 포인트 5~8개 불릿 (마크다운 헤딩 없이 이모지로 시작)

3. 멀티카드 상세 섹션 — **5~7개 카드**. 반드시 아래 형식과 예시를 따라라:

### 🟪 카드 1 — [주제 제목]

[도입 단락: 이 주제의 맥락과 핵심 주장을 1~2문장으로]

#### 1) [소주제 A]
- 핵심 포인트 1
- 핵심 포인트 2
- 핵심 포인트 3

[소주제 A에 대한 부연 설명 단락. 발화자가 든 근거, 수치, 비유를 상세히.]

#### 2) [소주제 B]
- 핵심 포인트 1
- 핵심 포인트 2

[소주제 B에 대한 부연 설명 단락.]

#### 3) [소주제 C]
- 핵심 포인트 1
- 핵심 포인트 2

[결론/시사점 단락]

### 🟦 카드 2 — [주제 제목]
(🟪/🟦 교대 반복, 동일 구조)

   규칙:
   - 카드는 **5~7개** (절대 8개 이상 만들지 마세요)
   - 카드 수가 적은 대신, 각 카드의 깊이와 분량을 극대화
   - 반드시 ### (h3) 마크다운 헤딩 + 이모지 + "카드 N — 제목" 형식
   - 🟪과 🟦을 교대 사용
   - 각 카드 내부에 #### (h4) 소제목 2~4개 + 불릿 포인트 + 설명 단락을 혼합
   - 한 카드 안에서 소제목으로 구조를 잡고, 불릿으로 핵심을 짚고, 단락으로 맥락을 보충
   - 발화자가 든 예시, 비유, 수치, 사례를 빠짐없이 포함
   - 영상을 안 봐도 될 만큼 상세해야 함 — 단순 한 줄 요약 금지

4. 💡 이렇게 보면 됩니다 — 실무 적용, 해석 포인트, 시청 후 행동 제안

5. 저장용 보강 섹션
   - Table of Contents
   - SCQA (Situation/Complication/Question/Answer)
   - Data & Evidence
   - Key Insights & Takeaways
   - Practical Implications

6. Timeline — 가능하면 5~10개 구간으로 요약 (시간 추정 가능 범위에서만, 부정확하면 생략 가능)

[Style]
- 카드 헤딩은 반드시 ### (h3) 마크다운 헤딩 사용
- 자연스럽고 읽기 쉬운 톤, 단 밀도와 상세함을 최우선
- 카드 안에서 발화자의 원래 논리 흐름을 최대한 살려서 서술
- 표가 유용하면 간단한 마크다운 표 사용 가능

영상 정보:
- 제목: ${cfg.title}
- 채널: ${cfg.channel}
- URL: ${cfg.videoUrl}

전사본:
${compactTranscript(cfg.transcript, cfg.format === 'brief' ? 10000 : 18000)}`;
}

/* ── API callers ── */

async function callResponsesAPI(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        { role: 'system', content: 'YouTube 영상을 한국어로 구조화 요약하는 AI 어시스턴트.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  for (const item of data.output || []) {
    for (const c of item.content || []) {
      if ((c.type === 'output_text' || c.type === 'text') && c.text) {
        return c.text.trim();
      }
    }
  }
  throw new Error('요약 응답 파싱 실패');
}

async function summarizeGrok(prompt: string): Promise<string> {
  const apiKey = requireEnv('XAI_API_KEY');
  const model = env('GROK_MODEL', 'grok-4-1-fast-reasoning');
  console.log(`  xAI 요약 모델: ${model}`);
  return callResponsesAPI('https://api.x.ai', apiKey, model, prompt);
}

async function summarizeOpenAI(prompt: string): Promise<string> {
  const apiKey = requireEnv('OPENAI_API_KEY');
  const model = env('OPENAI_SUMMARY_MODEL', 'gpt-5.4');
  console.log(`  OpenAI 요약 모델: ${model}`);
  return callResponsesAPI('https://api.openai.com', apiKey, model, prompt);
}

/* ── Public API ── */

export interface SummarizeOptions {
  transcript: string;
  meta: { title: string; channel: string; videoUrl: string };
  format: 'brief' | 'cards' | 'detailed';
  timelineHint?: string;
  useCloudSttPrompt?: boolean;  // Cloud STT 경로에서 온 경우
}

export async function summarize(opts: SummarizeOptions): Promise<string> {
  let prompt: string;

  if (opts.useCloudSttPrompt) {
    prompt = buildCloudSttPrompt({
      transcript: opts.transcript,
      title: opts.meta.title,
      channel: opts.meta.channel,
      videoUrl: opts.meta.videoUrl,
      format: opts.format,
    });
  } else {
    switch (opts.format) {
      case 'brief':
        prompt = buildBriefPrompt(opts.transcript, opts.meta);
        break;
      case 'detailed':
        prompt = buildDetailedPrompt(opts.transcript, opts.meta, opts.timelineHint || '');
        break;
      case 'cards':
      default:
        prompt = buildCardsPrompt(opts.transcript, opts.meta, opts.timelineHint || '');
        break;
    }
  }

  // Cloud STT 경로 → OpenAI 우선, 기본 → Grok 우선
  const useOpenAIPrimary = opts.useCloudSttPrompt && !!env('OPENAI_API_KEY');
  const [primary, fallback] = useOpenAIPrimary
    ? [summarizeOpenAI, summarizeGrok]
    : [summarizeGrok, summarizeOpenAI];

  try {
    return await primary(prompt);
  } catch (e: any) {
    console.log(`  1차 요약 실패: ${e.message}`);
    console.log('  폴백 요약 시도...');
    return fallback(prompt);
  }
}

/* ── Genre/Keywords extractor ── */

export function parseMetaFromSummary(text: string): { genre: string; keywords: string[]; body: string } {
  let genre = 'YouTube';
  let keywords: string[] = [];
  let body = text;

  const genreMatch = text.match(/^GENRE:\s*(.+)$/m);
  if (genreMatch) {
    genre = genreMatch[1].trim();
    body = body.replace(genreMatch[0], '');
  }

  const keywordsMatch = text.match(/^KEYWORDS:\s*(.+)$/m);
  if (keywordsMatch) {
    keywords = keywordsMatch[1].split(',').map((k) => k.trim()).filter(Boolean);
    body = body.replace(keywordsMatch[0], '');
  }

  body = body.replace(/^\s*\n{2,}/g, '\n').trim();
  return { genre, keywords, body };
}
