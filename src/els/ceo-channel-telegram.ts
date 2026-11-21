// The telegram face of the CEO channel (OP-CHANNEL-INGRESS-1121 row ①): a getUpdates long-poll loop that
// hands every allowed private message to createCeoChannel's door, and the egress that replies into the
// SAME chat, threaded on the CEO message (row ④). The personal polling script (tg-op-bot.ts) retires;
// this adapter is the product entrance the els daemon runs.
//
// Fail-soft: a refused getUpdates, a failed send or a thrown handler is one logged line and a retry —
// the loop never dies and never touches the queue beyond channel.receive().
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import type { CeoChannel, CeoInbound } from './ceo-channel.js';

export interface CeoTelegramAdapterOpts {
  readonly stateDir: string;
  readonly token: string;
  readonly channel: CeoChannel;
  /** Long-poll length (Telegram caps at 50 s; 25 keeps the loop lively). */
  readonly pollTimeoutSec?: number;
  /** The offset file lives in stateDir; started fresh when absent. */
  readonly fetchImpl?: typeof fetch;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly stopped?: () => boolean;
}

export interface CeoTelegramAdapter {
  /** One getUpdates pass → channel.receive for every new private message. Returns updates handled. */
  pollOnce(): Promise<number>;
  /** Row ④ egress — sendMessage into the same chat, threaded on the CEO message. */
  sendReply(inbound: CeoInbound, text: string): Promise<boolean>;
  /** The current cursor (also persisted to disk after every handled update). */
  offset(): number;
}

/** The bot API base — never logged (the token rides only in the URL given to fetch). */
const api = (token: string, method: string): string => `https://api.telegram.org/bot${token}/${method}`;

/** OP #119477 ② — an exception or a response-error log that quotes the bot URL is masked: api.telegram.org/bot<…>. */
const redactToken = (text: string): string => text.replace(/(api\.telegram\.org\/bot)[^/\s'"]+/g, '$1<…>');

const defaultLog = (event: string, data: Record<string, unknown>): void => { debug.log('ceo-telegram', event, data); };

export function createCeoTelegramAdapter(opts: CeoTelegramAdapterOpts): CeoTelegramAdapter {
  const stateDir = opts.stateDir;
  mkdirSync(stateDir, { recursive: true });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? defaultLog;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollTimeoutSec = Math.min(Math.max(opts.pollTimeoutSec ?? 25, 1), 50);
  const offsetFile = join(stateDir, 'telegram-offset');
  let offset = existsSync(offsetFile) ? Number(readFileSync(offsetFile, 'utf8')) || 0 : 0;

  const audit = (line: string): void => {
    try { appendFileSync(join(stateDir, 'ceo-telegram-audit.jsonl'), `${line}\n`); } catch { /* never breaks the loop */ }
  };

  return {
    offset: () => offset,
    pollOnce: async () => {
      const url = `${api(opts.token, 'getUpdates')}?timeout=${pollTimeoutSec}&offset=${offset}`;
      const response = await fetchImpl(url);
      const body = await response.json() as { ok?: boolean; result?: Array<Record<string, unknown>>; description?: string };
      if (!body.ok) { audit(redactToken(`getUpdates failed ${String(body.description ?? response.status)}`).slice(0, 80)); return 0; }
      let handled = 0;
      for (const update of body.result ?? []) {
        const updateId = update.update_id;
        if (typeof updateId !== 'number') continue;
        /** OP #119477 ① — the cursor moves only once the door has the row (or said a final word): 전진은 저장 성공 뒤에. */
        const advance = (): void => {
          offset = updateId + 1;
          try { writeFileSync(offsetFile, String(offset), { mode: 0o600 }); } catch { /* the cursor re-advances on the next pass */ }
        };
        const message = (update.message ?? update.edited_message) as Record<string, unknown> | undefined;
        if (!message || typeof message !== 'object') { advance(); continue; }
        const chat = message.chat as Record<string, unknown> | undefined;
        if (!chat || chat.type !== 'private') { advance(); continue; }
        const text = String((message.text ?? message.caption ?? '')).trim() || '(텍스트 없음 · 사진/파일)';
        const inbound: CeoInbound = {
          source: 'telegram',
          chatId: String(chat.id),
          senderId: String((message.from as Record<string, unknown> | undefined)?.id ?? ''),
          messageId: String(message.message_id ?? ''),
          text,
          at: Number(message.date ?? 0) * 1000 || Date.now(),
        };
        if (!inbound.messageId) { advance(); continue; }
        try {
          const received = await opts.channel.receive(inbound);
          advance(); // ① 저장 성공 뒤에만 전진 — the cursor never passes a row it does not hold
          audit(`receive ${received.status} chat=${inbound.chatId} message=${inbound.messageId}`);
          if (received.status === 'accepted') handled += 1;
        } catch (error) {
          // ① OP #119477 — a receive that throws (store failure) is 전진 0: the same update returns on the
          // next long-poll and the queue's (source, chat_id, message_id) key keeps the retry 중복 0.
          log('receive-threw', { messageId: inbound.messageId, error: redactToken(error instanceof Error ? error.message : String(error)) });
          break;
        }
      }
      return handled;
    },
    sendReply: async (inbound, text) => {
      try {
        const response = await fetchImpl(api(opts.token, 'sendMessage'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: inbound.chatId, text, reply_to_message_id: Number(inbound.messageId) || undefined, disable_web_page_preview: true }),
        });
        const body = await response.json() as { ok?: boolean; description?: string };
        if (!body.ok) { audit(redactToken(`sendReply failed ${String(body.description ?? response.status)}`).slice(0, 80)); return false; }
        audit(`sendReply ok chat=${inbound.chatId} message=${inbound.messageId}`);
        return true;
      } catch (error) {
        log('send-reply-threw', { messageId: inbound.messageId, error: redactToken(error instanceof Error ? error.message : String(error)) });
        return false;
      }
    },
  };
}

/** The loop the daemon runs: poll → handled, back off on error, stop on the STOP file or stopped(). */
export async function runCeoTelegramLoop(adapter: CeoTelegramAdapter, opts: {
  readonly stateDir: string;
  readonly pollTimeoutSec?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly stopped?: () => boolean;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? defaultLog;
  const stopFile = join(opts.stateDir, 'STOP');
  // The long-poll IS the pace; a short sleep only spaces failed passes.
  const errorPauseMs = 5_000;
  while (!existsSync(stopFile) && !(opts.stopped?.() ?? false)) {
    try {
      await adapter.pollOnce();
    } catch (error) {
      log('poll-threw', { error: redactToken(error instanceof Error ? error.message : String(error)) });
      await sleep(errorPauseMs);
    }
    if (opts.pollTimeoutSec === 0) await sleep(1_000);
  }
  log('loop-stop', { stopFile: existsSync(stopFile) });
}