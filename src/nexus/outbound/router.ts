// ── R6 Phase 1 — outbound channel fan-out router (2026-07-07) ──
//
// PLAN-outbound-fanout-mtproto-2026-07-06 §1 (B Phase 1). Replaces the
// telegram-hardcoded body of POST /v1/outbound with a per-kind channel
// router. Producers are UNCHANGED — everything still funnels through
// sendOutbound() → POST /v1/outbound; only the delivery side fans out.
//
// Config lives at `outbound` in ~/.elanous/config.json (user-config only
// principle — sparse). Read via the `raw` passthrough, same precedent as
// the root `dispatch` flag (src/nexus/index.ts) — the round-trip
// serializer preserves unknown raw keys, so no user-config.ts change:
//
//   "outbound": {
//     "channels": [
//       { "type": "telegram" },
//       { "type": "discord", "webhookUrl": "https://discord.com/api/webhooks/..." },
//       { "type": "pushcut", "webhookUrl": "https://api.pushcut.io/.../notifications/..." }
//     ],
//     "routes": { "alert": ["telegram", "pushcut"], "report": ["telegram", "discord"] },
//     "awayRoutes": { "alert": ["discord"] }
//   }
//
// Backward compat: when `outbound` is absent/malformed the resolved
// channel list is exactly [{type:'telegram'}] — the pre-R6 behavior, so
// the existing cron fleet is unaffected. Each adapter is fail-soft: one
// channel failing never blocks the others, and top-level `delivered` is
// true when ANY channel succeeded (outbound-alert.ts `deliver()` checks
// that boolean before falling back to direct Telegram).

import { createHash } from 'node:crypto';
import { readPresence } from '../../away/presence.js';
import { debug } from '../../debug/log.js';
import { sendTelegramReport } from '../../telegram-report.js';
import { getPushcutClient } from '../../pushcut/client.js';
import type { UserConfig } from '../../user-config.js';
import { formatForChannel, type OutboundChannelType, type OutboundMsg } from './format.js';
import { spillLongContent } from '../../storage/content-spill.js';
import {
  openDeliveryDb, deliveryDedupKey, successfulDeliveryId, recordDelivery, type ChannelDelivery,
} from './delivery-ledger.js';

// 채널 타입·메시지·분할기는 format.ts가 단일 출처 — 기존 소비처(test 등) 호환 재export.
export { chunkForDiscord } from './format.js';
export type { OutboundChannelType, OutboundMsg } from './format.js';

export interface OutboundChannelConfig {
  type: OutboundChannelType;
  /** discord: full webhook URL (required). pushcut: webhook URL — when
   *  omitted the adapter falls back to the API-key client
   *  (~/.elanous/pushcut.json) with `notification`. */
  webhookUrl?: string;
  /** pushcut API-key path: notification name — must be allowlisted in
   *  ~/.elanous/pushcut.json `allowedNotificationNames`. */
  notification?: string;
}

export interface OutboundFanoutConfig {
  channels: OutboundChannelConfig[];
  /** kind → channel types. A kind missing here falls back to
   *  `routes.default`, then to ALL configured channels. An explicitly
   *  empty route (`"heartbeat": []`) suppresses that kind. */
  routes?: Record<string, string[]>;
  /** 외출 중 kind → channel types. 미지정 kind는 awayRoutes.default, 이것도 없으면 기존 routes를 유지한다. */
  awayRoutes?: Record<string, string[]>;
}

export interface ChannelResult {
  type: string;
  ok: boolean;
  /** Failure reason — never contains webhook URLs (secret-safe). */
  error?: string;
}

export interface RouteResult {
  delivered: boolean;
  channels: ChannelResult[];
  /** 중복 발사 제어(dedup)로 재팬아웃이 억제됨 — 최근 동일 발송 존재. */
  suppressed?: boolean;
  /** 억제 근거가 된 앞선 성공 발송의 식별자. */
  suppressedBy?: string;
  /** 이 발송의 식별자(리드 동기화·회상 교차참조용). */
  messageId?: string;
}

/** DI seams for tests — production callers pass nothing. */
export interface RouterDeps {
  fetchImpl?: typeof fetch;
  telegramSend?: typeof sendTelegramReport;
  pushcutNotify?: (name: string, payload: { title: string; text: string }) => Promise<{ ok: boolean; reason?: string }>;
  /** 배송 원장 핸들 주입(테스트/공유). 미지정 시 실 DB 오픈. */
  deliveryDb?: import('bun:sqlite').Database;
  /** 중복 발사 제어 on/off(기본 on). */
  dedup?: boolean;
  now?: () => string;
  /** 롱콘텐츠 spill 주입(테스트/대체). 기본 = spillLongContent(S3 게이트·fail-soft).
   *  긴 본문을 S3 업로드+링크로 대체 → 전 메신저가 짧은 링크 버전을 받음. */
  spill?: (text: string) => { text: string; spilled: boolean; url?: string };
}

