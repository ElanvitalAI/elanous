/** Grok summarization — unified prompts for all source types + X-specific prompts absorbed from x-to-obsidian */

import { env, requireEnv } from './env.js';
import { compactText } from './util.js';
import type { SummaryFormat, TweetMeta, Reply } from './types.js';

/* ── Generic prompts (web, github, docs) ── */

function genericPrompt(format: SummaryFormat, content: string, meta: { title: string; source: string; url?: string }): string {
  const header = `[중요] 반드시 리포트 본문 시작 전에 아래 2줄을 정확히 출력하세요:
GENRE: {주장르#세부장르} (Tech, Business, Crypto, 자기개발, 시사 중 택1, 세부장르 포함)
KEYWORDS: {키워드1}, {키워드2}, {키워드3}`;
  const footer = `[출처] ${meta.title} (${meta.source})\n${meta.url ? `URL: ${meta.url}` : ''}\n\n[콘텐츠]\n`;

  if (format === 'essential') return `다음 콘텐츠의 간단 요약을 한국어 마크다운으로 작성.\n\n${header}\n\n[Sections]\n1. 🎯 한 줄 결론\n2. ✅ 핵심 포인트 5~8개 불릿\n3. SCQA 각 1줄\n4. 💡 시사점 3~5개\n\n[Style] 핵심 위주, 장황 X\n\n${footer}${compactText(content, 8000)}`;
  if (format === 'rich') return `다음 콘텐츠의 심층 분석 리포트를 한국어 마크다운으로 작성.\n\n${header}\n\n[Sections]\n1. 🎯 한 줄 결론\n2. ✅ 한눈에 정리 5~8개\n3. 🟪/🟦 카드형 상세 8~16개 (각 3~6문단)\n4. 💡 이렇게 보면 됩니다\n5. ToC, SCQA(상세), Data & Evidence(표), Key Insights 7~10개, Practical Implications\n6. 심층 분석: 논지+근거, 취약점, 비교 포인트\n\n[Style] 밀도 높은 리포트, 표 적극 활용\n\n${footer}${compactText(content, 18000)}`;
  // rich-cards (default)
  return `다음 콘텐츠의 카드 스타일 한국어 마크다운 요약 작성. 원문을 안 읽어도 충분히 이해 가능해야.\n\n${header}\n\n[Sections]\n1. 🎯 한 줄 결론\n2. ✅ 한눈에 정리 5~8개\n3. 🟪/🟦 카드형 상세 6~12개 (각 2~5문단)\n4. 💡 이렇게 보면 됩니다\n5. ToC, SCQA, Key Insights, Practical Implications\n\n[Style] 디스코드 카드 스타일, 자연스럽고 상세\n\n${footer}${compactText(content, 16000)}`;
}

/* ── X post prompts ── */

function xPostPrompt(format: SummaryFormat, meta: TweetMeta, repliesText: string, linksText: string): string {
  const header = `[중요] 반드시 리포트 본문 시작 전에 아래 2줄을 정확히 출력하세요:
GENRE: {주장르#세부장르} (Tech, Business, Crypto, 자기개발, 시사 중 택1, 세부장르 포함)
KEYWORDS: {키워드1}, {키워드2}, {키워드3}`;
  // 첨부 영상 전사문이 있으면 본문 다음으로 우선순위가 높은 1차 자료로 넣는다
  const mediaBlock = meta.mediaTranscript
    ? `\n\n[첨부 미디어 — 영상 전사·이미지·화면 설명 · 1차 자료, 본문과 동등하게 취급할 것]\n${compactText(meta.mediaTranscript, 12000)}`
    : '';
  const info = `[포스트 정보]\n- 작성자: ${meta.author}\n- 작성일: ${meta.createdAt}\n- 노출수: ${meta.viewCount} | 좋아요: ${meta.likeCount} | RT: ${meta.retweetCount} | 댓글수: ${meta.replyCount}\n\n[본문]\n${meta.text}${mediaBlock}\n\n[본문 링크]\n${linksText}\n\n[댓글 샘플]\n${repliesText}`;

  if (format === 'essential') return `다음 X 포스트의 간단 요약.\n\n${header}\n\n[Sections] 🎯 한 줄 결론, ✅ 핵심 5~8개, SCQA 각 1줄, 💡 시사점 3~5개\n[Style] 핵심 위주\n\n${info}`;
  if (format === 'rich') return `다음 X 포스트와 댓글의 심층 분석.\n\n${header}\n\n[Sections] 🎯 한 줄 결론, ✅ 한눈에 정리, 🟪/🟦 카드 8~16개(각 3~6문단), 💡 해석, ToC/SCQA/Comment Analysis/Data & Evidence/Key Insights/Practical Implications, 심층 분석\n[Style] 밀도 높은 리포트, 댓글 부족시 "데이터 제한" 명시\n\n${info}`;
  return `다음 X 포스트와 댓글의 카드 스타일 요약. 원문+댓글 안 읽어도 이해 가능.\n\n${header}\n\n[Sections] 🎯 한 줄 결론, ✅ 한눈에 정리 5~8개, 🟪/🟦 카드 6~12개(각 2~5문단), 💡 이렇게 보면 됩니다, ToC/SCQA/Comment Analysis/Practical Implications\n[Style] 디스코드 카드, 댓글 부족시 "데이터 제한"\n\n${info}`;
}

