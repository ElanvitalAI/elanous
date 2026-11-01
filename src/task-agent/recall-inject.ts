import { readFileSync } from 'node:fs';
import { readPriorMustFix, PRIOR_RESULT_NOT_RECOVERED } from './review-prior-fix.js';
import type { TaskCard } from './task-hand.js';

export const RECALL_MAX_ITEMS = 8;
export const RECALL_MAX_CHARS = 2000;

export interface PriorLessons {
  block?: string;
  priorCards: number;
  items: number;
  chars: number;
  truncated: boolean;
}

type ReviewResultReader = (path: string) => string;

function compact(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** Same-cell failure and review lessons for the next hand; no broad memory query. */
export function priorLessonsFor(
  checklistId: string,
  cards: readonly TaskCard[],
  readReviewResult: ReviewResultReader = (path) => readFileSync(path, 'utf8'),
): PriorLessons {
  const prior = cards
    .filter((card) => card.checklistId === checklistId)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const candidates: Array<{ cardId: string; text: string }> = [];

  for (const card of prior) {
    if (card.status === 'failed' || card.status === 'launch-failed') {
      const failure = [...card.history].reverse().find((event) => ['failed', 'run-failed', 'launch-failed',
        'graph-run-failed', 'tier-split-failed', 'device-first-launch-failed'].includes(event.event));
      const reason = compact(failure?.detail ?? failure?.reason ?? '');
      candidates.push({ cardId: card.id, text: `${card.status} 사유: ${reason || '실패 사유 미기록'}` });
    }
    for (const request of card.reviewRequests ?? []) {
      const result = readPriorMustFix(request.resultPath, request.pr, request.head, readReviewResult);
      if (result.status === 'recovered') {
        for (const finding of result.items) {
          const normalized = compact(finding);
          if (normalized) candidates.push({ cardId: card.id, text: `PR #${request.pr} must-fix: ${normalized}` });
        }
      } else {
        candidates.push({ cardId: card.id, text: `PR #${request.pr} · ${PRIOR_RESULT_NOT_RECOVERED} (${result.reason})` });
      }
    }
  }

  if (candidates.length === 0) return { priorCards: prior.length, items: 0, chars: 0, truncated: false };

  const itemLimited = candidates.length > RECALL_MAX_ITEMS;
  const itemMarker = `… 항목 상한 ${RECALL_MAX_ITEMS}건 초과분 생략`;
  const charMarker = `… 글자 상한 ${RECALL_MAX_CHARS}자에서 나머지 생략`;
  const selected: typeof candidates = [];
  const pool = candidates.slice(0, RECALL_MAX_ITEMS);
  const headingFor = (items: typeof candidates) => items.length
    ? `## 앞선 교훈(같은 칸 · 카드 ${[...new Set(items.map((item) => item.cardId))].join(', ')})`
    : '## 앞선 교훈(같은 칸)';
  let charLimited = false;
  for (const candidate of pool) {
    const next = [...selected, candidate];
    const heading = headingFor(next);
    const lines = [heading, ...next.map((item) => `- ${item.cardId}: ${item.text}`)];
    const reserve = [...(itemLimited ? [itemMarker] : []), charMarker];
    if ([...lines, ...reserve].join('\n').length > RECALL_MAX_CHARS) {
      charLimited = true;
      break;
    }
    selected.push(candidate);
  }
  const heading = headingFor(selected);
  const lines = [heading, ...selected.map((item) => `- ${item.cardId}: ${item.text}`)];
  const markers = [
    ...(itemLimited ? [itemMarker] : []),
    ...(charLimited || selected.length < pool.length ? [charMarker] : []),
  ];
  // A single oversized card is omitted as a whole, never sliced through its id or lesson text.
  if (!selected.length) markers.unshift(`… 첫 항목이 ${RECALL_MAX_CHARS}자 상한을 넘어 생략`);
  let block = [...lines, ...markers].join('\n');
  while (block.length > RECALL_MAX_CHARS && selected.length) {
    selected.pop();
    charLimited = true;
    const shortenedHeading = headingFor(selected);
    const shortenedLines = [shortenedHeading, ...selected.map((item) => `- ${item.cardId}: ${item.text}`)];
    const shortenedMarkers = [
      ...(itemLimited ? [itemMarker] : []), charMarker,
      ...(!selected.length ? [`… 첫 항목이 ${RECALL_MAX_CHARS}자 상한을 넘어 생략`] : []),
    ];
    block = [...shortenedLines, ...shortenedMarkers].join('\n');
  }
  return { block, priorCards: prior.length, items: selected.length,
    chars: block.length, truncated: itemLimited || charLimited };
}
