// ── L2 코어 앱 도구 레지스트리 (서피스·도메인 무관 · 2026-07-08) ───────────
//
// 툴 노출 3층 정리(대표 지시): L1 네이티브(session-runtime·Read/Grep/Bash) · **L2 코어
// 앱 도구(이 파일)** · L3 도메인 팩(finance_* — opt-in). L2는 도메인과 무관하고 어느
// 서피스(telegram·discord·PWA/iPad·iOS/Android·CLI·TUI·자율루프)에서든 항상 노출되는
// 코어 도구다. 이전엔 단일 출처가 없어 schedule_manage 가 4곳에 산재하고 memory_recall 이
// finance 팩에 갇혀 있었다 — 여기로 모아 **한 곳 등록 → 전 서피스 상속**으로 정리한다.
//
// 원칙(feedback_conatus_first_customer_not_core): finance/Conatus 는 퍼스트 고객(탈착
// 가능 옵션)이지 코어 아님. domain 무관 도구는 finance-tools.ts 가 아니라 이 L2 에.
//
// 새 코어 앱 도구는 여기 spec+dispatch 만 추가하면 전 서피스가 자동 상속한다.

import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import type { LLMToolSpec } from '../llm.js';
import { debug } from '../debug/log.js';
import { runRecall, CONTEXT_NOW_SPEC, type RecallSearch } from '../tool-runtime/self-cognition-runtimes.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import { SCHEDULE_MANAGE_SPEC, dispatchScheduleManage } from './schedule-manage-tool.js';
import { SESSION_MANAGE_SPEC, dispatchSessionQuery } from './session-query-tool.js';
import { AUTOPILOT_MISSION_SPEC, dispatchAutopilotMissions } from '../autopilot/mission-tool.js';
import { surfaceEventsDbPath, openSurfaceEventsDb, recallEvents } from './surface-events.js';
import { searchArchive, restoreFromArchive, type ArchiveS3Deps } from './memory-archive.js';
import { SELF_RECALL_SPEC, dispatchSelfRecall } from './self-awareness-tool.js';
import { FACT_CHECK_SPEC, dispatchFactCheck } from './fact-check.js';
import { OPS_STATUS_SPEC, dispatchOpsStatus } from './ops-status-tool.js';
import { SE_BUILD_SPEC, dispatchSeBuild } from './se-build-tool.js';
import { LOGS_QUERY_SPEC, dispatchLogsQuery } from './logs-tool.js';
import { MISSION_DECIDE_SPEC, dispatchMissionDecide } from '../autopilot/mission-decide-tool.js';
import { COO_ADMIN_SPEC, dispatchCooAdmin } from './coo-admin-tool.js';
import { RELEASE_STATUS_SPEC, RELEASE_CHANGE_SPEC, dispatchReleaseStatus, dispatchReleaseChange } from './release-tool.js';
import { OPS_SEATS_SPEC, DECISIONS_PENDING_SPEC, PROACT_METER_SPEC, dispatchOpsSeats, dispatchDecisionsPending, dispatchProactMeter } from './ops-facts-tool.js';

/** memory_recall — 크로스서피스 기억(자기 발송 원장 회상). 도메인 무관(domain 필터는 옵션).
 *  finance-tools 에서 L2 로 이관(2026-07-08). */
const MEMORY_RECALL_SPEC: LLMToolSpec = {
  name: 'memory_recall',
  description: "⭐ 크로스서피스 기억 (코어·**멀티 도메인**) — elanous가 전 표면에서 **자기가 발송한 알림/신호(outbound)와 나눈 대화(inbound Q&A)**를 회상. 도메인 무관 코어 도구로 여러 도메인을 아우른다: finance(투자 알림·수급·속보)·elanous(자기 구현 이력·self-awareness)·ops 등 — domain 인자로 특정 도메인만, 생략 시 전 도메인 통합 회상. **'방금/아까/어제 무슨 알림 보냈나' '전에 뭐라고 알려줬지' '내가 전에 뭘 물어봤지' 처럼 과거 발송·대화를 되짚는 질문은 반드시 이 도구 먼저.** direction 으로 outbound(발송)/inbound(대화) 필터, query(자연어) 최근성+현저성+관련성 스코어 top-N. 회상 결과에 **archived(흐려져 S3 로 이관된 cold 기억)** 가 있으면 그 후보의 id 를 **restoreId** 로 다시 호출해 **느린 복원**(S3 fetch·recall_count++·재활성화)해서 본문까지 되살릴 수 있다. READ-ONLY(restoreId 제외)·fail-soft. (예: 실시간 시세=finance_quote · 과거 유사국면 벡터검색=finance_knowledge · elanous 구현 이력=self_recall 과 구분: 여긴 도메인 불문 '내가 보낸/대화한 것'의 원장.)",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '회상할 자연어 키워드(예: "삼성 외국인 수급"·"KORU 재진입"·"리플레이 루프"). 생략 시 최근 전체.' },
      direction: { type: 'string', description: '방향 필터(선택) — outbound(내가 보낸 알림)|inbound(나눈 대화 Q&A). 생략 시 둘 다.' },
      kind: { type: 'string', description: '종류 필터(선택) — alert|watch-zone|digest|report|qna|impl 등.' },
      category: { type: 'string', description: '카테고리 필터(선택·도메인무관) — monitor|alert|report|digest|ingest|qna|maintenance|awareness.' },
      domain: { type: 'string', description: '도메인 필터(선택·멀티도메인) — finance(투자)·elanous(구현)·ops 등. 생략 시 전 도메인 통합.' },
      sinceHours: { type: 'number', description: '조회 기간 시간(기본 168=7일).' },
      limit: { type: 'number', description: '반환 건수(기본 8).' },
      restoreId: { type: 'string', description: '느린 복원(선택) — archived 후보의 id 를 지정하면 그 cold 기억을 S3 에서 복원(recall_count++·warm 재활성화)해 본문 반환. 회상 결과 archived 에 관련 후보가 있고 본문이 필요할 때만.' },
      timeBudgetMs: { type: 'number', description: '기억 조회 시간 예산(밀리초·기본 60000). 초과 시 찾은 것까지 부분 반환.' },
    },
    required: [],
  },
};

