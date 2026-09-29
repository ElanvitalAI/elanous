#!/usr/bin/env bun
// ── Mission Fabric · 미션 준비(외부조사 보강 + 크기적응 분해 → 사람 확인) 러너 ──
// intent-gate 가 human-intent 미션에 대해 detached spawn(데몬 무차단). 흐름(대표 지시 2026-07-11):
//   1. 외부조사 보강 게이트: [조사 필요한지 판단] → 필요하면 omni-crawl 조사 → 보강/교정 추출
//      → 플랜 초안(HITL)에 append. (리서치는 플랜을 풍부하게 하는 용도로 많이 쓰인다.)
//   2. heavy(큰) 미션 → 멀티페이즈 분해(sol/medium·병목 힘빼기 2026-07-21·조사 보강 반영·backlog 페이즈+플랜 초안).
//      light(작은) 미션 → placeholder 태스크(이미 생성) + 보강만.
//   3. ★ 자동 승인 없음 — 수렴점은 항상 사람 확인(HITL). heavy 는 특히 항상 사람 게이팅.
//      사람이 확인하는 이유: AI 가 과도하게 노력했거나, defer 할 것을 판단해 새 교정이 나올 수 있어서.
//      → 미션은 planning 유지. 대표가 PWA/텔레그램에서 플랜(초안)을 보고 trim/defer/교정 후 승인.
// 수동 도그푸드: bun scripts/se-mission-prepare.ts <missionId>

import { researchAndEnrichMission } from '../src/autopilot/mission-research-gate.js';
import { groundMissionInCodebase, isImplementationGoal } from '../src/autopilot/mission-codebase-gate.js';
import { loadFreshResearch, loadFreshGrounding, saveResearchCache, saveGroundingCache } from '../src/autopilot/mission-grounding-cache.js';
import { checkMissionOverlap } from '../src/autopilot/mission-dedup.js';
import { decomposeMissionToPhases, shouldPhaseDecompose, isTransientLlmError, DECOMPOSE_MODEL, DECOMPOSE_OPUS_MODEL, resolveDecomposeEffort } from '../src/autopilot/mission-engine.js';
import { openAutopilotMissionsDb, getMission, setMissionDescription, type MissionStatus } from '../src/autopilot/mission-registry.js';
import { missionLifecycleGate } from '../src/autopilot/mission-lifecycle-gate.js';
import { TaskStore } from '../src/task-orchestrator/store.js';
import { sendOutbound } from '../src/domains/outbound-alert.js';
import { loadMissionOrigin } from '../src/autopilot/mission-origin.js';
import { notifyMissionOrigin, notifyMissionHitl, notifyMissionDocument, resolveTelegramBotToken, sendTelegramReturningId, editTelegramMessageTo } from '../src/autopilot/mission-notify.js';
import { proposalDraftPath } from '../src/autopilot/build/build-target.js';
import { applyConfigDirFlagFromArgv } from '../src/cli/config-dir-flag.js';
import { debug } from '../src/debug/log.js';
import { inferPhaseTrack, loadTrackRegistry } from '../src/autopilot/mission-phase-track.js';
import { reportDecomposeFailureHitl } from './se-mission-prepare-cause.js';

// ★ 인스턴스 스코프 상속(ISO·2026-07-14) — 부모 데몬(mission-prepare-spawn)이 argv 로 넘긴
// --config-dir 을 setElanousConfigDir 로 적용하고 argv 에서 strip. 이걸 store 열기 전에 해야
// 격리 테스트 데몬이 만든 미션을 .elanous-test/tasks/tasks.db 에서 찾는다(미적용 시 운영 스토어
// 조회 → "미션 없음" 즉사). strip 후 argv[2]=missionId 유지(플래그는 항상 뒤에 붙는다).
applyConfigDirFlagFromArgv();

// ★ D-시리즈 관측 store sink(2026-07-15 · 관측성) — se-mission-prepare 는 데몬이 detached 로 스폰한
//   별도 프로세스라 데몬의 logs.db StoreSink 를 상속하지 않는다. 등록 안 하면 분해 비평(D1
//   mission.decomp.critique)·granularity 등의 debug.log 가 prepare 파일 트레일에만 남고 logs.db 에
//   안 닿아 `elanous logs --category mission.decomp.critique` 로 조회 불가(관측 관문 무실효). run-mission
//   과 동형(run-mission.ts:242). fail-soft(실패해도 준비는 진행).
try {
  const [storeMod, dbgMod, cfgMod] = await Promise.all([
    import('../src/mss/logging/log-store.js'),
    import('../src/debug/log.js'),
    import('../src/user-config.js'),
  ]);
  const logsCfg = cfgMod.getUserConfig().logs;
  storeMod.setLogInstanceName(logsCfg.instanceName);
  const offStore = storeMod.registerLogStoreSink((s) => dbgMod.debug.registerSink(s), 'autopilot', logsCfg.retention);
  if (offStore) process.on('exit', offStore);
} catch { /* fail-soft — 파일 트레일이 진실원 */ }

const missionId = process.argv[2];
if (!missionId) { console.error('usage: bun scripts/se-mission-prepare.ts <missionId> [--force]'); process.exit(1); }
// --force = 분해 검증 마커 — 크기 무관 강제 멀티페이즈 분해(리서치 포함) + HITL 까지만.
const force = process.argv.includes('--force');
// --comment "정정 지시" — HITL 정정(프리셋/직접입력) 재분해(대표 2026-07-12). 있으면 heavy 재분해.
const commentIdx = process.argv.indexOf('--comment');
const comment = commentIdx >= 0 ? (process.argv[commentIdx + 1] ?? '').trim() : '';
// --decompose-model "<m>" — 분해 모델 override(Opus 폴백·대표 2026-07-15). 미지정=기본(gpt-5.6-sol).
const decomposeModelIdx = process.argv.indexOf('--decompose-model');
const decomposeModelOverride = decomposeModelIdx >= 0 ? (process.argv[decomposeModelIdx + 1] ?? '').trim() : '';
// --clarified = Intake Q&A 답변이 comment(확정 설계)로 이미 fold 됨(RFC-mission-intake-qa-agent).
//   이 표식이 있으면 clarify 게이트를 재발동하지 않고 바로 분해(무한 되묻기 방지).
const clarified = process.argv.includes('--clarified');
// --redesign = 골 리디자인 역제안 수용 재-spawn(H5·2026-07-20). 전제/형태 전환이라 외부조사(research)
//   캐시를 강제 무효화(옛 전제로 모은 조사가 오도)·grounding(코드)은 파일 스코프 SHA 로 유지.
const redesign = process.argv.includes('--redesign');
const reexecIntent = redesign ? 'redesign' : 'redecompose';
// --rerun-from <stage> = P4 re-drive. 저장 프레임의 그 단계 진입 blackboard(inputsSnapshot)를 seed 로
//   그 단계부터 runBuildStages 재구동(LLM 재호출·페이즈 트랜잭셔널 교체). 정상 pre/clarify/post 우회.
const rerunFromIdx = process.argv.indexOf('--rerun-from');
const rerunFromStage = rerunFromIdx >= 0 ? (process.argv[rerunFromIdx + 1] ?? '').trim() : '';
// --fresh = 진짜 처음부터 리셋(대표 2026-07-20). re-drive(빌드 로직만 재실행·clarify/cache 재사용)와 달리
//   조사 캐시를 무효화(research+grounding 재수집) + 정상 flow 로 clarify(범위·아크 2단계) 재발동. rerunFrom 무시.
const freshReset = process.argv.includes('--fresh');
if (freshReset) {
  try {
    const { invalidateGroundingCache } = await import('../src/autopilot/mission-grounding-cache.js');
    const cleared = invalidateGroundingCache(missionId);
    try { debug.log('mission.pipeline.rerun', 'fresh-reset', { missionId, cacheCleared: cleared }); } catch { /* fail-soft */ }
    console.error(`[fresh] 진짜 리셋 — 조사 캐시 무효화(${cleared ? '삭제됨' : '없음'})·clarify 재발동·research/grounding 재수집`);
  } catch (e) { console.error('[fresh] 캐시 무효화 skip(fail-soft):', e instanceof Error ? e.message : e); }
}
// --arc-hint <n> = Intake clarify 확정 아크 수(구조화 배선 2026-07-17) — decomposeMissionToPhases 로
//   구조화 전달(텍스트 파싱 의존 제거). "5아크→5페이즈" 손실 체인 근본 수복.
const arcHintIdx = process.argv.indexOf('--arc-hint');
const arcHint = arcHintIdx >= 0 ? Number(process.argv[arcHintIdx + 1]) : NaN;
let arcHintValid = Number.isFinite(arcHint) && arcHint >= 1 ? arcHint : undefined;

const db = openAutopilotMissionsDb();
const m = getMission(db, missionId);
if (!m) { console.error(`미션 없음: ${missionId}`); db.close(); process.exit(1); }
// ★ 부채 수복(2026-07-22) — prepare(재-plan)↔run-mission(실행) 상호배제. 재-plan 은 페이즈를 삭제·교체
//   하므로, run-mission 이 그 페이즈를 실행 중이면 같은 tasks.db 를 두 writer 가 갈아엎어 충돌한다
//   (2a014e dogfood: resume→run-mission 이 옛 플랜 6/8 실행 + --fresh 재분해 동시 → 레이스). run-lock
//   이 활성이면 재-plan 을 거부(rerunMission 의 isRunLockActive 가드와 대칭). fail-soft(락 확인 실패는 진행).
try {
  const { isRunLockActive } = await import('../src/autopilot/mission-run-lock.js');
  if (isRunLockActive(missionId)) {
    console.error('[mission-prepare] 거부 — 이 미션의 run-mission 이 실행 중입니다(재-plan↔실행 레이스 방지). 완료 또는 pause+중단 후 재시도.');
    db.close();
    process.exit(1);
  }
} catch { /* fail-soft — 락 확인 실패는 종전대로 진행 */ }
// ★ I3a(2026-07-16 dogfood) — clarified 재-spawn 의 comment 는 "확정 설계"지 "heavy 정정"이 아니다.
//   그래서 clarified 일 땐 comment 를 heavy 트리거에서 제외(원래 tier 존중). light 골은 clarify 후에도
//   light 로 진행(강제 분해 없음), heavy 골은 shouldPhaseDecompose 로 heavy 유지.
const heavy = force || (!!comment && !clarified) || shouldPhaseDecompose({ tier: m.tier });

// ★ 조율자 상태소유(대표 2026-07-21) — build 진입을 registry status 로 실전이(persist). 종전엔 debug.log
//   로만 남겨 ops 가 빌드 몇 분째 'proposed·승인대기'로 표시(대표: "조율자가 상태관리를 안 한다"). 이제
//   building 으로 전이하고 완료 시 이전 상태를 복원한다. 터미널(done/rejected 등)은 무접촉. crash 로 building
//   에 갇히면 다음 prepare 가 재진입(building→복원 target=proposed). non-terminal 이라 승인/sweep 불변.
const prevStatus: string = m.status || 'proposed';
const enterBuilding = prevStatus === 'proposed' || prevStatus === 'running' || prevStatus === 'building';
const restoreStatus: MissionStatus = (prevStatus === 'building' ? 'proposed' : prevStatus) as MissionStatus;
if (enterBuilding) { try { missionLifecycleGate(db, missionId, 'building', `build-start(from ${prevStatus})`); } catch { /* fail-soft */ } }
db.close();

console.error(`[mission-prepare] ${missionId} (tier=${m.tier}·heavy=${heavy}${force ? '·force 분해검증' : ''}${comment ? `·정정="${comment.slice(0, 40)}"` : ''}) 준비 시작...`);

// ★ LG1 빌드 가시화(2026-07-19) — 미션이 빌드에 진입했음을 조율자 렌즈(mission.coordinator)로 관측. 종전엔
//   빌드 중 조율자가 미션을 못 봤다(exec-frame 없음·decompose 전 assembleMissionState 빈 State·라이브 갭).
//   이제 `elanous logs --category mission.coordinator` 로 building 을 회상. 제1원칙 관측.
try { debug.log('mission.coordinator', 'lifecycle', { missionId, phase: 'building', stage: 'prepare-start', heavy, tier: m.tier }); } catch { /* fail-soft */ }

// ★ 골 분해 라이브 통지(대표 2026-07-13) — 페이즈별 진행(notifyPhaseProgress)처럼, 골 분해 단계
//   전이(준비→조사→grounding→중복→분해)를 텔레그램 메시지 1개로 계속 edit(별도 새 메시지 아님·
//   갱신). LLM 내부 스트리밍은 불투명하나 단계 진행은 실시간으로 보인다. origin(발신 채널) 텔레그램
//   일 때만·fail-soft(발송 실패해도 분해는 진행). curl 셸아웃이라 detached 프로세스에서 동작.
const progressOrigin = loadMissionOrigin(missionId);
const progressGoal = m.goal;
let progressMsgId: number | null = null;
const STEPS = ['준비', '조사보강', 'grounding', '중복체크', '분해', '완료'];
function notifyStep(stepIdx: number, detail: string): void {
  // ★ 관측 파리티(2026-07-15) — 골 분해 진척을 통합 로그 패브릭(logs.db)에도 남긴다. 종전엔 텔레그램
  //   notifier 로만 가서(아래 origin 게이트) 비-텔레그램 오퍼레이터(Claude Code·codex·PWA)는 데몬의
  //   재분해 진행을 못 봤다(제1원칙 위반 — surface 만·통합 관측 store 미도달). origin 무관하게 먼저 로깅해
  //   `elanous logs --category mission.prepare` / ops / self_recall 로 CLI·skill 파리티 확보. StoreSink 는
  //   상단에서 등록됨(detached 프로세스 sink 상속 없음 보완). fail-soft.
  try {
    debug.log('mission.prepare', STEPS[stepIdx] ?? `step-${stepIdx}`, {
      missionId, step: `${stepIdx + 1}/${STEPS.length}`, detail,
    });
  } catch { /* fail-soft — 텔레그램/파일 트레일이 백업 */ }
  if (!progressOrigin || progressOrigin.channel !== 'telegram' || progressOrigin.chatId === undefined) return;
  const token = resolveTelegramBotToken(progressOrigin.botId);
  if (!token) return;
  const bar = STEPS.map((_, i) => (i < stepIdx ? '●' : i === stepIdx ? '◉' : '○')).join('');
  const text = `🧩 골 분해 진행 ${bar} (${stepIdx + 1}/${STEPS.length})\n${progressGoal.slice(0, 60)}\n\n${detail}`;
  try {
    if (progressMsgId && progressMsgId > 0) editTelegramMessageTo(token, progressOrigin.chatId, progressMsgId, text);
    else progressMsgId = sendTelegramReturningId(token, progressOrigin.chatId, text, progressOrigin.threadId);
  } catch { /* fail-soft */ }
}
// ★ 접수 ACK(대표 2026-07-18·Task#8) — 진행 메시지(notifyStep 이 edit 로 계속 갱신)와 별개로, 최초
//   접수 시점에 독립 불변 메시지를 한 번 발송(미션 ID·상태·취소법). 진행 갱신이 이 접수 정보를 덮지 않게
//   별개 message_id 로 남긴다. clarified(Intake 재-spawn)·정정 재분해는 새 접수가 아니므로 skip(중복 방지).
//   fail-soft(발송 실패해도 분해 진행).
if (!clarified && progressOrigin && progressOrigin.channel === 'telegram' && progressOrigin.chatId !== undefined) {
  try {
    const ackToken = resolveTelegramBotToken(progressOrigin.botId);
    if (ackToken) {
      const ack = `✅ 미션 접수됨\n🆔 ${missionId}\n📋 ${progressGoal.slice(0, 80)}\n⏳ 준비 중 (조사→분해, 수 분 소요)\n취소: /mission_del ${missionId}`;
      sendTelegramReturningId(ackToken, progressOrigin.chatId, ack, progressOrigin.threadId);
    }
  } catch { /* fail-soft — 접수 ack 실패해도 분해 진행 */ }
}
notifyStep(0, `준비 시작 (tier=${m.tier}·heavy=${heavy}${comment ? '·정정 재분해' : ''})`);

