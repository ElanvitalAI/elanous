// ── 시장신호 6h 의미 dedup 분류기 (2026-07-07 · 대표 피드백) ─────────────
//
// 배경: 기존 dedup(토큰 Jaccard 0.55)은 한/영 교차·장단문 변형을 못 잡음 —
// 07-07 아침 다이제스트에 삼성 실적 3건(초긴급 영어 + 다이제스트 한국어 2)·
// AI버블 3건·한화오션 2건이 중복 발송 (대표 지적).
//
// 2단 분류기 (실측 기반 · run 2026-07-07):
//   ① 임베딩(nomic·knowledge.ts defaultEmbed 재사용) — reason(한국어 요약)끼리
//      cos ≥ 0.87이면 중복 확정. 실측: AI버블 0.937·한화오션 0.952 잡힘,
//      비중복 최대 0.705와 갭. ⚠️ 한/영 교차 text(0.578)·표현 다른 reason
//      (삼성 0.677)은 임계 아래 = 임베딩 단독 분리 불가.
//   ② LLM 배치 판정 1콜(grok-fast-non-reasoning → LM Studio 폴백 — x-breaking
//      판정 체인과 동일) — ①이 못 가른 경계(같은 발표의 언어/수치 변형 vs
//      같은 기업의 다른 사건)를 의미로 판정.
// 전 단계 fail-soft: LLM·임베딩 전멸 시 기존 Jaccard만 (현행 유지 — 억제는
// 확신 있을 때만·속보 유실 방지가 우선).

import { tierModel } from '../llm/model-defaults.js';
import { llmNetworkFetch } from '../session-runtime/llm-call-gateway.js';
import { logUnmeteredRow } from '../llm/ledgered-call.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultEmbed, type EmbedFn } from './knowledge.js';
import { isNearDuplicate } from './breaking-signals.js';

const OMNI_ENV = join(homedir(), '.claude/skills/omni-crawl/.env');
export const SEMANTIC_DUP_THRESHOLD = 0.87;

export interface DedupSignal {
  text: string;
  reason?: string | null;
}

export interface SemanticDedupResult<T> {
  /** 유지 항목 + 접힌 소스 수(클러스터 크기). */
  kept: Array<{ item: T; sources: number }>;
  /** 최근 발송분과 같은 사건으로 판정돼 억제된 수. */
  suppressed: number;
  /** 사용한 판정 경로 — 관측용. */
  method: 'llm' | 'embedding' | 'jaccard-only';
}

// ── 임베딩 유사도 ──

export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** dedup 비교 키 — 판정 reason(한국어·언어 통일)이 있으면 그것, 없으면 원문. */
export function dedupKey(s: DedupSignal): string {
  return (s.reason && s.reason.trim().length >= 8 ? s.reason : s.text).slice(0, 300);
}

// ── LLM 배치 클러스터 판정 (grok-fast → LM Studio 폴백) ──

function skillEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(OMNI_ENV, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch { /* fail-soft */ }
  return env;
}

function clusterPrompt(candidates: DedupSignal[], recent: DedupSignal[]): string {
  const c = candidates.map((s, i) => `${i + 1}. ${dedupKey(s)} || ${s.text.slice(0, 160)}`).join('\n');
  const r = recent.length
    ? `\n최근 6시간 내 이미 발송된 항목:\n${recent.map((s, i) => `R${i + 1}. ${dedupKey(s)} || ${s.text.slice(0, 160)}`).join('\n')}`
    : '';
  return `다음 시장신호 후보들에서 "같은 사건/뉴스"를 판정해 JSON만 출력(설명 금지).
판정 기준:
- 같은 사건 = 같은 주체의 같은 발표/이벤트. 언어가 달라도(한/영), 수치·표현이 달라도, 1보/종합이어도 같은 발표면 같은 사건.
- 같은 발표에서 나온 다른 수치 보도(예: 같은 실적 공시의 매출 기사와 영업이익 기사)도 같은 사건.
- 같은 기업이라도 다른 사건(예: 실적 발표 vs IR 개최 안내 vs 지분 변동 vs 유상증자 vs 실적에 대한 별도 논평/전망)은 다른 사건.
출력: {"suppress":[이미 발송된 R항목과 같은 사건인 후보 번호들],"clusters":[[서로 같은 사건인 후보 번호 2개 이상 묶음]...]}

후보:
${c}${r}`;
}

