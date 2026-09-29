// 조사 장면(드라이브 RFC §1c · 대표 «grok 웹검색 ⊕ firecrawl 이 둘 다 셋팅됐을 때의 화려함을 일부러 보여 줘야»).
// 원천 = 🅢 `elanous research` 가 내는 관측(골 `ASK-elanous-research-cli-with-visible-engine-fanout` §Answer 2):
//   `research.query`(질문 · 엔진 목록) · 엔진마다 `research.result`(id · hits · ms · error) · MAX 면 `research.source`(url · 엔진 · 합침).
// 이 모듈은 그 줄을 «한 번의 조사» 단위로 묶는다 — 부채꼴(엔진) · 출처 비 · 인용 후보. 순수 · 시험 대상.
// ⚠️ 이벤트 이름은 `category=research, event=query|result|source` 와 `event=research.query…` 둘 다 받는다(착지 전이라 모양이 굳지 않았다).

import type { LogRow } from '@/nexus/client';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export interface ResearchEngine { id: string; hits: number; ms: number | null; error: string | null; done: boolean; credits?: number | null }
export interface ResearchSource {
  url: string; engine: string; merged: boolean; host: string;
  /** 무대용(있으면) — 제목 · 두뇌가 인용으로 고름 · 본문을 긁어 옴. */
  title?: string | null; cited?: boolean; scraped?: boolean;
}
export interface ResearchSession {
  key: string;
  ts: string;
  question: string;
  runId: string | null;
  engines: ResearchEngine[];
  sources: ResearchSource[];
  /** 엔진별 출처 수(출처 비 — 합침은 처음 낸 엔진에만). */
  share: Record<string, number>;
  /** 조사 등급 — `full`(유료 엔진 켜짐) · `free`(무료 폴백) · 모름. */
  tier: 'full' | 'free' | null;
  /** 그 조사 뒤 두뇌가 낸 판단의 «왜»(있으면) — 인용 카드가 날아가 붙는 자리. */
  why: string | null;
}

function kindOf(row: LogRow): 'query' | 'result' | 'source' | 'why' | null {
  if (row.category === 'harness.decision' && typeof row.data?.runId === 'string') return 'why';
  if (!row.category.startsWith('research')) return null;
  const e = row.event.replace(/^research\./, '');
  return e === 'query' || e === 'result' || e === 'source' ? e : null;
}

function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url.slice(0, 40); }
}

/** 창 안 조사들(최신이 앞). `result`·`source` 는 같은 런(없으면 시각상 가장 가까운 앞 `query`)에 붙인다. */
export function researchSessions(rows: readonly LogRow[]): ResearchSession[] {
  const sorted = rows.filter((r) => kindOf(r)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const sessions: ResearchSession[] = [];
  const openByRun = new Map<string, ResearchSession>();
  let last: ResearchSession | null = null;
  for (const row of sorted) {
    const k = kindOf(row)!;
    const d = row.data ?? {};
    const runId = str(d.runId);
    if (k === 'query') {
      const engines = Array.isArray(d.engines) ? (d.engines as unknown[]).map((e) => str(e)).filter((e): e is string => !!e) : [];
      const s: ResearchSession = {
        key: `${row.ts}|${runId ?? ''}`, ts: row.ts, question: str(d.question) ?? str(d.query) ?? '(질문 없음)', runId,
        engines: engines.map((id) => ({ id, hits: 0, ms: null, error: null, done: false })), sources: [], share: {},
        tier: d.tier === 'full' || d.tier === 'free' ? d.tier : d.free === true ? 'free' : null, why: null,
      };
      sessions.push(s);
      if (runId) openByRun.set(runId, s);
      last = s;
      continue;
    }
    if (k === 'why') {
      // 같은 런의 조사 «뒤» 판단 — 인용이 붙는 «왜». 조사 없는 런의 판단은 무시한다.
      const target = runId ? openByRun.get(runId) : null;
      if (target && !target.why) target.why = str(d.reason) ?? str(d.why) ?? str(d.what);
      continue;
    }
    const s = (runId && openByRun.get(runId)) || last;
    if (!s) continue;
    if (k === 'result') {
      const id = str(d.id) ?? str(d.engine) ?? 'engine';
      let e = s.engines.find((x) => x.id === id);
      if (!e) { e = { id, hits: 0, ms: null, error: null, done: false }; s.engines.push(e); }
      e.hits = num(d.hits);
      e.ms = typeof d.ms === 'number' ? d.ms : null;
      e.error = str(d.error);
      e.done = true;
      if (typeof d.credits === 'number') e.credits = d.credits;
    } else {
      const url = str(d.url);
      if (!url) continue;
      const engine = str(d.engine) ?? 'engine';
      const merged = d.merged === true || d.dedup === true;
      s.sources.push({ url, engine, merged, host: hostOf(url), title: str(d.title), cited: d.cited === true || d.picked === true, scraped: d.scraped === true });
      if (!merged) s.share[engine] = (s.share[engine] ?? 0) + 1;
    }
  }
  return sessions.reverse();
}
