import type { Command } from 'commander';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { canonicalSeatId, defaultMsgStorePath, openMsgStore, type Message, type MsgStore } from '../msg/msg-store.js';
import { readQueryCache } from '../storage/short-lived-read-cache.js';

interface MessageListOptions { to?: string; thread?: string; after?: string; limit?: string; json?: boolean }

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

export function formatMessage(message: Message): string {
  const kind = message.kind ? ` ${Object.hasOwn(KIND_EMOJI, message.kind) ? KIND_EMOJI[message.kind] : ''}[${message.kind}]` : '';
  return `#${message.id} ${message.createdAt} ${message.from} → ${message.to}${kind}: ${message.body}`;
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
    .option('--after <id>', 'exclusive message ID (default: acknowledged cursor for a recipient, 0 for a thread)')
    .option('--limit <count>', 'maximum messages (1–1000)').option('--json')
    .action((opts: MessageListOptions) => {
      let store: MsgStore | undefined;
      try {
        if (opts.thread !== undefined && opts.to !== undefined) throw new Error('--thread cannot be used with --to');
        const to = opts.thread === undefined
          ? (opts.to === undefined ? (() => { throw new Error('--to is required'); })() : canonicalSeatId(opts.to))
          : undefined;
        const threadId = opts.thread === undefined ? undefined : integer(opts.thread, '--thread', 0, 1, Number.MAX_SAFE_INTEGER);
        const limit = integer(opts.limit, '--limit', 100, 1, 1000);
        const after = opts.after === undefined ? undefined : integer(opts.after, '--after', 0, 0, Number.MAX_SAFE_INTEGER);
        store = open();
        const cursor = to === undefined || after !== undefined ? null : store.getCursor(to);
        const key = { command: 'msg-list', to, threadId, after, cursor, sequence: store.latestId(), limit };
        const load = () => threadId === undefined
          ? store!.list(to!, after ?? cursor!, limit)
          : store!.listThread(threadId, after ?? 0, limit);
        const messages = deps.cacheReads === false ? load() : readQueryCache({
          root: join(elanousStateRoot(), 'cache', 'cli-read-query'), key,
          sourcePaths: [`${defaultMsgStorePath()}`, `${defaultMsgStorePath()}-wal`], ttlMs: 500, load,
        });
        store.close();
        store = undefined;
        if (opts.json) out.log(JSON.stringify(messages));
        else {
          if (!messages.length) out.log('No messages.');
          for (const message of messages) out.log(formatMessage(message));
        }
      } catch (error) {
        store?.close();
        out.error(`msg: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(2);
      }
    });
}
