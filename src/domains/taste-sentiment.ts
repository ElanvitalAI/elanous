// ── Layer2 Taste substrate · D3 피드백 감정 2층 (P5b · 2026-07-18) ──────────
//
// 진입점(submitIntent)에서 사용자 발화의 **감정/피드백 신호**를 잡아 taste 모델에 weak scalar
// reward 로 반영한다(RLUF식·계획서 §9). 2층:
//   - Layer1 = **행동 규칙**(정정·좌절·중단·만족) — 진입점 무료·최고 정밀(무LLM·순수 패턴).
//   - Layer2 = 소형 sentiment/breakdown 분류기 seam(옵션·기본 미주입 — 후속 정교화).
//
// reward∈[-1,1] 은 surface_events(category:'taste.sentiment')에 각인되어 recentSentimentReward
// 로 집계 → P6 능동 제안 gate 가 affinity 에 adjustAffinity 로 반영("좌절 직후엔 제안 자제").
// = "좌절/정정 = weak reward 로 taste 벡터 이동"의 소비-시점 실현(별도 mutation 경로 없이).
//
// 원칙: 무LLM(Layer1)이라 핫패스 안전·fire-soft·config 게이트(taste.captureEnabled 공유)·
//   armed=false·매매 무접촉. 관측=debug.log('taste.sentiment', ...).

import type { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config/reader.js';
import { openSurfaceEventsDb, surfaceEventsDbPath, recordEvent, queryEvents } from './surface-events.js';

export type SentimentKind = 'correction' | 'frustration' | 'abandonment' | 'satisfaction';

export interface BehavioralSignal { kind: SentimentKind; reward: number }

/** Layer1 행동 규칙 — 정밀 우선(과탐 회피). 각 규칙은 reward 부호를 갖는다. */
const RULES: Array<{ kind: SentimentKind; reward: number; re: RegExp }> = [
  // 만족(양) — 명시적 칭찬/확인.
  { kind: 'satisfaction', reward: 0.7, re: /(고마워|감사|완벽|훌륭|맞아\s*그거|바로\s*그거|딱\s*좋|perfect|thank you|thanks|great job|nice work|exactly)/i },
  // 정정(음) — "그게 아니라/틀렸/다시".
  { kind: 'correction', reward: -0.6, re: /(그게\s*아니|그거\s*말고|아니라\s|틀렸|다시\s*해|잘못\s*(했|이해)|not\s+(that|what|quite)|that'?s\s+wrong|incorrect|redo)/i },
  // 좌절/에스컬레이션(음) — 반복 실패 호소·강한 부호.
  { kind: 'frustration', reward: -0.8, re: /(답답|짜증|왜\s*안|자꾸\s|계속\s*(안|못)|아직도\s*안|여전히\s*안|still\s+(not|doesn'?t|won'?t)|why\s+(isn'?t|won'?t|can'?t)|ugh|seriously\?|\?{3,}|!{3,})/i },
  // 중단/포기(음·약) — "그만/됐어/취소".
  { kind: 'abandonment', reward: -0.5, re: /(그만\s*(해|하자|둬)|됐어|관두|집어치|forget\s+it|never\s*mind|nvm|stop\s+it|cancel\s+that)/i },
];

/** 발화에서 행동 신호 검출(순수·정밀 우선). 신호 없으면 []. */
export function detectBehavioralSignals(text: string): BehavioralSignal[] {
  const t = (text ?? '').trim();
  if (t.length < 2) return [];
  const out: BehavioralSignal[] = [];
  for (const r of RULES) if (r.re.test(t)) out.push({ kind: r.kind, reward: r.reward });
  return out;
}

/** 신호들 → net weak scalar reward∈[-1,1]. 부호 상충 시 합산 후 클램프(정정+만족 공존=상쇄). */
export function sentimentReward(signals: BehavioralSignal[]): number {
  if (!signals.length) return 0;
  const sum = signals.reduce((a, s) => a + s.reward, 0);
  return Math.max(-1, Math.min(1, sum));
}

/** affinity blended 에 reward 반영(P6 gate 소비 primitive) — 좌절 직후엔 하향, 만족 직후엔 상향.
 *  adjusted = blended + 0.3·reward (클램프 없음 — 상대 비교용). */
export function adjustAffinity(blended: number, reward: number): number {
  return blended + 0.3 * reward;
}

export interface CaptureSentimentInput {
  text: string;
  channel: string;
  now?: Date;
  db?: Database;
  /** Layer2 분류기 seam(옵션·미주입 시 Layer1 행동규칙만). */
  classify?: (text: string) => Promise<BehavioralSignal[]>;
}

/** ★ 진입점 훅. submitIntent 최상단이 `void captureSentiment(...)` 로 부른다(await 금지).
 *  신호 있을 때만 surface_events(category:'taste.sentiment')에 각인. config OFF/무신호면 no-op. */
export async function captureSentiment(input: CaptureSentimentInput): Promise<void> {
  try {
    if (!getUserConfig().taste?.captureEnabled) return; // opt-in(taste 게이트 공유).
    const text = (input.text ?? '').trim();
    if (text.length < 2) return;

    let signals = detectBehavioralSignals(text);
    if (input.classify) {
      try { signals = signals.concat(await input.classify(text)); } catch { /* Layer2 실패 무시 */ }
    }
    if (!signals.length) return; // 중립 발화는 각인 안 함(노이즈 방지).

    const reward = sentimentReward(signals);
    const primary = signals.reduce((a, b) => (Math.abs(b.reward) > Math.abs(a.reward) ? b : a)).kind;
    const database = input.db ?? openSurfaceEventsDb(surfaceEventsDbPath());
    recordEvent(database, {
      surface: input.channel || 'cli',
      direction: 'inbound',
      kind: 'taste',
      category: 'taste.sentiment',
      domain: 'elanous',
      text: text.slice(0, 240),
      summary: `[sentiment:${primary}] reward ${reward.toFixed(2)}`,
      importance: Math.round(3 + Math.abs(reward) * 4), // 3..7
      tags: `sentiment:${primary},reward:${reward.toFixed(2)}`,
      ...(input.now ? { ts: input.now.toISOString() } : {}),
    });
    debug.log('taste.sentiment', 'imprint', { channel: input.channel, primary, reward, signals: signals.length });
  } catch (err) {
    debug.log('taste.sentiment', 'error', { error: err instanceof Error ? err.message : String(err) }, { level: 'error' });
  }
}

export interface RecentSentimentDeps { db?: Database; windowHours?: number }

/** 최근 감정 각인을 집계해 net reward∈[-1,1] 반환(P6 gate 가 "좌절 직후 제안 자제"에 사용).
 *  tags 의 reward 를 평균 후 클램프. 무기록이면 0. */
export function recentSentimentReward(deps: RecentSentimentDeps = {}): number {
  const database = deps.db ?? openSurfaceEventsDb(surfaceEventsDbPath());
  const rows = queryEvents(database, { category: 'taste.sentiment', sinceHours: deps.windowHours ?? 24, limit: 200 });
  if (!rows.length) return 0;
  let sum = 0, n = 0;
  for (const r of rows) {
    const m = /(?:^|,)\s*reward:(-?\d+(?:\.\d+)?)/.exec(r.tags ?? '');
    if (m) { sum += parseFloat(m[1]!); n++; }
  }
  if (n === 0) return 0;
  return Math.max(-1, Math.min(1, sum / n));
}