// 1) 빌드 단계 실행 (BC5 전면 cutover·RFC-mission-build-coordinator §5) — 빌드 단계(research/ground/
//    dedup/shape/decompose/critique/granularity)를 orchestrator(runBuildStages)로 실행한다. config flip
//    autopilot.missionBuildCoordinator ON → coordinator(의존 병렬 그룹)·OFF(기본) → 순차(동일 impl·동일
//    결과·폴백 보존). 각 단계 로직은 impls 클로저에 담고, clarify(process.exit 제어흐름)만 선행/후행 사이
//    선형 게이트로 유지. Opus 폴백·description·카드·BC2/BC3 는 후처리로 공유(양 경로 동일).
const doGround = heavy || isImplementationGoal(m.goal);
const skipResearch = clarified; // ★ research×2 최적화 — clarified 재-spawn 은 첫 패스 조사 재사용.
let coordinatorEnabled = false;
let stuckEnabled = false;
let pipelineFramesEnabled = false;
let critiqueExistenceCap = 16; // 기본 상향(8→16·ripgrep-core 수렴으로 rg 비용 감소) — 실재 파일이 상한 밖으로 밀려 [전무] 오판 방지.
let critiqueConcurrency = 4;   // ★ 병렬 비평 동시성 캡(config·기본 4) — rate limit 방어. 1이면 순차.
let critiqueModel: string | undefined; // ★ 비평 모델(config·미설정=terra 기본) — autopilot.critiqueModel 로 sol 복귀 가능.
// ★ 증분 재분해(대표 2026-07-21·opt-in·기본 OFF) — 재분해 시 이전 분해 baseline 재사용(sol 전체 재생성→증분).
//   OFF=종전 전체 재생성(무회귀). ON=엄격 무효화(골/파일 SHA·redesign/fresh) 통과 시에만 baseline 주입.
let incrementalRedecompose = false;
try {
  const { getUserConfig } = await import('../src/user-config.js');
  const ap = getUserConfig().raw?.autopilot as { missionBuildCoordinator?: unknown; buildCoordinatorStuck?: unknown; pipelineFrames?: unknown; critiqueExistenceCap?: unknown; critiqueConcurrency?: unknown; critiqueModel?: unknown; incrementalRedecompose?: unknown } | undefined;
  incrementalRedecompose = ap?.incrementalRedecompose === true;
  coordinatorEnabled = ap?.missionBuildCoordinator === true;
  stuckEnabled = ap?.buildCoordinatorStuck === true;
  // ★ 프레임 저널 계측(P0·opt-in·기본 OFF·미설정=완전 무동작) — 각 단계를 프레임으로 남겨 관측·리플레이·되감기.
  pipelineFramesEnabled = ap?.pipelineFrames === true;
  // ★ critique 실존 검사 토큰 상한(config 오버라이드·미설정=16). 대표가 더 올리려면 autopilot.critiqueExistenceCap.
  if (typeof ap?.critiqueExistenceCap === 'number' && ap.critiqueExistenceCap > 0) critiqueExistenceCap = ap.critiqueExistenceCap;
  // ★ 병렬 비평 동시성(config·미설정=4). autopilot.critiqueConcurrency 로 조정(1=순차·rate limit 시 낮춤).
  if (typeof ap?.critiqueConcurrency === 'number' && ap.critiqueConcurrency > 0) critiqueConcurrency = ap.critiqueConcurrency;
  // ★ 비평 모델(config·미설정=terra 기본). autopilot.critiqueModel 로 sol 복귀(품질 이슈 시).
  if (typeof ap?.critiqueModel === 'string' && ap.critiqueModel) critiqueModel = ap.critiqueModel;
} catch { /* fail-soft — OFF */ }
/** 선행/후행 호출 공유 — journal gate(미설정 시 no-op·비파괴). */
const frameJournal = pipelineFramesEnabled ? { journal: { missionId } } : {};

const { runBuildStages, MissionPausedError } = await import('../src/autopilot/mission-build-orchestrate.js');

// ★ S5(실행 적응·pause) — 분해가 stage 경계에서 pause 를 인지하게 한다(좀비 분해 방지·사고 2026-07-18).
//   isMissionPaused 를 stage 게이트로 주입하고, MissionPausedError 를 잡아 관측+상태 보존 종료(exit 0).
//   완료된 stage 의 프레임은 저널에 남아 resume(--clarified 재-spawn 아닌 재분해)이 이어받는다. fail-soft.
const { isMissionPaused } = await import('../src/autopilot/mission-lifecycle.js');
const pauseCheck = (): boolean => { try { return isMissionPaused(missionId); } catch { return false; } };
async function runStagesOrHalt(
  label: string,
  opts: Parameters<typeof runBuildStages>[1],
): ReturnType<typeof runBuildStages> {
  try {
    return await runBuildStages(buildImpls, opts);
  } catch (e) {
    if (e instanceof MissionPausedError) {
      console.error(`[mission-prepare] ⏸️ pause 감지 — ${label} 분해 중단(stage=${e.stage}·상태 보존·resume 재개)`);
      try { debug.log('mission.exec.pause', 'decompose-halt', { missionId, phase: label, beforeStage: e.stage }); } catch { /* fail-soft */ }
      process.exit(0);
    }
    throw e;
  }
}

/** 분해 phase 형(비평기 입력·decompose impl 과 coevolve 루프 공유). */
type DecompPhase = { id: string; title: string; prompt: string; acceptance: string[]; dependsOn: string[] };
/** 미션 DB 에서 방금 분해된 phases 를 수집(비평 입력 + 요약 라인). decompose impl 과 P3 재분해 루프가 공유. */
function collectDecompPhases(mid: string): { decompPhases: DecompPhase[]; phaseLines: string; phaseCount: number } {
  const phases = new TaskStore();
  try {
    const t = phases.listTasks({ goalSlug: mid }).sort((a, b) => a.createdAt - b.createdAt);
    const registry = loadTrackRegistry();
    const phaseLines = t.map((x, i) => {
      const result = inferPhaseTrack(`${x.title}\n${x.surface.kind === 'subagent' ? x.surface.prompt : ''}`, registry);
      try { debug.log('mission.prepare', 'phase-track', { missionId: mid, taskId: x.id, track: result.track, reason: result.reason, hits: result.hits }); } catch { /* fail-soft */ }
      if (!registry.length) return `  ${i}. ${x.title}`;
      return result.track ? `  ${i}. ${result.mark} ${x.title}` : `  ${i}. ❔ ${x.title} (트랙 미정 → 🅢)`;
    }).slice(0, 10).join('\n');
    const decompPhases: DecompPhase[] = t.filter((x) => x.surface.kind === 'subagent').map((x) => ({
      id: x.id, title: x.title,
      prompt: x.surface.kind === 'subagent' ? x.surface.prompt : x.title,
      acceptance: x.acceptance?.criteria ? [...x.acceptance.criteria] : [],
      // ★ 사전정보(축③) — 비평기가 상류 계약 출처(dependsOn)를 알고 고립 판정 방지.
      dependsOn: [...x.dependsOn],
    }));
    return { decompPhases, phaseLines, phaseCount: decompPhases.length };
  } finally { phases.close(); }
}

// ★ RFC 은퇴(대표 2026-07-22) — RFC-preset 분해면 post-hoc 적대적 비평/coevolve 재정련을 은퇴시킨다.
//   RFC author 가 단일책임 sizing·grounding·명세를 **저작 시점에** 수행 + 결정론 conformance + HITL 승인이
//   품질게이트를 겸하므로, 추출 페이즈 재판정은 이중 판정이고 over_scope 재판정은 RFC 결정론을 defeat 한다
//   (dogfood: 의미없는 치명→재저작 3→6·scope drift). 비평/coevolve 는 LLM-decompose 폴백 경로에만 남긴다.
let missionUsedRfcPreset = false;

