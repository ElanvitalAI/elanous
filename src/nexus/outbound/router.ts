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

/** The adapter's capability declaration is explicit: a feature is unavailable unless
 * the connector implements it. Send-only webhooks must not claim inbound support. */
export interface ChannelCapabilities {
  send: boolean;
  receive: boolean;
  thread: boolean;
  topic: boolean;
  persona: boolean;
  channelLifecycle: boolean;
  permissions: boolean;
  commands: boolean;
  attachments: boolean;
  buttons: boolean;
  choices: boolean;
  deliveryConfirmation: boolean;
  rateLimit: boolean;
}

export interface ChannelEnvelope {
  text: string;
  kind: string;
  channel?: string;
  senderId?: string;
  messageId?: string | number;
  threadId?: string;
  topicId?: string;
  persona?: { name: string; avatarUrl?: string };
  attachments?: readonly { url: string; name?: string }[];
  buttons?: readonly { label: string; value: string }[];
  choices?: readonly { label: string; value: string }[];
}

/** Plugin contract; optional operations may only be advertised when implemented.
 * `send` returns the same ChannelResult shape used by the existing delivery ledger. */
export interface ChannelAdapter {
  readonly type: string;
  readonly capabilities: ChannelCapabilities;
  send(config: OutboundChannelConfig, message: OutboundMsg, cfg: UserConfig, deps: RouterDeps): Promise<ChannelResult>;
  receive?: (payload: unknown) => ChannelEnvelope | null | Promise<ChannelEnvelope | null>;
  createChannel?: (name: string) => Promise<string>;
  archiveChannel?: (id: string) => Promise<void>;
  checkPermission?: (action: string) => Promise<boolean>;
  registerCommands?: (commands: readonly string[]) => Promise<void>;
  confirmDelivery?: (messageId: string) => Promise<boolean>;
  retryAfterMs?: (result: ChannelResult) => number | undefined;
  /** Validate a plugin's channel entry before it becomes eligible for routing.
   *  Unknown or invalid entries stay disabled rather than falling back to a different channel. */
  parseConfig?: (raw: Record<string, unknown>) => OutboundChannelConfig | undefined;
}

/** Existing bot receive paths can normalize an accepted event through the same
 * adapter contract before dispatching to their unchanged workflow/chat handlers. */
export function receiveChannelEvent(type: string, payload: unknown): ChannelEnvelope | null | Promise<ChannelEnvelope | null> {
  const adapter = outboundAdapters.get(type) ?? installedAdapters.get(type);
  if (!adapter?.capabilities.receive || !adapter.receive) return null;
  return adapter.receive(payload);
}

export interface OutboundChannelConfig {
  type: OutboundChannelType | (string & {});
  /** discord: full webhook URL (required). pushcut: webhook URL — when
   *  omitted the adapter falls back to the API-key client
   *  (~/.elanous/pushcut.json) with `notification`. */
  webhookUrl?: string;
  /** pushcut API-key path: notification name — must be allowlisted in
   *  ~/.elanous/pushcut.json `allowedNotificationNames`. */
  notification?: string;
}

/** Connector providers register while the host is running; unregister on plugin
 * deactivation. Built-ins cannot be replaced by a plugin or removed. */
const installedAdapters = new Map<string, ChannelAdapter>();
export function registerOutboundAdapter(adapter: ChannelAdapter): () => void {
  if (!/^[a-z][a-z0-9-]*$/.test(adapter.type) || outboundAdapters.has(adapter.type) || installedAdapters.has(adapter.type)
    || !adapter.capabilities.send || typeof adapter.send !== 'function' || typeof adapter.parseConfig !== 'function'
    || (adapter.capabilities.receive && typeof adapter.receive !== 'function')
    || (adapter.capabilities.channelLifecycle && (typeof adapter.createChannel !== 'function' || typeof adapter.archiveChannel !== 'function'))
    || (adapter.capabilities.permissions && typeof adapter.checkPermission !== 'function')
    || (adapter.capabilities.commands && typeof adapter.registerCommands !== 'function')
    || (adapter.capabilities.deliveryConfirmation && typeof adapter.confirmDelivery !== 'function')
    || (adapter.capabilities.rateLimit && typeof adapter.retryAfterMs !== 'function')) {
    throw new Error(`invalid or duplicate outbound connector: ${adapter.type}`);
  }
  installedAdapters.set(adapter.type, adapter);
  return () => { if (installedAdapters.get(adapter.type) === adapter) installedAdapters.delete(adapter.type); };
}

