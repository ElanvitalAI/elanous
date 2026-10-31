// PR-CL2 (B.2 · 2026-04-29) — ACP structured event → MessageBlockStream
// router.
//
// Bridge from raw `clientSessionSend(onUpdate)` events to the surface-
// neutral `MessageBlockStream` substrate (B.1). The router owns:
//
//  - per-session `MessageBlockStream` lifecycle
//  - turn / block sequence counters
//  - `agent_message_chunk` 의 active assistant block 누적 → update event
//  - `agent_thought_chunk` 의 active thought block 누적 → update event
//  - `tool_call` 와 `tool_call_update` 의 같은 block id 매칭 (B.1 의
//    stable merge key contract 사용)
//  - `plan` block (per-turn)
//
// Multiple consumers (acp-live pane render · conversation widget · chat
// log debug) 가 같은 stream 을 구독해도 사실상 같은 분해 결과를 보도록
// invariant 를 강제한다 (PR #1042 의 "stable id + merge/update semantics").
//
// **B.3 까지 transition 기간**: vw-live-bridge 의 로컬 transcript 와
// router stream 이 공존. pane render 는 여전히 로컬 transcript 사용 ·
// router stream 은 conversation widget / log-debug 가 구독 (B.3 에서
// pane render 도 stream snapshot 으로 교체).

import {
  createMessageBlockStream,
  makeAssistantTurnBlockId,
  makePlanBlockId,
  makeSystemBlockId,
  makeThoughtBlockId,
  makeToolCallBlockId,
  makeUserTurnBlockId,
  type MessageBlock,
  type MessageBlockStream,
} from '../conv-substrate/message-block.js';
import { debug } from '../debug/log.js';

/** ACP session update payload — `onUpdate` 가 raw 로 받는 shape 의
 *  subset. vw-live-bridge 의 inline type 와 일치. 추가 field 는 무시. */
export interface AcpSessionUpdate {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  title?: string;
  toolCallId?: string;
  status?: string;
  _meta?: { reasoning?: unknown; elanous?: { textOperation?: unknown } };
  /** Plan event 가 ref 를 직접 들고 오는 경우 (현재 ACP spec 에 없으면
   *  router 가 turn-기반 fallback ref 사용). */
  planId?: string;
}

export interface AcpEventRouter {
  /** Get (or create) the stream for a session. Subscribers 가 호출 ·
   *  ingest 가 자동으로 같은 stream 사용. */
  getStream(sessionId: string): MessageBlockStream;

  /** vw-live-bridge.submit() 가 user submit 시 호출. turn counter 를
   *  올리고 user block 을 stream 에 push 한 뒤 그 block 을 반환한다.
   *  반환된 block 의 id 가 다음 assistant block 의 turnSeq 기준이 됨. */
  noteUserSubmit(sessionId: string, text: string, ts?: number): MessageBlock;

  /** ACP session update 를 ingest. update kind 별로 stream 에
   *  push() OR update() 를 호출. unknown sessionUpdate 는 무시 (forward
   *  compat). */
  ingest(sessionId: string, update: AcpSessionUpdate, ts?: number): void;

  /** PR-CL3b (2026-04-29) — Push a system block (e.g. local error
   *  surfaced by `clientSessionSend` rejection). Bypasses `ingest`
   *  because such events do not arrive through ACP `sessionUpdate`
   *  but still belong on the conversation stream. Returns the pushed
   *  block so the caller can hand it to UI sinks if needed. */
  pushSystemBlock(
    sessionId: string,
    body: SystemBlockBody,
    ts?: number,
  ): MessageBlock;

  /** Session 종료 시 stream + state cleanup. */
  dropSession(sessionId: string): void;

  /** Test only — 활성 session 목록. */
  listSessions(): readonly string[];
}

/** PR-CL3b — Body shapes accepted by `pushSystemBlock`. Discriminated
 *  union so the caller can't accidentally synthesize a `user` or
 *  `assistant` block via this entry point (those go through
 *  `noteUserSubmit` / `ingest`). */
export type SystemBlockBody =
  | { kind: 'error'; text: string }
  | { kind: 'status'; text: string };

interface SessionState {
  /** -1 means no user submit yet. First submit increments to 0. */
  turnSeq: number;
  /** Per-turn monotonic block sequence. Reset on each new user turn. */
  blockSeq: number;
  /** sys block monotonic seq. Never reset (system events span turns). */
  sysSeq: number;
  /** Active assistant block id — chunks 가 이어 들어오면 같은 block 의
   *  body.text 를 update 로 누적. */
  activeAssistantBlockId: string | null;
  activeAssistantText: string;
  /** Last assistant block for this turn, retained across thought/tool delimiters
   *  so an authoritative synthesis can replace a provisional answer. */
  replaceableAssistantBlockId: string | null;
  /** Same shape for thought chunks. */
  activeThoughtBlockId: string | null;
  activeThoughtText: string;
}

