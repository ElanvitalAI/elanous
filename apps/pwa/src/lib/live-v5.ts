// Live MAX v5 «시각» 판의 데이터(RFC §7 · 대표 09:4x 레퍼런스 두 장) — 격자 칸마다 «진짜 수»를 접는다(순수 · 시험 대상).
// 원천은 Live 가 이미 받는 로그뿐이다: `llm.usage`(모델·사이트·과금·토큰) · 런 신호(runId·단계) · 판단 스트림.
// ⛔ 없는 칸은 만들지 않는다 — `llm.usage` 에 지연·역할이 없어서 히트맵은 «모델 × 사이트», 요청 창에 지연 칸이 없다.

import type { LogRow } from '@/nexus/client';
import { classifySignal, LIVE_STAGES, type LiveBoardData, type LiveStage } from './live-signals';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export interface UsageReq {
  ts: string;
  t: number;
  model: string;
  site: string;
  billing: string | null;
  provider: string | null;
  input: number;
  output: number;
  cache: number;
  /** API 로 샀다면 얼마였나(구독이면 실제 과금은 0). */
  apiUsd: number;
}

/** `llm.usage` 줄 → 요청. 최신이 앞. */
export function usageRequests(rows: readonly LogRow[]): UsageReq[] {
  const out: UsageReq[] = [];
  for (const row of rows) {
    if (!row.category.startsWith('llm.usage')) continue;
    const d = row.data ?? {};
    const t = Date.parse(row.ts);
    if (!Number.isFinite(t)) continue;
    const cost = (d.cost ?? {}) as Record<string, unknown>;
    out.push({
      ts: row.ts,
      t,
      model: str(d.model) ?? 'unknown',
      site: str(d.site) ?? 'unknown',
      billing: str(d.billing),
      provider: str(d.billingProvider),
      input: num(d.inputTokens),
      output: num(d.outputTokens),
      cache: num(d.cacheReadInputTokens),
      apiUsd: num(cost.apiEquivalentUsd),
    });
  }
  return out.sort((a, b) => b.t - a.t);
}

export interface Candle { t: number; count: number; tokens: number; byModel: Record<string, number> }

/** 봉(옛것 → 최신) — 칸마다 요청 수 ⊕ 토큰 ⊕ 모델별 요청 수. 빈 칸도 둔다(시간축이 끊기지 않게).
 *  `bucketMs` 기본 1분 — 창이 길면 호출자가 «창 ÷ 칸 수»로 넓힌다(6시간 창에 최근 40분만 그리면 막대가 한둘이다). */
export function usageCandles(reqs: readonly UsageReq[], now: number, buckets = 30, bucketMs = 60_000): Candle[] {
  const end = Math.floor(now / bucketMs) * bucketMs;
  const start = end - (buckets - 1) * bucketMs;
  const out: Candle[] = Array.from({ length: buckets }, (_, i) => ({ t: start + i * bucketMs, count: 0, tokens: 0, byModel: {} }));
  for (const r of reqs) {
    const i = Math.floor((r.t - start) / bucketMs);
    if (i < 0 || i >= buckets) continue;
    const c = out[i]!;
    c.count += 1;
    c.tokens += r.input + r.output;
    c.byModel[r.model] = (c.byModel[r.model] ?? 0) + 1;
  }
  return out;
}

/** 모델별 요청 띠 — 창의 뒤 절반이 앞 절반보다 많으면 ▲. */
export function modelTicker(reqs: readonly UsageReq[], now: number, windowMs: number): Array<{ model: string; count: number; tokens: number; delta: 1 | -1 | 0 }> {
  const mid = now - windowMs / 2;
  const by = new Map<string, { count: number; tokens: number; late: number; early: number }>();
  for (const r of reqs) {
    if (r.t < now - windowMs) continue;
    const m = by.get(r.model) ?? { count: 0, tokens: 0, late: 0, early: 0 };
    m.count += 1;
    m.tokens += r.input + r.output;
    if (r.t >= mid) m.late += 1; else m.early += 1;
    by.set(r.model, m);
  }
  return [...by.entries()]
    .map(([model, m]) => ({ model, count: m.count, tokens: m.tokens, delta: (m.late > m.early ? 1 : m.late < m.early ? -1 : 0) as 1 | -1 | 0 }))
    .sort((a, b) => b.count - a.count);
}

export interface Heatmap { models: string[]; sites: string[]; cells: Record<string, number>; max: number }

