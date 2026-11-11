// PR-CL1 (B.1 · 2026-04-29) — Surface-neutral message-block substrate.
//
// `acp-live` pane 내부 transcript / `conversation widget` 의
// `ConversationMessage` / `chat log debug` string buffer 가 같은 ACP
// session 의 message 를 서로 다른 shape 으로 분해하는 fragmentation 을
// presentation substrate 로 끌어올린다.
//
// PR #1042 보강 — `id` 는 append-only UUID 가 아니라 **stable merge key**.
// `update` 와 `append` 가 invariant 로 명확히 분리되어, 같은 stream 을
// 여러 surface 가 구독해도 분해 결과가 일치한다.
//
// 본 모듈은 **순수 substrate**: ACP session / VW pane / dashboard widget
// 등 도메인 코드를 import 하지 않는다. Track B 의 후속 PR (B.2 event-router
// · B.3 widget rewire) 가 이 substrate 위에서 구현된다.

import { debug } from '../debug/log.js';

/** Discriminated union — `body.kind` 가 surface 별 render 분기의 single
 *  source of truth. 신규 kind 추가 시 모든 consumer (acp-live render,
 *  conversation widget render, log-debug formatter) 가 같은 union 을
 *  소비하므로 누락이 type 차원에서 잡힌다. */
export type MessageBlockKind =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; markdown?: boolean }
  | { kind: 'thought'; text: string; reasoning?: boolean }
  | { kind: 'tool-call'; toolCallId: string; title: string; status?: string }
  | { kind: 'plan'; ref: string }
  | { kind: 'status'; text: string }
  | { kind: 'error'; text: string };

/** `source` 는 block 의 origin 을 표기. agent_message_chunk 와
 *  agent_thought_chunk 는 둘 다 `'agent'` source · body.kind 로 구분. */
export type MessageBlockSource = 'user' | 'agent' | 'tool' | 'system';

/** Surface-neutral progressive detail. `level` is the richest detail available;
 *  raw payloads stay behind a run/block reference and are fetched by the surface. */
export interface MessageBlockDetail {
  readonly level: 1 | 2 | 3;
  readonly summary?: string;
  readonly steps?: readonly string[];
  readonly rawRef?: { readonly runId: string; readonly blockId: string };
}

export interface MessageBlock {
  /** Stable merge key. `makeXxxBlockId` helper 로 생성. UUID append-only
   *  아님 — 같은 toolCallId 의 update 는 같은 block id 를 다시 사용한다. */
  readonly id: string;
  /** Block 의 logical timestamp. update 시 변경 금지 (invariant). */
  readonly ts: number;
  readonly source: MessageBlockSource;
  readonly body: MessageBlockKind;
  /** Optional detail tiers; never embeds L3 tool input/output. */
  readonly detail?: MessageBlockDetail;
}

export type MessageBlockStreamEvent = 'append' | 'update';

/** `update()` 에 전달하는 patch 함수. `id` / `ts` / `source` 는 invariant
 *  이므로 returner 가 mutate 하면 stream 이 throw — 호출자는 `body` 또는
 *  내부 field 만 변경. */
export type MessageBlockUpdater = (current: MessageBlock) => MessageBlock;

export interface MessageBlockStream {
  /** Append a new block. block.id 가 stream 내 unique 이어야 한다.
   *  중복 id 는 throw — 호출자는 `update()` 를 사용해야 함. */
  push(block: MessageBlock): void;

  /** Update an existing block by id. id 가 미등록이면 throw — 호출자는
   *  `push()` 사용해야 함. updater 의 결과가 `id` / `ts` / `source` 를
   *  변경하면 throw (invariant 위반). */
  update(blockId: string, updater: MessageBlockUpdater): void;

  /** Read-only snapshot in append order. update 는 자리를 옮기지 않음. */
  snapshot(): readonly MessageBlock[];

  /** Subscribe to append OR update events. 두 event 는 invariant 로
   *  명확히 분리 — append listener 는 update 에 fire 안 됨, vice versa.
   *  Returns unsubscribe fn. */
  on(event: MessageBlockStreamEvent, cb: (block: MessageBlock) => void): () => void;

  /** Drop all blocks + listeners. VW close / session reset 시 호출. */
  dispose(): void;
}