const buildImpls: import('../src/autopilot/mission-build-orchestrate.js').StageImpls = {
  // research + BC4 stuck(transient 드롭 예산 내 자동 재시도·대표 넘버원 ①스스로 힐링·opt-in).
  research: async () => {
    // ★ 조사 캐시(대표 2026-07-20·freshness=골+6h TTL) — 재분해마다 딥리서치 반복 방지(skipResearch 는
    //   빈값 스킵이나 이건 이전 데이터 재사용). fail-soft·골 다르면 자동 miss.
    // ★ H5 intent 규칙(Historian 단일 관문) — redesign 은 research 강제 무효(전제 전환). mayReuseResearch=false 면 캐시 skip.
    const { mayReuseResearch } = await import('../src/autopilot/lineage/intent-policy.js');
    const cachedR = mayReuseResearch(reexecIntent) ? loadFreshResearch(missionId, m.goal, Date.now()) : null;
    if (cachedR) { try { debug.log('mission.build.cache', 'research-hit', { missionId }); } catch { /* fail-soft */ } notifyStep(1, '♻️ 외부조사 캐시 재사용(골 동일·6h 이내·재조사 skip)'); return cachedR; }
    if (redesign) { try { debug.log('mission.build.cache', 'research-invalidate', { missionId, intent: 'redesign' }); } catch { /* fail-soft */ } notifyStep(1, '🔄 리디자인 — 외부조사 캐시 무효(전제 전환·재조사)'); }
    if (skipResearch) return { researched: false, enrichments: [], corrections: [], needReason: 'clarified 재-spawn — 첫 패스 조사 재사용(중복 딥리서치 skip)' };
    // ★ 조사 필요 판단 = luna(대표 2026-07-16) — heavy 여도 force 로 우회하지 않는다. "외부 웹조사가
    //   이 골을 실제로 풍부하게 하나"를 assessNeed(luna)가 판정(기존 자산 확장 = 딥리서치 낭비 방지).
    // ★ onAssess 훅(대표 2026-07-17·UX+관측) — luna 조사 필요 판단 직후 (a) 실시간 통지(낙관적 고정
    //   해소) + (b) mission.research.assess 로그(logs.db·검증된 sink 경로·"왜 조사/skip" 관측). fail-soft.
    let e = await researchAndEnrichMission(missionId, {
      onAssess: (need) => {
        notifyStep(1, need.needed
          ? '🔎 외부조사 필요 판정 — 딥리서치 중… (수 분·omni-crawl)'
          : `⏭️ 외부조사 불필요(${need.reason.slice(0, 40)}) — 내부 grounding 만`);
        try { debug.log('mission.research.assess', need.needed ? 'needed' : 'skip', { missionId, needed: need.needed, by: need.by, reason: need.reason.slice(0, 200) }); } catch { /* fail-soft */ }
      },
    });
    const err = (e as { error?: string }).error;
    if (!e.researched && err && stuckEnabled) {
      try {
        const { isTransientLlmError } = await import('../src/autopilot/mission-engine.js');
        const { classifyStuckReason, decideStuckAction } = await import('../src/autopilot/mission-build-coordinator-driver.js');
        const kind = classifyStuckReason(err, isTransientLlmError(err));
        const d = decideStuckAction(kind, 0);
        debug.log('mission.build.coordinator', `stuck-${d.action}`, { missionId, stage: 'research', kind, reason: d.reason, error: err.slice(0, 120) });
        if (d.action === 'retry') {
          notifyStep(1, '🔁 조사 일시 드롭 — 자동 재시도 중… (BC4 stuck 흡수)');
          const retry = await researchAndEnrichMission(missionId, {});
          if (retry.researched) { e = retry; debug.log('mission.build.coordinator', 'stuck-retry-absorbed', { missionId, stage: 'research', enrichments: retry.enrichments.length, corrections: retry.corrections.length }); }
          else debug.log('mission.build.coordinator', 'stuck-retry-failed', { missionId, stage: 'research', error: ((retry as { error?: string }).error)?.slice(0, 120) });
        }
      } catch (er) { console.error('[mission-prepare] BC4 stuck 처리 skip(fail-soft):', er instanceof Error ? er.message : er); }
    }
    const rResult = { researched: e.researched, enrichments: e.enrichments, corrections: e.corrections, needReason: e.needReason, error: (e as { error?: string }).error };
    try { saveResearchCache(missionId, m.goal, rResult, new Date().toISOString()); } catch { /* fail-soft */ }
    return rResult;
  },
  ground: async () => {
    if (!doGround) return { grounded: false, context: '', files: [] };
    // ★ grounding 캐시(H5·freshness=골+grounded 파일 스코프 SHA) — 그 파일들 안 바뀌면 재사용(무관 커밋 오버무효화 해소).
    const cachedG = loadFreshGrounding(missionId, m.goal);
    if (cachedG) { try { debug.log('mission.build.cache', 'ground-hit', { missionId }); } catch { /* fail-soft */ } return cachedG; }
    const g = await groundMissionInCodebase(m.goal);
    try { saveGroundingCache(missionId, m.goal, g); } catch { /* fail-soft */ }
    return g;
  },
  dedup: async () => await checkMissionOverlap(missionId),
  // shape — 골 형태 판정(A6-a·heavy·redesignLine).
  shape: async (enrichIn) => {
    if (!heavy) return { redesignLine: '' };
    let redesignLine = '';
    try {
      const { assessGoalShape, formatRedesignProposal, findSimilarMissions } = await import('../src/autopilot/mission-redesign.js');
      const researchCtx = enrichIn.researched ? [...enrichIn.enrichments, ...enrichIn.corrections].join('\n') : undefined;
      const shape = await assessGoalShape(m.goal, researchCtx ? { researchContext: researchCtx } : {});
      if (shape.verdict !== 'founded') {
        const simStore = new TaskStore();
        let similar: ReturnType<typeof findSimilarMissions> = [];
        try { similar = findSimilarMissions(simStore, m.goal, missionId); } finally { simStore.close(); }
        redesignLine = formatRedesignProposal(shape, similar);
        // ★ 관측(대표 2026-07-20) — 골 형태 판정(redesign 역제안)을 logs.db 로(종전 console.error=run.log
        //   만이라 `elanous logs` 로 조회 불가·redesign:true 근거가 관측 사각이었다). fail-soft.
        try { debug.log('mission.build.shape', shape.verdict, { missionId, reason: shape.reason.slice(0, 140), similar: similar.length }); } catch { /* fail-soft */ }
        console.error(`[mission-prepare] 🔧 골 형태 판정 → ${shape.verdict}: ${shape.reason.slice(0, 80)}`);
      }
    } catch (e) { console.error('[mission-prepare] 리디자인 판정 skip(fail-soft):', e instanceof Error ? e.message : e); }
    return { redesignLine };
  },
  // decompose — 크기적응 분해 + decompPhases 수집(store) + Opus 폴백 신호.
  decompose: async (enrichIn, groundingIn) => {
    if (!heavy) return { ok: false, phaseCount: 0, error: '', transientFailed: false, decompPhases: [], phaseLines: '' };
    notifyStep(4, '멀티페이즈 분해 중… (sol 리즈닝·조사/코드 반영) — 수 분 소요');
    const researchContext = enrichIn.researched ? [...enrichIn.enrichments.map((e) => `보강: ${e}`), ...enrichIn.corrections.map((c) => `교정: ${c}`)].join('\n') : undefined;
    // ★ E5-b 미션 간 공진화 회상(대표 2026-07-18) — 연관/계보 미션의 구현 이탈 교훈을 이 분해에 주입한다
    //   (association 은 이 impl 실행 前에 링킹됨). 없으면 무영향. 재분해(coevolve)에서도 매번 최신 반영.
    let coevolutionContext = '';
    try { const { recallCoevolutionContext } = await import('../src/autopilot/mission-coevolve-recall.js'); coevolutionContext = recallCoevolutionContext(missionId); } catch { /* fail-soft */ }
    // ★ R1b — 플랜=RFC 생성(opt-in autopilot.planAsRfc·기본 OFF·무회귀). ON 이면 discovery 재료
    //   (골+grounding+research+확정설계)로 RFC/DESIGN 문서를 저작·기록한다(R2 가 이 RFC 에서 아크/페이즈
    //   추출). 저작 실패/빈 아크는 fail-soft(기존 decompose 로 진행). RFC-plan-as-rfc-generation §6.
    let rfcPresetTasks: import('../src/task-orchestrator/generator-schema.js').ProposedTask[] | undefined;
    try {
      const { getUserConfig } = await import('../src/user-config.js');
      const planAsRfc = (getUserConfig().raw?.autopilot as { planAsRfc?: unknown } | undefined)?.planAsRfc === true;
      if (planAsRfc) {
        const { authorMissionRfc, createRfcResolver } = await import('../src/autopilot/mission-rfc-author.js');
        const { writeRfcDoc, readRfcDoc } = await import('../src/autopilot/mission-rfc-store.js');
        const { rfcToProposedTasks, checkRfcConformance } = await import('../src/autopilot/mission-rfc-extract.js');
        const { debug } = await import('../src/debug/log.js');
        const resolve = createRfcResolver(missionId);
        // ★ R3 amend — 재분해(comment=정정/실패 지시)면 기존 RFC 를 읽어 amend 모드(전면 재작성 아님·재분해=RFC 수정 단일 경로).
        const priorRfc = comment ? readRfcDoc(missionId) : null;
        const amend = !!(priorRfc && comment);
        const rfc = await authorMissionRfc({
          goal: m.goal,
          ...(groundingIn.context ? { groundingContext: groundingIn.context } : {}),
          ...(researchContext ? { researchContext } : {}),
          ...(comment && !amend ? { clarifyAnswers: comment } : {}),
          ...(m.domain ? { domainLabel: m.domain } : {}),
          ...(amend ? { priorRfc: priorRfc!, reviseReason: comment } : {}),
        }, resolve);
        const path = writeRfcDoc(missionId, rfc.markdown);
        const conf = checkRfcConformance(rfc);
        debug.log('mission.rfc', amend ? 'amended' : 'authored', { missionId, mode: amend ? 'amend' : 'author', title: rfc.title.slice(0, 80), arcs: rfc.arcs.length, phases: conf.expectedPhases, conformant: conf.conformant, openQuestions: rfc.openQuestions.length, path: path ?? null });
        // ★ #2 iterative 인터뷰(대표 2026-07-22) — RFC 가 확신 못 정한 설계 결정(openQuestions)이 있으면
        //   1회성 아니라 **재-clarify 로 재개입**한다. 답변은 다음 prepare 의 RFC amend(comment)로 반영.
        //   cap: !comment(첫 패스)만 — 재-spawn(comment 有)에선 openQuestions 남아도 진행(무한루프 방지).
        if (rfc.openQuestions.length > 0 && !comment) {
          debug.log('mission.rfc', 'open-questions', { missionId, count: rfc.openQuestions.length, questions: rfc.openQuestions.slice(0, 3) });
          try {
            const { savePendingClarify } = await import('../src/autopilot/mission-pending-clarify.js');
            const { buildClarifyMessages } = await import('../src/autopilot/mission-intake-clarify.js');
            const { hitlToken, sendTelegramButtonsTo } = await import('../src/autopilot/mission-notify.js');
            const oqClar = rfc.openQuestions.slice(0, 3).map((q, i) => ({
              questionId: `oq${i + 1}`, kind: 'scope' as const, header: 'RFC 열린질문',
              question: q.slice(0, 300),
              options: [{ label: '추천대로 자동 판단', recommended: true }, { label: '직접 입력(정정)' }],
              blocking: true,
            }));
            savePendingClarify(missionId, { clarifications: oqClar, stage: 1, goal: m.goal, heavy });
            if (progressOrigin?.channel === 'telegram' && progressOrigin.chatId !== undefined) {
              const tk = resolveTelegramBotToken(progressOrigin.botId);
              if (tk) {
                const { questions, control } = buildClarifyMessages(oqClar, hitlToken(missionId));
                for (const q of questions) { sendTelegramButtonsTo(tk, progressOrigin.chatId, q.text, q.buttons, progressOrigin.threadId); await new Promise((r) => setTimeout(r, 300)); }
                sendTelegramButtonsTo(tk, progressOrigin.chatId, control.text, control.buttons, progressOrigin.threadId);
              }
            }
            notifyStep(4, `🤔 RFC 열린질문 ${rfc.openQuestions.length}개 — 재개입(설계 확정 후 진행)`);
            db.close();
            process.exit(0); // 재개입 — 답변 콜백이 --clarified --comment 로 재-spawn → RFC amend
          } catch (e) { try { debug.log('mission.rfc', 'oq-emit-failed', { missionId, error: String(e).slice(0, 80) }); } catch { /* fail-soft */ } }
        }
        // ★ R2 — RFC 아크/작업항목을 결정론 추출해 decompose 의 presetTasks 로(LLM sizing 우회). 빈 아크면
        //   폴백(rfcPresetTasks undefined → 기존 LLM decompose·무회귀).
        if (conf.conformant) {
          rfcPresetTasks = rfcToProposedTasks(missionId, rfc);
          // ★ #1 아크는 RFC 에서 파생 — RFC 아크 수를 arcHint 로 설정해 classifyArcs 가 RFC 구조를 따르게
          //   한다(clarify arcHint 아님). arcHint 미지정 시에만(CLI 명시 우선). 아크가 RFC 이후 결정됨.
          if (rfc.arcs.length >= 1 && arcHintValid === undefined) arcHintValid = rfc.arcs.length;
        }
      }
    } catch (e) { try { const { debug } = await import('../src/debug/log.js'); debug.log('mission.rfc', 'author-failed', { missionId, error: e instanceof Error ? e.message.slice(0, 120) : String(e) }); } catch { /* fail-soft */ } }
    missionUsedRfcPreset = !!rfcPresetTasks?.length; // ★ RFC 은퇴 게이트 — preset 사용 시 critique/coevolve 스킵
    const r = await decomposeMissionToPhases(missionId, {
      ...(rfcPresetTasks?.length ? { presetTasks: rfcPresetTasks } : {}),
      maxTasks: Number(process.env.ELANOUS_DECOMPOSE_MAX || 8),
      ...(arcHintValid ? { arcHint: arcHintValid } : {}),
      ...(researchContext ? { researchContext } : {}),
      ...(groundingIn.context ? { codebaseContext: groundingIn.context } : {}),
      ...(comment ? { reviseContext: comment } : {}),
      ...(coevolutionContext ? { coevolutionContext } : {}),
      ...(decomposeModelOverride ? { decomposeModel: decomposeModelOverride } : {}),
      // ★ 증분 재분해(opt-in) — baseline 재사용/무효화 신호. mission-engine 이 엄격 판정(골·파일 SHA·redesign/fresh).
      ...(incrementalRedecompose ? { incrementalBaseline: true } : {}),
      ...(redesign ? { redesign: true } : {}),
      ...(freshReset ? { fresh: true } : {}),
      ...(groundingIn.files.length ? { groundingFiles: groundingIn.files } : {}),
      decomposeEffort: resolveDecomposeEffort(m.tier), // ★ tier 분기(heavy=medium·light=medium·병목 힘빼기 2026-07-21·seam=ELANOUS_DECOMPOSE_HEAVY_EFFORT)
    });
    const phaseCount = r.ok ? r.phaseCount : 0;
    console.error(r.ok ? `[mission-prepare] ${r.phaseCount} 페이즈 backlog · 플랜 ${r.planPath ?? '(없음)'}` : `[mission-prepare] 분해 실패: ${r.error}`);
    // ★ Opus 재시도 대상 확장(대표 2026-07-17) — 게이트웨이 오류(transient)뿐 아니라 스키마/파싱 위반
    //   (VALIDATION_FAILED·PARSE_FAILED)도 "다른/강력한 모델이면 될" 재시도 가치가 있다(sol 형식 실패 →
    //   Opus 재분해). 실측: universal-content 분해가 sol 스키마 위반으로 실패했으나 Opus 면 성공 가능.
    const errStr = r.error ?? '';
    const transientFailed = !r.ok && !decomposeModelOverride && (isTransientLlmError(errStr) || /VALIDATION_FAILED|PARSE_FAILED|schema violation/i.test(errStr));
    const { phaseLines, decompPhases } = collectDecompPhases(missionId);
    return { ok: r.ok, phaseCount, error: r.error ?? '', transientFailed, decompPhases, phaseLines };
  },
  // critique — D1 적대적 비평(heavy·decompPhases).
  critique: async (decompPhases) => {
    // ★ RFC 은퇴(대표 2026-07-22) — RFC-preset 이면 적대적 재판정 스킵. RFC author+conformance+HITL 이 품질게이트.
    if (missionUsedRfcPreset) {
      try { const { debug } = await import('../src/debug/log.js'); debug.log('mission.critique', 'skip-rfc', { missionId, reason: 'RFC-preset — 저작 시점 sizing/grounding/명세 + 결정론 conformance + HITL 승인이 품질게이트 겸함(post-hoc 적대적 비평 은퇴)' }); } catch { /* fail-soft */ }
      return { critiqueResult: null, critiqueLine: '' };
    }
    if (!heavy || !decompPhases.length) return { critiqueResult: null, critiqueLine: '' };
    let cr: unknown = null; let critiqueLine = '';
    try {
      const { critiquePhaseDecomposition, formatCritiqueForHitl } = await import('../src/autopilot/mission-decomp-critique.js');
      // ★ existenceCap(16)·concurrency(4)·critiqueModel(terra) — traceSink 기본 ON(입출력 sidecar).
      const r = await critiquePhaseDecomposition(decompPhases, { missionId, existenceCap: critiqueExistenceCap, concurrency: critiqueConcurrency, ...(critiqueModel ? { critiqueModel } : {}) });
      cr = r; critiqueLine = formatCritiqueForHitl(r);
      if (r.hasCritical) console.error(`[mission-prepare] ⚠️ 분해 비평 — 치명 ${r.critiques.filter((c) => c.severity === 'critical').length}건(빌드 前 정련 권장·HITL 카드)`);
      else console.error(`[mission-prepare] 분해 비평 → 치명 없음(${r.critiques.length} 페이즈)`);
    } catch (e) { console.error('[mission-prepare] 분해 비평 skip(fail-soft):', e instanceof Error ? e.message : e); }
    return { critiqueResult: cr, critiqueLine };
  },
  // granularity — D2 결정론 수치 게이트(heavy·decompPhases) + 아크 정합 검증(P2 decisions 소비자).
  granularity: async (decompPhases, arcHintIn) => {
    if (!heavy || !decompPhases.length) return { granularityLine: '', granularityOversizedCount: 0 };
    let granularityLine = '';
    let granularityOversizedCount = 0;
    let arcConforms: boolean | undefined;
    try {
      const { gradeDecompositionGranularity, formatGranularityForHitl, gradePhaseCompletability } = await import('../src/autopilot/mission-phase-granularity.js');
      const gr = gradeDecompositionGranularity(decompPhases);
      granularityLine = formatGranularityForHitl(gr);
      // ★ 플랜단계 sizing 집행(대표 2026-07-23) — 종전 granularity 는 too_small 만 신호(gradePhaseGranularity
      //   too_large=false 하드코딩). 완주가능 SSOT gradePhaseCompletability 로 **과대(under-decompose·페이즈가
      //   너무 큼)** 도 검출한다. synthesis 소비 이원(대표 철학 "플랜 가볍게·구현 유연"): **단일/소수 과대 →
      //   review**(구현에 위임·플랜 안 무겁게) · **다수(≥2) 과대 → narrow-redecompose**(체계적 under-decompose·
      //   e4f97b 7페이즈 붕괴형만 플랜 재분해). completability 는 텍스트 단독 too_large 금지(concerns≥3 AND
      //   acceptance≥6/제목결합 corroboration)라 2026-07-19 오탐 회귀 없음 — gross 과대만. PLAN Device 2(실집행).
      const overGrades = decompPhases.map((p) => gradePhaseCompletability(p)).filter((g) => g.verdict === 'too_large');
      granularityOversizedCount = overGrades.length;
      if (overGrades.length) {
        const line = `📐 완주가능 게이트 — 과대(재분해 권장) ${overGrades.length}개: ${overGrades.map((g) => `${g.phaseTitle.slice(0, 28)}(${g.oversizeFactors.slice(0, 2).join('·')})`).slice(0, 4).join(' / ')}`;
        granularityLine = granularityLine ? `${granularityLine}\n${line}` : line;
      }
      if (gr.tooLarge.length || gr.tooSmall.length || overGrades.length) console.error(`[mission-prepare] 📐 granularity — 과대(완주게이트) ${overGrades.length}·과소 ${gr.tooSmall.length}(결정론 게이트)`);
      // ★ 플랜 경량+정합(대표 2026-07-19) — 아크 수↔페이즈 수 정합(gradeArcConformance) 제거.
      //   arcHint 는 이제 페이즈 수 타깃이 아니라 사후 그룹핑 신호일 뿐이라(mission-engine 디커플),
      //   "5아크는 20~25페이즈여야 하는데 7뿐 → 붕괴" 판정은 오탐이 된다. arcHintIn 은 미사용(그룹핑은
      //   classifyArcs 소관). 실제 페이즈 과대/과소(gradeDecompositionGranularity)만 게이트로 유지.
      void arcHintIn;
    } catch (e) { console.error('[mission-prepare] granularity skip(fail-soft):', e instanceof Error ? e.message : e); }
    return { granularityLine, granularityOversizedCount, ...(arcConforms !== undefined ? { arcConforms } : {}) };
  },
};

