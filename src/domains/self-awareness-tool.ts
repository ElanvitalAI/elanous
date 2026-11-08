import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── Self-awareness 회상 도구 (P2 · 코어·도메인 무관 · 2026-07-08) ──────────
//
// elanous **코어** 기능 — finance/Conatus 도메인 팩과 독립(대표 지시: Conatus는 퍼스트
// 고객·탈착 가능 옵션이지 코어 아님). 그래서 finance-tools.ts 가 아니라 이 공유 모듈에
// 두고, 코어 도구 표면(continuation/telegram · CLI · daemon PWA/iOS/TUI)이 동일하게
// 배선한다(schedule_manage 공유 도구 패턴). domain='elanous' 고정.
//
// 두 층 통합 회상: 에피소드(surface_events domain=elanous — 구현 이벤트·무엇/언제/도구) +
// 문서 벡터(knowledge.db kind=docs domain=elanous — HANDOFF/REPORT/PLAN 의미검색·fail-soft).

import { existsSync } from 'node:fs';

import { surfaceEventsDbPath, openSurfaceEventsDb, recallEvents } from './surface-events.js';
import { knowledgeDbPath, openKnowledgeDb, hybridQueryKnowledge, renderKnowledgeMatches } from './knowledge.js';
import { SELF_DOMAIN } from './self-awareness.js';
import { debug } from '../debug/log.js';

export const SELF_RECALL_SPEC: LLMToolSpec = {
  name: 'self_recall',
  description: "⭐ Self-awareness 기억 (elanous 코어·도메인 무관) — **① 외부 도구(Claude Code/Codex)가 elanous 자체에 구현/변경한 것** + **② elanous 자율루프(dig·backtest·trade·retro·replay·delegate)가 무엇을 왜 했는지(자율행동)** 를 회상. **'최근 무슨 기능 구현했나' '내 코드/루프 뭐가 바뀌었지' '어제(오늘) 무슨 자율행동을 왜 했나' '자율매매/디깅/회고 뭐 돌았지' '이 기능 언제 넣었지' 같은 자기 구현·자율행동 이력 질문에 사용.** 두 층 통합: 에피소드(구현/자율행동 이벤트·무엇을·왜·언제·도구) + 문서 벡터(HANDOFF/REPORT/PLAN 의미검색). (내가 발송한 알림=memory_recall 과 구분: 여긴 '내가 구현/자율수행한 것'.) READ-ONLY.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '회상할 자연어 키워드(예: "리플레이 루프"·"trade checker gap 축"·"self-awareness"). 생략 시 최근 구현 전체.' },
      sinceHours: { type: 'number', description: '에피소드 조회 기간(기본 720=30일).' },
      limit: { type: 'number', description: '에피소드 반환 건수(기본 8).' },
    },
    required: [],
  },
};

/** self_recall 공유 구현 — 에피소드(결정론) + 문서 벡터(임베딩·fail-soft) 통합. */
export async function dispatchSelfRecall(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' ? String(args.query) : '';
  const limit = typeof args.limit === 'number' ? args.limit : 8;
  const sinceHours = typeof args.sinceHours === 'number' ? args.sinceHours : 720;
  // 제1원칙 관측 — 자기 기억(에피소드+문서벡터) 회상. kind='self'.
  try { debug.log('agent.source', 'recall', { kind: 'self', query, limit }); } catch { /* fail-open */ }

  // ① 에피소드 회상(surface_events domain=elanous · 무네트워크).
  let events: Array<{ when: string; tool: string; kind: string; summary: string; score: number }> = [];
  if (existsSync(surfaceEventsDbPath())) {
    const mdb = openSurfaceEventsDb();
    try {
      const hits = recallEvents(mdb, { domain: SELF_DOMAIN, sinceHours, limit, ...(query ? { query } : {}) });
      events = hits.map(h => ({
        when: h.ts, tool: h.surface, kind: h.kind ?? 'impl',
        summary: (h.summary ?? h.text).slice(0, 300), score: Math.round(h.score * 1000) / 1000,
      }));
    } catch { /* fail-soft */ } finally { mdb.close(); }
  }

  // ② 문서 벡터 회상(knowledge.db kind=docs · 임베딩 네트워크 · fail-soft).
  let docs: string | null = null;
  if (query && existsSync(knowledgeDbPath())) {
    const kdb = openKnowledgeDb();
    try {
      // DocOps P2 — 하이브리드(벡터+BM25 RRF): 고유명사/파일명/코드심볼 질의가 잡힌다.
      const matches = await hybridQueryKnowledge(kdb, query, { k: 5, kind: 'docs', domain: SELF_DOMAIN });
      if (matches.length > 0) docs = renderKnowledgeMatches(matches);
    } catch { /* 임베딩 불가 — 문서 검색 생략 */ } finally { kdb.close(); }
  }

  // ⛔⭐⭐⭐ **관측을 「불렀다」에서 「무엇을 얻었다」로 넓힌다**(2026-08-19 · `OBS-T116`).
  //   🚨 종전엔 질의만 남겨서 ***「불렀는데 0건」과 「불러서 찾았다」를 «못 갈랐다»***.
  //     그래서 「자식이 기억을 쓰나」를 물었을 때 ***호출 수 1,089 라는 «그럴듯한 수»만 나왔고,
  //     그 수는 「기억이 «작동하나»」에 아무 답도 못 했다***(`F42` — 호출 ≠ 내용).
  //   📏 실물 동기: 파생 우주의 knowledge.db 가 정본의 ***1/630 크기 · 7일 낡음***이었다(`OBS-T115`).
  //     그 상태에서 자식이 recall 을 «부르기는» 한다 — 그런데 무엇을 받았는지는 아무 데도 없었다.
  // ⛔ 질의 «내용»은 이미 위에서 남긴다 — 여기서는 «수»만 남긴다(중복·유출 방지).
  try {
    debug.log('agent.source', 'recall-result', {
      kind: 'self', events: events.length, docs: docs === null ? 0 : 1,
      // ⭐ 「찾을 곳이 있었나」와 「찾았나」는 다른 값이다 — 0건의 이유를 가른다(`F43`).
      knowledgeDbPresent: existsSync(knowledgeDbPath()),
      surfaceEventsDbPresent: existsSync(surfaceEventsDbPath()),
    });
  } catch { /* fail-open */ }

  return {
    events, count: events.length, docs,
    note: 'elanous 자기 구현·자율행동 이력 회상(self-awareness·코어·READ-ONLY). events=구현 이벤트(kind=impl 등) + 자율행동(kind=autonomy·loop별 무엇을·왜·결과) · docs=구현 문서 의미검색(HANDOFF/REPORT/PLAN). 비었으면 해당 기간/질의에 기록 없음(구현=elanous self log/POST /v1/self-event · 자율행동=자율루프가 자동 기록).',
  };
}
