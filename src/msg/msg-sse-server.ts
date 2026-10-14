import { timingSafeEqual } from 'node:crypto';
import { canonicalSeatId, type Message, type MsgStore } from './msg-store.js';

type Subscriber = { to: string; lastId: number; heartbeatAt: number; replaying: boolean; controller: ReadableStreamDefaultController<Uint8Array> };
const encoder = new TextEncoder();

function cursor(raw: string | null): number {
  if (raw === null) return 0;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error('invalid message cursor');
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw new Error('invalid message cursor');
  return id;
}

function authorized(request: Request, token: string): boolean {
  const value = request.headers.get('authorization');
  if (!value?.startsWith('Bearer ')) return false;
  const received = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return expected.length > 0 && received.length === expected.length && timingSafeEqual(received, expected);
}

function addressed(message: Message, to: string): boolean {
  return message.to === to || (message.to === 'ALL' && message.from !== to);
}

/** The SQLite ledger remains authoritative; this independent process only accelerates delivery. */
export function startMsgSseServer(input: {
  store: MsgStore;
  token: string;
  port: number;
  hostname?: string;
  pollMs?: number;
}): { port: number; stats: () => { subscribers: number; maxQueuedEvents: number }; stop: () => void } {
  if (!input.token) throw new Error('message SSE token is required');
  if (!Number.isSafeInteger(input.port) || input.port < 0 || input.port > 65535) throw new Error('invalid SSE port');
  const hostname = input.hostname ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) throw new Error('message SSE must bind to loopback');
  const pollMs = input.pollMs ?? 250;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 500) throw new Error('SSE ledger poll must be 1–500ms');
  const subscribers = new Set<Subscriber>();
  let maxQueuedEvents = 0;
  let scanned = input.store.latestId();
  const send = (subscriber: Subscriber, message: Message) => {
    if (message.id <= subscriber.lastId || !addressed(message, subscriber.to)) return;
    if ((subscriber.controller.desiredSize ?? 0) < -256) throw new Error('slow SSE subscriber; reconnect for ledger replay');
    subscriber.controller.enqueue(encoder.encode(`id: ${message.id}\ndata: ${JSON.stringify(message)}\n\n`));
    maxQueuedEvents = Math.max(maxQueuedEvents, Math.max(0, 1 - (subscriber.controller.desiredSize ?? 0)));
    subscriber.lastId = message.id;
  };
  const replay = (subscriber: Subscriber) => {
    if (!subscriber.replaying) return;
    try {
      while ((subscriber.controller.desiredSize ?? 0) > 0) {
        const batch = input.store.listByRecipient(subscriber.to, subscriber.lastId, 1000);
        if (!batch.length) { subscriber.replaying = false; break; }
        for (const message of batch) {
          if ((subscriber.controller.desiredSize ?? 0) <= 0) break;
          send(subscriber, message);
        }
      }
    } catch (error) {
      subscribers.delete(subscriber);
      subscriber.controller.error(error);
    }
  };
  const tick = () => {
    try {
      let batch: Message[];
      let scans = 0;
      do {
        batch = input.store.listAfter(scanned);
        for (const message of batch) {
          scanned = message.id;
          for (const subscriber of subscribers) {
            if (subscriber.replaying) continue;
            try { send(subscriber, message); } catch (error) {
              subscribers.delete(subscriber);
              try { subscriber.controller.error(error); } catch { /* already disconnected */ }
            }
          }
        }
        scans++;
      } while (batch.length === 1000 && scans < 4);
      const now = Date.now();
      for (const subscriber of subscribers) {
        if (subscriber.replaying || (subscriber.controller.desiredSize ?? 0) <= 0) continue;
        if (now - subscriber.heartbeatAt < 1000) continue;
        try {
          subscriber.controller.enqueue(encoder.encode(': keepalive\n\n'));
          subscriber.heartbeatAt = now;
        } catch { subscribers.delete(subscriber); }
      }
    } catch (error) {
      // The next tick retries from the last scanned ID; the durable ledger is unchanged.
      console.error(`msg SSE scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const server = Bun.serve({
    port: input.port,
    hostname,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/stream' || request.method !== 'GET') return new Response('Not Found', { status: 404 });
      if (!authorized(request, input.token)) return new Response('Unauthorized', { status: 401 });
      let to: string;
      let after: number;
      try {
        to = canonicalSeatId(url.searchParams.get('to') ?? '');
        if (to === 'ALL') throw new Error('ALL is not a recipient');
        after = Math.max(cursor(url.searchParams.get('since')), cursor(request.headers.get('last-event-id')));
      } catch (error) { return new Response(error instanceof Error ? error.message : String(error), { status: 400 }); }
      let subscriber: Subscriber;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          subscriber = { to, lastId: after, heartbeatAt: Date.now(), replaying: true, controller };
          subscribers.add(subscriber);
          controller.enqueue(encoder.encode(': connected\n\n'));
        },
        pull() { replay(subscriber); },
        cancel() { subscribers.delete(subscriber); },
      });
      request.signal.addEventListener('abort', () => subscribers.delete(subscriber), { once: true });
      return new Response(stream, { headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      } });
    },
  });
  const timer = setInterval(tick, pollMs);
  timer.unref();
  return { port: server.port ?? input.port,
    stats: () => ({ subscribers: subscribers.size, maxQueuedEvents }),
    stop: () => {
    clearInterval(timer);
    for (const subscriber of subscribers) { try { subscriber.controller.close(); } catch { /* disconnected */ } }
    subscribers.clear();
    server.stop(true);
  } };
}
