import { getUserConfig } from '../user-config.js';
import { FEATURE_MATURITY, type Role } from './feature-maturity.js';

export type BotSurface = 'telegram' | 'discord';
export type BotAudience = { role: Role; showBeta: boolean };

/** The menu audience is independent of the inbound command authorization gate. */
export function readBotAudience(raw: unknown = undefined): BotAudience {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const role = value.role === 'general' || value.role === 'contributor' || value.role === 'owner' ? value.role : 'owner';
  return { role, showBeta: value.showBeta === true };
}

export function botAudienceFor(surface: BotSurface): BotAudience {
  const raw = getUserConfig().raw?.[surface] as { commandAudience?: unknown } | undefined;
  return readBotAudience(raw?.commandAudience);
}

export function botCommandVisible(surface: BotSurface, name: string, role: Role, { showBeta }: { showBeta: boolean }): boolean {
  const grades: Record<string, string> = surface === 'telegram' ? FEATURE_MATURITY.telegramCommand : FEATURE_MATURITY.discordCommand;
  const grade = Object.hasOwn(grades, name) ? grades[name] : undefined;
  if (!grade) return role === 'owner';
  if (role === 'owner') return true;
  if (grade === 'stable') return true;
  if (role === 'contributor') return grade === 'beta' || grade === 'tool';
  return grade === 'beta' && showBeta;
}

export function filterBotCommands<T extends { name: string }>(surface: BotSurface, names: readonly T[], audience: BotAudience): T[] {
  return names.filter(({ name }) => botCommandVisible(surface, name, audience.role, audience));
}

/** Discord can only invoke registered slash commands, so hiding must not unregister them.
 *  Every schema stays registered; ones hidden for this audience become admin-only
 *  (`default_member_permissions: "0"`), which removes them from members' pickers while
 *  server admins (the owner) can still call them. An explicit permission on a schema wins. */
export function gateDiscordSchemas<T extends { name: string; defaultMemberPermissions?: string }>(schemas: readonly T[], audience: BotAudience): { schemas: T[]; hidden: number } {
  let hidden = 0;
  const out = schemas.map((schema) => {
    if (botCommandVisible('discord', schema.name, audience.role, audience) || schema.defaultMemberPermissions !== undefined) return schema;
    hidden++;
    return { ...schema, defaultMemberPermissions: '0' };
  });
  return { schemas: out, hidden };
}
