// 발송 목적(kind) → 텔레그램 채널 역할 · 대상. 가벼운 모듈(telegram.ts 를 import 하지 않는다 — outbound-alert 순환 방지).
// 표에 없는 kind 는 undefined → 부르는 쪽이 옛 reportChannel 로 간다(투자 알림 등 기존 동작 그대로).
import type { UserConfig } from '../user-config.js';
import { channelForRole, resolveTelegramChannels } from './telegram-channels.js';

export const DEFAULT_KIND_ROLES: Readonly<Record<string, string>> = {
  intake: 'system', 'ops-report': 'system', 'ops-alert': 'system', 'ops-health': 'system',
};

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
