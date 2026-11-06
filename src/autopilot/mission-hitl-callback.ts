// ── 미션 HITL 텔레그램 콜백 구독자 (대표 지시 2026-07-11) ─────────────────────
//
// 미션은 텔레그램에서 골로 시작하지만 HITL 승인/거절이 PWA 에서만 됐다. 이제 텔레그램 HITL
// 알림에 달린 승인/거절 inline 버튼 탭을 여기서 처리한다.
//
//   callback_data = `apm-hitl:<token>:approve|reject`  (token = 미션 id 의 hash6 suffix·ascii)
//
// 탭 → 토큰으로 미션 id 해석 → approveMission/cancelMission(★PWA·CLI 와 동일한 공유 write
// 경로) → 메시지 edit + answerCallback. PWA 는 폴링으로 status 를 자동 반영하고, 반대 방향
// (PWA→텔레그램)은 mission-tool 이 resolveMissionHitlUi 로 이 메시지를 edit 한다. 공유 상태 =
// mission.status(단일 SoT) — 한쪽에서 해소되면 반대편도 같은 상태가 된다.
//
// 데몬 메인 bot 에 1개 구독자로 등록(telegram-trigger-bot). 형제 핸들러(surface HITL·global
// HITL)와 prefix 로 구분 — `apm-hitl:` 아니면 조용히 무시(다른 핸들러 소관).

import type { TelegramBot, TgCallbackQuery } from '../telegram.js';
import { parseHitlCallbackData, parsePhaseCallbackData, parseLifecycleCallbackData, parseBriefingCallbackData, hitlToken, HITL_REVISE_PRESETS, resolveTelegramBotToken, sendForceReplyTo, sendTelegramTo, sendTelegramButtonsTo, notifyMissionReviseMenu, buildReviseConfirmCard, buildReviseDisambiguationCard, formatArcAutoproceedNotice, type PhaseAction, type LifecycleAction, type BriefingAction } from './mission-notify.js';
import { splitPhaseIntoSubphases } from './mission-phase-split.js';
import { skipPhase } from './mission-phase-skip.js';
import { TaskStore } from '../task-orchestrator/store.js';
import { spawnMissionPrepare } from './mission-prepare-spawn.js';
import { recommendRevise, reviseClassifyDefault, reviseKindLabel } from './mission-revise-recommender.js';
import { detectReviseIntent, resolveActiveMissionForChat, type ActiveMissionCandidate } from './mission-revise-intent.js';
import { routeMissionDecisionUtterance, detectMissionDecisionIntent } from './mission-decision-intent.js';
import { recordMissionDecision } from './mission-decision.js';
import { getRecentChatMission, savePendingReviseContext, readPendingReviseContext, clearPendingReviseContext } from './mission-chat-context.js';
import { savePendingRevise, readPendingRevise, clearPendingRevise } from './mission-pending-revise.js';
import { parseClarifyCallbackData, buildAnsweredText, allAnswered, foldAnswersIntoDesign, formatDesignAsDecomposeContext, buildClarifyMessages, analyzeGoalAmbiguity, decideArcAutoproceed, type ClarifyCallback, type IntakeClarification } from './mission-intake-clarify.js';
import { recordClarifyAnswer, clearPendingClarify, readPendingClarify, savePendingClarify, setClarifyControlMessage, type PendingClarify } from './mission-pending-clarify.js';
import { coordinatorRecordMemory } from './pipeline/coordinator-memory.js';
import { loadMissionOrigin } from './mission-origin.js';
import { openAutopilotMissionsDb, listMissions, getMission } from './mission-registry.js';
import { approveMission, type ApproveMissionResult } from './mission-engine.js';
import { canUseUxAgent } from '../ux/ux-config.js';
import { cancelMission, rerunMission, rebuildPhase, rebuildCritiquedPhases, mergeMissionPhases, buildMissionExecutionContext } from './mission-lifecycle.js';
import { debug } from '../debug/log.js';

const PREFIX = 'apm-hitl';

/** cron 표현식 → 대략적 한국어 해석(피드백 표시용·정밀 아님). 파싱 실패 시 원문 반환. */
export function describeCronKo(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, , , dow] = parts;
  const dowNames = ['일', '월', '화', '수', '목', '금', '토'];
  const hh = hour === '*' ? null : Number(hour);
  const mm = min === '*' ? null : Number(min);
  const timeStr = hh != null && Number.isFinite(hh)
    ? `${hh}시${mm ? ` ${mm}분` : ''}`
    : (mm != null && Number.isFinite(mm) ? `매시 ${mm}분` : '매분');
  if (dow !== '*' && /^[0-6]$/.test(dow)) return `매주 ${dowNames[Number(dow)]}요일 ${timeStr}`;
  if (dow === '1-5') return `평일 ${timeStr}`;
  return `매일 ${timeStr}`;
}

/** 승인 결과 → "어떻게 해석해 넣었는지" 사람용 요약. scheduler=예약(즉시 실행 아님) vs task=즉시 실행 구분. */
export function describeApproval(r: ApproveMissionResult): string {
  if (r.scheduledCron) {
    return `📅 실행 예약 등록 — ${describeCronKo(r.scheduledCron)}\n   (cron: ${r.scheduledCron} · 지금 즉시 실행이 아니라 예약 시각에 자동 발화)`;
  }
  if (r.activated > 0) return `▶️ 지금 실행 시작 — 페이즈 ${r.activated}건 집행.`;
  return '승인 처리됨.';
}

/** 토큰(hash6)으로 미션 id 해석 — 등록된 미션 중 hitlToken 매칭 첫 건. 없으면 null(만료/오탭).
 *  순수 조회(store 열고 닫음). */
export function resolveMissionByHitlToken(token: string): string | null {
  try {
    const store = openAutopilotMissionsDb();
    const hit = listMissions(store, {}).find((m) => hitlToken(m.id) === token);
    return hit ? hit.id : null;
  } catch (error) {
    try {
      debug.log('mission.hitl.token.resolve.failed', token, { error: error instanceof Error ? error.message : String(error) });
    } catch {
      // Logging is best-effort; preserve the callback's existing failure response.
    }
    return null;
  }
}

/** ★ Intake Q&A clarify 탭(RFC-mission-intake-qa-agent) — 옵션 선택(answer)/이대로 진행(proceed).
 *  I3b: 답변은 pending 기록·모두 답하면 진행, 일부면 카드 갱신(대기). "이대로 진행"은 미답 비블로킹을
 *  추천값으로 채워 진행(블로킹 남으면 거부). 자율경계: 되묻기=HITL·집행 0·armed 아님. fail-soft. */
async function handleClarifyTap(
  bot: TelegramBot, q: TgCallbackQuery, parsed: ClarifyCallback,
): Promise<void> {
  // ★ I3d — 탭마다 관측(제1원칙·종전엔 answer 경로 무로그라 Q2/Q3 미반응 진단이 어려웠다).
  debug.log('mission.intake.tap', parsed.kind, {
    token: parsed.token, ...(parsed.kind === 'answer' ? { questionId: parsed.questionId, optIdx: parsed.optIdx } : {}),
  });
  const missionId = resolveMissionByHitlToken(parsed.token);
  if (!missionId) {
    try { await bot.answerCallbackQuery(q.id, { text: '만료된 미션(이미 처리?)' }); } catch { /* */ }
    return;
  }

  if (parsed.kind === 'proceed') {
    const pending = readPendingClarify(missionId);
    if (!pending) {
      try { await bot.answerCallbackQuery(q.id, { text: '만료된 되묻기(이미 확정?)' }); } catch { /* */ }
      return;
    }
    // ★ I3d(대표 제안) — "전체 추천대로 진행": 미답을 추천값으로 채워 다음 단계로. 2단계(P3)면
    //   stage1 proceed → stage2(arc) 전이, stage2 proceed → finalize(advanceClarifyStage 가 분기).
    try { await bot.answerCallbackQuery(q.id, { text: '🚀 전체 추천대로 진행' }); } catch { /* */ }
    await advanceClarifyStage(bot, missionId, pending);
    return;
  }

  // ★ edit(RFC P4·자유 피드백) — force-reply 로 자유 교정 입력 요청. 답장은 tryInterceptClarifyFeedback
  //   (telegram handleIncoming 경유)이 가로채 현재 단계 질문을 sol 로 재마름질. 예산 MAX 2.
  if (parsed.kind === 'edit') {
    const pending = readPendingClarify(missionId);
    if (!pending) { try { await bot.answerCallbackQuery(q.id, { text: '만료된 되묻기(이미 확정?)' }); } catch { /* */ } return; }
    if ((pending.refineCount ?? 0) >= 2) {
      try { await bot.answerCallbackQuery(q.id, { text: '수정 횟수 소진(2회) — 선택/진행으로 마무리해주세요' }); } catch { /* */ }
      return;
    }
    try { await bot.answerCallbackQuery(q.id, { text: '✏️ 바꿀 점을 답장으로 보내주세요' }); } catch { /* */ }
    const origin = loadMissionOrigin(missionId);
    const botToken = origin ? resolveTelegramBotToken(origin.botId) : null;
    if (botToken && q.chatId !== undefined) {
      sendForceReplyTo(botToken, q.chatId, `✏️ 되묻기 직접 수정 [apm-clarify-edit:${hitlToken(missionId)}]\n추천안에서 바꾸고 싶은 점을 이 메시지에 답장으로 보내주세요(예: "아크를 더 잘게" · "X 어댑터도 이번 범위에"). 반영해 다시 마름질합니다.`, origin?.threadId);
    }
    debug.log('mission.intake.feedback', missionId, { phase: 'prompt', refineCount: pending.refineCount ?? 0 });
    return;
  }

  // answer — ★ I3c: 탭한 그 질문 메시지(q.messageId)만 편집(editMessageText 가 그 질문 버튼만 제거·
  //   다른 질문 메시지는 무영향). 종전 단일 카드 편집이 9개 버튼을 통째로 날리던 버그 해소.
  const pending = recordClarifyAnswer(missionId, parsed.questionId, parsed.optIdx);
  if (!pending) {
    try { await bot.answerCallbackQuery(q.id, { text: '만료된 되묻기(이미 확정?)' }); } catch { /* */ }
    return;
  }
  const idx = pending.clarifications.findIndex((c) => c.questionId === parsed.questionId);
  const answered = pending.clarifications[idx];
  try { await bot.answerCallbackQuery(q.id, { text: `✓ ${answered?.answer ?? '반영'}`.slice(0, 60) }); } catch { /* */ }
  if (answered && q.chatId !== undefined && q.messageId !== undefined) {
    try { await bot.editMessageText(q.chatId, q.messageId, buildAnsweredText(answered, idx, pending.clarifications.length)); } catch { /* */ }
  }
  // 모두 답하면 다음 단계(2단계면 stage1→stage2 전이·아니면 finalize), 아니면 대기.
  if (allAnswered(pending.clarifications)) await advanceClarifyStage(bot, missionId, pending);
}

