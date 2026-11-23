import type { Command } from 'commander';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { canonicalMessageAddress, defaultMsgStorePath, openMsgStore, type Message, type MsgStore } from '../msg/msg-store.js';
import { formatReceiptClockStatus, getReceipt } from '../hq/msg-receipt-clocks.js';
import { recordReceiptClock } from '../hq/msg-receipt-clock-sink.js';
import { readQueryCache } from '../storage/short-lived-read-cache.js';

interface MessageListOptions { to?: string; thread?: string; after?: string; limit?: string; all?: boolean; json?: boolean }

function integer(raw: string | undefined, flag: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  return value;
}

const KIND_EMOJI: Readonly<Record<string, string>> = {
  coord: '🤝', report: '📋', info: 'ℹ️', question: '❓', alert: '🚨', progress: '⏳', incident: '🔥', coach: '🎓',
};

export function formatMessage(message: Message, clockStatus?: string, ackState?: string): string {
  const kind = message.kind ? ` ${Object.hasOwn(KIND_EMOJI, message.kind) ? KIND_EMOJI[message.kind] : ''}[${message.kind}]` : '';
  const clock = clockStatus === undefined ? '' : ` [${clockStatus}]`;
  const ack = ackState === undefined ? '' : ` (${ackState})`;
  return `#${message.id} ${message.createdAt} ${message.from} → ${message.to}${kind}${clock}${ack}: ${message.body}`;
}

/** MSG-FILTERS-RELAX: per-row ack state for history reads — `unread` · `acked` · `done` (fail-soft: `unknown`). */
function readAckStates(store: MsgStore, messages: Message[], recipient: string): Map<number, string> {
  const states = new Map<number, string>();
  for (const message of messages) {
    try {
      const status = store.messageStatus(recipient, message.id);
      states.set(message.id, status === 'acked' || status === 'done' ? status : status === 'delivered' ? 'unread' : 'unknown');
    } catch { states.set(message.id, 'unknown'); }
  }
  return states;
}

/** [seat-mail #14 wiring] 각 행의 3계기 상태(미기록 '-'). 표가 없거나 읽기가 실패하면 빈 맵(전부 '-'). fail-soft. */
function readClockStatuses(store: MsgStore, messages: Message[], recipient: string): Map<number, string> {
  const statuses = new Map<number, string>();
  try {
    const table = store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'msg_receipt_clocks'").get();
    if (table === null) return statuses;
    for (const message of messages) statuses.set(message.id, formatReceiptClockStatus(getReceipt(store.db, message.id, recipient)));
  } catch { /* 상태 열은 fail-soft — 본체 목록은 그대로 */ }
  return statuses;
}

/** Register only msg list so the hot read route does not load post/watch/mirror producers. */
export function registerMsgListCommand(msg: Command, deps: {
  openStore?: () => MsgStore;
  cacheReads?: boolean;
  out?: Pick<Console, 'log' | 'error'>;
  setExitCode?: (code: number) => void;
} = {}): void {
  const open = deps.openStore ?? (() => openMsgStore());
  const out = deps.out ?? console;
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  msg.command('list').description('List messages for one recipient or one thread without acknowledging them')
    .option('--to <seat>').option('--thread <id>', 'request ID; list it and its replies, regardless of recipient')
    .option('--after <id>', 'exclusive message ID (default: acknowledged cursor for a recipient, 0 for a thread); includes acknowledged mail')
    .option('--all', 'include acknowledged mail from the first message, with each row\'s ack state')
    .option('--limit <count>', 'maximum messages (1–1000)').option('--json')
    .action((opts: MessageListOptions) => {
      let store: MsgStore | undefined;
      try {
        if (opts.thread !== undefined && opts.to !== undefined) throw new Error('--thread cannot be used with --to');
        const to = opts.thread === undefined
          ? (opts.to === undefined ? (() => { throw new Error('--to is required'); })() : canonicalMessageAddress(opts.to))
          : undefined;
        const threadId = opts.thread === undefined ? undefined : integer(opts.thread, '--thread', 0, 1, Number.MAX_SAFE_INTEGER);
        const limit = integer(opts.limit, '--limit', 100, 1, 1000);
        const explicitAfter = opts.after === undefined ? undefined : integer(opts.after, '--after', 0, 0, Number.MAX_SAFE_INTEGER);
        // MSG-FILTERS-RELAX: `--all` and an explicit `--after` are history reads — acknowledged mail stays in the list.
        const after = explicitAfter ?? (opts.all ? 0 : undefined);
        const history = after !== undefined;
        store = open();
        const cursor = to === undefined || after !== undefined ? null : store.getCursor(to);
        const key = { command: 'msg-list', to, threadId, after, cursor, history, sequence: store.latestId(), limit };
        const load = () => threadId === undefined
          ? store!.list(to!, after ?? cursor!, limit, { includeAcked: history })
          : store!.listThread(threadId, after ?? 0, limit);
        const messages = deps.cacheReads === false ? load() : readQueryCache({
          root: join(elanousStateRoot(), 'cache', 'cli-read-query'), key,
          sourcePaths: [`${defaultMsgStorePath()}`, `${defaultMsgStorePath()}-wal`], ttlMs: 500, load,
        });
        const nextAfter = messages.at(-1)?.id ?? after ?? cursor ?? 0;
        const remaining = to === undefined ? null : store.unreadCountAfter(to, nextAfter);
        // [seat-mail #14 wiring] 상태 열은 수신자 모드에서만 — 스토어가 살아있는 동안 읽는다(thread 모드는 기존 양식).
        const clockStatuses = to === undefined ? undefined : readClockStatuses(store, messages, to);
        const ackStates = to === undefined || !history ? undefined : readAckStates(store, messages, to);
        if (opts.json) {
          out.log(JSON.stringify(ackStates === undefined ? messages : messages.map(message => ({ ...message, ackState: ackStates.get(message.id) ?? 'unknown' }))));
          if (to !== undefined) for (const message of messages) recordReceiptClock(store.db, { messageId: message.id, recipient: to, event: 'seen' });
          if (remaining !== null && remaining > 0) out.error(`+${remaining} 더 · --after ${nextAfter}`);
        }
        else {
          if (!messages.length) out.log('No messages.');
          for (const message of messages) {
            out.log(formatMessage(message, clockStatuses === undefined ? undefined : clockStatuses.get(message.id) ?? '-', ackStates?.get(message.id)));
            if (to !== undefined) recordReceiptClock(store.db, { messageId: message.id, recipient: to, event: 'seen' });
          }
          if (remaining !== null) out.log(`+${remaining} 더 · --after ${nextAfter}`);
        }
        store.close();
        store = undefined;
      } catch (error) {
        store?.close();
        out.error(`msg: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(2);
      }
    });
}