interface ClusterVerdict { suppress: number[]; clusters: number[][] }

function parseClusterVerdict(text: string, n: number): ClusterVerdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { suppress?: unknown; clusters?: unknown };
    const inRange = (x: unknown): x is number => typeof x === 'number' && x >= 1 && x <= n;
    const suppress = Array.isArray(j.suppress) ? j.suppress.filter(inRange) : [];
    const clusters = Array.isArray(j.clusters)
      ? j.clusters.filter((c): c is number[] => Array.isArray(c) && c.length >= 2 && c.every(inRange))
      : [];
    return { suppress, clusters };
  } catch { return null; }
}

/** grok-fast → LM Studio 폴백 1콜 — 판정 계열 공유(모니터 중요도 판정도 사용). */
export async function llmOnce(prompt: string): Promise<string | null> {
  const xaiKey = process.env.XAI_API_KEY || skillEnv().XAI_API_KEY || '';
  if (xaiKey) {
    const model = tierModel('budget', 'grok');
    let logged = false; // 요청당 정확히 1행 — 기록 후 catch 재기록 금지 (JUD-B mustFix)
    try {
      const res = await llmNetworkFetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${xaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(30_000),
      }, { provider: 'grok', model, role: 'aux', requestedBy: 'signal-dedup' });
      logUnmeteredRow(model, { providerName: 'grok', site: 'signal-dedup', ...(res.ok ? {} : { missingReason: 'provider-call-failed' as const }) });
      logged = true;
      if (res.ok) {
        const d = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const c = d?.choices?.[0]?.message?.content;
        if (c) return c;
      }
    } catch {
      if (!logged) logUnmeteredRow(model, { providerName: 'grok', site: 'signal-dedup', missingReason: 'provider-call-failed' });
    }
  }
  // LM Studio 폴백 (config llm.rotation local baseUrl)
  let localModel: string | null = null; // 원장용 — 실제 chat 호출에 쓴 모델(요청 전 확정)
  let localLogged = false; // 요청당 정확히 1행 — 기록 후 catch 재기록 금지 (JUD-B mustFix)
  try {
    let base = 'http://localhost:1234/v1';
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), '.elanous/config.json'), 'utf-8')) as { llm?: { rotation?: Array<{ provider?: string; baseUrl?: string }> } };
      const local = (cfg?.llm?.rotation ?? []).find(r => r?.provider === 'local');
      if (local?.baseUrl) base = String(local.baseUrl).replace(/\/$/, '');
    } catch { /* 기본값 */ }
    // llm-ledger-exempt: model-listing
    const models = (await (await fetch(`${base}/models`, { signal: AbortSignal.timeout(5_000) })).json()) as { data?: Array<{ id: string }> };
    const ids = (models?.data ?? []).map(m => m.id);
    if (!ids.length) return null;
    const model = ids.find(id => /gemma/i.test(id)) ?? ids[0];
    localModel = model;
    const res = await llmNetworkFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(120_000),
    }, { provider: 'local', model, role: 'aux', requestedBy: 'signal-dedup', selectionSource: 'fallback' });
    logUnmeteredRow(model, { providerName: 'local', site: 'signal-dedup', ...(res.ok ? {} : { missingReason: 'provider-call-failed' as const }) });
    localLogged = true;
    if (!res.ok) return null;
    const d = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return d?.choices?.[0]?.message?.content ?? null;
  } catch {
    if (localModel && !localLogged) logUnmeteredRow(localModel, { providerName: 'local', site: 'signal-dedup', missingReason: 'provider-call-failed' });
    return null;
  }
}

// ── 통합 진입점 ──

