// ── Layer2 Taste substrate · D1 중앙 진입점 수집 (P4 · 2026-07-18) ──────────
//
// intent-gate `submitIntent` 최상단이 **모든 프롬프트**(마커/passthrough 무관)를 비동기
// fire-soft 로 이 모듈에 넘긴다. 원프롬프트를 로그로 쌓지 않고(ChatGPT `MODEL SET CONTEXT`
// 구조·embracethered 리버스엔지니어링) typed·confidence-scored 항목 5종으로 distill 해
// surface_events 에 각인한다:
//   facts · style_preferences · recurring_topics · insights · intent_tags
//
// 저장 = surface_events(kind:'taste'·category:'taste.capture') — 정렬 예약 네임스페이스
//   ([[ALIGNMENT-retrospection-x-mission-ecosystem-surface-events-2026-07-18]]). 관측(에피소드)
//   레이어이며, taste 모델(centroid·dual 벡터)은 P5 에서 knowledge.db 로 미러(해마→신피질).
//
// 원칙:
//  - hot-path 무증가: submitIntent 는 await 안 함(fire-and-forget·throw 삼킴).
//  - opt-in: config `taste.captureEnabled`(기본 OFF). 미설정이면 완전 무동작.
//  - 격리: NODE_ENV=test 는 실 LLM 미호출(distill seam 미주입 시 no-op).
//  - armed=false·매매 무접촉: 관측/가중용 각인일 뿐 mandate 아님.
//  - 제1원칙 관측: `debug.log('taste.capture', ...)` 로 logs.db 도달.

