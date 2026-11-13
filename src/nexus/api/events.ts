// NEXUS · /v1/events SSE route (Phase N-1 PR δ · NEXUS N-1.5 PR b SSoT).
//
// **★ SSoT for `/v1/events` SSE** post NEXUS N-1.5 cutover (2026-05-06):
// the legacy control-server SSE path (`src/control/server.ts:openSseResponse`)
// is freeze-deprecated (decision #13/#18) and PWA consumers point at
// the NEXUS port via `elanous.nexus.baseUrl` (PR a · #1743).
//
// Server-Sent Events stream filtered by topic prefix. Subscribers pass
// `?topics=p1,p2,p3` and receive `event: <kind>\ndata: <json>\n\n`
// frames for any event whose `kind` starts with one of the prefixes.
// Empty / missing topics = receive everything.
//
// Heartbeat: comment line `: ping\n\n` every SSE_HEARTBEAT_MS so
// intermediaries (proxies, dev servers, Tailscale Serve) keep the
// connection alive — see `sse-heartbeat.ts` for the 5s rationale.

import type { NexusEvent } from '../state/state.js';
import type { NexusEventBus } from './event-bus.js';
import { SSE_HEARTBEAT_MS } from './sse-heartbeat.js';

/** Prefix subscriptions can include the private namespace without naming its exact topic. */
export function requestsPluginEvents(prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => 'plugin.event'.startsWith(prefix) || prefix.startsWith('plugin.event.'));
}

/** Opaque device selector, never an ownership credential or a filesystem path. */
export function isPluginEventDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isPluginEventKind(kind: string): boolean {
  return kind === 'plugin.event' || kind.startsWith('plugin.event.');
}

export type SseEventScope = string | { readonly operatorBriefings?: true; readonly operatorDeviceId?: string };

export function handleSseEvents(bus: NexusEventBus, url: URL, memberScope?: SseEventScope): Response {
  const memberId = typeof memberScope === 'string' ? memberScope : undefined;
  const operatorBriefings = typeof memberScope === 'object' && memberScope !== null && memberScope.operatorBriefings === true;
  // Only the HTTP route may grant this scope after a configured operator bearer check.
  const deviceId = typeof memberScope === 'object' && memberScope !== null && Object.hasOwn(memberScope, 'operatorDeviceId')
    && isPluginEventDeviceId(memberScope.operatorDeviceId)
    ? memberScope.operatorDeviceId : undefined;
  const raw = url.searchParams.get('topics') ?? '';
  const prefixes = raw.split(',').map((s) => s.trim()).filter(Boolean);

  // Capture teardown handles in the outer scope so the stream's
  // cancel callback can release them on client disconnect — Bun
  // invokes cancel(reason) without re-entering start(), so the
  // controller isn't a reliable place to stash references.
  let teardown: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (chunk: string): void => {
        try { controller.enqueue(encoder.encode(chunk)); } catch { /* closed */ }
      };

      // Initial comment so curl + browser EventSource see a stream
      // immediately — easier debugging than a silent connection.
      send(`: nexus events stream (topics: ${prefixes.length > 0 ? prefixes.join(',') : '*'})\n\n`);

      const pushEvent = (ev: NexusEvent): void => {
        // App rows contain tenant data. They are available only from the
        // bearer-gated app-scoped endpoint, never from this public stream.
        if (ev.kind.startsWith('app.row.')) return;
        // Private device commands must never ride the public/all-topic or member stream.
        // Operator authority covers this Nexus; the selector narrows it to one device.
        if (isPluginEventKind(ev.kind)) {
          const data = ev.detail?.data;
          if (!deviceId || !data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(data, 'deviceId')
            || (data as Record<string, unknown>).deviceId !== deviceId) return;
        }
        // Board and briefing payloads are member-owned. A client-side filter
        // is not an authorization boundary, so require the owner scope that
        // routeRequest resolved through /v1/members/owner.
        if (ev.kind.startsWith('board.card') && (!memberId || ev.memberId !== memberId)) return;
        if (ev.kind.startsWith('briefing.ready') && !(memberId && ev.memberId === memberId) && !operatorBriefings) return;
        if (ev.kind.startsWith('scrap.summary.') && (!memberId || ev.memberId !== memberId)) return;
        send(`event: ${ev.kind}\n`);
        send(`data: ${JSON.stringify(ev)}\n\n`);
      };

      const unsub = bus.subscribe(pushEvent, prefixes);
      const heartbeat = setInterval(() => send(`: ping\n\n`), SSE_HEARTBEAT_MS);
      teardown = () => {
        clearInterval(heartbeat);
        unsub();
      };
    },
    cancel() {
      teardown?.();
      teardown = undefined;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}