export interface SemanticDedupOpts<T> {
  embed?: EmbedFn;
  /** 테스트 seam — LLM 판정 주입. null 반환 = 판정 실패(폴백). */
  llm?: (prompt: string) => Promise<string | null>;
  threshold?: number;
  /** 항목 → 비교용 {text, reason} 추출 — 기본 identity (T가 DedupSignal일 때). */
  getSignal?: (item: T) => DedupSignal;
}

/** 후보들을 의미 기반으로 클러스터하고, 최근 발송분과 같은 사건은 억제.
 *  입력 items는 이미 Jaccard(dedupeByText)로 1차 접힌 상태를 권장 —
 *  여기서는 그 위에 의미층을 얹는다. */
export async function dedupeSignalsSemantic<T>(
  items: Array<{ item: T; sources: number }>,
  recent: DedupSignal[],
  opts: SemanticDedupOpts<T> = {},
): Promise<SemanticDedupResult<T>> {
  if (items.length === 0) return { kept: [], suppressed: 0, method: 'jaccard-only' };
  const llm = opts.llm ?? llmOnce;
  const threshold = opts.threshold ?? SEMANTIC_DUP_THRESHOLD;
  const sig = opts.getSignal ?? ((item: T) => item as unknown as DedupSignal);

  // ① LLM 배치 판정 (1콜)
  const verdictText = await llm(clusterPrompt(items.map(x => sig(x.item)), recent));
  const verdict = verdictText ? parseClusterVerdict(verdictText, items.length) : null;
  if (verdict) {
    const drop = new Set<number>(verdict.suppress.map(i => i - 1));
    // 클러스터 병합 — 첫(=점수순 정렬돼 온) 항목 유지, 나머지 접기
    const foldInto = new Map<number, number>();
    for (const cluster of verdict.clusters) {
      const sorted = [...cluster].sort((a, b) => a - b);
      const head = sorted[0]! - 1;
      for (const i of sorted.slice(1)) foldInto.set(i - 1, head);
    }
    const kept: Array<{ item: T; sources: number }> = [];
    const headIndex = new Map<number, number>(); // 원 idx → kept idx
    items.forEach((x, i) => {
      if (drop.has(i)) return;
      const head = foldInto.get(i);
      if (head !== undefined && !drop.has(head)) {
        const ki = headIndex.get(head);
        if (ki !== undefined) { kept[ki]!.sources += x.sources; return; }
      }
      headIndex.set(i, kept.length);
      kept.push({ ...x });
    });
    return { kept, suppressed: drop.size, method: 'llm' };
  }

  // ② 임베딩 폴백 — reason(한국어) cos ≥ threshold. 확실한 쌍만 (유실 방지).
  try {
    const embed = opts.embed ?? defaultEmbed;
    const vecs = await Promise.all(items.map(x => embed(dedupKey(sig(x.item))).then(e => e.vector)));
    const recentVecs = await Promise.all(recent.map(s => embed(dedupKey(s)).then(e => e.vector)));
    const kept: Array<{ item: T; sources: number; vec: Float32Array }> = [];
    let suppressed = 0;
    for (let i = 0; i < items.length; i++) {
      const v = vecs[i]!;
      if (recentVecs.some(rv => cosineSim(v, rv) >= threshold)
        || recent.some(r => isNearDuplicate(r.text, sig(items[i]!.item).text))) { suppressed++; continue; }
      const dup = kept.find(k => cosineSim(k.vec, v) >= threshold);
      if (dup) dup.sources += items[i]!.sources;
      else kept.push({ ...items[i]!, vec: v });
    }
    return { kept: kept.map(({ item, sources }) => ({ item, sources })), suppressed, method: 'embedding' };
  } catch { /* 임베딩도 전멸 */ }

  // ③ 최후 폴백 — 최근 발송분 Jaccard만 (기존 동작)
  let suppressed = 0;
  const kept = items.filter(({ item }) => {
    const dup = recent.some(r => isNearDuplicate(r.text, sig(item).text));
    if (dup) suppressed++;
    return !dup;
  });
  return { kept, suppressed, method: 'jaccard-only' };
}