export interface OutboundFanoutConfig {
  channels: OutboundChannelConfig[];
  /** kind → channel types. A kind missing here falls back to
   *  `routes.default`, then to ALL configured channels. An explicitly
   *  empty route (`"heartbeat": []`) suppresses that kind. */
  routes?: Record<string, string[]>;
  /** 외출 중 kind → channel types. 미지정 kind는 awayRoutes.default, 이것도 없으면 기존 routes를 유지한다. */
  awayRoutes?: Record<string, string[]>;
  /** Optional primary/fallback per message kind or role; legacy routes remain fan-out. */
  primary?: Record<string, string>;
  fallback?: Record<string, string>;
  /** Optional role → eligible channel types; no role retains kind routes. */
  roleRoutes?: Record<string, string[]>;
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
  /** Test/host supplied connector registry; built-ins remain the default. */
  adapters?: ReadonlyMap<string, ChannelAdapter>;
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
    if (type !== 'telegram' && type !== 'discord' && type !== 'pushcut') {
      if (typeof type === 'string') {
        const connector = installedAdapters.get(type);
        try {
          const parsed = connector?.parseConfig?.(ch);
          if (parsed?.type === type) channels.push(parsed);
        } catch { /* invalid plugin config is not a routable channel */ }
      }
      continue;
    }
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
  const roleRoutes = parseRoutes(o.roleRoutes);
  const parseSelection = (value: unknown): Record<string, string> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      // Keep a selection even when its channel is not configured: an explicit main/backup must
      // never silently turn back into legacy fan-out (it is reported as not-routed instead).
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0));
  };
  const primary = parseSelection(o.primary);
  const fallback = parseSelection(o.fallback);
  return { channels, ...(routes ? { routes } : {}), ...(awayRoutes ? { awayRoutes } : {}),
    ...(roleRoutes ? { roleRoutes } : {}), ...(primary ? { primary } : {}), ...(fallback ? { fallback } : {}) };
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

async function deliverTelegram(_ch: OutboundChannelConfig, msg: OutboundMsg, cfg: UserConfig, deps: RouterDeps): Promise<ChannelResult> {
  const fmt = formatForChannel('telegram', msg);
  const send = deps.telegramSend ?? sendTelegramReport;
  const ok = await send(cfg, fmt.text, { markdown: fmt.markdown ?? msg.markdown, fetchImpl: deps.fetchImpl, kind: msg.kind });
  return ok ? { type: 'telegram', ok: true } : { type: 'telegram', ok: false, error: 'not-configured' };
}