/** 모델 × 사이트 요청 수(칸 색 5단은 화면이 `max` 로 나눈다). */
export function modelSiteHeatmap(reqs: readonly UsageReq[], maxModels = 7, maxSites = 4): Heatmap {
  const mCount = new Map<string, number>();
  const sCount = new Map<string, number>();
  for (const r of reqs) {
    mCount.set(r.model, (mCount.get(r.model) ?? 0) + 1);
    sCount.set(r.site, (sCount.get(r.site) ?? 0) + 1);
  }
  const models = [...mCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxModels).map(([m]) => m);
  const sites = [...sCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxSites).map(([s]) => s);
  const cells: Record<string, number> = {};
  let max = 0;
  for (const r of reqs) {
    if (!models.includes(r.model) || !sites.includes(r.site)) continue;
    const k = `${r.model}|${r.site}`;
    cells[k] = (cells[k] ?? 0) + 1;
    max = Math.max(max, cells[k]!);
  }
  return { models, sites, cells, max };
}

/** 런마다 창 안에서 본 첫 신호 → 마지막 신호(ms). */
export function runSpans(rows: readonly LogRow[]): Array<{ runId: string; ms: number }> {
  const span = new Map<string, { lo: number; hi: number }>();
  for (const row of rows) {
    const runId = str(row.data?.runId);
    const t = Date.parse(row.ts);
    if (!runId || !Number.isFinite(t)) continue;
    const s = span.get(runId);
    if (!s) span.set(runId, { lo: t, hi: t });
    else { s.lo = Math.min(s.lo, t); s.hi = Math.max(s.hi, t); }
  }
  return [...span.entries()].map(([runId, s]) => ({ runId, ms: s.hi - s.lo }));
}

/** 등폭 히스토그램 — 값이 없으면 빈 막대들. */
export function histogram(values: readonly number[], bins = 40): { bins: number[]; lo: number; hi: number; max: number } {
  const out = new Array<number>(bins).fill(0);
  if (values.length === 0) return { bins: out, lo: 0, hi: 0, max: 0 };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const w = (hi - lo) / bins || 1;
  for (const v of values) out[Math.min(bins - 1, Math.floor((v - lo) / w))]! += 1;
  return { bins: out, lo, hi, max: Math.max(...out) };
}

/** 단계마다 «지금 그 단계에 있는» 런 수 ⊕ 가장 붐비는 단계(실행 사이클 줄의 «지금» 칸). */
export function stageLoad(board: LiveBoardData): { counts: Record<LiveStage, number>; busiest: LiveStage | null } {
  const counts = Object.fromEntries(LIVE_STAGES.map((s) => [s, 0])) as Record<LiveStage, number>;
  for (const run of board.snapshot.runs) if (run.current) counts[run.current] += 1;
  let busiest: LiveStage | null = null;
  for (const s of LIVE_STAGES) if (counts[s] > 0 && (!busiest || counts[s] > counts[busiest])) busiest = s;
  return { counts, busiest };
}

/** 게이트 통과·실패 — 게이트 단계 신호의 성격으로. */
export function gateTally(rows: readonly LogRow[]): { pass: number; fail: number } {
  let pass = 0;
  let fail = 0;
  for (const row of rows) {
    const s = classifySignal(row);
    if (s.stage !== 'gate') continue;
    if (s.tone === 'ok') pass += 1; else if (s.tone === 'bad') fail += 1;
  }
  return { pass, fail };
}

/** SELF-HEAL(🅢 09-28 ①·🅣 티저 정의) — «리뷰 must-fix 를 받고 고쳐 병합된 PR». 창 안 review-loop 신호로 센다. */
export function selfHealedPrs(rows: readonly LogRow[]): string[] {
  const reworked = new Set<string>();
  const merged = new Set<string>();
  for (const row of rows) {
    if (!row.category.startsWith('review-loop')) continue;
    const d = row.data ?? {};
    const pr = str(d.pr) ?? (num(d.prNumber) ? String(num(d.prNumber)) : null);
    if (!pr) continue;
    if (row.event === 'rework-start' || (row.event === 'judge-verdict' && num(d.asks) > 0)) reworked.add(pr);
    if (/merged/.test(row.event)) merged.add(pr);
  }
  return [...reworked].filter((pr) => merged.has(pr));
}

/** 런 → 우주(로그를 쓴 인스턴스) — 그래프 바깥 고리 «우주» 노드(플릿 줌의 씨앗). */
export function runUniverses(rows: readonly LogRow[]): Array<{ runId: string; instance: string }> {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const runId = str(row.data?.runId);
    if (runId && row.instance && !seen.has(runId)) seen.set(runId, row.instance);
  }
  return [...seen.entries()].map(([runId, instance]) => ({ runId, instance }));
}

