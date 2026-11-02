import { createHash } from 'node:crypto';
import type { TelegramFetch } from '../video-pipeline/telegram-video-sender.js';

export interface FakeTelegramVideoReceipt {
  readonly endpoint: string;
  readonly chatId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly caption: string;
  readonly messageId: number | string;
}

export interface FakeTelegramVideoOptions {
  token?: string;
  messageId?: number | string;
  httpStatus?: number;
  ok?: boolean;
  description?: string;
}

/** In-memory Telegram Bot API sendVideo boundary; it never opens a socket. */
export function createFakeTelegramVideoReceipt(options: FakeTelegramVideoOptions = {}) {
  const token = options.token ?? 'test-token';
  const messageId = options.messageId ?? 7001;
  const endpoint = `https://api.telegram.org/bot${token}/sendVideo`;
  const receipts: FakeTelegramVideoReceipt[] = [];
  let calls = 0;
  const fetch: TelegramFetch = async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (url !== endpoint) throw new Error(`fake-telegram-video: unexpected endpoint ${url}`);
    if (init?.method !== 'POST') throw new Error(`fake-telegram-video: expected POST, got ${String(init?.method)}`);
    if (!(init.body instanceof FormData)) throw new Error('fake-telegram-video: expected multipart FormData body');
    const video = init.body.get('video');
    if (!(video instanceof File)) throw new Error('fake-telegram-video: video field must be a file');
    const chatId = init.body.get('chat_id');
    const caption = init.body.get('caption');
    if (typeof chatId !== 'string' || chatId.length === 0) throw new Error('fake-telegram-video: chat_id is required');
    if (typeof caption !== 'string') throw new Error('fake-telegram-video: caption is required');
    calls += 1;
    const contentSha256 = createHash('sha256').update(Buffer.from(await video.arrayBuffer())).digest('hex');
    const status = options.httpStatus ?? 200;
    const ok = options.ok ?? true;
    if (ok && status >= 200 && status < 300) {
      receipts.push({ endpoint: url, chatId, fileName: video.name, contentType: video.type, byteLength: video.size, contentSha256, caption, messageId });
    }
    const payload = ok
      ? { ok: true, result: { message_id: messageId } }
      : { ok: false, description: options.description ?? 'injected Telegram rejection' };
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls: () => calls, receipts: () => receipts.map((receipt) => ({ ...receipt })) };
}