/** Parse the sparse `outbound` section. Malformed input → undefined
 *  (feature off → telegram-only), consistent with the strict parser's
 *  fail-soft posture (normalizeReportChannel precedent). */
export function normalizeOutbound(raw: unknown): OutboundFanoutConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.channels)) return undefined;
  const channels: OutboundChannelConfig[] = [];
  for (const entry of o.channels as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const ch = entry as Record<string, unknown>;
    const type = ch.type;
    if (type !== 'telegram' && type !== 'discord' && type !== 'pushcut') continue;
    const webhookUrl = typeof ch.webhookUrl === 'string' && ch.webhookUrl.trim()
      ? ch.webhookUrl.trim() : undefined;
    const notification = typeof ch.notification === 'string' && ch.notification.trim()
      ? ch.notification.trim() : undefined;
    // discord without a webhook URL can never deliver — drop it here so
    // resolveChannels only ever yields actionable channels.
    if (type === 'discord' && !webhookUrl) continue;
    // pushcut needs one of the two paths (webhook or API-key notification).
    if (type === 'pushcut' && !webhookUrl && !notification) continue;
    channels.push({ type, ...(webhookUrl ? { webhookUrl } : {}), ...(notification ? { notification } : {}) });
  }
  if (channels.length === 0) return undefined;
  const parseRoutes = (value: unknown): Record<string, string[]> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const routes: Record<string, string[]> = {};
    for (const [kind, v] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(v)) routes[kind] = v.filter((t): t is string => typeof t === 'string');
    }
    return routes;
  };
  const routes = parseRoutes(o.routes);
  const awayRoutes = parseRoutes(o.awayRoutes);
  return { channels, ...(routes ? { routes } : {}), ...(awayRoutes ? { awayRoutes } : {}) };
}

/** Resolve the channel list for one message kind. No/empty config →
 *  [{type:'telegram'}] (pre-R6 behavior). */
export function resolveChannels(
  outbound: OutboundFanoutConfig | undefined,
  kind: string,
): OutboundChannelConfig[] {
  if (!outbound || outbound.channels.length === 0) return [{ type: 'telegram' }];
  const route = outbound.routes?.[kind] ?? outbound.routes?.default;
  if (!route) return outbound.channels;
  // Explicit route (possibly empty = suppress) — keep channel order.
  return outbound.channels.filter(ch => route.includes(ch.type));
}

async function deliverTelegram(cfg: UserConfig, msg: OutboundMsg, deps: RouterDeps): Promise<ChannelResult> {
  const fmt = formatForChannel('telegram', msg);
  const send = deps.telegramSend ?? sendTelegramReport;
  const ok = await send(cfg, fmt.text, { markdown: fmt.markdown ?? msg.markdown, fetchImpl: deps.fetchImpl, kind: msg.kind });
  return ok ? { type: 'telegram', ok: true } : { type: 'telegram', ok: false, error: 'not-configured' };
}

async function deliverDiscord(ch: OutboundChannelConfig, msg: OutboundMsg, deps: RouterDeps): Promise<ChannelResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // webhookUrl guaranteed by normalizeOutbound; guard for direct callers.
  if (!ch.webhookUrl) return { type: 'discord', ok: false, error: 'missing-webhook-url' };
  const fmt = formatForChannel('discord', msg);
  for (const content of fmt.chunks ?? [fmt.text]) {
    const res = await fetchImpl(ch.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    // Status only — never echo the URL (it embeds the webhook token).
    if (!res.ok) return { type: 'discord', ok: false, error: `http-${res.status}` };
  }
  return { type: 'discord', ok: true };
}

async function deliverPushcut(ch: OutboundChannelConfig, msg: OutboundMsg, deps: RouterDeps): Promise<ChannelResult> {
  const fmt = formatForChannel('pushcut', msg);
  const title = fmt.title ?? `elanous ${msg.kind}`;
  if (ch.webhookUrl) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await fetchImpl(ch.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text: fmt.text }),
    });
    return res.ok
      ? { type: 'pushcut', ok: true }
      : { type: 'pushcut', ok: false, error: `http-${res.status}` };
  }
  // API-key path — reuses the already-provisioned ~/.elanous/pushcut.json
  // client (the name must be allowlisted there).
  const notify = deps.pushcutNotify
    ?? ((name: string, payload: { title: string; text: string }) => getPushcutClient().notify(name, payload));
  const r = await notify(ch.notification ?? 'elanous-outbound', { title, text: fmt.text });
  return r.ok ? { type: 'pushcut', ok: true } : { type: 'pushcut', ok: false, error: r.reason ?? 'pushcut-failed' };
}

