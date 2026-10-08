import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  openSurfaceEventsDb, recordEvent, recordInboundTurn, queryEvents, importanceByKind, ftsQuery, recallEvents, recentSentDigest, categoryOfKind, pruneStaleEvents,
  stabilityDays, classifyTier, applyMemoryDecay,
} from './surface-events.js';

const db = () => openSurfaceEventsDb(':memory:');

describe('importanceByKind — kind 룰', () => {
  test('alert/watch-zone = 7', () => {
    expect(importanceByKind('alert')).toBe(7);
    expect(importanceByKind('watch-zone')).toBe(7);
  });
  test('digest/report = 4, qna = 3, 기본 = 5', () => {
    expect(importanceByKind('digest')).toBe(4);
    expect(importanceByKind('qna')).toBe(3);
    expect(importanceByKind(undefined)).toBe(5);
    expect(importanceByKind('별종')).toBe(5);
  });
});

describe('recordEvent + queryEvents', () => {
  test('기록 후 최근순 조회', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '첫 알림', ts: '2026-07-07T01:00:00Z' });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '둘째 알림', ts: '2026-07-07T02:00:00Z' });
    const rows = queryEvents(d, {});
    expect(rows.length).toBe(2);
    expect(rows[0]!.text).toBe('둘째 알림'); // 최근순
  });

  test('importance 미지정 시 kind 룰 적용 · summary 자동', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'digest', text: 'x'.repeat(500) });
    const r = queryEvents(d, {})[0]!;
    expect(r.importance).toBe(4);
    expect(r.summary!.length).toBe(200); // text 앞 200
    expect(r.recall_count).toBe(0);
    expect(r.consolidated).toBe(0);
  });

  test('명시 importance/summary/tags 보존', () => {
    const d = db();
    recordEvent(d, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone', text: 't', importance: 9, summary: '요약', tags: 'semis' });
    const r = queryEvents(d, {})[0]!;
    expect(r.importance).toBe(9);
    expect(r.summary).toBe('요약');
    expect(r.tags).toBe('semis');
  });
});

describe('필터', () => {
  const seed = () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: 'a' });
    recordEvent(d, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: 'b' });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'digest', text: 'c' });
    return d;
  };
  test('surface/direction/kind 필터', () => {
    const d = seed();
    expect(queryEvents(d, { surface: 'telegram' }).length).toBe(1);
    expect(queryEvents(d, { direction: 'outbound' }).length).toBe(2);
    expect(queryEvents(d, { kind: 'digest' }).length).toBe(1);
  });
  test('limit', () => {
    const d = seed();
    expect(queryEvents(d, { limit: 1 }).length).toBe(1);
  });
});

describe('FTS5 회상 — 대표 반문 시나리오', () => {
  test('한국어 수급 알림을 키워드로 회상', () => {
    const d = db();
    recordEvent(d, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone',
      text: '삼성전자 외국인 순매수 전환 감지 — 10분 델타 +120억' });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert',
      text: 'KORU 재진입 밴드 진입' });
    const hit = queryEvents(d, { query: '외국인 순매수' });
    expect(hit.length).toBe(1);
    expect(hit[0]!.text).toContain('삼성전자');
  });

  test('매치 없으면 빈 결과', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '삼성 알림' });
    expect(queryEvents(d, { query: '유가 원유' }).length).toBe(0);
  });

  test('특수문자 질의도 구문오류 없이 처리', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '테스트 알림' });
    expect(() => queryEvents(d, { query: '"삼성" (수급) * ^' })).not.toThrow();
  });
});

