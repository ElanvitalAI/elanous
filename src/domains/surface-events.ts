// ── 크로스서피스 에피소드 이벤트 로그 (2026-07-07 · P0) ─────────────────
//
// 문제(대표): 발송 전용 채널 알림(워치 zone 등)을 Q&A 봇이 회상 못하고 반문.
// PFC 표방 시스템이 자기 CORE 출력을 모른다.
// P0 = sendOutbound() 발송 사실을 검색 가능한 원장에 영속 기록. 이것만으로
// "내가 뭘 보냈는지"의 근본 데이터가 생긴다. 회상 도구(memory_recall)는 P2.
//
// 설계: breaking_signals.db 패턴 일반화 (전 표면 발송/수신 원장) · bun:sqlite +
// FTS5 (kgs sqlite-store 선례). 벡터/KG/통합크론은 미착수(스코프 락 · PLAN §0.5).
// 상세 = 내부 문서 `PLAN-cross-surface-memory-2026-07-07`.

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { memoryDbPath, migrateLegacyMemoryDb } from './memory-db-path.js';
import { provenanceRefs, provenanceTags, elanousSelfProvenance } from './provenance.js';
import { within } from '../time/db-window.js';

/** Cross-surface memory DB path — managed memory 네임스페이스(memory-db-path). scoped:
 *  ELANOUS_STATE_DIR 격리 인스턴스는 각자 ambient-recall store(운영 무오염). 종전 `~/.elanous/conatus/`
 *  legacy 는 open 시 `migrateLegacyMemoryDb` 가 자가치유 이전. (2026-07-19 일반화) */
export function surfaceEventsDbPath(): string {
  return memoryDbPath('surface_events.db');
}

/** 기록 입력 — 발송/수신 측이 아는 만큼만 채운다 (나머지 nullable). */
export interface SurfaceEventInput {
  surface: string;            // telegram|pwa|ipad|cli|watch-cron|digest|monitor|dart|outbound|...
  direction: 'outbound' | 'inbound';
  kind?: string;              // alert|digest|watch-zone|qna|report|...
  text: string;               // 실제 발송/수신 본문
  summary?: string | null;    // 회상용 한국어 1-2줄 (없으면 text 앞부분)
  importance?: number | null; // 0-10 (미지정 시 kind 룰)
  tags?: string | null;       // sector/asset 등 쉼표복수
  sessionId?: string | null;
  threadId?: string | null;
  refs?: string | null;       // 연결 alertId/signalId (JSON 문자열)
  /** 도메인무관 카테고리 (GEN · 스케줄러와 공유 taxonomy). 미지정 시 kind에서 추론. */
  category?: string | null;
  /** 도메인 (GEN · finance | <future>). 미지정 시 finance. */
  domain?: string | null;
  ts?: string;                // ISO (기본 now)
}

export interface SurfaceEventRow {
  id: string; ts: string;
  surface: string; direction: string; kind: string | null;
  session_id: string | null; thread_id: string | null;
  text: string; summary: string | null;
  importance: number | null; tags: string | null; refs: string | null;
  category: string | null; domain: string | null;
  recall_count: number; consolidated: number;
  /** M1 graded decay — 기억 계층(hot|warm|cold). 미지정=hot. */
  tier?: string | null;
}

/** 도메인 미지정 시 기본값 — 코어는 도메인 무관(멀티 도메인)이라 finance 를 가정하지
 *  않는다(대표 지시 2026-07-08: Conatus/finance 는 퍼스트 고객이지 코어 아님). 발송/기록
 *  주체가 domain 을 명시해야 하며(finance·elanous·ops …), 미지정만 이 중립 도메인으로. */
export const DEFAULT_MEMORY_DOMAIN = 'general';

/** kind별 기본 현저성 (P0 룰 — P2에서 LLM/RPE로 정교화). */
export function importanceByKind(kind?: string | null): number {
  switch ((kind ?? '').toLowerCase()) {
    case 'alert': case 'watch-zone': case 'zone': case 'breaking': return 7;
    case 'report': case 'digest': return 4;
    case 'qna': return 3;
    default: return 5;
  }
}

