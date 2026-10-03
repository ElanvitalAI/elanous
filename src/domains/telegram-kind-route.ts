// 발송 목적(kind) → 텔레그램 채널 역할 · 대상. 가벼운 모듈(telegram.ts 를 import 하지 않는다 — outbound-alert 순환 방지).
// 표에 없는 kind 는 undefined → 부르는 쪽이 폴백을 판정한다(투자 알림은 옛 reportChannel 유지).
import type { UserConfig } from '../user-config.js';
import { resolveChannelBotToken } from '../channel-bot-token.js';
import { debug } from '../debug/log.js';
import { channelForRole, resolveTelegramChannels } from './telegram-channels.js';

export const DEFAULT_KIND_ROLES: Readonly<Record<string, string>> = {
  intake: 'system', 'ops-report': 'system', 'ops-alert': 'system', 'ops-health': 'system',
  regression: 'system', 'agent-mission': 'system',
};

/** No channel mapping for an operational kind may cross into a different bot. */
export function isOperationalKind(kind?: string): boolean {
  return kind?.startsWith('ops-') ?? false;
}

export function mainHomeTarget(cfg: UserConfig): { botToken: string; chatId: number } | null {
  const botToken = resolveChannelBotToken('telegram', cfg).token;
  const chatId = cfg.telegram.homeChannel ?? cfg.telegram.allowedUsers[0];
  return botToken && chatId != null && Number.isFinite(chatId) ? { botToken, chatId } : null;
}

export function logKindRouteFallback(kind: string | undefined, to: 'report-channel' | 'main-home' | 'conatus-env' | 'none', sameBot: boolean): void {
  try { debug.log('telegram.kind-route', 'fallback', { kind, to, sameBot }); } catch { /* logging must not prevent delivery */ }
}

export function roleForKind(cfg: UserConfig, kind?: string): string | undefined {
  if (!kind) return undefined;
  return cfg.telegram.kindRoles?.[kind] ?? DEFAULT_KIND_ROLES[kind];
}

/** The channel for a purpose kind — only with explicit `telegram.channels` and a mapped role. */
export function kindRouteTarget(cfg: UserConfig, kind?: string): { botToken: string; chatId: number } | null {
  const role = roleForKind(cfg, kind);
  if (!role || !cfg.telegram.channels?.length) return null;
  const ch = channelForRole(resolveTelegramChannels(cfg.telegram), role);
  return ch?.botToken && Number.isFinite(ch.chatId) ? { botToken: ch.botToken, chatId: ch.chatId } : null;
}
