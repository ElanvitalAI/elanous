// NEXUS · GET /v1/platforms — platform connection summary
// (BACKLOG #2 · Archon-port follow-up · 2026-05-08)
//
// Returns a small array describing whether the user has wired
// credentials / config for each integration channel (Discord,
// Telegram, Pushcut, ACP, Tailscale share). The PWA renders a
// connected/not-configured Badge per row in Settings so users see
// at a glance what's already wired vs what's missing — no more
// digging through individual switch cards.
//
// This endpoint is read-only and never returns secret VALUES, just
// existence flags + the kind of credential (so we can show
// "via secret-ref" vs "via env" hints).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { jsonResponse } from './json-response.js';
import { readUserConfig, readSwitchValue } from '../config/user-config.js';
import { listSecretIds } from '../config/secrets/index.js';
import {
  TELEGRAM_TOKEN_SWITCH_ID,
  DISCORD_TOKEN_SWITCH_ID,
} from '../config/builtins/tab-channel.js';
import {
  PUSHCUT_ENABLED_SWITCH_ID,
  PUSHCUT_WEBHOOK_SECRET_SWITCH_ID,
} from '../config/builtins/tab-daemon.js';

export type PlatformStatus = 'connected' | 'not-configured';

export interface PlatformEntry {
  id: 'discord' | 'telegram' | 'pushcut' | 'acp' | 'tailscale';
  label: string;
  status: PlatformStatus;
  /** Short detail line — e.g. 'token via secret-ref' /
   *  '~/.elanous/acp-token present' / 'switch off'. */
  detail: string;
  /** Where to go in Settings / docs to wire it up when not-configured. */
  hint?: string;
}

/** Sync-list secret ids, swallowing any "backend doesn't support sync"
 *  errors so cloud-backend installs degrade gracefully (those users
 *  see "not-configured" instead of an error). */
function safeSecretIds(): Set<string> {
  try {
    return new Set(listSecretIds());
  } catch {
    return new Set();
  }
}

/** Return the platform list. Pure function for testability — the
 *  HTTP wrapper just adds auth + jsonResponse. */
export function buildPlatformList(opts: {
  acpTokenPath?: string;
} = {}): PlatformEntry[] {
  const cfg = readUserConfig();
  const secrets = safeSecretIds();

  const tokenRefConnected = (switchId: string): { connected: boolean; ref: string | null } => {
    const v = readSwitchValue(cfg, switchId);
    if (typeof v !== 'string' || v.trim().length === 0) return { connected: false, ref: null };
    const ref = v.trim();
    return { connected: secrets.has(ref), ref };
  };

  // Discord ───────────────────────────────────────────────────────
  const discord = tokenRefConnected(DISCORD_TOKEN_SWITCH_ID);
  const discordEntry: PlatformEntry = discord.connected
    ? {
        id: 'discord',
        label: 'Discord',
        status: 'connected',
        detail: 'token via secret-ref',
      }
    : {
        id: 'discord',
        label: 'Discord',
        status: 'not-configured',
        detail: discord.ref ? 'switch references missing secret' : 'no token configured',
        hint: 'Set tabs.discord:1.tokenRef + add the bot token in Secrets.',
      };

  // Telegram ──────────────────────────────────────────────────────
  const telegram = tokenRefConnected(TELEGRAM_TOKEN_SWITCH_ID);
  const telegramEntry: PlatformEntry = telegram.connected
    ? {
        id: 'telegram',
        label: 'Telegram',
        status: 'connected',
        detail: 'token via secret-ref',
      }
    : {
        id: 'telegram',
        label: 'Telegram',
        status: 'not-configured',
        detail: telegram.ref ? 'switch references missing secret' : 'no token configured',
        hint: 'Set tabs.telegram:1.tokenRef + add the BotFather token in Secrets.',
      };

  // Pushcut (incoming webhook on daemon) ──────────────────────────
  const pushcutEnabled = readSwitchValue(cfg, PUSHCUT_ENABLED_SWITCH_ID) === true;
  const pushcutSecret = tokenRefConnected(PUSHCUT_WEBHOOK_SECRET_SWITCH_ID);
  let pushcutEntry: PlatformEntry;
  if (!pushcutEnabled) {
    pushcutEntry = {
      id: 'pushcut',
      label: 'Pushcut',
      status: 'not-configured',
      detail: 'switch off',
      hint: 'Toggle tabs.daemon:1.pushcut.enabled to receive iPhone shortcuts.',
    };
  } else if (pushcutSecret.connected) {
    pushcutEntry = {
      id: 'pushcut',
      label: 'Pushcut',
      status: 'connected',
      detail: 'webhook secret stored',
    };
  } else {
    pushcutEntry = {
      id: 'pushcut',
      label: 'Pushcut',
      status: 'not-configured',
      detail: pushcutSecret.ref ? 'switch references missing secret' : 'no webhook secret',
      hint: 'Add the webhook secret to Secrets and reference it from tabs.daemon:1.pushcut.webhookSecretRef.',
    };
  }

  // ACP (loopback bearer token) ───────────────────────────────────
  // 로컬 데몬 토큰 존재 여부 표시용(default) — getElanousConfigDir() 치환 prod 동치.
  const acpPath = opts.acpTokenPath ?? join(getElanousConfigDir(), 'acp-token');
  const acpEntry: PlatformEntry = existsSync(acpPath)
    ? {
        id: 'acp',
        label: 'ACP',
        status: 'connected',
        detail: '~/.elanous/acp-token present',
      }
    : {
        id: 'acp',
        label: 'ACP',
        status: 'not-configured',
        detail: 'token file missing',
        hint: 'Run an ACP-aware client once to mint ~/.elanous/acp-token.',
      };

  // Tailscale Serve ──────────────────────────────────────────────
  const tailshare = readSwitchValue(cfg, 'global.nexus.pwa.shareTailnet') === true;
  const tailscaleEntry: PlatformEntry = tailshare
    ? {
        id: 'tailscale',
        label: 'Tailscale Serve',
        status: 'connected',
        detail: 'PWA share enabled',
      }
    : {
        id: 'tailscale',
        label: 'Tailscale Serve',
        status: 'not-configured',
        detail: 'switch off',
        hint: 'Run `elanous pwa share enable` to expose the PWA over your tailnet.',
      };

  return [discordEntry, telegramEntry, pushcutEntry, acpEntry, tailscaleEntry];
}

/** GET /v1/platforms — read-only, parallels `/v1/config/secrets` /
 *  `/v1/config/switches` which are also open (the http-server handles
 *  same-origin enforcement at a higher layer). Never returns secret
 *  VALUES — only existence flags + human-readable hints. */
export function handlePlatforms(): Response {
  return jsonResponse({ platforms: buildPlatformList() }, 200);
}
