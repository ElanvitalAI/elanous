// ── 우편 SSE 구독 클라이언트 — 받는 몸이 «듣는» 쪽 ──
//
// 서버(`msg-sse-server.ts` · `eln msg serve --sse`)는 원장을 빨리 밀어 줄 뿐이고 원장(SQLite)이 정본이다.
// 이 클라이언트는 한 주소를 구독해 글마다 `onMessage` 를 부른다.
//   · 커서(Last-Event-ID)는 주소별 state-dir 파일에 보존하고 «onMessage 가 성공한 뒤에만» 전진한다
//     — 실패하면 같은 글이 다시 온다(at-least-once · 중복은 소비자가 provenance 키로 거른다).
//   · SSE 가 끊기면 지수 백오프(상한)로 다시 붙고, 기다리는 동안은 원장을 직접 폴링해 빠짐을 막는다.
//   · 우체국 주소는 인자(`url`)로만 받는다(env·config·하드코딩 0) — 없으면 원장 폴링이 운영 기본이다.
//     서버가 없거나 토큰이 거절되어도 같은 길로 원장 폴링에 내려앉는다 — `fallback-poll` 로그.
//   · stop() 뒤에는 콜백 0.
// 관측: debug.log('msg.sse-client', connect|reconnect|replay|fallback-poll|deliver-failed|stop, …) — 원장을 직접 읽는 구간마다 fallback-poll

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ensureAuthToken } from '../auth/acp-token.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { canonicalSeatId, openMsgStoreReadOnly, type Message, type MsgStore } from './msg-store.js';

export interface MsgStreamOptions {
  address: string;
  /** Resolve to advance the cursor; reject to receive the same message again. */
  onMessage: (message: Message) => void | Promise<void>;
  signal?: AbortSignal;
  /** Default `<state-dir>/msg/sse-cursor/<ADDRESS>.json`. */
  cursorPath?: string;
  /**
   * Post office base URL — only by argument (OP #3237: no env, config key or hard-coded port on the
   * operating path). Absent = poll the ledger, which alone still delivers (wakes) every message.
   * Discovery through the control resource ledger is a follow-up goal (ASK-MSG-SSE-LEDGER-DISCOVERY).
   */
  url?: string;
  token?: () => string;
  /** Ledger reader for the polling fallback (default: read-only ledger in this state-dir). */
  openStore?: () => MsgStore;
  fetch?: typeof fetch;
  /** Reconnect backoff: doubles from `initialMs` to `maxMs`, reset after a successful connect. */
  backoff?: { initialMs?: number; maxMs?: number };
  pollMs?: number;
  /** Reconnect when the stream is silent this long (the server sends a keepalive every second). */
  idleTimeoutMs?: number;
}

export interface MsgStreamHandle {
  /** Stop delivering; resolves once the loop has exited. No callback starts after stop() is called. */
  stop: () => Promise<void>;
}

const LOG = 'msg.sse-client';

function defaultCursorPath(address: string): string {
  return join(elanousStateRoot(), 'msg', 'sse-cursor', `${address}.json`);
}

/** The saved cursor for `address` — a file written for another address is ignored (start from 0), never borrowed. */
function readCursor(path: string, address: string): number | undefined {
  let saved: { address?: unknown; lastEventId?: unknown };
  try { saved = JSON.parse(readFileSync(path, 'utf8')) as typeof saved; } catch { return undefined; }
  if (saved.address !== address) {
    debug.log(LOG, 'cursor-address-mismatch', { address, fileAddress: typeof saved.address === 'string' ? saved.address : null, path });
    return undefined;
  }
  const value = saved.lastEventId;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function writeCursor(path: string, address: string, lastEventId: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ address, lastEventId, at: new Date().toISOString() }));
  renameSync(tmp, path);
}

class StopError extends Error {}