// ── P4 re-drive(--rerun-from) — 저장 프레임 seed 로 그 단계부터 재구동 후 **정상 finalization 공유**(2026-07-20) ──
//   재구동 결과를 post 로, enrich/grounding/dedup 를 seed(선행 산출)에서 세팅 → 아래 finalization(HITL 카드·
//   coevolve·arc·briefing)을 정상 빌드와 동일 경로로 태운다. 정상 pre/clarify 는 우회(else). planBuildRerun
//   (순수)이 seed(그 단계 inputsSnapshot)+재실행 단계 계산. decompose=decomposeMissionToPhases 트랜잭셔널 교체.
type StagesOut = Awaited<ReturnType<typeof runStagesOrHalt>>;
let enrich: StagesOut['enrich'];
let grounding: StagesOut['grounding'];
let dedup: StagesOut['dedup'];
let post: StagesOut;
let clarifyRan = false; // BC2 shadow parity — clarify 게이트 실행·통과 여부(재구동/OFF=false). finalization 공유라 outer.
if (rerunFromStage && !freshReset) { // fresh 는 re-drive 단축 우회 → 정상 flow(clarify 재발동)
  const { readFrames } = await import('../src/autopilot/pipeline/frame-journal.js');
  const { planBuildRerun } = await import('../src/autopilot/pipeline/build-rerun.js');
  const plan = planBuildRerun(readFrames(missionId), rerunFromStage as import('../src/autopilot/mission-build-coordinator.js').BuildStage);
  if (!plan.ok) {
    console.error(`[rerun-from] re-drive 불가 — ${plan.reason}`);
    notifyStep(0, `❌ P4 re-drive 불가 — ${plan.reason}`);
    db.close(); process.exit(1);
  }
  const runnable = plan.stages.filter((s) => s !== 'clarify'); // clarify=HITL 게이트(buildImpls 무·재구동서 skip)
  notifyStep(0, `♻️ P4 re-drive — ${plan.fromStage}부터 ${runnable.length}단계 재구동(LLM·페이즈 교체)`);
  try { debug.log('mission.pipeline.rerun', 'build-redrive-start', { missionId, fromStage: plan.fromStage, stages: runnable }); } catch { /* fail-soft */ }
  post = await runStagesOrHalt(`re-drive(${plan.fromStage}~)`, { stages: runnable, seed: plan.seed, coordinator: coordinatorEnabled, ...frameJournal, pauseCheck });
  // enrich/grounding/dedup 는 seed(선행 산출)에서 추출 — finalization 이 참조(coevolve context·association 등). 없으면 빈값.
  enrich = (plan.seed.results.research?.output as StagesOut['enrich']) ?? { researched: false, enrichments: [], corrections: [], needReason: '' };
  grounding = (plan.seed.results.ground?.output as StagesOut['grounding']) ?? { grounded: false, context: '', files: [] };
  dedup = (plan.seed.results.dedup?.output as StagesOut['dedup']) ?? { ok: false, overlaps: [], comparedCount: 0 };
  try { debug.log('mission.pipeline.rerun', 'build-redrive-done', { missionId, fromStage: plan.fromStage, phaseCount: post.phaseCount ?? 0 }); } catch { /* fail-soft */ }
  console.error(`[rerun-from] 재구동 완료 — ${plan.fromStage}부터 ${runnable.length}단계 · 페이즈 ${post.phaseCount ?? 0} → finalization`);
  notifyStep(0, `✅ P4 re-drive 완료 — ${plan.fromStage}부터 재구동(페이즈 ${post.phaseCount ?? 0}) · HITL 확인 발송`);
} else {

// 선행 단계: research ∥ ground ∥ dedup (clarify 전 — clarify 가 enrich/grounding 참조).
// ★ 중립화(대표 2026-07-17·UX) — 낙관적 "외부조사 보강 중…"(luna 판단 전 고정)을 제거. luna 판단
//   직후 research impl 의 onAssess 훅이 실제 결과(딥리서치 중 / 조사 불필요·grounding만)로 갱신한다.
notifyStep(1, skipResearch
  ? '내부 grounding 중… (조사는 첫 패스 재사용·재-spawn)'
  : '조사 필요성 판단 + 내부 grounding 중… (luna·코드 검증)');
const pre = await runStagesOrHalt('선행(조사·grounding·중복)', { stages: ['research', 'ground', 'dedup'], coordinator: coordinatorEnabled, ...frameJournal, pauseCheck });
enrich = pre.enrich;
grounding = pre.grounding;
dedup = pre.dedup;
console.error(`[mission-prepare] 조사 보강 → ${enrich.researched ? `보강 ${enrich.enrichments.length}·교정 ${enrich.corrections.length}` : `조사 skip(${enrich.needReason})`}`);
console.error(`[mission-prepare] 내부 grounding → ${grounding.grounded ? `기존 파일 ${grounding.files.length}건 (재사용·확장)` : (doGround ? '관련 파일 없음' : 'skip(순수 조회)')}`);
notifyStep(2, `조사 → ${enrich.researched ? `보강 ${enrich.enrichments.length}·교정 ${enrich.corrections.length}` : `skip(${enrich.needReason})`} · grounding → ${grounding.grounded ? `기존 파일 ${grounding.files.length}건` : '없음/skip'}`);
// ★ 3-pillar RFC(build-context-exchange) — BUILD 조사(research=외부자료·ground=내부소스) 문맥을 RUN 페이즈로
//   이관(provenance='build' 워킹메모리·코디네이터 게이트 경유·일원화 정합). 종전 이 writer 가 미배선이라
//   walker/SE 의 hasBuildContext(se-bridge:217)가 항상 false 였다 → 재참조 채널 수복(재조사·재구현 방지).
//   관측(제1원칙): mission.build.context-seed(write) + 게이트 mission.coordinator.memory-record + read 측 wm-inject.
// ★ 순서 근본수정(2026-07-22 라이브 dogfood 4202bb) — build:context seed(buildContextSeedEntry) 는
//   종전 여기(PRE 단계 직후·decompose 前)서 기록됐다. 그런데 RFC-preset 판정(missionUsedRfcPreset)은
//   decompose(POST 단계·line 716)에서야 set 되므로, 여기서 게이트하면 flag=false 라 항상 recorded →
//   grounding-retire 무력(관측 실증: 4202bb recorded). ⇒ 이 seed 기록을 decompose 이후(block 2 옆·
//   flag set 뒤)로 이동해 게이트가 유효하게 한다. 비-RFC 는 어차피 block 2 가 덮어써 무회귀.
console.error(`[mission-prepare] 중복 체크 → ${dedup.ok ? (dedup.overlaps.length ? `⚠️ 중복 ${dedup.overlaps.length}건(통합 확인 필요)` : `중복 없음(비교 ${dedup.comparedCount})`) : `skip(${dedup.error ?? dedup.note})`}`);
notifyStep(3, `중복 체크 → ${dedup.ok ? (dedup.overlaps.length ? `⚠️ 중복 ${dedup.overlaps.length}건` : `없음(비교 ${dedup.comparedCount})`) : `skip`} · 빌드 실행=${coordinatorEnabled ? 'coordinator' : '순차'}`);

// 1b-clarify) ★ Intake Q&A clarify 게이트(RFC-mission-intake-qa-agent·재설계 1단계) — 분해 **전**에
//   골이 모호/과다범위면 옵션형 질문(최대3)을 텔레그램 카드로 되물어 설계를 확정한다. 확정 답변이
//   comment 로 fold 돼 재-spawn(--clarified) 되면 이 게이트를 건너뛰고 바로 분해한다.
//   ★ opt-in(config `autopilot.intakeClarify=true`·기본 OFF) — armed 아님(순수 설계·집행 0). 미설정=기존
//   일방 분해(비파괴). 블로킹 질문이 있으면 카드 발송 후 **분해 없이 종료**(콜백 재-spawn 이 이어감).
// ★ I3a — heavy 커플링 제거(2026-07-16 dogfood): 모호도는 heaviness 가 아니라 clarity 가 게이트
//   (RFC §6-①). light 골도 모호하면 되묻는다(예: 기존 미션과 병합? 별도?). arc 경계 질문만 heavy 전용
//   (light 는 단일 페이즈라 아크 무의미) — heavy 일 때만 estimatedPhases 전달, light 면 arc kind 필터.
clarifyRan = false; // (outer 선언·재초기화) BC2 shadow parity — clarify 게이트가 실제 실행·통과했나(옵트인 OFF 면 false).
if (!clarified && !comment) {
  let clarifyEnabled = false;
  // ★ 범위 fallback = opt-in(대표 결정 "스킵+MAX2" 2026-07-18) — 기본 false=scope 명확하면 arc 직행
  //   (불필요 왕복 제거). autopilot.intakeForceScopeStage=true 면 종전처럼 범위 카드 강제(2단계 예측 가능성).
  let forceScopeStage = false;
  try {
    const { getUserConfig } = await import('../src/user-config.js');
    const ap = getUserConfig().raw?.autopilot as { intakeClarify?: unknown; intakeForceScopeStage?: unknown } | undefined;
    clarifyEnabled = ap?.intakeClarify === true;
    forceScopeStage = ap?.intakeForceScopeStage === true;
  } catch { /* fail-soft — config 없으면 OFF */ }
  if (clarifyEnabled) {
    try {
      const { analyzeGoalAmbiguity, buildClarifyMessages } = await import('../src/autopilot/mission-intake-clarify.js');
      const { savePendingClarify, setClarifyControlMessage } = await import('../src/autopilot/mission-pending-clarify.js');
      const { hitlToken, sendTelegramButtonsTo, sendTelegramTo, formatArcAutoproceedNotice } = await import('../src/autopilot/mission-notify.js');
      const researchCtx = enrich.researched ? [...enrich.enrichments, ...enrich.corrections].join('\n') : undefined;
      // ★ R4 — planAsRfc 시 인터뷰를 RFC-갭 질문으로 지향(설계 결정 채우기). config opt-in.
      const planAsRfcClarify = await (async () => { try { const { getUserConfig } = await import('../src/user-config.js'); return (getUserConfig().raw?.autopilot as { planAsRfc?: unknown } | undefined)?.planAsRfc === true; } catch { return false; } })();
      const baseCtx = {
        ...(grounding.context ? { groundContext: grounding.context } : {}),
        ...(researchCtx ? { researchContext: researchCtx } : {}),
        heavy,
        forceScopeFallback: forceScopeStage, // 기본 false=skip(arc 직행)·config 로 종전 강제 복귀
        ...(planAsRfcClarify ? { planAsRfc: true } : {}),
      };
      // ★ 카드 발송 + 관측 + 종료(2단계 공용 헬퍼·RFC P3). savePendingClarify 는 호출부가 단계
      //   필드(stage/goal/heavy/priorAnswers)와 함께 먼저 저장. 발송 후 exit → 콜백이 이어감.
      const emitClarifyAndExit = async (qs: Awaited<ReturnType<typeof analyzeGoalAmbiguity>>, stageLabel: string) => {
        try {
          const { recordMissionObservation } = await import('../src/autopilot/mission-observation.js');
          recordMissionObservation({
            missionId, phaseId: 'intake', phaseTitle: `Intake Q&A ${stageLabel}`,
            stage: 'decision', verdict: 'no-op',
            rationale: `모호도 게이트(${stageLabel}) — 질문 ${qs.length}개(${qs.map((q) => q.kind).join(',')})`,
          });
        } catch { /* fail-soft */ }
        const token = hitlToken(missionId);
        const { questions, control } = buildClarifyMessages(qs, token);
        if (progressOrigin?.channel === 'telegram' && progressOrigin.chatId !== undefined) {
          const tk = resolveTelegramBotToken(progressOrigin.botId);
          if (tk) {
            // ★ I3d — 발송 간 350ms(텔레그램 rate-limit 드롭 방지).
            for (const q of questions) {
              sendTelegramButtonsTo(tk, progressOrigin.chatId, q.text, q.buttons, progressOrigin.threadId);
              await new Promise((r) => setTimeout(r, 350));
            }
            const controlId = sendTelegramButtonsTo(tk, progressOrigin.chatId, control.text, control.buttons, progressOrigin.threadId);
            if (controlId) setClarifyControlMessage(missionId, controlId);
          }
        }
        notifyStep(3, `🤔 Intake 되묻기(${stageLabel}) ${qs.length}개 — 설계 확정 대기(카드 응답 후 진행)`);
        console.error(`[mission-prepare] Intake clarify ${stageLabel} — 질문 ${qs.length}개, 보류(콜백 대기)`);
        process.exit(0); // 분해 없이 종료 — 답변 콜백이 stage 전이/재-spawn (db 는 이미 close)
      };

      // ── Stage 1: 범위확정(scope/term/safety) — RFC P3 2단계. arc 는 범위 답 이후에(순서 의존). ──
      const stage1Qs = await analyzeGoalAmbiguity(m.goal, { ...baseCtx, phase: 'scope' }, { missionId });
      if (stage1Qs.length > 0) {
        savePendingClarify(missionId, { clarifications: stage1Qs, stage: 1, goal: m.goal, heavy });
        await emitClarifyAndExit(stage1Qs, '1/2 범위');
      }
      // ── Stage 1 명확(질문 0) → Stage 2(아크) 직행(heavy 만·대표 결정: 불필요 왕복 제거). ──
      // ★ #1 아크는 RFC 이후(대표 2026-07-22 dogfood) — planAsRfc 면 arc clarify 를 건너뛴다. 아크는
      //   clarify arcHint 가 아니라 **RFC 저작에서 파생**되어야 한다(아크를 RFC 이전에 조기 결정·표시하던
      //   flow 위반 수복). scope(stage1)만 유지(RFC 설계 결정에 재료). RFC-plan-as-rfc-generation flow.
      if (heavy && !planAsRfcClarify) {
        const stage2Qs = await analyzeGoalAmbiguity(m.goal, { ...baseCtx, phase: 'arc' }, { missionId });
        if (stage2Qs.length > 0) {
          // ★ arc 자율화(대표 2026-07-21·불필요 피드백 제거·조율자 관장) — 아크수 질문이 clear single
          //   recommendation(추천 옵션 정확히 1개)이면 추천값으로 자율 진행(카드 skip). scope(stage1)만 HITL
          //   유지. "전체 추천대로 진행"을 사람 탭 없이. arcHint 는 soft(LLM classify 최종 결정)라 무회귀.
          //   CLI --arc-hint 명시 시 그 값 우선(재정의 안 함). 애매(추천 0/복수)면 종전대로 카드.
          const { decideArcAutoproceed } = await import('../src/autopilot/mission-intake-clarify.js');
          const arcDec = decideArcAutoproceed(stage2Qs, arcHintValid);
          if (arcDec.autoproceed) {
            if (arcHintValid === undefined && arcDec.arcHint !== undefined) arcHintValid = arcDec.arcHint;
            try { debug.log('mission.intake', 'autoproceed', { missionId, path: 'prepare', arcHint: arcHintValid ?? null, questions: stage2Qs.length }); } catch { /* fail-soft */ }
            // ★ 아크 자율 산정 non-blocking 알림(2026-07-21·대표 #4867 후속·투명성 갭) — 카드(HITL)는 없애되
            //   자율 채택한 아크 수를 사람에게 통지(제1원칙 — 자율 결정엔 사용자 향 관측). fail-soft(비차단).
            try {
              if (progressOrigin?.channel === 'telegram' && progressOrigin.chatId !== undefined) {
                const tk = resolveTelegramBotToken(progressOrigin.botId);
                if (tk) sendTelegramTo(tk, progressOrigin.chatId, formatArcAutoproceedNotice(arcHintValid), progressOrigin.threadId);
              }
            } catch { /* fail-soft — 알림 실패는 분해 진행 비차단 */ }
            console.error(`[mission-prepare] Intake arc 자율 진행 — 추천 아크수 ${arcHintValid ?? '(LLM 재량)'}(카드 skip·대표 불필요 피드백 제거)`);
          } else {
            savePendingClarify(missionId, { clarifications: stage2Qs, stage: 2, goal: m.goal, heavy, priorAnswers: [] });
            await emitClarifyAndExit(stage2Qs, '2/2 아크');
          }
        }
      }
      clarifyRan = true; // 게이트 실행·양단계 명확(BC2 shadow parity 실행집합 포함).
      console.error(`[mission-prepare] Intake clarify → 명확(scope/arc 질문 0) — 일방 분해 진행`);
    } catch (e) {
      console.error('[mission-prepare] Intake clarify skip(fail-soft):', e instanceof Error ? e.message : e);
    }
  }
}

// 1c~3-critique) ★ 후행 빌드 단계 (BC5) — shape ∥ decompose → critique ∥ granularity 를 orchestrator 로
//   실행. seed 로 선행(research/ground) 산출을 주입해 후행 impl 이 참조한다. heavy 아니면 빈 집합(분해
//   이후 단계 skip). shape=A6-a 골 형태·decompose=크기적응 분해+decompPhases 수집·critique=D1 적대적
//   비평·granularity=D2 결정론 게이트 — 전부 impls 클로저에 담김(선행부에서 정의). 결과는 blackboard 통일.

// ★ E5 association 엣지(미션 생태계 RFC §4.3·§4.1) — decompose **전에** 링킹한다(순서: association →
//   decompose 가 recallCoevolutionContext 로 연관 미션 이탈 교훈 회상 주입). 이 미션의 코드영역
//   (grounding.files)이 기존 미션과 교집합(Jaccard≥임계) 크면 연관 엣지를 잇는다. fail-soft·비파괴·집행0.
if (grounding.files.length) {
  try {
    const { linkMissionAssociations, parseGroundingFiles } = await import('../src/autopilot/mission-association.js');
    const { listMissions } = await import('../src/autopilot/mission-registry.js');
    const assocStore = new TaskStore();
    try {
      const others = listMissions(assocStore, { limit: 40 })
        .filter((r) => r.id !== missionId)
        .map((r) => ({ id: r.id, files: parseGroundingFiles(r.description) }))
        .filter((o) => o.files.length);
      const linked = linkMissionAssociations(missionId, grounding.files, others);
      if (linked.length) {
        debug.log('mission.graph.edge', 'association-linked', { missionId, count: linked.length, top: linked.slice(0, 3).map((l) => `${l.toId.slice(0, 30)}(${l.score.toFixed(2)})`) });
        console.error(`[mission-prepare] 🔗 연관 미션 ${linked.length}건(같은 코드영역·association 엣지)`);
      }
    } finally { assocStore.close(); }
  } catch (e) { console.error('[mission-prepare] association 링킹 skip(fail-soft):', e instanceof Error ? e.message : e); }
}

const buildSeed = {
  results: {
    research: { stage: 'research' as const, ok: true, output: enrich },
    ground: { stage: 'ground' as const, ok: true, output: grounding },
  },
  // ★ decisions 채널(P2) — Intake clarify 확정 아크 수를 조율자가 granularity 로 재전달(아크 정합 검증).
  decisions: arcHintValid !== undefined ? { arcHint: arcHintValid } : {},
};
post = await runStagesOrHalt('후행(설계·분해·비평·granularity)', {
  stages: (heavy ? ['shape', 'decompose', 'critique', 'granularity'] : []) as import('../src/autopilot/mission-build-coordinator.js').BuildStage[],
  coordinator: coordinatorEnabled,
  seed: buildSeed,
  ...frameJournal,
  pauseCheck,
});
} // ── /else (정상 pre→clarify→post) — 이하 finalization 은 정상·재구동 공유 ──
const redesignLine = post.redesignLine;
// ★ P3 자동 되먹임 — 아래 5개는 coevolve 루프가 최종 재분해 상태로 갱신(let). granularity/redesign 은 불변.
let phaseCount = post.phaseCount;
let decompPhases = post.decompPhases;
let phaseLines = post.phaseLines;
let critiqueResult = post.critiqueResult as import('../src/autopilot/mission-decomp-critique.js').DecompCritiqueResult | null;
let critiqueLine = post.critiqueLine;
const granularityLine = post.granularityLine;
const granularityOversizedCount = post.granularityOversizedCount ?? 0;