describe('ftsQuery 정규화', () => {
  test('토큰 prefix(*) OR · 특수문자 제거', () => {
    expect(ftsQuery('삼성 수급')).toBe('"삼성"* OR "수급"*');
    expect(ftsQuery('a*b^c')).not.toContain('^'); // 위험 특수문자 제거(prefix * 는 허용)
  });
  test('짧은 ASCII 토큰은 exact(prefix 금지) — "ref" 오차용 차단(2026-07-19)', () => {
    // "ref"(<4) → exact "ref" (reference/refactor 로 안 샘). CJK·긴 ASCII 는 prefix 유지.
    expect(ftsQuery('git ref')).toBe('"git" OR "ref"');
    expect(ftsQuery('reference 문서')).toBe('"reference"* OR "문서"*'); // 긴 ASCII prefix
    expect(ftsQuery('삼성 ref')).toBe('"삼성"* OR "ref"'); // 한글 prefix + 짧은 ASCII exact 혼합
  });
  test('prefix 매칭 — "삼성"이 복합어 "삼성전자"를 회상', () => {
    const d = db();
    recordEvent(d, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone', text: '삼성전자 외국인 순매수 전환 감지' });
    expect(queryEvents(d, { query: '삼성 수급 어때' }).length).toBe(1); // 삼성*→삼성전자
  });
});

describe('recallEvents — 스코어 회상 (P2)', () => {
  const NOW = Date.parse('2026-07-07T12:00:00Z');
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3.6e6).toISOString();

  test('query 회상 — 관련 알림만, 스코어 부여', () => {
    const d = db();
    recordEvent(d, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone', text: '삼성전자 외국인 순매수 전환 감지', ts: at(2) });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: 'KORU 재진입 밴드', ts: at(1) });
    const hits = recallEvents(d, { query: '삼성 외국인 수급', nowMs: NOW });
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toContain('삼성');
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  test('최근성 — 같은 kind면 최신이 상위', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '오래된 알림', ts: at(100) });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '최근 알림', ts: at(1) });
    const hits = recallEvents(d, { nowMs: NOW });
    expect(hits[0]!.text).toBe('최근 알림');
  });

  test('현저성 — 같은 시각이면 importance 높은 것 상위', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'digest', text: '다이제스트', ts: at(3), importance: 4 });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '긴급 알림', ts: at(3), importance: 9 });
    const hits = recallEvents(d, { nowMs: NOW });
    expect(hits[0]!.text).toBe('긴급 알림');
  });

  test('sinceHours 기간 밖은 제외', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '기간밖', ts: at(200) });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '기간안', ts: at(2) });
    const hits = recallEvents(d, { sinceHours: 24, nowMs: NOW });
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toBe('기간안');
  });

  test('발송 없으면 빈 배열', () => {
    expect(recallEvents(db(), { query: '아무거나', nowMs: NOW })).toEqual([]);
  });

  test('P4.2 미엘린 — 회상 시 recall_count 증분(bump 기본)', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '삼성 알림', ts: at(2) });
    recallEvents(d, { query: '삼성', nowMs: NOW });                 // bump 기본
    const row = queryEvents(d, { query: '삼성' })[0];
    expect(row!.recall_count).toBe(1);
    recallEvents(d, { query: '삼성', nowMs: NOW });                 // 또 회상 → 2
    expect(queryEvents(d, { query: '삼성' })[0]!.recall_count).toBe(2);
  });

  test('P4.2 bump:false → recall_count 불변(read-only 회상)', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '삼성 알림', ts: at(2) });
    recallEvents(d, { query: '삼성', nowMs: NOW, bump: false });
    expect(queryEvents(d, { query: '삼성' })[0]!.recall_count).toBe(0);
  });

  test('P4.2 미엘린 가중 — 같은 조건이면 자주 회상된 것 상위', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '자주 회상 알림', ts: at(3), importance: 5 });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '안 회상 알림', ts: at(3), importance: 5 });
    // '자주 회상 알림'만 여러 번 회상 → recall_count↑
    for (let i = 0; i < 5; i++) recallEvents(d, { query: '자주', nowMs: NOW });
    const hits = recallEvents(d, { nowMs: NOW, bump: false });
    expect(hits[0]!.text).toBe('자주 회상 알림');   // 미엘린 강화로 상위
  });
});

