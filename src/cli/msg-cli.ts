import type { Command } from 'commander';
import { canonicalSeatId, openMsgStore, type Message, type MsgStore } from '../msg/msg-store.js';

export interface MsgCliDeps {
  openStore?: () => MsgStore;
  out?: Pick<Console, 'log' | 'error'>;
  readStdin?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  setExitCode?: (code: number) => void;
  signal?: AbortSignal;
}

type CommonOptions = { json?: boolean };
type RecipientOptions = CommonOptions & { to?: string; after?: string; limit?: string };

function seat(raw: string | undefined, flag: string): string {
  if (raw === undefined) throw new Error(`${flag} is required`);
  return canonicalSeatId(raw);
}

function integer(raw: string | undefined, flag: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  return value;
}

function formatMessage(message: Message): string {
  return `#${message.id} ${message.createdAt} ${message.from} → ${message.to}${message.kind ? ` [${message.kind}]` : ''}: ${message.body}`;
}

/** Register the durable, recipient-addressed CLI. Reading never advances the acknowledgement cursor. */
export function registerMsgCommands(program: Command, deps: MsgCliDeps = {}): void {
  const open = deps.openStore ?? (() => openMsgStore());
  const out = deps.out ?? console;
  const readStdin = deps.readStdin ?? (() => Bun.stdin.text());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const msg = program.command('msg').description('Durable seat-addressed messages');

  const run = (action: () => void | Promise<void>) => async () => {
    try { await action(); }
    catch (error) {
      out.error(`msg: ${error instanceof Error ? error.message : String(error)}`);
      setExitCode(2);
    }
  };
  const withStore = <T>(action: (store: MsgStore) => T): T => {
    const store = open();
    try { return action(store); }
    finally { store.close(); }
  };
  const emit = (value: unknown, json: boolean | undefined, human: () => void) => {
    if (json) out.log(JSON.stringify(value));
    else human();
  };

  msg.command('post [body]').description('Post a message; use - or omit body to read stdin')
    .option('--from <seat>').option('--to <seat>').option('--kind <kind>').option('--body <text>').option('--json')
    .action((body: string | undefined, opts: CommonOptions & { from?: string; to?: string; kind?: string; body?: string }) => run(async () => {
      const from = seat(opts.from, '--from');
      const to = seat(opts.to, '--to');
      if (body !== undefined && body !== '-' && opts.body !== undefined) throw new Error('provide body once (argument or --body)');
      const text = opts.body ?? (body !== undefined && body !== '-' ? body : await readStdin());
      const posted = withStore(store => store.post({ from, to, body: text, ...(opts.kind === undefined ? {} : { kind: opts.kind }) }));
      emit(posted, opts.json, () => out.log(formatMessage(posted)));
    })());

  msg.command('list').description('List messages for one recipient without acknowledging them')
    .option('--to <seat>').option('--after <id>', 'exclusive message ID (default: acknowledged cursor)')
    .option('--limit <count>', 'maximum messages (1–1000)').option('--json')
    .action((opts: RecipientOptions) => run(() => {
      const to = seat(opts.to, '--to');
      const limit = integer(opts.limit, '--limit', 100, 1, 1000);
      const after = opts.after === undefined ? undefined : integer(opts.after, '--after', 0, 0, Number.MAX_SAFE_INTEGER);
      const messages = withStore(store => store.list(to, after ?? store.getCursor(to), limit));
      emit(messages, opts.json, () => {
        if (!messages.length) out.log('No messages.');
        for (const message of messages) out.log(formatMessage(message));
      });
    })());

  msg.command('ack [id]').description('Explicitly acknowledge messages through this ID for one recipient')
    .option('--to <seat>').option('--json')
    .action((id: string | undefined, opts: CommonOptions & { to?: string }) => run(() => {
      const to = seat(opts.to, '--to');
      if (id === undefined) throw new Error('message ID is required');
      const cursor = integer(id, 'message ID', 0, 0, Number.MAX_SAFE_INTEGER);
      const acknowledged = withStore(store => store.ack(to, cursor));
      emit({ recipient: to, cursor: acknowledged }, opts.json, () => out.log(`${to} acknowledged through #${acknowledged}`));
    })());

  msg.command('unread').description('Show recipients with unacknowledged messages')
    .option('--to <seat>').option('--json')
    .action((opts: CommonOptions & { to?: string }) => run(() => {
      const to = opts.to === undefined ? undefined : seat(opts.to, '--to');
      const rows = withStore(store => store.unread().filter(row => to === undefined || row.recipient === to));
      emit(rows, opts.json, () => {
        if (!rows.length) out.log('No unread messages.');
        for (const row of rows) out.log(`${row.recipient}: ${row.count} unread`);
      });
    })());

  msg.command('watch').description('Poll for new messages without acknowledging them (Ctrl-C to stop)')
    .option('--to <seat>').option('--after <id>', 'exclusive message ID (default: acknowledged cursor)')
    .option('--interval <ms>', 'poll interval in milliseconds', '1000')
    .option('--once', 'poll once and exit').option('--json')
    .action((opts: RecipientOptions & { interval?: string; once?: boolean }) => run(async () => {
      const to = seat(opts.to, '--to');
      const interval = integer(opts.interval, '--interval', 1000, 1, 60000);
      const after = opts.after === undefined ? undefined : integer(opts.after, '--after', 0, 0, Number.MAX_SAFE_INTEGER);
      const store = open();
      try {
        let cursor = after ?? store.getCursor(to);
        do {
          let messages: Message[];
          do {
            messages = store.list(to, cursor, 1000);
            for (const message of messages) {
              emit(message, opts.json, () => out.log(formatMessage(message)));
              cursor = message.id;
            }
          } while (messages.length === 1000 && !deps.signal?.aborted);
          if (opts.once || deps.signal?.aborted) break;
          await sleep(interval);
        } while (!deps.signal?.aborted);
      } finally { store.close(); }
    })());

  // Commander reports option/argument errors before action handlers run. Scope their exit code
  // to msg so unrelated commands keep their own error and help behavior.
  for (const command of [msg, ...msg.commands]) {
    const reportError = command.error.bind(command);
    command.error = (message, options) => reportError(message, { ...options, exitCode: 2 });
  }
}