/** ★ 되묻기 단계 전이(RFC P3·2단계 2026-07-17) — stage1(범위) 완료 → stage2(아크) 전이 or finalize.
 *  대표 지적: scope 답이 범위를 바꾸니 arc 는 그 뒤에. stage1 완료 시 확정 범위를 arc judge(sol)에
 *  주입해 arc 질문 생성 → 있으면 stage2 카드, 없으면(arc 명확) finalize. stage2/단일턴은 finalize
 *  (priorAnswers[stage1] + 현재[stage2] 병합). fail-soft — 어디서 실패해도 finalize 폴백(비파괴). */
async function advanceClarifyStage(bot: TelegramBot, missionId: string, pending: PendingClarify): Promise<void> {
  // stage1 완료 & heavy → stage2(arc) 전이
  if (pending.stage === 1 && pending.heavy && pending.goal) {
    // ★ 전이 중 침묵 방지(대표 UX 2026-07-17) — arc judge(sol/high)가 수 초~수십 초 걸려 응답이
    //   없으면 "죽은 줄" 오해. 범위 확정 즉시 "아크 구성 중" 통지를 보내 진행을 알린다.
    const origin0 = loadMissionOrigin(missionId);
    const tk0 = origin0 ? resolveTelegramBotToken(origin0.botId) : null;
    if (tk0 && origin0?.channel === 'telegram' && origin0.chatId !== undefined) {
      sendTelegramTo(tk0, origin0.chatId, '🔄 범위 확정됨 → 아크(작업 묶음) 구성 중입니다… (수 초, sol 리즈닝)', origin0.threadId);
    }
    try {
      const design1 = foldAnswersIntoDesign(pending.goal, pending.clarifications); // 확정 범위(미답=추천)
      const arcQs = await analyzeGoalAmbiguity(pending.goal, { heavy: true, phase: 'arc', confirmedScope: design1.scope }, { missionId });
      if (arcQs.length > 0) {
        // ★ arc 자율 진행(2026-07-21·대표 지적 "되묻기 컨펌 후 아크를 또 물음") — 아크 되묻기가 clear
        //   single recommendation 이면 카드(HITL) 없이 추천 아크수를 자율 채택하고 finalize 로 직행한다.
        //   #4855 는 se-mission-prepare stage2(scope 0개→arc 직행)만 커버해 이 콜백 경로(scope 카드 응답 후
        //   stage1→stage2 전이)는 우회당했다 → 두 경로를 decideArcAutoproceed 공용 seam 으로 통합. arcHint 는
        //   soft(LLM classify 최종 결정)라 무회귀. 애매(추천 0/복수)면 아래 종전 카드 경로.
        const arcDec = decideArcAutoproceed(arcQs);
        if (arcDec.autoproceed) {
          debug.log('mission.intake', 'autoproceed', { missionId, path: 'callback', arcHint: arcDec.arcHint ?? null, questions: arcQs.length });
          // ★ 아크 자율 산정 non-blocking 알림(2026-07-21·대표 #4867 후속·투명성 갭) — 카드(HITL)는 없애되
          //   자율 채택한 아크 수를 사람에게 통지(제1원칙 — 자율 결정엔 사용자 향 관측). fail-soft(발송 실패가
          //   finalize 를 막지 않게). origin0/tk0 는 이 stage1 블록 상단(범위 확정 통지)에서 이미 로드됨.
          try {
            if (tk0 && origin0?.channel === 'telegram' && origin0.chatId !== undefined) {
              sendTelegramTo(tk0, origin0.chatId, formatArcAutoproceedNotice(arcDec.arcHint), origin0.threadId);
            }
          } catch { /* fail-soft — 알림 실패는 파이프라인 비차단 */ }
          // stage1 답변(확정 범위) + arc 질문(미답→foldAnswersIntoDesign 이 추천값 auto-resolve→arcHint parse)
          //   을 합쳐 finalize. pending.controlMessageId(stage1 control)는 finalize 가 "✅ 확정"으로 마감.
          const merged: PendingClarify = { ...pending, clarifications: [...pending.clarifications, ...arcQs] };
          await finalizeClarify(bot, missionId, merged);
          return;
        }
        // stage1 답변 보존(priorAnswers) + stage2(arc) 카드 발송
        savePendingClarify(missionId, { clarifications: arcQs, stage: 2, goal: pending.goal, heavy: true, priorAnswers: pending.clarifications });
        try {
          const { recordMissionObservation } = await import('./mission-observation.js');
          recordMissionObservation({ missionId, phaseId: 'intake', phaseTitle: 'Intake Q&A 2/2 아크', stage: 'decision', verdict: 'no-op', rationale: `1단계(범위) 확정 → 아크 되묻기 ${arcQs.length}개` });
        } catch { /* fail-soft */ }
        const origin = loadMissionOrigin(missionId);
        const tk = origin ? resolveTelegramBotToken(origin.botId) : null;
        if (tk && origin?.channel === 'telegram' && origin.chatId !== undefined) {
          const { questions, control } = buildClarifyMessages(arcQs, hitlToken(missionId));
          for (const qq of questions) { sendTelegramButtonsTo(tk, origin.chatId, qq.text, qq.buttons, origin.threadId); await new Promise((r) => setTimeout(r, 350)); }
          const controlId = sendTelegramButtonsTo(tk, origin.chatId, control.text, control.buttons, origin.threadId);
          if (controlId) setClarifyControlMessage(missionId, controlId);
        }
        debug.log('mission.intake.stage', missionId, { from: 1, to: 2, arcQ: arcQs.length });
        return;
      }
      // arc 명확 → stage1 만으로 finalize
    } catch (e) { debug.log('mission.intake.stage', missionId, { from: 1, error: e instanceof Error ? e.message.slice(0, 100) : '' }); }
    await finalizeClarify(bot, missionId, pending);
    return;
  }
  // stage2 또는 단일턴 → finalize (stage1 답 + 현재 병합).
  const merged: PendingClarify = { ...pending, clarifications: [...(pending.priorAnswers ?? []), ...pending.clarifications] };
  await finalizeClarify(bot, missionId, merged);
}

/** 확정 설계 fold → --clarified 재-spawn(무한 되묻기 방지) + control 메시지 마감. 미답=추천값 fold. */
async function finalizeClarify(
  bot: TelegramBot, missionId: string,
  pending: { clarifications: IntakeClarification[]; controlMessageId?: number },
): Promise<void> {
  const design = foldAnswersIntoDesign('', pending.clarifications);
  const context = formatDesignAsDecomposeContext(design);
  const controlId = pending.controlMessageId;
  clearPendingClarify(missionId);
  try {
    const { recordMissionObservation } = await import('./mission-observation.js');
    recordMissionObservation({
      missionId, phaseId: 'intake', phaseTitle: 'Intake Q&A clarify',
      stage: 'decision', verdict: 'pass',
      rationale: `확정 설계 fold → 재준비 (${context.replace(/\n/g, ' ').slice(0, 120)})`,
    });
  } catch { /* fail-soft */ }
  // ★ I3a — forceDecompose 제거: 원래 tier 존중(heavy=분해·light=light·확정설계는 description).
  // ★ arcHint 구조화 배선(2026-07-17) — 확정 아크 수를 comment(텍스트) 외에 구조화 인자로도 전달.
  //   decompose 가 arcCount 제약으로 받아 멀티아크로 전개("5아크→5페이즈" 손실 체인 근본 수복).
  try { spawnMissionPrepare(missionId, { comment: context, clarified: true, ...(design.arcHint !== undefined ? { arcHint: design.arcHint } : {}) }); } catch { /* fail-soft */ }
  debug.log('mission.intake.confirmed', missionId, { arcHint: design.arcHint, scope: design.scope.length, excluded: design.excluded.length });
  // control(진행) 메시지를 "✅ 확정"으로 마감. origin 로드(콜백 q 는 finalize 로 안 넘김·control id 로 편집).
  if (controlId !== undefined) {
    const origin = loadMissionOrigin(missionId);
    if (origin?.channel === 'telegram' && origin.chatId !== undefined) {
      try { await bot.editMessageText(origin.chatId, controlId, `✅ 설계 확정 — 이 설계로 준비를 이어갑니다.\n${context}\n\n(완료 시 새 HITL 확인 요청이 옵니다)`); } catch { /* */ }
      try { await bot.clearMessageReplyMarkup(origin.chatId, controlId); } catch { /* */ }
    }
  }
}

/** ★ R2 페이즈 리뷰 탭(대표 2026-07-12) — phaseKey 로 페이즈 task 조회 → 승인(기록·버튼 제거)
 *  or 재구현(rebuildPhase: 이 페이즈부터 SE 격리 재구현). recritique 는 R1 이후. */
