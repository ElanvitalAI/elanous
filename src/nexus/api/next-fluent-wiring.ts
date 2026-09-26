// ── next-fluent 데몬 배선 (2026-07-15) ───────────────────────────────────────
//
// startNexusHttpServer 의 nextFluent 라우트 opts 를 구성한다. mission-fabric-aware source(페이즈 실
// 상태 역추적) + always-on enabled thunk + 옵션 로컬 페르소나 lane. intentPrediction
// 과 같은 자리(nexus/index.ts)에서 호출. 항상 배선하므로 route 는 더는 503(not-wired) 안 낸다.

import type { NextFluentRouteOpts } from './next-fluent.js';
import {
  createMissionNextActionSource, MISSION_ACTION_KINDS, type PhaseActionState,
} from '../../intent-prediction/next-action-source.js';
import { createLocalShowroomLaneCallable } from '../../task-orchestrator/surfaces/showroom-lane-callable.js';
import { getUserConfig } from '../../user-config.js';
import { TaskStore } from '../../task-orchestrator/store.js';

/** refId(phaseId) → 페이즈 액션 상태(TaskStore 역추적·fail-soft null). done/failed 카드 mount 당 1회. */
export function lookupPhaseState(refId: string): PhaseActionState | null {
  try {
    const store = new TaskStore();
    try {
      const t = store.getTask(refId);
      if (!t) return null;
      const notes = (t.notes ?? []).map(String);
      const isMissionPhase = t.surface.kind === 'subagent' && !!t.goalSlug;
      const hasPr = notes.some((n) => /\[SE-PR\]/.test(n));
      const hasCritique = notes.some((n) => /\[CRITIQUE:(FAIL|WARN)\]/i.test(n));
      let missionCompleted = false;
      if (t.goalSlug) { try { missionCompleted = store.getMission(t.goalSlug)?.status === 'completed'; } catch { /* fail-soft */ } }
      return { isMissionPhase, status: t.status, hasPr, missionCompleted, hasCritique };
    } finally { store.close(); }
  } catch { return null; }
}

const DISPATCHABLE = new Set<string>(MISSION_ACTION_KINDS);

/**
 * 칩 1-클릭 → 페이즈 액션 실행. refId(phaseId)로 missionId 역추적 후 dispatchAutopilotMissions(단일 창구·
 * 텔레그램 HITL 과 동일 경로). 화이트리스트 밖·비미션·미해결은 거부(안전). fail-soft.
 */
export async function dispatchPhaseAction(refId: string, action: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  if (!DISPATCHABLE.has(action)) return { ok: false, error: `unsupported-action: ${action}` };
  let missionId: string | null = null;
  try { const store = new TaskStore(); try { missionId = store.getTask(refId)?.goalSlug ?? null; } finally { store.close(); } } catch { /* fail-soft */ }
  if (!missionId) return { ok: false, error: 'phase-not-in-mission' };
  try {
    const { dispatchAutopilotMissions } = await import('../../autopilot/mission-tool.js');
    const r = await dispatchAutopilotMissions({ action, id: missionId, phase: refId }) as { error?: string } | null | undefined;
    if (r && typeof r === 'object' && 'error' in r && r.error) return { ok: false, error: String(r.error) };
    return { ok: true, message: `${action} 실행됨` };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/** nextFluent 페르소나 옵션은 검증된 typed 설정에서만 읽는다. */
function readNextFluentCfg(): { personas?: boolean } {
  return getUserConfig().nextFluent ?? {};
}

/** nextFluent 라우트 opts — 항상 배선. personas 는 build-time(재시작 반영). */
export function buildNextFluentRouteOpts(
  deps: { lookupPhase?: (refId: string) => PhaseActionState | null } = {},
): NextFluentRouteOpts {
  const lookup = deps.lookupPhase ?? lookupPhaseState;
  const personasOn = readNextFluentCfg().personas === true;
  return {
    deps: {
      source: createMissionNextActionSource({ lookupPhase: lookup }),
      enabled: () => true,
      ...(personasOn ? { laneCallable: createLocalShowroomLaneCallable() } : {}),
    },
    dispatch: dispatchPhaseAction,
  };
}