/** kind → 도메인무관 카테고리 (GEN · schedule-registry와 동일 taxonomy 공유:
 *  ingest|monitor|report|alert|digest|qna|maintenance). 비-Conatus 도메인 대비. */
export function categoryOfKind(kind?: string | null): string {
  switch ((kind ?? '').toLowerCase()) {
    case 'watch-zone': case 'zone': case 'breaking': case 'monitor': return 'monitor';
    case 'digest': return 'digest';
    case 'report': return 'report';
    case 'qna': return 'qna';
    case 'ingest': return 'ingest';
    case 'alert': default: return 'alert';
  }
}

export function openSurfaceEventsDb(path: string = surfaceEventsDbPath()): Database {
  if (path !== ':memory:') {
    migrateLegacyMemoryDb('surface_events.db'); // conatus/ → memory/ 자가치유(재시작 시점·라이브 안전)
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS events(
    id TEXT PRIMARY KEY, ts TEXT NOT NULL,
    surface TEXT NOT NULL, direction TEXT NOT NULL, kind TEXT,
    session_id TEXT, thread_id TEXT,
    text TEXT NOT NULL, summary TEXT,
    importance INT, tags TEXT, refs TEXT,
    category TEXT, domain TEXT,
    recall_count INT DEFAULT 0, consolidated INT DEFAULT 0
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_surface ON events(surface, direction)`);
  // GEN 마이그레이션 — 기존 DB에 category/domain 없으면 추가.
  const cols = (db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('category')) db.run(`ALTER TABLE events ADD COLUMN category TEXT`);
  if (!cols.includes('domain')) db.run(`ALTER TABLE events ADD COLUMN domain TEXT`);
  // M1 graded decay(2026-07-08) — 기억 계층 tier(hot|warm|cold). 미지정=hot(신선).
  if (!cols.includes('tier')) db.run(`ALTER TABLE events ADD COLUMN tier TEXT DEFAULT 'hot'`);
  // FTS5 — 독립 테이블(kgs 선례). 키워드 회상용. 벡터는 미착수(스코프 락).
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    id UNINDEXED, search_text, tokenize = 'porter'
  )`);
  return db;
}

/** 발송/수신 사실 1건 기록. id 반환. fail-soft는 호출측 책임(발송을 막지 않게). */
export function recordEvent(db: Database, evt: SurfaceEventInput): string {
  const id = randomUUID();
  const ts = evt.ts ?? new Date().toISOString();
  const summary = evt.summary ?? evt.text.slice(0, 200);
  const importance = evt.importance ?? importanceByKind(evt.kind);
  const category = evt.category ?? categoryOfKind(evt.kind);   // GEN
  const domain = evt.domain ?? DEFAULT_MEMORY_DOMAIN;           // GEN — 코어 중립(미지정=general)
  db.transaction(() => {
    db.run(
      `INSERT INTO events (id, ts, surface, direction, kind, session_id, thread_id, text, summary, importance, tags, refs, category, domain)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ts, evt.surface, evt.direction, evt.kind ?? null,
       evt.sessionId ?? null, evt.threadId ?? null,
       evt.text, summary, importance, evt.tags ?? null, evt.refs ?? null, category, domain],
    );
    db.run(`INSERT INTO events_fts (id, search_text) VALUES (?, ?)`,
      [id, `${summary}\n${evt.text}\n${evt.tags ?? ''}`]);
  })();
  return id;
}

/** ★ Block 3 — 인바운드 대화 턴 기록(사용자 질의+응답). 발송(outbound)만 기록되던
 *  원장에 표면 Q&A 를 direction='inbound'·kind='qna' 로 편입 → memory_recall 이
 *  과거 대화도 회상("전에 뭐라고 물어봤지"·"그때 답이 뭐였지"). 표면 무관 코어 헬퍼 —
 *  각 표면 wrapper 가 runTurn 후 호출. 회상 anchor=질의(summary)·응답은 text 에 절삭 포함.
 *  fail-soft(기록 실패가 대화를 막지 않음)·빈 질의 스킵. domain 미지정=general(대화는
 *  도메인 무관·옵션 라벨 정책). importance 는 qna 기본(저현저·prune 이 볼륨 관리). */
export function recordInboundTurn(
  opts: { surface: string; userText: string; responseText?: string; sessionId?: string; threadId?: string; now?: () => string; db?: Database; origin?: string },
): string | null {
  const q = (opts.userText ?? '').trim();
  if (!q) return null;
  // Test runners must never fall through to the user's production memory DB.
  const testRunner = process.env.NODE_ENV === 'test' || process.env.BUN_TEST !== undefined;
  const isolatedTestPath = process.env.ELANOUS_STATE_DIR?.trim() ? surfaceEventsDbPath() : ':memory:';
  const db = opts.db ?? openSurfaceEventsDb(testRunner ? isolatedTestPath : surfaceEventsDbPath());
  const ownDb = !opts.db;
  try {
    const a = (opts.responseText ?? '').trim();
    // provenance(2026-07-19) — elanous 자기 처리 턴에 origin:elanous-self + git/branch/cwd 태그.
    // 외부 도구 발화(injectUtterance origin:claude-code 등)와 같은 스키마 → 회상이 주체 구분.
    const prov = { ...elanousSelfProvenance(), ...(opts.origin ? { origin: opts.origin } : {}), ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) };
    return recordEvent(db, {
      surface: opts.surface,
      direction: 'inbound',
      kind: 'qna',
      text: a ? `Q: ${q}\nA: ${a.slice(0, 800)}` : `Q: ${q}`,
      summary: q.slice(0, 150),
      refs: provenanceRefs(prov),
      tags: provenanceTags(prov),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      ...(opts.now ? { ts: opts.now() } : {}),
    });
  } catch { return null; }
  finally { if (ownDb) db.close(); }
}

/** 발화 «원천» — 사람이 말한 것과 시험 fixture·외부 CLI agent 가 던진 것을 계측상 구분한다.
 *  ⛔ 원천 표기가 없는 0건을 «사람 표본 0» 으로 오인하면 안 되고, 반대로 시험 fixture 가
 *  사람과 같은 서피스(cli·telegram)에 기록됐다는 이유로 사람 표본으로 세어도 안 된다. */
export type SurfaceUtteranceOrigin = 'human' | 'test-fixture' | 'external-cli-agent' | 'elanous-self' | 'unknown';

const TEST_FIXTURE_ORIGIN = /^(?:test-fixture|test_fixture|fixture|test|test-runner|bun-test)$/i;
const HUMAN_ORIGIN = /^(?:human|user|tui|pwa|telegram|discord|cli)$/i;
const EXTERNAL_CLI_AGENT_ORIGIN = /^(?:claude-code|codex|gemini|agent|external|external-cli-agent|external:[\w-]+|ext:[\w-]+)$/i;
const HUMAN_PROSE_SURFACE = /^(?:cli|tui|pwa|telegram|discord|ipad|watch)$/i;

function refsOf(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/** 원천 분류기 — provenance(recordInboundTurn opts.origin → refs.origin/tags.origin:<origin>)
 *  표기를 먼저 읽고, 표기가 없을 때만 서피스로 추정한다. 시험 fixture 는 서피스 추정 «전에» 가른다. */
export function classifySurfaceUtteranceOrigin(
  row: Pick<SurfaceEventRow, 'direction' | 'surface' | 'kind' | 'refs' | 'tags'>,
): SurfaceUtteranceOrigin {
  if (row.direction !== 'inbound') return 'unknown';
  const refs = refsOf(row.refs);
  const explicit = typeof refs.origin === 'string' ? refs.origin : undefined;
  const utteranceOrigin = typeof refs.utteranceOrigin === 'string' ? refs.utteranceOrigin : undefined;
  const fixtureTagged = (row.tags ?? '').split(/\s+/).filter(Boolean)
    .some((tag) => TEST_FIXTURE_ORIGIN.test(tag.split(':').pop() ?? ''));
  if ((utteranceOrigin && TEST_FIXTURE_ORIGIN.test(utteranceOrigin)) || (explicit && TEST_FIXTURE_ORIGIN.test(explicit)) || fixtureTagged) {
    return 'test-fixture';
  }
  if (utteranceOrigin === 'human') return 'human';
  if (utteranceOrigin === 'agent') return 'external-cli-agent';
  if (explicit) {
    if (HUMAN_ORIGIN.test(explicit)) return 'human';
    if (EXTERNAL_CLI_AGENT_ORIGIN.test(explicit)) return 'external-cli-agent';
  }
  // recordInboundTurn marks its recorder as elanous-self; on chat Q&A the speaker is the human.
  if (row.kind === 'qna' && /^(?:telegram|discord)$/i.test(row.surface)) return 'human';
  if (explicit === 'elanous-self') return 'elanous-self';
  if (/^ext:/i.test(row.surface)) return 'external-cli-agent';
  if (HUMAN_PROSE_SURFACE.test(row.surface)) return 'human';
  return 'unknown';
}

export interface SurfaceUtteranceQuery {
  from: string;
  to: string;
  surface?: string;
  /** 원천 필터(선택) — 미지정이면 종전과 같이 창 안의 모든 발화를 읽는다(보존 계약). */
  origin?: SurfaceUtteranceOrigin | readonly SurfaceUtteranceOrigin[];
}

/** Read every event in a half-open UTC interval without touching recall state. */
export function querySurfaceUtterances(db: Database, opts: SurfaceUtteranceQuery): SurfaceEventRow[] {
  const where = ["julianday(e.ts) >= julianday(?)", "julianday(e.ts) < julianday(?)", "e.direction = 'inbound'", "e.kind IN ('utterance', 'qna')"];
  const params: string[] = [opts.from, opts.to];
  if (opts.surface) { where.push('e.surface = ?'); params.push(opts.surface); }
  const rows = db.prepare(
    `SELECT e.* FROM events e WHERE ${where.join(' AND ')} ORDER BY julianday(e.ts) ASC, e.id ASC`,
  ).all(...params) as SurfaceEventRow[];
  if (opts.origin === undefined) return rows;
  const wanted = new Set<SurfaceUtteranceOrigin>(typeof opts.origin === 'string' ? [opts.origin] : opts.origin);
  return rows.filter((row) => wanted.has(classifySurfaceUtteranceOrigin(row)));
}

/** 원천별 발화 수 — «사람 원천 0» 을 사람 표본으로 읽지 않게 하는 계측 입구(read-only·recall 무접촉). */
export interface SurfaceUtteranceOriginCounts {
  human: number;
  testFixture: number;
  externalCliAgent: number;
  elanousSelf: number;
  unknown: number;
  total: number;
}

export function countSurfaceUtterancesByOrigin(
  db: Database,
  opts: Omit<SurfaceUtteranceQuery, 'origin'>,
): SurfaceUtteranceOriginCounts {
  const counts: SurfaceUtteranceOriginCounts = { human: 0, testFixture: 0, externalCliAgent: 0, elanousSelf: 0, unknown: 0, total: 0 };
  for (const row of querySurfaceUtterances(db, opts)) {
    counts.total += 1;
    switch (classifySurfaceUtteranceOrigin(row)) {
      case 'human': counts.human += 1; break;
      case 'test-fixture': counts.testFixture += 1; break;
      case 'external-cli-agent': counts.externalCliAgent += 1; break;
      case 'elanous-self': counts.elanousSelf += 1; break;
      default: counts.unknown += 1;
    }
  }
  return counts;
}

export interface QueryEventsOpts {
  query?: string;             // FTS MATCH (없으면 최근순 전체)
  surface?: string;
  direction?: 'outbound' | 'inbound';
  kind?: string;
  category?: string;          // GEN
  domain?: string;            // GEN
  sinceHours?: number;
  limit?: number;             // 기본 20
}

/** 이벤트 조회 — 회상(P2 memory_recall)의 기반. query 있으면 FTS MATCH, 없으면 최근순.
 *  현재는 최근성 우선(ts DESC). 현저성/관련성 가중 스코어는 P2에서 얹는다. */
export function queryEvents(db: Database, opts: QueryEventsOpts = {}): SurfaceEventRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.surface) { where.push('e.surface = ?'); params.push(opts.surface); }
  if (opts.direction) { where.push('e.direction = ?'); params.push(opts.direction); }
  if (opts.kind) { where.push('e.kind = ?'); params.push(opts.kind); }
  if (opts.category) { where.push('e.category = ?'); params.push(opts.category); }
  if (opts.domain) { where.push('e.domain = ?'); params.push(opts.domain); }
  if (opts.sinceHours != null) { where.push(`${within('e.ts')}`); params.push(`-${opts.sinceHours} hours`); }
  const limit = opts.limit ?? 20;

  const q = (opts.query ?? '').trim();
  if (q) {
    // FTS 매치 → id 집합 → 본문. 최근순.
    const clause = where.length ? 'AND ' + where.join(' AND ') : '';
    return db.prepare(
      `SELECT e.* FROM events e
       JOIN events_fts f ON f.id = e.id
       WHERE events_fts MATCH ? ${clause}
       ORDER BY e.ts DESC LIMIT ?`,
    ).all(ftsQuery(q), ...params, limit) as SurfaceEventRow[];
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(
    `SELECT e.* FROM events e ${clause} ORDER BY e.ts DESC LIMIT ?`,
  ).all(...params, limit) as SurfaceEventRow[];
}

/** 사용자 자유 질의를 FTS5 안전 표현으로 — 토큰별 OR, 특수문자 제거.
 *  ⚠️ prefix(*): 한국어 복합어("삼성"→"삼성전자")·긴 ASCII 어간 회상엔 필수라 유지하되,
 *  **짧은 ASCII 토큰(<4·"ref"/"git")은 prefix 금지→exact**. 안 그러면 `"ref"*`가 reference·
 *  refactor·refresh 까지 걸려 오차용(false-recall). CJK 는 항상 prefix(형태소 경계). (2026-07-19) */
export function ftsQuery(raw: string): string {
  const tokens = raw.toLowerCase().replace(/["^*():]/g, ' ').split(/\s+/).filter(t => t.length > 1);
  if (tokens.length === 0) return (raw.replace(/["^*():]/g, ' ').trim() || raw);
  const hasCjk = (t: string) => /[㄰-㆏가-힣぀-ヿ一-鿿]/.test(t);
  return tokens.map(t => (hasCjk(t) || t.length >= 4) ? `"${t}"*` : `"${t}"`).join(' OR ');
}

// ── 회상 스코어링 (P2) — recency + importance + relevance ──────────────
// Generative Agents(Park 2023) 계열 표준 공식의 경량판. 벡터/LLM 없이 FTS bm25 +
// 지수감쇠 최근성 + kind 현저성. 크로스링구얼 한계는 summary(한국어)로 완화.

export interface RecallHit extends SurfaceEventRow { score: number }

export interface RecallOpts {
  query?: string;
  kind?: string;
  direction?: 'outbound' | 'inbound';
  surface?: string;
  category?: string;     // GEN
  domain?: string;       // GEN
  sinceHours?: number;   // 기본 168(7일)
  limit?: number;        // 기본 8
  nowMs?: number;        // 테스트 seam
  /** P4.2 미엘린 — 회상된 이벤트의 recall_count 를 증분(자주 되짚는 기억 강화).
   *  기본 true(실 회상은 강화). retro/관찰 등 read-only 는 false. */
  bump?: boolean;
  /** M1 — cold 로 흐려진 기억까지 회상 후보에 포함(기본 false=cold 제외·hot/warm 만).
   *  cold 는 M2 에서 S3 Glacier 로 이관 → on-demand 복원 대상. */
  includeCold?: boolean;
}

/** 회상 — 후보 풀(FTS bm25 또는 최근순 60) → recency+importance+relevance+myelin 재랭킹 top-N.
 *  recency 반감기 ~50h · importance=현저성/10 · relevance=bm25 정규화 · myelin=recall_count 강화.
 *  ★ P4.2: 반환된 top-N 의 recall_count 를 증분(bump≠false) → 자주 회상되는 기억이 우선·잔류. */
export function recallEvents(db: Database, opts: RecallOpts = {}): RecallHit[] {
  const sinceHours = opts.sinceHours ?? 168;
  const limit = opts.limit ?? 8;
  const nowMs = opts.nowMs ?? Date.now();
  const q = (opts.query ?? '').trim();

  // 시간창 필터는 nowMs seam 기준(SQL `datetime('now')` 아님) — recency 스코어와 동일 기준점.
  //   운영(nowMs=Date.now())은 종전과 동일 결과이고, 테스트/재현(nowMs 주입)에서도 창이 정합.
  const cutoffIso = new Date(nowMs - sinceHours * 3.6e6).toISOString();
  const where: string[] = [`e.ts >= ?`];
  const params: Array<string | number> = [cutoffIso];
  if (opts.surface) { where.push('e.surface = ?'); params.push(opts.surface); }
  if (opts.direction) { where.push('e.direction = ?'); params.push(opts.direction); }
  if (opts.kind) { where.push('e.kind = ?'); params.push(opts.kind); }
  if (opts.category) { where.push('e.category = ?'); params.push(opts.category); }
  if (opts.domain) { where.push('e.domain = ?'); params.push(opts.domain); }
  // M1 — cold(흐려진) 기억은 기본 회상 제외(hot/warm 만). includeCold 로 override.
  if (!opts.includeCold) where.push(`(e.tier IS NULL OR e.tier != 'cold')`);

  let pool: Array<SurfaceEventRow & { rank?: number }>;
  if (q) {
    pool = db.prepare(
      `SELECT e.*, bm25(events_fts) AS rank FROM events e
       JOIN events_fts f ON f.id = e.id
       WHERE events_fts MATCH ? AND ${where.join(' AND ')}
       ORDER BY rank LIMIT 60`,
    ).all(ftsQuery(q), ...params) as Array<SurfaceEventRow & { rank: number }>;
  } else {
    pool = db.prepare(
      `SELECT e.* FROM events e WHERE ${where.join(' AND ')} ORDER BY e.ts DESC LIMIT 60`,
    ).all(...params) as SurfaceEventRow[];
  }
  if (pool.length === 0) return [];

  // bm25 정규화 (낮을수록 관련) → [0,1], 클수록 관련.
  const ranks = pool.map(r => r.rank).filter((x): x is number => typeof x === 'number');
  const rMin = ranks.length ? Math.min(...ranks) : 0;
  const rMax = ranks.length ? Math.max(...ranks) : 0;
  const relOf = (rank?: number): number => {
    if (rank == null) return 0.5;                 // 질의 없음 = 중립
    if (rMax === rMin) return 1;                    // 단일 후보
    return (rMax - rank) / (rMax - rMin);
  };

  // query-적응 가중(2026-07-19 튜닝) — 질의가 있으면 **relevance 우선**(관련 회상: 오래됐어도
  //   관련 이벤트가 최근 무관보다 상위), 질의 없으면(ambient) **recency 우선**(최근 활동). 종전
  //   고정 0.45 recency 는 query 모드에서 relevance 를 눌러 관련 회상을 놓쳤다. cross-recall 핵심.
  const W = q
    ? { recency: 0.25, importance: 0.20, relevance: 0.40, myelin: 0.15 }
    : { recency: 0.50, importance: 0.25, relevance: 0.10, myelin: 0.15 };
  const hits = pool.map(r => {
    const ageH = Math.max(0, (nowMs - Date.parse(r.ts)) / 3.6e6);
    const recency = Math.exp(-ageH / 72);
    const importance = (r.importance ?? 5) / 10;
    const relevance = relOf(r.rank);
    // P4.2 미엘린 — recall_count 로그 포화(0→0·2→~0.4·5→~0.65·10→~0.8·∞→1).
    const myelin = Math.min(1, Math.log1p(r.recall_count ?? 0) / Math.log(11));
    const score = W.recency * recency + W.importance * importance + W.relevance * relevance + W.myelin * myelin;
    const { rank, ...row } = r as SurfaceEventRow & { rank?: number };
    return { ...(row as SurfaceEventRow), score };
  }).sort((a, b) => b.score - a.score).slice(0, limit);

  // ★ P4.2 미엘린 강화 — 반환된 기억의 recall_count 증분(bump≠false). 자주 회상될수록
  //   미래 회상 랭킹↑ + retention prune 에서 보호(잔류). read-only 회상은 bump:false.
  if (opts.bump !== false && hits.length) {
    const ids = hits.map(h => h.id);
    db.prepare(`UPDATE events SET recall_count = recall_count + 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    for (const h of hits) h.recall_count = (h.recall_count ?? 0) + 1;
  }
  return hits;
}

// ── M1 graded decay — 이진 삭제 → stability 곡선(미엘린 반영·삭제 대신 흐려짐) ──
//
// 사람 기억은 삭제되지 않고 "떠올리기 어려워질 뿐"이다. importance·recall_count(미엘린)로
// stability(보존 기간)를 산출하고, 나이가 그 배수를 넘으면 tier 를 hot→warm→cold 로
// 강등한다. cold 는 회상 후보에서 빠진다(흐려짐) — 삭제 아님(M2 에서 S3 Glacier 이관).
// 자주 회상된 기억(recall_count↑)은 stability↑ → 천천히 흐린다(활동의존 강화).

/** stability(일) — 기억이 hot 에 머무는 기간. importance + 미엘린(recall_count)로 늘어난다. */
export const MEMORY_STABILITY_BASE_DAYS = 7;
export const MEMORY_STABILITY_IMPORTANCE_DAYS = 30; // importance 10 → +30일
export const MEMORY_STABILITY_MYELIN_DAYS = 45;     // recall 포화 시 +45일

export function stabilityDays(importance: number | null | undefined, recallCount: number | null | undefined): number {
  const imp = (importance ?? 5) / 10;                                   // 0~1
  const myelin = Math.min(1, Math.log1p(recallCount ?? 0) / Math.log(11)); // 0~1(포화)
  return MEMORY_STABILITY_BASE_DAYS + MEMORY_STABILITY_IMPORTANCE_DAYS * imp + MEMORY_STABILITY_MYELIN_DAYS * myelin;
}

/** 나이 vs stability → 계층. ≤stability=hot · ≤2×=warm · 초과=cold(회상서 흐려짐). */
export function classifyTier(ageDays: number, stability: number): 'hot' | 'warm' | 'cold' {
  if (ageDays <= stability) return 'hot';
  if (ageDays <= 2 * stability) return 'warm';
  return 'cold';
}

export interface DecayResult { hot: number; warm: number; cold: number; changed: number }

/** ★ M1 — 전 이벤트 tier 를 stability 기반으로 재계산·갱신(배치). 삭제하지 않는다(강등만).
 *  knowledge-ingest 크론이 pruneStaleEvents 앞에서 호출. 계층 분포 반환. */
export function applyMemoryDecay(db: Database, opts: { nowMs?: number } = {}): DecayResult {
  const nowMs = opts.nowMs ?? Date.now();
  const rows = db.prepare(`SELECT id, ts, importance, recall_count, tier FROM events`).all() as Array<{ id: string; ts: string; importance: number | null; recall_count: number | null; tier: string | null }>;
  const out: DecayResult = { hot: 0, warm: 0, cold: 0, changed: 0 };
  const upd = db.prepare(`UPDATE events SET tier = ? WHERE id = ?`);
  const tx = db.transaction((items: typeof rows) => {
    for (const r of items) {
      const ageDays = Math.max(0, (nowMs - Date.parse(r.ts)) / 8.64e7);
      const tier = classifyTier(ageDays, stabilityDays(r.importance, r.recall_count));
      out[tier]++;
      if ((r.tier ?? 'hot') !== tier) { upd.run(tier, r.id); out.changed++; }
    }
  });
  tx(rows);
  return out;
}

export interface PruneOpts {
  /** 이 일수보다 오래된 것만 대상(기본 90일). */
  maxAgeDays?: number;
  /** 이 미만 중요도만 대상(기본 5). 중요 발송은 보존. */
  importanceFloor?: number;
  nowExpr?: string; // 테스트 seam(기본 'now')
}

/** ★ P4.3 retention/망각 — 오래되고(>90d) 덜 중요하며(imp<5) 한 번도 회상 안 된
 *  (recall_count=0·비미엘린) 이벤트를 정리. 미엘린(회상됨)·중요 기억은 보존. events +
 *  events_fts 양쪽 삭제(트리거 없음). 삭제 건수 반환. surface_events.db 무한증식 방지. */
export function pruneStaleEvents(db: Database, opts: PruneOpts = {}): number {
  const maxAgeDays = opts.maxAgeDays ?? 90;
  const impFloor = opts.importanceFloor ?? 5;
  const cutoff = `-${maxAgeDays} days`;
  const ids = (db.prepare(
    `SELECT id FROM events WHERE ts < datetime(?, ?) AND (importance IS NULL OR importance < ?) AND (recall_count IS NULL OR recall_count = 0)`,
  ).all(opts.nowExpr ?? 'now', cutoff, impFloor) as Array<{ id: string }>).map(r => r.id);
  if (!ids.length) return 0;
  const q = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM events_fts WHERE id IN (${q})`).run(...ids);
  db.prepare(`DELETE FROM events WHERE id IN (${q})`).run(...ids);
  return ids.length;
}

// ── ambient 주입 다이제스트 (Block 5) — 에이전트 컨텍스트에 최근 발송 요약 ──
// 텔레그램/데몬 에이전트는 memory.ts 선언기억을 안 받음(CLI만) → 자기 발송을
// 모른 채 반문 위험. memory_recall(도구·온디맨드) 위에, 최근 유의 발송을 매 턴
// compact 주입해 "내가 방금 뭘 보냈는지"를 ambient 인지시킨다(반문 예방).

/** 최근 유의 발송 요약(빈 문자열=발송 없음). systemPrompt 주입용·bounded. */
export function recentSentDigest(
  db: Database,
  opts: { sinceHours?: number; limit?: number; floor?: number; nowMs?: number } = {},
): string {
  const sinceHours = opts.sinceHours ?? 24;
  const limit = opts.limit ?? 6;
  const floor = opts.floor ?? 6;
  const rows = db.prepare(
    `SELECT ts, kind, summary, text FROM events
     WHERE direction='outbound' AND COALESCE(importance,0) >= ? AND ${within('ts')}
     ORDER BY ts DESC LIMIT ?`,
  ).all(floor, `-${sinceHours} hours`, limit) as Array<{ ts: string; kind: string | null; summary: string | null; text: string }>;
  if (rows.length === 0) return '';
  const hm = (iso: string): string => {
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); }
    catch { return '?'; }
  };
  const line = (r: { ts: string; kind: string | null; summary: string | null; text: string }): string => {
    const body = ((r.summary && r.summary.trim()) ? r.summary : r.text).replace(/\s+/g, ' ').trim().slice(0, 90);
    return `- [${hm(r.ts)} ${r.kind ?? ''}] ${body}`;
  };
  return `최근 내가 발송한 알림/신호 (최근 ${sinceHours}h · 이걸 알고 답하라·모른다고 반문 금지·더 필요하면 memory_recall):\n${rows.map(line).join('\n')}`;
}