/** Fan one message out to every routed channel. Per-channel fail-soft —
 *  a throwing adapter records `{ok:false}` and never blocks siblings.
 *  구조: 채널별 포맷(format.ts) + 중복 발사 제어·배송 원장(delivery-ledger.ts).
 *  다채널 지원(config `outbound.channels`/`routes`)이나 config 없으면 telegram-only. */
export async function routeOutbound(cfg: UserConfig, msg: OutboundMsg, deps: RouterDeps = {}): Promise<RouteResult> {
  const outbound = normalizeOutbound((cfg.raw as Record<string, unknown> | undefined)?.outbound);

  // 롱콘텐츠 spill(공용) — 단일 수렴점이라 여기서 대체하면 전 메신저가 짧은 링크 버전 수신.
  // S3 불가/실패면 원문 유지(채널별 분할 폴백). dedup/원장은 원문 기준(대체 무관 동일성).
  const spill = (deps.spill ?? spillLongContent)(msg.text);
  const outMsg: OutboundMsg = spill.spilled ? { ...msg, text: spill.text, markdown: false } : msg;

  const messageId = createHash('sha1').update(`${msg.kind}\n${msg.text}\n${(deps.now ?? (() => new Date().toISOString()))()}`).digest('hex').slice(0, 16);
  const dedupKey = deliveryDedupKey(msg.kind, msg.text);

  // 배송 원장(fail-soft) — 없어도 발송은 진행.
  const ownLedger = !deps.deliveryDb;
  let ledger: import('bun:sqlite').Database | undefined = deps.deliveryDb;
  if (!ledger) { try { ledger = openDeliveryDb(); } catch { ledger = undefined; } }

  // ① 중복 발사 제어 — 최근(120s) 동일 발송이면 재팬아웃 억제.
  if (ledger && deps.dedup !== false) {
    try {
      const suppressedBy = successfulDeliveryId(ledger, dedupKey);
      if (suppressedBy) {
        if (ownLedger) ledger.close();
        try { debug.log('outbound.send', 'suppressed', { kind: msg.kind, suppressedBy }); } catch { /* 관측 실패는 발송 결과에 영향 없음 */ }
        return { delivered: true, channels: [], suppressed: true, suppressedBy, messageId };
      }
    } catch { /* 원장 조회 실패 — 억제 없이 진행 */ }
  }

  // 상태 파일이 없거나 읽기에 실패하면 기존 kind 경로를 그대로 사용한다.
  let list = resolveChannels(outbound, msg.kind);
  if (outbound?.awayRoutes) {
    try {
      if (readPresence().away) {
        const awayRoute = outbound.awayRoutes[msg.kind] ?? outbound.awayRoutes.default;
        // kind 도 default 도 없으면 기존 경로로 · 명시적인 빈 배열은 기존 routes 와 같은 규칙(채널 0)을 따른다.
        if (awayRoute !== undefined) {
          list = outbound.channels.filter(ch => awayRoute.includes(ch.type));
          try { debug.log('outbound.send', 'away-route', { kind: msg.kind, channels: list.map(ch => ch.type) }); } catch { /* 관측 실패는 발송 결과에 영향 없음 */ }
        }
      }
    } catch { /* 상태 조회 실패 — 기존 경로 유지 */ }
  }
  const channels = await Promise.all(list.map(async (ch): Promise<ChannelResult> => {
    try {
      if (ch.type === 'telegram') return await deliverTelegram(cfg, outMsg, deps);
      if (ch.type === 'discord') return await deliverDiscord(ch, outMsg, deps);
      return await deliverPushcut(ch, outMsg, deps);
    } catch (e) {
      return { type: ch.type, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }));

  // 배송 기록(리드 동기화·중복 제어 토대) — fail-soft.
  if (ledger) {
    try {
      const chDel: ChannelDelivery[] = channels.map(c => ({ type: c.type, ok: c.ok }));
      recordDelivery(ledger, { messageId, kind: msg.kind, dedupKey, text: msg.text, channels: chDel, ...(deps.now ? { ts: deps.now() } : {}) });
    } catch { /* 기록 실패 — 발송엔 무영향 */ }
    finally { if (ownLedger) ledger.close(); }
  }
  return { delivered: channels.some(c => c.ok), channels, messageId };
}
