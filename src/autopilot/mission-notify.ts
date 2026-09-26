// ── 미션 origin 되돌림 발송 (대표 지시 2026-07-11 · 채널 정정) ────────────────
//
// 미션 준비 완료 알림을 "던진 그 대화창"(origin 봇+chatId)으로 되돌려 보낸다. sendOutbound
// ('report')가 별도 report 봇으로 가던 문제(발신 채널 불일치) 해결. botId 로 config 에서 봇
// 토큰을 해석(main/report/test) — 매칭 없으면 main 기본. origin/토큰/chat 없으면 false 반환
// (caller 가 sendOutbound 폴백). 봇 토큰은 저장 안 하고 config 에서만 읽는다.

import { getUserConfig } from '../user-config.js';
import { resolveChannelBotToken } from '../channel-bot-token.js';
import { canUseUxAgent } from '../ux/ux-config.js';
import { notifyMissionHitlViaUx } from './mission-ux-live.js';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MissionOrigin } from './mission-origin.js';
import type { MissionArc } from '../task-orchestrator/mission.js';
import { saveMissionHitlMessage, loadMissionOrigin } from './mission-origin.js';
import { buildPhaseOutcomeFromSummary, synthesizePhaseDiagnosis, renderAttemptTrail, parseTriageHealOverride, type HealKind } from './mission-phase-diagnosis.js';
import { attemptsForPhase } from './se-build-registry.js';
import { selfHealArmed } from './arming.js';
import { latestMissionRouteDecision } from './mission-route-decision.js';

/** 힐 액션 → 사람이 읽는 라벨(진단 카드 권장 + 버튼 강조 매핑). */
const HEAL_KO: Record<HealKind, string> = {
  rebuild: '🔧 재구현', split: '✂️ 분할', revise: '✏️ 골 정정', skip: '⏭️ 건너뛰기', escalate: '🙋 사람 개입',
};

/** botId(토큰 prefix)로 config 텔레그램 봇 토큰 해석.
 *
 *  ⚠️ 사건 수리(ISO-3 · 2026-07-13): 종전에는 "매칭 없으면 main botToken"
 *  폴백이 있었다 — 격리 테스트 데몬에서 운영 미션의 origin(메인 봇 id)이
 *  테스트 config 후보들과 매칭 안 되자 **자기(테스트) 봇으로 폴백 발송**해
 *  운영 미션 알림이 테스트 채널로 새어나갔다. origin 이 지정한 봇을 보장할
 *  수 없으면 발송하지 않는 게 맞다(엉뚱한 채널 > 미발송이 아니라 그 반대).
 *  botId 미지정(legacy origin)일 때만 main botToken. */
export function resolveTelegramBotToken(botId?: string): string | null {
  try {
    const tg = getUserConfig().telegram as {
      botToken?: string;
      reportChannel?: { botToken?: string };
      testChannel?: { botToken?: string };
    } | undefined;
    if (!tg) return null;
    const mainToken = resolveChannelBotToken('telegram', getUserConfig())?.token;
    const candidates = [mainToken, tg.reportChannel?.botToken, tg.testChannel?.botToken]
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (botId) {
      return candidates.find((t) => t.split(':')[0] === botId) ?? null;
    }
    return mainToken ?? null;
  } catch { return null; }
}

/** 특정 봇 토큰 + chatId 로 텔레그램 직접 발송(4000자 분할·줄 경계). curl 셸아웃(dep-free). */
export function sendTelegramTo(botToken: string, chatId: number | string, text: string, threadId?: number): boolean {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const chunks: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > 3900) { chunks.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur) chunks.push(cur);
  let ok = true;
  for (const ch of chunks) {
    const params: Record<string, string> = { chat_id: String(chatId), text: ch, disable_web_page_preview: 'true' };
    if (threadId !== undefined) params.message_thread_id = String(threadId);
    const body = new URLSearchParams(params).toString();
    const r = spawnSync('curl', ['-sS', '-m', '15', '-X', 'POST', url,
      '-H', 'Content-Type: application/x-www-form-urlencoded', '--data', body], { encoding: 'utf-8' });
    if (r.status !== 0) ok = false;
  }
  return ok;
}

/** ★ 플레인 메시지 발송 + 실제 messageId 반환(대표 지시 2026-07-12) — 진행 알림(notifyPhaseProgress)
 *  이 "메시지 1개를 만들고 계속 edit" 하려면 첫 메시지의 실제 좌표가 필요. sendTelegramTo 는
 *  boolean 만 반환하므로 별도. 마지막 청크의 message_id 파싱(sendTelegramButtonsTo 동일). 실패 null. */
export function sendTelegramReturningId(botToken: string, chatId: number | string, text: string, threadId?: number): number | null {
  const chunks: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > 3900) { chunks.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0) chunks.push(text);
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let lastMsgId: number | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const params: Record<string, string> = { chat_id: String(chatId), text: chunks[i]!, disable_web_page_preview: 'true' };
    if (threadId !== undefined) params.message_thread_id = String(threadId);
    const body = new URLSearchParams(params).toString();
    const r = spawnSync('curl', ['-sS', '-m', '15', '-X', 'POST', url,
      '-H', 'Content-Type: application/x-www-form-urlencoded', '--data', body], { encoding: 'utf-8' });
    if (r.status === 0 && i === chunks.length - 1) {
      try {
        const j = JSON.parse(r.stdout) as { result?: { message_id?: number } };
        lastMsgId = typeof j.result?.message_id === 'number' ? j.result.message_id : null;
      } catch { /* fail-soft */ }
    }
  }
  return lastMsgId;
}

/** 특정 봇 토큰 + chatId 로 파일(문서) 발송 — Bot API sendDocument(multipart/form-data·curl -F).
 *  분해 결과(플랜 초안 md)를 텔레그램에서 다운로드 받게 함(대표 지시 2026-07-12). 파일 없으면
 *  false. caption 은 1024자 캡(초과 truncate). dep-free 셸아웃. */
export function sendTelegramDocumentTo(
  botToken: string,
  chatId: number | string,
  filePath: string,
  caption?: string,
  threadId?: number,
  /** ★ 표시 파일명 override(대표 2026-07-22) — 텔레그램에 보일 파일명(기본=실제 파일명). RFC 첨부를
   *  rfc.md 대신 미션 apm id 로 보이게. curl 멀티파트 `;filename=` 규약. */
  filename?: string,
): boolean {
  try {
    if (!existsSync(filePath)) return false;
    const url = `https://api.telegram.org/bot${botToken}/sendDocument`;
    const docField = filename ? `document=@${filePath};filename=${filename}` : `document=@${filePath}`;
    const args = ['-sS', '-m', '30', '-X', 'POST', url, '-F', `chat_id=${String(chatId)}`, '-F', docField];
    if (caption) args.push('-F', `caption=${caption.slice(0, 1024)}`);
    if (threadId !== undefined) args.push('-F', `message_thread_id=${String(threadId)}`);
    const r = spawnSync('curl', args, { encoding: 'utf-8' });
    return r.status === 0 && !/"ok":false/.test(r.stdout ?? '');
  } catch { return false; }
}

/** origin(발신 채널)으로 파일(문서) 되돌려 발송. 텔레그램 origin+chatId+토큰+파일 있으면 발송
 *  (true), 없으면 false. 알림 본문과 별개로 첨부물을 그 대화창으로 보낸다. */
export function notifyMissionDocument(origin: MissionOrigin | null, filePath: string, caption?: string, filename?: string): boolean {
  if (!origin || origin.channel !== 'telegram' || origin.chatId === undefined) return false;
  const token = resolveTelegramBotToken(origin.botId);
  if (!token) return false;
  try { return sendTelegramDocumentTo(token, origin.chatId, filePath, caption, origin.threadId, filename); }
  catch { return false; }
}

/** 미션 완료/실패 후 "처음부터 재실행" 버튼 발송(대표 2026-07-12·미션 유지). 텔레그램 origin
 *  이면 버튼 메시지 발송(message_id 반환). rerun 콜백은 mission-hitl-callback 이 rerunMission 으로
 *  처리. 특정 페이즈 재실행은 CLI(elanous autopilot rerun --from). */
