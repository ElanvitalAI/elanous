import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── logs_query — 크로스서피스 로그 조회 도구 (통합 로그 패브릭 LF3 · 2026-07-13) ──
//
// elanous 자신(봇 턴·자율 루프·TUI 챗)이 자기/전체 서피스의 로그를 조회한다 —
// "방금 왜 에러났나", "PWA 에서 지금 무슨 일이", "보이스 timeout 있었나".
// adb logcat 의 도구 반쪽. logs.db(LF0) 직독 — 데몬 프로세스 밖(TUI 등)에서도
// 같은 스토어를 읽는다(READ-ONLY·fail-soft). 레벨 "변경"은 의도적으로 미노출
// (CLI `elanous logs level`/REST POST 소관 — 상태 변경은 HITL 있는 창구로).
//
// 설계: 내부 문서 `PLAN-unified-log-fabric-2026-07-13` §LF3.

import { existsSync } from 'node:fs';


import {
  LogStore,
  logsDbPath,
  type LogQuery,
} from '../mss/logging/log-store.js';
import { LOG_LEVEL_ORDER, type LogLevel } from '../mss/logging/record.js';
import { debug } from '../debug/log.js';

type LogsZeroReason =
  | 'no_records_in_window'
  | 'grep_may_be_multi_token_literal'
  | 'filter_has_no_candidates';

interface LogsZeroAnalysis {
  reason: LogsZeroReason;
  note: string;
  retryGrepTokens?: string[];
}

/**
 * A zero-result explanation is deliberately separate from storage so its
 * grep heuristic can be tested without a database. The multi-token case is
 * only a warning: LIKE can still match the literal string in rare data.
 */
/** `--grep`의 다중 키워드 오해를 판별·재조회 안내에 공통으로 쓰는 토크나이저. */
export function tokenizeGrepPhrase(grep?: string): string[] {
  return grep
    ?.trim()
    // 2026-07-28 실측에서 모델이 대안을 파이프로 썼으므로 |·,도 구분한다; 공백·명시 OR도 유지한다.
    .split(/\s+OR\s+|[|,]|\s+/)
    .filter(Boolean) ?? [];
}

export function analyzeLogsZeroResult(input: {
  grep?: string;
  filtersHaveNoCandidates: boolean;
}): LogsZeroAnalysis {
  const retryGrepTokens = tokenizeGrepPhrase(input.grep);

  if (input.filtersHaveNoCandidates) {
    return {
      reason: 'filter_has_no_candidates',
      note: '지정한 필터에 해당하는 기록이 이 로그 스토어에 아예 없을 수 있으므로, 이 0건은 그 일이 일어나지 않았다는 근거가 될 수 없습니다. 스토어 보존 기간 때문이거나 필터 이름/범위의 오타일 수 있습니다. category/event/surface/level 등의 이름과 범위를 확인해 다시 조회하세요.',
    };
  }
  if (retryGrepTokens.length >= 2) {
    return {
      reason: 'grep_may_be_multi_token_literal',
      retryGrepTokens,
      note: 'grep은 다중 키워드 OR 검색이 아니라 단일 부분문자열입니다. 이 0건을 기록 없음으로 결론내지 말고, retryGrepTokens의 각 토큰으로 나누어 다시 조회하세요.',
    };
  }
  return {
    reason: 'no_records_in_window',
    note: '지정한 유효 필터에서 이 시간창에 일치하는 기록이 없습니다.',
  };
}

export const LOGS_QUERY_SPEC: LLMToolSpec = {
  name: 'logs_query',
  description: "크로스서피스 로그 조회 (코어·READ-ONLY) — 전 서피스(nexus 데몬·PWA·telegram·discord·TUI·voice)의 디버그 로그를 한 스토어(logs.db)에서 조회. **'방금 왜 에러났나' '아까 PWA/텔레그램에서 무슨 일 있었나' '타임아웃/실패 있었나' 같은 자기 진단 질문은 이 도구 먼저.** level(이 레벨 이상)·surface·category prefix·grep·시간창 필터. 반환은 최근순. (운영 상태 스냅샷=ops_status · 발송/대화 기억=memory_recall 과 구분: 여긴 저수준 디버그 이벤트의 원장.) 레벨 변경은 불가 — CLI 'elanous logs level' 안내.",
  parameters: {
    type: 'object',
    properties: {
      level: { type: 'string', description: '이 레벨 이상만 — trace|debug|info|warn|error|critical (예: error 만 보려면 "error").' },
      surface: { type: 'string', description: 'surface 필터 CSV(선택) — nexus,pwa,telegram,discord,tui,ios,android.' },
      category: { type: 'string', description: 'category prefix 필터 CSV(선택) — 예: "voice"(voice.* 전부)·"webterm.tabs".' },
      exactCategory: { type: 'string', description: 'category 정확 일치 필터 CSV(선택) — 자식 category 제외.' },
      event: { type: 'string', description: 'event 정확 일치 필터 CSV(선택).' },
      grep: { type: 'string', description: 'event/data/category 부분 일치 검색(선택).' },
      sinceMinutes: { type: 'number', description: '조회 시간창(분·기본 30).' },
      sessionId: { type: 'string', description: '특정 세션의 로그만(선택).' },
      limit: { type: 'number', description: '반환 건수(기본 50·최대 200).' },
    },
    required: [],
  },
};