describe('pruneStaleEvents — P4.3 retention/망각', () => {
  const NOW = Date.parse('2026-07-07T12:00:00Z');
  const daysAgo = (n: number) => new Date(NOW - n * 86400_000).toISOString();

  test('오래되고·비중요·비회상만 삭제 · 미엘린/중요/최근 보존', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'qna', text: '낡은 잡담', ts: daysAgo(120), importance: 2 });        // 삭제 대상
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '낡지만 중요', ts: daysAgo(120), importance: 8 });     // 보존(중요)
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'qna', text: '낡지만 회상됨', ts: daysAgo(120), importance: 2 });     // 보존(미엘린)
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'qna', text: '최근 잡담', ts: daysAgo(3), importance: 2 });            // 보존(최근)
    recallEvents(d, { query: '회상됨', nowMs: NOW, sinceHours: 200 * 24 });   // 신선할 때 회상됐다 가정 → recall_count 보유
    const pruned = pruneStaleEvents(d, { nowExpr: new Date(NOW).toISOString() });
    expect(pruned).toBe(1);
    const remain = queryEvents(d, { limit: 10 }).map(r => r.text);
    expect(remain).toContain('낡지만 중요');
    expect(remain).toContain('낡지만 회상됨');
    expect(remain).toContain('최근 잡담');
    expect(remain).not.toContain('낡은 잡담');
  });

  test('삭제 시 FTS 동기(orphan 없음)', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'qna', text: '삭제될 반도체 잡담', ts: daysAgo(200), importance: 1 });
    pruneStaleEvents(d, { nowExpr: new Date(NOW).toISOString() });
    expect(queryEvents(d, { query: '반도체' }).length).toBe(0);   // FTS 에서도 사라짐
  });
});

describe('recentSentDigest — ambient 주입 (Block 5)', () => {
  test('최근 유의 발송만 요약(저중요/오래된/inbound 제외)', () => {
    const d = db();
    recordEvent(d, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone', text: '삼성 외국인 순매수 전환', importance: 7 });
    recordEvent(d, { surface: 'telegram', direction: 'outbound', kind: 'qna', text: '잡담 응답', importance: 3 }); // 저중요 제외
    recordEvent(d, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: '질문', importance: 7 }); // inbound 제외
    const digest = recentSentDigest(d);
    expect(digest).toContain('삼성 외국인 순매수');
    expect(digest).not.toContain('잡담');
    expect(digest).not.toContain('질문');
    expect(digest).toContain('memory_recall'); // 오리엔테이션 힌트
  });
  test('발송 없으면 빈 문자열(주입 스킵)', () => {
    expect(recentSentDigest(db())).toBe('');
  });
  test('sinceHours 밖 제외', () => {
    const d = db();
    recordEvent(d, { surface: 'x', direction: 'outbound', kind: 'alert', text: '오래된', importance: 8, ts: new Date(Date.now() - 100 * 3.6e6).toISOString() });
    expect(recentSentDigest(d, { sinceHours: 24 })).toBe('');
  });
});