// ★ Opus 폴백 HITL(대표 2026-07-15·확장 2026-07-17) — 분해가 재시도 가치 실패(게이트웨이 오류 transient
//   OR 스키마/파싱 위반 VALIDATION_FAILED)면 유료 Opus 재분해 1탭 제안 + 진행 통지(5).
if (heavy) {
  if (post.decomposeTransientFailed) {
    const reported = reportDecomposeFailureHitl({
      decomposeError: post.decomposeError,
      model: DECOMPOSE_MODEL,
      opusModel: DECOMPOSE_OPUS_MODEL,
      notify: (text) => notifyMissionHitl(progressOrigin, missionId, text, { opusFallbackButton: true }),
    });
    notifyStep(5, `⚠️ 분해 실패(${reported.observed.label}) — Opus(유료) 폴백 승인 대기`);
  } else {
    notifyStep(5, post.decomposeOk ? `✅ ${phaseCount} 페이즈 분해 완료 — HITL 확인 요청 발송 중` : `⚠️ 분해 실패: ${post.decomposeError.slice(0, 60)}`);
  }
} else {
  notifyStep(5, '경량 미션 — 분해 없이 준비 완료(HITL 확인 발송 중)');
}

// 2z) ★ P3 자동 되먹임(RFC §3C·분해기↔비평기 공진화 폐루프) — critique 치명이면 HITL 로 곧장 위임하지
//     않고, 인루프로 K회 자동 재분해해 스스로 수렴시킨다(제1원칙: 관측툴 기반 스스로 판단·힐링 최우선).
//     opt-in autopilot.coevolveAuto(기본 OFF·비파괴·OFF=현행 BC3 수동 재분해 제안 유지). 발산 3중 방어
//     (K회 상한·단조성 불변식·kind rubric 정당성 게이트). 재분해는 decomposeMissionToPhases 트랜잭셔널
//     교체(#6)라 고아 없음. 관측(자기인지) 3박자: mission.coevolve.round(logs.db·모듈 내부)+observe 관문
//     (recordMissionObservation·미션 결정 원장)+워킹메모리 각인(재분해가 각 라운드 축B 각인·기존 배선).
if (heavy && !missionUsedRfcPreset && critiqueResult?.hasCritical) { // ★ RFC 은퇴 — preset 이면 coevolve 재정련도 미실행(critique 스킵과 defense-in-depth)
  let coevolveEnabled = false;
  let coevolveMaxRounds = 2; // 기본 2회(RFC 실측: 1라운드로 치명 15→2·2회면 충분). config 상한 4.
  try {
    const { getUserConfig } = await import('../src/user-config.js');
    const ap = getUserConfig().raw?.autopilot as { coevolveAuto?: unknown; coevolveMaxRounds?: unknown } | undefined;
    coevolveEnabled = ap?.coevolveAuto === true;
    if (typeof ap?.coevolveMaxRounds === 'number' && ap.coevolveMaxRounds >= 1) coevolveMaxRounds = Math.min(ap.coevolveMaxRounds, 4);
  } catch { /* fail-soft — config 없으면 OFF */ }
  if (coevolveEnabled) {
    try {
      const { runCoevolveLoop, countCritical } = await import('../src/autopilot/mission-coevolve-loop.js');
      const { critiquePhaseDecomposition, formatCritiqueForHitl } = await import('../src/autopilot/mission-decomp-critique.js');
      const c0 = countCritical(critiqueResult);
      notifyStep(5, `🔁 자동 정련 — critique 치명 ${c0}건 → 재분해 수렴 시도(최대 ${coevolveMaxRounds}회)`);
      // 재분해는 원 분해와 동일 컨텍스트(arcHint·조사·grounding·모델) 재사용하고 reviseContext 만 주입.
      const coResearchContext = enrich.researched ? [...enrich.enrichments.map((e) => `보강: ${e}`), ...enrich.corrections.map((c) => `교정: ${c}`)].join('\n') : undefined;
      const co = await runCoevolveLoop<DecompPhase>({
        missionId, initialCritique: critiqueResult, maxRounds: coevolveMaxRounds,
        redecompose: async (reviseContext) => {
          // ★ P2 coevolutionContext 재분해 갱신(대표 2026-07-19) — 초기 분해(R0)만 연관 미션 회상을
          //   받고 재분해(R1+)는 전혀 못 받던 갭 수복. 반복 라운드도 연관 미션 학습을 유지한다. fail-soft.
          let coCtxRe = '';
          try { const { recallCoevolutionContext } = await import('../src/autopilot/mission-coevolve-recall.js'); coCtxRe = recallCoevolutionContext(missionId); } catch { /* fail-soft */ }
          const r = await decomposeMissionToPhases(missionId, {
            maxTasks: Number(process.env.ELANOUS_DECOMPOSE_MAX || 8),
            ...(arcHintValid ? { arcHint: arcHintValid } : {}),
            ...(coResearchContext ? { researchContext: coResearchContext } : {}),
            ...(grounding.context ? { codebaseContext: grounding.context } : {}),
            ...(coCtxRe ? { coevolutionContext: coCtxRe } : {}),
            reviseContext,
            ...(decomposeModelOverride ? { decomposeModel: decomposeModelOverride } : {}),
            decomposeEffort: resolveDecomposeEffort(m.tier), // ★ P1 tier 분기(재분해도 동일 effort)
          });
          if (!r.ok || r.phaseCount === 0) return null;
          return collectDecompPhases(missionId).decompPhases;
        },
        recritique: async (phases) => critiquePhaseDecomposition(phases, { missionId, existenceCap: critiqueExistenceCap, concurrency: critiqueConcurrency, ...(critiqueModel ? { critiqueModel } : {}) }),
      });
      if (co.rounds > 0) {
        // 최종 재분해 상태로 표시/비평 갱신 — gate·BC3·발송·description 이 최신 분해를 소비.
        const collected = collectDecompPhases(missionId);
        decompPhases = collected.decompPhases;
        phaseLines = collected.phaseLines;
        phaseCount = collected.phaseCount;
        // ★ 발산 정직 표시(대표 2026-07-19) — DB 는 마지막 라운드(last)라, 발산 시엔 실행될 실제 플랜
        //   (last)의 비평을 보여준다(best 로 눈속임 금지). 아니면 best(=last)로 표시.
        const displayCritique = co.diverged ? co.lastCritique : co.finalCritique;
        critiqueResult = displayCritique;
        critiqueLine = formatCritiqueForHitl(displayCritique);
        const finalCrit = countCritical(displayCritique);
        notifyStep(5, co.converged
          ? `✅ 자동 정련 수렴 — ${co.rounds}회 만에 치명 해소(${phaseCount} 페이즈)`
          : co.diverged
            ? `⚠️ 자동 정련 발산 — ${co.rounds}회·최선 round ${co.bestRound}(치명 ${co.bestCritical}) 대비 마지막 치명 ${co.lastCritical}. 재빌드 권장(HITL)`
            : `🔁 자동 정련 ${co.rounds}회 — 치명 ${c0}→${finalCrit} 잔여(HITL 확인 요청)`);
        console.error(`[mission-prepare] 🔁 coevolve ${co.rounds}회 — 치명 ${c0}→best ${co.bestCritical}/last ${co.lastCritical}, 수렴=${co.converged}, 발산=${co.diverged}`);
        // ★ 셀프힐 결정 관문(제1원칙·observe) — 자동 정련 결과를 미션 결정 원장에 각인(자기인지).
        try {
          const { recordMissionObservation } = await import('../src/autopilot/mission-observation.js');
          recordMissionObservation({
            missionId, phaseId: 'coevolve', phaseTitle: '분해 자동 정련(공진화)', stage: 'decision',
            verdict: co.converged ? 'pass' : co.diverged ? 'stuck' : finalCrit < c0 ? 'no-op' : 'stuck',
            rationale: co.diverged
              ? `자동 재분해 ${co.rounds}회 발산 — 최선 치명 ${co.bestCritical}(round ${co.bestRound}) 대비 마지막 ${co.lastCritical}. 재빌드 권장`
              : `자동 재분해 ${co.rounds}회 — 치명 ${c0}→${finalCrit}${co.converged ? '(수렴)' : finalCrit < c0 ? '(개선·잔여 HITL)' : '(정체·HITL)'}`,
          });
        } catch { /* fail-soft */ }
      }
    } catch (e) {
      console.error('[mission-prepare] 자동 정련(coevolve) skip(fail-soft):', e instanceof Error ? e.message : e);
    }
  }
}

// 2b-N) ★ P4b — 페이즈 가치/필요성 판정(대표 2026-07-21·조율자 주도·컨텍스트 관리). 분해 직후(hot-loop 아님·
//   1회성) grounding(이미 존재하는 기존 구현/코드팩트=히스토리안 맥락) 위에서 남은 페이즈가 실행 가치 있는지
//   LLM 에이전트로 판정 → trim-satisfied/duplicate 를 **실행 전** done 마킹(랜딩된 산출물 무접촉·보수적). 705308
//   이 이미 main 에 있는 테스트 페이즈를 하나씩 재실행한 근본(가치 판정 부재) 처방. opt-in autopilot.phaseNecessityGate
//   (기본 OFF·비파괴). 관측 mission.coordinator.necessity(제1원칙). fail-soft(실패=전량 유지·무영향).
if (heavy && decompPhases.length) {
  let necessityEnabled = false;
  try { const { getUserConfig } = await import('../src/user-config.js'); necessityEnabled = (getUserConfig().raw?.autopilot as { phaseNecessityGate?: unknown } | undefined)?.phaseNecessityGate === true; } catch { /* fail-soft */ }
  if (necessityEnabled) {
    try {
      const { assessPhaseNecessity, defaultNecessityResolve, trimmablePhases } = await import('../src/autopilot/mission-phase-necessity.js');
      // landed = grounding(코드베이스 기존 구현·codeFacts·파일) — 히스토리안 맥락(이미 존재/랜딩).
      const landed: string[] = [];
      try {
        const g = loadFreshGrounding(missionId, m.goal) as { files?: string[]; context?: string; codeFacts?: string[] } | null;
        if (g?.codeFacts?.length) landed.push(...g.codeFacts.slice(0, 20).map((f) => `기존 코드: ${f}`));
        if (g?.files?.length) landed.push(...g.files.slice(0, 15).map((f) => `기존 파일: ${f}`));
        if (g?.context && landed.length === 0) landed.push(`코드베이스 맥락: ${g.context.slice(0, 500)}`);
      } catch { /* fail-soft */ }
      if (landed.length) {
        const verdicts = await assessPhaseNecessity(
          decompPhases.map((p) => ({ id: p.id, title: p.title, acceptance: p.acceptance.join('; ') })),
          { goal: m.goal, landed }, defaultNecessityResolve,
        );
        // 집행 — trim-satisfied/duplicate 만 실행 전 done 마킹(보수적·merge 는 v1 제외). 랜딩 산출물 무접촉.
        const trims = trimmablePhases(verdicts).filter((v) => v.verdict === 'trim-satisfied' || v.verdict === 'trim-duplicate');
        if (trims.length) {
          const ts = new TaskStore();
          try {
            for (const t of trims) {
              const task = ts.getTask(t.phaseId);
              if (task && task.status !== 'done') ts.saveTask({ ...task, status: 'done', notes: [...task.notes, `[NECESSITY-TRIM:${t.verdict}] ${t.reason}`.slice(0, 300)], updatedAt: Date.now() });
            }
          } finally { ts.close(); }
          notifyStep(5, `✂️ 가치판정 — ${trims.length}/${decompPhases.length} 페이즈 실행 전 트림(이미 랜딩/중복·재실행 방지)`);
          // decompPhases 도 트림 반영(후속 arc/카드가 트림된 걸 안 보게).
          const trimmed = new Set(trims.map((t) => t.phaseId));
          decompPhases = decompPhases.filter((p) => !trimmed.has(p.id));
          phaseCount = decompPhases.length;
        }
        try { debug.log('mission.coordinator.necessity', 'assessed', { missionId, total: verdicts.length, trimmed: trims.length, kept: verdicts.length - trims.length, trims: trims.map((t) => `${t.phaseId}:${t.verdict}`).slice(0, 10) }); } catch { /* fail-soft */ }
      }
    } catch { /* fail-soft — 필요성 판정 실패는 전량 유지(무영향) */ }
  }
}

