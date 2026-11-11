// ── 미션 최종 브리핑 — 실 소스 배선(B2 · PLAN-mission-pre-arming-briefing-2026-07-15) ────────
//
// mission-briefing.ts 는 순수 합성(readers 주입). 이 모듈이 그 readers 를 실 소스로 채운다:
//   revisions=getMissionRevisions · history=buildMissionHistory · mission/phases=TaskStore ·
//   resourceCount=missionResources · grounded=reconcileMission(현실 관측·B2 핵심).
// grounded 는 gh/git 을 호출(네트워크)하므로 기본 OFF — CLI/arming 시 opts.grounded 로 켠다.

import { TaskStore } from '../task-orchestrator/store.js';
import { buildMissionBriefing, type BriefingReaders, type BriefingPhase, type MissionBriefing } from './mission-briefing.js';
import { buildMissionHistory } from './mission-history.js';
import { getMissionRevisions } from './mission-lifecycle.js';
import { missionResources } from './mission-resources.js';
import { prUrlFromNotes } from './mission-multiphase-executor.js';
import { latestMissionRouteDecision } from './mission-route-decision.js';
import { resolveRouteDecision } from '../llm/route-decision.js';
import { getUserConfig } from '../user-config/reader.js';

/** 페이즈가 실집행/구현(deliverable 산출) 페이즈인가 — 조사·확인 마커면 read-only(산출물 기대 안 함). */
function phaseIsImpl(notes: readonly string[]): boolean {
  const readonly = notes.some((n) => /EXPLICIT_READONLY|\[READONLY\]|조사만|read-?only/i.test(n));
  if (readonly) return false;
  // 빌드 시도 흔적(SE-PR/REBUILD/BUILD)이 있으면 구현 페이즈. 없어도 조사 마커 없으면 impl 로 간주(보수).
  return true;
}

/**
 * 실 소스로 채운 BriefingReaders — buildMissionBriefing 에 주입. store 1회 열어 공유(닫기는 호출측/여기).
 * grounded=true 면 reconcileMission(현실 관측)을 추가(gh/git 호출·느림). 각 reader fail-soft.
 */
export function liveBriefingReaders(missionId: string, opts: { store?: TaskStore; grounded?: boolean } = {}): BriefingReaders {
  const store = opts.store ?? new TaskStore();
  return {
    revisions: () => {
      try {
        const r = getMissionRevisions(missionId, { store });
        if (!r) return null;
        return {
          ...(r.currentGoal ? { currentGoal: r.currentGoal } : {}),
          history: r.history.map((g) => ({
            generation: g.generation,
            ...(g.goal ? { goal: g.goal } : {}),
            reason: g.reason,
            phases: g.phases.map((p) => ({ title: p.title, status: p.status })),
          })),
        };
      } catch { return null; }
    },
    history: () => { try { return buildMissionHistory(missionId); } catch { return []; } },
    mission: () => {
      try {
        const m = store.getMission(missionId);
        if (!m) return null;
        // 아크는 autopilot 상태에 산다(rerunHistory 와 동일 컨테이너·m.autopilot?.arcs).
        const arcs = m.autopilot?.arcs;
        return { ...(arcs ? { arcs } : {}), status: m.status };
      } catch { return null; }
    },
    phases: () => {
      try {
        return store.listTasks({ goalSlug: missionId })
          .filter((t) => t.surface.kind === 'subagent')
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((t): BriefingPhase => {
            const prUrl = prUrlFromNotes(t.notes);
            return { title: t.title, status: t.status, isImpl: phaseIsImpl(t.notes), ...(prUrl ? { prUrl } : {}) };
          });
      } catch { return []; }
    },
    resourceCount: () => {
      try { const led = missionResources(missionId, { store }); return led.tasks.length + led.crons.length; }
      catch { return 0; }
    },
    // Actual execution evidence wins. Before a phase runs, expose a clearly
    // derived policy prediction rather than pretending it was executed.
    routeDecision: () => {
      try {
        const recorded = latestMissionRouteDecision(missionId, { store });
        if (recorded) return recorded;
        const cfg = getUserConfig();
        const goal = getMissionRevisions(missionId, { store })?.currentGoal;
        if (!goal || !cfg.llm?.provider) return null;
        return resolveRouteDecision({ provider: cfg.llm.provider, configuredModel: cfg.llm.model, text: goal, routePolicy: cfg.llm.routePolicy });
      } catch { return null; }
    },
    ...(opts.grounded ? {
      grounded: () => {
        try {
          // 동적 import — reconcile 는 gh/git 무거운 경로라 grounded 요청 시에만 로드.
          const { reconcileMission } = require('./mission-reconcile.js') as typeof import('./mission-reconcile.js');
          const { reconciliations } = reconcileMission(missionId);
          return reconciliations.map((rc) => ({
            phaseTitle: rc.phaseTitle, drift: rc.drift, note: rc.note, recordedPr: rc.recordedPr, perceived: rc.perceived,
          }));
        } catch { return []; }
      },
    } : {}),
  };
}

/**
 * 실 소스 브리핑 합성 — liveBriefingReaders + buildMissionBriefing. store 를 여기서 열고 닫는다.
 * pendingArming=실집행 승인 대상 페이즈(arming 게이트 연동). grounded=현실 관측(느림·CLI/arming 기본 ON).
 */
export function buildLiveMissionBriefing(
  missionId: string,
  opts: { pendingArming?: { phaseId: string; title: string }; grounded?: boolean } = {},
): MissionBriefing {
  const store = new TaskStore();
  try {
    const readers = liveBriefingReaders(missionId, { store, ...(opts.grounded ? { grounded: true } : {}) });
    return buildMissionBriefing(missionId, { readers, ...(opts.pendingArming ? { pendingArming: opts.pendingArming } : {}) });
  } finally {
    store.close();
  }
}
