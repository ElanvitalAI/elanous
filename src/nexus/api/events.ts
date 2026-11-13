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

export function handleSseEvents(bus: NexusEventBus, url: URL, memberScope?: string | { readonly operatorBriefings: true }): Response {
  const memberId = typeof memberScope === 'string' ? memberScope : undefined;
  const operatorBriefings = typeof memberScope === 'object' && memberScope !== null && memberScope.operatorBriefings === true;
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
