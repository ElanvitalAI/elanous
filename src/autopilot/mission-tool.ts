import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── Autopilot Mission Tool (AL3 · 2026-07-09) ─────────────────────────────
//
// 대표 지시: "tool 로 내용 조회가 가능해야." 오토파일럿 미션과 그 파생물(크론/
// 태스크/자율행동)을 조회하는 L2 코어 도구. list(미션 목록+헬스 롤업)·
// trace(미션 1건의 계보 트리+각 live 상태). schedule-manage-tool 패턴(전 표면 공용).


import { debug } from '../debug/log.js';
import { openAutopilotMissionsDb, listMissions, getMission, type MissionRow } from './mission-registry.js';
import { traceAutopilotMission } from './mission-trace.js';
import { materializeMission, armMission, approveMission, defaultSpawnRunMission } from './mission-engine.js';
import { cancelMission, missionKind, isReviewDue, rerunMission, rebuildPhase, rebuildCritiquedPhases, buildMissionExecutionContext } from './mission-lifecycle.js';
import { listPhases, trimPhase, deferPhase, editPhase } from './mission-adjust.js';
import { resolveMissionHitlUi } from './mission-notify.js';
import { splitPhaseIntoSubphases } from './mission-phase-split.js';
import { skipPhase } from './mission-phase-skip.js';
import { spawnMissionPrepare } from './mission-prepare-spawn.js';
import { missionCliScopeError, MISSION_MUTATING_ACTIONS } from './mission-cli-scope-guard.js';
import { missionRunLogPath } from './mission-engine.js';
import { missionPrepareLogPath } from './mission-prepare-spawn.js';
import { readWorkingMemory, formatWorkingMemoryDigest } from './mission-working-memory.js';
import { coordinatorRecordMemory } from './pipeline/coordinator-memory.js';
import { reconcileMission } from './mission-reconcile.js';
import { recommendRevise, reviseClassifyDefault, reviseKindLabel } from './mission-revise-recommender.js';
import { fetchPrContext, parsePrArg } from './mission-pr-context.js';
import { parseSuspectNotes } from './contradiction-detector.js';
import { parseDiagnosisNote } from './mission-phase-diagnosis.js';
import { runSystemLookback } from './system-lookback-run.js';
import { spawnSystemRepairMission } from './system-repair-spawn.js';
import { loadMissionOrigin } from './mission-origin.js';
import { TaskStore } from '../task-orchestrator/store.js';

/** 페이즈 status 직접 갱신(inject/check 용) — mission-adjust.editPhase 는 backlog/scheduled 만 허용해
 *  failed/done 페이즈를 못 건드린다. inject(외부 수습)·check(HITL 확인)는 failed→done 이 목적이라
 *  직접 resolve+saveTask. ref = index(0-based) 또는 task id. 반환 {ok,title,error}. */
function setPhaseStatusDirect(missionId: string, ref: string | number, status: string, extraNotes: string[] = []): { ok: boolean; title?: string; error?: string } {
  const store = new TaskStore();
  try {
    const phases = store.listTasks({ goalSlug: missionId })
      .filter((t) => t.surface.kind === 'subagent')
      .sort((a, b) => a.createdAt - b.createdAt);
    const key = String(ref).trim();
    const t = /^\d+$/.test(key) ? phases[Number(key)] : phases.find((p) => p.id === ref);
    if (!t) return { ok: false, error: `페이즈 없음: ${ref} (phases 로 목록 확인)` };
    // status 빈 문자열이면 현재 상태 유지(노트만 추가 — inject 가 PR 링크만 달 때).
    store.saveTask({ ...t, status: (status || t.status) as typeof t.status, notes: extraNotes.length ? [...t.notes, ...extraNotes] : t.notes, updatedAt: Date.now() });
    return { ok: true, title: t.title };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  finally { store.close(); }
}

/** 페이즈 task 조회(escalate 용) — ref = index(0-based) 또는 task id. subagent 페이즈만·생성순.
 *  notes(진단·[SUSPECT])를 읽어야 하는 escalate 가 setPhaseStatusDirect 와 달리 task 자체를 쓴다. */
function resolvePhaseTask(missionId: string, ref: string | number): { id: string; title: string; notes: string[] } | null {
  const store = new TaskStore();
  try {
    const phases = store.listTasks({ goalSlug: missionId })
      .filter((t) => t.surface.kind === 'subagent')
      .sort((a, b) => a.createdAt - b.createdAt);
    const key = String(ref).trim();
    const t = /^\d+$/.test(key) ? phases[Number(key)] : phases.find((p) => p.id === ref);
    return t ? { id: t.id, title: t.title, notes: [...t.notes] } : null;
  } catch { return null; }
  finally { store.close(); }
}

/** CSV/배열 인자 → 문자열 배열(inject 의 reusables/decisions). */
function parseListArg(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  return [];
}
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';

export const AUTOPILOT_MISSION_SPEC: LLMToolSpec = {
  name: 'autopilot_missions',
  description: "⭐ 오토파일럿 미션 조회·구체화 — 오토파일럿이 받은 골(미션)과 그것이 만든 파생물(크론/태스크/자율행동)을 추적·모니터. 미션마다 안정 ID(apm_...)가 있고 파생물엔 부모 미션 ID가 심겨(계보) 무엇을 만들었고 각각 돌고 있는지 조회 가능. **'오토파일럿이 뭘 만들었나' '이 미션 상태' '오토파일럿 잡 추적' '자율로 만든 크론/태스크 조회'** 류에 사용. action: list(미션 목록+헬스 롤업·status/source 필터)·trace(id의 계보 트리+각 파생물 live 상태: ✅ok·⏰stale·❌error·🔵active·⏳pending)·materialize(scheduler 미션→실제 cron 생성. 스케줄은 골에서 자동 추론·command는 명시 필수·HITL). list/trace=READ-ONLY.",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'list(기본·미션 목록)|trace(id의 계보 트리)|phases(id의 멀티페이즈 플랜 목록)|approve(승인·backlog 페이즈 집행)|trim(페이즈 제거)|defer(페이즈 보류)|edit(페이즈 교정)|rerun(처음부터 재실행·세대+1·이전 PR close)|rebuild(특정 페이즈부터 재구현·후속 리셋)|split(★실패 페이즈를 단일책임 서브페이즈로 국소 재분해·과대 페이즈용)|skip(★페이즈 건너뛰기=기능 제외·후속 언블록·부분 완주)|revise(★골 정정·재분해 — comment 필수·실패 컨텍스트 자동 포함)|revise-suggest(★미션 자율 revise 추천 — 관측+맥락(context)으로 정정 comment 를 LLM 이 자동 생성·READ-ONLY·트리거 안 함. 원탭 승인 또는 revise 로 집행)|rereflect(비평 지적 페이즈만 자동 재구현·머지는 HITL)|log(★미션 실행 로그 run.log tail — 진단 근거의 실체·재부팅에도 영속)|memory(★미션 워킹 메모리 — 지금까지 각 페이즈가 무엇을 조사·결정·재사용·산출했나. 미션 셀프 인지)|reconcile(★self-perception — 각 페이즈의 기록 상태·PR vs 현실(git/PR/main)을 미션이 스스로 관측해 drift 감지·자기 형상 재인지. 외부가 PR을 머지/닫아도 미션이 현실에 스스로 도달. self-memory 에 provenance=reconcile 로 self-write)|inject(★외부 가이드/수습 주입 — 외부 도구/대표가 재사용맵·교정·페이즈 상태(done)·머지PR을 미션에 정식 주입. provenance=external 태그·self-memory 안 해침. ❔ 페이즈 체크·외부 머지 인지)|check(★HITL 확인 패스 — 카나리 등 사람이 도착/결과를 눈으로 확인해야 하는 페이즈를 done 처리. 에이전트 검증 불가 항목의 사람 확인)|escalate(★시스템 셀프힐링 — 진단이 escalate 권장한 실패 페이즈(R2 시스템 결함 의심)를 R3 Opus 룩백 후 system-repair 권한 수리 미션으로 스폰. 예산/분할로 안 풀리는 elanous 자기 코드/설정 결함을 자율 수리로 잇는다. 보안 경계는 사람 판단 통지만. merge+데몬 재시작은 HITL)|materialize(즉시 구체화)|arm(승인·spec 저장)|briefing(★실집행 전 최종 브리핑 — 골 진화(최초/중간/최종)+여정+산출물 grounded 점검+정착 종합. send=true 면 텔레그램 카드[승인/재조치/보류])|landing(★랜딩 빠른 스캔 — 기록 PR merge 상태만 1회 gh 배치(수초). 완주/arming 전 "미머지 있나?" 즉답. blocking=open PR=확정 미머지)|cancel(미션 종료·파생 잡 release). ★힐: 실패 페이즈의 권장 힐(ops_status action:mission 의 diagnosis.heal)에 따라 rebuild/split/revise/skip 선택 — 3층 탈출구(재구현→분할→골정정/건너뛰기). ★HITL 조정: 플랜 검토 시 과한 페이즈를 trim/defer 하거나 edit 로 교정 후 approve.' },
      id: { type: 'string', description: 'trace/phases/approve/trim/defer/edit/rerun/rebuild/split/skip/revise/materialize/arm/cancel 대상 미션 id(apm_...·list에서 확인).' },
      phase: { type: 'string', description: 'trim/defer/edit/rebuild/split/skip 대상 페이즈 — index(0-based·"3") 또는 task id. phases 로 확인.' },
      comment: { type: 'string', description: 'revise 용(필수) — 골 정정 지시(예: "범위축소: X 기능 제외하고 재분해"). 실행 컨텍스트(실패 페이즈+사유)는 자동 첨부.' },
      context: { type: 'string', description: 'revise-suggest 용(선택) — 정정 방향 자유 맥락(예: 대표 텔레그램 메시지 "급락 리플레이는 빼줘"). 미션 관측과 합쳐 정정 comment 를 자동 생성.' },
      tail: { type: 'number', description: 'log 용(선택) — 마지막 N줄(기본 40·최대 200).' },
      note: { type: 'string', description: 'inject 용 — 외부 가이드/수습 내용(예: "sub6 fixture는 #4028로 랜딩").' },
      pr: { type: 'string', description: 'inject 용 — 외부 머지 PR 번호(페이즈 링크). ★revise/revise-suggest 용 — PR 번호(들·쉼표구분·예 "4306,4307"). 시스템이 스스로 PR 제목·본문·변경파일·연관 RFC/PLAN 문서를 읽어 정정 맥락에 합류(PR 로 골 재분해).' },
      reusables: { type: 'string', description: 'inject 용(선택) — 재사용 경계(; 또는 줄바꿈 구분).' },
      arc: { type: 'string', description: 'inject 용(선택·대표 2026-07-16) — 외부 아크 수습. 외부가 아크 통합을 미션 밖(main 머지)에서 완성해 아크 검증기가 못 ground 할 때, 그 아크(arcId·name·index)를 done+verified 로 정식 처리(provenance=external·근거 note 기록). 후속 아크 배리어 해제. L3 외부개정 존중의 아크판.' },
      decisions: { type: 'string', description: 'inject 용(선택) — 결정(; 또는 줄바꿈 구분).' },
      title: { type: 'string', description: 'edit 용 — 페이즈 새 제목(선택).' },
      description: { type: 'string', description: 'edit 용 — 페이즈 새 설명(선택).' },
      status: { type: 'string', description: 'list 필터(선택) — proposed|armed|running|done|failed|disarmed.' },
      source: { type: 'string', description: 'list 필터(선택) — human-intent(구 intake·사람 포착)|discovery|repo-watch|manual.' },
      command: { type: 'string', description: 'materialize(scheduler)용 — cron이 실행할 명령(예: "scripts/foo.ts"·자동보강). 자동생성 안 함(HITL).' },
      cron: { type: 'string', description: 'materialize(scheduler)용 cron 식(선택·미지정 시 골에서 추론).' },
      prompt: { type: 'string', description: 'materialize(task)용 — TOX 태스크가 수행할 내용(선택·미지정 시 골 사용).' },
      send: { type: 'boolean', description: 'briefing 용(선택) — true 면 텔레그램 브리핑 카드([승인/재조치/보류]) 발송. 미지정=READ-ONLY 합성만.' },
      grounded: { type: 'boolean', description: 'briefing 용(선택) — false 면 현실 관측(reconcile·gh/git) 생략하고 title 휴리스틱만(빠름). 기본 ON.' },
    },
  },
};