async function handlePhaseReviewTap(
  bot: TelegramBot, q: TgCallbackQuery,
  parsed: { phaseKey: string; action: PhaseAction },
): Promise<void> {
  const store = new TaskStore();
  let task: ReturnType<TaskStore['listTasks']>[number] | undefined;
  let missionId = '';
  try {
    task = store.listTasks({}).find((t) => t.id.replace(/^task:/, '').startsWith(parsed.phaseKey));
    missionId = task?.goalSlug ?? task?.missionId ?? '';
  } finally { store.close(); }
  if (!task || !missionId) { try { await bot.answerCallbackQuery(q.id, { text: '만료된 페이즈(이미 처리?)' }); } catch { /* */ } return; }
  debug.log('mission.phase.review', missionId, { action: parsed.action, phase: task.id });
  // ★ 사용자 인텐트 기록 보완(대표 2026-07-14) — HITL 버튼 탭(승인/확인/재구현/건너뛰기 등)은 그간
  //   user-intent 로그에 안 남아(handleIncoming=타이핑만 emit) "사용자 깨어있음" 신호에서 누락됐다.
  //   버튼도 명백한 사용자 발원 인텐트라 selection 레이어로 emit → 야간 무음 우회가 이걸 본다. fail-soft.
  try {
    const { userIntentLogger } = await import('../user-intent/index.js');
    userIntentLogger().emit({
      surface: 'telegram',
      intent: {
        layer: 'selection', kind: `telegram.selection.hitl_${parsed.action}`,
        target: { kind: 'message', id: String(q.messageId ?? ''), label: String(q.chatId ?? '') },
        value: q.data,
      },
    });
  } catch { /* logging must never break the HITL path */ }

  if (parsed.action === 'approve') {
    try { await bot.answerCallbackQuery(q.id, { text: '✅ 페이즈 승인' }); } catch { /* */ }
    if (q.chatId !== undefined && q.messageId !== undefined) {
      try { await bot.editMessageText(q.chatId, q.messageId, `✅ 페이즈 승인됨: ${task.title}\n${missionId}`); } catch { /* */ }
      try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
    }
    return;
  }
  if (parsed.action === 'rebuild') {
    let r: { ok: boolean; error?: string };
    try { r = rebuildPhase(missionId, task.id, { note: '사람 재구현 요청(페이즈 리뷰 버튼)' }); }
    catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    try { await bot.answerCallbackQuery(q.id, { text: (r.ok ? '🔧 재구현 시작' : `실패: ${r.error ?? ''}`).slice(0, 60) }); } catch { /* */ }
    if (r.ok && q.chatId !== undefined && q.messageId !== undefined) {
      try { await bot.editMessageText(q.chatId, q.messageId, `🔧 페이즈 재구현 시작: ${task.title}\n(이 페이즈부터 SE 격리 재구현·완료 시 새 알림)\n${missionId}`); } catch { /* */ }
      try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
    }
    return;
  }
  // ★ 페이즈 국소 재분해(대표 지시 2026-07-12) — 최대 예산으로도 완주 못 한 "너무 큰" 페이즈를
  //   단일책임 서브페이즈로 쪼개 재개. answer-first(반응 지연 해소·비동기 LLM 재분해는 뒤에서).
  if (parsed.action === 'split') {
    try { await bot.answerCallbackQuery(q.id, { text: '✂️ 페이즈 분할 중… (재분해 후 재개)' }); } catch { /* */ }
    if (q.chatId !== undefined && q.messageId !== undefined) {
      try { await bot.editMessageText(q.chatId, q.messageId, `✂️ 페이즈 분할 중: ${task.title}\n(단일책임 서브페이즈로 재분해 → 순회 재개·완료 시 새 알림)\n${missionId}`); } catch { /* */ }
      try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
    }
    const phaseId = task.id;
    const mid = missionId;
    // 비동기 재분해(LLM) — 콜백 응답을 막지 않도록 뒤에서. 결과를 origin 채널로 발송.
    void splitPhaseIntoSubphases(mid, phaseId).then((r) => {
      try {
        const origin = loadMissionOrigin(mid);
        const token = origin ? resolveTelegramBotToken(origin.botId) : null;
        if (origin && token && origin.chatId !== undefined) {
          // ★ 서브페이즈 제목 열거(대표 지시 2026-07-12) — "어떻게 N개로 쪼갰나" 를 바로 보이게.
          const titleList = r.subTitles.map((t, i) => `  ${i + 1}. ${t}`).join('\n');
          const msg = r.ok
            ? `✅ 페이즈 분할 완료 — ${r.subPhaseCount}개 서브페이즈로 재분해·순회 재개:\n${titleList}\n${mid}`
            : `⚠️ 페이즈 분할 실패: ${r.error ?? ''}\n(재구현/처음부터 재실행을 대신 시도하세요)\n${mid}`;
          sendTelegramTo(token, origin.chatId, msg, origin.threadId);
        }
      } catch { /* fail-soft */ }
    }).catch(() => { /* fail-soft */ });
    return;
  }
  // ★ 골 정정 탈출구(대표 지시 2026-07-12) — 막힌 페이즈에서 골 분해까지 올라가 목표 정정·재분해.
  //   재시도만 있고 상향 정정이 없던 갭. revise 프리셋 메뉴(범위축소=이 기능 제외·간소화 등)를
  //   띄운다 → 선택 시 기존 revise 핸들러가 spawnMissionPrepare 로 골 재분해 → 새 HITL 확인.
  if (parsed.action === 'revise') {
    try { await bot.answerCallbackQuery(q.id, { text: '✏️ 골 정정 메뉴' }); } catch { /* */ }
    const origin = loadMissionOrigin(missionId);
    const text = `✏️ 골 정정·재분해 — 막힌 페이즈: ${task.title}\n재시도로 안 되는 하드 피처입니다. 골을 어떻게 정정할지 고르세요:\n· ✂️ 범위축소 = 이 기능 제외 · 🔼 간소화 · ♻️ 기존재사용 · 🔽 더잘게 · 🔍 조사강화 · ✏️ 직접입력\n선택 시 골을 재분해하고 새 확인 요청을 보냅니다.\n${missionId}`;
    try { notifyMissionReviseMenu(origin, missionId, text); } catch { /* fail-soft */ }
    return;
  }
  // ★ 건너뛰기 탈출구(대표 지시 2026-07-13·§5.2 3층 탈출구 마지막 층) — "이 기능은 지금 안 만든다"고
  //   판단할 때 이 페이즈를 done+[SKIPPED] 마킹(기능 제외)하고 나머지 페이즈로 미션 계속(부분 완주).
  //   skipPhase 는 동기(LLM 없음)라 즉시 처리·재spawn 은 뒤에서 순회 재개.
  if (parsed.action === 'skip') {
    let r: { ok: boolean; skippedTitle?: string; unblockedCount: number; error?: string };
    try { r = skipPhase(missionId, task.id); }
    catch (e) { r = { ok: false, unblockedCount: 0, error: e instanceof Error ? e.message : String(e) }; }
    try { await bot.answerCallbackQuery(q.id, { text: (r.ok ? '⏭️ 페이즈 건너뜀' : `실패: ${r.error ?? ''}`).slice(0, 60) }); } catch { /* */ }
    if (q.chatId !== undefined && q.messageId !== undefined) {
      const msg = r.ok
        ? `⏭️ 페이즈 건너뜀(기능 제외): ${task.title}\n(후속 ${r.unblockedCount}개 페이즈 언블록·순회 재개 — 완료 시 새 알림)\n${missionId}`
        : `⚠️ 건너뛰기 실패: ${r.error ?? ''}\n${missionId}`;
      try { await bot.editMessageText(q.chatId, q.messageId, msg); } catch { /* */ }
      try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
    }
    return;
  }
  // ★ arming 경계 결정(Track C·2026-07-15) — 실집행 페이즈를 실패가 아니라 HITL 로. 대표가 arm/defer 선택.
  if (parsed.action === 'arm') {
    recordMissionDecision(missionId, { kind: 'boundary', note: `arm 승인 요청 — "${task.title}" 실집행`, appliesTo: task.title, rationale: '대표 arming 승인(실집행 경계)', actor: `telegram:${q.chatId ?? '?'}` });
    try { await bot.answerCallbackQuery(q.id, { text: '🔒 arming 승인 접수' }); } catch { /* */ }
    if (q.chatId !== undefined && q.messageId !== undefined) {
      try { await bot.editMessageText(q.chatId, q.messageId, `🔒 실집행 승인 접수: ${task.title}\n결정 기록됨(관측·기억). ⚠️ 실 arming 은 안전 플로우로: \`elanous autopilot arm ${missionId}\` 또는 mandate arming(별도 HITL·매매 안전관문).\n${missionId}`); } catch { /* */ }
      try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
    }
    return;
  }
  if (parsed.action === 'defer') {
    recordMissionDecision(missionId, { kind: 'defer', note: `"${task.title}" arming 단계로 defer(범위 제외)`, appliesTo: task.title, rationale: '실집행은 arming HITL 로 이관', actor: `telegram:${q.chatId ?? '?'}` });
    let r: { ok: boolean; unblockedCount: number; error?: string };
    try { r = skipPhase(missionId, task.id); } catch (e) { r = { ok: false, unblockedCount: 0, error: e instanceof Error ? e.message : String(e) }; }
    try { await bot.answerCallbackQuery(q.id, { text: '⏳ arming 으로 defer' }); } catch { /* */ }
    if (q.chatId !== undefined && q.messageId !== undefined) {
      try { await bot.editMessageText(q.chatId, q.messageId, `⏳ arming 단계로 defer(범위 제외): ${task.title}\n결정 기록됨·후속 ${r.unblockedCount}개 언블록. 미션은 이 페이즈 없이 계속(arming 때 실집행).\n${missionId}`); } catch { /* */ }
      try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
    }
    return;
  }
  // ★ HITL 확인 패스(대표 2026-07-13·슬라이스 2) — 카나리 등 "사람이 도착/결과를 눈으로 확인"해야
  //   하는 페이즈를 대표가 확인 버튼으로 done 처리. 에이전트 검증 불가 항목의 사람 확인(hard-fail 로
  //   끝나지 않고 확인 기회 제공). mission-tool check 액션 재사용(status→done + working memory 태깅).
  if (parsed.action === 'check') {
    let r: { error?: string } = {};
    try { const { dispatchAutopilotMissions } = await import('./mission-tool.js'); r = await dispatchAutopilotMissions({ action: 'check', id: missionId, phase: task.id }) as { error?: string }; }
    catch (e) { r = { error: e instanceof Error ? e.message : String(e) }; }
    const ok = !r.error;
    try { await bot.answerCallbackQuery(q.id, { text: (ok ? '✅ 확인 완료 — done 처리' : `실패: ${r.error ?? ''}`).slice(0, 60) }); } catch { /* */ }
    if (q.chatId !== undefined && q.messageId !== undefined) {
      const msg = ok
        ? `✅ 확인 완료: ${task.title}\n(사람이 결과를 확인해 done 처리 — 카나리 도착 등 에이전트 검증 불가 항목 · 미션 순회 재개·완료 시 새 알림)\n${missionId}`
        : `⚠️ 확인 실패: ${r.error ?? ''}\n${missionId}`;
      try { await bot.editMessageText(q.chatId, q.messageId, msg); } catch { /* */ }
      try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
    }
    return;
  }
  // ★ 시스템 셀프힐링 escalate(대표 2026-07-13) — 시스템 결함 의심 페이즈를 자율 수리로 잇는다.
  //   answer-first(R3 Opus 룩백 + 스폰은 수십초 걸림 → 콜백 즉시 ack, 결과는 origin 채널로 발송).
  //   dispatch escalate = mission-tool(단일 창구·CLI/tool 동형). 수리 미션은 분해→HITL 승인 대기.
  if (parsed.action === 'escalate') {
    try { await bot.answerCallbackQuery(q.id, { text: '🙋 시스템 수리 escalate 중… (R3 Opus 조사)' }); } catch { /* */ }
    if (q.chatId !== undefined && q.messageId !== undefined) {
      try { await bot.editMessageText(q.chatId, q.messageId, `🙋 시스템 수리 escalate 중: ${task.title}\n(R3 Opus 소스 룩백 → 시스템 결함이면 수리 미션 스폰·완료 시 새 알림)\n${missionId}`); } catch { /* */ }
      try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
    }
    const mid = missionId;
    const phaseId = task.id;
    // 비동기(LLM+스폰) — 콜백 막지 않도록 뒤에서. 결과를 origin 채널로 발송.
    void (async () => {
      let r: { spawned?: boolean; repairMissionId?: string; boundary?: string; error?: string; note?: string } = {};
      try { const { dispatchAutopilotMissions } = await import('./mission-tool.js'); r = await dispatchAutopilotMissions({ action: 'escalate', id: mid, phase: phaseId }) as typeof r; }
      catch (e) { r = { error: e instanceof Error ? e.message : String(e) }; }
      try {
        const origin = loadMissionOrigin(mid);
        const token = origin ? resolveTelegramBotToken(origin.botId) : null;
        if (origin && token && origin.chatId !== undefined) {
          const msg = r.error
            ? `⚠️ escalate 실패: ${r.error}\n${mid}`
            : r.spawned
              ? `🛠️ 시스템 수리 미션 스폰 완료 — ${r.repairMissionId}\n(system-repair 권한·Opus 강제·분해 후 HITL 승인 대기. merge+데몬 재시작은 대표 승인.)\n${mid}`
              : `ℹ️ escalate — 자율 수리 미대상${r.boundary === 'provenance' ? '(보안 경계·사람 판단 필요)' : '(시스템 결함 모순 미검출)'}.\n${mid}`;
          sendTelegramTo(token, origin.chatId, msg, origin.threadId);
        }
      } catch { /* fail-soft */ }
    })();
    return;
  }
  try { await bot.answerCallbackQuery(q.id, { text: '재비평(R1)은 준비 중' }); } catch { /* */ }
}

