// ── Layer2 Taste substrate · D4 능동 미션 제안 gate (P6 · 2026-07-18) ──────
//
// 누적 taste(D2 관심사 벡터)에서 **교차세션 창발 테마**를 검출해, 보수적 임계를 넘고 최근
// 좌절(D3)이 없을 때 **미션 후보를 제안**한다. ★ gate 는 **표면화 여부만** 판정한다 —
// 미션 생성/승인은 **대표(HITL)**. gate 는 createMission/submitIntent 를 절대 부르지 않는다
// (feedback_signal_wiring_via_mission·계획서 §9#3 "생성/승인 대표만"). 대표의 승인/기각은
// 라벨로 축적되어 뒤에 학습 gatekeeper 로 승격(RLUF식·보수 임계→학습).
//
// 원칙: config `taste.proposeEnabled` 기본 OFF(라이브 무접촉)·armed=false·매매 무접촉·
//   미션 DB 무접촉(제안은 surface_events category:'taste.propose' 관측일 뿐). 자율 gate
//   결정은 제1원칙 관측 관문 debug.log('taste.propose', ...).

import type { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config/reader.js';
import { openSurfaceEventsDb, surfaceEventsDbPath, recordEvent, queryEvents } from './surface-events.js';
import { openKnowledgeDb, knowledgeDbPath, loadKindVectors } from './knowledge.js';
import { cosine } from './taste-model.js';
import { recentSentimentReward } from './taste-sentiment.js';

/** 창발 테마 = 유사 taste 항목의 군집. */
export interface TasteTheme {
  key: string;          // 슬러그(쿨다운 매칭·라벨 키)
  label: string;        // 대표 항목 원문(테마 이름)
  size: number;         // 군집 크기
  score: number;        // 0..1 정규화 강도
  evidence: string[];   // 근거 항목 텍스트(상한 5)
}

export interface TasteProposal {
  theme: string;        // key
  label: string;
  score: number;
  rationale: string;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** 그리디 군집화(cosine≥simThreshold). 입력 순서 보존·중심=최다연결 근사(첫 원소 대표). */
export function clusterVectors(
  items: Array<{ text: string; vector: Float32Array }>,
  simThreshold = 0.6,
): Array<{ label: string; members: string[] }> {
  const clusters: Array<{ centroidIdx: number; vec: Float32Array; members: string[] }> = [];
  for (const it of items) {
    let best = -1, bestSim = simThreshold;
    for (let c = 0; c < clusters.length; c++) {
      const sim = cosine(it.vector, clusters[c]!.vec);
      if (sim >= bestSim) { bestSim = sim; best = c; }
    }
    if (best >= 0) clusters[best]!.members.push(it.text);
    else clusters.push({ centroidIdx: clusters.length, vec: it.vector, members: [it.text] });
  }
  return clusters.map((c) => ({ label: c.members[0]!, members: c.members }));
}

export interface ProposeDeps {
  knowledgeDb?: Database;
  surfaceDb?: Database;
  now?: Date;
  threshold?: number;
  cooldownDays?: number;
  simThreshold?: number;
  /** 좌절 억제 창(시간·기본 24). */
  sentimentWindowHours?: number;
  maxProposals?: number;
}

/** 누적 taste(recurring_topic·intent_tag)에서 창발 테마 점수화(순수 데이터 → 테마). */
export function scoreThemes(deps: ProposeDeps = {}): TasteTheme[] {
  const kdb = deps.knowledgeDb ?? openKnowledgeDb(knowledgeDbPath());
  const docs = loadKindVectors(kdb, 'taste', 'elanous')
    .filter((d) => d.sector_tags === 'recurring_topic' || d.sector_tags === 'intent_tag');
  if (docs.length < 2) return [];
  // 공간 정합 — 최다 embed_model.
  const modelCount = new Map<string, number>();
  for (const d of docs) modelCount.set(d.embed_model, (modelCount.get(d.embed_model) ?? 0) + 1);
  const embedModel = [...modelCount.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const use = docs.filter((d) => d.embed_model === embedModel);

  const clusters = clusterVectors(use.map((d) => ({ text: d.text, vector: d.vector })), deps.simThreshold ?? 0.6);
  const maxSize = clusters.reduce((m, c) => Math.max(m, c.members.length), 1);
  return clusters
    .filter((c) => c.members.length >= 2) // 단발성 제외(창발=반복)
    .map((c) => ({
      key: slugify(c.label),
      label: c.label,
      size: c.members.length,
      score: c.members.length / maxSize, // 상대 강도(0..1)
      evidence: c.members.slice(0, 5),
    }))
    .sort((a, b) => b.score - a.score);
}

/** 쿨다운 — 최근 cooldownDays 내 제안/결정된 테마 key 집합. */
function recentlyProposed(sdb: Database, cooldownDays: number): Set<string> {
  const rows = queryEvents(sdb, { category: 'taste.propose', sinceHours: cooldownDays * 24, limit: 200 });
  const keys = new Set<string>();
  for (const r of rows) {
    const m = /(?:^|,)\s*theme:([^,]+)/.exec(r.tags ?? '');
    if (m) keys.add(m[1]!.trim());
  }
  return keys;
}

/** ★ 능동 제안 gate — 창발 테마 중 임계 초과 & 최근 좌절 없음 & 쿨다운 밖만 제안.
 *  **미션을 만들지 않는다** — 제안 객체만 반환(대표 HITL). config OFF/억제면 []. */
export function proposeMissions(deps: ProposeDeps = {}): TasteProposal[] {
  const cfg = getUserConfig().taste;
  if (!cfg?.proposeEnabled) return [];
  const threshold = deps.threshold ?? cfg.proposeThreshold ?? 0.55;
  const cooldownDays = deps.cooldownDays ?? cfg.proposeCooldownDays ?? 7;
  const sdb = deps.surfaceDb ?? openSurfaceEventsDb(surfaceEventsDbPath());

  // 좌절 억제(D3) — 최근 부정 감정이 강하면 제안 자제.
  const reward = recentSentimentReward({ db: sdb, windowHours: deps.sentimentWindowHours ?? 24 });
  if (reward <= -0.3) {
    debug.log('taste.propose', 'suppressed.frustration', { reward });
    return [];
  }

  const themes = scoreThemes(deps);
  const cooling = recentlyProposed(sdb, cooldownDays);
  const proposals: TasteProposal[] = [];
  for (const t of themes) {
    if (t.score <= threshold) continue;
    if (cooling.has(t.key)) continue;
    proposals.push({
      theme: t.key,
      label: t.label,
      score: t.score,
      rationale: `창발 테마 "${t.label}"(관련 ${t.size}건·강도 ${t.score.toFixed(2)}) — 반복 관심. 근거: ${t.evidence.slice(0, 3).join(' · ')}`,
    });
    if (proposals.length >= (deps.maxProposals ?? 2)) break;
  }
  debug.log('taste.propose', 'gate', { themes: themes.length, proposed: proposals.length, threshold, reward });
  return proposals;
}

/** 제안을 surface_events(category:'taste.propose')에 각인 — 관측 + 쿨다운 소스. 미션 아님. */
export function imprintProposal(p: TasteProposal, deps: { db?: Database; now?: Date } = {}): string {
  const database = deps.db ?? openSurfaceEventsDb(surfaceEventsDbPath());
  return recordEvent(database, {
    surface: 'cli', direction: 'outbound', kind: 'taste', category: 'taste.propose', domain: 'elanous',
    text: p.rationale,
    summary: `[제안] ${p.label} (강도 ${p.score.toFixed(2)})`,
    importance: 6,
    tags: `theme:${p.theme},score:${p.score.toFixed(2)},decision:pending`,
    ...(deps.now ? { ts: deps.now.toISOString() } : {}),
  });
}

/** 대표의 제안 결정(approve|reject) 라벨 각인 — 학습 gatekeeper 승격용 축적(RLUF positive/negative). */
export function recordProposalDecision(
  theme: string, decision: 'approve' | 'reject',
  deps: { db?: Database; now?: Date } = {},
): string {
  const database = deps.db ?? openSurfaceEventsDb(surfaceEventsDbPath());
  debug.log('taste.propose', `decision.${decision}`, { theme });
  return recordEvent(database, {
    surface: 'cli', direction: 'inbound', kind: 'taste', category: 'taste.propose', domain: 'elanous',
    text: `제안 결정: ${theme} → ${decision}`,
    summary: `[결정] ${theme}: ${decision}`,
    importance: decision === 'approve' ? 7 : 4,
    tags: `theme:${slugify(theme)},decision:${decision}`,
    ...(deps.now ? { ts: deps.now.toISOString() } : {}),
  });
}

/** 오케스트레이터 — 제안 생성 + 각인(관측). 표면화(대표 알림)는 호출측 책임(HITL·기본 미배선).
 *  반환=각인된 제안. config OFF 면 []. 미션 생성 없음. */
export function runProposalGate(deps: ProposeDeps = {}): TasteProposal[] {
  const proposals = proposeMissions(deps);
  const sdb = deps.surfaceDb ?? openSurfaceEventsDb(surfaceEventsDbPath());
  for (const p of proposals) {
    try { imprintProposal(p, { db: sdb, now: deps.now }); } catch { /* fail-soft */ }
  }
  return proposals;
}

export interface PendingProposal { theme: string; label: string; score: number; rationale: string }

/** 미결(pending) 제안 목록 — taste.propose 각인 중 테마별 최신 결정이 pending 인 것.
 *  대표 HITL 목록/알림용. approve/reject 된 테마는 제외. */
export function pendingProposals(deps: { db?: Database; sinceHours?: number } = {}): PendingProposal[] {
  const database = deps.db ?? openSurfaceEventsDb(surfaceEventsDbPath());
  const rows = queryEvents(database, { category: 'taste.propose', sinceHours: deps.sinceHours ?? 24 * 30, limit: 500 });
  // 테마별 최신 이벤트(ts 최대) 채택.
  const latest = new Map<string, { ts: number; decision: string; label: string; score: number; rationale: string }>();
  for (const r of rows) {
    const tags = r.tags ?? '';
    const theme = /(?:^|,)\s*theme:([^,]+)/.exec(tags)?.[1]?.trim();
    if (!theme) continue;
    const decision = /(?:^|,)\s*decision:([a-z]+)/.exec(tags)?.[1] ?? 'pending';
    const score = parseFloat(/(?:^|,)\s*score:(-?\d+(?:\.\d+)?)/.exec(tags)?.[1] ?? '0');
    const ts = Date.parse(r.ts) || 0;
    const prev = latest.get(theme);
    // 최신 우선 · 동일 ts 면 결정(non-pending)이 pending 을 이긴다(경합 안전).
    const wins = !prev || ts > prev.ts || (ts === prev.ts && decision !== 'pending' && prev.decision === 'pending');
    if (wins) {
      const label = (r.summary ?? theme).replace(/^\[제안\]\s*/, '').replace(/\s*\(강도.*$/, '') || theme;
      latest.set(theme, { ts, decision, label, score, rationale: r.text });
    }
  }
  return [...latest.entries()]
    .filter(([, v]) => v.decision === 'pending')
    .map(([theme, v]) => ({ theme, label: v.label, score: v.score, rationale: v.rationale }))
    .sort((a, b) => b.score - a.score);
}
