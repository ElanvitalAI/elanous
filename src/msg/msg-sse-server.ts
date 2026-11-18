import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { clearPostOffice, livePostOffice, writeResidentPostOffice, type PostOfficeInfo } from './msg-post-office.js';
import { canonicalSeatId, openMsgStore, openMsgStoreReadOnly, type Message, type MsgStore } from './msg-store.js';
import { receiptMatches, type Receipt } from './msg-receipts.js';

type Subscriber = { to: string; lastId: number; heartbeatAt: number; replaying: boolean; controller: ReadableStreamDefaultController<Uint8Array> };
/** SEAT-INBOX B1-C §4c — `GET /receipts?from=<seat>|msg=<id>` · cursor = receipt id (separate from /stream's message id). */
type ReceiptSubscriber = { filter: { messageId?: number; from?: string }; lastId: number; heartbeatAt: number;
  /** #38216 REVIEW-1 ①: catching up from the ledger under backpressure (like /stream) — live ticks skip it until done. */
  replaying: boolean; controller: ReadableStreamDefaultController<Uint8Array> };
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

function addressed(message: Message, to: string, store: MsgStore): boolean {
  return message.to === to || (message.to === 'ALL' && message.from !== to) || store.isGroupDelivery(message, to);
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
  const receiptSubscribers = new Set<ReceiptSubscriber>();
  let maxQueuedEvents = 0;
  let scanned = input.store.latestId();
  let receiptsScanned = input.store.latestReceiptId();
  /** `event: receipt` frames — the body is never part of a receipt (§4b). */
  const sendReceipt = (subscriber: ReceiptSubscriber, receipt: Receipt) => {
    if (receipt.id <= subscriber.lastId || !receiptMatches(receipt, subscriber.filter)) return;
    if ((subscriber.controller.desiredSize ?? 0) < -256) throw new Error('slow SSE subscriber; reconnect for ledger replay');
    subscriber.controller.enqueue(encoder.encode(`event: receipt\nid: ${receipt.id}\ndata: ${JSON.stringify(receipt)}\n\n`));
    subscriber.lastId = receipt.id;
  };
  /**
   * Ledger replay paced by the stream's own backpressure (`pull` · desiredSize), not all at once in `start()`: a busy
   * seat with hundreds of receipts after its cursor no longer trips the slow-subscriber guard and reconnects forever.
   */
  const replayReceipts = (subscriber: ReceiptSubscriber) => {
    if (!subscriber.replaying) return;
    try {
      while ((subscriber.controller.desiredSize ?? 0) > 0) {
        const batch = input.store.listReceipts({ ...subscriber.filter, afterId: subscriber.lastId });
        if (!batch.length) { subscriber.replaying = false; break; }
        for (const receipt of batch) {
          if ((subscriber.controller.desiredSize ?? 0) <= 0) break;
          sendReceipt(subscriber, receipt);
        }
      }
    } catch (error) {
      receiptSubscribers.delete(subscriber);
      try { subscriber.controller.error(error); } catch { /* already disconnected */ }
    }
  };
  const tickReceipts = () => {
    // MSG-RECEIPTS-FOLLOWUP: nobody subscribed → just move the cursor (no listReceipts every tick).
    if (receiptSubscribers.size === 0) { receiptsScanned = input.store.latestReceiptId(); return; }
    let batch: Receipt[];
    let scans = 0;
    do {
      batch = input.store.listReceipts({ afterId: receiptsScanned });
      for (const receipt of batch) {
        receiptsScanned = receipt.id;
        for (const subscriber of receiptSubscribers) {
          if (subscriber.replaying) continue; // its replay reads this from the ledger
          try { sendReceipt(subscriber, receipt); } catch (error) {
            receiptSubscribers.delete(subscriber);
            try { subscriber.controller.error(error); } catch { /* already disconnected */ }
          }
        }
      }
      scans++;
    } while (batch.length === 1000 && scans < 4);
    const now = Date.now();
    for (const subscriber of receiptSubscribers) {
      if (subscriber.replaying || (subscriber.controller.desiredSize ?? 0) <= 0) continue;
      if (now - subscriber.heartbeatAt < 1000) continue;
      try { subscriber.controller.enqueue(encoder.encode(': keepalive\n\n')); subscriber.heartbeatAt = now; }
      catch { receiptSubscribers.delete(subscriber); }
    }
  };
  const send = (subscriber: Subscriber, message: Message) => {
    if (message.id <= subscriber.lastId || !addressed(message, subscriber.to, input.store)) return;
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
      tickReceipts();
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
      if (url.pathname === '/health' && request.method === 'GET')
        return new Response(null, { status: 204, headers: { 'X-Elanous-Service': 'msg-sse' } });
      if (url.pathname === '/receipts' && request.method === 'GET') {
        if (!authorized(request, input.token)) return new Response('Unauthorized', { status: 401 });
        let filter: ReceiptSubscriber['filter'];
        let after: number;
        try {
          const from = url.searchParams.get('from');
          const msg = url.searchParams.get('msg');
          filter = {
            ...(from === null ? {} : { from: canonicalSeatId(from) }),
            // msg=0 / non-integer is a bad request, not an empty filter (#38194 REVIEW-1 ⑥).
            ...(msg === null ? {} : { messageId: /^[1-9]\d{0,15}$/.test(msg) ? Number(msg) : (() => { throw new Error('msg must be a positive message id'); })() }),
          };
          if (filter.from === undefined && filter.messageId === undefined) throw new Error('receipts need from=<seat> or msg=<id>');
          after = Math.max(cursor(url.searchParams.get('since')), cursor(request.headers.get('last-event-id')));
        } catch (error) { return new Response(error instanceof Error ? error.message : String(error), { status: 400 }); }
        let receiptSubscriber: ReceiptSubscriber;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            receiptSubscriber = { filter, lastId: after, heartbeatAt: Date.now(), replaying: true, controller };
            receiptSubscribers.add(receiptSubscriber);
            controller.enqueue(encoder.encode(': connected\n\n'));
          },
          pull() { replayReceipts(receiptSubscriber); },
          cancel() { receiptSubscribers.delete(receiptSubscriber); },
        });
        request.signal.addEventListener('abort', () => receiptSubscribers.delete(receiptSubscriber), { once: true });
        return new Response(stream, { headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        } });
      }
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
    for (const subscriber of receiptSubscribers) { try { subscriber.controller.close(); } catch { /* disconnected */ } }
    receiptSubscribers.clear();
    server.stop(true);
  } };
}