// 2b) ★ build:context seed(buildContextSeedEntry 경로) — decompose 이후로 이동(2026-07-22 순서 근본수정).
//   여기서 missionUsedRfcPreset 이 확정돼(POST 단계 decompose·line 716) 그라운딩 은퇴 게이트가 유효.
//   RFC-preset 이면 skip(RFC 가 grounding 소화). 비-RFC 는 기록(아래 축2가 덮어써도 무해·skillFacts refill 보존).
try {
  const { buildContextSeedEntry } = await import('../src/autopilot/mission-build-orchestrate.js');
  let groundForSeed = grounding;   // skillFacts/codeFacts 손실 방어(revise·re-drive 경로) — 캐시서 보충. fail-soft.
  const sf = (grounding as { skillFacts?: string[] }).skillFacts;
  const cf = (grounding as { codeFacts?: string[] }).codeFacts;
  if (grounding.grounded && !sf?.length && !cf?.length) {
    try {
      const c = loadFreshGrounding(missionId, m.goal);
      if (c && ((c as { skillFacts?: string[] }).skillFacts?.length || (c as { codeFacts?: string[] }).codeFacts?.length)) {
        groundForSeed = c;
        try { debug.log('mission.build.context-seed', 'facts-refill', { missionId, from: 'grounding-cache' }); } catch { /* fail-soft */ }
      }
    } catch { /* fail-soft */ }
  }
  const seed = buildContextSeedEntry(enrich, groundForSeed);
  if (seed && missionUsedRfcPreset) {
    debug.log('mission.build.context-seed', 'skip-rfc-preset', { missionId, reason: 'RFC 가 grounding 소화·disposition-aware — 원 grounding 무력화(모순 방지)' });
  } else if (seed) {
    const { coordinatorRecordMemory } = await import('../src/autopilot/pipeline/coordinator-memory.js');
    coordinatorRecordMemory(missionId, seed);
    debug.log('mission.build.context-seed', 'recorded', { missionId, reusables: seed.reusables.length, decisions: seed.decisions.length, summaryChars: seed.summary.length });
  } else {
    debug.log('mission.build.context-seed', 'skip', { missionId, reason: 'no-research-no-ground' });
  }
} catch (e) { try { debug.log('mission.build.context-seed', 'error', { missionId, error: e instanceof Error ? e.message : String(e) }); } catch { /* fail-soft */ } }

// 2c) ★ 축2 조사문맥 이관(대표 2026-07-19) — 빌드가 탐색한 research(딥리서치 발견·교정)+grounding(재사용
//     기존 파일·코드 맥락)+dedup(중복 회피)을 미션 워킹메모리에 provenance:'build'·scope:'global' 로 seed.
//     formatWorkingMemoryForPrompt 가 global 을 모든 실행 페이즈 프롬프트에 자동 주입 → 구현이 빌드 조사를
//     통째로 받아 재조사 0(A1 같은 조사 페이즈 예산소진 실패 근본 해소·S1 스킵 자동 발동·균형을 구현으로).
// ★ 그라운딩 은퇴(RFC-preset·2026-07-22 대표) — 블록1과 동일 원리(RFC author 가 조사문맥 소화·disposition-aware
//   설계로 이미 만듦). RFC-preset 이면 disposition-blind 축2 seed 를 실행 페이즈에 다시 얹지 않는다(RFC↔grounding
//   모순 근절·a85843 phase0 앵커링 blocked 근본). RFC 가 단일 소화 소스. 비-RFC 는 종전대로(소화할 RFC 無).
if (missionUsedRfcPreset) {
  try { debug.log('mission.build.context-seed', 'skip-rfc-preset-axis2', { missionId, reason: 'RFC-preset — 원 조사문맥 grounding 무력화(모순 방지)' }); } catch { /* fail-soft */ }
} else try {
  // ★ #44 근본(대표 2026-07-21·중앙 컨트롤 복원) — 종전 이 Writer 는 appendWorkingMemory 직접 호출로
  //   coordinatorRecordMemory 단일 write 게이트를 우회 + skillFacts/codeFacts 를 decisions 에서 빠뜨렸다.
  //   Writer A(게이트·facts) 를 latest-wins dedup 으로 덮어 wm-inject decisions:0(라이브 미션 930d2d). 수정:
  //   ①게이트(coordinatorRecordMemory) 경유로 통합 ②skill/code/memory 팩트를 decisions 로 carry(grounding 이
  //   팩트 없으면 grounding 캐시 truth 에서 보충·facts-refill 동형). 게이트=아카이브 fan-out·Historian 관장 정합.
  const { coordinatorRecordMemory } = await import('../src/autopilot/pipeline/coordinator-memory.js');
  const storyParts: string[] = [];
  if (enrich.researched && enrich.enrichments.length) storyParts.push(`딥리서치 발견 ${enrich.enrichments.length}건: ${enrich.enrichments.slice(0, 6).join(' / ')}`);
  if (grounding.grounded && grounding.context) storyParts.push(`기존 코드 맥락: ${grounding.context.slice(0, 400)}`);
  let factSrc = grounding as { skillFacts?: string[]; codeFacts?: string[]; memoryFacts?: string[] };
  if (grounding.grounded && !factSrc.skillFacts?.length && !factSrc.codeFacts?.length) {
    try { const c = loadFreshGrounding(missionId, m.goal) as (typeof factSrc | null); if (c && (c.skillFacts?.length || c.codeFacts?.length)) factSrc = c; } catch { /* fail-soft */ }
  }
  const buildDecisions: string[] = [
    ...(factSrc.skillFacts ?? []).slice(0, 6),
    ...(factSrc.codeFacts ?? []).slice(0, 10),
    ...(factSrc.memoryFacts ?? []).slice(0, 6),
    ...enrich.corrections.map((c) => `교정: ${c}`),
    ...(dedup.ok && dedup.overlaps.length ? dedup.overlaps.map((o) => `중복회피: ${o.label} - ${o.consolidation}`) : []),
  ];
  // ★ P3 원문 파일화(축2 심화·대표 2026-07-19) — 요약만 seed 하면 딥리서치 상세(~85%)를 실행이 못 본다.
  //   전문을 미션 디렉토리(워킹메모리 옆)에 저장하고 artifacts 에 경로 → 실행 에이전트가 필요시 Read(진짜
  //   전체 이관). 절대경로라 SE 격리 worktree/walker 어디서든 접근. fail-soft.
  const buildArtifacts: string[] = [];
  try {
    const { missionWorkingMemoryPath } = await import('../src/autopilot/mission-working-memory.js');
    const fs = await import('node:fs'); const path = await import('node:path');
    const full = [
      enrich.researched && enrich.enrichments.length ? `## 딥리서치 발견 (${enrich.enrichments.length})\n${enrich.enrichments.map((e) => `- ${e}`).join('\n')}` : '',
      enrich.corrections.length ? `## 교정 (${enrich.corrections.length})\n${enrich.corrections.map((c) => `- ${c}`).join('\n')}` : '',
      grounding.context ? `## 기존 코드 맥락\n${grounding.context}` : '',
      dedup.ok && dedup.overlaps.length ? `## 중복 회피\n${dedup.overlaps.map((o) => `- ${o.label}: ${o.consolidation}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    if (full) {
      const p = path.join(path.dirname(missionWorkingMemoryPath(missionId)), 'build-context.md');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, full, 'utf8');
      buildArtifacts.push(p);
    }
  } catch { /* fail-soft — 요약만으로도 재조사 방지 효과는 유지 */ }
  coordinatorRecordMemory(missionId, {
    phaseId: 'build:context', phaseTitle: '빌드 조사 문맥(재조사 금지·재사용 경계)',
    kind: 'investigation',
    summary: (storyParts.join(' | ') || '빌드 조사: 신규 영역(기존 재사용 없음)') + (buildArtifacts.length ? ' | 전문: build-context.md (필요시 Read)' : ''),
    reusables: grounding.files,
    decisions: buildDecisions,
    artifacts: buildArtifacts,
    provenance: 'build',
    scope: 'global',
  });
  console.error(`[mission-prepare] 🔗 축2 조사문맥 seed(global) — 재사용파일 ${grounding.files.length}·교정 ${enrich.corrections.length}·중복 ${dedup.ok ? dedup.overlaps.length : 0} → 실행 페이즈 자동 회상(재조사 방지)`);
} catch (e) { console.error('[mission-prepare] 축2 조사문맥 seed skip(fail-soft):', e instanceof Error ? e.message : e); }

// 3a) ★ A6-b 과대골 성숙도 분리 검출(RFC §8b) — 분해가 만든 아크가 과대(heavy·아크≥3 또는 over_scope
//     preflight)면 "지금 = 성숙도 1단계·나머지 = 후속 미션" 역제안을 HITL 카드에 표면화. 자율경계(대표):
//     **검출·제안만**(자동 분리 없음). 집행은 대표 명시 트리거(elanous autopilot maturity-split --apply).
let maturityLine = '';
let arcOverviewLine = '';   // ★ A2.5 아크 구조 개요(다중 아크면 사람이 아크 분류를 보게 함)
let arcCount = 0;           // 요약 카드용 아크 수(대표 2026-07-16 요약 먼저)
let arcCompactLine = '';    // ★ 갭3(2026-07-19) — 카드에 아크별 페이즈 한눈 요약
let mirageArcs = 0;         // ★ CC1(RFC §3c) — 아크 preflight mirage(허상) 카운트
let overScopeArcs = 0;      // ★ CC1 — 아크 preflight over_scope(과대) 카운트
let arcPreflightConcerns = ''; // ★ 갭3(대표 2026-07-20) — mirage/over_scope 판정 근거(reason)를 카드/desc 에 표면화(오탐 판별용)
if (heavy) {
  const arcStore = new TaskStore();
  try {
    const arcs = arcStore.getMission(missionId)?.autopilot?.arcs;
    arcCount = (arcs ?? []).length;
    const { buildMaturityProposal, formatMaturityProposal } = await import('../src/autopilot/mission-maturity.js');
    const { formatArcOverview, formatArcCompact } = await import('../src/autopilot/mission-notify.js');
    arcOverviewLine = formatArcOverview(arcs);
    // ★ 아크 아래 상세 페이즈(대표 2026-07-19) — phaseId→제목 맵을 만들어 카드에 중첩 표시.
    const arcPhaseTitles = new Map<string, string>();
    for (const a of arcs ?? []) for (const pid of a.phaseIds) {
      const t = arcStore.getTask(pid)?.title;
      if (t) arcPhaseTitles.set(pid, t);
    }
    arcCompactLine = formatArcCompact(arcs, arcPhaseTitles);
    // ★ CC1 — 아크 preflight verdict 집계(mirage/over_scope) → 종합 제안 입력. + 갭3 사유 수집.
    const concernLines: string[] = [];
    for (const a of arcs ?? []) {
      const pv = a.preflightVerdict;
      if (pv?.verdict === 'mirage') { mirageArcs++; concernLines.push(`- ⚠️ mirage(허상 의심): ${a.name} — ${pv.reason || '(근거 없음)'}`); }
      else if (pv?.verdict === 'over_scope') { overScopeArcs++; concernLines.push(`- ⚠️ over_scope(과대): ${a.name} — ${pv.reason || '(근거 없음)'}`); }
    }
    arcPreflightConcerns = concernLines.join('\n');
    // ★ 관측(대표 2026-07-20) — 아크 preflight 집계를 logs.db 로(종전 console.error=run.log 만이라
    //   `elanous logs` 로 CC1 입력(아크수·mirage·over_scope)을 조회 불가 = 문맥관리 관측 사각). fail-soft.
    try { debug.log('mission.build.arc', 'preflight', { missionId, arcCount, mirageArcs, overScopeArcs, phaseCount }); } catch { /* fail-soft */ }
    // ★ arcHint 이탈 관측(대표 2026-07-20) — 지정≠실제를 logs.db 로(종전 무관측·대표가 이유 없이 마주침).
    if (arcHintValid && arcHintValid >= 2 && arcCount && arcCount !== arcHintValid) {
      try { debug.log('mission.build.arc', 'hint-deviation', { missionId, arcHint: arcHintValid, arcCount }); } catch { /* fail-soft */ }
    }
    if (arcOverviewLine) console.error(`[mission-prepare] ⬡ 다중 아크 구조 — ${(arcs ?? []).length}개 아크(HITL 카드에 개요 노출)`);
    const proposal = buildMaturityProposal(arcs, m.tier as 'light' | 'heavy');
    if (proposal.oversized) {
      maturityLine = formatMaturityProposal(proposal);
      console.error(`[mission-prepare] ⚠️ 과대 미션 검출 — 성숙도 분리 권장(후속 ${proposal.followups.length}·${proposal.reason})`);
    }
  } catch (e) { console.error('[mission-prepare] 아크 개요/성숙도 검출 skip(fail-soft):', e instanceof Error ? e.message : e); }
  finally { arcStore.close(); }
}

// ★ CC1(RFC-general-coordinator-custom-contracts §3c) — 골분해 파편 신호(역제안·비평·granularity·
//   성숙도·아크 preflight)를 단일 스마트 제안으로 종합. description·카드 공용. 순수·결정론(LLM 후속).
// ★ CC1b(대표 2026-07-20) — gate verdict 를 synthesis 앞으로 끌어올려 CC1 종합에 포함. gate 는 매 재분해
//   정당한 revise/reject(예: "아크 내 병렬인데 Task 선행 의존성 충돌")를 내는데, 종전 synthesis 뒤(아래
//   발송 블록:834)에서 호출돼 CC1 종합에서 빠졌다 → gate 버튼(🚦)과 CC1 카드(🧠)가 분리. 여기서 gate 를
//   1회 계산하고 아래 부수효과 블록(834)이 이 결과를 재사용(중복 호출 없음·발송/재분해 로직 불변 = 순서
//   재배치 리스크 최소). fail-soft(에이전트 실패 = decompGate undefined·synthesis 는 gateVerdict 없이 진행).
let decompGate: import('../src/autopilot/mission-decomp-gate.js').DecompGateResult | undefined;
try {
  const { getUserConfig } = await import('../src/user-config.js');
  const gateOn = (getUserConfig().raw?.autopilot as { decompGate?: unknown } | undefined)?.decompGate === true;
  if (gateOn && heavy && decompPhases.length) {
    const { gateDecomposition } = await import('../src/autopilot/mission-decomp-gate.js');
    const researchCtx = enrich.researched ? [...enrich.enrichments, ...enrich.corrections].join('\n') : undefined;
    decompGate = await gateDecomposition(decompPhases, {
      goal: m.goal,
      ...(clarified && comment ? { confirmedDesign: comment } : {}),
      ...(arcOverviewLine ? { arcs: [arcOverviewLine] } : {}),
      ...(grounding.files.length ? { groundingFiles: grounding.files } : {}),
      ...(researchCtx ? { research: researchCtx } : {}),
    });
    debug.log('mission.decomp.gate', decompGate.verdict, { missionId, reason: decompGate.reason.slice(0, 120), phases: decompPhases.length });
  }
} catch { /* fail-soft — gate 없음·synthesis 는 gateVerdict 없이 종합 */ }