export function notifyMissionRerunButton(
  origin: MissionOrigin | null, missionId: string, text: string,
  // ★ 실패 지점 재개(대표 2026-07-12) — 페이즈 실패로 중단 시 그 페이즈부터 재개(앞 성공 보존).
  //   "전체 종료는 과하다" — 처음부터(P1~) 대신 실패 페이즈부터 rebuildPhase. resume=실패 페이즈.
  resume?: { phaseId: string; index: number; total: number } | null,
): number | null {
  if (!origin || origin.channel !== 'telegram' || origin.chatId === undefined) return null;
  const token = resolveTelegramBotToken(origin.botId);
  if (!token) return null;
  try {
    // 재개 버튼(있으면 위·강조) + 처음부터 재실행. 재개는 페이즈 리뷰 콜백(rebuild) 재사용.
    const rows: TgButton[][] = [];
    if (resume) {
      rows.push([{ text: `▶️ 실패 지점(${resume.index + 1}/${resume.total})부터 재개`, data: buildPhaseCallbackData(resume.phaseId, 'rebuild') }]);
    }
    rows.push([{ text: '🔄 처음부터 재실행', data: buildHitlCallbackData(missionId, 'rerun') }]);
    return sendTelegramButtonsTo(token, origin.chatId, text, rows, origin.threadId);
  } catch { return null; }
}

/** 경량 텍스트 progress bar — "▓▓▓░░░░░░░ 29%" (omni-crawl 조사: 긴 작업엔 단순 바가 최적·
 *  editMessageText 단일갱신은 messageId 추적 부담이라 각 알림에 텍스트 바로 부담 없이). 순수함수. */
export function renderProgressBar(ratio: number, width = 10): string {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * width);
  return `${'▓'.repeat(filled)}${'░'.repeat(width - filled)} ${Math.round(r * 100)}%`;
}

/** 아크 이름에서 중복 "아크 X —" prefix 제거(가독성) — arcName 이 "아크 A — 무해한..." 형태면 본문만. */
function cleanArcName(name: string): string {
  return name.replace(/^아크\s+[A-Za-z0-9]+\s*[—:\-]\s*/, '').trim() || name;
}

/** arcSeq("1/4") → 아크 레터(1→A). 없으면 ''. */
function arcLetterFromSeq(arcSeq?: string): string {
  const n = arcSeq ? parseInt(arcSeq.split('/')[0] ?? '', 10) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : '';
}

/**
 * 페이즈 진행 카드 헤더(대표 2026-07-16 Layout A) — 첫줄에 여정(아크·페이즈 위치)+상태+% 를 집약,
 * 2행 진행바, 3행 아크 이름(읽는). 암호 핸들·빌드 id 는 헤더에 안 넣는다(footer=phaseCardFooter).
 * flat(arcSeq 없음)이면 아크 부분 생략. 순수함수(테스트가능).
 *   🔧 아크 A · 페이즈 3/7 · 구현 중 · 29%
 *   ▓▓▓░░░░░░░
 *   ⬡ 무해한 자율 ACT 가드 (아크 1/4)
 */
export function phaseProgressHeader(
  info: { index: number; total: number; status: string; arcName?: string; arcSeq?: string },
): string {
  const icon = info.status === 'done' ? '✅' : info.status === 'failed' ? '⚠️' : '🔧';
  const statusLabel = info.status === 'running' ? '구현 중' : info.status === 'done' ? '완료' : info.status;
  const ratio = info.status === 'done' ? (info.index + 1) / info.total : info.index / info.total;
  const arcLetter = arcLetterFromSeq(info.arcSeq);
  const arcPos = arcLetter ? `아크 ${arcLetter} · ` : '';
  const line1 = `${icon} ${arcPos}페이즈 ${info.index + 1}/${info.total} · ${statusLabel} · ${Math.round(ratio * 100)}%`;
  const arcName = info.arcName ? cleanArcName(info.arcName) : '';
  const arcLine = arcName ? `⬡ ${arcName}${info.arcSeq ? ` (아크 ${info.arcSeq})` : ''}` : '';
  return [line1, renderProgressBar(ratio), arcLine].filter(Boolean).join('\n');
}

/** Layout A footer(대표 2026-07-16) — 실행 프로바이더 + (선택)빌드 진행 note. 암호 빌드 id 는
 *  여기(카드 하단·내부)만. 둘 다 없으면 빈 문자열. */
export function phaseCardFooter(provider?: string, buildNote?: string): string {
  const parts = [provider ? `⚙ ${provider}` : '', (buildNote ?? '').trim()].map((s) => s.trim()).filter(Boolean);
  return parts.length ? `\n─ ${parts.join(' · ')}` : '';
}

/** ★ 페이즈별 실시간 알림(대표 지시 2026-07-12) — 멀티페이즈 미션의 각 페이즈가 시작(running)/
 *  done/failed 될 때마다 즉시 발송(전체 완료 대기 없이). 진행률 바(▓░ %)로 진행 인지. SE built
 *  로 PR 초안이 있으면 "📖 PR #N 리뷰" URL 버튼을 달아 탭 한 번에 GitHub PR 리뷰. */
/** ★ 페이즈 리뷰 버튼 결정(대표 2026-07-12·순수·테스트) — "리뷰할 산출물이 있을 때"만 버튼을 단다.
 *  - pr: PR URL 이 있으면 "📖 PR 리뷰" URL 버튼.
 *  - approve: [✅승인]=구현 결과(PR)를 수용. 실제 산출물이 있어야 의미 있으므로 done+prUrl 일 때만.
 *      조사/운영 페이즈(PR 없음)·실패 페이즈에 '승인' 은 무의미('구현도 안 했는데 뭘 승인?').
 *  - rebuild: [🔧재구현]=다시 만들기. done/failed 어느 쪽이든 가능(실패=재시도·성공=재작성).
 *  진행 중(running)은 전부 false(버튼 없이 알림만). */
/** ★ "너무 큰 페이즈" 신호 감지(대표 지시 2026-07-12·순수·테스트) — 페이즈가 최대 예산(terra
 *  150→300→1000턴 + opus 4.8 폴백)으로도 완주 못 하거나, 비평이 "계획 핵심 파일 미수정/미완"
 *  으로 반복 차단한 경우. 이런 실패만 "분할 권장"(단일책임 위배·큰 arc). 전제부재·일시오류 등
 *  다른 실패엔 분할 버튼을 띄우지 않는다(분할해도 소용없음). summary/note 텍스트 기반. */
export function isPhaseTooBig(text: string | undefined): boolean {
  if (!text) return false;
  // 예산 계단 + opus 폴백까지 소진 = 크기 문제의 가장 강한 신호.
  if (/폴백까지 시도했으나 실패|opus[^\n]*폴백[^\n]*실패|150→300→1000|예산[^\n]*턴[^\n]*(소진|실패)/.test(text)) return true;
  // 비평이 "계획 핵심/대상 파일 미수정·미완" 으로 차단 = 배선을 한 실행에 못 끝낸 것.
  if (/계획\s*(핵심|대상)[^\n]*(미수정|수정되지\s*않)|전혀\s*수정되지\s*않|미완\/훼손/.test(text)) return true;
  return false;
}

/** ★ 카드 표시용 유효 힐 kind(대표 2026-07-14) — 결정론 진단(recommendHeal)에 재시도 triage
 *  오버라이드(요약 마커 [SE triage: ...] / [재시도 triage 권장: ...])를 적용해 run-mission 영속
 *  경로와 일치시킨다. 그간 카드는 결정론만 봐서, triage 가 split 로 오버라이드해도 카드는 "권장:
 *  재구현"에 분할 버튼 누락 불일치가 났다(대표 발견: 알림은 "분할 필요"인데 분할 버튼 없음). 순수. */
export function effectiveCardHeal(deterministicKind: HealKind, summary: string | undefined): HealKind {
  return parseTriageHealOverride(summary ?? '') ?? deterministicKind;
}

export function phaseReviewActions(info: { status: string; prUrl?: string; summary?: string; note?: string }): { pr: boolean; approve: boolean; rebuild: boolean; split: boolean; revise: boolean; skip: boolean; check: boolean } {
  const terminal = info.status === 'done' || info.status === 'failed';
  const hasPr = !!info.prUrl;
  return {
    pr: hasPr,
    approve: info.status === 'done' && hasPr,
    rebuild: terminal,
    // ★ HITL 확인 버튼(대표 2026-07-13·슬라이스 2) — 카나리 등 "사람이 도착/결과를 눈으로 확인"해야
    //   하는 실패 페이즈에 노출. 에이전트가 검증 불가한 항목(실제 텔레그램 도착 등)을 대표가 확인해
    //   done 처리. hard-fail 로 끝나지 않고 사람 확인 기회를 주는 경로.
    check: info.status === 'failed',
    // ★ 분할 버튼은 "실패 + 너무 큼 신호" 일 때만(대표 2026-07-12) — 아무 실패에나 띄우지 않음.
    split: info.status === 'failed' && isPhaseTooBig(info.summary ?? info.note),
    // ★ 골 정정 버튼(대표 지시 2026-07-12·탈출구) — 실패 페이즈에 노출. 재시도로 안 되는 하드
    //   피처를 골 분해까지 올라가 목표 자체를 정정(범위축소·간소화 등)·재분해할 상향 경로.
    revise: info.status === 'failed',
    // ★ 건너뛰기 버튼(대표 지시 2026-07-13·§5.2 탈출구 마지막 층) — 실패 페이즈에 노출. "이 기능은
    //   지금 안 만든다"고 판단할 때 이 페이즈만 기능 제외하고 나머지로 미션 계속(부분 완주).
    skip: info.status === 'failed',
  };
}

