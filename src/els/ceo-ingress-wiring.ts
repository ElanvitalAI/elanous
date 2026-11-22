// OP-CHANNEL-INGRESS-1121 ②③ wiring, els side — the product entrance the els daemon runs.
//   ① the telegram adapter hands one allowed private message to the channel door (queue + ledger),
//   ② the channel's inject seam crosses into createCeoIngress, which pushes the frame over the
//      per-destination ceo socket (socketCeoSink) into the OP tab's turn input,
//   ③ receipts are honest: 👀 when the tab's answer says the frame became turn input (exitCode 0)
//      — never at telegram/queue time; 🔴 30 s without 👀; RES takeover after 5 min (createCeoIngress).
//
// els provisions a socket + a per-tab secret per destination (OP, RES) — the seat tab env carries
// BOTH. Without the bot token the wiring is one observability line + inactive (never a crash).
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CEO_RECEIPT_GLYPH,
  ceoFrameAuth,
  ENV_CEO_INGRESS_AUTH,
  ENV_CEO_INGRESS_SOCKET,
  OP_SEAT,
  RES_SEAT,
  createCeoIngress,
  socketCeoSink,
  type CeoIngress,
  type CeoSessionSink,
  type CeoClock,
} from '../agent-events/ceo-ingress.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { createCeoChannel, type CeoInbound, type CeoLedgerPost } from './ceo-channel.js';
import { createCeoTelegramAdapter, runCeoTelegramLoop, type CeoTelegramAdapter } from './ceo-channel-telegram.js';
import { openCeoMailDb, scanCeoMail, type CeoMailDb } from './ceo-channel-mail-watch.js';
import { defaultMsgStorePath } from '../msg/msg-store.js';
import { verifyCeoReplyProof } from './ceo-reply-proof.js';
import { createCeoSideAlertWriter } from './ceo-side-alert.js';

/** ① the bot token — absent → one observability line + inactive. */
export const ENV_CEO_TELEGRAM_TOKEN = 'ELANOUS_CEO_TELEGRAM_TOKEN';
/** ① allowed CEO chat ids (comma list) — the allowlist that decides from=CEO. */
export const ENV_CEO_ALLOW_CHAT = 'ELANOUS_CEO_ALLOW_CHAT';
/** ① allowed sender ids (comma list, checked alongside the chat). */
export const ENV_CEO_ALLOW_SENDER = 'ELANOUS_CEO_ALLOW_SENDER';

/** ② the destinations els provisions a ceo ingress for (each its own socket + per-tab secret). */
export const CEO_INGRESS_DESTINATIONS: readonly string[] = [OP_SEAT, RES_SEAT];

const csv = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);

export interface CeoIngressDestination {
  readonly seat: string;
  readonly socketPath: string;
  /** ① the per-tab producer secret — the OP and RES tabs never share one (each verifies its own). */
  readonly authSecret: string;
}