/** Nexus-owned lifetime: initialize the durable ledger, publish discovery, and release both on shutdown. */
export async function startResidentMsgSseServer(input: {
  stateRoot: string;
  token: string;
  port?: number;
  pollMs?: number;
}): Promise<{ port: number; stop: () => void } | null> {
  const skip = (owner: PostOfficeInfo) => {
    debug.log('msg.sse', 'resident-skipped-live-owner', { owner,
      guidance: '독립 서버를 eln msg serve stop 으로 내리면 다음 Nexus 기동에 인계' }, { level: 'warn' });
    return null;
  };
  const existing = livePostOffice(input.stateRoot);
  if (existing) return skip(existing);
  const path = join(input.stateRoot, 'msg', 'messages.db');
  openMsgStore(path).close();
  const store = openMsgStoreReadOnly(path);
  let service: ReturnType<typeof startMsgSseServer> | undefined;
  try {
    service = startMsgSseServer({ store, token: input.token, port: input.port ?? 0,
      ...(input.pollMs === undefined ? {} : { pollMs: input.pollMs }) });
    const registered = await writeResidentPostOffice(input.stateRoot, { port: service.port });
    if (registered.port !== service.port) {
      service.stop();
      store.close();
      return skip(registered);
    }
  } catch (error) {
    service?.stop();
    store.close();
    throw error;
  }
  return { port: service.port, stop: () => {
    service.stop();
    clearPostOffice(input.stateRoot, process.pid, service.port);
    store.close();
  } };
}
