import type { ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';

/** Format evidence without losing the source URL or mistaking publication date for observation time. */
export function formatResearchEvidenceAttribution(evidence: ResearchEvidenceEnvelope): string {
  const publication = evidence.publishedAt
    ? ` · published ${evidence.publishedAt.slice(0, 10)}`
    : ' · publication date unavailable';
  return `- [${evidence.outcome}] ${evidence.sourceKind} · ${evidence.source}${publication}: ${evidence.content}`;
}

function isHttpUrl(source: string): boolean {
  if (!/^https?:\/\//iu.test(source) || source !== source.trim() || /\s/u.test(source)) return false;
  try {
    const parsed = new URL(source);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch { return false; }
}

/** Return exact HTTP(S) source URLs from structured evidence without normalizing their spelling. */
export function researchEvidenceSourceUrls(evidence: readonly ResearchEvidenceEnvelope[]): string[] {
  return [...new Set(evidence
    .filter(({ outcome }) => outcome !== 'failed')
    .map(({ source }) => source)
    .filter(isHttpUrl))];
}

function answerContainsExactUrl(answer: string, sourceUrl: string): boolean {
  for (const match of answer.matchAll(/https?:\/\/[^\s<>"`]+/giu)) {
    const candidate = match[0];
    if (candidate === sourceUrl) return true;
    const start = match.index ?? -1;
    const before = start > 0 ? answer[start - 1] : '';
    if (before === '(' && candidate.endsWith(')')
      && (candidate.match(/\)/gu)?.length ?? 0) > (candidate.match(/\(/gu)?.length ?? 0)
      && candidate.slice(0, -1) === sourceUrl) return true;
    if (before === '[' && candidate.endsWith(']')
      && (candidate.match(/\]/gu)?.length ?? 0) > (candidate.match(/\[/gu)?.length ?? 0)
      && candidate.slice(0, -1) === sourceUrl) return true;
  }
  return false;
}

/** Add observed source URLs to the user-facing synthesis when the model omits them. */
export function ensureResearchAnswerHasSourceUrl(answer: string, sourceUrls: readonly string[]): string {
  const observedUrls = [...new Set(sourceUrls.filter(isHttpUrl))];
  if (observedUrls.length === 0 || observedUrls.some((url) => answerContainsExactUrl(answer, url))) return answer;
  return `${answer.trim()}\n\n## Sources\n${observedUrls.slice(0, 5).map((url) => `- ${url}`).join('\n')}`;
}
