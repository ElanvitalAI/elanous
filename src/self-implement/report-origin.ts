import type { MissionOrigin } from '../autopilot/mission-origin.js';

export const REPORT_ORIGIN_ENV = 'ELANOUS_REPORT_ORIGIN';

const CHANNELS = new Set<MissionOrigin['channel']>(['telegram', 'pwa', 'voice', 'cli', 'api', 'tui', 'discord']);
const SNOWFLAKE = /^\d{1,20}$/;

function isReportOrigin(value: unknown): value is MissionOrigin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const origin = value as Record<string, unknown>;
  if (!CHANNELS.has(origin.channel as MissionOrigin['channel'])) return false;
  // Discord carries its own reply target (channel ⊕ optional thread snowflakes) — same shape as MissionOrigin.
  if (origin.channel === 'discord') {
    for (const key of Object.keys(origin)) {
      if (!['channel', 'channelId', 'discordThreadId', 'botId', 'hitlMessageId'].includes(key)) return false;
    }
    return typeof origin.channelId === 'string' && SNOWFLAKE.test(origin.channelId)
      && (origin.discordThreadId === undefined || (typeof origin.discordThreadId === 'string' && SNOWFLAKE.test(origin.discordThreadId)))
      && (origin.botId === undefined || (typeof origin.botId === 'string' && origin.botId.length > 0))
      && (origin.hitlMessageId === undefined || Number.isSafeInteger(origin.hitlMessageId));
  }
  if (origin.channel === 'telegram' && (!Number.isSafeInteger(origin.chatId) || origin.chatId === 0)) return false;
  for (const key of Object.keys(origin)) {
    if (!['channel', 'chatId', 'botId', 'threadId', 'hitlMessageId'].includes(key)) return false;
  }
  return (origin.chatId === undefined || Number.isSafeInteger(origin.chatId))
    && (origin.botId === undefined || (typeof origin.botId === 'string' && origin.botId.length > 0))
    && (origin.threadId === undefined || Number.isSafeInteger(origin.threadId))
    && (origin.hitlMessageId === undefined || Number.isSafeInteger(origin.hitlMessageId));
}

export function encodeReportOriginEnv(origin: MissionOrigin): Record<typeof REPORT_ORIGIN_ENV, string> {
  return { [REPORT_ORIGIN_ENV]: JSON.stringify(origin) };
}

// `NodeJS.ProcessEnv` 가 아니라 읽는 칸만 — Next 타입이 ProcessEnv 에 NODE_ENV 를 필수로 더해 객체 리터럴 호출(`harness-api.ts`)이 PWA 빌드에서 깨졌다(2026-09-27 #21122).
export function readReportOrigin(env: Readonly<Record<string, string | undefined>>): MissionOrigin | null {
  const raw = env[REPORT_ORIGIN_ENV];
  if (!raw) return null;
  try {
    const origin: unknown = JSON.parse(raw);
    return isReportOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

export function formatPtyLinkMessage({ webUrl, ptyId, title }: { webUrl: string; ptyId: string; title?: string }): string {
  return `${title ? `${title} · ` : ''}이너 PTY ${ptyId}: ${webUrl}\n읽기 전용 · 쓰려면 takeover`;
}