function missionSummary(m: MissionRow, rollup?: { total: number; ok: number; stale: number; error: number; active: number; pending: number }): Record<string, unknown> {
  return {
    id: m.id, goal: m.goal, source: m.source, status: m.status,
    model: m.execution_model, tier: m.tier, engine: m.engine,
    domain: m.domain,                       // WHAT축 골 성격(coding·investment·business·general)
    mode: m.mode ?? null,                   // ★ 예약(RFC §3a) HOW축 실행 모드 — RFC 이후 채움·그전 null
    kind: missionKind(m.execution_model),   // 수명 성격(finite=완료시 종료·continuous=취소까지)
    reviewDue: isReviewDue(m.execution_model, m.status, m.created_at), // 상시 30일+ 드리프트 리뷰
    createdAt: m.created_at,
    ...(rollup ? { derived: rollup } : {}),
  };
}

export async function dispatchAutopilotMissions(args: Record<string, unknown>): Promise<unknown> {
  const action = String(args.action ?? 'list').trim() || 'list';
  // 크로스서피스 싱크 표기 — 어느 서피스에서 해소됐는지(기본 pwa · TUI 는 'tui' 전달·C-b-2 PR①).
  const via = args.via === 'tui' ? 'tui' as const : 'pwa' as const;
  // ★ 스토어 스코프 가드(2026-07-14) — ELANOUS_STATE_DIR 이 config-dir 와 어긋나면 mutating
  //   미션 명령이 운영 스토어에 조용히 작동하는 사고를 fail-closed 로 막는다.
  if (MISSION_MUTATING_ACTIONS.has(action)) {
    const scopeErr = missionCliScopeError();
    if (scopeErr) return { error: scopeErr };
  }
  try {
    if (action === 'threads') {
      // ★ UR4a 조율자 상주 thread authority(2026-07-19) — 데몬이 인지하는 살아있는 미션 thread 뷰
      //   (disk-discovery·read-only·비파괴). 활성도 + 중앙 State(progress/cursor) 요약. 어느 프로세스에서든
      //   동일(디스크가 진실원). 제1원칙 관측 — mission.registry 로 데몬 인지 남김.
      const { listMissionThreads } = await import('./pipeline/mission-thread-registry.js');
      const activeOnly = args.active === true;
      const within = Number(args.within);
      const rows = listMissionThreads({
        ...(activeOnly ? { activeOnly: true } : {}),
        ...(Number.isFinite(within) && within > 0 ? { activeWithinMin: within } : {}),
      });
      const activeCount = rows.filter((r) => r.active).length;
      try { const { debug } = await import('../debug/log.js'); debug.log('mission.registry', 'list', { threadCount: rows.length, activeCount, via }); } catch { /* fail-soft */ }
      return { ok: true, mode: 'threads', threadCount: rows.length, activeCount, threads: rows };
    }
    if (action === 'history') {
      // ★ 미션 생애주기 revision 타임라인(대표 2026-07-13·P1) — 세대별 골·페이즈 변천 조회(READ-ONLY).
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'history엔 id(apm_...) 필수.' };
      const { getMissionRevisions } = await import('./mission-lifecycle.js');
      let r = getMissionRevisions(id);
      // ★ H2 — 행이 purge 됐어도 cold ledger 스냅샷이 있으면 그걸로 도달(냉동보관 self-recall). fail-soft.
      let coldArchived = false;
      if (!r) {
        try {
          const { readColdSnapshot } = await import('./lineage/cold-ledger.js');
          const snap = readColdSnapshot(id);
          if (snap) { r = { currentGeneration: snap.currentGeneration ?? 0, currentGoal: snap.goal, history: snap.revisions }; coldArchived = true; }
        } catch { /* fail-soft */ }
      }
      if (!r) return { error: '미션 없음(apm_...)' };
      // ★ 종합 히스토리(Track B·대표 2026-07-16 갭수정) — revision 만 반환하던 걸 편집/결정/분할/drift/
      //   외부(🔧 PR·RFC L1) 통합까지 합류. 미션(LLM·CLI)이 외부 변경을 인지(self log --mission 표출).
      let comprehensive: unknown[] = [];
      try { const { buildMissionHistory } = await import('./mission-history.js'); comprehensive = buildMissionHistory(id); }
      catch { /* fail-soft */ }
      // ★ 5-way lineage(--full·H1) — Historian 통합 타임라인(세대아카이브·워킹메모리·빌드/실행프레임·캐시).
      //   기존 revision+Track B 위에 시간축 교차 뷰를 추가(관측 부족 수복·RFC §2a). fail-soft.
      let lineageText: string | undefined;
      if (args.full === true) {
        try {
          const { mountBuiltinLineageSources } = await import('./lineage/sources.js');
          const { buildLineageTimeline, formatLineageTimeline } = await import('./lineage/timeline.js');
          mountBuiltinLineageSources();
          lineageText = formatLineageTimeline(buildLineageTimeline(id));
        } catch { /* fail-soft */ }
      }
      return { missionId: id, ...r, comprehensive, ...(coldArchived ? { coldArchived: true } : {}), ...(lineageText ? { lineageText } : {}) };
    }
    if (action === 'briefing') {
      // ★ 미션 최종 브리핑(B4·실집행 전 종합 점검) — 골 진화+여정+산출물 grounded 점검+정착 종합.
      //   기본 READ-ONLY(합성만). send=true 면 텔레그램 브리핑 카드 발송([승인/재조치/보류]).
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'briefing엔 id(apm_...) 필수.' };
      const grounded = args.grounded !== false; // 기본 ON(실집행 전 현실 관측)
      if (args.send === true) {
        const { presentMissionBriefing } = await import('./mission-briefing-notify.js');
        const { loadMissionOrigin } = await import('./mission-origin.js');
        const r = presentMissionBriefing(loadMissionOrigin(id), id, { grounded });
        return { ok: true, missionId: id, sent: r.sent, attached: r.attached, briefing: r.briefing };
      }
      const { buildLiveMissionBriefing } = await import('./mission-briefing-live.js');
      return { missionId: id, briefing: buildLiveMissionBriefing(id, { grounded }) };
    }
    if (action === 'landing') {
      // ★ 랜딩 빠른 스캔(B7) — 기록 PR merge 상태만 1회 gh 배치(git 고고학 없음·수초). 완주/arming
      //   전 "미머지 있나?" 즉답. blocking=open(확정 미머지). 상세는 briefing --grounded.
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'landing엔 id(apm_...) 필수.' };
      const { scanMissionLanding, formatLandingScanLine } = await import('./mission-landing-scan.js');
      const scan = scanMissionLanding(id);
      return { missionId: id, scan, summary: formatLandingScanLine(scan) };
    }
    if (action === 'cancel') {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'cancel엔 id(apm_...) 필수.' };
      // defer=보류(record 유지·status=rejected) — 텔레그램 HITL 거절과 동형(완전삭제는 기본 cancel).
      const defer = args.defer === true;
      const r = await cancelMission(id, { defer });
      if (!r.ok) return { error: r.error };
      // 크로스서피스 싱크 — 텔레그램 HITL 버튼 메시지가 있으면 "거절됨"으로 edit(fail-soft·좌표 없으면 no-op).
      resolveMissionHitlUi(id, 'rejected', via);
      return { ok: true, missionId: id, status: defer ? 'rejected' : 'done', releasedCrons: r.releasedCrons, releasedTasks: r.releasedTasks, releasedWorkflows: r.releasedWorkflows,
        note: `${defer ? '미션 보류(기록 유지)' : '미션 종료'} · 파생 크론 ${r.releasedCrons} 삭제 · 태스크 ${r.releasedTasks} 정리${r.releasedWorkflows ? ` · workflow 정의 ${r.releasedWorkflows} 삭제` : ''}.` };
    }
    if (action === 'approve') {
      // V4 HITL 승인 — 자동 분해된 backlog 태스크를 ready 로 승격(집행)·미션 running.
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'approve엔 id(apm_...) 필수.' };
      const r = await approveMission(id);
      if (!r.ok) return { error: r.error };
      // 크로스서피스 싱크 — 텔레그램 HITL 버튼 메시지가 있으면 "승인됨"으로 edit(fail-soft·좌표 없으면 no-op).
      resolveMissionHitlUi(id, 'approved', via);
      return { ok: true, missionId: id, status: 'running', activated: r.activated,
        ...(r.scheduledCron ? { scheduledCron: r.scheduledCron } : {}),
        note: r.scheduledCron
          ? `승인 — 반복 예약 배선(${r.scheduledCron}·run-mission). 미션 running.`
          : `승인 — backlog 태스크 ${r.activated}건 ready 승격(집행 시작). 미션 running.` };
    }
    if (action === 'arm') {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'arm엔 id(apm_...) 필수.' };
      const spec: { command?: string; cron?: string; prompt?: string } = {};
      if (typeof args.command === 'string' && args.command.trim()) spec.command = args.command.trim();
      if (typeof args.cron === 'string' && args.cron.trim()) spec.cron = args.cron.trim();
      if (typeof args.prompt === 'string' && args.prompt.trim()) spec.prompt = args.prompt.trim();
      const r = armMission(id, spec);
      if (!r.ok) return { error: r.error };
      return { ok: true, missionId: id, status: 'armed', spec,
        note: 'HITL 승인·spec 저장. arming.materialize ON 이면 자동 실행 · 아니면 materialize로 즉시 실행.' };
    }
    if (action === 'materialize') {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'materialize엔 id(apm_...) 필수.' };
      const command = typeof args.command === 'string' ? args.command.trim() : undefined;
      const cron = typeof args.cron === 'string' ? args.cron.trim() : undefined;
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : undefined;
      const r = await materializeMission({ missionId: id, ...(command ? { command } : {}), ...(cron ? { cron } : {}), ...(prompt ? { prompt } : {}) });
      if (!r.ok) return { error: r.error, engine: r.engine };
      return {
        ok: true, missionId: id, engine: r.engine,
        ...(r.cron ? { cron: r.cron, inferred: r.inferred } : {}),
        ...(r.taskId ? { taskId: r.taskId } : {}),
        note: `미션→${r.engine} 구체화·계보 연결(apm_id 스탬프)${r.inferred ? ' · 스케줄 골에서 추론' : ''}. trace로 상태 확인.`,
      };
    }
    if (action === 'phases' || action === 'trim' || action === 'defer' || action === 'edit') {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: `${action}엔 id(apm_...) 필수.` };
      const mdb = openAutopilotMissionsDb();
      try {
        if (action === 'phases') {
          const phases = listPhases(mdb, id);
          return { ok: true, missionId: id, count: phases.length, phases,
            note: phases.length === 0 ? '페이즈 없음(단일/미분해 미션).' : '멀티페이즈 플랜(index로 trim/defer/edit·approve 시 backlog만 집행).' };
        }
        const phaseRef = String(args.phase ?? '').trim();
        if (!phaseRef) return { error: `${action}엔 phase(index 또는 task id) 필수. phases 로 확인.` };
        if (action === 'trim') {
          const r = trimPhase(mdb, id, phaseRef);
          return r.ok ? { missionId: id, ...r } : { error: r.error };
        }
        if (action === 'defer') {
          const r = deferPhase(mdb, id, phaseRef);
          return r.ok ? { missionId: id, ...r } : { error: r.error };
        }
        // edit
        const edits: { title?: string; description?: string } = {};
        if (typeof args.title === 'string' && args.title.trim()) edits.title = args.title.trim();
        if (typeof args.description === 'string' && args.description.trim()) edits.description = args.description.trim();
        const r = editPhase(mdb, id, phaseRef, edits);
        return r.ok ? { missionId: id, ...r } : { error: r.error };
      } finally { mdb.close(); }
    }
    // ★ 재실행/재구현(C-b-2 PR ③) — 텔레그램 HITL 버튼(rerun·rebuild)과 동일한 write 경로를
    //   전 표면(LLM tool·TUI·CLI)에 개방. 실행은 rerun/rebuild 내부의 run-mission 재spawn 그대로.
    if (action === 'rerun') {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'rerun엔 id(apm_...) 필수.' };
      const r = rerunMission(id);
      if (!r.ok) return { error: r.error };
      const gen = r.generation && r.generation > 0 ? ` · 세대 ${r.generation}` : '';
      return { ok: true, missionId: id, reset: r.reset, total: r.total, ...(r.generation ? { generation: r.generation } : {}),
        note: `처음부터 재실행${gen} — ${r.reset}/${r.total} 페이즈 리셋·집행 시작(이전 세대는 히스토리 보관).` };
    }
    if (action === 'rebuild') {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'rebuild엔 id(apm_...) 필수.' };
      const phaseRef = String(args.phase ?? '').trim();
      if (!phaseRef) return { error: 'rebuild엔 phase(index 또는 task id) 필수. phases 로 확인.' };
      // index/id 겸용 해석 — listPhases 의 실행순서 index 와 동일 규약(trim/defer/edit 와 대칭).
      const mdb = openAutopilotMissionsDb();
      let phaseId: string | null = null;
      let phaseTitle = '';
      try {
        const phases = listPhases(mdb, id);
        const hit = /^\d+$/.test(phaseRef)
          ? phases[Number(phaseRef)]
          : phases.find((p) => p.id === phaseRef);
        if (hit) { phaseId = hit.id; phaseTitle = hit.title; }
      } finally { mdb.close(); }
      if (!phaseId) return { error: `페이즈 없음: ${phaseRef} (phases 로 확인).` };
      const r = rebuildPhase(id, phaseId, { note: '사람 재구현 요청(autopilot_missions tool)' });
      if (!r.ok) return { error: r.error };
      return { ok: true, missionId: id, phase: phaseTitle, reset: r.reset, total: r.total, fromIndex: r.fromIndex,
        note: `페이즈 재구현 "${phaseTitle}" — ${r.fromIndex}번부터 ${r.reset} 페이즈 리셋·집행 시작(후속 의존 페이즈 포함).` };
    }
    // ★ 힐 액션 3종(P2 · 2026-07-13) — 텔레그램 버튼 전용이던 split/skip/revise 를 전 표면
    //   (LLM tool·TUI·CLI)에 개방. 콜백 핸들러(mission-hitl-callback)와 동일 함수 소비(단일 창구).
    //   진단(ops_status action:mission)의 권장 힐을 에이전트가 대화 지시 하에 직접 실행하는 수단.
    if (action === 'split' || action === 'skip') {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: `${action}엔 id(apm_...) 필수.` };
      const phaseRef = String(args.phase ?? '').trim();
      if (!phaseRef) return { error: `${action}엔 phase(index 또는 task id) 필수. phases 로 확인.` };
      const mdb = openAutopilotMissionsDb();
      let phaseId: string | null = null;
      let phaseTitle = '';
      try {
        const phases = listPhases(mdb, id);
        const hit = /^\d+$/.test(phaseRef) ? phases[Number(phaseRef)] : phases.find((p) => p.id === phaseRef);
        if (hit) { phaseId = hit.id; phaseTitle = hit.title; }
      } finally { mdb.close(); }
      if (!phaseId) return { error: `페이즈 없음: ${phaseRef} (phases 로 확인).` };
      if (action === 'skip') {
        const r = skipPhase(id, phaseId);
        if (!r.ok) return { error: r.error };
        return { ok: true, missionId: id, phase: phaseTitle, unblocked: r.unblockedCount,
          note: `페이즈 건너뜀(기능 제외) "${phaseTitle}" — 후속 ${r.unblockedCount}개 언블록·순회 재개(부분 완주).` };
      }
      const r = await splitPhaseIntoSubphases(id, phaseId);
      if (!r.ok) return { error: `분할 실패: ${r.error ?? ''} (재구현/rerun 을 대신 시도)` };
      return { ok: true, missionId: id, phase: phaseTitle, subPhases: r.subTitles,
        note: `페이즈 분할 "${phaseTitle}" → ${r.subPhaseCount}개 단일책임 서브페이즈 재분해·순회 재개.` };
    }
    if (action === 'log') {
      // ★ 미션 실행 로그 리더(P5 · 2026-07-13) — O3 영속 run.log 를 tail 로 읽는다(진단 evidence 의
      //   실체 접근). READ-ONLY · 바운디드(마지막 256KB 에서 tail N줄) — 대용량 로그 안전.
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'log엔 id(apm_...) 필수.' };
      const tailN = Math.max(5, Math.min(200, Number(args.tail) || 40));
      const p = missionRunLogPath(id);
      if (!existsSync(p)) {
        return { ok: true, missionId: id, runLogPath: p, exists: false,
          note: '실행 로그 없음 — 아직 실행 전이거나(승인 대기) 구버전 실행(공유 /tmp 로그).' };
      }
      try {
        const size = statSync(p).size;
        const CAP = 256 * 1024;
        const readBytes = Math.min(size, CAP);
        const buf = Buffer.alloc(readBytes);
        const fd = openSync(p, 'r');
        try { readSync(fd, buf, 0, readBytes, size - readBytes); } finally { closeSync(fd); }
        const lines = buf.toString('utf-8').split('\n');
        const tail = lines.slice(-tailN).map((l) => l.slice(0, 400));
        return { ok: true, missionId: id, runLogPath: p, exists: true, sizeBytes: size, lines: tail,
          note: `run.log 마지막 ${tail.length}줄 (재부팅에도 영속 · 전문: ${p})` };
      } catch (e) {
        return { error: `로그 읽기 실패: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
      }
    }
    if (action === 'prepare-log') {
      // ★ 재분해(se-mission-prepare) 진행 로그 리더(대표 2026-07-13·관측성) — 조사→grounding→중복
      //   체크→분해 단계 전이를 tail 로 본다("ING만 알 수 있나" 해소). READ-ONLY·바운디드(256KB).
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'prepare-log엔 id(apm_...) 필수.' };
      const tailN = Math.max(5, Math.min(200, Number(args.tail) || 40));
      const p = missionPrepareLogPath(id);
      if (!existsSync(p)) {
        return { ok: true, missionId: id, prepareLogPath: p, exists: false,
          note: '재분해 로그 없음 — 아직 재분해 전이거나 구버전(stdio ignore 로 버려짐).' };
      }
      try {
        const size = statSync(p).size;
        const CAP = 256 * 1024;
        const readBytes = Math.min(size, CAP);
        const buf = Buffer.alloc(readBytes);
        const fd = openSync(p, 'r');
        try { readSync(fd, buf, 0, readBytes, size - readBytes); } finally { closeSync(fd); }
        const tail = buf.toString('utf-8').split('\n').slice(-tailN).map((l) => l.slice(0, 400));
        return { ok: true, missionId: id, prepareLogPath: p, exists: true, sizeBytes: size, lines: tail,
          note: `재분해 진행 로그 마지막 ${tail.length}줄 (단계: 준비→조사→grounding→중복체크→분해 · 전문: ${p})` };
      } catch (e) {
        return { error: `재분해 로그 읽기 실패: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
      }
    }
    if (action === 'pipeline') {
      // ★ 파이프라인 프레임 관측·자기인지 리더(P1/P2 · 2026-07-18) — 빌드 단계 프레임 저널을 읽어
      //   현재 STATUS(단계 ENUM·top)·스택(P1)·리플레이(P2·저장 출력 재생·집행 0)를 본다. READ-ONLY.
      //   제1원칙: 관측(프레임)+자기인지(diagnoseStack). sub=status(기본)|stack|replay. 되감기는 P3.
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'pipeline엔 id(apm_...) 필수.' };
      const sub = String(args.sub ?? 'status').trim();
      if (sub === 'critique') {
        // ★ critique 트레이스 조회(sol 입출력·오탐 진단) — frames 무관(별도 파일). --phase 로 페이즈 원문.
        const { readCritiqueTraces, readCritiqueSidecar } = await import('./pipeline/critique-trace.js');
        const all = readCritiqueTraces(id);
        if (!all.length) return { ok: true, missionId: id, exists: false,
          note: 'critique 트레이스 없음 — pipelineFrames 미설정이거나 빌드 전(구버전은 미기록).' };
        // ★ 최신 라운드만(재분해 누적 격리) — 마지막 trace 의 runId 로 필터. runId 없으면(구버전) 전체.
        const latestRun = all[all.length - 1]!.runId;
        const traces = latestRun ? all.filter((t) => t.runId === latestRun) : all;
        const phaseArg = String(args.phase ?? '').trim();
        if (phaseArg) {
          const meta = traces.find((t) => t.phaseId === phaseArg || t.phaseId.includes(phaseArg) || t.title.includes(phaseArg));
          if (!meta) return { error: `페이즈 '${phaseArg}' 트레이스 없음. --sub critique 로 목록 확인.` };
          return { ok: true, missionId: id, exists: true, mode: 'critique-detail', phase: meta, sidecar: readCritiqueSidecar(id, meta.phaseId) };
        }
        return { ok: true, missionId: id, exists: true, mode: 'critique', count: traces.length,
          round: latestRun, model: traces[0]?.model ?? '?',
          traces: traces.map((t) => ({ phaseId: t.phaseId, title: t.title, verdict: t.verdict, severity: t.severity,
            existsCount: t.existsCount, total: t.total, dropped: t.dropped, groundConfidence: t.groundConfidence,
            model: t.model, promptChars: t.promptChars, responseChars: t.responseChars })) };
      }
      if (sub === 'clarify') {
        // ★ clarify 트레이스 조회(sol 입출력·비결정성 진단) — "왜 범위 0개(clear)인가". --phase scope|arc 원문.
        const { readClarifyTraces, readClarifySidecar } = await import('./pipeline/clarify-trace.js');
        const traces = readClarifyTraces(id);
        if (!traces.length) return { ok: true, missionId: id, exists: false,
          note: 'clarify 트레이스 없음 — pipelineFrames 미설정이거나 빌드 전(구버전은 미기록).' };
        const phaseArg = String(args.phase ?? '').trim();
        if (phaseArg) {
          const m = traces.find((t) => t.phase === phaseArg);
          if (!m) return { error: `phase '${phaseArg}' 트레이스 없음(scope|arc). --sub clarify 로 목록.` };
          return { ok: true, missionId: id, exists: true, mode: 'clarify-detail', clarifyPhase: m, sidecar: readClarifySidecar(id, m.phase) };
        }
        return { ok: true, missionId: id, exists: true, mode: 'clarify', count: traces.length,
          traces: traces.map((t) => ({ phase: t.phase, count: t.count, kinds: t.kinds, heavy: t.heavy,
            fallback: t.fallback, promptChars: t.promptChars, responseChars: t.responseChars })) };
      }
      if (sub === 'rerun') {
        // ★ P4 rerun — 저장된 단계 프롬프트(critique/clarify sidecar 원문)로 LLM 재실행(모델·effort·추가지시
        //   튜닝). "이 프롬프트를 다른 모델로 돌리면?"·"이 지시를 덧붙이면 오탐이 사라지나?"를 데이터로 본다.
        //   저널 비오염(실험) — old vs new 만 비교. 제1원칙: rerun 은 LLM 집행이므로 debug.log 로 관측.
        const { planRerun, runRerunLlm } = await import('./pipeline/frame-rerun.js');
        const kind = String(args.kind ?? 'critique').trim();
        const phaseArg = String(args.phase ?? '').trim();
        if (!phaseArg) return { error: 'rerun 엔 --phase 필수 — critique=페이즈 제목 일부 / clarify=scope|arc.' };
        const tune = {
          ...(args.model ? { model: String(args.model) } : {}),
          ...(args.effort ? { effort: String(args.effort) } : {}),
          ...(args.append ? { append: String(args.append) } : {}),
        };
        if (kind === 'clarify') {
          const { readClarifySidecar } = await import('./pipeline/clarify-trace.js');
          const sc = readClarifySidecar(id, phaseArg);
          if (!sc) return { error: `clarify phase '${phaseArg}' sidecar(원문) 없음(scope|arc). --sub clarify 로 목록 확인.` };
          const plan = planRerun({ prompt: sc.prompt }, tune);
          const response = await runRerunLlm(plan);
          debug.log('mission.pipeline.rerun', 'clarify', { missionId: id, phase: phaseArg, model: plan.model, effort: plan.effort, appended: plan.appended });
          return { ok: true, missionId: id, exists: true, mode: 'rerun', kind: 'clarify', phase: phaseArg,
            model: plan.model, effort: plan.effort, appended: plan.appended,
            oldResponse: sc.response.slice(0, 1500), newResponse: response.slice(0, 1500),
            note: `clarify '${phaseArg}' 재실행(${plan.model}·effort ${plan.effort}${plan.appended ? '·추가지시' : ''}) — old vs new 응답 비교.` };
        }
        // critique(기본) — 최신 라운드 트레이스에서 페이즈 찾아 원문 sidecar 로 재실행 + verdict 재파싱 비교.
        const { readCritiqueTraces, readCritiqueSidecar } = await import('./pipeline/critique-trace.js');
        const { parsePhaseCritique } = await import('./mission-decomp-critique.js');
        const allT = readCritiqueTraces(id);
        if (!allT.length) return { ok: true, missionId: id, exists: false, note: 'critique 트레이스 없음 — pipelineFrames 미설정이거나 빌드 전.' };
        const latestRun = allT[allT.length - 1]!.runId;
        const traces = latestRun ? allT.filter((t) => t.runId === latestRun) : allT;
        const meta = traces.find((t) => t.phaseId === phaseArg || t.phaseId.includes(phaseArg) || t.title.includes(phaseArg));
        if (!meta) return { error: `critique 페이즈 '${phaseArg}' 트레이스 없음. --sub critique 로 목록 확인.` };
        const sc = readCritiqueSidecar(id, meta.phaseId);
        if (!sc) return { error: `critique 페이즈 '${meta.title}' sidecar(원문) 없음.` };
        const plan = planRerun({ prompt: sc.prompt, model: meta.model }, tune);
        const response = await runRerunLlm(plan);
        const newC = parsePhaseCritique(response, meta.phaseId, meta.title);
        debug.log('mission.pipeline.rerun', 'critique', { missionId: id, phaseId: meta.phaseId, model: plan.model, effort: plan.effort, appended: plan.appended, oldVerdict: meta.verdict, newVerdict: newC.verdict });
        return { ok: true, missionId: id, exists: true, mode: 'rerun', kind: 'critique', phase: meta.title, phaseId: meta.phaseId,
          model: plan.model, effort: plan.effort, appended: plan.appended,
          oldVerdict: meta.verdict, oldSeverity: meta.severity, newVerdict: newC.verdict, newSeverity: newC.severity,
          changed: meta.verdict !== newC.verdict, newReason: newC.reason, newConcerns: newC.concerns, newSuggestion: newC.suggestion,
          oldResponse: sc.response.slice(0, 800), newResponse: response.slice(0, 1500),
          note: `critique '${meta.title}' 재실행(${plan.model}·effort ${plan.effort}${plan.appended ? '·추가지시' : ''}) — ${meta.verdict}→${newC.verdict}${meta.verdict !== newC.verdict ? ' ★변화' : ' (동일)'}.` };
      }
      if (sub === 'exec-rewind' || sub === 'exec-goto') {
        // ★ P5 리플레이 컨트롤 — 실행 프레임 되감기(exec goto/rewind·C5 수복). build rewind/goto 의 exec
        //   미러. 타겟 이후 프레임 supersededBy 마킹 + 되감기 기록 append(역사 보존). 재실행은 executor.
        //   frame 저널(elanousStateRoot)만 쓰고 tasks.db 무접촉 → scope-guard 대상 아님. 셀프힐 관측(observe).
        const { readExecFrames, appendExecFrame } = await import('./pipeline/exec-frame-journal.js');
        const { rewindExec, gotoExecPhase } = await import('./pipeline/exec-frame-rewind.js');
        const nowIso = new Date().toISOString();
        const frames = readExecFrames(id);
        if (!frames.length) return { ok: true, missionId: id, exists: false, note: '실행 프레임 없음(실행 전이거나 저널 비어있음).' };
        // ★ H6 세대 인지 — 최신(또는 --generation) 세대 실행 프레임만 되감기(세대 혼합 방지).
        const { framesForGeneration } = await import('./pipeline/frame-generation-filter.js');
        const execGenArg = (args.generation !== undefined && String(args.generation).trim() !== '') ? Number(args.generation) : undefined;
        const scopedExec = framesForGeneration(frames, execGenArg);
        const plan = sub === 'exec-rewind'
          ? rewindExec(scopedExec, Math.max(0, Number(args.n) || 1), nowIso)
          : gotoExecPhase(scopedExec, String(args.phase ?? '').trim(), nowIso);
        if (!plan.ok) return { error: plan.reason ?? '실행 되감기 실패' };
        for (const f of plan.framesToAppend) appendExecFrame(f);
        const supersededCount = plan.framesToAppend.length - 1;
        try {
          const { observeCoordinator } = await import('./pipeline/mission-progress-ledger.js');
          observeCoordinator(sub, id, { targetPhaseId: plan.targetPhaseId, targetSeq: plan.targetSeq, superseded: supersededCount });
        } catch { /* fail-soft */ }
        // ★ UR3 재개 커서 write(2026-07-19) — 되감기 대상을 중앙 State 에 남긴다. run-mission 이 시작 시
        //   소비해 그 페이즈를 ready 로 리셋(executor 가 그 지점부터 재실행). State 가 '현재 재개 위치' 소유.
        try {
          if (plan.targetPhaseId) {
            const { assembleMissionState, persistMissionState } = await import('./pipeline/mission-state-assemble.js');
            const { applyChannelUpdates, cursorUpdate } = await import('./pipeline/mission-state-channels.js');
            const st = assembleMissionState(id);
            persistMissionState(id, applyChannelUpdates(st, [cursorUpdate({ phaseId: plan.targetPhaseId, ...(plan.targetPhaseTitle ? { phaseTitle: plan.targetPhaseTitle } : {}), reason: `${sub} → seq ${plan.targetSeq}` })]));
          }
        } catch { /* fail-soft */ }
        return { ok: true, missionId: id, exists: true, mode: 'exec-rewind', sub,
          targetPhase: plan.targetPhaseTitle, targetSeq: plan.targetSeq, superseded: supersededCount,
          note: `실행 되감기 → ${plan.targetPhaseTitle} (seq ${plan.targetSeq}) · 이후 ${supersededCount}프레임 무효화(supersededBy) · 재개 커서 기록 → 미션 재개(resume) 시 그 페이즈부터 재실행` };
      }
      if (sub === 'coordinator') {
        // ★ 조율자 단일 관측(P0~P2 통합·RFC ②) — thread(단일 thread·P0조각2)+channelVersions(P0조각3)+
        //   Progress Ledger(P2 판정) 를 한 화면에. 전과정을 하나의 조율자 뷰로 파악. READ-ONLY.
        // ★ 순수 READ — 로그 방출(logProgressLedger)은 조율자가 판정에 따라 행동하는 실행 경로(P4/
        //   run-mission·sink 등록됨)의 몫. observe 명령은 화면 출력만(부수효과 없음).
        const { summarizeMissionThread } = await import('./pipeline/mission-thread.js');
        const { evaluateMissionProgress } = await import('./pipeline/mission-progress-ledger.js');
        const summary = summarizeMissionThread(id);
        if (summary.buildFrames === 0 && summary.execFrames === 0) {
          return { ok: true, missionId: id, exists: false, note: '조율자 프레임 없음 — build/exec 저널 모두 비어있음(빌드 전).' };
        }
        // ★ 실 총 페이즈 수를 미션 스토어에서 읽어 전달(2026-07-19 dogfood 정합) — 프레임만으로는 미시작
        //   페이즈를 못 세 "1/1 satisfied" 오판. 스토어 subagent 페이즈 수가 정확한 총계. fail-soft.
        let totalPhases: number | undefined;
        try {
          const st = new TaskStore();
          try { totalPhases = st.listTasks({ goalSlug: id }).filter((t) => t.surface.kind === 'subagent').length || undefined; }
          finally { st.close(); }
        } catch { /* fail-soft — 프레임 기반 기본값 사용 */ }
        const ledger = evaluateMissionProgress(id, totalPhases !== undefined ? { totalPhases } : {});
        return { ok: true, missionId: id, exists: true, mode: 'coordinator', summary, ledger };
      }
      if (sub === 'state') {
        // ★ 중앙 MissionState read-through 관측(통합 조율 런타임 UR0·2026-07-19) — 4소스(TaskStore·
        //   exec-frame·Ledger·failures)에서 파생 조립한 조율자 중앙 State 를 한 화면에. READ-ONLY·비파괴.
        //   실행 루프 write cutover(UR1/UR2) 전, State 가 올바로 조립되는지 관측하는 단일 관문.
        const { assembleMissionState, persistMissionState } = await import('./pipeline/mission-state-assemble.js');
        const state = assembleMissionState(id);
        const phases = Array.isArray(state.phases) ? state.phases as Array<{ status: string }> : [];
        if (phases.length === 0 && (!Array.isArray(state.frames) || state.frames.length === 0)) {
          return { ok: true, missionId: id, exists: false, note: '중앙 State 조립 대상 없음 — TaskStore 페이즈·exec 프레임 모두 비어있음(빌드/실행 전).' };
        }
        if (args.persist === true) persistMissionState(id, state); // 옵션 — snapshot 저장(체크포인터 seed)
        const failures = Array.isArray(state.failures) ? state.failures : [];
        return { ok: true, missionId: id, exists: true, mode: 'state',
          phaseCount: phases.length, frameCount: Array.isArray(state.frames) ? state.frames.length : 0,
          failureCount: failures.length, progress: state.progress, state };
      }
      if (sub === 'thread') {
        // ★ 단일 thread 통합(P0 조각2) — build+exec 저널을 layer 태그로 시간순 병합해 미션 전체를 하나의
        //   thread 로. build 프레임 없어도(외부빌드 등) exec 만으로 동작하므로 readFrames 빈 체크 앞에 둔다.
        const { readMissionThread, summarizeMissionThread } = await import('./pipeline/mission-thread.js');
        const entries = readMissionThread(id);
        const summary = summarizeMissionThread(id);
        if (!entries.length) return { ok: true, missionId: id, exists: false,
          note: 'thread 프레임 없음 — build/exec 저널 모두 비어있음(빌드 전이거나 pipelineFrames 미설정).' };
        return { ok: true, missionId: id, exists: true, mode: 'thread', summary,
          thread: entries.map((e) => ({
            layer: e.layer, seq: e.seq, at: e.timestamp, label: e.label, op: e.op, status: e.status,
            ...(e.supersededBy !== undefined ? { supersededBy: e.supersededBy } : {}),
            ...(e.artifacts ? { artifacts: e.artifacts } : {}),
            ...(e.arcName ? { arcName: e.arcName } : {}),
            ...(e.arcSeq ? { arcSeq: e.arcSeq } : {}),
          })) };
      }
      const { readFrames } = await import('./pipeline/frame-journal.js');
      const { diagnoseStack, reconstructStack } = await import('./pipeline/frame-stack.js');
      const frames = readFrames(id);
      if (!frames.length) {
        return { ok: true, missionId: id, exists: false,
          note: '파이프라인 프레임 없음 — autopilot.pipelineFrames 미설정(기본 OFF)이거나 빌드 전.' };
      }
      // ★ H6 세대 인지 — replay/rewind/goto 는 세대 혼합을 피해 최신(또는 --generation 지정) 세대 프레임만
      //   재구성한다(rerun 후 gen0/gen1 이 한 파일에 쌓여도 리플레이는 한 세대). stack(관측)은 전 세대 표시.
      const { framesForGeneration, latestGeneration } = await import('./pipeline/frame-generation-filter.js');
      const genArg = (args.generation !== undefined && String(args.generation).trim() !== '') ? Number(args.generation) : undefined;
      const latestGen = latestGeneration(frames);
      const scopedFrames = framesForGeneration(frames, genArg);
      const scopedGen = genArg ?? latestGen;
      if (sub === 'stack') {
        // ★ P5 — 컨트롤러 owner 관측(via 태그 집계 + drift 감지·"이중 write 방지" 관문).
        const { detectControllerDrift } = await import('./pipeline/frame-owner.js');
        const ownership = detectControllerDrift(frames);
        return { ok: true, missionId: id, exists: true, frameCount: frames.length, latestGeneration: latestGen, ownership,
          frames: frames.map((f) => ({
            seq: f.seq, stage: f.stage, status: f.status, op: f.op, at: f.timestamp,
            ...(f.generation !== undefined ? { generation: f.generation } : {}),
            ...(f.via ? { via: f.via } : {}),
            ...(f.supersededBy !== undefined ? { supersededBy: f.supersededBy } : {}),
            hasLlm: !!f.llm,
          })) };
      }
      if (sub === 'build-fresh') {
        // ★ fresh 리셋(진짜 처음부터·2026-07-20) — re-drive(빌드 로직만·clarify/cache 재사용)와 달리 조사 캐시
        //   무효화 + clarify(범위·아크 2단계) 재발동. comment/clarified 미전달로 clarify 발동 조건 충족.
        const { spawnMissionPrepare } = await import('./mission-prepare-spawn.js');
        const logPath = spawnMissionPrepare(id, { fresh: true, forceDecompose: true });
        return { ok: true, missionId: id, mode: 'build-fresh', spawned: logPath !== null, ...(logPath ? { logPath } : {}),
          note: 'fresh 리셋 spawn — 조사 캐시 무효화·clarify(범위·아크) 재발동·research/grounding 재수집(진짜 처음부터·prepare-log 로 관측)' };
      }
      if (sub === 'build-rerun') {
        // ★ P4 re-drive — 그 단계 inputsSnapshot 을 seed 로 runBuildStages 재구동(LLM 재호출·페이즈 트랜잭셔널
        //   교체). 실 재구동은 se-mission-prepare(buildImpls 소유)를 --rerun-from 으로 spawn. 여기선 계획 검증 후 트리거.
        const fromStage = String(args.stage ?? '').trim();
        if (!fromStage) return { error: 'build-rerun 엔 --to-stage <재구동 시작 단계> 필수(예: decompose).' };
        const { planBuildRerun } = await import('./pipeline/build-rerun.js');
        const plan = planBuildRerun(scopedFrames, fromStage as import('./mission-build-coordinator.js').BuildStage);
        if (!plan.ok) return { error: `build-rerun 불가 — ${plan.reason}` };
        const runnable = plan.stages.filter((s) => s !== 'clarify');
        const { spawnMissionPrepare } = await import('./mission-prepare-spawn.js');
        const logPath = spawnMissionPrepare(id, { rerunFrom: fromStage });
        return { ok: true, missionId: id, mode: 'build-rerun', generation: scopedGen, fromStage,
          stages: runnable, spawned: logPath !== null, ...(logPath ? { logPath } : {}),
          note: `gen ${scopedGen} re-drive spawn — ${fromStage}부터 ${runnable.length}단계 재구동(LLM·페이즈 교체·prepare-log 로 진행 관측)` };
      }
      if (sub === 'replay') {
        // ★ 리플레이(P2·H6 세대 인지) — 대상 세대 저장 output 재생(LLM 0·결정론)으로 그 지점 blackboard 재구성. 집행 0.
        const { replayFrames } = await import('./pipeline/frame-replay.js');
        const toStage = args.stage ? String(args.stage).trim() as import('./mission-build-coordinator.js').BuildStage : undefined;
        const rep = replayFrames(scopedFrames, toStage ? { toStage } : {});
        return { ok: true, missionId: id, exists: true, mode: 'replay', generation: scopedGen,
          replayed: rep.replayed, skipped: rep.skipped, ...(rep.stoppedAt ? { stoppedAt: rep.stoppedAt } : {}),
          decisions: rep.blackboard.decisions,
          resultStages: Object.keys(rep.blackboard.results),
          note: `gen ${scopedGen} 재생 ${rep.replayed.length}단계(LLM 재호출 0·결정론)${rep.stoppedAt ? ` → ${rep.stoppedAt} 까지` : ''}` };
      }
      if (sub === 'rewind' || sub === 'goto') {
        // ★ 되감기(P3·셀프힐·저널 append) — 그 지점 blackboard(인자) 복원 + 이후 프레임 supersede(MESI I).
        //   프레임 저널(elanousStateRoot 스코프)만 쓰고 tasks.db 무접촉 → scope-guard 대상 아님. 재실행(LLM)은
        //   rerun(P4). 셀프힐 조작이므로 observe 관문(recordMissionObservation)에 기록(제1원칙).
        const nowIso = new Date().toISOString();
        const { rewind, gotoStage } = await import('./pipeline/frame-rewind.js');
        const { appendFrame } = await import('./pipeline/frame-journal.js');
        // ★ H6 세대 인지 — 대상 세대 프레임 내에서만 되감기(세대 경계 넘는 supersede 방지).
        const plan = sub === 'rewind'
          ? rewind(scopedFrames, Math.max(0, Number(args.n) || 1), nowIso)
          : gotoStage(scopedFrames, String(args.stage ?? '').trim() as import('./mission-build-coordinator.js').BuildStage, nowIso);
        if (!plan.ok) return { error: plan.reason ?? '되감기 실패' };
        for (const f of plan.framesToAppend) appendFrame(f);
        const supersededCount = plan.framesToAppend.length - 1;
        const { recordMissionObservation } = await import('./mission-observation.js');
        recordMissionObservation({
          missionId: id, phaseId: `pipeline:${sub}`, phaseTitle: `파이프라인 ${sub} → ${plan.targetStage}`,
          stage: 'edit', verdict: 'event', stateful: true,
          rationale: `파이프라인 ${sub === 'rewind' ? '되감기' : 'goto'} → ${plan.targetStage}(seq ${plan.targetSeq}) · 이후 ${supersededCount}프레임 supersede(재실행=rerun)`,
          refs: { sub, targetStage: plan.targetStage, targetSeq: plan.targetSeq },
        }, {});
        return { ok: true, missionId: id, mode: sub, targetStage: plan.targetStage, targetSeq: plan.targetSeq,
          superseded: supersededCount, restoredDecisions: plan.restoredBlackboard?.decisions ?? {},
          note: `${sub === 'rewind' ? '되감기' : 'goto'} → ${plan.targetStage} · 이후 ${supersededCount}프레임 무효화(재실행은 rerun·P4)` };
      }
      // status(기본) — 단계 ENUM 현재위치 + 자기인지 진단(이상판정·셀프힐 권장).
      const diag = diagnoseStack(id, frames);
      const top = reconstructStack(id, frames).top;
      return { ok: true, missionId: id, exists: true, frameCount: frames.length,
        current: diag.current, currentStatus: top?.status ?? null,
        statuses: diag.statuses, stuck: diag.stuck, superseded: diag.superseded, incomplete: diag.incomplete,
        healable: diag.healable, recommendation: diag.recommendation };
    }
    if (action === 'memory') {
      // ★ 미션 워킹 메모리 리더(P4 · 2026-07-13) — 미션이 자기 페이즈들이 지금까지 무엇을 조사·
      //   결정·재사용·산출했나를 인지(셀프 인지 질의). READ-ONLY. 조사→구현 지식 전달 갭 해소의
      //   가시화. "이 미션 지금까지 뭐 했어" 에 응답.
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'memory엔 id(apm_...) 필수.' };
      const entries = readWorkingMemory(id);
      return { ok: true, missionId: id, phaseCount: entries.length,
        entries: entries.map((e) => ({ phase: e.phaseTitle, kind: e.kind, reusables: e.reusables, decisions: e.decisions, artifacts: e.artifacts, summary: e.summary.slice(0, 200) })),
        digest: formatWorkingMemoryDigest(entries),
        note: entries.length ? `미션 워킹 메모리 ${entries.length}개 페이즈 — 각 페이즈의 재사용 경계·결정·산출.` : '워킹 메모리 비어 있음(아직 실행 전이거나 구버전 실행).' };
    }
    if (action === 'reconcile') {
      // ★ self-perception(대표 2026-07-13·방향 B) — 미션이 자기 기록(상태·PR) vs 현실(git/PR/main)
      //   을 스스로 관측해 drift 를 감지하고 자기 형상을 재인지. 외부에서 PR 을 머지/닫아도 미션이
      //   현실에 스스로 도달. 결과는 self-memory 에 provenance=reconcile 로 self-write(밖에서 해치는
      //   게 아니라 미션이 스스로 봄). READ-현실 + self-WRITE 만.
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'reconcile엔 id(apm_...) 필수.' };
      const { reconciliations, drifts } = reconcileMission(id);
      // ★ notify(대표 2026-07-13) — 외부 수습 후 미션이 스스로 재인지한 형상을 텔레그램(발신 origin =
      //   운영 봇)으로 다시 통지. "외부 수습 → self-perceive → 텔레그램도 앎"의 완결. fail-soft.
      let notified = false;
      if (args.notify) {
        try {
          const { formatReconcileCard } = await import('./mission-reconcile.js');
          const { loadMissionOrigin } = await import('./mission-origin.js');
          const { sendOutbound } = await import('../domains/outbound-alert.js');
          const store2 = openAutopilotMissionsDb(); const m = getMission(store2, id); store2.close();
          const card = formatReconcileCard(m?.goal ?? id, reconciliations);
          notified = sendOutbound(card, 'report', loadMissionOrigin(id));
        } catch { /* fail-soft */ }
      }
      return { ok: true, missionId: id, phaseCount: reconciliations.length, drifts, ...(args.notify ? { notified } : {}),
        phases: reconciliations.map((r) => ({ phase: r.phaseTitle, recordedStatus: r.recordedStatus, recordedPr: r.recordedPr, perceived: r.perceived, drift: r.drift, note: r.note })),
        note: drifts > 0
          ? `self-perception: ${drifts}건 drift 감지(기록≠현실). reconcile 엔트리로 미션이 스스로 재인지함(자기기억 provenance=reconcile).`
          : `self-perception: drift 없음 — 기록과 현실 일치.` };
    }
    if (action === 'inject') {
      // ★ 방향 A(대표 2026-07-13·하이브리드) — 외부 도구/대표가 수습 내용·가이드를 미션에 정식
      //   주입. self-memory 를 밖에서 해치는 게 아니라 provenance=external 로 태그된 기여. 옵션으로
      //   페이즈 status/PR 도 갱신(❔ 페이즈를 done 으로 체크·외부 머지 PR 링크). reconcile(방향 B·
      //   현실 관측)과 같은 장치(working memory) 공유.
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'inject엔 id(apm_...) 필수.' };
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      const reusables = parseListArg(args.reusables);
      const decisions = parseListArg(args.decisions);
      const pr = args.pr != null && String(args.pr).trim() ? Number(args.pr) : null;
      const phaseRef = args.phase != null && String(args.phase).trim() ? String(args.phase).trim() : null;
      const newStatus = typeof args.status === 'string' ? args.status.trim() : '';
      if (!note && !reusables.length && !decisions.length && !newStatus && !(typeof args.arc === 'string' && args.arc.trim())) return { error: 'inject엔 note/reusables/decisions/status/arc 중 하나 이상 필요.' };
      let phaseId = 'external-inject', phaseTitle = '외부 주입';
      let statusUpdated: string | null = null;
      if (phaseRef) {
        // 페이즈 지정 시 PR 링크/노트를 항상 phase notes 에 추가(reconcile 이 최신 PR 로 인지) + status 선택 갱신.
        const phaseNotes = [
          ...(pr ? [`[SE-PR] https://github.com/ElanvitalAI/elanous/pull/${pr} (외부 주입)`] : []),
          ...(note ? [`[EXTERNAL] ${note}`] : []),
        ];
        const upd = setPhaseStatusDirect(id, phaseRef, newStatus, phaseNotes);
        if (!upd.ok) return { error: upd.error };
        if (newStatus) statusUpdated = newStatus;
        phaseTitle = upd.title ?? phaseTitle;
        phaseId = `external:${phaseRef}`;
      }
      // ★ 외부 아크 수습(대표 2026-07-16·L3 아크판) — 외부가 아크 통합을 미션 밖(main 머지)에서
      //   완성했을 때 그 아크를 done+verified 로 정식 처리. 아크 검증기가 미션 브랜치라 external
      //   main-merge 를 못 ground → 영원히 배리어 홀드. 이 창구로 정식 해소(운영자 확인·provenance
      //   external·근거 기록). 수동 스토어 편집 대신 단일 창구(resolveArcExternal).
      const arcRef = typeof args.arc === 'string' ? args.arc.trim() : '';
      let arcResolved: string | null = null;
      let arcReuse: string[] = reusables;
      if (arcRef) {
        const { openAutopilotMissionsDb: openDb } = await import('./mission-registry.js');
        const { resolveArcExternal } = await import('./mission-arc.js');
        const mdb = openDb();
        try {
          const m = mdb.getMission(id);
          const arcs = m?.autopilot?.arcs;
          if (!arcs || arcs.length === 0) return { error: '아크 없는 미션(flat/미분해) — inject --arc 불가.' };
          const evidence = `[external${pr ? `·PR #${pr}` : ''}] ${note || '외부 아크 통합 완성(운영자 확인)'}`;
          const { arcs: next, resolved } = resolveArcExternal(arcs, arcRef, evidence);
          if (!resolved) return { error: `아크 못 찾음: "${arcRef}"(arcId·name·index). 목록: ${arcs.map((a) => a.name).join(' · ')}` };
          mdb.saveMission({ ...m, autopilot: { ...(m.autopilot ?? { origin: 'manual' }), arcs: next } });
          arcResolved = resolved.name;
          // ★ 워킹 메모리 재사용 경계(대표 2026-07-16) — 외부가 완성한 아크의 산출물을 후속 아크(소비자)
          //   가 재구현/오배선 없이 재사용하도록, 아크의 reuseBoundaries + CLI --reusables 를 합쳐
          //   워킹 메모리에 external 로 남긴다. formatWorkingMemoryForPrompt 가 다음 페이즈 프롬프트에 주입.
          arcReuse = [...(resolved.reuseBoundaries ?? []), ...reusables];
        } finally { mdb.close(); }
        coordinatorRecordMemory(id, { phaseId: `external-arc:${arcRef}`, phaseTitle: `외부 아크 수습: ${arcResolved}`,
          kind: 'operational', summary: `[external] 아크 "${arcResolved}" 통합 외부 완성 → done+verified${pr ? ` (PR #${pr})` : ''}. 후속(소비자) 아크는 이 아크 산출물을 재사용하라(재구현 금지). ${note}`.slice(0, 400),
          reusables: arcReuse, decisions, artifacts: pr ? [`PR#${pr}`] : [], provenance: 'external' });
        return { ok: true, missionId: id, injected: true, arcResolved,
          note: `외부 아크 수습 완료(provenance=external) · 아크 "${arcResolved}" → done+verified${pr ? ` · PR #${pr}` : ''}. 후속 아크 배리어 해제(다음 executor 실행이 이어감). 미션 self-cognition 반영.` };
      }
      coordinatorRecordMemory(id, { phaseId, phaseTitle, kind: 'operational',
        summary: `[external] ${note || '외부 가이드 주입'}${pr ? ` (PR #${pr})` : ''}`, reusables, decisions,
        artifacts: pr ? [`PR#${pr}`] : [], provenance: 'external' });
      return { ok: true, missionId: id, injected: true, ...(statusUpdated ? { phaseStatusUpdated: statusUpdated } : {}),
        note: `외부 주입 완료(provenance=external)${statusUpdated ? ` · 페이즈 "${phaseTitle}" → ${statusUpdated}` : ''}${pr ? ` · PR #${pr} 링크` : ''}. 미션 self-cognition 에 태그 반영.` };
    }
    if (action === 'check') {
      // ★ 슬라이스 2(대표 2026-07-13) — HITL 확인으로 페이즈 패스. 카나리 등 "사람이 도착/결과를
      //   눈으로 확인"해야 하는 페이즈는 에이전트가 검증 불가 → 대표가 확인 버튼/CLI 로 done 처리.
      //   텔레그램 "✅ 확인" 버튼(mission-hitl-callback)도 이 액션을 호출한다.
      const id = String(args.id ?? '').trim();
      const phaseRef = args.phase != null && String(args.phase).trim() ? String(args.phase).trim() : null;
      if (!id || !phaseRef) return { error: 'check엔 id(apm_...) + phase(index 또는 task id) 필수.' };
      const upd = setPhaseStatusDirect(id, phaseRef, 'done', ['[HITL-CHECK] 사람 확인 완료(수동 패스)']);
      if (!upd.ok) return { error: upd.error };
      coordinatorRecordMemory(id, { phaseId: `check:${phaseRef}`, phaseTitle: upd.title ?? '', kind: 'operational',
        summary: `[HITL-CHECK] 사람이 확인해 done 처리 — 에이전트 검증 불가 항목(카나리 도착 등)`, reusables: [], decisions: [], artifacts: [], provenance: 'external' });
      // ★ 순회 재개(대표 2026-07-14·dogfood) — check 는 페이즈를 done 처리만 하고 재spawn 이 없어
      //   (skip 은 skipPhase 가 재spawn) 마지막 페이즈를 확인하면 미션이 완료 평가·통지 없이 "실행 중"
      //   에 멈췄다(P6 확인 후 완료 메시지 미도착). skip 처럼 run-mission 재spawn 으로 후속 실행/완료
      //   통지를 잇는다. NODE_ENV=test 가드(defaultSpawnRunMission)로 테스트 안전. fail-soft.
      try { defaultSpawnRunMission(id); } catch { /* fail-soft */ }
      return { ok: true, missionId: id, checked: true, phase: upd.title,
        note: `HITL 확인 완료 — 페이즈 "${upd.title}" done. 미션 순회 재개(후속 실행·완료 시 통지).` };
    }
    if (action === 'escalate') {
      // ★ 시스템 셀프힐링 escalate(대표 2026-07-13·컴포넌트 1·2·3) — 진단이 escalate 권장한 페이즈를
      //   실제 자율 수리로 잇는다. 저장된 [SUSPECT] 신호(실패 시점 R2 모순) → R3 fresh Opus 룩백 →
      //   시스템 결함이면 system-repair 권한 수리 미션 스폰(Opus 강제·분해→HITL). 보안 경계(provenance)
      //   escalate 는 자율 수리 대상 아님 — 사람 판단 통지만. merge+데몬 재시작은 여전히 HITL.
      const id = String(args.id ?? '').trim();
      const phaseRef = args.phase != null && String(args.phase).trim() ? String(args.phase).trim() : null;
      if (!id || !phaseRef) return { error: 'escalate엔 id(apm_...) + phase(index 또는 task id) 필수.' };
      const task = resolvePhaseTask(id, phaseRef);
      if (!task) return { error: `페이즈 없음: ${phaseRef} (phases 로 확인).` };
      const signals = parseSuspectNotes(task.notes);
      debug.log('mission.escalate', 'requested', { missionId: id, phaseRef, phaseTitle: task.title, suspectSignals: signals.length });
      if (signals.length === 0) {
        // [SUSPECT] 없음 = 시스템 결함 아님. 보안 경계(provenance) escalate 면 사람 판단 통지.
        const diag = parseDiagnosisNote(task.notes);
        const boundary = diag?.failClass === 'provenance';
        debug.log('mission.escalate', boundary ? 'boundary-notice' : 'not-repairable', { missionId: id, phaseTitle: task.title, failClass: diag?.failClass ?? null });
        return { ok: true, missionId: id, escalated: true, spawned: false,
          ...(boundary ? { boundary: 'provenance' } : {}),
          note: boundary
            ? `보안 경계(provenance) escalate — 자율 수리 미대상. 사람 판단 필요(문서 명령/신뢰 경계). 페이즈 "${task.title}".`
            : `시스템 결함 모순([SUSPECT]) 미검출 — 자동 수리 대상 아님. (systemSuspect 아님 또는 구버전 실패). 재구현/분할/골정정 탈출구를 쓰세요.` };
      }
      // R3 fresh Opus 룩백(READ-ONLY) — 저장 신호가 가리키는 의심 소스를 현재 코드로 재조사.
      const origin = loadMissionOrigin(id);
      const lookback = await runSystemLookback({ phaseTitle: task.title, signals });
      const spawn = await spawnSystemRepairMission({
        sourceMissionId: id, phaseTitle: task.title, signals, report: lookback.report,
        suspectFiles: lookback.suspectFiles, origin,
      });
      if (!spawn.ok || !spawn.missionId) {
        debug.log('mission.escalate', 'spawn-failed', { missionId: id, phaseTitle: task.title, error: (spawn.error ?? '').slice(0, 200), investigated: lookback.investigated }, { level: 'error' });
        return { error: `수리 미션 스폰 실패: ${spawn.error ?? ''}` };
      }
      debug.log('mission.escalate', 'repair-spawned', { missionId: id, phaseTitle: task.title, repairMissionId: spawn.missionId, suspectSignals: signals.length, suspectFiles: lookback.suspectFiles, investigated: lookback.investigated });
      // 원 미션 워킹메모리에 escalate 기록(계보·provenance=external) — reconcile/조회가 인지.
      try {
        coordinatorRecordMemory(id, { phaseId: `escalate:${phaseRef}`, phaseTitle: task.title, kind: 'operational',
          summary: `[ESCALATE] 시스템 결함(모순 ${signals.length}건) → 수리 미션 ${spawn.missionId} 스폰(Opus·system-repair 권한)`,
          reusables: [], decisions: [`escalate→repair ${spawn.missionId}`], artifacts: [spawn.missionId], provenance: 'external' });
      } catch { /* fail-soft */ }
      return { ok: true, missionId: id, escalated: true, spawned: true, repairMissionId: spawn.missionId,
        suspectSignals: signals.length, suspectFiles: lookback.suspectFiles, investigated: lookback.investigated,
        report: lookback.report.slice(0, 600),
        note: `시스템 결함 escalate — R3 Opus 조사(${lookback.investigated ? '성공' : '폴백'}) 후 수리 미션 스폰(${spawn.missionId}·system-repair 권한·Opus 강제). 다음: 분해→HITL 승인→수리 빌드→HITL merge→데몬 재시작(HITL).` };
    }
    if (action === 'revise-suggest') {
      // ★ 미션 자율 revise 추천(대표 2026-07-14·DECIDE 다리) — 관측(working memory·reconcile·실패
      //   컨텍스트·rerunHistory) + 선택적 맥락(context)을 근거로 "골을 어떻게 정정할지"를 LLM 이 판단해
      //   정정 지시(comment) 를 생성한다. READ-ONLY(추천만·트리거 안 함). 실제 revise 는 원탭 승인 게이트
      //   (텔레그램 카드) 또는 이 결과를 revise action 에 넘겨 집행. context=자유 맥락(예: 대표 메시지).
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'revise-suggest엔 id(apm_...) 필수.' };
      let context = typeof args.context === 'string' ? args.context.trim()
        : typeof args.comment === 'string' ? args.comment.trim() : '';
      // ★ PR 자동 분해(대표 2026-07-16) — --pr 주면 시스템이 스스로 PR 내용(제목·본문·변경파일·연관
      //   RFC/PLAN 문서 발췌)을 읽어 정정 맥락에 합류(사람이 요지 요약 불요). fail-soft(gh 실패=스킵).
      const prNums = parsePrArg(args.pr);
      if (prNums.length) {
        const prCtx = fetchPrContext(prNums);
        if (prCtx) context = context ? `${context}\n\n${prCtx}` : prCtx;
      }
      const classify = process.env.NODE_ENV === 'test' ? undefined : reviseClassifyDefault;
      const { recommendation: rec, observation: obs } = await recommendRevise(
        id, context ? { userContext: context } : {}, classify ? { classify } : {},
      );
      return {
        ok: true, missionId: id,
        shouldRevise: rec.shouldRevise,
        reviseKind: rec.reviseKind,
        reviseKindLabel: reviseKindLabel(rec.reviseKind),
        comment: rec.comment,
        confidence: rec.confidence,
        rationale: rec.rationale,
        source: rec.source,
        observed: { generation: obs.currentGeneration, priorRevisions: obs.priorGoals.length, driftCount: obs.driftCount, hasFailedPhases: !!obs.executionContext.trim() },
        note: rec.shouldRevise
          ? `추천: ${reviseKindLabel(rec.reviseKind)} — comment 를 revise action 에 넘기거나 원탭 승인으로 집행(트리거 안 함·READ-ONLY).`
          : '지금 골 정정 불필요(실패 페이즈/맥락 근거 부족).',
      };
    }
    if (action === 'revise') {
      // 골 정정(3층 탈출구 상단) — 실패 맥락(어떤 페이즈가 왜 실패했나)을 코멘트에 실어 재분해.
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'revise엔 id(apm_...) 필수.' };
      let comment = typeof args.comment === 'string' ? args.comment.trim() : '';
      // ★ PR 자동 분해(대표 2026-07-16) — --pr 주면 PR 내용·연관 RFC 를 읽어 정정 지시에 합류.
      //   comment 없이 --pr 만으로도 재분해 가능(PR 이 정정 방향의 근거). fail-soft.
      const prNums = parsePrArg(args.pr);
      if (prNums.length) {
        const prCtx = fetchPrContext(prNums);
        if (prCtx) comment = comment ? `${comment}\n\n${prCtx}` : prCtx;
      }
      if (!comment) return { error: 'revise엔 comment(정정 지시 — 예: "범위축소: X 제외") 또는 --pr(PR 자동 분해) 필수.' };
      // ★ P2 revision(대표 2026-07-13·미션 생애주기) — 재분해 전 현재 골+페이즈를 스냅샷 보관(원본 이력 보존).
      try { const { archiveMissionRevision } = await import('./mission-lifecycle.js'); archiveMissionRevision(id, 'revise'); } catch { /* fail-soft */ }
      // ★ 워킹 메모리 리셋(대표 2026-07-13·비정상 경로 방어) — revise 는 골이 바뀌고 페이즈가 새 id 로
      //   재분해되므로 이전 세대의 재사용 경계·결정은 stale 오염이 된다. archive(.bak) 후 비워 fresh 시작.
      try { const { resetWorkingMemory } = await import('./mission-working-memory.js'); resetWorkingMemory(id, 'revise'); } catch { /* fail-soft */ }
      let reviseComment = comment;
      try { const ctx = buildMissionExecutionContext(id); if (ctx) reviseComment = `${comment}\n\n${ctx}`; } catch { /* fail-soft */ }
      // ★ arcHint 보존(Task#9 수복·2026-07-18) — revise 재분해가 Intake 확정 아크 수를 잃어 붕괴하던 버그.
      //   미션 레코드의 durable arcsArcHint(없으면 커밋된 arcs 수)를 읽어 spawnMissionPrepare 에 arcHint+
      //   clarified 로 전달 → clarify 재요청 없이 아크 구조 보존 재분해(축① maxTasks arc-aware 발동). 없으면 종전.
      let reviseArcHint: number | undefined;
      try {
        const mdb = openAutopilotMissionsDb(); const m = mdb.getMission(id); mdb.close();
        const ap = m?.autopilot as { arcsArcHint?: number; arcs?: unknown[] } | undefined;
        const stamped = typeof ap?.arcsArcHint === 'number' ? ap.arcsArcHint : undefined;
        const committed = Array.isArray(ap?.arcs) ? ap.arcs.length : undefined;
        const ah = stamped ?? committed;
        if (typeof ah === 'number' && ah >= 2) reviseArcHint = ah;
      } catch { /* fail-soft — arcHint 없으면 종전 동작 */ }
      // ★ clarified 는 heavy 트리거에서 comment 를 제외(se-mission-prepare:74)하므로, arcHint 경로엔
      //   forceDecompose 를 함께 줘 heavy 멀티페이즈 분해를 보장한다(clarified 가 comment→heavy 를 끊는 회귀 방지).
      try { spawnMissionPrepare(id, { comment: reviseComment, ...(reviseArcHint ? { arcHint: reviseArcHint, clarified: true, forceDecompose: true } : {}) }); }
      catch (e) { return { error: `재분해 스폰 실패: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` }; }
      // ★ 관측성(제1원칙·대표 2026-07-18) — revise 재분해 결정을 logs.db 에 남긴다(무슨 arcHint 보존·컨텍스트
      //   포함 여부·크기). 이전엔 재분해 트리거가 관측 안 돼 "왜/어떻게 재분해했나" 사후 조회 불가였다.
      debug.log('mission.revise', 'redecompose', {
        missionId: id, arcHint: reviseArcHint ?? 0, arcHintPreserved: reviseArcHint !== undefined,
        hasComment: !!comment, hasExecContext: reviseComment !== comment,
        hasPrContext: prNums.length > 0, commentChars: reviseComment.length,
      });
      return { ok: true, missionId: id, ...(reviseArcHint ? { arcHint: reviseArcHint } : {}),
        note: `골 정정·재분해 시작 — 실행 컨텍스트 포함해 se-mission-prepare 재분해${reviseArcHint ? ` (확정 ${reviseArcHint}아크 보존)` : ''}. 완료 시 새 HITL 확인 요청 발송.` };
    }
    if (action === 'add-phase') {
      // ★ P2(대표 2026-07-13·미션 생애주기) — 안착 미션에 페이즈 추가(revision 스냅샷·backlog 스택).
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'add-phase엔 id(apm_...) 필수.' };
      const title = typeof args.title === 'string' ? args.title.trim() : (typeof args.comment === 'string' ? args.comment.trim() : '');
      if (!title) return { error: 'add-phase엔 title(페이즈 제목) 필수.' };
      const { addPhaseToMission } = await import('./mission-lifecycle.js');
      const r = addPhaseToMission(id, title, typeof args.prompt === 'string' && args.prompt.trim() ? { description: args.prompt.trim() } : {});
      if (!r.ok) return { error: r.error };
      return { ok: true, missionId: id, phaseId: r.phaseId, generation: r.generation,
        note: `페이즈 추가(revision gen ${r.generation}) — backlog 로 마지막에 스택. autopilot rerun 또는 다음 실행이 집행.` };
    }
    if (action === 'pause') {
      // ★ P3(대표 2026-07-13·캐스케이드 컨트롤) — 미션 일시정지(상태 보존).
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'pause엔 id(apm_...) 필수.' };
      const { pauseMission } = await import('./mission-lifecycle.js');
      if (!pauseMission(id)) return { error: '미션 없음(apm_...)' };
      return { ok: true, missionId: id, status: 'paused', note: '미션 일시정지 — 진행 중이면 현재 페이즈 완료 후 다음에서 멈춤(상태 보존). resume 으로 재개.' };
    }
    if (action === 'resume') {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'resume엔 id(apm_...) 필수.' };
      const { resumeMission } = await import('./mission-lifecycle.js');
      if (!resumeMission(id)) return { error: '미션 없음(apm_...)' };
      return { ok: true, missionId: id, status: 'running', note: '미션 재개 — paused 해제 + run-mission 재spawn(남은 backlog 페이즈 집행).' };
    }
    if (action === 'rereflect') {
      // 비평 재반영(#3923) — [CRITIQUE] 지적이 있는 페이즈만 자동 재구현(텔레그램 버튼 동형).
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'rereflect엔 id(apm_...) 필수.' };
      const r = rebuildCritiquedPhases(id);
      if (!r.ok) return { error: r.error };
      return { ok: true, missionId: id, rebuilt: r.rebuilt, phases: r.phases,
        note: `비평 재반영 — 지적된 ${r.rebuilt} 페이즈 재구현 시작(${r.phases.slice(0, 3).join(' · ')}${r.phases.length > 3 ? ' …' : ''}) · 머지는 HITL.` };
    }
    if (action === 'trace') {
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'trace엔 id(apm_...) 필수. list로 확인.' };
      const t = traceAutopilotMission(id);
      if (!t.mission) return { error: `미션 없음: ${id} (list로 id 확인).` };
      return {
        // trace 만 description(준비 맥락 전문 — grounding 파일·보강/교정·중복) 포함 —
        // "전문은 trace" 안내의 실체(dogfood 지적: 힌트만 있고 전문이 안 보였음). list 는 요약 유지.
        mission: { ...missionSummary(t.mission), description: t.mission.description ?? null },
        rollup: t.rollup,
        ...(t.routeDecision ? { routeDecision: t.routeDecision } : {}),
        derived: t.derived.map(d => ({ kind: d.kind, name: d.name, status: d.status, detail: d.detail ?? null })),
        note: t.derived.length === 0
          ? '파생물 없음 — 아직 엔진 배선/실행 전이거나 태깅 안 됨.'
          : `파생 ${t.rollup.total} · ✅${t.rollup.ok} ⏰${t.rollup.stale} ❌${t.rollup.error} 🔵${t.rollup.active} ⏳${t.rollup.pending}`,
      };
    }
    // list
    const mdb = openAutopilotMissionsDb();
    try {
      const filter: { status?: string; source?: string } = {};
      if (typeof args.status === 'string' && args.status.trim()) filter.status = args.status.trim();
      if (typeof args.source === 'string' && args.source.trim()) filter.source = args.source.trim();
      const missions = listMissions(mdb, filter as never);
      // 헬스 롤업은 미션별 fan-in — 목록이 크면 상위 30건만 롤업(나머지는 요약만).
      const enriched = missions.slice(0, 30).map(m => missionSummary(m, traceAutopilotMission(m.id).rollup));
      const rest = missions.slice(30).map(m => missionSummary(m));
      return {
        count: missions.length,
        missions: [...enriched, ...rest],
        note: missions.length === 0 ? '오토파일럿 미션 없음(아직 골 진입 전).' : '오토파일럿 미션 목록(READ-ONLY). trace <id>로 계보 상세.',
      };
    } finally { mdb.close(); }
  } catch (e) {
    return { error: `미션 조회 실패: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
  }
}