export function subscribeMsgStream(options: MsgStreamOptions): MsgStreamHandle {
  const address = canonicalSeatId(options.address);
  if (address === 'ALL') throw new Error('ALL is a topic, not a recipient');
  const cursorPath = options.cursorPath ?? defaultCursorPath(address);
  const url = options.url;
  const doFetch = options.fetch ?? fetch;
  const initialBackoff = options.backoff?.initialMs ?? 500;
  const maxBackoff = options.backoff?.maxMs ?? 30_000;
  const pollMs = options.pollMs ?? 1000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 10_000;
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const stopped = () => controller.signal.aborted;
  let cursor = readCursor(cursorPath, address) ?? 0;

  const sleep = (ms: number) => new Promise<void>(resolve => {
    if (stopped()) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); }
    controller.signal.addEventListener('abort', done, { once: true });
  });

  /** Deliver in order; the cursor moves only after onMessage resolves. Returns false when a delivery failed. */
  const deliver = async (message: Message, via: 'sse' | 'poll'): Promise<boolean> => {
    if (message.id <= cursor) return true;
    if (stopped()) throw new StopError();
    try { await options.onMessage(message); }
    catch (error) {
      debug.log(LOG, 'deliver-failed', { address, msgId: message.id, via, cursor, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
    cursor = message.id;
    try { writeCursor(cursorPath, address, cursor); }
    catch (error) { debug.log(LOG, 'cursor-write-failed', { address, cursor, error: error instanceof Error ? error.message : String(error) }); }
    return true;
  };

  /** Drain the ledger directly — the outage path. Stops at the first failed delivery. */
  const pollOnce = async (): Promise<void> => {
    let store: MsgStore;
    try { store = (options.openStore ?? (() => openMsgStoreReadOnly()))(); }
    catch (error) { debug.log(LOG, 'poll-unavailable', { address, error: error instanceof Error ? error.message : String(error) }); return; }
    try {
      for (;;) {
        const batch = store.listByRecipient(address, cursor, 100);
        for (const message of batch) if (!await deliver(message, 'poll')) return;
        if (batch.length < 100) return;
      }
    } finally { store.close(); }
  };

  /** One SSE session; resolves when it ends (server gone, idle, delivery failure). Throws for 401. */
  const streamOnce = async (base: string, attempt: number): Promise<{ connected: boolean }> => {
    const target = new URL('/stream', base);
    target.searchParams.set('to', address);
    target.searchParams.set('since', String(cursor));
    const session = new AbortController();
    const onStop = () => session.abort();
    controller.signal.addEventListener('abort', onStop, { once: true });
    try {
      const token = (options.token ?? (() => ensureAuthToken().token))();
      // 재접속은 «실제로 다시 요청하는 순간»에 남긴다 — 토큰을 못 얻어 요청이 없으면 기록도 없다(첫 연결은 connect 만).
      if (attempt > 0) debug.log(LOG, 'reconnect', { address, attempts: attempt, cursor });
      // 헤더 대기에도 같은 무음 제한 — 연결만 받고 응답을 안 주는 서버에 매달려 폴링이 멈추지 않게.
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        doFetch(target, { headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': String(cursor) }, signal: session.signal }),
        new Promise<never>((_, reject) => { connectTimer = setTimeout(() => { session.abort(); reject(new Error('SSE connect timeout')); }, idleTimeoutMs); }),
      ]).finally(() => clearTimeout(connectTimer));
      if (response.status === 401) throw Object.assign(new Error('SSE unauthorized (401)'), { unauthorized: true });
      if (!response.ok || !response.body) throw new Error(`SSE unavailable (${response.status})`);
      debug.log(LOG, 'connect', { address, url: target.origin, lastEventId: cursor });
      if (cursor > 0) debug.log(LOG, 'replay', { address, from: cursor });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (!stopped()) {
        let idle: ReturnType<typeof setTimeout> | undefined;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { idle = setTimeout(() => reject(new Error('SSE idle timeout')), idleTimeoutMs); }),
        ]).finally(() => clearTimeout(idle));
        if (chunk.done) break;
        pending = (pending + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
        if (pending.length > 1_000_000) throw new Error('SSE event exceeds limit');
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          if (!data) continue;
          // A failed delivery drops this session; the reconnect replays from the unchanged cursor.
          if (!await deliver(JSON.parse(data) as Message, 'sse')) return { connected: true };
        }
      }
      return { connected: true };
    } finally {
      controller.signal.removeEventListener('abort', onStop);
      session.abort();
    }
  };

  /** Poll the ledger until `until` — one `fallback-poll` per interval. */
  const pollInterval = async (reason: string, until: number, attempts: number): Promise<void> => {
    debug.log(LOG, 'fallback-poll', { address, reason, cursor, attempts, ...(Number.isFinite(until) ? { untilMs: until - Date.now() } : {}) });
    do {
      try { await pollOnce(); }
      catch (error) { if (error instanceof StopError) return; debug.log(LOG, 'poll-failed', { address, error: error instanceof Error ? error.message : String(error) }); }
      await sleep(Math.min(pollMs, Math.max(0, until - Date.now())));
    } while (!stopped() && Date.now() < until);
  };

  const loop = (async () => {
    // 주소가 없으면 처음부터 원장 폴링 한 구간(끝 없음) — 운영 기본.
    if (!url) { await pollInterval('no-url', Number.POSITIVE_INFINITY, 0); return; }
    let backoff = initialBackoff;
    let attempts = 0;
    while (!stopped()) {
      let reason: string;
      try {
        const { connected } = await streamOnce(url, attempts);
        if (connected) backoff = initialBackoff;
        reason = 'stream-ended';
      } catch (error) {
        if (error instanceof StopError || stopped()) break;
        reason = (error as { unauthorized?: boolean }).unauthorized ? 'unauthorized' : error instanceof Error ? error.message : String(error);
      }
      if (stopped()) break;
      attempts++;
      // 끊긴 동안(서버 없음·토큰 거절·무응답·재접속 대기)은 원장을 직접 폴링한다.
      await pollInterval(reason, Date.now() + backoff, attempts);
      backoff = Math.min(maxBackoff, backoff * 2);
    }
  })();

  return {
    stop: async () => {
      if (!stopped()) debug.log(LOG, 'stop', { address, cursor });
      controller.abort();
      options.signal?.removeEventListener('abort', onOuterAbort);
      await loop.catch(() => undefined);
    },
  };
}
