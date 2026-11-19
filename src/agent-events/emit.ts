// eln agent-event emitter — the one door every operating producer (turn state, sub-agent, harness run, graph run/nodes,
// sidetab mission, background shell) uses to tell whatever frames this eln. Active only when the frame put
// ELANOUS_EVENT_SOCKET into the environment; otherwise there is no emitter and nothing touches a socket.
// Fail-soft: no host, a refused frame or a throw never reaches the producer.
import { randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';
import { ENV_EVENT_PANE, ENV_EVENT_SOCKET, ENV_EVENT_WS, EVENT_PROTOCOL_VERSION, type AgentEvent, type AgentEventFrame, type AgentState, type ChildSourceName } from './protocol.js';
import { sendFrameOverSocket, type SendFrame } from './transport.js';

export interface AgentEventEmitter {
  state(state: AgentState, message?: string): void;
  turn(phase: 'start' | 'end', id: string): void;
  meta(meta: { model?: string; queue?: number; plan?: string; elapsed?: string; title?: string }): void;
  notice(level: 'info' | 'warn' | 'alert', text: string): void;
  release(): void;
  readonly child: {
    start(input: { id: string; source: ChildSourceName; label: string; parent?: string; cwd?: string }): void;
    progress(id: string, line: string): void;
    status(id: string, state: 'working' | 'blocked' | 'idle', line?: string): void;
    end(id: string, ok: boolean, summary: string): void;
  };
  /** Resolves when everything emitted so far has been answered (or failed). For tests and orderly shutdown. */
  flush(): Promise<void>;
}

export interface AgentEventEmitterOpts {
  readonly ws: string;
  readonly socketPath: string;
  readonly pane?: string;
  /** Transport seam. Called strictly one at a time, in emission order. */
  readonly send?: SendFrame;
  readonly now?: () => number;

  /** One line per swallowed failure; default `debug.log('agent-events', …)`. */
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);

/** 출처: the send chain times out at 10 s per frame (transport.ts), so 256 queued frames bound the backlog of a hung host. */
const MAX_QUEUED = 256;

export function createAgentEventEmitter(opts: AgentEventEmitterOpts): AgentEventEmitter {
  const send = opts.send ?? sendFrameOverSocket;
  const log = opts.log ?? ((event: string, data: Record<string, unknown>) => debug.log('agent-events', event, data));
  const now = opts.now ?? Date.now;
  // One chain per emitter: every frame waits for the one before it to be answered, so the host sees start → status → end in the
  // order the producer made them (separate fire-and-forget sockets raced: an end could overtake its start).
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  // The sender is THIS emitter: a random sid, and a plain counter inside it. Two processes in one pane (an inherited environment,
  // a fast restart) have different sids, so neither can make the other's frames look stale; within one sid the chain is ordered,
  // so seq only ever goes up by one.
  // 출처: #38499 — 미사용 sid 옵션 폐지(동일 sid 주입이 송신자 분리를 깨뜨림): 무조건 fresh random sid
  const sid = randomUUID().slice(0, 80);
  let seq = 0;
  const guarded = (what: string, fn: () => void): void => {
    try { fn(); } catch (error) { try { log('agent-event-threw', { what, error: error instanceof Error ? error.message : String(error) }); } catch { /* the log must not throw either */ } }
  };
  const post = (event: AgentEvent): void => {
    if (queued >= MAX_QUEUED) return;
    queued++;
    try {
      const at = now();
      // 출처: #38499 — now() 가 throw 해도 seq 를 소모하지 않도록 at 계산을 seq 증가보다 먼저: 구멍(1, 3, …) 방지
      seq += 1;
      const frame: AgentEventFrame = { op: 'event', v: EVENT_PROTOCOL_VERSION, ws: opts.ws, ...(opts.pane ? { pane: opts.pane } : {}), sid, seq, at, event };
      tail = tail.then(() => send(opts.socketPath, frame)).catch(() => { /* no host: nothing to show */ }).finally(() => { queued--; });
    } catch (error) {
      // terra must 2 (#38499): frame construction failed (e.g. a throwing clock) — hand the slot back, or enough of these jam
      // the backlog for good. The rethrow is what guarded() turns into one logged line, exactly as before the fix.
      queued--;
      throw error;
    }
  };
  return {
    flush: async () => { await tail; },
    state: (state, message) => guarded('state', () => post({ kind: 'state', state, ...(message ? { message: oneLine(message, 200) } : {}) })),
    turn: (phase, id) => guarded('turn', () => post({ kind: 'turn', phase, id: oneLine(id, 80) })),
    meta: (meta) => guarded('meta', () => post({ kind: 'meta', ...meta })),
    notice: (level, text) => guarded('notice', () => post({ kind: 'notice', level, text: oneLine(text, 200) })),
    release: () => guarded('release', () => post({ kind: 'release' })),
    child: {
      start: (i) => guarded('child.start', () => post({ kind: 'child', action: 'start', id: i.id, source: i.source, label: oneLine(i.label, 80),
        ...(i.cwd ? { cwd: i.cwd } : {}), ...(i.parent ? { parent: i.parent } : {}) })),
      progress: (id, line) => guarded('child.progress', () => post({ kind: 'child', action: 'progress', id, line: oneLine(line, 200) })),
      status: (id, state, line) => guarded('child.status', () => post({ kind: 'child', action: 'status', id, state, ...(line ? { line: oneLine(line, 200) } : {}) })),
      end: (id, ok, summary) => guarded('child.end', () => post({ kind: 'child', action: 'end', id, ok, summary: oneLine(summary, 200) })),
    },
  };
}

/** The emitter for this process, or undefined when no frame launched it. Created once per environment. */
let cached: { socketPath: string; ws: string; pane: string; emitter: AgentEventEmitter | undefined } | undefined;
export function getAgentEventEmitter(env: NodeJS.ProcessEnv = process.env): AgentEventEmitter | undefined {
  const socketPath = env[ENV_EVENT_SOCKET]?.trim() ?? '';
  const ws = env[ENV_EVENT_WS]?.trim() ?? '';
  const pane = env[ENV_EVENT_PANE]?.trim() ?? '';
  // 출처: #38499 — 튜플 성분 비교로 교체: '|' 문자열 키는 성분에 '|'가 있으면 충돌해 남의 emitter 를 돌려줬다
  if (cached && cached.socketPath === socketPath && cached.ws === ws && cached.pane === pane) return cached.emitter;
  const emitter = socketPath && ws ? createAgentEventEmitter({ ws, socketPath, ...(pane ? { pane } : {}) }) : undefined;
  cached = { socketPath, ws, pane, emitter };
  return emitter;
}