/** 미션 HITL 콜백 구독자 등록. 반환=unsub. 데몬 startup(메인 bot 생성 후·start 전) 1회 호출.
 *  bot 이 폴링 중이어야 callback_query 가 도착한다(등록 자체가 poll 의 allowed_updates 를 켬). */
export function registerMissionHitlCallback(bot: TelegramBot): () => void {
  // ★ P4 라이브 배선 수신(opt-in) — 리액션 수신은 후속(승인 카드는 consequential=버튼 강제라 콜백으로 충분).
  return bot.onCallbackQuery(async (q: TgCallbackQuery) => {
    // ★ P4 ux: 콜백 우선(opt-in) — 우리 UX 카드면 소비 후 종료(형제 핸들러 무간섭). 실패=기존 폴백.
    if (canUseUxAgent() && q.data.startsWith('ux:')) {
      try {
        const m = await import('./mission-ux-live.js');
        if (m.handleUxCallback(q.data, m.defaultUxConsumerDeps())) {
          try { await bot.answerCallbackQuery(q.id, { text: '✓ 반영됨' }); } catch { /* */ }
          return;
        }
      } catch { /* fail-soft → 기존 라우팅 */ }
    }
    // ★ R2 페이즈 리뷰 콜백(apm-phase:) — 승인/재구현(대표 2026-07-12). apm-hitl 보다 먼저 처리.
    const phaseParsed = parsePhaseCallbackData(q.data);
    if (phaseParsed) { await handlePhaseReviewTap(bot, q, phaseParsed); return; }
    // ★ P4 생애주기 콜백(apm-life:) — pause/resume/history(대표 2026-07-13·코드 배선·실 검증 나중).
    const lifeParsed = parseLifecycleCallbackData(q.data);
    if (lifeParsed) { await handleLifecycleTap(bot, q, lifeParsed); return; }
    // ★ B3 브리핑 콜백(apm-brief:) — 실집행 전 최종 브리핑 카드의 [승인/재조치/보류].
    const briefParsed = parseBriefingCallbackData(q.data);
    if (briefParsed) { await handleBriefingTap(bot, q, briefParsed); return; }
    // ★ Intake Q&A clarify 콜백(apm-clarify:) — 설계 확정 되묻기 옵션 탭(RFC-mission-intake-qa-agent).
    const clarifyParsed = parseClarifyCallbackData(q.data);
    if (clarifyParsed) { await handleClarifyTap(bot, q, clarifyParsed); return; }
    // 우리 소관(apm-hitl:)만 처리 — 아니면 조용히 무시(형제 핸들러 stomp 방지).
    if (!q.data.startsWith(`${PREFIX}:`)) return;
    const parsed = parseHitlCallbackData(q.data);
    if (!parsed) {
      debug.log('mission.hitl.tap-unparsed', q.data, { dataLen: q.data.length });
      return;
    }
    const missionId = resolveMissionByHitlToken(parsed.token);
    if (!missionId) {
      // 매칭 미션 없음 = 이미 처리됐거나 만료. 탭은 ack 해서 스피너는 지운다.
      debug.log('mission.hitl.tap-unmatched', parsed.token, { data: q.data });
      try { await bot.answerCallbackQuery(q.id, { text: '만료된 미션(이미 처리?)' }); } catch { /* best effort */ }
      return;
    }

    // ★ Opus 폴백 재분해(대표 2026-07-15) — Codex(sol) 분해가 2분 재시도 후에도 transient(520)로 실패 시,
    //   유료 Opus 로 재분해 스폰(HITL 승인 1회 소비). 골 정정 없이 모델만 스위치(comment 유지 목적으로 표식만).
    if (parsed.decision === 'opus-fallback') {
      const { DECOMPOSE_OPUS_MODEL } = await import('./mission-engine.js');
      const logPath = spawnMissionPrepare(missionId, {
        forceDecompose: true,
        comment: 'Opus 폴백 재분해(Codex transient 실패 후 대표 승인)',
        decomposeModel: DECOMPOSE_OPUS_MODEL,
      });
      debug.log('mission.hitl.opus-fallback', missionId, { model: DECOMPOSE_OPUS_MODEL, spawned: !!logPath });
      try { await bot.answerCallbackQuery(q.id, { text: `🧠 Opus(${DECOMPOSE_OPUS_MODEL})로 재분해 시작` }); } catch { /* */ }
      const origin = loadMissionOrigin(missionId);
      const tk = resolveTelegramBotToken(origin?.botId);
      if (tk && q.chatId !== undefined) {
        sendTelegramTo(tk, q.chatId, `🧠 Opus(${DECOMPOSE_OPUS_MODEL}·유료)로 재분해를 시작합니다 — 완료 시 새 HITL 확인 요청이 옵니다.`, origin?.threadId);
      }
      return;
    }

    // ★ BC3 역방향 피드백(대표 2026-07-16·원탭 HITL) — critique 치명 시 "🔁 자동 재분해" 탭 →
    //   critique 지적(pending-redecompose 슬롯 comment)을 reviseContext 로 decompose 재-spawn. 예산
    //   MAX_REDECOMPOSE 회(taps 누적·초과 시 se-mission-prepare 가 버튼 미노출). 집행=재분해(설계)만·arming 아님.
    if (parsed.decision === 'redecompose') {
      const { readPendingRedecompose, bumpRedecomposeTaps } = await import('./mission-pending-redecompose.js');
      const { MAX_REDECOMPOSE } = await import('./mission-build-coordinator-driver.js');
      const pending = readPendingRedecompose(missionId);
      const comment = pending?.comment ?? '분해 비평(critique) 치명 지적을 반영해 재분해하라.';
      const next = bumpRedecomposeTaps(missionId);
      const taps = next?.taps ?? 1;
      const logPath = spawnMissionPrepare(missionId, { forceDecompose: true, comment });
      try {
        const { recordMissionObservation } = await import('./mission-observation.js');
        recordMissionObservation({
          missionId, phaseId: 'build-coordinator', phaseTitle: 'BC3 재분해(critique 피드백)',
          stage: 'triage', verdict: 'inject', triageKind: 'redecompose',
          rationale: `critique→decompose 재분해 (탭 ${taps}/${MAX_REDECOMPOSE})`,
          refs: { spawned: !!logPath },
        });
      } catch { /* fail-soft */ }
      debug.log('mission.build.coordinator', 'redecompose-tap', { missionId, taps, max: MAX_REDECOMPOSE, spawned: !!logPath });
      try { await bot.answerCallbackQuery(q.id, { text: `🔁 비평 반영 재분해 시작 (${taps}/${MAX_REDECOMPOSE})` }); } catch { /* */ }
      const origin = loadMissionOrigin(missionId);
      const tk = resolveTelegramBotToken(origin?.botId);
      if (tk && q.chatId !== undefined) {
        sendTelegramTo(tk, q.chatId, `🔁 분해 비평을 반영해 재분해를 시작합니다 (${taps}/${MAX_REDECOMPOSE}) — 완료 시 새 HITL 확인 요청이 옵니다.`, origin?.threadId);
      }
      return;
    }

    // ★ 게이팅 revise 반복 시 Opus 재분해(대표 2026-07-17) — sol 재분해가 revise 반복(본질적 난제)일 때
    //   강력 모델(Opus)로 승격. 같은 terra 힌트(pending-redecompose 슬롯 comment) 반영 + Opus 모델. 예산 공유.
    if (parsed.decision === 'redecompose-opus') {
      const { readPendingRedecompose, bumpRedecomposeTaps } = await import('./mission-pending-redecompose.js');
      const { MAX_REDECOMPOSE } = await import('./mission-build-coordinator-driver.js');
      const { DECOMPOSE_OPUS_MODEL } = await import('./mission-engine.js');
      const pending = readPendingRedecompose(missionId);
      const comment = pending?.comment ?? '게이팅(terra) 지적을 반영해 재분해하라.';
      const next = bumpRedecomposeTaps(missionId);
      const taps = next?.taps ?? 1;
      const logPath = spawnMissionPrepare(missionId, { forceDecompose: true, comment, decomposeModel: DECOMPOSE_OPUS_MODEL });
      try {
        const { recordMissionObservation } = await import('./mission-observation.js');
        recordMissionObservation({
          missionId, phaseId: 'build-coordinator', phaseTitle: 'Opus 재분해(게이팅 revise)',
          stage: 'triage', verdict: 'inject', triageKind: 'redecompose-opus',
          rationale: `게이팅→Opus 재분해 (탭 ${taps}/${MAX_REDECOMPOSE}·${DECOMPOSE_OPUS_MODEL})`,
          refs: { spawned: !!logPath, model: DECOMPOSE_OPUS_MODEL },
        });
      } catch { /* fail-soft */ }
      debug.log('mission.build.coordinator', 'redecompose-opus-tap', { missionId, taps, max: MAX_REDECOMPOSE, model: DECOMPOSE_OPUS_MODEL, spawned: !!logPath });
      try { await bot.answerCallbackQuery(q.id, { text: `🧠 Opus(${DECOMPOSE_OPUS_MODEL})로 재분해 시작 (${taps}/${MAX_REDECOMPOSE})` }); } catch { /* */ }
      const origin = loadMissionOrigin(missionId);
      const tk = resolveTelegramBotToken(origin?.botId);
      if (tk && q.chatId !== undefined) {
        sendTelegramTo(tk, q.chatId, `🧠 Opus(${DECOMPOSE_OPUS_MODEL}·유료)로 재분해를 시작합니다 (${taps}/${MAX_REDECOMPOSE}) — 강력 모델이 게이팅 지적을 반영합니다. 완료 시 새 HITL 확인 요청이 옵니다.`, origin?.threadId);
      }
      return;
    }

    // ★ A6-b 성숙도 분리 원탭(RFC §8b) — 과대 미션을 핵심 M1 + 후속 proposed 미션으로 분리.
    //   비파괴: M1 카드/버튼은 그대로 두고(승인 계속 가능) 별도 확인 메시지만 보낸다. 후속=proposed(자동 실행 없음).
    if (parsed.decision === 'maturity-split') {
      const { TaskStore } = await import('../task-orchestrator/store.js');
      const { applyMaturitySplit } = await import('./mission-maturity.js');
      const store = new TaskStore();
      let r: { ok: boolean; reason: string; created: string[] };
      try { r = applyMaturitySplit(store, missionId); } finally { store.close(); }
      debug.log('mission.hitl.maturity-split', missionId, { ok: r.ok, created: r.created.length });
      try { await bot.answerCallbackQuery(q.id, { text: (r.ok ? `✂️ 후속 ${r.created.length}개 분리` : `분리 불가: ${r.reason}`).slice(0, 60) }); } catch { /* */ }
      const origin = loadMissionOrigin(missionId);
      const tk = resolveTelegramBotToken(origin?.botId);
      if (tk && q.chatId !== undefined) {
        const msg = r.ok
          ? `✂️ 성숙도 분리 — 후속 ${r.created.length}개 proposed 미션 생성(M1 종속·자동 실행 없음):\n${r.created.map((c) => `· ${c}`).join('\n')}\n원 미션(M1)은 위 카드에서 그대로 승인하세요.`
          : `ℹ️ 성숙도 분리 불가: ${r.reason}`;
        sendTelegramTo(tk, q.chatId, msg, origin?.threadId);
      }
      return;
    }

    // ── 정정(revise-*) — 프리셋 지시를 코멘트로 se-mission-prepare 재분해 스폰(대표 2026-07-12).
    //   승인/거절과 달리 미션 상태는 그대로(planning) 두고 재분해만 트리거 → 새 HITL 확인 요청.
    // 직접입력(revise-custom) — force_reply 로 자유 코멘트 요청. 답장은 handleIncoming 이 가로챈다.
    if (parsed.decision === 'revise-custom') {
      const origin = loadMissionOrigin(missionId);
      const botToken = resolveTelegramBotToken(origin?.botId);
      if (botToken && q.chatId !== undefined) {
        sendForceReplyTo(botToken, q.chatId, `✏️ 미션 정정 [apm-revise:${hitlToken(missionId)}]\n반영할 내용을 이 메시지에 답장으로 보내주세요.`, origin?.threadId);
      }
      debug.log('mission.hitl.revise-custom-prompt', missionId, {});
      try { await bot.answerCallbackQuery(q.id, { text: '✏️ 답장으로 입력' }); } catch { /* */ }
      return;
    }
    // ★ 자율 revise 원탭 승인(대표 2026-07-14) — recommender 초안을 승인/수정/취소. preset(revise-*)보다 먼저.
    if (parsed.decision === 'revise-apply') {
      const draft = readPendingRevise(missionId);
      try { await bot.answerCallbackQuery(q.id, { text: (draft ? '✅ 정정 집행' : '초안 만료(다시 요청)').slice(0, 60) }); } catch { /* */ }
      if (!draft) {
        if (q.chatId !== undefined && q.messageId !== undefined) {
          try { await bot.editMessageText(q.chatId, q.messageId, `⌛ 정정 초안이 만료됐습니다 — 맥락을 다시 보내 새 추천을 받으세요.\n${missionId}`); } catch { /* */ }
          try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
        }
        return;
      }
      debug.log('mission.hitl.revise-apply', missionId, { comment: draft.comment.slice(0, 60) });
      clearPendingRevise(missionId);
      await applyRevise(missionId, draft.comment);
      if (q.chatId !== undefined && q.messageId !== undefined) {
        try { await bot.editMessageText(q.chatId, q.messageId, `🔧 정정 반영 중(승인): "${draft.comment.slice(0, 60)}"\n재분해 후 새 확인 요청을 보냅니다.\n${missionId}`); } catch { /* */ }
        try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
      }
      return;
    }
    if (parsed.decision === 'revise-edit') {
      // 수정 — 대표가 최종 정정 문구를 직접입력(추천 우회). apm-revise-final 마커로 답장 가로챔.
      const origin = loadMissionOrigin(missionId);
      const botToken = resolveTelegramBotToken(origin?.botId);
      if (botToken && q.chatId !== undefined) {
        sendForceReplyTo(botToken, q.chatId, `✏️ 정정 문구 직접 입력 [apm-revise-final:${hitlToken(missionId)}]\n최종 정정 지시를 이 메시지에 답장으로 보내주세요(추천 우회·그대로 반영).`, origin?.threadId);
      }
      debug.log('mission.hitl.revise-edit-prompt', missionId, {});
      try { await bot.answerCallbackQuery(q.id, { text: '✏️ 답장으로 입력' }); } catch { /* */ }
      return;
    }
    if (parsed.decision === 'revise-cancel') {
      clearPendingRevise(missionId);
      if (q.chatId !== undefined) clearPendingReviseContext(q.chatId);
      debug.log('mission.hitl.revise-cancel', missionId, {});
      try { await bot.answerCallbackQuery(q.id, { text: '❌ 취소됨' }); } catch { /* */ }
      if (q.chatId !== undefined && q.messageId !== undefined) {
        try { await bot.editMessageText(q.chatId, q.messageId, `❌ 정정 취소 — 골 유지(재분해 안 함).\n${missionId}`); } catch { /* */ }
        try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
      }
      return;
    }
    if (parsed.decision === 'revise-pick') {
      // 모호 해소 선택 — 이 미션으로 확정 -> 보관된 원 요청 맥락으로 추천 카드 생성.
      debug.log('mission.hitl.revise-pick', missionId, {});
      try { await bot.answerCallbackQuery(q.id, { text: '✏️ 미션 선택됨' }); } catch { /* */ }
      const userContext = (q.chatId !== undefined ? readPendingReviseContext(q.chatId) : null) || '이 미션을 개정';
      if (q.chatId !== undefined) clearPendingReviseContext(q.chatId);
      if (q.chatId !== undefined && q.messageId !== undefined) {
        try { await bot.editMessageText(q.chatId, q.messageId, `✏️ 선택: ${missionId}\n정정 추천 생성 중...`); } catch { /* */ }
        try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
      }
      if (q.chatId !== undefined) {
        const origin = loadMissionOrigin(missionId);
        const presented = await presentReviseCard(missionId, userContext, { chatId: q.chatId, ...(origin?.threadId !== undefined ? { threadId: origin.threadId } : {}) }, bot);
        if (!presented) { try { await bot.editMessageText(q.chatId, q.messageId!, `ℹ️ 지금 골 정정 불필요로 판단(근거 부족). 구체 지시로 다시 요청해 주세요.\n${missionId}`); } catch { /* */ } }
      }
      return;
    }
    if (parsed.decision.startsWith('revise-')) {
      const preset = HITL_REVISE_PRESETS.find((p) => p.action === parsed.decision);
      if (!preset) { try { await bot.answerCallbackQuery(q.id, { text: '알 수 없는 정정' }); } catch { /* */ } return; }
      debug.log('mission.hitl.revise', missionId, { action: parsed.decision });
      // ★ 실행 상황 인지(대표 지시 2026-07-12) — 재분해가 "왜 축소/정정하는지"(어떤 페이즈가 왜
      //   실패했는지)를 스스로 알도록, 실행 컨텍스트를 정정 코멘트에 실어 보낸다. 실패 페이즈가
      //   없으면 제네릭(빈 컨텍스트) — 기존 동작 유지.
      let reviseComment = preset.comment;
      try { const ctx = buildMissionExecutionContext(missionId); if (ctx) reviseComment = `${preset.comment}\n\n${ctx}`; } catch { /* fail-soft */ }
      try { spawnMissionPrepare(missionId, { comment: reviseComment }); } catch { /* fail-soft */ }
      try { await bot.answerCallbackQuery(q.id, { text: `✏️ ${preset.label}` }); } catch { /* */ }
      if (q.chatId !== undefined && q.messageId !== undefined) {
        try { await bot.editMessageText(q.chatId, q.messageId, `🔧 정정 반영 중: ${preset.label}\n재분해 후 새 확인 요청을 보냅니다.\n${missionId}`); } catch { /* */ }
        try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
      }
      return;
    }

    // ── rerun — 미션 유지·처음부터 재실행(대표 2026-07-12). 페이즈 backlog 리셋 + run-mission
    //   재spawn. 승인/거절과 달리 미션 상태(running) 유지. 특정 페이즈부터는 CLI(--from).
    if (parsed.decision === 'rerun') {
      debug.log('mission.hitl.rerun', missionId, {});
      try { await bot.answerCallbackQuery(q.id, { text: '🔄 처음부터 재실행 시작…' }); } catch { /* */ }
      let r: { ok: boolean; reset: number; total: number; error?: string; generation?: number };
      try { r = rerunMission(missionId); }
      catch (e) { r = { ok: false, reset: 0, total: 0, error: e instanceof Error ? e.message : String(e) }; }
      // 세대(대표 2026-07-12) — 재실행 문맥을 UX 에 표면화. 이전 세대는 rerunHistory 에 보관됨.
      const genLabel = r.generation && r.generation > 0 ? ` · 세대 ${r.generation}` : '';
      if (q.chatId !== undefined && q.messageId !== undefined) {
        const msg = r.ok
          ? `🔄 처음부터 재실행${genLabel} — ${r.reset} 페이즈 리셋·집행 시작\n(이전 세대는 히스토리에 보관됨)\n${missionId}`
          : `❌ 재실행 실패: ${r.error ?? ''}\n${missionId}`;
        try { await bot.editMessageText(q.chatId, q.messageId, msg); } catch { /* */ }
        if (r.ok) { try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ } }
      }
      return;
    }

    // ── rereflect — 완료 후 비평 재반영(대표 2026-07-12). 자동 비평 지적([CRITIQUE])이 있는
    //   페이즈만 골라 재구현(지적→[REBUILD] 승격·이전 PR close·backlog 리셋). clean 페이즈는 유지.
    if (parsed.decision === 'rereflect') {
      debug.log('mission.hitl.rereflect', missionId, {});
      // ★ 즉시 응답(대표 2026-07-12) — 버튼 반응 지연 해소. 작업 전 먼저 ack, 결과는 edit 로.
      try { await bot.answerCallbackQuery(q.id, { text: '🔧 비평 재반영 시작…' }); } catch { /* */ }
      let r: { ok: boolean; rebuilt: number; phases: string[]; error?: string };
      try { r = rebuildCritiquedPhases(missionId); }
      catch (e) { r = { ok: false, rebuilt: 0, phases: [], error: e instanceof Error ? e.message : String(e) }; }
      if (q.chatId !== undefined && q.messageId !== undefined) {
        const msg = r.ok
          ? `🔧 비평 재반영 — 지적된 ${r.rebuilt}개 페이즈 재구현 시작(기존 PR 재활용·같은 PR 업데이트·머지는 HITL):\n${r.phases.map((t) => `· ${t}`).join('\n')}\n${missionId}`
          : `❌ 재반영 실패: ${r.error ?? ''}\n${missionId}`;
        try { await bot.editMessageText(q.chatId, q.messageId, msg); } catch { /* */ }
        if (r.ok) { try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ } }
      }
      return;
    }

    // ── merge — 완료 후 clean PR 반영(머지·대표 2026-07-12). 비평 지적 없는 PR 만 squash 머지.
    //   비평 FAIL/WARN 페이즈는 머지 안 함(재반영 먼저·안전). 대표 버튼 트리거(unattended 아님).
    if (parsed.decision === 'merge') {
      debug.log('mission.hitl.merge', missionId, {});
      try { await bot.answerCallbackQuery(q.id, { text: '✅ clean PR 머지 시작…' }); } catch { /* */ }
      let r: { ok: boolean; merged: number; prs: string[]; skipped: number; error?: string };
      try { r = mergeMissionPhases(missionId); }
      catch (e) { r = { ok: false, merged: 0, prs: [], skipped: 0, error: e instanceof Error ? e.message : String(e) }; }
      if (q.chatId !== undefined && q.messageId !== undefined) {
        const msg = r.ok
          ? `✅ 반영(머지) — clean PR ${r.merged}개 squash 머지 완료:\n${r.prs.map((u) => `· ${u}`).join('\n')}\n(비평 지적 페이즈는 재반영 먼저)\n${missionId}`
          : `❌ 머지 실패: ${r.error ?? ''}\n${missionId}`;
        try { await bot.editMessageText(q.chatId, q.messageId, msg); } catch { /* */ }
        if (r.ok) { try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ } }
      }
      return;
    }

    const approve = parsed.decision === 'approve';
    debug.log('mission.hitl.resolve', missionId, { decision: parsed.decision, via: 'telegram' });

    // 공유 write — PWA/CLI 와 동일한 approveMission/cancelMission. 멱등 가드는 그 안에서.
    let ok = false;
    let errMsg = '';
    let summary = ''; // ★ 승인 시 "어떻게 해석해 넣었는지" 피드백(예약 vs 즉시실행 오해 방지).
    try {
      if (approve) {
        const r = await approveMission(missionId);
        if (r.error) errMsg = r.error;
        else { ok = true; summary = describeApproval(r); }
      } else {
        const r = await cancelMission(missionId, { defer: true }); // 거절=보류(record 유지·완전삭제는 /mission_del)
        const rr = r as { error?: unknown } | undefined;
        if (rr && typeof rr.error === 'string' && rr.error.length > 0) errMsg = rr.error;
        else ok = true;
      }
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }

    if (!ok) {
      debug.log('mission.hitl.resolve-failed', missionId, { errMsg }, { level: 'error' });
      try { await bot.answerCallbackQuery(q.id, { text: `처리 안됨(이미 처리?): ${errMsg.slice(0, 60)}` }); } catch { /* best effort */ }
      return;
    }

    // 성공 — 토스트 + 메시지 edit + 버튼 제거(이 탭이 왔던 메시지 좌표를 그대로 사용).
    //   ★ 승인은 "어떻게 해석해 넣었는지"(summary)를 함께 표시 — 예약 vs 즉시실행 오해 방지(대표 2026-07-12).
    const label = approve ? '✅ 승인됨' : '⏸️ 보류됨 (기록 유지 · 완전삭제는 /mission_del)';
    const body = approve && summary ? `\n${summary}` : '';
    try { await bot.answerCallbackQuery(q.id, { text: approve ? '✓ 승인' : '⏸️ 보류' }); } catch { /* best effort */ }
    if (q.chatId !== undefined && q.messageId !== undefined) {
      try { await bot.editMessageText(q.chatId, q.messageId, `${label} — via 텔레그램${body}\n${missionId}`); } catch { /* best effort */ }
      try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* best effort */ }
    }
  });
}

