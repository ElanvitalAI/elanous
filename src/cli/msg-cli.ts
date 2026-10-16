import type { Command } from 'commander';
import { ensureAuthToken } from '../auth/acp-token.js';
import { canonicalSeatId, openMsgStore, openMsgStoreReadOnly, type Message, type MsgStore } from '../msg/msg-store.js';
import { startMsgSseServer } from '../msg/msg-sse-server.js';
import { messageRouteFor, noReplyBodyNotice, unsupportedLoopAddressNotice } from '../loops/msg-address.js';
import { resolveWake, wakeRecipient, type WakeDeps, type WakeOutcome } from '../loops/msg-wake.js';

export interface MsgCliDeps {
  openStore?: () => MsgStore;
  openReadStore?: () => MsgStore;
  out?: Pick<Console, 'log' | 'error'>;
  readStdin?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  setExitCode?: (code: number) => void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  authToken?: () => string;
  /** Wake-path resolution for `msg route` (tests inject; default reads pty manifest ⊕ seat folders). */
  wakeDeps?: WakeDeps;
  /** Attach the logs.db sink so `msg.wake` reaches `elanous logs` (a short CLI otherwise writes only the file trail). */
  registerLogSink?: () => Promise<unknown>;
  /** Wake the recipient after a durable post; never changes the post outcome. */
  wake?: (address: string, msgId: number, message: { from: string; kind?: string }, deps: WakeDeps) => Promise<WakeOutcome>;
  /** Test seams for the existing self-send transport and the selected task-card ledger. */
  readCard?: typeof import('../task-agent/task-hand.js').readTaskCard;
  podFragmentsForRun?: typeof import('../harness/self-send-target.js').listPodFragmentsForRun;
  sendPod?: typeof import('../harness/self-send-target.js').dispatchPodSelfSend;
  runScreen?: typeof import('../self-implement/run-ledger.js').queryRunScreenKey;
  sendMemo?: typeof import('../harness/control-inbox.js').enqueueControlMemo;
  sendStop?: typeof import('../harness/control-inbox.js').enqueueSoftStop;
  screenAlive?: (spaceId: string) => boolean;
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

/** Emoji prefix per known kind; the `[kind]` text itself stays because operating scripts grep for it. */
const KIND_EMOJI: Readonly<Record<string, string>> = {
  coord: '🤝', report: '📋', info: 'ℹ️', question: '❓', alert: '🚨', progress: '⏳', incident: '🔥', coach: '🎓',
};

export function formatMessage(message: Message): string {
  const kind = message.kind ? ` ${Object.hasOwn(KIND_EMOJI, message.kind) ? KIND_EMOJI[message.kind] : ''}[${message.kind}]` : '';
  return `#${message.id} ${message.createdAt} ${message.from} → ${message.to}${kind}: ${message.body}`;
}

/** Register the durable, recipient-addressed CLI. Reading never advances the acknowledgement cursor. */
export function registerMsgCommands(program: Command, deps: MsgCliDeps = {}): void {
  const open = deps.openStore ?? (() => openMsgStore());
  const openRead = deps.openReadStore ?? (() => openMsgStoreReadOnly());
  const out = deps.out ?? console;
  const readStdin = deps.readStdin ?? (() => Bun.stdin.text());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const msg = program.command('msg').description('Durable seat-addressed messages');

  // Called by both msg post and msg ask after their durable TA request is written.
  const handleTaMessage = async (request: Message): Promise<void> => {
    if (request.to !== 'TA' || request.from === 'TA' || request.replyTo !== undefined) return;
    const command = /\b(stop|memo|status)\b/i.exec(request.body);
    const cardId = /\bta-[a-zA-Z0-9][a-zA-Z0-9._-]*\b/.exec(request.body)?.[0]?.replace(/[.,!?]+$/, '');
    if (!command || !cardId) return;
    const { readTaskCard } = await import('../task-agent/task-hand.js');
    const { queryRunScreenKey } = await import('../self-implement/run-ledger.js');
    const { listHarnessScreens } = await import('../harness/harness-screen.js');
    const { normalizeRunId } = await import('../harness/harness-space.js');
    const { dispatchPodSelfSend, listPodFragmentsForRun } = await import('../harness/self-send-target.js');
    const { enqueueControlMemo, enqueueSoftStop } = await import('../harness/control-inbox.js');
    withStore(store => {
      // Reserve one linked reply and pending delivery before touching another store or Pod.
      const pending = store.db.transaction(() => {
        // A concurrent sender may have claimed after an earlier read. Keep this
        // check in the same write transaction as any pending reply change.
        if (store.taDeliveryClaimState(request.id) === 'held') return null;
        const reply = store.listReplies(request.id, 1)[0];
        if (reply && store.taDeliveryStatus(request.id) !== 'pending') return null;
        let delivery: (() => void) | undefined;
        let deliveryReply: string | undefined;
        let answer: string;
        try {
          const card = (deps.readCard ?? readTaskCard)(cardId);
          if (!card) throw new Error(`카드 없음: ${cardId}`);
          if (command[1]!.toLowerCase() === 'status') {
            answer = `${card.id}: ${card.status}${card.runId ? ` · run ${card.runId}` : ''}`;
          } else {
            const runId = card.runId;
            if (!runId || normalizeRunId(runId) !== runId) throw new Error(`${cardId}: 연결된 런 없음`);
            const fragments = (deps.podFragmentsForRun ?? listPodFragmentsForRun)(runId);
            const resolved = fragments.length === 0 ? (deps.runScreen ?? queryRunScreenKey)(runId) : null;
            const screen = resolved?.logStoreStatus === 'read' ? resolved.screenKey : null;
            if (fragments.length > 1 || (fragments.length === 0 && (!screen || !(deps.screenAlive ?? ((id: string) => listHarnessScreens().some(row => row.spaceId === id)))(screen)))) {
              throw new Error(`${cardId}: 실행 중인 단일 런 공간을 찾을 수 없음`);
            }
            const space = fragments[0]?.spaceId ?? screen!;
            const stop = command[1]!.toLowerCase() === 'stop';
            const body = stop ? '' : request.body.replace(command[0], '').replace(cardId, '').trim().replace(/^[,.:;\s-]+/, '');
            if (!stop && (!body || /[\r\n]/.test(body))) throw new Error('memo는 비어 있지 않은 한 줄이어야 한다');
            const memo = { version: 1 as const, kind: 'supervisor', urgency: 'normal' as const, body };
            answer = `${cardId}: run ${runId} 전달 여부 미확인 (${space}) — 자동 재시도 중지; 런 인박스를 확인하세요.`;
            delivery = () => {
              if (fragments.length) {
                if (!(deps.sendPod ?? dispatchPodSelfSend)(space, stop ? { stop: true } : { memo })) throw new Error(`${cardId}: Pod 전달 실패`);
              } else if (stop) (deps.sendStop ?? enqueueSoftStop)(space);
              else (deps.sendMemo ?? enqueueControlMemo)(space, memo);
            };
            deliveryReply = stop ? `${cardId}: run ${runId} soft stop 요청 기록 (${space})`
              : `${cardId}: run ${runId} 감독 메모 기록 (${space})`;
          }
        } catch (error) {
          answer = `${cardId}: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (delivery) store.setTaDeliveryStatus(request.id, 'pending');
        if (reply) store.updateTaReply(request.id, answer);
        else store.post({ from: 'TA', to: request.from, kind: 'reply', body: answer, replyTo: request.id });
        return delivery && deliveryReply ? { delivery, reply: deliveryReply } : null;
      }).immediate();
      if (pending) {
        const claim = store.claimTaDelivery(request.id);
        if (!claim) return;
        try {
          pending.delivery();
          store.settleTaDelivery(request.id, claim, pending.reply, true);
        }
        catch (error) {
          // A transport error or failed DB settlement may follow a successful publication.
          // Keep the claim and require inspection rather than send the same memo again.
          store.markTaDeliveryUnknown(request.id, claim,
            `${cardId}: 전달 여부 미확인 — 자동 재시도 중지: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  };

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
    .option('--from <seat>').option('--to <seat>').option('--kind <kind>').option('--body <text>')
    .option('--reply-to <id>', 'point this reply at a question message ID')
    .option('--origin-key <key>', 'deduplicate a channel mirror by coord:<commentId>:<recipient>').option('--json')
    .action((body: string | undefined, opts: CommonOptions & { from?: string; to?: string; kind?: string; body?: string; replyTo?: string; originKey?: string }) => run(async () => {
      const from = seat(opts.from, '--from');
      const unsupported = opts.to === undefined ? null : unsupportedLoopAddressNotice(opts.to);
      if (unsupported) out.error(unsupported);
      const to = seat(opts.to, '--to');
      if (body !== undefined && body !== '-' && opts.body !== undefined) throw new Error('provide body once (argument or --body)');
      const text = opts.body ?? (body !== undefined && body !== '-' ? body : await readStdin());
      const envelope = { from, to, body: text,
        ...(opts.kind === undefined ? {} : { kind: opts.kind }),
        ...(opts.replyTo === undefined ? {} : { replyTo: integer(opts.replyTo, '--reply-to', 0, 1, Number.MAX_SAFE_INTEGER) }) };
      const posted = withStore(store => opts.originKey === undefined
        ? store.post(envelope)
        : store.appendWithProvenance(envelope, opts.originKey));
      emit(posted, opts.json, () => out.log(formatMessage(posted)));
      await handleTaMessage(posted); // msg post: process the durable TA request (including pending retry).
      const noBody = noReplyBodyNotice(to);
      if (noBody) out.error(noBody);
      // 저장 «뒤» 한 번 — 읽는 몸이 없다는 안내가 이미 나갔으면 깨움 경고는 겹쳐 내지 않는다.
      // 깨움은 post 의 성패를 바꾸지 않는다 — 동기 예외까지 여기서 막는다.
      // 로그 싱크 등록이 멈춰도 깨움·post 완료를 붙잡지 않는다(1초 상한).
      try {
        let sinkTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          (deps.registerLogSink ?? (async () => (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('cli')))(),
          new Promise<void>(resolve => { sinkTimer = setTimeout(resolve, 1000); }),
        ]).finally(() => clearTimeout(sinkTimer));
      } catch { /* observability is fail-open */ }
      try {
        await (deps.wake ?? wakeRecipient)(to, posted.id, { from, ...(opts.kind === undefined ? {} : { kind: opts.kind }) },
          { ...deps.wakeDeps, warn: noBody ? () => {} : line => out.error(line) });
      } catch { /* the wake outcome is logged by wakeRecipient; the post is already durable */ }
    })());

  msg.command('route <address>').description('Show how a post to this address is read (replyBody) and woken (wake)')
    .option('--json')
    .action((address: string, opts: CommonOptions) => run(() => {
      const to = canonicalSeatId(address);
      const wake = resolveWake(to, deps.wakeDeps);
      const row = { msgAddress: to, replyBody: messageRouteFor(to)?.replyBody ?? null, ...wake };
      emit(row, opts.json, () => out.log(`${to}\treplyBody=${row.replyBody ?? '모름'}\twake=${wake.wake}`
        + `${wake.target ? `\ttarget=${wake.target}` : ''}${wake.optIn === undefined ? '' : `\toptIn=${wake.optIn ? 'yes' : 'no(주입 0)'}`}`
        + `\t(${wake.source}${wake.reason ? `: ${wake.reason}` : ''})`));
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
      const rows = withStore(store => {
        if (to === undefined) return store.unread();
        const count = store.unreadCount(to);
        return count ? [{ recipient: to, count }] : [];
      });
      emit(rows, opts.json, () => {
        if (!rows.length) out.log('No unread messages.');
        for (const row of rows) out.log(`${row.recipient}: ${row.count} unread`);
      });
    })());

  msg.command('watch').description('Watch durable messages; SSE accelerates delivery and polling covers outages')
    .option('--to <seat>').option('--after <id>', 'exclusive message ID (default: acknowledged cursor)')
    .option('--since-ack', 'start from the recipient seat’s acknowledged cursor')
    .option('--interval <ms>', 'poll interval in milliseconds', '1000')
    .option('--sse <url>', 'post office base URL (fall back to ledger polling on disconnect)')
    .option('--once', 'poll once and exit').option('--json')
    .action((opts: RecipientOptions & { interval?: string; once?: boolean; sinceAck?: boolean; sse?: string }) => run(async () => {
      if (opts.sinceAck && opts.after !== undefined) throw new Error('--since-ack cannot be used with --after');
      const to = seat(opts.to, '--to');
      const interval = integer(opts.interval, '--interval', 1000, 1, 60000);
      const after = opts.after === undefined ? undefined : integer(opts.after, '--after', 0, 0, Number.MAX_SAFE_INTEGER);
      const store = open();
      try {
        let cursor = after ?? store.getCursor(to);
        const poll = () => {
          let messages: Message[];
          do {
            messages = store.list(to, cursor, 1000);
            for (const message of messages) {
              emit(message, opts.json, () => out.log(formatMessage(message)));
              cursor = message.id;
            }
          } while (messages.length === 1000 && !deps.signal?.aborted);
        };
        if (!opts.sse || opts.once) {
          do {
            poll();
            if (opts.once || deps.signal?.aborted) break;
            await sleep(interval);
          } while (!deps.signal?.aborted);
        } else {
          const url = new URL('/stream', opts.sse);
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--sse requires an HTTP URL');
          if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
            throw new Error('--sse requires HTTPS outside localhost');
          url.searchParams.set('to', to);
          const token = (deps.authToken ?? (() => ensureAuthToken().token))();
          let outage = false;
          while (!deps.signal?.aborted) {
            poll();
            url.searchParams.set('since', String(cursor));
            const controller = new AbortController();
            const onAbort = () => controller.abort();
            deps.signal?.addEventListener('abort', onAbort, { once: true });
            try {
              let connectTimer: ReturnType<typeof setTimeout> | undefined;
              const response = await Promise.race([
                (deps.fetch ?? fetch)(url, { headers: {
                  Authorization: `Bearer ${token}`, 'Last-Event-ID': String(cursor),
                }, signal: controller.signal }),
                new Promise<never>((_, reject) => { connectTimer = setTimeout(() => {
                  controller.abort();
                  reject(new Error('SSE connect timeout'));
                }, Math.max(1000, Math.min(5000, interval * 2))); }),
              ]).finally(() => clearTimeout(connectTimer));
              if (response.status === 401) throw new Error('SSE unauthorized (401)');
              if (!response.ok || !response.body) throw new Error(`SSE unavailable (${response.status})`);
              outage = false;
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let pending = '';
              while (!deps.signal?.aborted) {
                let idleTimer: ReturnType<typeof setTimeout> | undefined;
                const chunk = await Promise.race([
                  reader.read(),
                  new Promise<never>((_, reject) => { idleTimer = setTimeout(() => {
                    controller.abort();
                    reject(new Error('SSE idle timeout'));
                  }, Math.max(1000, Math.min(5000, interval * 2))); }),
                ]).finally(() => clearTimeout(idleTimer));
                if (chunk.done) break;
                pending += decoder.decode(chunk.value, { stream: true });
                pending = pending.replace(/\r\n/g, '\n');
                if (pending.length > 1_000_000) throw new Error('SSE event exceeds limit');
                let boundary: number;
                while ((boundary = pending.indexOf('\n\n')) >= 0) {
                  const event = pending.slice(0, boundary);
                  pending = pending.slice(boundary + 2);
                  if (event.split('\n').some((line) => line.startsWith('id: '))) poll();
                }
              }
            } catch (error) {
              if (error instanceof Error && error.message === 'SSE unauthorized (401)') throw error;
              if (!outage && !deps.signal?.aborted) out.error(`msg: SSE disconnected; polling ledger (${error instanceof Error ? error.message : String(error)})`);
              outage = true;
            } finally { deps.signal?.removeEventListener('abort', onAbort); controller.abort(); }
            if (deps.signal?.aborted) break;
            poll();
            await sleep(interval);
          }
        }
      } finally { store.close(); }
    })());

  msg.command('ask <recipient> <question>').description('Post a question and wait for its first reply')
    .option('--from <seat>', 'asking seat (required)').option('--wait <seconds>', 'seconds to wait for a reply (default 60)', '60')
    .option('--json')
    .action((recipient: string, question: string, opts: CommonOptions & { from?: string; wait?: string }) => run(async () => {
      const from = seat(opts.from, '--from');
      const to = canonicalSeatId(recipient);
      const waitSeconds = integer(opts.wait, '--wait', 60, 0, 86400);
      const interrupt = deps.signal === undefined ? new AbortController() : undefined;
      const signal = deps.signal ?? interrupt!.signal;
      const onInterrupt = () => interrupt?.abort();
      if (interrupt) {
        process.once('SIGINT', onInterrupt);
        process.once('SIGTERM', onInterrupt);
      }
      let store: MsgStore | undefined;
      try {
        const asked = withStore(ledger => ledger.post({ from, to, body: question }));
        // msg ask uses the same saved-message handler before waiting for its linked reply.
        await handleTaMessage(asked);
        const deadline = Date.now() + waitSeconds * 1000;
        let reply: Message | undefined;
        store = open();
        do {
          reply = store.listReplies(asked.id, 1)[0];
          if (reply !== undefined || signal.aborted || Date.now() >= deadline) break;
          await sleep(1000);
        } while (true);
        if (reply === undefined && signal.aborted) throw new Error(`ask interrupted after posting #${asked.id}`);
        if (reply === undefined) throw new Error(`no reply to #${asked.id} within ${waitSeconds}s`);
        emit(reply, opts.json, () => out.log(formatMessage(reply)));
      } finally {
        store?.close();
        if (interrupt) {
          process.removeListener('SIGINT', onInterrupt);
          process.removeListener('SIGTERM', onInterrupt);
        }
      }
    })());

  msg.command('thread <id>').description('Show one question and its replies in time order')
    .option('--json')
    .action((id: string, opts: CommonOptions) => run(() => {
      const target = integer(id, 'message ID', 0, 1, Number.MAX_SAFE_INTEGER);
      const thread = withStore(store => {
        const question = store.getMessage(target);
        if (question === null) throw new Error(`message not found: #${target}`);
        // Keep paging until a short page so a thread longer than one store page is never truncated.
        const replies: Message[] = [];
        let after = 0;
        let page: Message[];
        do {
          page = store.listReplies(target, 100, after);
          replies.push(...page);
          after = page.at(-1)?.id ?? after;
        } while (page.length === 100);
        return { question, replies };
      });
      emit(thread, opts.json, () => {
        out.log(formatMessage(thread.question));
        for (const reply of thread.replies) out.log(formatMessage(reply));
      });
    })());

  msg.command('serve').description('Run the independent, read-only post office SSE service')
    .option('--sse', 'serve GET /stream')
    .option('--port <port>', 'port (or ELANOUS_MSG_SSE_PORT)')
    .option('--host <host>', 'bind address', '127.0.0.1')
    .action((opts: { sse?: boolean; port?: string; host?: string }) => run(() => {
      if (!opts.sse) throw new Error('serve requires --sse');
      const rawPort = opts.port ?? process.env.ELANOUS_MSG_SSE_PORT;
      if (rawPort === undefined) throw new Error('--port or ELANOUS_MSG_SSE_PORT is required');
      const port = integer(rawPort, '--port', 0, 0, 65535);
      const store = openRead();
      try {
        const service = startMsgSseServer({ store, token: (deps.authToken ?? (() => ensureAuthToken().token))(),
          port, hostname: opts.host });
        out.log(`msg SSE listening on ${opts.host}:${service.port}`);
        const stop = () => { service.stop(); store.close(); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      } catch (error) { store.close(); throw error; }
    })());

  // Commander reports option/argument errors before action handlers run. Scope their exit code
  // to msg so unrelated commands keep their own error and help behavior.
  for (const command of [msg, ...msg.commands]) {
    const reportError = command.error.bind(command);
    command.error = (message, options) => reportError(message, { ...options, exitCode: 2 });
  }
}