/** 페이즈 summary 정리(순수) — 실행 접두([PASS·시도N]/[FAIL·..]/[판정누락..])와 VERDICT 마커
 *  줄(사람에겐 노이즈)을 걷어내고 공백 정리. 트림 없음(첨부 전문·발췌 공통 전처리). */
export function cleanPhaseSummary(summary: string | undefined): string {
  if (!summary) return '';
  return summary
    .replace(/^\s*\[(PASS|FAIL|판정누락)[^\]]*\]\s*/i, '') // 실행 접두(시도/판정) 제거
    .split('\n')
    .filter((ln) => !/^\s*VERDICT:\s*(PASS|FAIL)\s*$/i.test(ln)) // 판정 마커 줄 제거
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** ★ 페이즈 산출물 요약 발췌(대표 2026-07-12·순수·테스트) — 페이즈가 "무엇을 했나" 피드백.
 *  cleanPhaseSummary 후 max 로 트림(초과 시 말줄임). 없으면 ''. */
export function phaseSummaryExcerpt(summary: string | undefined, max = 600): string {
  const cleaned = cleanPhaseSummary(summary);
  if (cleaned.length <= max) return cleaned;
  // ★ 요약형 발췌(대표 지시 2026-07-12) — max 에서 단어 중간을 "…" 로 자르지 말고, 마크다운
  //   구조(제목·번호목록 + 각 섹션 첫 실질 줄)로 개요를 만든다("요약 보내달라 했는데 컷만 했다").
  //   전문은 별도 .md 첨부라 개요만으로 충분. 구조가 없으면 문장/줄 경계로 자름(단어 중간 컷 회피).
  const headRe = /^#{1,6}\s|^\*\*.+\*\*[:：]?$|^\d+\.\s/;
  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
  const outline: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!headRe.test(lines[i]!)) continue; // 제목/섹션 헤더만
    outline.push(lines[i]!.replace(/^#{1,6}\s*/, '• ').replace(/\*\*/g, ''));
    const next = lines.slice(i + 1).find((x) => !headRe.test(x));
    if (next) outline.push('   ' + next.replace(/^[-*]\s*/, '').slice(0, 140));
    if (outline.join('\n').length > max) break;
  }
  const built = outline.join('\n').trim();
  if (built.length >= 40) return built.length > max ? built.slice(0, max).trimEnd() + ' …' : built;
  // 폴백 — 구조 없음: 문장/줄 경계로 자름(단어 중간 컷 회피), 없으면 하드 컷.
  const cut = cleaned.slice(0, max);
  const brk = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('\n'));
  return (brk > max * 0.6 ? cut.slice(0, brk + 1) : cut).trimEnd() + ' …';
}

/** 긴 페이즈 산출물 첨부 임계(대표 2026-07-12) — 이보다 길면 요약만 인라인·전문은 .md 첨부. */
export const PHASE_SUMMARY_ATTACH_THRESHOLD = 900;

/** ★ 실행 프로바이더 footer(대표 2026-07-15) — 어떤 모델이 이 미션을 트리거·집행하는지 카드 **맨끝
 *  footer** 한 줄로. 페이즈 카드뿐 아니라 HITL·결과 등 대부분 미션 메시지에 통일 노출(헤더 아님).
 *  provider 미상이면 빈 문자열(카드 무변형·fail-soft). 순수 함수. */
export function providerFooter(provider?: string): string {
  return provider ? `\n\n🤖 실행: ${provider}` : '';
}

/** 미션 단위 실행 프로바이더 라벨 조달 — 기록된 route-decision(실집행 증거) 우선, 없으면(분해 직후 등
 *  페이즈 미실행) config 예측으로 폴백. 어느 미션 메시지든 동일 라벨을 쓰게 하는 단일 창구. fail-soft. */
export function resolveMissionProviderLabel(missionId: string): string | undefined {
  try {
    const d = latestMissionRouteDecision(missionId);
    if (d) return d.model ? `${d.provider}:${d.model}` : d.provider;
  } catch { /* fail-soft — 기록 없거나 store 접근 실패 */ }
  try {
    const cfg = getUserConfig();
    return cfg.llm.provider === 'auto' ? (cfg.llm.model || 'auto') : `${cfg.llm.provider}:${cfg.llm.model || '?'}`;
  } catch { return undefined; }
}

