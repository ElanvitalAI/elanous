import type { RegisteredIntakeSource } from './intake-sources.js';

/** listChecklist(v).items 꼴 — 호출 쪽이 다음 두 판 칸을 모아 넘긴다. */
export interface PrefetchCell {
  id: string;
  title: string;
  status: string;
  refs?: readonly string[];
  /** 그 판 날짜(YYYY-MM-DD). 주제 until 로 실린다. */
  until?: string;
}

export interface PrefetchTopic {
  topic: string;
  cellIds: string[];
  until?: string;
}

export interface PrefetchTopicsOpts {
  max?: number;
}

/**
 * 의도적 경계: 이 파일은 제안만 만든다. intake CLI `prefetch --dry-run|--apply` 와
 * REQ-LEDGER 테마 원천 교체는 다음 조각 — addSource · CLI 를 부르지 않는다.
 */
function backtickTokens(title: string): string[] {
  const tokens: string[] = [];
  const re = /`([^`]+)`/g;
  for (let match = re.exec(title); match; match = re.exec(title)) {
    const token = match[1]!.trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

function englishProperNouns(title: string): string[] {
  const stripped = title.replace(/`[^`]*`/g, ' ');
  const tokens: string[] = [];
  // CamelCase · 내부 대문자 식별자, 또는 2글자 이상 대문자(하이픈 칸 id 포함).
  const re = /\b(?:[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z]{2,}(?:-[A-Z0-9]+)*)\b/g;
  for (let match = re.exec(stripped); match; match = re.exec(stripped)) tokens.push(match[0]);
  return tokens;
}

function rfcNames(refs: readonly string[] | undefined): string[] {
  if (!refs) return [];
  const names: string[] = [];
  for (const ref of refs) {
    const file = (ref.split('#')[0] ?? '').split('/').pop() ?? '';
    const stem = file.replace(/\.[A-Za-z0-9]+$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
    if (stem.startsWith('RFC-') && stem.length > 4) names.push(stem);
  }
  return names;
}

function laterDate(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function sourceId(topic: string): string {
  const slug = topic.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `ref-prefetch-${slug || 'topic'}`;
}

export function prefetchTopics(cells: readonly PrefetchCell[], opts: PrefetchTopicsOpts = {}): PrefetchTopic[] {
  const max = opts.max ?? 5;
  const byTopic = new Map<string, { topic: string; count: number; cellIds: string[]; until?: string }>();
  const order: string[] = [];
  for (const cell of cells) {
    if (cell.status !== 'yellow') continue;
    const tokens = new Set([
      ...englishProperNouns(cell.title),
      ...backtickTokens(cell.title),
      ...rfcNames(cell.refs),
    ]);
    for (const topic of tokens) {
      let acc = byTopic.get(topic);
      if (!acc) {
        acc = { topic, count: 0, cellIds: [], until: cell.until };
        byTopic.set(topic, acc);
        order.push(topic);
      }
      acc.count++;
      if (!acc.cellIds.includes(cell.id)) acc.cellIds.push(cell.id);
      acc.until = laterDate(acc.until, cell.until);
    }
  }
  return order
    .map((topic) => byTopic.get(topic)!)
    .sort((a, b) => b.count - a.count || order.indexOf(a.topic) - order.indexOf(b.topic))
    .slice(0, Math.max(0, max))
    .map(({ topic, cellIds, until }) => until === undefined ? { topic, cellIds } : { topic, cellIds, until });
}

export function prefetchSources(topics: readonly PrefetchTopic[], seat: string, now: Date): RegisteredIntakeSource[] {
  // 판 날짜를 모르면 until 을 비운다 — now 로 채우면 untilMs(그날 00:00Z) 기준으로 이미 만료된 제안이 된다.
  void now;
  return topics.map((entry) => ({
    id: sourceId(entry.topic),
    seat,
    kind: 'github-query',
    spec: entry.topic,
    every: '1d',
    ...(entry.until === undefined ? {} : { until: entry.until }),
    why: `REF-PREFETCH ⊕ ${entry.cellIds.join(' ')}`,
  }));
}
