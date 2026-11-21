#!/usr/bin/env bun
// CEO channel daemon — the els face of CEO-CHANNEL-FIRST-CLASS (OP-CHANNEL-INGRESS-1121 rows ①③④).
// ─────────────────────────────────────────────────────────────────────────────────────────────
// One long-running process wiring the three product modules (src/els/ceo-channel*.ts):
//
//   door      createCeoChannel            ① disk queue + from=CEO mail-ledger post · ③ 👀/✅ SLA timers
//   telegram  createCeoTelegramAdapter    ① getUpdates long-poll → door · ④ sendMessage egress into the
//             + runCeoTelegramLoop           SAME chat threaded on the CEO message, retried via the outbox
//   mail      openCeoMailDb + scanCeoMail ③ the OP seat's ack/reply in the ledger drives 👀 / ✅
//
// The retiring personal script (seat-state/OP/tools/tg-op-bot.ts) used the same secret id
// (TELEGRAM_OP_BOT_TOKEN); its chat binding moves from .tg-op/chat to CEO_TG_CHAT_IDS at deploy.
//
// Config (env):              TELEGRAM_OP_BOT_TOKEN   bot token (env first, else the secret store)
//                            CEO_TG_CHAT_IDS          allowed private chat ids, comma-separated — the
//                                                     allowlist; empty ⇒ every message is rejected-not-
//                                                     allowed (fail-secure, no first-chat auto-bind)
//                            CEO_TG_SENDERS           optional sender ids (empty ⇒ any sender of a bound
//                                                     chat is from=CEO)
//                            CEO_STATE_DIR            queue db/audit/cursors (default ~/.elanous/ceo-channel)
//                            CEO_MAIL_DB              the mail ledger to watch (default ~/.elanous/msg/messages.db)
//                            CEO_INJECT_MODULE        optional row ② bridge (HAND-ELN-ELS-API landing:
//                                                    exports ceoInject(inbound); absent/import-failed ⇒ rows
//                                                    stay queued and redeliver() picks them up when it lands)
//                            CEO_TG_POLL_SEC          getUpdates long-poll length (default 25, clamped 1..50)
//                            CEO_MAIL_SCAN_SEC       mail scan period in s (default 15)
//                            CEO_OUTBOX_RETRY_SEC    failed-reply retry period in s (default 60)
//
// Run:                        bun scripts/ceo-channel-daemon.ts           the daemon
//                            bun scripts/ceo-channel-daemon.ts --once    one poll + scan + outbox retry → JSON
//
// Stop:                      touch <stateDir>/STOP   (or SIGINT/SIGTERM — the loop and the timers stand down)
//
// Fail-soft: a refused getUpdates, a missing ledger or a failed send is one logged line inside the modules;
// the daemon only exits on STOP, a signal, or missing config. The token is never printed or logged.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log.js';
import { createCeoChannel, type CeoChannel, type CeoInject } from '../src/els/ceo-channel.js';
import { createCeoTelegramAdapter, runCeoTelegramLoop, type CeoTelegramAdapter } from '../src/els/ceo-channel-telegram.js';
import { openCeoMailDb, scanCeoMail, type CeoMailDb } from '../src/els/ceo-channel-mail-watch.js';
import { getSecret } from '../src/nexus/config/secrets/index.js';

/** The secret id the retiring tg-op-bot.ts already uses — no re-enrollment at deploy. */
export const CEO_TOKEN_SECRET_ID = 'TELEGRAM_OP_BOT_TOKEN';

export interface CeoDaemonEnv {
  readonly TELEGRAM_OP_BOT_TOKEN?: string;
  readonly CEO_TG_CHAT_IDS?: string;
  readonly CEO_TG_SENDERS?: string;
  readonly CEO_STATE_DIR?: string;
  readonly CEO_MAIL_DB?: string;
  readonly CEO_INJECT_MODULE?: string;
  readonly CEO_TG_POLL_SEC?: string;
  readonly CEO_MAIL_SCAN_SEC?: string;
  readonly CEO_OUTBOX_RETRY_SEC?: string;
}

export type CeoSecretLookup = (id: string) => string | undefined;

/** The file backend answers sync; a cloud backend throws — both mean "no token" for the daemon. */
const defaultSecretLookup: CeoSecretLookup = (id) => { try { return getSecret(id); } catch { return undefined; } };

export interface CeoDaemonConfig {
  readonly token: string;
  readonly chatIds: readonly string[];
  readonly senders: readonly string[] | null;
  readonly stateDir: string;
  readonly mailDb: string;
  readonly injectModule: string | null;
  readonly pollTimeoutSec: number;
  readonly mailScanSec: number;
  readonly outboxRetrySec: number;
  readonly once: boolean;
}

/** env beats the secret store; a blank token is no token (main exits 1 with a JSON why). */
export function resolveCeoToken(env: Pick<CeoDaemonEnv, 'TELEGRAM_OP_BOT_TOKEN'>, secretLookup: CeoSecretLookup = defaultSecretLookup): string | null {
  const fromEnv = env.TELEGRAM_OP_BOT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return secretLookup(CEO_TOKEN_SECRET_ID)?.trim() || null;
}

const list = (raw: string | undefined): readonly string[] =>
  Array.from(new Set((raw ?? '').split(',').map((value) => value.trim()).filter((value) => value.length > 0)));

const period = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return raw?.trim() && Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
};

