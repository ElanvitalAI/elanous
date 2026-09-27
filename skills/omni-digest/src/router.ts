import type { SummaryFormat, OutputTarget, RouteDecision } from './types.js';

export interface RouterInput {
  intentText: string;
  forceFormat?: string;
  forceTargets?: string;
}

export function decideRoute(input: RouterInput): RouteDecision {
  const text = (input.intentText || '').trim();
  let format: SummaryFormat = 'rich-cards';
  let targets: OutputTarget[] = ['obsidian'];
  const reasons: string[] = [];

  // "sum" 키워드 감지 → summarize CLI 우선 사용
  // "sum full" → summarize CLI가 추출+요약 모두 수행 (Grok 스킵)
  const summarizeFull = /\bsum\s+full\b/i.test(text);
  const useSummarize = summarizeFull || /\bsum\b/i.test(text);
  // enrichWithCrawl: 명시 요청 = 'force', 스마트 자동 판단 = 'smart', 비활성 = false
  const enrichExplicit = /\bcrawl\b|보강|배경|컨텍스트|맥락|심화|deep\s*dive|enrich|풍부/i.test(text);
  const enrichWithCrawl = enrichExplicit ? 'force' as const : 'smart' as const;

  if (input.forceFormat) {
    const valid: SummaryFormat[] = ['essential', 'rich', 'rich-cards'];
    format = valid.includes(input.forceFormat as SummaryFormat) ? input.forceFormat as SummaryFormat : 'rich-cards';
    reasons.push(`--format ${input.forceFormat}`);
  }
  if (input.forceTargets) {
    const validT: OutputTarget[] = ['obsidian', 'markdown', 'web', 'web-deploy', 'pdf'];
    targets = input.forceTargets.split(',').map(t => t.trim()).filter(t => validT.includes(t as OutputTarget)) as OutputTarget[];
    if (targets.length === 0) targets = ['obsidian'];
    reasons.push(`--target ${input.forceTargets}`);
  }
  if (input.forceFormat || input.forceTargets) {
    if (summarizeFull) reasons.push('summarize CLI end-to-end');
    else if (useSummarize) reasons.push('summarize CLI 우선');
    return { format, targets, reason: reasons.join(', '), useSummarize, summarizeFull, enrichWithCrawl };
  }

  // Format detection
  if (/상세|자세히|깊게|detailed|분석|심층|rich(?!\s*card)/i.test(text)) { format = 'rich'; reasons.push('심층 분석'); }
  else if (/간단히|짧게|요약만|essential|brief|빠르게/i.test(text)) { format = 'essential'; reasons.push('간략 요약'); }
  else { format = 'rich-cards'; reasons.push('기본 카드형'); }

  // Target detection
  const det: OutputTarget[] = [];
  if (/ccv웹/i.test(text))                          { det.push('web-deploy'); reasons.push('ccv웹 배포'); }
  else if (/cc웹|웹으로|웹페이지/i.test(text))        { det.push('web');        reasons.push('cc웹'); }
  if (/pdf|PDF로/i.test(text))                       { det.push('pdf');        reasons.push('PDF'); }
  if (/markdown|md로/i.test(text))                   { det.push('markdown');   reasons.push('마크다운'); }

  const markdownOnly = det.length === 1 && det[0] === 'markdown';
  if (det.length === 0 || (!markdownOnly && !det.includes('obsidian'))) det.unshift('obsidian');
  targets = det;

  if (summarizeFull) reasons.push('summarize CLI end-to-end');
  else if (useSummarize) reasons.push('summarize CLI 우선');
  if (enrichWithCrawl === 'force') reasons.push('omni-crawl 보강 (명시)');
  return { format, targets, reason: reasons.join(', '), useSummarize, summarizeFull, enrichWithCrawl };
}