async function deliverDiscord(ch: OutboundChannelConfig, msg: OutboundMsg, _cfg: UserConfig, deps: RouterDeps): Promise<ChannelResult> {
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

async function deliverPushcut(ch: OutboundChannelConfig, msg: OutboundMsg, _cfg: UserConfig, deps: RouterDeps): Promise<ChannelResult> {
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

/** Built-in channel connectors. Telegram and Discord receive adapters normalize
 * already-authorized trigger taps; the webhook and Pushcut senders do not poll. */
export const outboundAdapters: ReadonlyMap<string, ChannelAdapter> = new Map<string, ChannelAdapter>([
  ['telegram', { type: 'telegram', capabilities: {
    send: true, receive: true, thread: false, topic: false, persona: false,
    channelLifecycle: false, permissions: false, commands: false, attachments: false,
    buttons: false, choices: false, deliveryConfirmation: false, rateLimit: false,
  }, send: deliverTelegram, receive: (payload): ChannelEnvelope | null => {
    if (!payload || typeof payload !== 'object') return null;
    const tap = payload as Record<string, unknown>;
    if (typeof tap.body !== 'string' || typeof tap.kind !== 'string' || typeof tap.chat !== 'string') return null;
    return { text: tap.body, kind: tap.kind, channel: tap.chat,
      ...(typeof tap.user === 'string' ? { senderId: tap.user } : {}),
      ...(typeof tap.messageId === 'number' ? { messageId: tap.messageId } : {}) };
  } }],
  ['discord', { type: 'discord', capabilities: {
    send: true, receive: true, thread: false, topic: false, persona: false,
    channelLifecycle: false, permissions: false, commands: false, attachments: false,
    buttons: false, choices: false, deliveryConfirmation: false, rateLimit: false,
  }, send: deliverDiscord, receive: (payload): ChannelEnvelope | null => {
    if (!payload || typeof payload !== 'object') return null;
    const tap = payload as Record<string, unknown>;
    if (typeof tap.body !== 'string' || typeof tap.kind !== 'string' || typeof tap.channel !== 'string') return null;
    return { text: tap.body, kind: tap.kind, channel: tap.channel,
      ...(typeof tap.user === 'string' ? { senderId: tap.user } : {}),
      ...(typeof tap.messageId === 'string' ? { messageId: tap.messageId } : {}) };
  } }],
  ['pushcut', { type: 'pushcut', capabilities: {
    send: true, receive: false, thread: false, topic: false, persona: false,
    channelLifecycle: false, permissions: false, commands: false, attachments: false,
    buttons: false, choices: false, deliveryConfirmation: false, rateLimit: false,
  }, send: deliverPushcut }],
]);

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
  // Whether the route that decided `list` is explicitly empty — that means «suppress», which is
  // different from a route whose channels are simply not configured.
  const kindRoute = outbound ? (outbound.routes?.[msg.kind] ?? outbound.routes?.default) : undefined;
  let explicitlyEmpty = kindRoute !== undefined && kindRoute.length === 0;
  const role = msg.role;
  const roleRoute = role ? outbound?.roleRoutes?.[role] : undefined;
  if (roleRoute && outbound) {
    list = outbound.channels.filter(ch => roleRoute.includes(ch.type));
    explicitlyEmpty = roleRoute.length === 0;
  }
  if (outbound?.awayRoutes) {
    try {
      if (readPresence().away) {
        const awayRoute = outbound.awayRoutes[msg.kind] ?? outbound.awayRoutes.default;
        // kind 도 default 도 없으면 기존 경로로 · 명시적인 빈 배열은 기존 routes 와 같은 규칙(채널 0)을 따른다.
        if (awayRoute !== undefined) {
          // Away mode narrows the route; it never widens a role's allowed channels.
          list = outbound.channels.filter(ch => awayRoute.includes(ch.type) && (!roleRoute || roleRoute.includes(ch.type)));
          // A role's explicitly empty route stays suppressed while away.
          explicitlyEmpty = awayRoute.length === 0 || roleRoute?.length === 0;
          try { debug.log('outbound.send', 'away-route', { kind: msg.kind, channels: list.map(ch => ch.type) }); } catch { /* 관측 실패는 발송 결과에 영향 없음 */ }
        }
      }
    } catch { /* 상태 조회 실패 — 기존 경로 유지 */ }
  }
  const send = async (ch: OutboundChannelConfig): Promise<ChannelResult> => {
    try {
      const adapter = deps.adapters?.get(ch.type) ?? outboundAdapters.get(ch.type) ?? installedAdapters.get(ch.type);
      if (!adapter?.capabilities.send) return { type: ch.type, ok: false, error: 'unsupported-channel' };
      const result = await adapter.send(ch, outMsg, cfg, deps);
      // A connector may not impersonate another channel or echo credentials
      // through the response. Legacy built-in result fields stay unchanged.
      if (!outboundAdapters.has(ch.type)) return { type: ch.type, ok: result.ok,
        ...(result.ok ? {} : { error: 'delivery-failed' }) };
      return { ...result, type: ch.type };
    } catch (e) {
      // Connector exceptions may include secret-bearing URLs or configuration.
      // Keep the old built-in error reasons unless they expose the webhook;
      // a plugin's arbitrary configuration cannot safely be echoed at all.
      const reason = e instanceof Error ? e.message : String(e);
      const plugin = !outboundAdapters.has(ch.type);
      return { type: ch.type, ok: false,
        error: plugin || (ch.webhookUrl && reason.includes(ch.webhookUrl)) ? 'delivery-failed' : reason };
    }
  };
  const primaryType = (role ? outbound?.primary?.[role] : undefined) ?? outbound?.primary?.[msg.kind] ?? outbound?.primary?.default;
  const fallbackType = (role ? outbound?.fallback?.[role] : undefined) ?? outbound?.fallback?.[msg.kind] ?? outbound?.fallback?.default;
  // Legacy routes still fan out. An explicit primary switches only this kind/role to ordered
  // failover: main, then the configured backup — never the rest of the route. A selected channel
  // that the current route does not carry is recorded as not-routed and the backup is tried.
  // An explicitly empty route stays suppressed (no rows).
  // Only an explicitly empty route suppresses the selection entirely (no rows).
  const suppressed = list.length === 0 && explicitlyEmpty;
  let channels: ChannelResult[];
  if (suppressed) {
    channels = [];
  } else if (primaryType) {
    channels = [];
    for (const type of fallbackType && fallbackType !== primaryType ? [primaryType, fallbackType] : [primaryType]) {
      const ch = list.find(candidate => candidate.type === type);
      const result = ch ? await send(ch) : { type, ok: false, error: 'not-routed' };
      channels.push(result);
      if (result.ok) break;
    }
  } else {
    // A backup without a main has nothing to back up: the allowed route already fans out to every
    // channel it may reach, and a backup outside that route must not bypass role/away limits.
    channels = await Promise.all(list.map(send));
  }

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