/** memory_recall 코어(db 주입·테스트 가능). restoreId 지정 시 느린 복원(축B P2), 아니면 회상 + archive 발견.
 *  recency+importance+relevance 스코어. restoreDeps 는 테스트 S3 mock(생략 시 기본 S3). */
export function recallOrRestore(mdb: Database, args: Record<string, unknown>, restoreDeps?: ArchiveS3Deps, onPartial?: (result: Record<string, unknown>) => void): unknown {
  // ★ 축B P2 느린 복원 — restoreId 지정 시 cold 기억을 S3 에서 명시적 복원(recall_count++·warm 재활성화).
  //   자동 아님(명시적) = 복원 폭주 방지. 죽어있던 restoreFromArchive 호출부 배선.
  if (typeof args.restoreId === 'string' && args.restoreId) {
    const id = String(args.restoreId);
    const restored = restoreDeps ? restoreFromArchive(mdb, id, restoreDeps) : restoreFromArchive(mdb, id);
    try { debug.log('memory.restore', restored ? 'restored' : 'miss', { id }); } catch { /* fail-open */ }
    if (!restored) return { restored: null, note: 'cold 기억 복원 실패 — 메타 없음 또는 S3 미존재.' };
    return {
      restored: {
        id: String(restored.id), when: String(restored.ts), surface: restored.surface, kind: restored.kind,
        text: String(restored.text ?? '').slice(0, 400), importance: restored.importance, recall_count: restored.recall_count,
      },
      note: '느린 복원 완료(S3→로컬·recall_count++·warm 재활성화). 이제 일반 회상 후보.',
    };
  }
  const hits = recallEvents(mdb, {
    ...(typeof args.query === 'string' && args.query ? { query: String(args.query) } : {}),
    ...(args.direction === 'inbound' || args.direction === 'outbound' ? { direction: args.direction } : {}),
    ...(typeof args.kind === 'string' && args.kind ? { kind: String(args.kind) } : {}),
    ...(typeof args.category === 'string' && args.category ? { category: String(args.category) } : {}),
    ...(typeof args.domain === 'string' && args.domain ? { domain: String(args.domain) } : {}),
    ...(typeof args.sinceHours === 'number' ? { sinceHours: args.sinceHours } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
  });
  const mappedHits = hits.map(h => ({
    when: h.ts, surface: h.surface, kind: h.kind,
    text: h.text.slice(0, 400), importance: h.importance,
    score: Math.round(h.score * 1000) / 1000,
  }));
  onPartial?.({ hits: mappedHits, count: hits.length });
  // M2 — cold(S3 보관) 기억 메타 발견(본문 fetch 없음·빠름). 존재+id 알리고 복원은 restoreId 로 명시적.
  const q = typeof args.query === 'string' ? String(args.query) : '';
  const archived = q ? searchArchive(mdb, q, { ...(typeof args.domain === 'string' && args.domain ? { domain: String(args.domain) } : {}), limit: 3 }) : [];
  return {
    hits: mappedHits,
    count: hits.length,
    ...(archived.length ? { archived: archived.map(a => ({ id: a.id, when: a.ts, summary: a.summary, note: 'cold·S3 보관(restoreId 로 느린 복원)' })) } : {}),
    note: '내가 발송/통지한 것의 원장 회상(크로스서피스 기억·hot/warm). archived=흐려져 S3 로 이관된 cold 기억(존재+id·본문은 restoreId 로 느린 복원). 비었으면 해당 기간 발송 없음.',
  };
}

/** memory_recall 공유 구현(finance-tools 에서 이관). db 열기 + recallOrRestore 위임. */
async function dispatchMemoryRecall(args: Record<string, unknown>, onPartial?: (result: Record<string, unknown>) => void): Promise<unknown> {
  if (!existsSync(surfaceEventsDbPath())) {
    return { hits: [], note: '발송 원장 미생성 — 아직 기록된 발송이 없음(데몬 재시작 후 sendOutbound부터 적재).' };
  }
  const mdb = openSurfaceEventsDb();
  try { return recallOrRestore(mdb, args, undefined, onPartial); }
  catch (e) { return { error: `기억 회상 실패: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}` }; }
  finally { mdb.close(); }
}

/** L2 코어 앱 도구 dispatch 핸들러 — 이름 → 구현. 새 코어 도구는 여기 추가. */
const CORE_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>, onPartial?: (result: Record<string, unknown>) => void) => Promise<unknown>> = {
  schedule_manage: dispatchScheduleManage,
  session_manage: (args) => dispatchSessionQuery(args), // 대화 세션 검색·열람·목록·삭제(내용/ID/텔레그램)
  memory_recall: dispatchMemoryRecall,
  context_now: async (args) => (await import('../context-bus/context-now.js')).contextNow({ ...(typeof args.topic === 'string' ? { topic: args.topic } : {}) }),
  fact_check: dispatchFactCheck, // 팩트체크 캐스케이드(내부 발송원장→외부 X/레딧/웹)·도메인 무관 코어
  self_recall: dispatchSelfRecall, // self-awareness(elanous 구현 이력)·도메인 무관 코어
  autopilot_missions: dispatchAutopilotMissions, // 오토파일럿 계보 조회(AL3)·도메인 무관 코어
  ops_status: dispatchOpsStatus, // 운영 상태 관측(지금 뭐 도나·이상 없나)·도메인 무관 코어
  se_build: dispatchSeBuild, // SE 격리 빌드 관측(빌드 안 뭐 하나·로그 tail·worktree diff)·코어
  logs_query: dispatchLogsQuery, // 크로스서피스 디버그 로그 조회(logs.db·LF3)·READ-ONLY 코어
  mission_decide: dispatchMissionDecide, // 미션 결정 기록(re-ground·defer·boundary…)·3박자 주입·코어
  coo_admin: (args) => dispatchCooAdmin(args),
  release_status: async (args) => dispatchReleaseStatus(args),
};

