// 발송 목적(kind) → 텔레그램 채널 역할 · 대상. 가벼운 모듈(telegram.ts 를 import 하지 않는다 — outbound-alert 순환 방지).
// 명시적으로 매매 kind 인 경우만 trading; 나머지는 system. 역할 채널이 없으면 다른 역할로 폴백하지 않는다.
import type { UserConfig } from '../user-config.js';
import { resolveChannelBotToken } from '../channel-bot-token.js';
import { debug } from '../debug/log.js';
import { resolveTelegramChannels } from './telegram-channels.js';

export const DEFAULT_KIND_ROLES: Readonly<Record<string, string>> = {
  report: 'report', alert: 'report', digest: 'report',
  intake: 'system', 'ops-report': 'system', 'ops-alert': 'system', 'ops-health': 'system',
  regression: 'system', 'agent-mission': 'system', brief: 'system', 'op-report': 'system',
};

/** Only named finance delivery kinds can use the trading/report bot. */
export function isTradingKind(kind?: string): boolean {
  return kind === 'report' || kind === 'alert' || kind === 'digest';
}

export function isOperationalKind(kind?: string): boolean {
  return !isTradingKind(kind);
}

export function mainHomeTarget(cfg: UserConfig): { botToken: string; chatId: number } | null {
  const botToken = operationsBotToken(cfg);
  const chatId = cfg.telegram.homeChannel ?? cfg.telegram.allowedUsers[0];
  return botToken && chatId != null && Number.isFinite(chatId) ? { botToken, chatId } : null;
}

export function logKindRouteFallback(kind: string | undefined, to: 'report-channel' | 'main-home' | 'conatus-env' | 'none', sameBot: boolean): void {
  try { debug.log('telegram.kind-route', 'fallback', { kind, to, sameBot }); } catch { /* logging must not prevent delivery */ }
}

function operationsBotToken(cfg: UserConfig): string | undefined {
  const main = resolveChannelBotToken('telegram', cfg);
  const channels = cfg.telegram.channels?.length ? resolveTelegramChannels(cfg.telegram) : [];
  const tradingTokens = new Set(channels.filter(c => c.roles.includes('report')).map(c => c.botToken));
  // The report (trading) bot is never the operations bot — with or without a channels table (review must-fix · OUT1).
  if (cfg.telegram.reportChannel?.botToken) tradingTokens.add(cfg.telegram.reportChannel.botToken);
  if (main.source !== 'channels.main') return main.token && !tradingTokens.has(main.token) ? main.token : undefined;
  // channels.main may mean "first channel", which can be the trading bot.
  // Only a named operations channel (or the named main channel) with an
  // operational role establishes identity; array order and role alone do not.
  const tokens = new Set(channels
    .filter(c => (c.name === 'ops' && c.roles.includes('system'))
      || (c.name === 'main' && c.roles.some(r => r === 'system' || r === 'qa' || r === 'default')))
    .filter(c => !tradingTokens.has(c.botToken))
    .map(c => c.botToken));
  return tokens.size === 1 ? tokens.values().next().value : undefined;
}

function isAllowedBot(cfg: UserConfig, kind: string | undefined, token: string): boolean {
  const mainToken = operationsBotToken(cfg);
  if (!mainToken) return false;
  if (!isTradingKind(kind)) return token === mainToken;
  const reportToken = cfg.telegram.reportChannel?.botToken;
  return token !== mainToken && (!reportToken || token === reportToken);
}

export function roleForKind(cfg: UserConfig, kind?: string): string {
  const fallback = isTradingKind(kind) ? 'report' : 'system';
  if (!kind || !cfg.telegram.channels?.length) return fallback;
  const override = cfg.telegram.kindRoles?.[kind];
  if (!override) return fallback;
  const channel = resolveTelegramChannels(cfg.telegram)
    .find(c => c.roles.includes(override) && isAllowedBot(cfg, kind, c.botToken));
  return channel ? override : fallback;
}

/** Exact role only: channelForRole's default/first fallback can cross bot boundaries. */
export function kindRouteTarget(cfg: UserConfig, kind?: string): { botToken: string; chatId: number } | null {
  if (!cfg.telegram.channels?.length) return null;
  const role = roleForKind(cfg, kind);
  const ch = resolveTelegramChannels(cfg.telegram)
    .find(c => c.roles.includes(role) && isAllowedBot(cfg, kind, c.botToken));
  if (!ch || !Number.isFinite(ch.chatId)) return null;
  return { botToken: ch.botToken, chatId: ch.chatId };
}

export type ReportRouteReason =
  | 'routed' | 'report-role-missing' | 'no-role-channel'
  | 'no-report-channel' | 'report-bot-not-distinct' | 'report-chat-invalid' | 'no-main-home';

/** Why a kind has (or lacks) a delivery target — no logging, no sending. Mirrors
 *  `resolveReportTarget` so a skipped send can say *which* rule closed it instead of
 *  «no report channel configured» (BRIEF-DELIVERY-1007: a channels table without a
 *  `report` role closed the morning brief for four days while reportChannel was set). */
export function explainReportRoute(cfg: UserConfig, kind?: string): { reason: ReportRouteReason; role: string; hint: string } {
  const role = roleForKind(cfg, kind);
  const trading = isTradingKind(kind);
  if (cfg.telegram.channels?.length) {
    if (kindRouteTarget(cfg, kind)) return { reason: 'routed', role, hint: '' };
    const hasRole = resolveTelegramChannels(cfg.telegram).some(c => c.roles.includes(role));
    if (trading && !hasRole && cfg.telegram.reportChannel) {
      return {
        reason: 'report-role-missing', role,
        hint: `채널 표에 «${role}» 역할 칸이 없다 — telegram.reportChannel 은 채널 표가 있으면 쓰지 않는다. `
          + `telegram.channels[].roles 에 "${role}" 를 더하거나 telegram.kindRoles.${kind ?? '<kind>'} 로 있는 역할을 고른다`,
      };
    }
    return { reason: 'no-role-channel', role, hint: `채널 표에 «${role}» 역할을 가진 허용된 봇 칸이 없다 — telegram.channels 를 확인` };
  }
  if (!trading) {
    return mainHomeTarget(cfg)
      ? { reason: 'routed', role, hint: '' }
      : { reason: 'no-main-home', role, hint: '운영 봇 또는 telegram.homeChannel·allowedUsers 가 없다' };
  }
  const rc = cfg.telegram.reportChannel;
  if (!rc) return { reason: 'no-report-channel', role, hint: 'telegram.reportChannel 이 없다' };
  const mainToken = resolveChannelBotToken('telegram', cfg).token;
  if (!rc.botToken || rc.botToken === mainToken) {
    return { reason: 'report-bot-not-distinct', role, hint: 'telegram.reportChannel 의 봇이 없거나 운영 봇과 같다 — 매매 보고는 별도 봇만 쓴다' };
  }
  return Number.isFinite(rc.chatId)
    ? { reason: 'routed', role, hint: '' }
    : { reason: 'report-chat-invalid', role, hint: 'telegram.reportChannel.chatId 가 숫자가 아니다' };
}