export function notifyPhaseResult(
  origin: MissionOrigin | null,
  info: { index: number; total: number; title: string; status: string; prUrl?: string; note?: string; summary?: string; phaseId?: string; missionId?: string; handle?: string; arcHandle?: string; arcSeq?: string; arcName?: string; provider?: string },
): number | null {
  if (!origin || origin.channel !== 'telegram' || origin.chatId === undefined) return null;
  const token = resolveTelegramBotToken(origin.botId);
  if (!token) return null;
  // icon/label/진행률은 헤더 헬퍼(phaseProgressHeader)가 계산 — 카드 상단 아크→페이즈 계층.
  // ★ 페이즈 피드백(대표 2026-07-12) — 산출물 요약을 실제로 표시(그간 summary 를 note 로 잘못
  //   읽어 조용히 버려졌음·"무엇을 했는지 피드백이 없다"). running 은 요약 없이 진행 알림만.
  //   ★긴 내용 첨부(대표 2026-07-12): 전문이 아주 길면(임계 초과) 요약만 인라인·전문은 .md 로
  //   자동 첨부(요약후 첨부). 인라인이 리포트로 도배되던 문제 해소.
  const rawSummary = info.status === 'running' ? '' : cleanPhaseSummary(info.summary ?? info.note);
  const attachLong = rawSummary.length > PHASE_SUMMARY_ATTACH_THRESHOLD;
  const excerpt = info.status === 'running' ? '' : (attachLong ? phaseSummaryExcerpt(rawSummary, 400) : rawSummary);
  const attachHint = attachLong ? '\n📎 전문은 첨부 파일 참조' : '';
  // ★ 진단 카드(대표 지시 2026-07-13·PLAN O7) — 실패 페이즈를 opus 수준 진단으로 격상.
  //   시도 트레일 + 근본원인 추론 + 권장 힐을 구조화(§5.8 목업). 요약 텍스트에서 합성(순수).
  //   P6 — attempts 는 se_builds 실기록 우선(빌드=시도 1급·B1 계측). regex 재구성은 폴백.
  //   run-mission 영속 경로와 같은 사실원 → 카드=저장 진단의 결정론 골격 일치(소비 일원화).
  let diag: ReturnType<typeof synthesizePhaseDiagnosis> | null = null;
  let trail = '';
  if (info.status === 'failed') {
    const outcome = buildPhaseOutcomeFromSummary({
      phaseId: info.phaseId ?? '', missionId: info.missionId ?? '', title: info.title, index: info.index, total: info.total,
      status: 'failed', summary: info.summary ?? info.note,
    });
    try {
      if (info.phaseId) {
        const real = attemptsForPhase(info.phaseId);
        if (real.length) outcome.attempts = real;
      }
    } catch { /* fail-soft — regex 폴백 유지 */ }
    diag = synthesizePhaseDiagnosis(outcome);
    // ★ triage 힐 오버라이드 반영(대표 2026-07-14) — run-mission 영속 경로와 동일하게 요약의 triage
    //   마커(split 등)를 카드 권장/버튼에 적용. 결정론만 보던 불일치(분할 필요인데 분할 버튼 없음) 해소.
    const effKind = effectiveCardHeal(diag.healRecommendation.kind, info.summary ?? info.note);
    if (effKind !== diag.healRecommendation.kind) diag = { ...diag, healRecommendation: { ...diag.healRecommendation, kind: effKind } };
    trail = renderAttemptTrail(outcome.attempts);
  }
  // P7 — §5.8 목업 완결: 🔁 시도 트레일(실측·P6) + ⚙ 자율 재시도 arming 상태 + 📄 로그 안내.
  let armingLine = '';
  try {
    if (diag && (diag.healRecommendation.kind === 'rebuild')) {
      armingLine = `\n⚙ 자율 재시도(transient·1회): ${selfHealArmed() ? 'on — 자동 재구현 시도' : 'off'}`;
    }
  } catch { /* fail-soft */ }
  const logLine = diag && info.missionId
    ? `\n📄 상세 로그: elanous ops mission-log ${info.missionId}`
    : '';
  const diagCard = diag
    ? `\n\n🔁 시도: ${trail}\n🧭 진단(추정): ${diag.rootCauseInference}\n💡 권장: ${HEAL_KO[diag.healRecommendation.kind]} (신뢰도 ${diag.confidence})${armingLine}${logLine}`
    : '';
  // ★ 리더빌리티 재설계(대표 2026-07-16) — 아크 이름을 앞세운 아크→페이즈 계층(phaseProgressHeader).
  //   지칭 핸들(handle)은 카드에서 뺀다(rebuild/skip 은 실패 카드 버튼·페이즈 순번으로 충분).
  // ★ 실행 프로바이더는 헤더가 아니라 맨끝 footer 로(대표 2026-07-15) — 카드 상단은 아크/페이즈에 집중.
  const text = [phaseProgressHeader(info), info.title,
    ...(excerpt ? ['', excerpt + attachHint] : []), ...(diagCard ? [diagCard] : [])].join('\n')
    + phaseCardFooter(info.provider);
  // 긴 전문을 .md 로 첨부(알림 발송 후·fail-soft). 파일명=페이즈 번호+제목 슬러그.
  const attachFullSummary = () => {
    if (!attachLong || origin.chatId === undefined) return;
    try {
      const safe = info.title.replace(/[^\w가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'phase';
      const fp = join(tmpdir(), `elanous-phase-${info.index + 1}-${safe}.md`);
      writeFileSync(fp, `# 페이즈 ${info.index + 1}/${info.total} — ${info.title}\n\n${rawSummary}\n`);
      sendTelegramDocumentTo(token, origin.chatId, fp, `페이즈 ${info.index + 1}/${info.total} 전문 · ${info.title}`.slice(0, 200), origin.threadId);
    } catch { /* fail-soft */ }
  };
  try {
    // ★ R2 페이즈 리뷰 버튼(대표 2026-07-12·의미론 수정) — 어떤 버튼을 달지는 순수 함수가 결정.
    const acts = phaseReviewActions(info);
    const row: TgButton[] = [];
    if (acts.pr && info.prUrl) {
      const m = /\/pull\/(\d+)/.exec(info.prUrl);
      row.push({ text: m ? `📖 PR #${m[1]} 리뷰` : '📖 PR 리뷰', url: info.prUrl });
    }
    if (acts.approve && info.phaseId) {
      row.push({ text: '✅ 승인', data: buildPhaseCallbackData(info.phaseId, 'approve') });
    }
    // ★ 진단 권장 힐 강조(대표 2026-07-13·PLAN O7) — 진단이 권장한 액션 버튼에 "(권장)" 표기.
    const rec = diag?.healRecommendation.kind ?? null;
    const mark = (kind: HealKind, base: string): string => (rec === kind ? `${base} (권장)` : base);
    if (acts.rebuild && info.phaseId) {
      row.push({ text: mark('rebuild', '🔧 재구현'), data: buildPhaseCallbackData(info.phaseId, 'rebuild') });
    }
    // ★ 분할 버튼(대표 2026-07-12·진단 정합 2026-07-13) — 너무 큰 페이즈 실패에. 게이팅을 진단
    //   추천과 정합화: acts.split(summary 휴리스틱) OR 진단이 split 권장(실측 attempts 기반·
    //   isTooBig). 그간 "권장: ✂️ 분할" 카드인데 버튼이 없던 불일치 해소(요약이 '가짜 no-op' 등이면
    //   isPhaseTooBig=false 로 버튼 누락됐음). 진단이 정답이므로 진단 추천 시 버튼을 반드시 노출.
    if ((acts.split || rec === 'split') && info.phaseId) {
      row.push({ text: mark('split', '✂️ 분할'), data: buildPhaseCallbackData(info.phaseId, 'split') });
    }
    // ★ 골 정정 버튼(대표 지시 2026-07-12·탈출구) — 실패 페이즈에서 골 분해까지 올라가 목표 정정·재분해.
    if (acts.revise && info.phaseId) {
      row.push({ text: mark('revise', '✏️ 골 정정'), data: buildPhaseCallbackData(info.phaseId, 'revise') });
    }
    // ★ 건너뛰기 버튼(대표 지시 2026-07-13·§5.2 탈출구) — 이 페이즈 기능 제외 후 나머지로 미션 계속.
    if (acts.skip && info.phaseId) {
      row.push({ text: mark('skip', '⏭️ 건너뛰기'), data: buildPhaseCallbackData(info.phaseId, 'skip') });
    }
    // ★ HITL 확인 버튼(대표 2026-07-13·슬라이스 2) — 사람이 결과를 확인해 done 처리(카나리 도착 등).
    if (acts.check && info.phaseId) {
      row.push({ text: '✅ 확인 완료', data: buildPhaseCallbackData(info.phaseId, 'check') });
    }
    // ★ escalate 버튼(대표 2026-07-13·시스템 셀프힐링) — 진단이 escalate 권장(R2 시스템 결함 의심
    //   또는 보안 경계)일 때. 탭 → R3 Opus 룩백 → 시스템 결함이면 system-repair 수리 미션 스폰(HITL),
    //   보안 경계면 사람 판단 통지. "예산/분할로 안 풀리는 시스템 결함"을 자율 수리로 잇는 표면.
    if (rec === 'escalate' && info.phaseId) {
      row.push({ text: mark('escalate', '🙋 시스템수리'), data: buildPhaseCallbackData(info.phaseId, 'escalate') });
    }
    if (row.length) {
      // ★ 2개/줄 배치(대표 2026-07-14) — 한 줄에 몰면 텔레그램이 라벨을 잘라 "페...(권장)" 로 뭉갠다.
      const mid = sendTelegramButtonsTo(token, origin.chatId, text, chunkButtonRows(row, 4), origin.threadId);
      attachFullSummary();
      return mid;
    }
    const sent = sendTelegramTo(token, origin.chatId, text, origin.threadId);
    attachFullSummary();
    return sent ? 0 : null;
  } catch { return null; }
}

/**
 * ★ 아크 이벤트 알림(A7 arc-aware UX·2026-07-14) — 아크 통합검증 통과/실패를 텔레그램 카드로.
 * notifyPhaseResult 와 대칭·같은 텔레그램 직결 게이트. 무버튼 통지(아크 실패의 수복 카드는
 * presentArcReviseCard 가 별도로 arc-revise 버튼을 띄운다 — 여기선 진행 통지만). 페이즈가 green
 * 인데 아크로는 dead-code 인 순간을 사람이 실시간으로 본다(아크의 존재 이유를 UX 로 노출).
 */
export function notifyArcResult(
  origin: MissionOrigin | null,
  info: { arcIndex: number; arcTotal: number; name: string; status: 'done' | 'failed' | 'unverified' | 'descoped'; kind: 'reconcile' | 'complete'; evidence?: string; missing?: string; handle?: string },
): number | null {
  if (!origin || origin.channel !== 'telegram' || origin.chatId === undefined) return null;
  const token = resolveTelegramBotToken(origin.botId);
  if (!token) return null;
  const icon = info.status === 'done' ? '✅' : info.status === 'unverified' ? '🔍' : info.status === 'descoped' ? '⊘' : '🔒';
  const ratio = (info.status === 'done' || info.status === 'descoped') ? (info.arcIndex + 1) / info.arcTotal : info.arcIndex / info.arcTotal;
  const suffix = info.kind === 'reconcile' ? '·reconcile' : '';
  const label = info.status === 'done'
    ? `통합검증 통과${suffix}`
    : info.status === 'descoped'
      ? `범위 제외${suffix} — non-blocking(완주 안 막음)`
      : info.status === 'unverified'
        ? `판정 보류${suffix} — grounding 불충분(HITL 재검증)`
        : `통합검증 실패${suffix} — arc-revise 권장`;
  const detail = info.status === 'done' || info.status === 'descoped'
    ? (info.evidence ? `\n${info.evidence.slice(0, 200)}` : '')
    : (info.missing ? `\n${info.status === 'unverified' ? '사유' : '미충족'}: ${info.missing.slice(0, 200)}` : '');
  // 지칭 핸들(handle=A2·slug) 있으면 `아크 A2·slug (2/3)`, 없으면 종전 `아크 2/3`(하위호환).
  const arcLabel = info.handle ? `아크 ${info.handle} (${info.arcIndex + 1}/${info.arcTotal})` : `아크 ${info.arcIndex + 1}/${info.arcTotal}`;
  const text = `${icon} ⬡ ${arcLabel} [${label}] ${renderProgressBar(ratio)}\n${info.name}${detail}`;
  try {
    const sent = sendTelegramTo(token, origin.chatId, text, origin.threadId);
    return sent ? 0 : null;
  } catch { return null; }
}

/** ★ 아크 자율 산정 알림 문구(2026-07-21·대표 지시 #4867 후속·투명성 갭) — arc 되묻기가 clear single
 *  recommendation 이라 카드(HITL) 없이 autoproceed 로 채택될 때, 카드는 없애되(불필요 HITL 유지) 사람에게
 *  "아크를 어떻게/왜 그 수로 정했는지" non-blocking 정보성 알림을 남긴다(제1원칙 — 자율 결정엔 사용자 향
 *  관측). autoproceed 시점은 intake 라 아직 실제 아크 이름이 없으므로 아크 수 + 진행 통지 위주로 간결히,
 *  상세 구성(이름·페이즈 배분)은 분해 완료 후 승인 카드로 안내. arcHint 미지정(분해기 재량)이면 수 대신
 *  "분해기 재량". 순수함수(테스트가능) — 발송은 sendTelegramTo(두 autoproceed 경로 호출측). */
export function formatArcAutoproceedNotice(arcHint?: number): string {
  const arcPhrase = typeof arcHint === 'number' ? `아크 ${arcHint}개로` : '아크 구성을 분해기 재량으로';
  return [
    `🧭 아크 자율 산정 — 되묻기 답변을 반영해 ${arcPhrase} 자율 진행합니다(추가 확인 카드 생략).`,
    '상세 구성(아크 이름·페이즈 배분)은 분해 완료 후 최종 승인 카드에서 확인하실 수 있습니다.',
  ].join('\n');
}

/** ★ preflight 판정 근거(mirage/over_scope reason) 표시 상한(2026-07-21·#4857 후속) — 종전 90자에서 확대.
 *  90자 컷은 근거 문장을 "...grounding에도 두..." 처럼 잘라 대표가 판정 근거를 못 읽었다.
 *  텔레그램 메시지 한도 고려해 균형(220자). formatArcOverview·formatArcCompact 두 곳 동일 적용. */
const PREFLIGHT_REASON_MAX = 220;

/**
 * ★ 아크 구조 개요(A2.5 arc-aware UX·2026-07-14) — 다중 아크 미션의 아크 분류를 사람이 보게 한다.
 * 골 분해가 페이즈만 나열하던 prepare HITL 카드에, "이 골이 어떤 응집 아크들로 구조화됐나"를 노출
 * (자동 분류 A2.5 를 가시화 → "사람은 편히 관리"). flat(단일/암묵1아크)이면 빈 문자열. 순수함수.
 */
export function formatArcOverview(arcs: readonly MissionArc[] | undefined): string {
  const list = arcs ?? [];
  if (list.length < 2) return ''; // flat(암묵1아크)은 개요 불필요
  const byId = new Map(list.map((a) => [a.arcId, a]));
  const lines = [`⬡ 아크 ${list.length}개로 구조화(A2.5 자동 분류):`];
  let total = 0; let anyCost = false;
  list.forEach((a, i) => {
    const deps = a.dependsOnArcs.map((d) => byId.get(d)?.name ?? d).filter(Boolean);
    const depStr = deps.length ? ` (선행: ${deps.join(', ')})` : '';
    // ★ 갭3(대표 2026-07-20) — 플래그 옆에 판정 근거 짧게(종전 ⚠️mirage 만·근거 없어 오탐 판별 불가).
    const pv = a.preflightVerdict;
    const flag = pv && pv.verdict !== 'founded'
      ? ` ⚠️${pv.verdict}${pv.reason ? `(${pv.reason.length > PREFLIGHT_REASON_MAX ? `${pv.reason.slice(0, PREFLIGHT_REASON_MAX)}…` : pv.reason})` : ''}` : '';
    // ★ G2/B1(2026-07-15) — 아크별 예산 자동 산정값 노출(있을 때만·하위호환).
    const cost = typeof a.estimatedCost === 'number' ? (anyCost = true, total += a.estimatedCost, ` · ~$${a.estimatedCost.toFixed(2)}`) : '';
    lines.push(`  ${i + 1}. ${a.name} — ${a.phaseIds.length}페이즈${cost}${depStr}${flag}`);
  });
  if (anyCost) lines.push(`  총 예산 ~$${(Math.round(total * 100) / 100).toFixed(2)}(자동 산정·아크 편집 시 재산정).`);
  lines.push('  ↳ 아크는 순차 배리어(아크 통합 검증 통과 후 다음)·아크 내 페이즈 병렬.');
  return lines.join('\n');
}

/** 컴팩트 아크 개요(HITL 요약 카드용·2026-07-19 갭3) — 아크별 페이즈를 "한눈에".
 *  formatArcOverview 는 예산/의존/배리어까지 담아 상세(description 용)이나, 카드엔 아크 이름 +
 *  그 아크의 페이즈 목록(제목)을 중첩해 보여준다(대표 지적 2026-07-19 — 카운트만이 아니라 상세 페이즈).
 *  phaseTitles 없으면 페이즈 수(Np)만. 아크<2(flat)면 빈 문자열. 순수. */
export function formatArcCompact(
  arcs: readonly MissionArc[] | undefined,
  phaseTitles?: Map<string, string> | Record<string, string>,
): string {
  const list = arcs ?? [];
  if (list.length < 2) return '';
  const titleOf = (id: string): string | undefined =>
    phaseTitles instanceof Map ? phaseTitles.get(id) : phaseTitles?.[id];
  const lines = [`⬡ 아크 ${list.length}개 (아크 통합검증 경계·순차):`];
  list.forEach((a, i) => {
    // ★ 갭3(대표 2026-07-20) — 플래그 옆에 판정 근거 짧게(종전 ⚠️mirage 만·근거 없어 오탐 판별 불가).
    const pv = a.preflightVerdict;
    const flag = pv && pv.verdict !== 'founded'
      ? ` ⚠️${pv.verdict}${pv.reason ? `(${pv.reason.length > PREFLIGHT_REASON_MAX ? `${pv.reason.slice(0, PREFLIGHT_REASON_MAX)}…` : pv.reason})` : ''}` : '';
    lines.push(`  ${circledArc(i)} ${cleanArcName(a.name)} · ${a.phaseIds.length}p${flag}`);
    // ★ 아크 아래 상세 페이즈(제목 맵 있을 때) — 대표 "아크 아래 상세 페이즈도 나와야"(2026-07-19).
    a.phaseIds.forEach((pid) => {
      const t = titleOf(pid);
      if (t) lines.push(`     • ${t.length > 62 ? `${t.slice(0, 62)}…` : t}`);
    });
  });
  return lines.join('\n');
}

function circledArc(i: number): string {
  const c = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
  return c[i] ?? `${i + 1}.`;
}

/** 페이즈 리뷰 콜백 액션. split=너무 큰 페이즈를 서브페이즈로 국소 재분해. revise=골 분해까지
 *  올라가 목표 자체 정정·재분해. skip=이 페이즈를 기능 제외 처리하고 미션 계속(대표 2026-07-13·
 *  §5.2 3층 탈출구 마지막 층 — 재시도·분할·정정으로도 안 될 때 부분 완주로 빠져나가는 경로). */
export type PhaseAction = 'approve' | 'rebuild' | 'recritique' | 'split' | 'revise' | 'skip' | 'check' | 'escalate' | 'arm' | 'defer';

/** 페이즈 리뷰 콜백 데이터 — `apm-phase:<phaseKey>:<action>`(ascii·64byte 내). phaseKey=task id hex. */
export function buildPhaseCallbackData(phaseId: string, action: PhaseAction): string {
  return `apm-phase:${phaseId.replace(/^task:/, '').slice(0, 24)}:${action}`;
}

/** 페이즈 콜백 파싱 — 미션 페이즈 리뷰가 아니면 null. 순수함수. */
export function parsePhaseCallbackData(data: string): { phaseKey: string; action: PhaseAction } | null {
  const m = /^apm-phase:([^:]+):(approve|rebuild|recritique|split|revise|skip|check|escalate|arm|defer)$/.exec(data);
  return m ? { phaseKey: m[1]!, action: m[2] as PhaseAction } : null;
}

// ── 미션 생애주기 콜백(대표 2026-07-13·P4 텔레그램 UX) — 미션 레벨(페이즈 아님·apm-life:) ──
export type LifecycleAction = 'pause' | 'resume' | 'history';

/** 미션 생애주기 콜백 데이터 — `apm-life:<token>:<action>`(token=hitlToken·미션 id hash6·ascii). */
export function buildLifecycleCallbackData(missionId: string, action: LifecycleAction): string {
  return `apm-life:${hitlToken(missionId)}:${action}`;
}

/** 생애주기 콜백 파싱 — 아니면 null. 순수함수. */
export function parseLifecycleCallbackData(data: string): { token: string; action: LifecycleAction } | null {
  const m = /^apm-life:([^:]+):(pause|resume|history)$/.exec(data);
  return m ? { token: m[1]!, action: m[2] as LifecycleAction } : null;
}

// ── 미션 최종 브리핑 콜백(B3·PLAN-mission-pre-arming-briefing) — 실집행 전 승인 게이트 ──
export type BriefingAction = 'arm' | 'react' | 'hold';

/** 브리핑 카드 콜백 데이터 — `apm-brief:<token>:<action>`(token=hitlToken·ascii·64byte 내). */
export function buildBriefingCallbackData(missionId: string, action: BriefingAction): string {
  return `apm-brief:${hitlToken(missionId)}:${action}`;
}

/** 브리핑 콜백 파싱 — 아니면 null. 순수함수. 새 action 추가 시 정규식도 갱신(#4234 교훈). */
export function parseBriefingCallbackData(data: string): { token: string; action: BriefingAction } | null {
  const m = /^apm-brief:([^:]+):(arm|react|hold)$/.exec(data);
  return m ? { token: m[1]!, action: m[2] as BriefingAction } : null;
}

/** 브리핑 카드 버튼 row — [✅ 최종 승인(arm)] [✏️ 재조치] [❌ 보류]. 실집행 전 판단 게이트. */
export function briefingButtonRow(missionId: string): Array<{ text: string; data: string }> {
  return [
    { text: '✅ 최종 승인', data: buildBriefingCallbackData(missionId, 'arm') },
    { text: '✏️ 재조치', data: buildBriefingCallbackData(missionId, 'react') },
    { text: '❌ 보류', data: buildBriefingCallbackData(missionId, 'hold') },
  ];
}

/** ★ 미션 생애주기 버튼 row(대표 2026-07-13·P4) — 진행 중/완료 미션 카드에 첨부. paused 면
 *  [▶️ 재개], 아니면 [⏸️ 일시정지] + 항상 [📜 히스토리](revision 타임라인 조회). */
export function lifecycleButtonRow(missionId: string, opts: { paused?: boolean } = {}): Array<{ text: string; data: string }> {
  return [
    opts.paused
      ? { text: '▶️ 재개', data: buildLifecycleCallbackData(missionId, 'resume') }
      : { text: '⏸️ 일시정지', data: buildLifecycleCallbackData(missionId, 'pause') },
    { text: '📜 히스토리', data: buildLifecycleCallbackData(missionId, 'history') },
  ];
}

/** origin(발신 채널)으로 되돌려 발송. 텔레그램 origin+chatId+토큰 있으면 직접 발송(true),
 *  없으면 false(caller 가 sendOutbound 폴백). */
export function notifyMissionOrigin(origin: MissionOrigin | null, text: string): boolean {
  if (!origin || origin.channel !== 'telegram' || origin.chatId === undefined) return false;
  const token = resolveTelegramBotToken(origin.botId);
  if (!token) return false;
  try { return sendTelegramTo(token, origin.chatId, text, origin.threadId); }
  catch { return false; }
}

// ── 미션 HITL 버튼 + 크로스서피스 싱크 (대표 지시 2026-07-11) ─────────────────
//
// 미션은 텔레그램에서 시작(골 발화)하지만 HITL 승인/거절이 PWA 에서만 됐다. 이제 텔레그램
// HITL 메시지에 승인/거절 inline 버튼을 달고, 어느 서피스에서 해소되든 반대편에 반영한다.
// 공유 상태 = mission.status(단일 SoT) — 양쪽이 같은 승인/거절 write 를 부르고 각자 반영.

/** 미션 id 의 ascii-safe 짧은 토큰(hash6 suffix). callback_data 는 64byte 캡인데 미션 id 는
 *  한글 slug 를 포함해 멀티바이트로 초과 → id 끝의 hash 세그먼트만 실어 매칭. */
export function hitlToken(missionId: string): string {
  const seg = missionId.split('_').pop() ?? missionId;
  return seg.slice(0, 16);
}

/** HITL 액션 — 승인/거절 + 정정 프리셋(클릭 정정) + revise-custom(직접입력·force_reply·Step B)
 *  + rerun(완료/실패 후 처음부터 재실행·미션 유지·대표 2026-07-12). */
export type HitlAction = 'approve' | 'reject' | 'rerun' | 'rereflect' | 'merge'
  | 'revise-smaller' | 'revise-simpler' | 'revise-scope' | 'revise-reuse' | 'revise-research' | 'revise-custom'
  // ★ 자율 revise 원탭 승인(대표 2026-07-14) — 추천 초안을 승인/수정/취소. apply=집행·edit=직접입력·cancel=폐기.
  | 'revise-apply' | 'revise-edit' | 'revise-cancel'
  // ★ 모호 해소(대표 2026-07-14) — 활성 미션 2건+일 때 어느 미션을 개정할지 선택.
  | 'revise-pick'
  // ★ A6-b 성숙도 분리 원탭(RFC §8b) — 과대 미션을 핵심 M1 + 후속 proposed 미션으로 분리.
  | 'maturity-split'
  // ★ Opus 폴백 분해(대표 2026-07-15) — Codex 분해가 transient 재시도 후에도 실패 시 Opus(유료) 재분해.
  | 'opus-fallback'
  // ★ BC3 역방향 피드백(대표 2026-07-16) — critique 치명 시 원탭 자동 재분해(critique 지적 반영).
  | 'redecompose'
  // ★ 게이팅 revise 반복 시 Opus 재분해(대표 2026-07-17) — sol 한계 극복·강력 모델 승격·terra 힌트 반영.
  | 'redecompose-opus';

/** 정정 프리셋(대표 2026-07-12) — 클릭 1번 정정. comment 는 재분해 objective 에 주입될 지시. */
export const HITL_REVISE_PRESETS: ReadonlyArray<{ action: HitlAction; label: string; comment: string }> = [
  { action: 'revise-smaller', label: '🔽 더 잘게', comment: '각 페이즈를 더 세분화하라(더 잘게 분해).' },
  { action: 'revise-simpler', label: '🔼 간소화', comment: '핵심 페이즈로 통합하라(과분해를 간소화).' },
  { action: 'revise-scope', label: '✂️ 범위축소', comment: '핵심 요구사항만 다루고 부가 기능은 제외하라(범위 축소).' },
  { action: 'revise-reuse', label: '♻️ 기존재사용', comment: '기존 grounding 파일을 확장·재사용하고 신규 파일 생성을 최소화하라.' },
  { action: 'revise-research', label: '🔍 조사강화', comment: '외부조사와 기존 코드 조사를 더 깊게 하라.' },
];

/** HITL 콜백 데이터 — `apm-hitl:<token>:<action>` (전부 ascii·40byte 내외). */
export function buildHitlCallbackData(missionId: string, action: HitlAction): string {
  return `apm-hitl:${hitlToken(missionId)}:${action}`;
}

/** ★ 자율 revise 원탭 승인 카드 텍스트+버튼(대표 2026-07-14) — recommender 가 만든 정정 초안을
 *  대표에게 제시하고 [승인][수정][취소] 원탭을 단다. 프롬프트 작성 부담은 제거하되 HITL 게이트 유지.
 *  순수함수(테스트) — 발송은 sendTelegramButtonsTo(호출측). */
export function buildReviseConfirmCard(
  missionId: string,
  draft: { comment: string; reviseKindLabel: string; confidence: string; rationale: string; source: string },
): { text: string; buttons: TgButton[] } {
  const src = draft.source === 'llm' ? 'LLM 판단' : '규칙 기반';
  const text = [
    `✏️ 골 정정(revise) 추천 — ${draft.reviseKindLabel} (신뢰도 ${draft.confidence}·${src})`,
    '',
    '아래 정정 지시로 골을 재분해할까요? (원본 gen0 은 보존·되돌릴 수 있음)',
    `"${draft.comment}"`,
    '',
    `근거: ${draft.rationale}`,
    missionId,
  ].join('\n');
  const buttons: TgButton[] = [
    { text: '✅ 승인', data: buildHitlCallbackData(missionId, 'revise-apply') },
    { text: '✏️ 수정', data: buildHitlCallbackData(missionId, 'revise-edit') },
    { text: '❌ 취소', data: buildHitlCallbackData(missionId, 'revise-cancel') },
  ];
  return { text, buttons };
}

/** ★ 모호 해소 선택 카드(대표 2026-07-14) — 이 방 활성 미션이 여러 개고 맥락이 불명확할 때
 *  recency 로 찍지 말고 "어느 미션?"을 물어본다(틀리게 찍느니 물어봄). 각 미션 버튼 탭 -> revise-pick
 *  콜백(그 미션 토큰) -> 보관된 원 요청 맥락으로 추천 카드. 순수함수(발송은 호출측). */
export function buildReviseDisambiguationCard(
  candidates: ReadonlyArray<{ id: string; goal: string }>,
): { text: string; buttons: TgButton[][] } {
  const lines = ['✏️ 어느 미션을 개정할까요? (이 방 활성 미션 ' + candidates.length + '건 — 최근순으로 찍지 않고 확인)'];
  candidates.forEach((c, i) => lines.push(`${i + 1}. ${c.goal.replace(/\s+/g, ' ').slice(0, 60)}\n   ${c.id}`));
  // 버튼 1행당 1미션(라벨=번호+골 앞부분·64byte callback 안전).
  const buttons: TgButton[][] = candidates.map((c, i) => [
    { text: `${i + 1}. ${c.goal.replace(/\s+/g, ' ').slice(0, 24)}`, data: buildHitlCallbackData(c.id, 'revise-pick') },
  ]);
  buttons.push([{ text: '❌ 취소', data: buildHitlCallbackData(candidates[0]!.id, 'revise-cancel') }]);
  return { text: lines.join('\n'), buttons };
}

/** 콜백 데이터 파싱 — 미션 HITL 이 아니면 null(형제 핸들러가 조용히 무시). 순수함수. */
export function parseHitlCallbackData(data: string): { token: string; decision: HitlAction } | null {
  const m = /^apm-hitl:([^:]+):(approve|reject|rerun|rereflect|merge|maturity-split|opus-fallback|redecompose-opus|redecompose|revise-[a-z]+)$/.exec(data);
  if (!m) return null;
  return { token: m[1]!, decision: m[2] as HitlAction };
}

/** 승인/거절 inline 버튼을 달아 특정 봇+chatId 로 발송. 응답 message_id 반환(실패 null).
 *  긴 텍스트는 앞 청크 plain 발송 후 마지막 청크에만 버튼(줄 경계 4000자 분할).
 *  버튼은 콜백(data) 또는 URL(url·클릭 시 브라우저 열림·PR 리뷰 등) 둘 중 하나. */
export type TgButton = { text: string; data?: string; url?: string };

/** inline 버튼을 perRow 개씩 나눠 여러 줄로(대표 2026-07-14) — 한 줄에 다 몰면 텔레그램이 라벨을
 *  잘라 "✂️ 페...(권장)" 처럼 뭉갠다. 한 줄 최대 4개(대표 지시) — 라벨 짧으면 4개까지 모바일서도
 *  안 잘리고, 넘치면 다음 줄로. 순수함수. */
export function chunkButtonRows(buttons: TgButton[], perRow = 4): TgButton[][] {
  const rows: TgButton[][] = [];
  for (let i = 0; i < buttons.length; i += Math.max(1, perRow)) rows.push(buttons.slice(i, i + perRow));
  return rows;
}
export function sendTelegramButtonsTo(
  botToken: string, chatId: number | string, text: string,
  buttons: TgButton[] | TgButton[][], threadId?: number,
): number | null {
  const chunks: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > 3900) { chunks.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0) chunks.push(text);
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let lastMsgId: number | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const params: Record<string, string> = { chat_id: String(chatId), text: chunks[i]!, disable_web_page_preview: 'true' };
    if (threadId !== undefined) params.message_thread_id = String(threadId);
    if (isLast) {
      const rows: TgButton[][] = Array.isArray(buttons[0]) ? (buttons as TgButton[][]) : [buttons as TgButton[]];
      params.reply_markup = JSON.stringify({ inline_keyboard: rows.map((row) => row.map((b) => b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: (b.data ?? '').slice(0, 64) })) });
    }
    const body = new URLSearchParams(params).toString();
    const r = spawnSync('curl', ['-sS', '-m', '15', '-X', 'POST', url,
      '-H', 'Content-Type: application/x-www-form-urlencoded', '--data', body], { encoding: 'utf-8' });
    if (r.status === 0 && isLast) {
      try {
        const j = JSON.parse(r.stdout) as { result?: { message_id?: number } };
        lastMsgId = typeof j.result?.message_id === 'number' ? j.result.message_id : null;
      } catch { /* fail-soft — 좌표 없으면 크로스서피스 edit 만 스킵 */ }
    }
  }
  return lastMsgId;
}

