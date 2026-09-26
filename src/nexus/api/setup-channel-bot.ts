import { debug } from '../../debug/log.js';
import { probeChannelBotToken, resolveChannelBotToken, storeChannelBotToken, type ChannelBotPlatform } from '../../channel-bot-token.js';
import { getUserConfig, reloadUserConfig } from '../../user-config.js';
import { userConfigPath } from '../config/paths.js';

const PLATFORMS: ChannelBotPlatform[] = ['telegram', 'discord'];

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** GET /v1/setup/channel-bots — never return a credential or its metadata. */
export function handleChannelBotsGet(): Response {
  const cfg = getUserConfig(userConfigPath());
  return json({ platforms: PLATFORMS.map(platform => {
    const resolved = resolveChannelBotToken(platform, cfg);
    return {
      platform,
      configured: Boolean(resolved),
      source: resolved?.source ?? null,
      allowedUsers: (cfg[platform]?.allowedUsers ?? []).map(String),
    };
  }) });
}

/** POST /v1/setup/channel-bot — validate every field before any write. */
export async function handleChannelBotSet(req: Request, fetchImpl: typeof fetch = fetch): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: 'invalid-json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid-body' }, 400);
  const input = body as Record<string, unknown>;
  if (input.platform !== 'telegram' && input.platform !== 'discord') return json({ error: 'invalid-platform' }, 400);
  const platform = input.platform;
  if ('token' in input && (typeof input.token !== 'string' || !input.token.trim())) return json({ error: 'invalid-token' }, 400);
  if ('allowedUsers' in input && (!Array.isArray(input.allowedUsers)
    || !input.allowedUsers.every(value => typeof value === 'string' && /^\d+$/.test(value)
      && (platform === 'discord' || (Number.isSafeInteger(Number(value)) && Number(value) > 0))))) {
    return json({ error: 'invalid-allowed-users' }, 400);
  }
  if (!('token' in input) && !('allowedUsers' in input)) return json({ error: 'empty-body' }, 400);
  if (Object.keys(input).some(key => !['platform', 'token', 'allowedUsers'].includes(key))) return json({ error: 'unknown-fields' }, 400);
  const token = input.token as string | undefined;
  const allowedUsers = input.allowedUsers as string[] | undefined;
  const probed = token !== undefined;
  const result = token ? await probeChannelBotToken(platform, token, fetchImpl) : undefined;
  if (result && !result.ok) return json({ error: 'bot-token-rejected' }, 400);
  try {
    await storeChannelBotToken(platform, token ?? '', allowedUsers);
    reloadUserConfig(userConfigPath());
  } catch {
    return json({ error: 'channel-bot-store-failed' }, 500);
  }
  debug.log('pwa.settings', 'channel-bot-set', { platform, probed, allowedUsersCount: allowedUsers?.length ?? getUserConfig(userConfigPath())[platform].allowedUsers.length });
  return json({ ok: true, ...(token && result?.botName && !result.botName.includes(token)
    ? { botName: result.botName } : {}), restartNeeded: true });
}