const { synthesizeDecomposition } = await import('../src/autopilot/mission-decompose-synthesis.js');
const decomposeSynthesis = synthesizeDecomposition({
  ...(decompGate ? { gateVerdict: decompGate.verdict } : {}), // ★ CC1b — gate 판정을 CC1 종합에 포함
  redesign: !!redesignLine,
  criticalCritique: critiqueResult?.hasCritical ? 1 : 0,
  granularityOversized: !!granularityLine,
  granularityOversizedCount, // ★ 다수(≥2) 과대 → narrow-redecompose(체계적 under-decompose·대표 2026-07-23)
  maturityOversized: !!maturityLine,
  mirageArcs, overScopeArcs, arcCount, phaseCount,
});
// ★ 관측(대표 2026-07-20) — CC1 종합 verdict 를 logs.db 로. 종전 이 판단은 description·카드에 쓰이기만
//   하고 계측이 0 이라 `elanous logs --grep synthesis` 가 빈 결과 = CC1 판단 자체가 관측 사각이었다. fail-soft.
try {
  // ★ 압축(대표 2026-07-20) — debug.log payload 400자 상한(log.ts:640)에 긴 missionId+풀키면 뒷필드
  //   (crit 등)이 잘렸다. event=recommendation(조회 시 approve/review/redesign 즉시 식별)·짧은 키로 전
  //   필드가 400자 안에 들어오게. mid=미션 꼬리 14자(식별 충분).
  debug.log('mission.build.synthesis', decomposeSynthesis.recommendation, {
    mid: missionId.slice(-14), adv: decomposeSynthesis.advisoryCount,
    act: decomposeSynthesis.recommendedAction, defer: decomposeSynthesis.deferToBuild, // ★ 조율 UX(2방향·구현서 수습)
    gate: decompGate?.verdict ?? 'off', // ★ CC1b — gate 종합 관측(종전 synthesis 에서 빠져 있던 축)
    mir: mirageArcs, ovr: overScopeArcs, arcs: arcCount, phs: phaseCount,
    rds: !!redesignLine, crit: critiqueResult?.hasCritical ? 1 : 0,
    gran: !!granularityLine, mat: !!maturityLine,
  });
} catch { /* fail-soft */ }

// 3b) ★ 미션 레코드 description 에 준비 맥락 저장(대표 2026-07-12) — 외부조사(보강/교정)·분해·
//     중복을 goal 한 줄 너머로 보존해 이후 회상/추적/재실행에 근거 제공. 텔레그램 요약(truncate)과
//     달리 전문. fail-soft(발송/준비를 막지 않음).
const descParts: string[] = [
  `골: ${m.goal}`,
  `분류: tier=${m.tier} · heavy=${heavy}${force ? ' · force 분해검증' : ''}`,
];
// ★ CC1 — 종합 스마트 제안을 파편 나열 위에 단일 판단으로(approve 면 생략·무경고 정상).
if (decomposeSynthesis.recommendation !== 'approve') {
  descParts.push('', '## 골분해 종합 제안 (CC1·스마트 판단)', decomposeSynthesis.headline,
    ...decomposeSynthesis.reasons.map((r) => `- ${r}`));
}
// ★ I3a — Intake 확정 설계 반영(되묻기 답변). heavy 는 분해 reviseContext 로도 흐르지만, light 는
//   분해가 없어 description 이 유일한 반영처(예: "기존 미션과 병합" 결정을 미션 상세에 남긴다).
if (clarified && comment) descParts.push('', '## Intake 확정 설계 (되묻기 답변 반영)', comment);
if (heavy && phaseLines) descParts.push('', `## 분해 (${phaseCount} 페이즈)`, phaseLines);
if (arcOverviewLine) descParts.push('', '## 아크 구조 (A2.5)', arcOverviewLine);
// ★ 갭3(대표 2026-07-20) — mirage/over_scope 판정 근거를 표면화(종전 카드엔 ⚠️플래그만·근거는 logs.db
//   에만 있어 대표가 오탐 판별 불가). 갭4 오탐가드로 미구현 오탐은 이미 강등 → 여기 남는 건 정당한 의심.
if (arcPreflightConcerns) descParts.push('', '## 아크 preflight 판정 근거 (허상/과대·오탐 판별용)', arcPreflightConcerns);
if (granularityLine) descParts.push('', '## 분해 granularity (D2·결정론 게이트)', granularityLine);
if (critiqueLine) descParts.push('', '## 분해 비평 (D1·빌드 前 정련 권장)', critiqueLine);
if (enrich.researched) {
  descParts.push('', `## 외부조사 (보강 ${enrich.enrichments.length} · 교정 ${enrich.corrections.length})`);
  for (const e of enrich.enrichments) descParts.push(`- 보강: ${e}`);
  for (const c of enrich.corrections) descParts.push(`- 교정: ${c}`);
} else descParts.push('', `## 외부조사: skip (${enrich.needReason})`);
if (grounding.grounded) {
  descParts.push('', `## 내부 grounding — 기존 관련 파일 ${grounding.files.length} (재사용·확장·중복금지)`);
  for (const f of grounding.files) descParts.push(`- ${f}`);
}
if (dedup.ok && dedup.overlaps.length) {
  descParts.push('', `## 중복 (${dedup.overlaps.length}건)`);
  for (const o of dedup.overlaps) descParts.push(`- ${o.label} → ${o.consolidation}`);
}
if (redesignLine) {
  descParts.push('', '## 골 리디자인 역제안 (A6-a·골 형태)', redesignLine);
  // ★ CC3(대표 2026-07-20) — 역제안 텍스트를 pending-redesign 슬롯에 저장(accept-redesign 콜백이 재분해에 사용).
  try { const { savePendingRedesign } = await import('../src/autopilot/mission-pending-redesign.js'); savePendingRedesign(missionId, redesignLine); } catch { /* fail-soft */ }
}
if (maturityLine) descParts.push('', '## 성숙도 분리 권장 (A6-b·과대 미션)', maturityLine);
const descText = descParts.join('\n');
const descStore = new TaskStore();
try { setMissionDescription(descStore, missionId, descText); console.error(`[mission-prepare] description 저장 (${descText.length}자).`); }
catch (e) { console.error('[mission-prepare] description 저장 실패(fail-soft):', e instanceof Error ? e.message : e); }
finally { descStore.close(); }

// ★ 조율자 상태소유 복원(대표 2026-07-21) — build 완료. building→이전 상태(proposed/running) 복원.
//   여기(description 저장 후·승인 카드 발송 전)가 자연 완료점. 이제 ops 가 '빌드 중'→'승인대기/실행중' 정직 반영.
if (enterBuilding) {
  const lifeStore = new TaskStore();
  try { missionLifecycleGate(lifeStore, missionId, restoreStatus, 'build-done'); }
  catch (e) { console.error('[mission-prepare] building 복원 실패(fail-soft):', e instanceof Error ? e.message : e); }
  finally { lifeStore.close(); }
}

// ★ 요약 먼저(대표 2026-07-16) — 첫 5줄에 전체 요약(무엇·규모·조사·다음 액션), 그 아래 페이즈만
//   약간 더 상세. 전문(아크 구조·grounding 파일·중복 상세)은 아래 📄 첨부 문서로(중복 인라인 제거).
//   종전: 골+7페이즈+아크개요+조사+grounding+중복+권고를 전부 인라인 → 너무 길어 2메시지로 쪼개짐.
// ★ 헤더 오라벨 수복(2026-07-21) — 종전 comment truthiness 만 검사 → autoproceed 의 intake fold
//   (clarified·확정설계 comment) 도 "🔧 정정 반영 완료"로 떠 대표가 "본인이 정정한 것"으로 오해.
//   "정정"은 대표가 실제 정정 지시했을 때(comment && !clarified)만. clarified(자율 확정 fold)는 정상 준비,
//   force(critique/gate 자동정련)는 분해 검증. :94 heavy·:869 description 이 이미 clarified 로 분기하는 패턴에 정렬.
const headline = (comment && !clarified) ? '🔧 정정 반영 완료 — 승인 대기'
  : force ? '🧪 분해 검증 완료 — 승인 대기'
  : '✅ 미션 준비 완료 — 승인 대기';
const researchSummary = enrich.researched ? `조사 보강 ${enrich.enrichments.length}` : '조사 skip';
const dedupSummary = dedup.ok ? (dedup.overlaps.length ? `중복 ${dedup.overlaps.length}` : '중복 0') : '중복 skip';
const advisoryCount = decomposeSynthesis.advisoryCount; // ★ CC1 — 파편 개수세기 → synth 종합으로 대체
const parts: string[] = [
  headline,                                                                       // 1 상태
  `🎯 ${m.goal.slice(0, 72)}${m.goal.length > 72 ? '…' : ''}`,                    // 2 골(제목)
  `🧩 아크 ${arcCount || 1} · 페이즈 ${phaseCount}개 (미빌드·backlog)`,           // 3 규모
  `🔎 ${researchSummary} · grounding ${grounding.files.length} · ${dedupSummary}${advisoryCount ? ` · ⚠️권고 ${advisoryCount}` : ''}`, // 4 조사 요약
  `👉 ${decomposeSynthesis.actionHint}`,                                          // 5 조율자 추천 액션(2방향·구현서 수습 우선)
];
// ★ 페이즈 제목 인라인(대표 2026-07-22) — 승인 카드에 페이즈 문장을 함께 보여준다. 종전엔 개수(🧩 페이즈 N개)만
//   이고 제목은 첨부 문서 참조뿐이라, 대표가 카드만 보고는 "무엇을 나눴나"를 판단 못 했다. 제목을 인라인으로.
if (phaseLines) parts.push('', '📋 페이즈:', phaseLines);
// ★ R4 — planAsRfc 시 승인 카드에 RFC 프리뷰(설계 승인·"페이즈 N개"→설계 계약). rfc.md 있으면 제목·아크
//   인라인 → 대표가 개수 아닌 설계를 검토. RFC-plan-as-rfc-generation §6(R4). fail-soft·opt-in.
try {
  const { getUserConfig } = await import('../src/user-config.js');
  if ((getUserConfig().raw?.autopilot as { planAsRfc?: unknown } | undefined)?.planAsRfc === true) {
    const { readRfcDoc } = await import('../src/autopilot/mission-rfc-store.js');
    const { parseAuthoredRfc } = await import('../src/autopilot/mission-rfc-author.js');
    const md = readRfcDoc(missionId);
    if (md) {
      const rfc = parseAuthoredRfc(md);
      // ★ #3 텔레그램 UX(대표 2026-07-22) — planAsRfc 면 개수 대신 **설계(아크 이름)**를 보여준다.
      //   대표가 "아크 N·페이즈 N개" 조기 카운트가 아니라 RFC 가 무엇을 설계했는지(아크 제목)로 판단.
      parts.push('', `📄 RFC 설계계약: ${rfc.title.slice(0, 76)}`);
      if (rfc.arcs.length) parts.push(`  🧩 아크(RFC 파생): ${rfc.arcs.map((a) => a.heading).join(' · ').slice(0, 140)}`);
    }
  }
} catch { /* fail-soft */ }
// ★ 조율자 UX flow(대표 2026-07-20) — 추천 액션은 위 👉(actionHint·항상 추천·2방향). 여기는 판정 근거만.
//   판정 라벨(headline)은 actionHint 와 중복/상충 방지로 카드에서 뺀다 — 예: gate revise 지만 "구현서 수습"
//   추천이면 "재분해 권장" 라벨이 혼란(대표 지적). 근거는 왜 그 추천인지 1줄. 라벨·상세는 description.
if (decomposeSynthesis.reasons.length) parts.push('', `💡 근거: ${decomposeSynthesis.reasons.slice(0, 2).join(' · ')}`);
// ★ redesign 역제안 표면화(대표 2026-07-20) — recommendedAction=redesign(재구성 추천)일 때만 카드 요지에.
//   proceed(승인 추천)·redecompose 면 역제안은 부차라 생략(종전 무조건 노출 → "승인 추천인데 역제안 크게"
//   상충·중복 노출·대표 지적). 역제안 상세·근거는 description 에 남아 pipeline/첨부로 확인 가능.
if (redesignLine && decomposeSynthesis.recommendedAction === 'redesign') {
  const rdLines = redesignLine.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2);
  if (rdLines.length) parts.push('', ...rdLines.map((l) => (l.length > 90 ? `${l.slice(0, 90)}…` : l)));
}
// ★ 갭3(대표 2026-07-19) — 아크별 페이즈를 카드에 "한눈에"(다중 아크일 때만·flat 은 위 규모줄로 충분).
//   분해 메타(비평/granularity)는 아래에서 요약 1줄씩만 — 카드의 초점을 "무엇을(아크) 만드나"에 둔다.
if (arcCompactLine) parts.push('', arcCompactLine);
// ── 요약만 인라인(대표 2026-07-19·장황함 해소) — 페이즈 목록·비평 상세·구현 시 볼 내용은
//    카드에서 제외하고 전문 첨부/pipeline 으로. 카드엔 규모+경고 요약 1줄씩만. ──
// ★ footer 라벨도 같은 뿌리(2026-07-21) — "정정 지시"는 대표 HITL 정정(comment && !clarified)만.
//   clarified(자율 intake fold)면 "확정 설계 기준" 중립 표현(:869 clarified 분기 패턴에 정렬).
if (comment && !clarified) parts.push('', `🔧 정정 지시: ${comment.slice(0, 80)}`);
else if (clarified && comment) parts.push('', `🧩 확정 설계 기준: ${comment.slice(0, 80)}`);
// 권고(성숙도)는 있을 때만 짧게. ★ 리디자인 역제안은 위(813)에서 recommendedAction=redesign 일 때만
//   요지로 통합 — 종전 여기서 전체를 무조건 push 해 proceed(승인 추천)에도 역제안 크게 노출 + 813 요지와
//   중복(카드에 2번·대표 지적). 역제안 전체·근거는 description(781)에 남아 첨부/pipeline 으로 확인.
if (maturityLine) parts.push('', maturityLine, `  집행: elanous autopilot maturity-split ${missionId} --apply`);
// ★ 분해 granularity(결정론 게이트·"[과대→split] 관심사 N클래스")는 카드에서 제거(대표 2026-07-19
//   "분해 이야기 줄여라"). 카드는 "무엇을(아크·페이즈) 만드나"에 집중 — granularity 상세는 description +
//   pipeline --sub 으로. (granularityLine 은 description 3b 에 여전히 저장됨.)
// 비평은 1줄 요약만(개수·유형) — 치명 상세는 첨부/pipeline.
if (critiqueResult?.hasCritical) {
  try {
    const { formatCritiqueSummaryLine } = await import('../src/autopilot/mission-decomp-critique.js');
    const sum = formatCritiqueSummaryLine(critiqueResult);
    if (sum) parts.push('', sum);
  } catch { if (critiqueLine) parts.push('', critiqueLine.split('\n')[0] ?? ''); }
}
parts.push('', `📎 상세(페이즈 전목록·아크 구조·비평 근거·조사)는 첨부 문서 · pipeline --sub status/critique · id ${missionId}`);