/** The daemon config from env — exported for the boundary test. null ⇒ no token ⇒ main exits 1. */
export function ceoDaemonConfig(env: CeoDaemonEnv, once: boolean, secretLookup: CeoSecretLookup = defaultSecretLookup): CeoDaemonConfig | null {
  const token = resolveCeoToken(env, secretLookup);
  if (!token) return null;
  const senders = list(env.CEO_TG_SENDERS);
  const poll = period(env.CEO_TG_POLL_SEC, 25);
  return {
    token,
    chatIds: list(env.CEO_TG_CHAT_IDS),
    senders: senders.length > 0 ? senders : null,
    stateDir: env.CEO_STATE_DIR?.trim() || join(homedir(), '.elanous', 'ceo-channel'),
    mailDb: env.CEO_MAIL_DB?.trim() || join(homedir(), '.elanous', 'msg', 'messages.db'),
    injectModule: env.CEO_INJECT_MODULE?.trim() || null,
    pollTimeoutSec: Math.min(Math.max(poll, 1), 50),
    mailScanSec: period(env.CEO_MAIL_SCAN_SEC, 15),
    outboxRetrySec: period(env.CEO_OUTBOX_RETRY_SEC, 60),
    once,
  };
}

const log = (event: string, data: Record<string, unknown> = {}): void => { debug.log('ceo-daemon', event, data); };

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const config = ceoDaemonConfig(process.env as CeoDaemonEnv, once);
  if (!config) {
    console.log(JSON.stringify({ ok: false, why: `no ${CEO_TOKEN_SECRET_ID} (env or secret store)` }));
    process.exit(1);
  }

  // Row ② — the bridge is another cell's landing (HAND-ELN-ELS-API); a missing or failed import is one
  // line and rows simply stay queued until redeliver() picks them up once the bridge lands.
  let inject: CeoInject | null = null;
  if (config.injectModule) {
    try {
      const bridge = await import(config.injectModule) as { ceoInject?: CeoInject };
      inject = bridge.ceoInject ?? null;
    } catch (error) {
      log('inject-module-refused', { module: config.injectModule, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const channel: CeoChannel = createCeoChannel({
    stateDir: config.stateDir,
    allow: () => config.chatIds,
    // `?? []` — property narrowing does not survive into the closure, so the non-null read is explicit.
    ...(config.senders === null ? {} : { senderAllow: () => config.senders ?? [] }),
    ...(inject === null ? {} : { inject }),
  });
  const adapter: CeoTelegramAdapter = createCeoTelegramAdapter({
    stateDir: config.stateDir, token: config.token, channel, pollTimeoutSec: config.pollTimeoutSec,
  });

  // Boot — both fail-soft: a locked db or a dead bridge is one line, the door still opens.
  try {
    const delivered = await channel.redeliver();
    log('boot-redeliver', { delivered });
  } catch (error) { log('boot-redeliver-threw', { error: error instanceof Error ? error.message : String(error) }); }
  try {
    const sent = await channel.retryOutbox();
    log('boot-outbox', { sent });
  } catch (error) { log('boot-outbox-threw', { error: error instanceof Error ? error.message : String(error) }); }

  // Row ③ mail side — the OP seat's ack/reply in the ledger drives 👀/✅; the cursor rides between scans.
  const cursorFile = join(config.stateDir, 'mail-cursor');
  const readCursor = (): number => { try { return Number(readFileSync(cursorFile, 'utf8')) || 0; } catch { return 0; } };
  const mailScan = async (): Promise<void> => {
    try {
      const mail: CeoMailDb | null = openCeoMailDb(config.mailDb);
      if (!mail) { log('mail-db-missing', { mailDb: config.mailDb }); return; }
      const cursor = readCursor();
      const out = await scanCeoMail({ channel, mail, seat: 'OP', cursor });
      if (out.cursor > cursor) writeFileSync(cursorFile, String(out.cursor), { mode: 0o600 });
    } catch (error) { log('mail-scan-threw', { error: error instanceof Error ? error.message : String(error) }); }
  };
  await mailScan();

  if (config.once) {
    const handled = await adapter.pollOnce();
    console.log(JSON.stringify({ ok: true, mode: 'once', handled, counts: channel.counts() }));
    channel.stop();
    process.exit(0);
  }

  console.log(JSON.stringify({
    ok: true, mode: 'daemon', stateDir: config.stateDir, mailDb: config.mailDb,
    chats: config.chatIds.length, senders: config.senders?.length ?? null,
    pollSec: config.pollTimeoutSec, mailScanSec: config.mailScanSec, outboxRetrySec: config.outboxRetrySec,
  }));

  let shutDown = false;
  const shutdown = (): void => {
    if (shutDown) return;
    shutDown = true;
    clearInterval(mailTimer);
    clearInterval(outboxTimer);
    channel.stop();
    process.exit(0);
  };
  const stopFile = join(config.stateDir, 'STOP');
  const tick = (fire: () => Promise<void>): void => {
    void (async () => {
      if (existsSync(stopFile)) shutdown();
      await fire().catch(() => undefined); // one line is already logged inside
    })();
  };
  const mailTimer = setInterval(() => { void tick(mailScan); }, config.mailScanSec * 1000);
  (mailTimer as { unref?: () => void }).unref?.();
  const outboxTimer = setInterval(() => { void tick(async () => { await channel.retryOutbox(); }); }, config.outboxRetrySec * 1000);
  (outboxTimer as { unref?: () => void }).unref?.();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log('daemon-start', { stateDir: config.stateDir, chats: config.chatIds.length });

  // The telegram long-poll IS the pace — this only returns on STOP (a signal has already exited).
  await runCeoTelegramLoop(adapter, { stateDir: config.stateDir });
  shutdown();
}

if (import.meta.main) {
  void main().catch((error) => {
    console.log(JSON.stringify({ ok: false, why: 'daemon-crash', error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}