function freshSessionState(): SessionState {
  return {
    turnSeq: -1,
    blockSeq: 0,
    sysSeq: 0,
    activeAssistantBlockId: null,
    activeAssistantText: '',
    replaceableAssistantBlockId: null,
    activeThoughtBlockId: null,
    activeThoughtText: '',
  };
}

export function createAcpEventRouter(): AcpEventRouter {
  const streams = new Map<string, MessageBlockStream>();
  const states = new Map<string, SessionState>();

  const ensureSession = (
    sessionId: string,
  ): { stream: MessageBlockStream; state: SessionState } => {
    let stream = streams.get(sessionId);
    if (!stream) {
      stream = createMessageBlockStream();
      streams.set(sessionId, stream);
      if (debug.enabled) {
        debug.log('acp.event-router.session.create', sessionId, {});
      }
    }
    let state = states.get(sessionId);
    if (!state) {
      state = freshSessionState();
      states.set(sessionId, state);
    }
    return { stream, state };
  };

  /** Closing the active assistant block — next agent_message_chunk
   *  starts a fresh assistant block. Called on tool_call / plan /
   *  agent_thought_chunk arrival, and on every user submit. */
  const flushActiveAssistant = (state: SessionState): void => {
    state.activeAssistantBlockId = null;
    state.activeAssistantText = '';
  };

  const flushActiveThought = (state: SessionState): void => {
    state.activeThoughtBlockId = null;
    state.activeThoughtText = '';
  };

  return {
    getStream(sessionId) {
      const { stream } = ensureSession(sessionId);
      return stream;
    },

    noteUserSubmit(sessionId, text, ts = Date.now()) {
      const { stream, state } = ensureSession(sessionId);
      // Any active streaming block from the previous turn closes — the
      // assistant won't append more chunks to it after the user has
      // already typed the next prompt.
      flushActiveAssistant(state);
      flushActiveThought(state);
      state.turnSeq += 1;
      state.blockSeq = 0;
      state.replaceableAssistantBlockId = null;
      const id = makeUserTurnBlockId(sessionId, state.turnSeq, state.blockSeq);
      const block: MessageBlock = {
        id,
        ts,
        source: 'user',
        body: { kind: 'user', text },
      };
      stream.push(block);
      if (debug.enabled) {
        debug.log('acp.event-router.user.submit', sessionId, {
          turnSeq: state.turnSeq,
          chars: text.length,
          blockId: id,
        });
      }
      return block;
    },

    ingest(sessionId, update, ts = Date.now()) {
      const { stream, state } = ensureSession(sessionId);
      const u = update;
      if (debug.enabled) {
        debug.log('acp.event-router.ingest', sessionId, {
          updateKind: u.sessionUpdate ?? '(none)',
          turnSeq: state.turnSeq,
        });
      }
      switch (u.sessionUpdate) {
        case 'agent_message_chunk': {
          const c = u.content;
          if (c?.type !== 'text' || typeof c.text !== 'string') return;
          const isReplace = u._meta?.elanous?.textOperation === 'replace';
          const replaceTargetId = state.activeAssistantBlockId ?? state.replaceableAssistantBlockId;
          if (isReplace && replaceTargetId !== null) {
            flushActiveThought(state);
            state.activeAssistantText = c.text;
            const id = replaceTargetId;
            stream.update(id, (cur) => ({
              ...cur,
              body: { ...cur.body, text: c.text } as MessageBlock['body'],
            }));
            state.activeAssistantBlockId = id;
            return;
          }
          if (state.activeAssistantBlockId === null) {
            // New assistant block — close any active thought first so
            // append/update events stay temporally ordered for
            // subscribers.
            flushActiveThought(state);
            state.blockSeq += 1;
            const id = makeAssistantTurnBlockId(
              sessionId,
              Math.max(0, state.turnSeq),
              state.blockSeq,
            );
            state.activeAssistantBlockId = id;
            state.replaceableAssistantBlockId = id;
            state.activeAssistantText = c.text;
            stream.push({
              id,
              ts,
              source: 'agent',
              body: { kind: 'assistant', text: c.text, markdown: true },
            });
          } else {
            state.activeAssistantText += c.text;
            const id = state.activeAssistantBlockId;
            const accumulated = state.activeAssistantText;
            stream.update(id, (cur) => ({
              ...cur,
              body: { ...cur.body, text: accumulated } as MessageBlock['body'],
            }));
          }
          return;
        }

        case 'agent_thought_chunk': {
          const c = u.content;
          if (
            c?.type !== 'text'
            || typeof c.text !== 'string'
            || c.text.length === 0
          ) {
            return;
          }
          if (state.activeThoughtBlockId === null) {
            // Symmetric: opening a thought closes any active assistant
            // block so the stream order matches the human-perceived
            // alternation.
            flushActiveAssistant(state);
            state.blockSeq += 1;
            const id = makeThoughtBlockId(
              sessionId,
              Math.max(0, state.turnSeq),
              state.blockSeq,
            );
            state.activeThoughtBlockId = id;
            state.activeThoughtText = c.text;
            stream.push({
              id,
              ts,
              source: 'agent',
              body: {
                kind: 'thought',
                text: c.text,
                reasoning: u._meta?.reasoning === true,
              },
            });
          } else {
            state.activeThoughtText += c.text;
            const id = state.activeThoughtBlockId;
            const accumulated = state.activeThoughtText;
            stream.update(id, (cur) => ({
              ...cur,
              body: { ...cur.body, text: accumulated } as MessageBlock['body'],
            }));
          }
          return;
        }

        case 'tool_call': {
          flushActiveAssistant(state);
          flushActiveThought(state);
          const tcId = u.toolCallId;
          if (!tcId) return;
          const id = makeToolCallBlockId(sessionId, tcId);
          // Defensive: if a tool_call_update raced ahead of the
          // tool_call (network reorder), the block already exists. Refresh
          // title; otherwise push fresh.
          const exists = stream.snapshot().some((b) => b.id === id);
          if (exists) {
            stream.update(id, (cur) => ({
              ...cur,
              body: {
                ...cur.body,
                title: u.title ?? (cur.body as { title?: string }).title ?? tcId,
                status: u.status ?? (cur.body as { status?: string }).status,
              } as MessageBlock['body'],
            }));
          } else {
            state.blockSeq += 1;
            stream.push({
              id,
              ts,
              source: 'tool',
              body: {
                kind: 'tool-call',
                toolCallId: tcId,
                title: u.title ?? tcId,
                ...(u.status ? { status: u.status } : {}),
              },
            });
          }
          return;
        }

        case 'tool_call_update': {
          const tcId = u.toolCallId;
          if (!tcId) return;
          const id = makeToolCallBlockId(sessionId, tcId);
          const exists = stream.snapshot().some((b) => b.id === id);
          if (!exists) {
            // Race: update before original — push a fresh block so the
            // stream isn't empty for that toolCallId. Subsequent updates
            // will hit the `update` branch below.
            state.blockSeq += 1;
            stream.push({
              id,
              ts,
              source: 'tool',
              body: {
                kind: 'tool-call',
                toolCallId: tcId,
                title: u.title ?? tcId,
                ...(u.status ? { status: u.status } : {}),
              },
            });
            return;
          }
          stream.update(id, (cur) => ({
            ...cur,
            body: {
              ...cur.body,
              title: u.title ?? (cur.body as { title?: string }).title ?? tcId,
              status: u.status ?? (cur.body as { status?: string }).status,
            } as MessageBlock['body'],
          }));
          return;
        }

        case 'plan': {
          flushActiveAssistant(state);
          flushActiveThought(state);
          const ref = u.planId ?? `turn-${Math.max(0, state.turnSeq)}-plan`;
          const id = makePlanBlockId(sessionId, ref);
          const exists = stream.snapshot().some((b) => b.id === id);
          if (!exists) {
            state.blockSeq += 1;
            stream.push({
              id,
              ts,
              source: 'agent',
              body: { kind: 'plan', ref },
            });
          }
          // 'update' on plan is a no-op signal for now — Track B.4 may
          // surface plan revisions as update events with structured ref.
          return;
        }

        default:
          // Unknown update kind — forward-compat: ignore silently. The
          // raw update is still available to direct subscribers via
          // `emit('output', update)` in vw-live-bridge.
          return;
      }
    },

    pushSystemBlock(sessionId, body, ts = Date.now()) {
      const { stream, state } = ensureSession(sessionId);
      // Closing any active streaming block — a system event (error /
      // status surfaced by the caller) is treated as a hard delimiter
      // for whatever was mid-stream so the next agent_message_chunk
      // starts a fresh block.
      flushActiveAssistant(state);
      flushActiveThought(state);
      const seq = state.sysSeq++;
      const id = makeSystemBlockId(sessionId, body.kind, seq);
      const block: MessageBlock = {
        id,
        ts,
        source: 'system',
        body,
      };
      stream.push(block);
      if (debug.enabled) {
        debug.log('acp.event-router.system-block.push', sessionId, {
          kind: body.kind,
          id,
        });
      }
      return block;
    },

    dropSession(sessionId) {
      const stream = streams.get(sessionId);
      if (stream) {
        stream.dispose();
        streams.delete(sessionId);
      }
      states.delete(sessionId);
      if (debug.enabled) {
        debug.log('acp.event-router.session.drop', sessionId, {});
      }
    },

    listSessions() {
      return Array.from(streams.keys());
    },
  };
}

// ─── Global singleton ─────────────────────────────────────────────────

let _global: AcpEventRouter | null = null;

export function globalAcpEventRouter(): AcpEventRouter {
  if (!_global) _global = createAcpEventRouter();
  return _global;
}

/** Test-only — drop the singleton so each test starts fresh. */
export function _resetGlobalAcpEventRouterForTests(): void {
  _global = null;
}