/** 정정 집행 — revise 단일 창구(mission-tool revise) 재사용(archive+워킹메모리 리셋+실패컨텍스트+
 *  spawnMissionPrepare). 원탭 승인·직접입력이 공유. fail-soft(집행 실패가 콜백을 막지 않음). */
async function applyRevise(missionId: string, comment: string): Promise<void> {
  try {
    const { dispatchAutopilotMissions } = await import('./mission-tool.js');
    await dispatchAutopilotMissions({ action: 'revise', id: missionId, comment });
  } catch { /* fail-soft */ }
}

/** 추천 -> 초안 저장 -> 자각 기록(provenance=self) -> 원탭 승인 카드 발송. 두 진입점(force_reply
 *  맥락·NL 인텐트)이 공유. 추천이 불필요/빈 초안/실패면 false(호출측이 폴백 결정). 카드 발송이면 true. */
async function presentReviseCard(
  missionId: string, userContext: string,
  ctx: { chatId: number; threadId?: number },
  bot: { sendMessage: (chatId: number, text: string, opts?: { threadId?: number }) => Promise<unknown> },
  opts: { classify?: (prompt: string) => Promise<string>; hint?: string } = {},
): Promise<boolean> {
  const classify = opts.classify ?? (process.env.NODE_ENV === 'test' ? undefined : reviseClassifyDefault);
  let rec;
  try { ({ recommendation: rec } = await recommendRevise(missionId, { userContext }, classify ? { classify } : {})); }
  catch { rec = undefined; }
  if (!rec || !rec.shouldRevise || !rec.comment.trim()) return false;

  savePendingRevise(missionId, { comment: rec.comment, reviseKind: rec.reviseKind, rationale: rec.rationale, confidence: rec.confidence, source: rec.source });
  try {
    coordinatorRecordMemory(missionId, {
      phaseId: `revise-suggest:${missionId}`, phaseTitle: '자율 revise 추천', kind: 'operational',
      summary: `[revise-추천] 맥락 "${userContext.slice(0, 80)}" -> ${reviseKindLabel(rec.reviseKind)}: ${rec.comment.slice(0, 120)}`,
      reusables: [], decisions: [`revise 추천(${rec.source}): ${rec.reviseKind}`], artifacts: [], provenance: 'self',
    });
  } catch { /* fail-soft */ }

  const origin = loadMissionOrigin(missionId);
  // 테스트 격리(repo 패턴·spawnMissionPrepare 동형) — 실 텔레그램 발송 대신 bot.sendMessage 폴백.
  const botToken = process.env.NODE_ENV === 'test' ? null : resolveTelegramBotToken(origin?.botId);
  const card = buildReviseConfirmCard(missionId, {
    comment: rec.comment, reviseKindLabel: reviseKindLabel(rec.reviseKind),
    confidence: rec.confidence, rationale: rec.rationale, source: rec.source,
  });
  const text = opts.hint ? `${opts.hint}\n${card.text}` : card.text;
  if (botToken) sendTelegramButtonsTo(botToken, ctx.chatId, text, card.buttons, ctx.threadId);
  else { try { await bot.sendMessage(ctx.chatId, text, { threadId: ctx.threadId }); } catch { /* */ } }
  return true;
}

