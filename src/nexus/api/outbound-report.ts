// ── Unified outbound send — POST /v1/outbound (B outbound, 2026-07-05) ──
//
// The single fan-out point for elanous OUTBOUND messages (cron digests,
// trading alerts, autonomous-loop output), symmetric to the inbound
// trigger-bot (the single inbound point). External senders — the openclaw
// morning report and the Conatus `screener/send.py` alerts — POST here
// instead of hitting the Telegram API directly with their own bot tokens,
// so ALL outbound routes through elanous's delivery channels. Send-only;
// auth via bearer (acp-token).
//
// Body: { text: string, markdown?: boolean, kind?: string }
//   kind routes per-channel since R6 Phase 1 (2026-07-07): the body is
//   handed to routeOutbound (src/nexus/outbound/router.ts) which fans out
//   to telegram/discord/pushcut per the `outbound` user-config section.
//   No `outbound` config → telegram-only (pre-R6 behavior, cron fleet
//   unaffected).

import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { routeOutbound } from '../outbound/router.js';
import { getUserConfig } from '../../user-config.js';
import { openSurfaceEventsDb, recordEvent } from '../../domains/surface-events.js';
import { debug } from '../../debug/log.js';
import { resolveReportTarget } from '../../telegram-report.js';
import type { RouteResult, RouterDeps } from '../outbound/router.js';

/** 크로스서피스 기억(P0.5) — /v1/outbound = ALL outbound 단일 수렴점이므로 여기서
 *  원장 기록하면 sendOutbound 클라 + 직접 POST(morning-report·external) 전부 포착.
 *  fail-soft(기억 기록이 발송을 막지 않음). 데몬 미경유 직접폴백만 클라가 별도 기록. */
function recordOutboundEvent(text: string, kind: string): void {
  try {
    const db = openSurfaceEventsDb();
    try { recordEvent(db, { surface: 'outbound', direction: 'outbound', kind, text }); }
    finally { db.close(); }
  } catch { /* 발송 원장 기록 실패는 무시 */ }
}

function observeDaemonSend(cfg: ReturnType<typeof getUserConfig>, text: string, kind: string, result: RouteResult, source: string): void {
  if (result.suppressed) return; // 라우터가 suppressedBy 만 싣는 억제 관측을 남긴다.
  try {
    const target = result.channels.some(c => c.type === 'telegram') ? resolveReportTarget(cfg, kind) : null;
    const id = target?.botToken.split(':', 1)[0];
    const bot = id && /^\d+$/.test(id) ? `telegram:${id}` : target ? 'telegram:configured' : 'none';
    debug.log('outbound.send', result.delivered ? 'sent' : 'failed', {
      kind: /^[a-zA-Z0-9_-]{1,80}$/.test(kind) ? kind : 'unknown',
      source: /^[a-zA-Z0-9_./-]{1,160}$/.test(source) ? source : 'unknown',
      chars: text.length, bot, path: 'daemon',
      channels: result.channels.map(c => ({ type: c.type, ok: c.ok })),
    });
  } catch { /* observation must not change the send result */ }
}

interface OutboundBody {
  text?: string;
  markdown?: boolean;
  kind?: string;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** The daemon's own sendOutbound path (OB8) — what POST /v1/outbound does, without the HTTP self-call. */
export async function routeOutboundInProcess(text: string, kind: string, source = 'daemon-in-process', deferFailureObservation = false): Promise<boolean> {
  const cfg = getUserConfig();
  const result = await routeOutbound(cfg, { text, markdown: false, kind });
  if (result.delivered || !deferFailureObservation) observeDaemonSend(cfg, text, kind, result, source);
  if (result.delivered && !result.suppressed) recordOutboundEvent(text, kind);
  return result.delivered;
}

/** POST /v1/outbound — fan one message out to the routed channels. */
export async function handleOutboundReport(req: Request, metaApi: MetaApiOpts, routerDeps: RouterDeps = {}): Promise<Response> {
  if (!checkAuth(req, metaApi)) return json({ error: 'unauthorized' }, 401);

  let body: OutboundBody;
  try { body = (await req.json()) as OutboundBody; }
  catch { return json({ error: 'invalid-json' }, 400); }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return json({ error: 'missing-text' }, 400);

  const cfg = getUserConfig();
  const kind = typeof body.kind === 'string' ? body.kind : 'report';
  try {
    // Router is per-channel fail-soft; `delivered` = any channel ok.
    // Producers (outbound-alert.ts deliver()) gate their direct-telegram
    // fallback on this top-level boolean — keep it stable.
    const result = await routeOutbound(cfg, { text, markdown: body.markdown ?? true, kind }, routerDeps);
    const clientFallback = req.headers.get('X-Elanous-Client-Fallback') === 'direct';
    const source = req.headers.get('X-Elanous-Outbound-Source') ?? 'daemon-http';
    if (result.delivered || !clientFallback) observeDaemonSend(cfg, text, kind, result, source);
    if (result.delivered && !result.suppressed) recordOutboundEvent(text, kind); // 크로스서피스 기억 원장(P0.5)
    return json({
      delivered: result.delivered,
      // Legacy single-channel field (pre-R6 consumers) + full breakdown.
      channel: result.suppressed ? 'suppressed' : (result.channels.find(c => c.ok)?.type ?? 'none'),
      channels: result.channels,
      ...(result.suppressed ? { suppressed: true, suppressedBy: result.suppressedBy } : {}),
      ...(!result.suppressed && result.channels.length === 0 ? { reason: 'no-channel' } : {}),
      kind,
    }, result.delivered ? 200 : 503);
  } catch (e) {
    if (req.headers.get('X-Elanous-Client-Fallback') !== 'direct') {
      try {
        debug.log('outbound.send', 'failed', {
          kind: /^[a-zA-Z0-9_-]{1,80}$/.test(kind) ? kind : 'unknown',
          source: 'daemon-http', chars: text.length, bot: 'unknown', path: 'daemon',
        });
      } catch { /* observation must not change the response */ }
    }
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}