/** ② Provision every destination's socket path + fresh per-tab secret under stateDir. */
export function provisionCeoIngressDestinations(stateDir: string): Map<string, CeoIngressDestination> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const destinations = new Map<string, CeoIngressDestination>();
  for (const seat of CEO_INGRESS_DESTINATIONS) {
    // ELS restarts adopt existing PTYs; the already running tab keeps its secret.
    // Persist it under the ELS-owned 0700 root so that replay can reach that tab.
    const authPath = join(stateDir, `${seat.toLowerCase()}-ceo-ingress.auth`);
    try { writeFileSync(authPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = lstatSync(authPath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('CEO ingress auth file is unsafe');
    const authSecret = readFileSync(authPath, 'utf8');
    if (!/^[0-9a-f]{64}$/.test(authSecret)) throw new Error('CEO ingress auth file is invalid');
    destinations.set(seat, {
      seat,
      socketPath: join(stateDir, `${seat.toLowerCase()}-ceo-ingress.sock`),
      authSecret,
    });
  }
  return destinations;
}

export interface CeoChannelWiringOpts {
  readonly env: NodeJS.ProcessEnv;
  readonly stateDir: string;
  /** ② the ws id stamped on every frame (the seat workspace). */
  readonly ws: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The mail-ledger seam (tests inject a no-op; the default posts through the real in-process store). */
  readonly post?: CeoLedgerPost;
  /** The same durable ledger the channel posts into. ELS supplies its state-root path explicitly. */
  readonly mailPath?: string;
  /** OP #127483 — the mail-db seam (tests inject a fixture; the default opens the real ledger). */
  readonly mailDb?: () => CeoMailDb | null;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /** Synthetic SLA clock for the complete channel and ingress path. */
  readonly clock?: CeoClock;
  /** The ELS owner state root that serves the side list. */
  readonly sideStateRoot?: string;
}

export interface CeoChannelWiring {
  readonly adapter: CeoTelegramAdapter;
  readonly ingress: CeoIngress;
  /** ③ the env els hands the seat's tab: the provisioned socket + THIS tab's secret. */
  envFor(seat: string): Record<string, string>;
  /** The product loop the daemon runs (poll → handle; back off on error). */
  run(): Promise<void>;
  /** OP #127483 — one mail scan on the persistent cursor (the 1 s timer calls exactly this). */
  scanMail(): Promise<void>;
  stop(): void;
}

export function startCeoChannelWiring(opts: CeoChannelWiringOpts): CeoChannelWiring | undefined {
  const log = opts.log ?? (() => { /* quiet by default: the audit lines carry the events */ });
  const token = opts.env[ENV_CEO_TELEGRAM_TOKEN]?.trim() ?? '';
  if (!token) {
    // ② no credential → one observability line + inactive: the CEO channel never half-boots.
    log('ceo-channel-inactive', { why: `${ENV_CEO_TELEGRAM_TOKEN} absent` });
    return undefined;
  }
  const destinations = provisionCeoIngressDestinations(opts.stateDir);
  const side = createCeoSideAlertWriter(opts.sideStateRoot ?? elanousStateRoot(), (error) => {
    log('ceo-side-alert-write-failed', { error: error instanceof Error ? error.message : String(error) });
  });
  const allowChat = (): string[] => csv(opts.env[ENV_CEO_ALLOW_CHAT]);
  const allowSender = (): string[] => csv(opts.env[ENV_CEO_ALLOW_SENDER]);
  let channel: ReturnType<typeof createCeoChannel>;
  const ingress = createCeoIngress({
    ws: opts.ws,
    allowedSenders: allowSender(),
    ...(opts.clock ? { clock: opts.clock } : {}),
    sessions: (seat: string): CeoSessionSink | undefined => {
      const destination = destinations.get(seat);
      if (!destination) return undefined;
      // ②③ the product sink: sign per frame with THIS tab's secret; 👀 exactly when the tab's
      // answer says the frame became turn input (exitCode 0) — never at send/queue time.
      return socketCeoSink({
        socketPath: destination.socketPath,
        ws: opts.ws,
        authSecret: destination.authSecret,
        onAnswer: (answer, frame) => {
          if (answer !== undefined && answer.exitCode === 0 && frame.event.kind === 'ceo-message') {
            try {
              const key = { source: 'telegram' as const, chatId: frame.event.threadId, messageId: frame.event.messageId };
              let turn: { sessionId: string; turnRunId: string } | undefined;
              try {
                const raw = JSON.parse(answer.message) as Record<string, unknown>;
                if (typeof raw.sessionId === 'string' && typeof raw.turnRunId === 'string')
                  turn = { sessionId: raw.sessionId, turnRunId: raw.turnRunId };
              } catch { /* older intake has no turn binding, so it cannot authorize an external reply */ }
              if (turn) channel.acceptIngress(key, ceoFrameAuth(frame, destination.authSecret), turn);
              ingress.ackSeen(frame.event.source, frame.event.threadId, frame.event.messageId);
              channel.markSeen(key);
            } catch (error) { log('ceo-intake-record-failed', { error: error instanceof Error ? error.message : String(error) }); }
          }
        },
      });
    },
    onStatus: (source, threadId, messageId, receipt) => {
      side.update(source, threadId, messageId, receipt);
      log('ceo-receipt', { source, threadId, messageId, receipt, glyph: CEO_RECEIPT_GLYPH[receipt] });
    },
  });
  let adapter: CeoTelegramAdapter; // wired below: channel → adapter (sendReply), adapter → channel (receive)
  channel = createCeoChannel({
    stateDir: opts.stateDir,
    allow: allowChat,
    senderAllow: allowSender,
    ...(opts.clock ? {
      now: () => opts.clock!.now(),
      arm: (delayMs: number, fire: () => void) => {
        const handle = opts.clock!.after(delayMs, fire);
        return { cancel: () => opts.clock!.cancel(handle) };
      },
    } : {}),
    ...(opts.post ? { post: opts.post } : {}),
    inject: (inbound: CeoInbound) => {
      const result = ingress.submit({
        source: inbound.source,
        sender: inbound.senderId,
        threadId: inbound.threadId ?? inbound.chatId,
        messageId: inbound.messageId,
        text: inbound.text,
      });
      if (!result.ok) {
        // A queued/injected row may be retried after a dead socket or daemon restart.
        // The same pending receipt is re-sent; a second CEO message is never created.
        if (result.reason !== 'duplicate message in this conversation'
          || !ingress.retryPending(inbound.source, inbound.threadId ?? inbound.chatId, inbound.messageId))
          throw new Error(`ceo ingress refused: ${result.reason}`);
      }
    },
    sendReply: (inbound, text) => adapter.sendReply(inbound, text),
    log,
  });
  adapter = createCeoTelegramAdapter({
    stateDir: opts.stateDir,
    token,
    channel,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    log,
  });
  let stopped = false;
  let started = false;
  let mailTimer: ReturnType<typeof setInterval> | null = null;
  let replayTimer: ReturnType<typeof setInterval> | null = null;
  let scanning = false;
  const replyCursor = new Map<number, number>();
  const pendingReplySince = new Map<number, number>();
  // OP #127688 — parent rows this daemon already answered: a settled row never reclassifies as
  // open on a re-scan (the open window is the unanswered-parent set, not a min-id cursor).
  const answeredParents = new Set<number>();
  // OP #127483 — the daemon carries the scan cursor between polls: 0 exactly once at boot
  // (downtime catch-up), then the open window (the oldest correlatable row without a trusted
  // answer) — never a cursor:0 full re-query every second again.
  let mailCursor = 0;
  const scanMail = async (): Promise<void> => {
    if (stopped || scanning) return;
    scanning = true;
    let mail: CeoMailDb | null = null;
    try {
      mail = opts.mailDb ? opts.mailDb() : openCeoMailDb(opts.mailPath ?? defaultMsgStorePath());
      if (mail) {
        const out = await scanCeoMail({ cursor: mailCursor, mail, replyCursor, pendingReplySince, answeredParents, channel: {
        ...channel,
        markAnswered: async (key, body, grant) => {
          const sent = await channel.markAnswered(key, body, grant);
          if (sent) ingress.markAnswered(key.source, key.chatId, key.messageId);
          return sent;
        },
        }, verifyReply: (parent, key, reply) => {
          const proof = verifyCeoReplyProof(reply.refsJson, { source: key.source, threadId: key.chatId,
            messageId: key.messageId }, parent.id, reply.body, destinations.get(OP_SEAT)!.authSecret);
          if (!proof) return null;
          return channel.hasAcceptedIngress(key, proof.ingressId, proof) ? proof : 'pending';
        }, log });
        // A late CEO reply to any still-open row must be seen next second: resume from the open
        // window, not from the walked tail. Settled/foreign rows stay behind the cursor.
        mailCursor = out.openSince > 0 ? out.openSince - 1 : out.cursor;
      }
      await channel.retryOutbox();
    } catch (error) { log('ceo-mail-watch-error', { error: error instanceof Error ? error.message : String(error) }); }
    finally { mail?.close?.(); scanning = false; }
  };
  const replay = async (): Promise<void> => {
    if (stopped) return;
    try { await channel.redeliver(); }
    catch (error) { log('ceo-redeliver-error', { error: error instanceof Error ? error.message : String(error) }); }
  };
  return {
    adapter,
    ingress,
    scanMail,
    envFor: (seat: string): Record<string, string> => {
      const destination = destinations.get(seat);
      if (!destination) return {};
      return {
        [ENV_CEO_INGRESS_SOCKET]: destination.socketPath,
        [ENV_CEO_INGRESS_AUTH]: destination.authSecret,
      };
    },
    run: async () => {
      if (started) return;
      started = true;
      await scanMail();
      await replay();
      mailTimer = setInterval(() => { void scanMail(); }, 1_000);
      replayTimer = setInterval(() => { void replay(); }, 15_000);
      mailTimer.unref?.(); replayTimer.unref?.();
      await runCeoTelegramLoop(adapter, {
        stateDir: opts.stateDir,
        stopped: () => stopped,
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        ...(opts.log ? { log: opts.log } : {}),
      });
    },
    stop: () => {
      stopped = true;
      if (mailTimer) clearInterval(mailTimer);
      if (replayTimer) clearInterval(replayTimer);
      ingress.dispose();
      channel.stop();
    },
  };
}