export async function dispatchLogsQuery(args: Record<string, unknown>): Promise<unknown> {
  const dbPath = logsDbPath();
  if (!existsSync(dbPath)) {
    return { logs: [], count: 0, note: `로그 스토어 미생성(${dbPath}) — LF0 이후 데몬이 한 번은 떠야 적재 시작.` };
  }
  const q: LogQuery = {};
  if (typeof args.level === 'string' && args.level) {
    if (!(args.level in LOG_LEVEL_ORDER)) {
      return { error: `level 은 ${Object.keys(LOG_LEVEL_ORDER).join('|')} 중 하나 (받음: '${args.level}')` };
    }
    q.minLevel = args.level as LogLevel;
  }
  const csv = (v: unknown): string[] | undefined => {
    if (typeof v !== 'string' || !v) return undefined;
    const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  };
  const surfaces = csv(args.surface);
  if (surfaces) q.surfaces = surfaces;
  const categories = csv(args.category);
  if (categories) q.categories = categories.map((c) => c.replace(/\.\*$/, ''));
  const exactCategories = csv(args.exactCategory);
  if (exactCategories) q.exactCategories = exactCategories;
  const events = csv(args.event);
  if (events) q.events = events;
  if (typeof args.grep === 'string' && args.grep) q.grep = args.grep;
  if (typeof args.sessionId === 'string' && args.sessionId) q.sessionId = args.sessionId;
  const sinceMin = typeof args.sinceMinutes === 'number' && args.sinceMinutes > 0 ? args.sinceMinutes : 30;
  q.sinceMs = Date.now() - sinceMin * 60_000;
  q.limit = Math.min(Math.max(1, typeof args.limit === 'number' ? args.limit : 50), 200);

  let store: LogStore | null = null;
  try {
    store = new LogStore(dbPath);
    const rows = store.query(q);
    const response = {
      logs: rows.map((r) => ({
        ts: r.ts,
        level: r.level,
        surface: r.surface,
        category: r.category,
        event: r.event,
        ...(r.session_id ? { sessionId: r.session_id } : {}),
        ...(r.data ? { data: r.data.length > 300 ? `${r.data.slice(0, 300)}…` : r.data } : {}),
      })),
      count: rows.length,
      window: `최근 ${sinceMin}분`,
      thisProcessLevel: debug.level(),
      note: '크로스서피스 디버그 로그(최근순·READ-ONLY). 레벨 변경은 CLI `elanous logs level <lvl>` 또는 PWA 대시보드에서.',
    };
    if (rows.length !== 0) return response;

    const candidateFilters: Omit<LogQuery, 'limit'> = {};
    if (q.minLevel) candidateFilters.minLevel = q.minLevel;
    if (q.surfaces) candidateFilters.surfaces = q.surfaces;
    if (q.categories) candidateFilters.categories = q.categories;
    if (q.exactCategories) candidateFilters.exactCategories = q.exactCategories;
    if (q.events) candidateFilters.events = q.events;
    if (q.sessionId) candidateFilters.sessionId = q.sessionId;
    const hasCandidateFilters = Object.keys(candidateFilters).length > 0;
    const analysis = analyzeLogsZeroResult({
      grep: q.grep,
      filtersHaveNoCandidates: hasCandidateFilters && store.countMatching(candidateFilters) === 0,
    });
    debug.log('domains.logs-query', 'zero-result-classified', {
      reason: analysis.reason,
      grepLength: q.grep?.length ?? 0,
      retryTokenCount: analysis.retryGrepTokens?.length ?? 0,
      hasCandidateFilters,
    });
    return {
      ...response,
      zeroReason: analysis.reason,
      note: analysis.note,
      ...(analysis.retryGrepTokens ? { retryGrepTokens: analysis.retryGrepTokens } : {}),
    };
  } catch (e) {
    return { error: `로그 조회 실패: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
  } finally {
    try { store?.close(); } catch { /* noop */ }
  }
}
