// ── 세션 검색 관련도 랭킹 — in-memory trigram FTS5 (PLAN §P5 · 2026-07-16) ──────────
//
// 현 세션 검색은 ripgrep 후보군 + JS substring(매칭은 되나 관련도 정렬 없음·CJK 는
// substring 으로만). Hermes 선례대로 **trigram FTS5** 로 승격하되, 영속 인덱스(sync·
// backfill·staleness 기계장치)의 위험/과함을 피해 **in-memory** 로 짓는다 — ripgrep 이
// 이미 좁힌 후보 세션 본문만 :memory: FTS 에 넣어 BM25 랭킹. 영속 상태 0·동기화 0.
//
// CJK: trigram 토크나이저는 3자 슬라이딩 윈도라 한국어에 필수(unicode61 은 CJK 단어경계
// 없어 깨짐). 단 trigram 은 **최소 3자** — 2자 이하 질의는 null 반환(호출자 substring 폴백).

import { Database } from 'bun:sqlite';

export interface RankedDoc { sessionId: string; content: string; }
export interface RankResult { sessionId: string; score: number }

/** FTS5 MATCH 안전화 — 질의를 리터럴 구(phrase)로 감싸 특수문자(*, ", : 등) 파싱 오류 차단. */
function toPhraseQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

function toTrigramOverlapQuery(query: string): string | null {
  const chars = [...query.normalize('NFKC').toLocaleLowerCase()];
  const trigrams = new Set<string>();
  for (let index = 0; index <= chars.length - 3; index += 1) trigrams.add(chars.slice(index, index + 3).join(''));
  return trigrams.size ? [...trigrams].map(toPhraseQuery).join(' OR ') : null;
}

/** trigram FTS5 최소 유효 길이(공백 제외 3자). 미만이면 폴백 신호로 null. */
export function isTrigramRankable(query: string): boolean {
  return query.replace(/\s+/g, '').length >= 3;
}

/**
 * in-memory trigram FTS5 로 세션 문서(합친 대화 본문)를 BM25 관련도 랭킹.
 * 반환 = 매칭 세션만 score 오름차순(SQLite bm25 는 낮을수록 관련도 높음).
 * query<3자 또는 FTS 오류 → null(호출자가 substring/최신순 폴백).
 */
export function rankByTrigramFts(query: string, docs: RankedDoc[], match: 'phrase' | 'trigram-overlap' = 'phrase'): RankResult[] | null {
  const q = query.trim();
  const rankable = match === 'trigram-overlap'
    ? [...q.normalize('NFKC')].length >= 3
    : isTrigramRankable(q);
  if (!rankable || docs.length === 0) return null;
  const matchQuery = match === 'trigram-overlap' ? toTrigramOverlapQuery(q) : toPhraseQuery(q);
  if (!matchQuery) return null;
  let db: Database | null = null;
  try {
    db = new Database(':memory:');
    db.run("CREATE VIRTUAL TABLE d USING fts5(sid UNINDEXED, content, tokenize='trigram')");
    const ins = db.prepare('INSERT INTO d(sid, content) VALUES (?, ?)');
    const tx = db.transaction((rows: RankedDoc[]) => {
      for (const r of rows) ins.run(r.sessionId, match === 'trigram-overlap' ? r.content.normalize('NFKC') : r.content);
    });
    tx(docs);
    const rows = db.query(
      'SELECT sid AS sessionId, bm25(d) AS score FROM d WHERE d MATCH ? ORDER BY score',
    ).all(matchQuery) as RankResult[];
    return rows;
  } catch {
    return null; // FTS 미지원/오류 → 폴백
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}
