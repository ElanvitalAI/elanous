import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── ops_status 코어 도구 (Ops Observability P2 · 2026-07-10) — 전 표면 상속 ──
//
// L2 코어 도구: elanous 가 "지금 무엇이 어떤 상태로 도나(미션·태스크·계약 루프·오케스트
// 레이터)"와 "이상은 없나"를 스스로/외부(telegram·PWA·CLI·자율루프·MCP)에서 조회.
// P1(ops-status)의 순수 집계 함수를 감싼 READ-ONLY dispatch — 단일 출처.
//
// 거버넌스: 순수 조회. 매매/발송 로직과 무관. fail-soft(집계 실패해도 error 필드로 응답).
// 도메인 무관 코어(feedback_conatus_first_customer_not_core) — finance 팩 아님.


import { opsSnapshot, opsHealth, opsTimeline, opsMissionDetail, type OpsScheduleSnapshot } from './ops-status.js';
import type { OpsEntityType, OpsEventKind } from './ops-log.js';

export const OPS_STATUS_SPEC: LLMToolSpec = {
  name: 'ops_status',
  description: "⭐ 운영 상태 관측 (코어·READ-ONLY) — elanous 가 **자기 자율 시스템이 지금 무엇을 어떤 상태로 돌리고 있나**를 인지. 오케스트레이터형 투자 루프(미션 → 3계약 루프[캡스톤·레버·자유스윙] → blackboard → 포트폴리오 오케스트레이터 → 집행) 4계층의 상태 전이·사이클·조율 결과를 집계한다. **'지금 뭐 돌고 있어?' '무슨 미션/태스크 도나' '이상 있어?' '오케스트레이터 잘 돌아?' '이 미션(apm_...) 상세 보여줘' '이 미션 관련 태스크/스케줄'** 류 질문에 사용. action: snapshot(미션/태스크 byStatus+두 플레인[스케줄실행 vs 디스패치대기]·계약 루프별 최신+arming·오케스트레이션·스케줄 헬스)·health(이상 판정)·timeline(상태 전이 최근순)·mission(id 지정 시 미션 1건 상세: 내용+**페이즈별 상태·저장 진단(failClass·근본원인·권장 힐)**+관련 태스크/스케줄/자율행동 fan-in+전이 이력+runLogPath. **'P2 왜 실패했어?' '어떻게 고쳐?'** 는 이 액션 1콜 — phases[].diagnosis 가 저장된 진단(재계산 불필요)). (예약 크론 CRUD=schedule_manage · 미션 arm/cancel/materialize=autopilot_missions · 발송원장=memory_recall 와 구분: 여긴 '지금 도는 자율 작업의 상태 관측'·READ-ONLY.)",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'snapshot(기본·현재 상태 종합)|health(이상 판정만)|timeline(상태 전이 최근순)|mission(id 미션 상세: 페이즈별 진단[failClass·rootCause·권장 힐]+태스크/스케줄 fan-in+runLogPath).' },
      id: { type: 'string', description: 'mission 액션 대상 미션 id(apm_...·snapshot의 missions.active 또는 autopilot list에서 확인).' },
      entityType: { type: 'string', description: 'timeline 필터(선택) — mission|task|loop|orchestration.' },
      event: { type: 'string', description: 'timeline 필터(선택) — created|status_change|cycle_start|cycle_end|merge|alloc|blocked.' },
      sinceHours: { type: 'number', description: 'timeline 조회 기간 시간(기본 48).' },
      limit: { type: 'number', description: 'timeline 반환 건수(기본 40).' },
    },
    required: [],
  },
};

export function projectScheduleHealth(schedules: OpsScheduleSnapshot | null): {
  elanousTotal: number;
  staleCount: number;
  erroredCount: number;
  noncanonicalCount: number;
  unmeasuredCount: number;
  excludedRunVia: number;
  excludedUnwrappedCrontab: number;
  excludedDisabled: number;
  excludedMissingCron: number;
} | null {
  if (!schedules) return null;
  return {
    elanousTotal: schedules.elanousTotal,
    staleCount: schedules.stale.length,
    erroredCount: schedules.errored.length,
    noncanonicalCount: schedules.noncanonical.length,
    unmeasuredCount: schedules.unmeasured.length,
    excludedRunVia: schedules.excludedRunVia,
    excludedUnwrappedCrontab: schedules.excludedUnwrappedCrontab,
    excludedDisabled: schedules.excludedDisabled,
    excludedMissingCron: schedules.excludedMissingCron,
  };
}

/** ops_status 실행 — 전 표면 공용. 순수 집계(ops-status.ts) 래퍼. READ-ONLY·fail-soft. */
export async function dispatchOpsStatus(args: Record<string, unknown>): Promise<unknown> {
  const action = String(args.action ?? 'snapshot');
  try {
    if (action === 'mission') {
      const id = typeof args.id === 'string' ? args.id : '';
      if (!id) return { error: 'mission 액션은 id(apm_...) 필요.' };
      const d = opsMissionDetail(id);
      return d;
    }
    if (action === 'health') {
      const h = opsHealth();
      return {
        healthy: h.healthy, anomalyCount: h.anomalies.length, anomalies: h.anomalies,
        generatedAt: h.generatedAt,
        note: h.healthy ? '이상 없음 — 자율 시스템 정상.' : `${h.anomalies.length}건 이상 — 관측+알림(HITL·개입은 대표 결정).`,
      };
    }
    if (action === 'timeline') {
      const entries = opsTimeline({
        ...(typeof args.entityType === 'string' && args.entityType ? { entityType: args.entityType as OpsEntityType } : {}),
        ...(typeof args.event === 'string' && args.event ? { event: args.event as OpsEventKind } : {}),
        ...(typeof args.sinceHours === 'number' ? { sinceHours: args.sinceHours } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      });
      return { count: entries.length, timeline: entries, note: entries.length ? '상태 전이 최근순(미션/태스크/루프/오케스트레이션 통합).' : '기록된 상태 전이 없음(데몬이 아직 새 코드로 안 돌았거나 활동 없음).' };
    }
    // snapshot(기본)
    const s = opsSnapshot();
    const h = opsHealth();
    return {
      missions: { total: s.missions.total, byStatus: s.missions.byStatus, active: s.missions.active },
      tasks: {
        total: s.tasks.total, byStatus: s.tasks.byStatus,
        scheduleBacked: s.tasks.scheduleBacked, recentlyActive: s.tasks.recentlyActive,
        dispatchPending: s.tasks.dispatchPending,
        blocked: s.tasks.blocked, dispatchable: s.tasks.dispatchable,
      },
      loops: s.loops,
      orchestration: s.orchestration,
      schedules: projectScheduleHealth(s.schedules),
      // anomalies 배열도 실어 스냅샷 1콜로 "무엇이 이상인지"까지 노출(종전 count만 → ops health
      // 재조회 강요·"카운트만 있고 상세 없음" 관측 갭. 2026-07-24).
      health: { healthy: h.healthy, anomalyCount: h.anomalies.length, anomalies: h.anomalies },
      generatedAt: s.generatedAt,
      note: '자율 시스템 현재 상태 종합(READ-ONLY). ★두 플레인: 태스크 scheduleBacked=스케줄로 실행중(backlog여도 안멈춤)·dispatchPending=진짜 대기. 미션 disposition=승인대기(HITL)/실행중. 이상=action:health · 전이=action:timeline.',
    };
  } catch (e) {
    return { error: `운영 상태 조회 실패: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
  }
}
