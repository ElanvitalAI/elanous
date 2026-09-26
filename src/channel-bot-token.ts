import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { debug } from './debug/log.js';
import { getSecret, setSecretAsync } from './nexus/config/secrets/index.js';
import { userConfigPath } from './nexus/config/paths.js';
import { isSecretRef, makeSecretRef, secretIdFromRef } from './nexus/config/types.js';
import { acquireLockAsync } from './storage/file-lock.js';
import type { UserConfig } from './user-config.js';

export type ChannelBotPlatform = 'telegram' | 'discord';
export type ChannelBotTokenSource = 'tokenRef' | 'env' | 'plaintext';

/** The tab reference is read from the same persistent config as the NEXUS switch. */
export function resolveChannelBotToken(
  platform: ChannelBotPlatform,
  cfg: Pick<UserConfig, 'telegram' | 'discord'> & { tabs?: Record<string, { tokenRef?: unknown }> },
): { token: string; source: ChannelBotTokenSource } | undefined {
  const ref = cfg.tabs?.[`${platform}:1`]?.tokenRef;
  if (isSecretRef(ref)) {
    const id = secretIdFromRef(ref);
    const token = id ? getSecret(id) : undefined;
    if (token) return { token, source: 'tokenRef' };
  }
  const envName = platform === 'telegram' ? 'ELANOUS_TELEGRAM_BOT_TOKEN' : 'ELANOUS_DISCORD_BOT_TOKEN';
  const envToken = process.env[envName];
  if (envToken) return { token: envToken, source: 'env' };
  const token = cfg[platform]?.botToken;
  if (token) {
    debug.log('channel-bot.token', 'plaintext-fallback', { platform });
    return { token, source: 'plaintext' };
  }
  return undefined;
}

/** Publish the secret before its reference, under the config lock. Other config keys survive unchanged. */
type ChannelBotTokenWrite = {
  platform: ChannelBotPlatform; token: string; allowedUsers?: string[];
};

export function storeChannelBotToken(platform: ChannelBotPlatform, token: string, allowedUsers?: string[]): Promise<void>;
/** Migration selects candidates and backs up the exact config under the same lock as the write. */
export function storeChannelBotToken(entries: (cfg: Record<string, unknown>) => ReadonlyArray<ChannelBotTokenWrite>, requireSameSecret: boolean): Promise<void>;
export async function storeChannelBotToken(
  platformOrEntries: ChannelBotPlatform | ((cfg: Record<string, unknown>) => ReadonlyArray<ChannelBotTokenWrite>),
  tokenOrRequireSameSecret: string | boolean,
  allowedUsers?: string[],
): Promise<void> {
  const requireSameSecret = typeof tokenOrRequireSameSecret === 'boolean' ? tokenOrRequireSameSecret : false;
  const path = userConfigPath();
  const lock = await acquireLockAsync(`${path}.lock`);
  try {
    const cfg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
    const entries: ReadonlyArray<ChannelBotTokenWrite> = typeof platformOrEntries === 'string'
      ? [{ platform: platformOrEntries, token: tokenOrRequireSameSecret as string, allowedUsers }]
      : platformOrEntries(cfg);
    if (entries.length === 0) return;
    if (entries.some(({ platform, allowedUsers }) => platform === 'telegram' && allowedUsers !== undefined
      && (!Array.isArray(allowedUsers) || !allowedUsers.every(id => typeof id === 'string'
        && /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0)))) {
      throw new Error('invalid-allowed-users');
    }
    const tabs = cfg.tabs && typeof cfg.tabs === 'object' && !Array.isArray(cfg.tabs)
      ? cfg.tabs as Record<string, unknown> : {};
    const updates = entries.map(({ platform, token, allowedUsers }) => {
      const section = cfg[platform] && typeof cfg[platform] === 'object' && !Array.isArray(cfg[platform])
        ? cfg[platform] as Record<string, unknown> : {};
      const tabKey = `${platform}:1`;
      const tab = tabs[tabKey] && typeof tabs[tabKey] === 'object' && !Array.isArray(tabs[tabKey])
        ? tabs[tabKey] as Record<string, unknown> : {};
      // 기존 참조가 «같은 토큰»을 이미 가리키면 그 참조를 재사용한다(#20744 reuse-ref) — 평문만 지운다.
      // 다른 값을 가리키면 그 비밀은 남(다른 서비스와 공유 가능)이라 덮지 않고 표준 id 로 간다.
      const refId = isSecretRef(tab.tokenRef) ? secretIdFromRef(tab.tokenRef as string) : null;
      const id = refId && token && getSecret(refId) === token ? refId : `${platform}_1__tokenRef`;
      return { platform, token, allowedUsers, section, tabKey, tab, id,
        existing: token ? getSecret(id) : undefined };
    });
    if (requireSameSecret && updates.some(update => update.token && update.existing !== undefined
      && update.existing !== update.token)) throw new Error('secret conflict');
    for (const update of updates) {
      const { platform, token, allowedUsers, section, tabKey, tab, id, existing } = update;
      if (token) {
        if (existing !== token) await setSecretAsync(id, token);
        tab.tokenRef = makeSecretRef(id);
        tabs[tabKey] = tab;
        cfg.tabs = tabs;
      }
      // 평문은 «새 토큰을 저장할 때»와 «빈 평문»일 때만 지운다 — 허용 사용자만 고치는 저장은 토큰 칸을 안 건드린다.
      if (token || section.botToken === '') delete section.botToken;
      if (allowedUsers !== undefined) section.allowedUsers = platform === 'telegram'
        ? allowedUsers.map(Number) : allowedUsers;
      cfg[platform] = section;
    }
    if (!lock.stillHeld()) throw new Error('config lock lost');
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  } finally {
    lock.release();
  }
}

/** Fetch errors may contain the Telegram token-bearing URL; never propagate them. */
export async function probeChannelBotToken(
  platform: ChannelBotPlatform,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; botName?: string }> {
  try {
    const response = await fetchImpl(platform === 'telegram'
      ? `https://api.telegram.org/bot${token}/getMe` : 'https://discord.com/api/v10/users/@me',
    platform === 'discord' ? { headers: { Authorization: `Bot ${token}` } } : undefined);
    if (!response.ok) return { ok: false };
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') return { ok: false };
    const data = body as { ok?: boolean; result?: { username?: unknown }; username?: unknown };
    const name = platform === 'telegram' ? data.result?.username : data.username;
    if (platform === 'telegram' && data.ok !== true) return { ok: false };
    return typeof name === 'string' && name.trim() ? { ok: true, botName: name } : { ok: false };
  } catch {
    return { ok: false };
  }
}