// ── Stable merge key generators ─────────────────────────────────────
//
// PR #1042 보강 — 본 plan 의 핵심 contract.
//
// user / assistant turn block: `sessionId:user:turnSeq:blockSeq` /
//                              `sessionId:assistant:turnSeq:blockSeq`
// tool-call:                   `sessionId:tool:toolCallId`
// tool_call_update:            같은 toolCallId block 을 update event 로
// agent_message_chunk:         active assistant block 에 append (B.2 의
//                              router 가 처리)

export function makeUserTurnBlockId(
  sessionId: string,
  turnSeq: number,
  blockSeq: number,
): string {
  return `${sessionId}:user:${turnSeq}:${blockSeq}`;
}

export function makeAssistantTurnBlockId(
  sessionId: string,
  turnSeq: number,
  blockSeq: number,
): string {
  return `${sessionId}:assistant:${turnSeq}:${blockSeq}`;
}

export function makeToolCallBlockId(sessionId: string, toolCallId: string): string {
  return `${sessionId}:tool:${toolCallId}`;
}

export function makePlanBlockId(sessionId: string, planRef: string): string {
  return `${sessionId}:plan:${planRef}`;
}

export function makeThoughtBlockId(
  sessionId: string,
  turnSeq: number,
  blockSeq: number,
): string {
  return `${sessionId}:thought:${turnSeq}:${blockSeq}`;
}

/** System / status / error 처럼 turn 외부 block 의 id. seq 는 stream
 *  자체의 monotonic counter — 호출자가 관리한다. */
export function makeSystemBlockId(sessionId: string, kind: string, seq: number): string {
  return `${sessionId}:sys:${kind}:${seq}`;
}

// ── Factory ─────────────────────────────────────────────────────────

export function createMessageBlockStream(): MessageBlockStream {
  const blocks: MessageBlock[] = [];
  const indexById = new Map<string, number>();
  const listeners: Record<MessageBlockStreamEvent, Set<(b: MessageBlock) => void>> = {
    append: new Set(),
    update: new Set(),
  };

  const emit = (event: MessageBlockStreamEvent, block: MessageBlock): void => {
    const set = listeners[event];
    for (const cb of Array.from(set)) {
      try {
        cb(block);
      } catch {
        // per-listener errors are isolated — surface render glitches in
        // one consumer must not break sibling consumers.
      }
    }
  };

  return {
    push(block) {
      if (indexById.has(block.id)) {
        throw new Error(
          `MessageBlockStream.push: id "${block.id}" already exists — use update() instead`,
        );
      }
      indexById.set(block.id, blocks.length);
      blocks.push(block);
      if (debug.enabled) {
        debug.log('conv-substrate.message-block.append', block.id, {
          source: block.source,
          bodyKind: block.body.kind,
          ts: block.ts,
        });
      }
      emit('append', block);
    },

    update(blockId, updater) {
      const idx = indexById.get(blockId);
      if (idx === undefined) {
        throw new Error(
          `MessageBlockStream.update: id "${blockId}" not found — use push() instead`,
        );
      }
      const current = blocks[idx]!;
      const next = updater(current);
      if (next.id !== current.id) {
        throw new Error(
          `MessageBlockStream.update: id mutated ("${current.id}" → "${next.id}") — invariant violated`,
        );
      }
      if (next.ts !== current.ts) {
        throw new Error(
          `MessageBlockStream.update: ts mutated (${current.ts} → ${next.ts}) — invariant violated`,
        );
      }
      if (next.source !== current.source) {
        throw new Error(
          `MessageBlockStream.update: source mutated ("${current.source}" → "${next.source}") — invariant violated`,
        );
      }
      blocks[idx] = next;
      if (debug.enabled) {
        debug.log('conv-substrate.message-block.update', blockId, {
          source: next.source,
          bodyKind: next.body.kind,
        });
      }
      emit('update', next);
    },

    snapshot() {
      return blocks.slice();
    },

    on(event, cb) {
      listeners[event].add(cb);
      return (): void => {
        listeners[event].delete(cb);
      };
    },

    dispose() {
      if (debug.enabled) {
        debug.log('conv-substrate.message-block.dispose', '', {
          blockCount: blocks.length,
          appendListeners: listeners.append.size,
          updateListeners: listeners.update.size,
        });
      }
      blocks.length = 0;
      indexById.clear();
      listeners.append.clear();
      listeners.update.clear();
    },
  };
}
