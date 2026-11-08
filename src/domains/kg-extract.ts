import { textOnly } from '../llm/stream-text.js';
// ── 온톨로지 LLM 인과 추출 (후속2 · R5/R9 정성 · 2026-07-08) ──────────────
//
// dig_reports/breaking 텍스트 → 엔티티 간 causes/affects 엣지 추출. deterministic
// 엔티티 링킹(linkEntities) 으로 후보 노드 좁히고, LLM 이 그 사이 인과 관계만 추출.
// 무비용 우선 원칙: 노드 링킹은 무료·관계 추출만 LLM(config 게이트·기본 off).
//
// 거버넌스: 상관(correlates)≠인과(causes) 구분. LLM causes 엣지는 낮은 기본 conf +
// source_ref 필수(출처 없는 엣지 금지). READ-ONLY 판단·append-only.

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { addEdge, type EdgeRelation } from './kg-store.js';
import { linkEntities } from './kg-recall.js';
import { getUserConfig } from '../user-config.js';
import { getProviderForConfig, anyProviderAvailable, type LLMMessage } from '../llm.js';
import { windowCompare } from '../time/db-window.js';

export interface Triple { from: string; relation: EdgeRelation; to: string; confidence: number }

/** 추출 관계는 인과/영향만(상관은 가격 데이터가·correlates). */
const EXTRACT_RELATIONS = new Set<EdgeRelation>(['causes', 'affects']);

export const EXTRACT_SYSTEM = [
  '너는 금융 인과관계 추출기다. 주어진 텍스트와 후보 엔티티 목록에서, 엔티티 사이의',
  '인과/영향 관계만 JSON 으로 추출한다. 관계 종류는 causes(A가 B를 야기) 또는',
  'affects(A가 B에 영향). 후보 목록에 없는 엔티티는 쓰지 마라. 추측 금지.',
  '텍스트에 근거가 명확한 것만. 출력은 순수 JSON 배열:',
  '[{"from":"<id>","relation":"causes|affects","to":"<id>","confidence":0.0-1.0}]',
  '근거 없으면 빈 배열 []. 설명 금지·JSON 만.',
].join(' ');

/** LLM 출력에서 triple 파싱(순수·fail-soft). 후보 id 집합으로 검증. */
export function parseTriples(raw: string, validIds: Set<string>): Triple[] {
  const start = raw.indexOf('['), end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try { arr = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: Triple[] = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const from = String(o.from ?? ''), to = String(o.to ?? ''), rel = String(o.relation ?? '');
    if (!validIds.has(from) || !validIds.has(to) || from === to) continue;
    if (!EXTRACT_RELATIONS.has(rel as EdgeRelation)) continue;
    const conf = Math.max(0, Math.min(1, Number(o.confidence ?? 0.4) || 0.4));
    out.push({ from, relation: rel as EdgeRelation, to, confidence: conf });
  }
  return out;
}

export type ChatFn = (messages: LLMMessage[]) => Promise<string>;

/** 기본 LLM 호출 — dig-engine 패턴(streamChat·textOnly·getProviderForConfig). */
export async function defaultChat(messages: LLMMessage[]): Promise<string> {
  if (!anyProviderAvailable()) return '';
  const provider = getProviderForConfig(getUserConfig());
  if (!provider.streamChat) return '';
  let out = '';
  try { for await (const d of textOnly(provider.streamChat(messages, { temperature: 0, maxTokens: 500 }))) out += d; } catch { return ''; }
  return out.trim();
}

/** 텍스트 → 후보 링킹 → LLM 인과 추출 → triples(순수·chat 주입). 후보<2 = 빈. */
export async function extractCausal(
  db: Database, text: string, chat: ChatFn = defaultChat,
): Promise<Triple[]> {
  const candidates = linkEntities(db, text);
  if (candidates.length < 2) return [];
  const valid = new Set(candidates);
  const list = candidates.map(id => `- ${id}`).join('\n');
  const messages: LLMMessage[] = [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: `텍스트:\n${text.slice(0, 4000)}\n\n후보 엔티티:\n${list}` },
  ];
  const raw = await chat(messages);
  return parseTriples(raw, valid);
}

