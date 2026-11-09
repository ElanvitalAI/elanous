// ── 텔레그램 멀티 채널 해석 (정적 · 2026-07-09) ──────────────────────────
//
// 대표 지시: user-config 를 멀티 봇(N채널)으로 일반화. 채널 = 봇 토큰(elanous 전용) +
// chat + 역할 + interactive(Q&A 폴러 여부). 명시 channels[] 가 있으면 그걸 쓰고,
// 없으면 legacy(botToken/homeChannel/reportChannel)에서 자동 파생(하위호환).
//
// ★ 핵심 불변식: getUpdates 폴러는 봇 토큰당 1개. interactivePollerTokens 가 토큰별로
//   dedup 해서 중복 폴러(→ 409 자기충돌·2026-07-09 버그)를 원천 차단한다.
// ★ 변경은 재시작 시 적용(정적) — 런타임 핫리로드는 폴러 레이스 위험이라 미채택.

import type { TelegramChannel, TelegramConfig } from '../user-config/types.js';

export type { TelegramChannel };

/** TelegramConfig → 채널 목록. 명시 channels 우선, 없으면 legacy 파생. */
export function resolveTelegramChannels(tg: TelegramConfig): TelegramChannel[] {
  // 1) 명시 채널이 있으면 그대로(유효한 것만).
  if (tg.channels && tg.channels.length > 0) {
    return tg.channels.filter(c => c.botToken && Number.isFinite(c.chatId));
  }
  // 2) legacy 파생.
  const out: TelegramChannel[] = [];
  const mainChat = tg.homeChannel ?? tg.allowedUsers[0] ?? 0;
  if (tg.botToken) {
    out.push({ name: 'main', botToken: tg.botToken, chatId: mainChat, interactive: true, roles: ['qa', 'default'] });
  }
  const rc = tg.reportChannel;
  if (rc) {
    if (rc.botToken && rc.botToken !== tg.botToken) {
      // 별도 봇 → 자체 interactive 채널(발송+양방향).
      out.push({ name: 'alert', botToken: rc.botToken, chatId: rc.chatId, interactive: true, roles: ['alert', 'report'] });
    } else if (tg.botToken) {
      // 메인 봇 공유 → 발송 전용 타깃(메인 폴러가 이미 그 토큰을 커버). interactive=false.
      out.push({ name: 'alert', botToken: tg.botToken, chatId: rc.chatId, interactive: false, roles: ['alert', 'report'] });
    }
  } else if (out.length > 0) {
    // report 채널 없음 → 메인이 alert/report 도 수신.
    out[0]!.roles.push('alert', 'report');
  }
  return out.filter(c => c.botToken);
}

/** interactive 채널 중 봇 토큰당 1개만(폴러 dedup). 같은 토큰에 두 폴러 → 409 방지. */
export function interactivePollerTokens(channels: TelegramChannel[]): TelegramChannel[] {
  const seen = new Set<string>();
  const out: TelegramChannel[] = [];
  for (const c of channels) {
    if (!c.interactive || !c.botToken) continue;
    if (seen.has(c.botToken)) continue;
    seen.add(c.botToken);
    out.push(c);
  }
  return out;
}

/** 역할(kind) → 그 역할을 가진 채널(발송 라우팅). 없으면 default/first. */
export function channelForRole(channels: TelegramChannel[], role: string): TelegramChannel | undefined {
  return channels.find(c => c.roles.includes(role))
    ?? channels.find(c => c.roles.includes('default'))
    ?? channels[0];
}