/** force_reply 정정 답장 가로채기 — telegram.ts handleIncoming 이 dynamic import 로 호출(Step B).
 *  두 마커를 처리한다(대표 2026-07-14·자율 revise):
 *   · apm-revise-final:<token>  = 대표가 정확한 정정 문구 직접입력(수정 버튼) -> recommender 우회·직접 집행.
 *   · apm-revise:<token>        = 대표가 자유 맥락 -> recommender 가 정정 프롬프트 자동 생성 -> 원탭 승인 카드.
 *  추천이 "정정 불필요/빈 초안"이면 맥락을 그대로 반영(현행 동작 degrade). fail-soft. */
/** ★ Intake 자유 피드백 답장 가로채기(RFC P4·2026-07-17) — [✏️ 직접 수정] force-reply 답장.
 *  마커 apm-clarify-edit:<token>. 교정 텍스트를 sol judge 에 재투입해 **현재 단계** 질문/추천을 다시
 *  마름질하고 새 카드 발송. 예산 MAX 2(무한 교정 방지). 순서 의존 유지(stage2=arc·확정범위 주입).
 *  telegram handleIncoming 이 tryInterceptMissionRevise 최상단에서 호출. fail-soft. */
export async function tryInterceptClarifyFeedback(
  ctx: { replyToText?: string; text: string; chatId: number; threadId?: number },
  bot: { sendMessage: (chatId: number, text: string, opts?: { threadId?: number }) => Promise<unknown> },
): Promise<boolean> {
  const token = ctx.replyToText?.match(/apm-clarify-edit:([a-z0-9]+)/i)?.[1];
  if (!token) return false;
  const missionId = resolveMissionByHitlToken(token);
  if (!missionId) return false;
  const feedback = ctx.text.trim();
  if (!feedback) return false;
  const pending = readPendingClarify(missionId);
  if (!pending || !pending.goal) {
    try { await bot.sendMessage(ctx.chatId, '만료된 되묻기 — 이미 확정됐거나 취소됐습니다.', { threadId: ctx.threadId }); } catch { /* */ }
    return true;
  }
  const used = pending.refineCount ?? 0;
  if (used >= 2) {
    try { await bot.sendMessage(ctx.chatId, '수정 횟수(2회)를 다 썼습니다 — 카드에서 선택/진행으로 마무리해주세요.', { threadId: ctx.threadId }); } catch { /* */ }
    return true;
  }
  debug.log('mission.intake.feedback', missionId, { phase: 'apply', refineCount: used, fb: feedback.slice(0, 60) });
  try {
    const phase: 'scope' | 'arc' = pending.stage === 2 ? 'arc' : 'scope';
    const confirmedScope = pending.stage === 2 && pending.priorAnswers
      ? foldAnswersIntoDesign(pending.goal, pending.priorAnswers).scope : undefined;
    const newQs = await analyzeGoalAmbiguity(pending.goal, {
      heavy: pending.heavy === true, phase, feedback,
      ...(confirmedScope && confirmedScope.length ? { confirmedScope } : {}),
    }, { missionId });
    if (newQs.length === 0) {
      try { await bot.sendMessage(ctx.chatId, '교정 반영 결과 되물을 게 없어졌습니다 — 카드에서 [전체 추천대로 진행]으로 확정하세요.', { threadId: ctx.threadId }); } catch { /* */ }
      return true;
    }
    savePendingClarify(missionId, { ...pending, clarifications: newQs, refineCount: used + 1 });
    const origin = loadMissionOrigin(missionId);
    const tk = origin ? resolveTelegramBotToken(origin.botId) : null;
    if (tk && origin?.channel === 'telegram' && origin.chatId !== undefined) {
      const { questions, control } = buildClarifyMessages(newQs, hitlToken(missionId));
      try { await bot.sendMessage(origin.chatId, `✏️ 교정 반영: "${feedback.slice(0, 60)}" → 다시 마름질했습니다(수정 ${used + 1}/2).`, { threadId: origin.threadId }); } catch { /* */ }
      for (const qq of questions) { sendTelegramButtonsTo(tk, origin.chatId, qq.text, qq.buttons, origin.threadId); await new Promise((r) => setTimeout(r, 350)); }
      const controlId = sendTelegramButtonsTo(tk, origin.chatId, control.text, control.buttons, origin.threadId);
      if (controlId) setClarifyControlMessage(missionId, controlId);
    }
  } catch (e) {
    debug.log('mission.intake.feedback', missionId, { phase: 'error', error: e instanceof Error ? e.message.slice(0, 100) : '' });
    try { await bot.sendMessage(ctx.chatId, '교정 반영 중 오류 — 카드에서 선택/진행으로 마무리해주세요.', { threadId: ctx.threadId }); } catch { /* */ }
  }
  return true;
}