/** 기획 트리(🅢 09-28 «골 → 조각 가지 · 조각이 Pod 로») — 런마다 조각 이름.
 *  원천: `self-dev.supervisor decompose-and-retry.applied`(pieceFeatures · 이름 있음) ⊕ `goal-author goal-steps-decomposed`(stepCount · 수만).
 *  이름이 있으면 이름, 수만 있으면 «단계 i/N». 같은 런의 마지막 분해를 쓴다. */
export function planPieces(rows: readonly LogRow[]): Array<{ runId: string; pieces: string[] }> {
  const by = new Map<string, { t: number; pieces: string[] }>();
  for (const row of rows) {
    const runId = str(row.data?.runId);
    if (!runId) continue;
    const t = Date.parse(row.ts);
    let pieces: string[] | null = null;
    if (row.event === 'decompose-and-retry.applied' && Array.isArray(row.data?.pieceFeatures)) {
      pieces = (row.data!.pieceFeatures as unknown[]).map((p) => (typeof p === 'string' ? p : '')).filter(Boolean);
    } else if (row.event === 'goal-steps-decomposed' && num(row.data?.stepCount) > 1) {
      const n = Math.min(12, num(row.data?.stepCount));
      pieces = Array.from({ length: n }, (_, i) => `단계 ${i + 1}/${n}`);
    }
    if (!pieces || pieces.length === 0) continue;
    const cur = by.get(runId);
    if (!cur || t >= cur.t) by.set(runId, { t, pieces: pieces.slice(0, 12) });
  }
  return [...by.entries()].map(([runId, v]) => ({ runId, pieces: v.pieces }));
}

/** Pod 발사 — `harness.substrate dispatch-pod`(podPool). ⛔ 이 줄엔 runId 가 없다 — 그래서 조각↔Pod 를 잇지 않고 하니스 → Pod 로만 쏜다. */
export function podDispatches(rows: readonly LogRow[]): Array<{ pool: string; ts: string }> {
  const out: Array<{ pool: string; ts: string }> = [];
  for (const row of rows) {
    if (row.category !== 'harness.substrate' || row.event !== 'dispatch-pod') continue;
    const pool = str(row.data?.podPool);
    if (pool) out.push({ pool, ts: row.ts });
  }
  return out;
}

/** 재시도 고리 — 같은 단계에 «다시» 들어간 횟수(리뷰 = 반영 라운드 · 게이트 = 실패 뒤 재시도). */
export function stageRetries(rows: readonly LogRow[]): Array<{ runId: string; stage: LiveStage; retries: number }> {
  const review = new Map<string, number>();
  const gate = new Map<string, number>();
  for (const row of rows) {
    const runId = str(row.data?.runId);
    if (!runId) continue;
    if (row.category.startsWith('review-loop') && row.event === 'rework-start') review.set(runId, Math.max(review.get(runId) ?? 0, num(row.data?.round) || (review.get(runId) ?? 0) + 1));
    const s = classifySignal(row);
    if (s.stage === 'gate' && s.tone === 'bad') gate.set(runId, (gate.get(runId) ?? 0) + 1);
  }
  return [
    ...[...review.entries()].map(([runId, retries]) => ({ runId, stage: 'review' as const, retries })),
    ...[...gate.entries()].map(([runId, retries]) => ({ runId, stage: 'gate' as const, retries })),
  ];
}

/** 그래프 밀도 재료 — 런마다 신호 종류(카테고리·사건) 한 노드 ⊕ 그 신호 수. 단계가 있으면 그 단계 곁에. */
export function runEventKinds(rows: readonly LogRow[]): Array<{ runId: string; key: string; label: string; stage: LiveStage | null; count: number; bad: boolean }> {
  const by = new Map<string, { runId: string; key: string; label: string; stage: LiveStage | null; count: number; bad: boolean }>();
  for (const row of rows) {
    const runId = str(row.data?.runId);
    if (!runId) continue;
    const { stage, tone } = classifySignal(row);
    const key = `${runId}|${row.category}.${row.event}`;
    const cur = by.get(key);
    if (cur) { cur.count += 1; cur.bad ||= tone === 'bad'; continue; }
    by.set(key, { runId, key, label: row.event, stage, count: 1, bad: tone === 'bad' });
  }
  return [...by.values()];
}
