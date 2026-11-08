import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── 미션 결정 기록 도구 (L2 core · RFC-mission-decision-injection-2026-07-15) ──
//
// elanous 에이전트·외부 도구(Claude Code/Codex)가 미션에 대한 운영 결정(re-ground·defer·check-pass·
// boundary…)을 프로그램적으로 기록. self_recall·logs_query 옆 L2 코어 도구. dispatch 는
// recordMissionDecision(통합 창구·3박자) 재사용 — 워킹메모리+logs.db+기억(surface_events)+ops.


import { TaskStore } from '../task-orchestrator/store.js';
import { recordMissionDecision, type MissionDecisionKind } from './mission-decision.js';

const KINDS: readonly MissionDecisionKind[] = ['re-ground', 'defer', 'check-pass', 'scope-note', 'boundary', 'reuse', 'accept'];

export const MISSION_DECIDE_SPEC: LLMToolSpec = {
  name: 'mission_decide',
  description: "⭐ 미션 결정 기록 (elanous 코어) — 미션에 대한 운영 결정(criterion re-ground·게이트 defer(arming/HITL)·감사 check-pass·범위 boundary·재사용 경계 등)을 미션 컨텍스트에 **정식 주입**한다. 결정이 ①후속 페이즈 빌드 프롬프트(자기인지) ②logs.db(elanous logs mission.selfheal.decision) ③통합 기억(surface_events·전 서피스 회상) ④ops timeline 에 **3박자로** 흐른다. **'이 아크 criterion 은 arming 으로 미뤄' '이 감사는 통과로 확인' '이 경계는 여기까지' 같은 운영 결정을 미션이 스스로 알고 셀프힐이 거스르지 않게 하려면 이 도구를 써라.** raw 스토어 변경 대신 이 창구로. (조회=self_recall/logs_query·상태변경 CRUD=autopilot_missions 와 구분: 여긴 '왜 그렇게 결정했나'의 원장.)",
  parameters: {
    type: 'object',
    properties: {
      missionId: { type: 'string', description: '대상 미션 id(apm_...).' },
      kind: { type: 'string', enum: [...KINDS], description: 're-ground(acceptance 재조정)·defer(arming/HITL로 미룸)·check-pass(감사 통과)·scope-note·boundary(완주 경계)·reuse·accept.' },
      note: { type: 'string', description: '결정 요약 한 줄.' },
      rationale: { type: 'string', description: '왜 이 결정인가(comprehension-debt 방지).' },
      appliesTo: { type: 'string', description: '대상(아크 핸들·페이즈·criterion 등·예: "A1 criterion 2").' },
      actor: { type: 'string', description: '누가(기본 agent).' },
      arcId: { type: 'string', description: '대상 아크 arcId(선택).' },
    },
    required: ['missionId', 'kind', 'note'],
  },
};

/** mission_decide 공유 구현 — recordMissionDecision(3박자) 재사용. */
export async function dispatchMissionDecide(args: Record<string, unknown>): Promise<unknown> {
  const missionId = typeof args.missionId === 'string' ? args.missionId.trim() : '';
  const note = typeof args.note === 'string' ? args.note.trim() : '';
  const kindRaw = typeof args.kind === 'string' ? args.kind : '';
  if (!missionId || !note) return { ok: false, error: 'missionId·note 필수' };
  const kind = (KINDS.includes(kindRaw as MissionDecisionKind) ? kindRaw : 'scope-note') as MissionDecisionKind;

  const store = new TaskStore();
  try {
    if (!store.getMission(missionId)) return { ok: false, error: `미션 없음: ${missionId}` };
  } finally { store.close(); }

  const recorded = recordMissionDecision(missionId, {
    kind, note, actor: typeof args.actor === 'string' && args.actor.trim() ? args.actor.trim() : 'agent',
    ...(typeof args.rationale === 'string' && args.rationale.trim() ? { rationale: args.rationale.trim() } : {}),
    ...(typeof args.appliesTo === 'string' && args.appliesTo.trim() ? { appliesTo: args.appliesTo.trim() } : {}),
    ...(typeof args.arcId === 'string' && args.arcId.trim() ? { arcId: args.arcId.trim() } : {}),
  });
  return {
    ok: true, missionId, kind, recorded,
    note: '결정이 워킹메모리+logs.db(mission.selfheal.decision)+기억(회상)+ops 에 3박자로 기록됨. 후속 페이즈·triage 가 이 결정을 인지한다.',
  };
}