/** force_reply 메시지 발송 — 사용자가 답장하면 handleIncoming 이 가로채 정정 재분해(Step B).
 *  텍스트에 apm-revise:<token> 마커를 심어 답장의 reply_to 로 미션을 매칭. message_id 반환. */
export function sendForceReplyTo(botToken: string, chatId: number | string, text: string, threadId?: number): number | null {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const params: Record<string, string> = {
    chat_id: String(chatId), text, disable_web_page_preview: 'true',
    reply_markup: JSON.stringify({ force_reply: true, input_field_placeholder: '정정 내용을 입력…' }),
  };
  if (threadId !== undefined) params.message_thread_id = String(threadId);
  const r = spawnSync('curl', ['-sS', '-m', '15', '-X', 'POST', url,
    '-H', 'Content-Type: application/x-www-form-urlencoded', '--data', new URLSearchParams(params).toString()], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  try { const j = JSON.parse(r.stdout) as { result?: { message_id?: number } }; return typeof j.result?.message_id === 'number' ? j.result.message_id : null; }
  catch { return null; }
}

/** 저장된 HITL 메시지를 새 텍스트로 edit + 버튼 제거(editMessageText·reply_markup 생략).
 *  fail-soft(true=성공). */
export function editTelegramMessageTo(botToken: string, chatId: number | string, messageId: number, text: string): boolean {
  const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
  const body = new URLSearchParams({
    chat_id: String(chatId), message_id: String(messageId), text, disable_web_page_preview: 'true',
  }).toString();
  const r = spawnSync('curl', ['-sS', '-m', '15', '-X', 'POST', url,
    '-H', 'Content-Type: application/x-www-form-urlencoded', '--data', body], { encoding: 'utf-8' });
  return r.status === 0;
}

/** ★ 완료 리뷰 요약 + 재반영 버튼(대표 2026-07-12) — 미션 완료 시 페이즈별 자동 비평 요약을
 *  보내고, 지적(FAIL/WARN)이 있으면 [🔧 비평 재반영] 버튼(지적된 페이즈만 재구현). 머지는 HITL. */
export function notifyMissionReviewSummary(
  origin: MissionOrigin | null, missionId: string, text: string,
  opts: { hasCritiques: boolean; hasMergeable: boolean; provider?: string },
): number | null {
  if (!origin || origin.channel !== 'telegram' || origin.chatId === undefined) return null;
  const token = resolveTelegramBotToken(origin.botId);
  if (!token) return null;
  // ★ 실행 프로바이더 footer(대표 2026-07-15) — 완료 결과 카드 맨끝에 집행 모델 통일 노출.
  text = text + providerFooter(opts.provider ?? resolveMissionProviderLabel(missionId));
  try {
    // ★ 버튼 게이트(대표 2026-07-12) — 지적이 남아있으면 [🔧재반영]만(머지 잠금). 지적이 다 해소돼
    //   전부 clean 이면 그제서야 [✅반영(머지)]. "재반영 혹은 clean 상태에서만 머지 버튼". 상호배타.
    const rows: TgButton[][] = [];
    if (opts.hasCritiques) {
      rows.push([{ text: '🔧 비평 재반영(지적 페이즈 재구현)', data: buildHitlCallbackData(missionId, 'rereflect') }]);
    } else if (opts.hasMergeable) {
      rows.push([{ text: '✅ 반영(전체 clean PR 머지)', data: buildHitlCallbackData(missionId, 'merge') }]);
    }
    return rows.length
      ? sendTelegramButtonsTo(token, origin.chatId, text, rows, origin.threadId)
      : (sendTelegramTo(token, origin.chatId, text, origin.threadId) ? 0 : null);
  } catch { return null; }
}

/** ★ 페이즈 내부 진행 갱신(대표 2026-07-12) — 실행 중 페이즈의 "구현 중" 메시지를 변곡점마다
 *  edit 해 재시도/에스컬레이션/opus 폴백 같은 세부 진행을 실시간 노출("진행을 전혀 못 봐 답답").
 *  messageId=onPhaseStart 가 반환한 메시지. 진행 바 + 현재 진행 note. fail-soft(true=성공). */
export function notifyPhaseProgress(
  origin: MissionOrigin | null,
  // ★ 진행 메시지 1개를 만들고 edit(대표 지시 2026-07-12·정정) — 매 변곡점마다 새 메시지를 쏘면
  //   과다(대표: "너무 많이 온다"). 첫 호출은 새 메시지 1개 생성 + 실제 좌표 반환, 이후 호출은 그
  //   좌표를 editMessageText 로 갱신. run-mission 이 반환 좌표를 저장해 재사용. messageId 가 실제
  //   좌표(>0)면 edit, 아니면(0/null·notifyPhaseResult no-button 폴백) 새로 만들어 좌표 반환.
  messageId: number | null,
  info: { index: number; total: number; title: string; provider?: string; arcName?: string; arcSeq?: string },
  note: string,
): number | null {
  if (!origin || origin.channel !== 'telegram' || origin.chatId === undefined) return messageId ?? null;
  const token = resolveTelegramBotToken(origin.botId);
  if (!token) return messageId ?? null;
  // ★ 페이즈 카드에 빌드 진행 합침(대표 2026-07-16) — 종전엔 별도 '격리 구현 중' 메시지가 페이즈
  //   카드와 중복됐다. 이제 같은 Layout A 헤더 + 빌드 note 를 footer 로 접어 하나의 카드를 edit.
  const text = [phaseProgressHeader({ ...info, status: 'running' }), info.title].join('\n')
    + phaseCardFooter(undefined, note);
  try {
    if (messageId && messageId > 0) { editTelegramMessageTo(token, origin.chatId, messageId, text); return messageId; }
    return sendTelegramReturningId(token, origin.chatId, text, origin.threadId);
  } catch { return messageId ?? null; }
}

/** ★ 정정 프리셋 버튼 2행(대표 2026-07-12·재사용) — 승인 단계 + 실행 중 골 정정 탈출구 공용.
 *  더잘게·간소화·범위축소 / 기존재사용·조사강화·직접입력. 콜백=buildHitlCallbackData(revise-*). */
export function buildReviseButtonRows(missionId: string): TgButton[][] {
  const preset = (i: number) => HITL_REVISE_PRESETS[i]!;
  return [
    [0, 1, 2].map((i) => ({ text: preset(i).label, data: buildHitlCallbackData(missionId, preset(i).action) })),
    [3, 4].map((i) => ({ text: preset(i).label, data: buildHitlCallbackData(missionId, preset(i).action) }))
      .concat([{ text: '✏️ 직접입력', data: buildHitlCallbackData(missionId, 'revise-custom') }]),
  ];
}

/** ★ 골 정정 메뉴 발송(대표 지시 2026-07-12·탈출구) — 실행 중 막힌 페이즈의 [✏️ 골 정정] 탭이
 *  이 메뉴를 띄운다. 프리셋(범위축소 등) 선택 → revise 핸들러가 spawnMissionPrepare 재분해. */
export function notifyMissionReviseMenu(origin: MissionOrigin | null, missionId: string, text: string): number | null {
  if (!origin || origin.channel !== 'telegram' || origin.chatId === undefined) return null;
  const token = resolveTelegramBotToken(origin.botId);
  if (!token) return null;
  try { return sendTelegramButtonsTo(token, origin.chatId, text, buildReviseButtonRows(missionId), origin.threadId); }
  catch { return null; }
}

/** 미션 HITL 알림을 승인/거절 버튼과 함께 origin 으로 발송하고 메시지 좌표를 저장. origin 이
 *  텔레그램 아님/토큰 없음이면 null → caller 가 plain notifyMissionOrigin 폴백. */
/** HITL 확인 카드 버튼 row 구성(순수·테스트) — 승인/보류 + 정정 프리셋 2행 + (과대면) 성숙도 분리.
 *  opts.maturityButton=A6-b 과대 미션일 때 [✂️ 성숙도 분리] 원탭 추가(RFC §8b·자율경계=HITL). */
export function buildHitlButtonRows(missionId: string, opts: { maturityButton?: boolean; opusFallbackButton?: boolean; redecomposeButton?: boolean; redecomposeOpusButton?: boolean } = {}): TgButton[][] {
  // ★ Opus 폴백(대표 2026-07-15) — Codex 분해가 transient 재시도 후에도 실패 시 유료 Opus 재분해 1탭 승인.
  //   승인/보류만(정정 프리셋 불필요) — 실패 원인이 모델 게이트웨이라 골 정정이 아니라 모델 스위치가 답.
  if (opts.opusFallbackButton) {
    return [[
      { text: '🧠 Opus로 재분해(유료)', data: buildHitlCallbackData(missionId, 'opus-fallback') },
      { text: '⏸️ 보류', data: buildHitlCallbackData(missionId, 'reject') },
    ]];
  }
  const rows: TgButton[][] = [
    [
      { text: '✅ 승인(실행 시작)', data: buildHitlCallbackData(missionId, 'approve') },
      { text: '⏸️ 보류', data: buildHitlCallbackData(missionId, 'reject') },
    ],
    ...buildReviseButtonRows(missionId),
  ];
  if (opts.maturityButton) {
    rows.push([{ text: '✂️ 성숙도 분리(후속 미션 생성)', data: buildHitlCallbackData(missionId, 'maturity-split') }]);
  }
  // ★ BC3 역방향 피드백 — critique/게이팅 지적 시 원탭 재분해(지적을 reviseContext 로 재분해). 게이팅
  //   revise 반복(sol 한계·본질적 난제) 시 [🧠 Opus 재분해] 동반(대표 2026-07-17) — 강력 모델로 승격·
  //   같은 terra 힌트(슬롯) 반영. 한 줄에 sol/opus 두 버튼.
  if (opts.redecomposeButton) {
    const row: TgButton[] = [{ text: '🔁 재분해(sol·비평반영)', data: buildHitlCallbackData(missionId, 'redecompose') }];
    if (opts.redecomposeOpusButton) row.push({ text: '🧠 Opus 재분해(강력)', data: buildHitlCallbackData(missionId, 'redecompose-opus') });
    rows.push(row);
  }
  return rows;
}

export function notifyMissionHitl(origin: MissionOrigin | null, missionId: string, text: string, opts: { maturityButton?: boolean; opusFallbackButton?: boolean; redecomposeButton?: boolean; redecomposeOpusButton?: boolean; signals?: Record<string, unknown>; provider?: string } = {}): number | null {
  if (!origin || origin.channel !== 'telegram' || origin.chatId === undefined) return null;
  // ★ P4 라이브 배선(opt-in·autopilot.uxAgent.enabled·기본 OFF) — UX 에이전트 켜지면 동적 액션 UXIntent
  //   경로로 발행(신호 기반 버튼·Phase 1 빌더). 실패 시 기존 하드코딩으로 폴백(비파괴·회귀 0).
  if (canUseUxAgent()) {
    try {
      const uxBody = text + providerFooter(opts.provider ?? resolveMissionProviderLabel(missionId));
      // ★ CC2b(대표 2026-07-20) — 골분해 승인 카드도 synth 신호(redesign·criticalCount·scopeExceeded)를
      //   버튼 빌더로 전달해 다이나믹 버튼 생성(예 역제안 수용). 종전엔 signals 미전달→정적 버튼.
      const uxMid = notifyMissionHitlViaUx(origin, missionId, uxBody, opts.signals ? { signals: opts.signals } : {});
      if (uxMid != null) { saveMissionHitlMessage(missionId, uxMid); return uxMid; }
    } catch { /* fail-soft → 기존 폴백 */ }
  }
  const token = resolveTelegramBotToken(origin.botId);
  if (!token) return null;
  // 승인/거절 + 정정 프리셋 2행(클릭 정정·대표 2026-07-12) + 과대면 성숙도 분리(A6-b).
  const rows = buildHitlButtonRows(missionId, opts);
  // ★ 실행 프로바이더 footer(대표 2026-07-15) — HITL 카드 맨끝에 어떤 모델이 집행할지 통일 노출.
  const body = text + providerFooter(opts.provider ?? resolveMissionProviderLabel(missionId));
  try {
    const msgId = sendTelegramButtonsTo(token, origin.chatId, body, rows, origin.threadId);
    if (msgId != null) saveMissionHitlMessage(missionId, msgId);
    return msgId;
  } catch { return null; }
}

/** 크로스서피스 반영 — 미션 해소(승인/거절) 시 저장된 텔레그램 HITL 메시지를 edit + 버튼
 *  제거. PWA/텔레그램 어느 경로에서 해소돼도 호출(멱등·fail-soft·좌표 없으면 no-op). */
export function resolveMissionHitlUi(missionId: string, decision: 'approved' | 'rejected', via: 'telegram' | 'pwa' | 'tui'): boolean {
  const origin = loadMissionOrigin(missionId);
  if (!origin || origin.channel !== 'telegram' || origin.chatId === undefined || origin.hitlMessageId === undefined) return false;
  const token = resolveTelegramBotToken(origin.botId);
  if (!token) return false;
  const label = decision === 'approved' ? '✅ 승인됨(실행 시작)' : '❌ 거절됨';
  const viaLabel = via === 'pwa' ? 'PWA' : via === 'tui' ? 'TUI' : '텔레그램';
  const text = `${label} — via ${viaLabel}\n${missionId}`;
  try { return editTelegramMessageTo(token, origin.chatId, origin.hitlMessageId, text); }
  catch { return false; }
}