/** Worker-side search entry: dispatch must not re-enter its own budget wrapper. */
export function dispatchRecallUnbudgeted(name: 'memory_recall' | 'self_recall', args: Record<string, unknown>, onPartial: (result: Record<string, unknown>) => void): Promise<unknown> {
  return CORE_TOOL_HANDLERS[name]!(args, onPartial);
}

/** L2 코어 앱 도구 spec 목록(전 서피스 공용). */
const SELF_RECALL_BUDGET_SPEC: LLMToolSpec = {
  ...SELF_RECALL_SPEC,
  parameters: {
    ...SELF_RECALL_SPEC.parameters,
    properties: {
      ...(SELF_RECALL_SPEC.parameters.properties as Record<string, unknown>),
      timeBudgetMs: { type: 'number', description: '기억 조회 시간 예산(밀리초·기본 60000). 초과 시 찾은 것까지 부분 반환.' },
    },
  },
};
export const CORE_TOOL_SPECS: LLMToolSpec[] = [SCHEDULE_MANAGE_SPEC, SESSION_MANAGE_SPEC, MEMORY_RECALL_SPEC, FACT_CHECK_SPEC, SELF_RECALL_BUDGET_SPEC, CONTEXT_NOW_SPEC, AUTOPILOT_MISSION_SPEC, OPS_STATUS_SPEC, SE_BUILD_SPEC, LOGS_QUERY_SPEC, MISSION_DECIDE_SPEC, COO_ADMIN_SPEC, RELEASE_STATUS_SPEC, RELEASE_CHANGE_SPEC, OPS_SEATS_SPEC, DECISIONS_PENDING_SPEC, PROACT_METER_SPEC];

export interface CoreTools {
  specs: LLMToolSpec[];
  names: Set<string>;
  dispatch: (name: string, args: Record<string, unknown>, onPartial?: (result: Record<string, unknown>) => void, context?: ToolRuntimeContext) => Promise<unknown>;
}

/** 서피스 무관 코어 앱 도구 세트. 모든 서피스가 이걸 조립 → 코어 도구 단일 출처 상속.
 *  L1(native)·L3(finance 팩)와 조합해 쓴다. dispatch 는 이름으로 라우팅(미등록=error). */
export function buildCoreTools(recallSearch?: RecallSearch): CoreTools {
  const names = new Set(CORE_TOOL_SPECS.map(s => s.name));
  return {
    specs: CORE_TOOL_SPECS,
    names,
    dispatch: async (name, args, onPartial, context) => {
      const h = CORE_TOOL_HANDLERS[name];
      if (!h && name !== 'release_change' && name !== 'ops_seats' && name !== 'decisions_pending' && name !== 'proact_meter') return { error: `unknown core tool: ${name}` };
      if (name === 'release_change') return dispatchReleaseChange(args, context);
      if (name === 'ops_seats') return dispatchOpsSeats(args, context);
      if (name === 'decisions_pending') return dispatchDecisionsPending(context);
      if (name === 'proact_meter') return dispatchProactMeter(args, context);
      if (name === 'memory_recall' || name === 'self_recall') {
        return runRecall(name, args, context ?? { surface: 'skill' }, recallSearch, onPartial);
      }
      return h!(args, onPartial);
    },
  };
}