export async function tryInterceptMissionRevise(
  ctx: { replyToText?: string; text: string; chatId: number; threadId?: number },
  bot: { sendMessage: (chatId: number, text: string, opts?: { threadId?: number }) => Promise<unknown> },
  deps: { classify?: (prompt: string) => Promise<string> } = {},
): Promise<boolean> {
  // ★ P4 — Intake 자유 피드백 답장 먼저(clarify-edit 마커). 처리하면 revise 로 안 샘.
  if (await tryInterceptClarifyFeedback(ctx, bot)) return true;
  const notifyApplying = async (comment: string) => {
    try { await bot.sendMessage(ctx.chatId, `🔧 정정 반영 중: "${comment.slice(0, 60)}"\n재분해 후 새 확인 요청을 보냅니다.`, { threadId: ctx.threadId }); } catch { /* */ }
  };

  // (0) ★ B3 브리핑 재조치 경로 — 브리핑 [✏️ 재조치] 답장. 결정 패브릭으로 라우팅: 결정 의도면
  //   recordMissionDecision(3박자·재분해 없음), 아니면 자유형식 재조정으로 applyRevise. 덜 충족된
  //   부분을 대표가 자유롭게 지시하는 마지막 관문(PLAN §4).
  const briefToken = ctx.replyToText?.match(/apm-brief-react:([a-z0-9]+)/i)?.[1];
  if (briefToken) {
    const missionId = resolveMissionByHitlToken(briefToken);
    if (!missionId) return false;
    const text = ctx.text.trim();
    if (!text) return false;
    const intent = detectMissionDecisionIntent(text);
    if (intent.isIntent) {
      const recorded = recordMissionDecision(missionId, {
        kind: intent.kind ?? 'scope-note', note: text, actor: `telegram:${ctx.chatId}`,
        ...(intent.appliesTo ? { appliesTo: intent.appliesTo } : {}),
      });
      debug.log('mission.briefing.react-decision', missionId, { recorded: recorded.slice(0, 80) });
      try { await bot.sendMessage(ctx.chatId, `🧭 브리핑 재조치 → 결정 기록됨 (${missionId})\n${recorded}\n↳ 워킹메모리+logs.db+기억 반영 — 후속 판단이 이 결정을 전제. (되돌리려면 다른 결정으로 supersede)`, { threadId: ctx.threadId }); } catch { /* */ }
    } else {
      debug.log('mission.briefing.react-revise', missionId, { ctx: text.slice(0, 60) });
      await applyRevise(missionId, text);
      await notifyApplying(text);
    }
    return true;
  }

  // (1) 직접입력(수정) 경로 — 정확한 문구를 그대로 집행(추천 우회).
  const finalToken = ctx.replyToText?.match(/apm-revise-final:([a-z0-9]+)/i)?.[1];
  if (finalToken) {
    const missionId = resolveMissionByHitlToken(finalToken);
    if (!missionId) return false;
    const comment = ctx.text.trim();
    if (!comment) return false;
    debug.log('mission.hitl.revise-final', missionId, { comment: comment.slice(0, 60) });
    clearPendingRevise(missionId);
    await applyRevise(missionId, comment);
    await notifyApplying(comment);
    return true;
  }

  // (2) 맥락 경로 — recommender 가 정정 프롬프트 자동 생성 -> 원탭 승인 카드.
  const token = ctx.replyToText?.match(/apm-revise:([a-z0-9]+)/i)?.[1];
  if (!token) return false;
  const missionId = resolveMissionByHitlToken(token);
  if (!missionId) return false;
  const userContext = ctx.text.trim();
  if (!userContext) return false;
  debug.log('mission.hitl.revise-context', missionId, { ctx: userContext.slice(0, 60) });

  const presented = await presentReviseCard(missionId, userContext, ctx, bot, deps.classify ? { classify: deps.classify } : {});
  if (!presented) {
    // 추천 실패/불필요/빈 초안 -> 맥락 그대로 직접 반영(degrade·현행 동작 보존·대표가 명시 답장한 경로).
    await applyRevise(missionId, userContext);
    await notifyApplying(userContext);
  }
  return true;
}

/** ★ 미션 정정 자연어 인텐트 가로채기(대표 2026-07-14·NL 라우터·세 번째 다리) — force_reply 마커
 *  없이도 "이 미션 개정해줘" 류 자유텍스트를 최근 활성 미션 대상으로 recommender->원탭 카드.
 *  telegram.ts handleIncoming 이 LLM 턴 전에 호출. 오발 방지: detectReviseIntent 게이트 통과 +
 *  채팅방 활성 미션 존재 시에만 하이재킹. 그 외엔 false(일반 LLM 처리로 폴백). fail-soft. */
/**
 * ★ 미션 결정 자연어 인텐트(Layer 3·RFC-mission-decision-injection·2026-07-15) — "이 아크 criterion 2는
 * arming 으로 미뤄" "완주 경계는 A2 까지" 류 자유텍스트를 recordMissionDecision(3박자)로 기록+확인.
 * 결정은 저위험·가역(supersede)이라 원탭 카드 없이 기록+확인. revise 동사는 detector 가 제외(중복 없음).
 * 반환 true=가로챔. 모호(2건+)면 false 로 폴백(하이재킹 안 함).
 */
export async function tryInterceptMissionDecisionIntent(
  ctx: { text: string; chatId: number; threadId?: number },
  bot: { sendMessage: (chatId: number, text: string, opts?: { threadId?: number }) => Promise<unknown> },
  deps: { resolve?: (chatId: number) => { missionId: string | null; candidates: ActiveMissionCandidate[] }; recentMission?: (chatId: number) => string | null } = {},
): Promise<boolean> {
  const resolve = deps.resolve ?? ((cid: number) => resolveActiveMissionForChat(cid));
  const result = routeMissionDecisionUtterance(
    { text: ctx.text, chatId: ctx.chatId, actor: `telegram:${ctx.chatId}` },
    { resolve, record: recordMissionDecision, recentMission: deps.recentMission ?? getRecentChatMission },
  );
  if (!result.handled) return false;
  debug.log('mission.hitl.decision-intent', result.missionId ?? '?', { recorded: (result.recorded ?? '').slice(0, 80) });
  try {
    await bot.sendMessage(ctx.chatId, `🧭 미션 결정 기록됨 (${result.missionId})\n${result.recorded}\n↳ 워킹메모리+logs.db+기억에 반영 — 후속 페이즈·triage 가 이 결정을 전제로 판단. (되돌리려면 다른 결정으로 supersede)`, { ...(ctx.threadId ? { threadId: ctx.threadId } : {}) });
  } catch { /* fail-soft */ }
  return true;
}