/* ── X article prompt ── */

function xArticlePrompt(format: SummaryFormat, content: string, authorHandle: string): string {
  const header = `작성자: @${authorHandle}\n\n[중요] 반드시 리포트 본문 시작 전에 아래 2줄을 정확히 출력:\nGENRE: {주장르#세부장르}\nKEYWORDS: {키워드1}, {키워드2}, {키워드3}`;
  if (format === 'essential') return `다음 X 아티클 간단 요약.\n\n${header}\n\n[Sections] Executive Summary 6~10불릿, SCQA 각 1줄, Key Insights 5개\n[Style] 핵심 위주\n\n[아티클 본문]\n${compactText(content, 10000)}`;
  if (format === 'rich') return `다음 X 아티클 심층 분석.\n\n${header}\n\n[Sections] ToC, Executive Summary 7~10불릿, SCQA(상세), Detailed Analysis, Data & Evidence(표), Key Insights 7~10개, 심층 분석, Practical Implications\n[Style] 밀도 높은 리포트, 표 활용, 빠짐없이 커버\n\n[아티클 본문]\n${compactText(content, 18000)}`;
  return `다음 X 아티클 상세 리포트.\n\n${header}\n\n[Sections] ToC, Executive Summary 5불릿, SCQA(불릿), Detailed Analysis(헤딩 다수), Data & Evidence, Key Insights 5~7불릿\n[Style] 간결/정확, 표 활용\n\n[아티클 본문]\n${compactText(content, 16000)}`;
}

/* ── Grok API caller ── */

async function callGrok(prompt: string): Promise<string> {
  const apiKey = requireEnv('XAI_API_KEY');
  const model = env('GROK_MODEL', 'grok-4-1-fast-reasoning');
  console.log(`  xAI 모델: ${model}`);
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: [{ role: 'system', content: '콘텐츠를 심층 분석해 구조화된 한국어 요약을 생성하는 AI.' }, { role: 'user', content: prompt }], temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`Grok API ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  for (const item of data.output || []) for (const c of item.content || []) if ((c.type === 'output_text' || c.type === 'text') && c.text) return c.text.trim();
  throw new Error('요약 응답 파싱 실패');
}

/* ── Public API ── */

export async function summarizeGeneric(content: string, title: string, source: string, url: string | undefined, format: SummaryFormat): Promise<string> {
  return callGrok(genericPrompt(format, content, { title, source, url }));
}

export async function summarizeXPost(meta: TweetMeta, replies: Reply[], allRefLinks: string[], format: SummaryFormat): Promise<string> {
  const repliesText = replies.length > 0 ? replies.map(r => `- ${r.author} (likes:${r.likes}): ${r.text}`).join('\n') : '- 댓글 없음';
  const linksText = allRefLinks.length > 0 ? allRefLinks.map(u => `- ${u}`).join('\n') : '- 링크 없음';
  return callGrok(xPostPrompt(format, meta, repliesText, linksText));
}

export async function summarizeXArticle(content: string, authorHandle: string, format: SummaryFormat): Promise<string> {
  return callGrok(xArticlePrompt(format, content, authorHandle));
}

/* ── Genre/Keywords extractor ── */

export function parseMetaFromSummary(text: string): { genre: string; keywords: string[]; body: string } {
  let genre = 'General', keywords: string[] = [], body = text;
  const gm = text.match(/^GENRE:\s*(.+)$/m);   if (gm) { genre = gm[1].trim(); body = body.replace(gm[0], ''); }
  const km = text.match(/^KEYWORDS:\s*(.+)$/m); if (km) { keywords = km[1].split(',').map(k => k.trim()).filter(Boolean); body = body.replace(km[0], ''); }
  return { genre, keywords, body: body.replace(/^\s*\n{2,}/g, '\n').trim() };
}