// ★ 채널 정정(대표 지시 2026-07-11) — 던진 그 대화창(origin 봇+chatId)으로 되돌려 발송.
//   origin 없거나 실패면 sendOutbound('report') 폴백.
const msg = parts.join('\n');
const origin = progressOrigin;
let sent = false;
// ★ BC3 역방향 피드백(대표 2026-07-16·원탭 HITL) — critique 치명이면 "🔁 자동 재분해" 버튼을 카드에
//   동반한다(자동 트리거 아님·대표 탭 시 critique 지적 반영 재분해). opt-in autopilot.buildCoordinatorFeedback
//   (기본 OFF)·예산 MAX_REDECOMPOSE 회(taps 누적·초과 시 미노출). 슬롯에 재분해 comment 저장(콜백이 소비).
let offerRedecompose = false;
let gateRejectMsg = ''; // ★ 게이팅 reject 시 별도 HITL 발송(재설계 역제안·대표 결정).
try {
  const { getUserConfig } = await import('../src/user-config.js');
  const ap = getUserConfig().raw?.autopilot as { buildCoordinatorFeedback?: unknown; decompGate?: unknown } | undefined;
  const feedbackEnabled = ap?.buildCoordinatorFeedback === true;
  const { shouldOfferRedecompose, MAX_REDECOMPOSE } = await import('../src/autopilot/mission-build-coordinator-driver.js');
  const { readRedecomposeTaps, savePendingRedecompose } = await import('../src/autopilot/mission-pending-redecompose.js');

  // ★ 분해 게이팅(terra) 부수효과 — revise=BC3 재분해·reject=HITL 재설계·pass=통과. gate 판정 자체는 위
  //   CC1b 블록(synthesis 앞)에서 1회 계산됨(decompGate·debug.log 도 거기서) → 여기선 그 결과의 부수효과만
  //   처리(재호출 없음·순서 재배치 리스크 최소). decompGate 없으면(gate OFF/실패) 아래 BC3(critique 치명) 폴백.
  if (decompGate) {
    const { buildGateReviseComment } = await import('../src/autopilot/mission-decomp-gate.js');
    const gate = decompGate; // ★ CC1b — synthesis 앞에서 계산한 gate 재사용
    try {
      const { recordMissionObservation } = await import('../src/autopilot/mission-observation.js');
      recordMissionObservation({
        missionId, phaseId: 'decomp-gate', phaseTitle: '분해 게이팅(terra)', stage: 'decision',
        verdict: gate.verdict === 'pass' ? 'pass' : gate.verdict === 'reject' ? 'stuck' : 'no-op',
        rationale: `게이팅 ${gate.verdict} — ${gate.reason}`.slice(0, 400), // 상한 확대(대표 2026-07-17·근거 풍부)
      });
    } catch { /* fail-soft */ }
    if (gate.verdict === 'revise') {
      const taps = readRedecomposeTaps(missionId);
      offerRedecompose = shouldOfferRedecompose(true, taps, true);
      if (offerRedecompose) savePendingRedecompose(missionId, buildGateReviseComment(gate));
      console.error(`[mission-prepare] 🚦 게이팅 → revise (재분해 제안·${offerRedecompose ? '예산내' : '예산소진'})`);
    } else if (gate.verdict === 'reject') {
      gateRejectMsg = `⛔ 분해 게이팅(terra) 거부 — ${gate.reason.slice(0, 200)}\n\n근본 재설계가 필요합니다. [정정]으로 좁히거나 골을 재구성해 주세요.\n${missionId}`;
      console.error(`[mission-prepare] 🚦 게이팅 → reject: ${gate.reason.slice(0, 80)}`);
    } else {
      console.error(`[mission-prepare] 🚦 게이팅 → pass`);
    }
  } else if (feedbackEnabled && critiqueResult?.hasCritical) {
    // 게이팅 OFF 폴백 — 기존 BC3(critique 치명 기반).
    const { buildRedecomposeComment } = await import('../src/autopilot/mission-build-coordinator-driver.js');
    const taps = readRedecomposeTaps(missionId);
    offerRedecompose = shouldOfferRedecompose(true, taps, true);
    if (offerRedecompose) {
      savePendingRedecompose(missionId, buildRedecomposeComment(critiqueResult));
      debug.log('mission.build.coordinator', 'redecompose-offered', { missionId, taps, max: MAX_REDECOMPOSE });
    } else {
      debug.log('mission.build.coordinator', 'redecompose-budget-exhausted', { missionId, taps, max: MAX_REDECOMPOSE });
    }
  }
} catch (e) { console.error('[mission-prepare] 게이팅/BC3 제안 skip(fail-soft):', e instanceof Error ? e.message : e); }
// 텔레그램 origin 이면 승인/거절 버튼과 함께 발송(HITL 크로스서피스 싱크). 실패 시 plain 폴백.
// ★ A6-b 과대 미션이면 [✂️ 성숙도 분리] 원탭 버튼 동반(maturityLine 이 있으면 oversized).
// ★ CC2b(대표 2026-07-20) — 골분해 synth 신호를 버튼 빌더로 전달(역제안→원탭 재구성 버튼·다이나믹).
// ★ 조율자 버튼 다이어트(대표 2026-07-20) — 2방향([추천 액션 1개]+[정정]). recommendedAction 기반:
//   proceed=재분해/성숙도/Opus 버튼 없음(승인·정정만) · redecompose=재분해 버튼 · redesign=역제안 수용.
//   종전 maturity/Opus 별도 버튼(최대 5-6개)은 제거 — 정정으로 흡수. gate revise 여도 proceed 면 재분해
//   버튼 안 뜸(구현서 수습). offerRedecompose(pending 슬롯 저장)는 834 로직 그대로.
const recAction = decomposeSynthesis.recommendedAction;
// ★ 조율자→UX 주문(대표 2026-07-20) — recommendedAction 을 signals 로 넘겨 buildContextualActions(UX
//   에이전트)가 추천 버튼을 합성·⭐강조. redecomposeButton(고정 buildHitlButtonRows)은 uxAgent OFF 폴백용.
try { sent = notifyMissionHitl(origin, missionId, msg, { redecomposeButton: recAction === 'redecompose' && offerRedecompose, signals: { recommendedAction: recAction, redesign: recAction === 'redesign' && !!redesignLine, criticalCount: critiqueResult?.hasCritical ? 1 : 0, scopeExceeded: overScopeArcs > 0 } }) != null; } catch { sent = false; }
if (!sent) { try { sent = notifyMissionOrigin(origin, msg); } catch { sent = false; } }
if (sent) {
  console.error(`[mission-prepare] origin(${origin?.channel}:${origin?.chatId}) 되돌려 발송 완료.`);
} else {
  try { sendOutbound(msg, 'report'); console.error('[mission-prepare] origin 없음/실패 → report 폴백 발송.'); }
  catch (e) { console.error('[mission-prepare] 발송 실패(fail-soft):', e instanceof Error ? e.message : e); }
}
// ★ 게이팅 reject 역제안 — 승인 카드 뒤에 별도 발송(재설계 필요·대표 결정·자동 차단 없음). fail-soft.
if (gateRejectMsg) {
  try { if (notifyMissionOrigin(origin, gateRejectMsg) == null) sendOutbound(gateRejectMsg, 'report'); }
  catch { /* fail-soft */ }
}

// 3c) ★ 분해 결과 다운로드(대표 지시 2026-07-12) — 플랜 초안 md(전체 페이즈·근거·검증)를
//     텔레그램 문서로 첨부해 그 대화창에서 받아볼 수 있게 한다. 텔레그램 알림 요약은 상위 10
//     페이즈만 보이므로 전문은 파일로. heavy(플랜 초안 존재) 미션만·fail-soft(발송을 막지 않음).
try {
  const draftPath = proposalDraftPath(missionId);
  // ★ 전문 첨부 작성(대표 2026-07-19·카드 장황함 해소) — 카드는 요약만이므로 페이즈 전목록·아크·
  //   비평 상세를 문서로 써서 첨부한다(구현 시 볼 내용은 여기·카드 아님).
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { formatCritiqueForHitl } = await import('../src/autopilot/mission-decomp-critique.js');
    const detail = [
      `# 분해 플랜 상세 — ${m.goal.replace(/\s+/g, ' ').trim()}`,
      // ★ arcHint 이탈 표면화(대표 2026-07-20) — 지정≠실제면 카드에 명시(종전 무표면화·이유 없이 마주침).
      '', `> 아크 ${arcCount || 1} · 페이즈 ${phaseCount}개${arcHintValid ? (arcCount && arcCount !== arcHintValid ? ` · ⚠️arcHint ${arcHintValid}→${arcCount}(LLM 조정·사유는 아크 intent)` : ` · arcHint ${arcHintValid}`) : ''}`,
      '', `## 페이즈 (${decompPhases.length})`,
      ...decompPhases.map((p, i) => `${i + 1}. ${p.title}`),
      ...(arcOverviewLine ? ['', '## 아크 구조', arcOverviewLine] : []),
      ...(critiqueResult?.hasCritical ? ['', '## 비평 상세(치명)', formatCritiqueForHitl(critiqueResult)] : []),
      ...(granularityLine ? ['', '## granularity', granularityLine] : []),
    ].join('\n');
    mkdirSync(dirname(draftPath), { recursive: true });
    writeFileSync(draftPath, detail + '\n');
  } catch (e) { console.error('[mission-prepare] 전문 작성 실패(fail-soft):', e instanceof Error ? e.message : e); }
  // ★ RFC 첨부(대표 2026-07-22) — RFC-preset 미션이면 승인 카드 첨부를 분해 플랜 텍스트가 아니라 **RFC 설계문서**로.
  //   (대표 지적: RFC 가 첨부로 와야 하는데 분해 플랜 전문이 왔다). rfc.md 있으면 그걸 첨부·없으면 종전 플랜 초안(무회귀).
  let attachPath = draftPath;
  let caption = `📄 분해 플랜 전문 — ${m.goal.slice(0, 80)}${m.goal.length > 80 ? '…' : ''} (${phaseCount} 페이즈)`;
  let docFilename: string | undefined;   // ★ 표시 파일명 override — RFC 는 apm id.md 로(rfc.md 대신).
  if (missionUsedRfcPreset) {
    try {
      const { rfcDocPath } = await import('../src/autopilot/mission-rfc-store.js');
      const { existsSync } = await import('node:fs');
      const rfcPath = rfcDocPath(missionId);
      if (existsSync(rfcPath)) {
        attachPath = rfcPath;
        caption = `📄 RFC 설계문서 — ${m.goal.slice(0, 70)}${m.goal.length > 70 ? '…' : ''} (아크 ${arcCount || 1}·페이즈 ${phaseCount})`;
        docFilename = `rfc_${missionId}.md`;   // 대표 지적 — 첨부 파일명 = rfc_<apm id>
      }
    } catch { /* fail-soft — RFC 경로 해석 실패 시 플랜 초안 첨부(무회귀) */ }
  }
  const docSent = notifyMissionDocument(origin, attachPath, caption, docFilename);
  console.error(docSent ? `[mission-prepare] ${attachPath === draftPath ? '플랜 초안' : 'RFC 설계문서'} 첨부 발송 완료(${attachPath}).` : '[mission-prepare] 문서 미첨부(origin 비텔레그램/파일 없음).');
} catch (e) { console.error('[mission-prepare] 플랜 문서 첨부 실패(fail-soft):', e instanceof Error ? e.message : e); }

// 4) ★ BC2 shadow parity(재설계 2단계·RFC-mission-build-coordinator §5) — 선형 스크립트가 방금
//    실행한 단계집합을 coordinator 스케줄러로 재생(replay)해 스케줄 계약(BUILD_STAGE_DEPS)이 선형
//    현실과 일치하는지 대조. ★ 실 재실행 없음(집행 0)·배달 무변경(관측만·카드/발송 불변). drift 면
//    관측 관문(logs.db)으로 표면화 — cutover(BC5) 전에 잡아야 할 유일한 계약 갭. opt-in
//    (autopilot.buildCoordinatorShadow·기본 OFF·미설정=완전 무동작). fail-soft(준비를 막지 않음).
try {
  let shadowEnabled = false;
  try {
    const { getUserConfig } = await import('../src/user-config.js');
    shadowEnabled = (getUserConfig().raw?.autopilot as { buildCoordinatorShadow?: unknown } | undefined)?.buildCoordinatorShadow === true;
  } catch { /* fail-soft — config 없으면 OFF */ }
  if (shadowEnabled) {
    const { shadowParityCheck } = await import('../src/autopilot/mission-build-coordinator-driver.js');
    // 선형이 실제 실행한 단계만 trace 에 담는다(미실행은 제외 — 부분집합 스케줄). LLM 출력이 아니라
    // 실행/성공 여부만(replay·비결정 값 대조 안 함).
    const trace: import('../src/autopilot/mission-build-coordinator-driver.js').LinearTrace = {
      research: { stage: 'research', ok: true, output: { researched: enrich.researched } },
      dedup: { stage: 'dedup', ok: dedup.ok, output: { overlaps: dedup.ok ? dedup.overlaps.length : 0 } },
    };
    if (doGround) trace.ground = { stage: 'ground', ok: true, output: { grounded: grounding.grounded, files: grounding.files.length } };
    if (clarifyRan) trace.clarify = { stage: 'clarify', ok: true };
    if (heavy) {
      trace.shape = { stage: 'shape', ok: true, output: { redesign: !!redesignLine } };
      trace.decompose = { stage: 'decompose', ok: phaseCount > 0, output: { phaseCount } };
      if (decompPhases.length) {
        trace.critique = { stage: 'critique', ok: true, output: { hasLine: !!critiqueLine } };
        trace.granularity = { stage: 'granularity', ok: true, output: { hasLine: !!granularityLine } };
      }
    }
    const linearSucceeded = heavy ? phaseCount > 0 : dedup.ok;
    const verdict = shadowParityCheck(trace, { linearSucceeded });
    debug.log('mission.build.coordinator', verdict.ok ? 'shadow-parity-ok' : 'shadow-parity-drift', {
      missionId, heavy, executed: verdict.executedStages, groups: verdict.groups,
      orphans: verdict.orphans, uncovered: verdict.uncovered, convergedMatch: verdict.convergedMatch,
    });
    console.error(`[mission-prepare] 🔀 BC2 shadow parity → ${verdict.detail}`);
  }
} catch (e) { console.error('[mission-prepare] BC2 shadow parity skip(fail-soft):', e instanceof Error ? e.message : e); }

console.error('[mission-prepare] 준비 완료 — 사람 확인 대기(planning 유지·자동실행 0).');
// ★ LG1 빌드 가시화 — 빌드 완료(플랜 확정·승인 대기)를 조율자 렌즈로 관측. building→plan-ready 회상.
try { debug.log('mission.coordinator', 'lifecycle', { missionId, phase: 'building', stage: 'plan-ready', phaseCount }); } catch { /* fail-soft */ }