export async function tryInterceptMissionReviseIntent(
  ctx: { text: string; chatId: number; threadId?: number },
  bot: { sendMessage: (chatId: number, text: string, opts?: { threadId?: number }) => Promise<unknown> },
  deps: {
    classify?: (prompt: string) => Promise<string>;
    resolve?: (chatId: number) => { missionId: string | null; candidates: ActiveMissionCandidate[] };
    recentMission?: (chatId: number) => string | null;
  } = {},
): Promise<boolean> {
  const intent = detectReviseIntent(ctx.text);
  if (!intent.isIntent) return false;
  const userContext = ctx.text.trim();
  const classifyOpt = deps.classify ? { classify: deps.classify } : {};

  // 1) 명시 apm_id 최우선 — 대화 맥락/recency 무시.
  if (intent.explicitId) {
    debug.log('mission.hitl.revise-intent', intent.explicitId, { via: 'explicit-id', text: userContext.slice(0, 60) });
    return presentReviseCard(intent.explicitId, userContext, ctx, bot, classifyOpt);
  }

  const resolve = deps.resolve ?? ((cid: number) => resolveActiveMissionForChat(cid));
  const { candidates } = resolve(ctx.chatId);
  if (candidates.length === 0) return false; // 이 방에 활성 미션 없음 -> LLM 폴백(하이재킹 안 함)

  // 2) 맥락-인지 — 이 방에서 방금 논의한 미션이 활성 후보 중에 있으면 recency 보다 우선(대표 2026-07-14).
  const recent = (deps.recentMission ?? getRecentChatMission)(ctx.chatId);
  const recentMatch = recent ? candidates.find((c) => c.id === recent) : undefined;
  if (recentMatch) {
    debug.log('mission.hitl.revise-intent', recentMatch.id, { via: 'recent-mention', text: userContext.slice(0, 60) });
    return presentReviseCard(recentMatch.id, userContext, ctx, bot, classifyOpt);
  }

  // 3) 활성 미션 단 1건 -> 그대로 추천.
  if (candidates.length === 1) {
    debug.log('mission.hitl.revise-intent', candidates[0]!.id, { via: 'single-active', text: userContext.slice(0, 60) });
    return presentReviseCard(candidates[0]!.id, userContext, ctx, bot, classifyOpt);
  }

  // 4) 모호(2건+·맥락 없음) -> recency 로 찍지 말고 선택 카드(대표 2026-07-14). 원 요청 맥락 보관.
  savePendingReviseContext(ctx.chatId, userContext);
  const card = buildReviseDisambiguationCard(candidates);
  const origin = loadMissionOrigin(candidates[0]!.id);
  const botToken = process.env.NODE_ENV === 'test' ? null : resolveTelegramBotToken(origin?.botId);
  if (botToken) sendTelegramButtonsTo(botToken, ctx.chatId, card.text, card.buttons, ctx.threadId);
  else { try { await bot.sendMessage(ctx.chatId, card.text, { threadId: ctx.threadId }); } catch { /* */ } }
  debug.log('mission.hitl.revise-disambiguate', String(ctx.chatId), { candidates: candidates.length });
  return true;
}

/** ★ P4(대표 2026-07-13·미션 생애주기) — 생애주기 버튼 탭(pause/resume/history). 코드 배선(실 검증 나중). */
async function handleLifecycleTap(bot: TelegramBot, q: TgCallbackQuery, parsed: { token: string; action: LifecycleAction }): Promise<void> {
  const missionId = resolveMissionByHitlToken(parsed.token);
  if (!missionId) { try { await bot.answerCallbackQuery(q.id, { text: '만료된 미션(이미 처리?)' }); } catch { /* */ } return; }
  const { pauseMission, resumeMission, getMissionRevisions } = await import('./mission-lifecycle.js');
  if (parsed.action === 'pause') {
    pauseMission(missionId);
    try { await bot.answerCallbackQuery(q.id, { text: '⏸️ 일시정지 — 다음 페이즈 전 중단(상태 보존)' }); } catch { /* */ }
  } else if (parsed.action === 'resume') {
    resumeMission(missionId);
    try { await bot.answerCallbackQuery(q.id, { text: '▶️ 재개 — 남은 페이즈 재실행' }); } catch { /* */ }
  } else {
    const rev = getMissionRevisions(missionId);
    const origin = loadMissionOrigin(missionId);
    const botToken = resolveTelegramBotToken(origin?.botId);
    if (botToken && q.chatId !== undefined) sendTelegramTo(botToken, q.chatId, renderRevisionHistory(rev), origin?.threadId);
    try { await bot.answerCallbackQuery(q.id, { text: '📜 히스토리' }); } catch { /* */ }
  }
}

/**
 * 승인 후 다음 단계 안내 텍스트 — 미션 domain 별(대표 2026-07-16). 코어(elanous) 미션엔 '매매
 * 안전관문' 같은 투자 전용 문구를 붙이지 않는다(종전엔 모든 미션에 mandate arming 문구가 나와
 * 코어 미션에 '이상한 이야기'였다). 순수·테스트가능.
 */
export function approvalNextStepText(missionId: string, domain: string | null): string {
  if (domain === 'investment' || domain === 'finance') {
    return `⚠️ 실 arming(자율 매매)은 mandate 안전관문(별도 HITL): \`elanous autopilot arm ${missionId}\``;
  }
  return `▶️ 빌드 착수: \`elanous autopilot approve ${missionId}\` (아크 순차 실행) · arming/파괴는 별도 HITL`;
}

/** 미션 domain 을 읽어 approvalNextStepText 반환. fail-soft(도메인 못 읽으면 코어 안내). */
function missionApprovalNextStep(missionId: string): string {
  let domain: string | null = null;
  try { const db = openAutopilotMissionsDb(); domain = getMission(db, missionId)?.domain ?? null; db.close(); } catch { /* fail-soft */ }
  return approvalNextStepText(missionId, domain);
}

/** ★ B3 브리핑 카드 탭 — 실집행 전 최종 브리핑의 [✅승인][✏️재조치][❌보류].
 *   · arm  = 결정 기록(boundary) + 카드 보존 + domain-aware 다음 단계 안내(여기서 실무장 아님).
 *   · react= force_reply(자유형식) → 답장이 결정 패브릭(detect→record/revise)으로 라우팅.
 *   · hold = 결정 기록(defer·보류) + 미션 유지(재조정 대기). */
async function handleBriefingTap(bot: TelegramBot, q: TgCallbackQuery, parsed: { token: string; action: BriefingAction }): Promise<void> {
  const missionId = resolveMissionByHitlToken(parsed.token);
  if (!missionId) { try { await bot.answerCallbackQuery(q.id, { text: '만료된 미션(이미 처리?)' }); } catch { /* */ } return; }
  debug.log('mission.briefing.tap', missionId, { action: parsed.action });
  const actor = `telegram:${q.chatId ?? '?'}`;
  if (parsed.action === 'arm') {
    recordMissionDecision(missionId, { kind: 'boundary', note: '브리핑 검토 후 실집행 최종 승인', rationale: '대표 브리핑 승인(실집행 경계)', actor });
    try { await bot.answerCallbackQuery(q.id, { text: '✅ 승인 접수' }); } catch { /* */ }
    if (q.chatId !== undefined && q.messageId !== undefined) {
      // ★ 카드(아크·분해 계획) 보존(대표 2026-07-16) — 종전엔 editMessageText 로 카드를 minimal ack 로
      //   덮어써 아크/분해 내용이 사라졌다. 이제 버튼만 제거하고 승인 확인을 별도 메시지로 append.
      try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
      const origin = loadMissionOrigin(missionId);
      const botToken = resolveTelegramBotToken(origin?.botId);
      if (botToken) {
        try { sendTelegramTo(botToken, q.chatId, `✅ 최종 승인 접수 — 브리핑 검토 완료. 결정 기록됨(관측·기억).\n${missionApprovalNextStep(missionId)}`, origin?.threadId); } catch { /* */ }
      }
    }
    return;
  }
  if (parsed.action === 'hold') {
    recordMissionDecision(missionId, { kind: 'defer', note: '브리핑 검토 후 실집행 보류', rationale: '대표 보류(추가 조정 대기)', actor });
    try { await bot.answerCallbackQuery(q.id, { text: '❌ 보류' }); } catch { /* */ }
    if (q.chatId !== undefined && q.messageId !== undefined) {
      try { await bot.editMessageText(q.chatId, q.messageId, `❌ 실집행 보류 — 결정 기록됨. 미션은 유지(재조정 대기).\n필요 시 [✏️ 재조치]로 자유롭게 지시하거나 \`elanous autopilot briefing ${missionId}\` 로 다시 점검하세요.\n${missionId}`); } catch { /* */ }
      try { await bot.clearMessageReplyMarkup(q.chatId, q.messageId); } catch { /* */ }
    }
    return;
  }
  // react — 자유형식 재조치. force_reply 로 받아 답장이 결정 패브릭으로 라우팅(apm-brief-react 마커).
  const origin = loadMissionOrigin(missionId);
  const botToken = resolveTelegramBotToken(origin?.botId);
  if (botToken && q.chatId !== undefined) {
    sendForceReplyTo(botToken, q.chatId, `✏️ 브리핑 재조치 [apm-brief-react:${hitlToken(missionId)}]\n덜 충족된 부분을 자유롭게 지시하세요(예: "canary 아크는 arming 으로 미뤄" · "이 감사는 통과로 확인" · "범위를 좁혀 재분해"). 결정/정정으로 자동 라우팅됩니다.`, origin?.threadId);
  }
  try { await bot.answerCallbackQuery(q.id, { text: '✏️ 답장으로 입력' }); } catch { /* */ }
}

/** 미션 생애주기(revision) → 텔레그램 텍스트(순수). */
function renderRevisionHistory(
  rev: { currentGeneration: number; currentGoal?: string; history: readonly { generation: number; reason: string; goal?: string; phases: readonly { status: string; title: string }[] }[] } | null,
): string {
  if (!rev) return '📜 히스토리 없음(미션 미발견).';
  const lines = [`📜 미션 생애주기 — 현재 gen ${rev.currentGeneration} · 보관 ${rev.history.length}세대`];
  for (const s of rev.history) {
    lines.push(`── gen ${s.generation} [${s.reason}]${s.goal ? ` · ${s.goal.slice(0, 40)}` : ''}`);
    s.phases.forEach((p, i) => lines.push(`   ${i}. [${p.status}] ${p.title.slice(0, 36)}`));
  }
  if (rev.currentGoal) lines.push(`── 현재 gen ${rev.currentGeneration}: ${rev.currentGoal.slice(0, 40)}`);
  return lines.join('\n');
}