describe('GEN — 도메인무관 taxonomy (category×domain)', () => {
  test('categoryOfKind — 스케줄러와 공유 taxonomy', () => {
    expect(categoryOfKind('watch-zone')).toBe('monitor');
    expect(categoryOfKind('breaking')).toBe('monitor');
    expect(categoryOfKind('digest')).toBe('digest');
    expect(categoryOfKind('report')).toBe('report');
    expect(categoryOfKind('qna')).toBe('qna');
    expect(categoryOfKind('alert')).toBe('alert');
    expect(categoryOfKind(undefined)).toBe('alert');
  });
  test('recordEvent — category 추론 + domain 기본 general(코어 중립·finance 가정 금지)', () => {
    const d = db();
    recordEvent(d, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone', text: '삼성 수급 전환' });
    const r = queryEvents(d, {})[0]!;
    expect(r.category).toBe('monitor');
    expect(r.domain).toBe('general'); // 옵션 라벨 정책 — 미지정=중립 general(격리 필요분만 명시 라벨)
  });
  test('recordEvent — 명시 category/domain 보존(비-Conatus 도메인)', () => {
    const d = db();
    recordEvent(d, { surface: 'cli', direction: 'outbound', kind: 'alert', text: '배포 완료', category: 'maintenance', domain: 'ops' });
    const r = queryEvents(d, {})[0]!;
    expect(r.category).toBe('maintenance');
    expect(r.domain).toBe('ops');
  });
  test('category/domain 필터 — queryEvents & recallEvents', () => {
    const d = db();
    recordEvent(d, { surface: 'x', direction: 'outbound', kind: 'watch-zone', text: '수급 모니터', domain: 'finance' });
    recordEvent(d, { surface: 'x', direction: 'outbound', kind: 'alert', text: '배포', category: 'maintenance', domain: 'ops' });
    expect(queryEvents(d, { category: 'monitor' }).length).toBe(1);
    expect(queryEvents(d, { domain: 'ops' }).length).toBe(1);
    expect(recallEvents(d, { domain: 'finance' }).length).toBe(1);
  });
});

describe('recordInboundTurn — 인바운드 대화 턴 기록(Block 3)', () => {
  test('Q&A 를 direction=inbound·kind=qna 로 기록(회상 anchor=질의)', () => {
    const d = db();
    const id = recordInboundTurn({ surface: 'telegram', userText: '삼성 수급 어때?', responseText: '외국인 순매수 전환입니다.', sessionId: 's1', db: d });
    expect(id).toBeTruthy();
    const rows = queryEvents(d, { direction: 'inbound' });
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe('qna');
    expect(rows[0]!.surface).toBe('telegram');
    expect(rows[0]!.summary).toBe('삼성 수급 어때?');       // 질의가 요약(회상 anchor)
    expect(rows[0]!.text).toContain('Q: 삼성 수급 어때?');
    expect(rows[0]!.text).toContain('A: 외국인 순매수');
    expect(rows[0]!.importance).toBe(3);                    // qna 저현저
    d.close();
  });

  test('빈 질의 → 기록 스킵(null)', () => {
    const d = db();
    expect(recordInboundTurn({ surface: 'telegram', userText: '   ', db: d })).toBeNull();
    expect(queryEvents(d, { direction: 'inbound' }).length).toBe(0);
    d.close();
  });

  test('응답 없어도 질의만 기록 + FTS 회상 가능', () => {
    const d = db();
    recordInboundTurn({ surface: 'pwa', userText: 'KORU 재진입 언제', db: d });
    const hits = recallEvents(d, { query: 'KORU 재진입', direction: 'inbound' });
    expect(hits.length).toBe(1);
    d.close();
  });
});

describe('M1 graded decay — stability 곡선(미엘린 반영)', () => {
  test('stabilityDays — importance·recall_count 로 늘어난다(미엘린)', () => {
    const low = stabilityDays(3, 0);     // 7 + 9 + 0 = 16
    const mid = stabilityDays(5, 0);     // 7 + 15 + 0 = 22
    const myelinated = stabilityDays(5, 10); // 7 + 15 + ~44 = ~66
    expect(mid).toBeGreaterThan(low);                 // 중요할수록 오래
    expect(myelinated).toBeGreaterThan(mid);          // 자주 회상할수록 오래(미엘린)
    expect(myelinated).toBeGreaterThan(60);
  });

  test('classifyTier — hot(≤stability) · warm(≤2×) · cold(초과)', () => {
    expect(classifyTier(10, 20)).toBe('hot');
    expect(classifyTier(20, 20)).toBe('hot');   // 경계 포함
    expect(classifyTier(30, 20)).toBe('warm');
    expect(classifyTier(40, 20)).toBe('warm');  // 2× 경계
    expect(classifyTier(41, 20)).toBe('cold');
  });

  test('applyMemoryDecay — 나이든 저현저는 cold, 미엘린은 hot 유지(삭제 없음)', () => {
    const d = db();
    const old = (days: number) => new Date(Date.now() - days * 8.64e7).toISOString();
    // 저현저·오래됨·비회상 → cold (stability~16, 100일)
    recordEvent(d, { surface: 'x', direction: 'outbound', kind: 'digest', text: '낡은 저현저', importance: 3, ts: old(100) });
    // 고현저·자주회상 → 100일이어도 hot 유지(stability 큼)
    const idHot = recordEvent(d, { surface: 'x', direction: 'outbound', kind: 'alert', text: '중요 자주회상', importance: 9, ts: old(50) });
    d.prepare(`UPDATE events SET recall_count = 12 WHERE id = ?`).run(idHot);

    const r = applyMemoryDecay(d);
    expect(r.cold).toBe(1);                           // 낡은 저현저 강등
    expect(r.hot).toBe(1);                            // 미엘린 보존
    // 삭제 안 됨 — 둘 다 남아있다(강등만).
    expect(queryEvents(d, {}).length).toBe(2);
    d.close();
  });

  test('recallEvents — cold 기억은 기본 회상 제외(흐려짐)·includeCold 로 복원', () => {
    const d = db();
    const old = (days: number) => new Date(Date.now() - days * 8.64e7).toISOString();
    recordEvent(d, { surface: 'x', direction: 'outbound', kind: 'digest', text: '삼성 낡은 발송', importance: 3, ts: old(200) });
    applyMemoryDecay(d);                              // → cold
    // 기본: cold 제외 → 회상 0 (sinceHours 넉넉히)
    expect(recallEvents(d, { query: '삼성', sinceHours: 24 * 365, bump: false }).length).toBe(0);
    // includeCold: cold 도 후보 → 회상 1
    expect(recallEvents(d, { query: '삼성', sinceHours: 24 * 365, includeCold: true, bump: false }).length).toBe(1);
    d.close();
  });
});

// ── wire 가드 (feedback_dep_inject_seam_must_be_wired · source_level_grep) ──
describe('배선 가드', () => {
  test('데몬 수렴점(/v1/outbound)이 원장을 기록한다 (P0.5 — ALL outbound 포착)', () => {
    const src = readFileSync(join(import.meta.dir, '../nexus/api/outbound-report.ts'), 'utf-8');
    expect(src).toContain("from '../../domains/surface-events.js'");
    expect(src).toContain('recordOutboundEvent(text, kind)');   // delivered 후 호출
    expect(src).toContain('recordEvent(db, {');
  });
  test('sendOutbound 은 직접폴백(direct)만 클라 기록 — 데몬경유 중복 금지', () => {
    const src = readFileSync(join(import.meta.dir, 'outbound-alert.ts'), 'utf-8');
    const body = src.slice(src.indexOf('export function sendOutbound'));
    expect(body).toContain("path === 'direct'");        // 데몬경유는 기록 안 함
    expect(body).toContain('recordOutbound(text, kind)'); // 폴백/보류만 기록
    expect(src).toContain("from './surface-events.js'");
  });
  test('memory_recall 이 L2 코어 도구(core-tools)로 등록·라우팅되고 finance 팩엔 없다', () => {
    const core = readFileSync(join(import.meta.dir, 'core-tools.ts'), 'utf-8');
    expect(core).toContain("name: 'memory_recall'");   // L2 spec
    expect(core).toContain('recallEvents(mdb,');         // L2 dispatch
    expect(core).toContain('schedule_manage');               // schedule_manage 도 L2
    const fin = readFileSync(join(import.meta.dir, 'finance-tools.ts'), 'utf-8');
    expect(fin).not.toContain("name: 'memory_recall'");  // finance 팩에서 이관 제거(강결합 해소)
  });
  test('finance 오리엔테이션이 memory_recall 회상을 지시한다', () => {
    const src = readFileSync(join(import.meta.dir, 'finance.ts'), 'utf-8');
    expect(src).toContain('memory_recall');
  });
  // ⚠️ M4a(2026-07-12): telegram-agent 의 assembly(Block 3/5 배선 포함)는
  //   src/agent/monad-agent-turn.ts 로 verbatim 이관되고 surface 로 일반화(telegram|discord)됨.
  //   telegram-agent.ts 는 이제 thin flavor shim → 배선 가드는 canonical 위치를 겨눈다.
  test('monad-agent-turn이 최근 발송(recentSentContext)을 systemPrompt에 주입한다 (Block 5)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'agent', 'monad-agent-turn.ts'), 'utf-8');
    expect(src).toContain('recentSentContext()');
    expect(src).toContain('recentSentDigest');
    // parts 배열(주입 지점)에 포함되는지
    expect(src.slice(src.indexOf('const parts'))).toContain('recentSentContext()');
  });
  test('monad-agent-turn이 대화 턴(recordInboundTurn)을 runTurn 후 기록한다 (Block 3)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'agent', 'monad-agent-turn.ts'), 'utf-8');
    expect(src).toContain('recordInboundTurn({');
    expect(src).toContain('surface, userText: opts.userText'); // surface 파라미터로 일반화(M4a)
    expect(src).toContain('result.text'); // runTurn 결과에서 응답(responseText) 추출
  });
});
