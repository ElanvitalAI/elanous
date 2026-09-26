// ── 미션 발신 origin 저장 (대표 지시 2026-07-11 · 채널 되돌림 정정) ──────────
//
// 문제: 미션 준비 완료 알림이 sendOutbound('report') 로 나가 발신 채널(대표가 던진 main 봇)
// 이 아니라 report 봇으로 갔다. 근본 원인 = submitIntent 가 origin(채널/chatId/botId)을 미션에
// 안 심어, detached se-mission-prepare 가 발신 채널을 알 방법이 없음.
//
// 해결: origin 을 mission id 로 키된 작은 JSON 파일에 저장(봇 토큰은 저장 안 함 — botId 만.
// 발송 시 config 에서 botId→botToken 해석). DB 스키마/계약 변경 없이 라우팅 메타만 보관.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { elanousStateRoot } from './state-paths.js';
import { getUserConfig } from '../user-config.js';
import { resolveChannelBotToken } from '../channel-bot-token.js';
import { join } from 'node:path';

export interface MissionOrigin {
  channel: 'telegram' | 'pwa' | 'voice' | 'cli' | 'api' | 'tui';
  /** 텔레그램: 답장할 chat id. */
  chatId?: number;
  /** 텔레그램: 수신 봇 식별(botId=토큰 prefix). 발송 시 config 에서 토큰 해석. */
  botId?: string;
  /** 텔레그램 스레드(포럼) — 있으면 답장에 붙임. */
  threadId?: number;
  /** HITL 승인/거절 버튼을 단 알림 메시지의 message_id. 크로스서피스 싱크용 —
   *  PWA/텔레그램 어느 쪽에서 해소돼도 이 좌표(chatId+botId+이 id)로 텔레그램 메시지를
   *  edit("승인됨/거절됨")하고 버튼을 제거한다. 버튼 발송 성공 시에만 기록. */
  hitlMessageId?: number;
}

function originDir(): string {
  // core 미션 fabric = autopilot/ (conatus/ 는 투자 customer 네임스페이스·대표 정정 2026-07-11).
  // [ISO-3] ELANOUS_STATE_DIR 존중 — 격리 테스트 데몬은 운영 origin 을 못 본다.
  return join(elanousStateRoot(), 'autopilot', 'mission-origin');
}
function originPath(missionId: string): string {
  return join(originDir(), `${missionId}.json`);
}

/** origin 저장(fail-soft). submitIntent 가 human-intent 미션 생성 직후 호출. */
export function saveMissionOrigin(missionId: string, origin: MissionOrigin): void {
  try {
    mkdirSync(originDir(), { recursive: true });
    writeFileSync(originPath(missionId), JSON.stringify(origin));
  } catch { /* fail-soft — 없으면 report 폴백 */ }
}

/** origin 로드. 없거나 손상 시 null(caller 는 report 폴백). */
export function loadMissionOrigin(missionId: string): MissionOrigin | null {
  try {
    const p = originPath(missionId);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf-8')) as MissionOrigin;
    return j && typeof j === 'object' && typeof j.channel === 'string' ? j : null;
  } catch { return null; }
}

/**
 * config 기본 텔레그램 채널(telegram.homeChannel)로부터 기본 origin 을 구성(대표 2026-07-16).
 * homeChannel 은 chatId 숫자 또는 {chatId} 객체. botId=main botToken prefix. 미구성이면 null.
 */
export function defaultTelegramOrigin(): MissionOrigin | null {
  try {
    const cfg = getUserConfig();
    const tg = cfg.telegram as { homeChannel?: number | { chatId?: number } } | undefined;
    if (!tg) return null;
    const chatId = typeof tg.homeChannel === 'number' ? tg.homeChannel : tg.homeChannel?.chatId;
    if (typeof chatId !== 'number') return null;
    const token = resolveChannelBotToken('telegram', cfg)?.token;
    const botId = token ? token.split(':')[0] : undefined;
    return { channel: 'telegram', chatId, ...(botId ? { botId } : {}) };
  } catch { return null; }
}

/**
 * origin 이 없으면 config 기본 텔레그램 채널로 자동 바인딩(대표 지시 2026-07-16). 프로그램/operator
 * 제출 미션(텔레그램 intake 아님)도 준비·HITL·브리핑 알림이 조용히 skip 되지 않고 홈채널로 가게 한다.
 * 이미 origin 이 있으면 no-op(텔레그램 intake 가 심은 실제 발신 채널 보존). fail-soft.
 */
export function ensureMissionOrigin(missionId: string): MissionOrigin | null {
  const existing = loadMissionOrigin(missionId);
  if (existing) return existing;
  const def = defaultTelegramOrigin();
  if (def) saveMissionOrigin(missionId, def);
  return def;
}

/** HITL 버튼 메시지 좌표(message_id)를 기존 origin 에 머지 저장(fail-soft). 버튼 발송
 *  성공 직후 호출 — 이후 PWA/텔레그램 어느 쪽 해소든 이 좌표로 메시지를 edit 한다.
 *  origin 이 없으면(비텔레그램 등) no-op. */
export function saveMissionHitlMessage(missionId: string, hitlMessageId: number): void {
  const origin = loadMissionOrigin(missionId);
  if (!origin) return;
  saveMissionOrigin(missionId, { ...origin, hitlMessageId });
}