import type { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config/reader.js';
import { budgetModel } from '../llm/model-defaults.js';
import {
  openSurfaceEventsDb,
  surfaceEventsDbPath,
  recordEvent,
  type SurfaceEventInput,
} from './surface-events.js';

/** distill 대상 5종(ChatGPT bio 구조). intent_tag=현재 의도 라벨, 나머지는 유지 취향. */
export const TASTE_ITEM_TYPES = [
  'fact',
  'style_pref',
  'recurring_topic',
  'insight',
  'intent_tag',
] as const;
export type TasteItemType = (typeof TASTE_ITEM_TYPES)[number];

export interface TasteItem {
  type: TasteItemType;
  /** distilled 한 줄(원문 verbatim 아님·요약/분류). */
  text: string;
  /** 0..1 신뢰도(현저성). importance(0-10) 로 스케일. */
  confidence: number;
}

/** distill LLM seam(테스트/재사용). prompt→raw 문자열(JSON 배열 기대). */
export type DistillCallable = (prompt: string) => Promise<string>;

export interface CaptureTasteInput {
  text: string;
  channel: string;
  now?: Date;
  /** surface_events store seam(테스트). 없으면 내부 open. */
  db?: Database;
  /** distill seam(테스트 격리·LLM 우회). 없고 non-test 면 luna 디폴트. */
  distill?: DistillCallable;
}

function isTasteType(v: unknown): v is TasteItemType {
  return typeof v === 'string' && (TASTE_ITEM_TYPES as readonly string[]).includes(v);
}

/** LLM raw(JSON 배열 문자열)를 TasteItem[] 으로 파싱(순수·fail-soft). 코드펜스·잡텍스트 관대.
 *  각 원소 {type,text,confidence} 검증 — 미상 type·빈 text·범위밖 confidence 는 드롭/클램프. */
export function parseTasteItems(raw: string): TasteItem[] {
  if (!raw) return [];
  // ```json … ``` 펜스나 앞뒤 산문 제거 — 첫 '[' ~ 마지막 ']' 만.
  const lo = raw.indexOf('[');
  const hi = raw.lastIndexOf(']');
  if (lo < 0 || hi <= lo) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(lo, hi + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: TasteItem[] = [];
  for (const el of arr) {
    if (!el || typeof el !== 'object') continue;
    const r = el as Record<string, unknown>;
    if (!isTasteType(r.type)) continue;
    const text = typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
    if (!text) continue;
    let confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : 0.5;
    confidence = Math.max(0, Math.min(1, confidence));
    out.push({ type: r.type, text, confidence });
  }
  return out.slice(0, 12); // 프롬프트당 상한(폭주 방어).
}

const DISTILL_SYSTEM = `You extract durable user "taste" signals from a single user message for a personal-assistant memory (ChatGPT bio style). Do NOT store the raw message. Output ONLY a JSON array; each element {"type","text","confidence"}.
type ∈ fact | style_pref | recurring_topic | insight | intent_tag.
- fact: stable fact about the user (role, tools, environment).
- style_pref: how they like responses (tone, length, language, format). Include negatives ("dislikes X").
- recurring_topic: a subject they keep returning to.
- insight: an inferred higher-order preference/goal.
- intent_tag: short label(s) of the CURRENT request intent.
text = concise distilled phrase (NOT verbatim), <= 200 chars, in the user's language. confidence ∈ 0..1.
Return [] if nothing durable. No prose, no code fences.`;

function buildDistillPrompt(text: string): string {
  const clipped = text.replace(/\s+/g, ' ').trim().slice(0, 2000);
  return `${DISTILL_SYSTEM}\n\nUSER MESSAGE:\n"""${clipped}"""`;
}

/** 경량 distill 디폴트(luna·low-effort). NODE_ENV=test 는 호출측이 미주입(seam). */
async function defaultDistill(prompt: string, model: string): Promise<string> {
  const { streamLLM } = await import('../llm.js');
  return streamLLM([{ role: 'user', content: prompt }], () => {}, {
    model,
    reasoningEffort: 'low',
  });
}

/** confidence(0..1) → importance(0-10). 최저 3(감쇠 저항 floor)·high 신뢰는 상향. */
function importanceOf(confidence: number): number {
  return Math.round(3 + confidence * 5); // 3..8
}

/** TasteItem[] 을 surface_events 에 각인(각 1행·kind:'taste'·category:'taste.capture').
 *  db seam 재사용. 반환=각인된 이벤트 id[]. */
export function imprintTasteItems(
  items: TasteItem[],
  opts: { channel: string; db?: Database; now?: Date },
): string[] {
  if (!items.length) return [];
  const database = opts.db ?? openSurfaceEventsDb(surfaceEventsDbPath());
  const ts = opts.now?.toISOString();
  const ids: string[] = [];
  for (const it of items) {
    const evt: SurfaceEventInput = {
      surface: opts.channel || 'cli',
      direction: 'inbound',
      kind: 'taste',
      category: `taste.capture`,
      domain: 'elanous',
      text: it.text,
      summary: `[${it.type}] ${it.text.slice(0, 120)}`,
      importance: importanceOf(it.confidence),
      tags: `taste:${it.type},conf:${it.confidence.toFixed(2)}`,
      ...(ts ? { ts } : {}),
    };
    ids.push(recordEvent(database, evt));
  }
  return ids;
}

/** ★ 중앙 진입점 훅. submitIntent 최상단이 `void captureTaste(...)` 로 부른다(await 금지).
 *  config OFF 면 즉시 no-op. distill 실패/빈 결과는 조용히 종료(hot-path·라이브 무차단). */
export async function captureTaste(input: CaptureTasteInput): Promise<void> {
  try {
    const cfg = getUserConfig().taste;
    if (!cfg?.captureEnabled) return; // opt-in — 미설정이면 완전 무동작.

    const text = (input.text ?? '').trim();
    if (text.length < 8) return; // 잡음(짧은 확인·이모지)은 스킵.

    // distill seam — 미주입 & test 면 no-op(실 LLM 방지). 운영은 luna 디폴트.
    const model = cfg.model || process.env.ELANOUS_TASTE_MODEL || budgetModel();
    const distill = input.distill
      ?? (process.env.NODE_ENV === 'test' ? undefined : (p: string) => defaultDistill(p, model));
    if (!distill) return;

    const raw = await distill(buildDistillPrompt(text));
    const items = parseTasteItems(raw);
    if (!items.length) {
      debug.log('taste.capture', 'distill.empty', { channel: input.channel, len: text.length });
      return;
    }
    const ids = imprintTasteItems(items, { channel: input.channel, db: input.db, now: input.now });
    debug.log('taste.capture', 'imprint', {
      channel: input.channel,
      items: items.length,
      types: items.map((i) => i.type).join(','),
      imprinted: ids.length,
    });
  } catch (err) {
    // fail-soft — taste 수집 실패가 프롬프트 처리를 절대 막지 않는다.
    debug.log('taste.capture', 'error', { error: err instanceof Error ? err.message : String(err) }, { level: 'error' });
  }
}
