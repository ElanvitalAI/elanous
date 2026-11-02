import { readFileSync } from 'node:fs';

export type TelegramFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TelegramVideoSenderOptions {
  apiBase: string;
  token: string;
  chatId: string | number;
  fetchImpl?: TelegramFetch;
}

/** Wire Telegram delivery into the production graph state when recipient and token are present. */
export function configureTelegramVideoDelivery(
  state: Record<string, unknown>,
  graphId: string,
  env: Partial<Pick<NodeJS.ProcessEnv, 'TELEGRAM_API_BASE' | 'TELEGRAM_BOT_TOKEN'>>,
  fetchImpl?: TelegramFetch,
): boolean {
  const chatId = state.telegram_chat_id;
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (graphId !== 'explainer-line' || (typeof chatId !== 'string' && typeof chatId !== 'number') || !token) return false;
  state.sendTelegramVideo = createTelegramVideoSender({
    apiBase: env.TELEGRAM_API_BASE ?? 'https://api.telegram.org', token, chatId, fetchImpl,
  });
  return true;
}

/** Build the production sendVideo callback used by explainer-line delivery. */
export function createTelegramVideoSender(options: TelegramVideoSenderOptions): (file: string, briefing: unknown) => Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase.replace(/\/$/, '');
  return async (file, briefing) => {
    const form = new FormData();
    form.set('chat_id', String(options.chatId));
    form.set('video', new Blob([readFileSync(file)], { type: 'video/mp4' }), 'briefing.mp4');
    const title = briefing && typeof briefing === 'object' && 'title' in briefing
      ? String((briefing as { title: unknown }).title)
      : '60초 브리핑 영상';
    form.set('caption', title);
    const response = await fetchImpl(`${apiBase}/bot${options.token}/sendVideo`, { method: 'POST', body: form });
    const payload = await response.json() as { ok?: boolean; result?: { message_id?: number | string }; description?: string };
    if (!response.ok || payload.ok !== true || payload.result?.message_id === undefined) {
      throw new Error(`Telegram sendVideo failed: ${payload.description ?? `HTTP ${response.status}`}`);
    }
    return String(payload.result.message_id);
  };
}