export interface ExtractOpts {
  chat?: ChatFn;
  enabled?: boolean;          // config 게이트(기본 false)
  limit?: number;             // 처리할 소스 행 수(기본 20)
  sinceHours?: number;        // dig/breaking 최근성(기본 48)
  now?: string;
}

/** dig_reports/breaking 최근 텍스트 → 인과 엣지 적재(config 게이트). 반환 = 적재 triple 수.
 *  기본 off — enabled=true (또는 config kg.extract.enabled) 여야 실행. */
export async function extractAndStore(
  db: Database, sourceDbPath: string, opts: ExtractOpts = {},
): Promise<{ processed: number; edges: number }> {
  const enabled = opts.enabled ?? Boolean(getUserConfig().finance?.kg?.extract?.enabled);
  if (!enabled) return { processed: 0, edges: 0 };
  if (!existsSync(sourceDbPath)) return { processed: 0, edges: 0 };
  const chat = opts.chat ?? defaultChat;
  const now = opts.now ?? new Date().toISOString();
  const limit = opts.limit ?? 20;
  const sinceHours = opts.sinceHours ?? 48;
  const sdb = new Database(sourceDbPath, { readonly: true });
  let rows: Array<{ id: string; text: string; confidence?: string }> = [];
  try {
    // dig_reports(topic+verdict+확신도) 우선, 없으면 signals(text+reason).
    const hasDig = sdb.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='dig_reports'`).get();
    if (hasDig) {
      rows = (sdb.query(`SELECT queue_id AS id, topic || ' ' || COALESCE(verdict,'') AS text, confidence FROM dig_reports WHERE ${windowCompare('ts', '>')} ORDER BY ts DESC LIMIT ?`).all(`-${sinceHours} hours`, limit) as Array<{ id: string; text: string; confidence?: string }>);
    }
    if (!rows.length) {
      rows = (sdb.query(`SELECT id, text || ' ' || COALESCE(reason,'') AS text FROM signals WHERE ${windowCompare('ts', '>')} AND impact >= 6 ORDER BY ts DESC LIMIT ?`).all(`-${sinceHours} hours`, limit) as Array<{ id: string; text: string }>);
    }
  } catch { /* fail-soft */ } finally { sdb.close(); }

  let edges = 0;
  for (const r of rows) {
    const triples = await extractCausal(db, r.text, chat);
    // ★ C.6 · 분석 확신도 전파 — 고확신 dig 는 강한 인과 엣지, 저확신은 약하게.
    //   분석 루프 품질이 온톨로지 인과 강도로 흘러든다(0.6 cap × 확신도 계수).
    const digFactor = digConfidenceFactor(r.confidence);
    for (const t of triples) {
      addEdge(db, { src: t.from, dst: t.to, relation: t.relation, weight: t.relation === 'causes' ? undefined : 0, confidence: Math.min(0.6, t.confidence) * digFactor, validAt: now, regimeAt: undefined, sourceRef: `dig:${r.id}`, extractedBy: 'grok-fast' });
      edges++;
    }
  }
  return { processed: rows.length, edges };
}

/** dig_reports.confidence 라벨(high/med/low·goal-v2) → 인과 엣지 confidence 계수.
 *  분석이 확신할수록 인과 엣지가 강해진다. 미상/goal-v2 = 중립(0.75). */
export function digConfidenceFactor(label?: string | null): number {
  switch ((label ?? '').toLowerCase().trim()) {
    case 'high': return 1.0;
    case 'med': case 'medium': return 0.75;
    case 'low': return 0.5;
    default: return 0.75; // goal-v2·미상 = 중립
  }
}
