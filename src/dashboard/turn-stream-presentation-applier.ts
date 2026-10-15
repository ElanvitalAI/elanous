// ── Turn-stream presentation applier ───────────────────────────────
//
// 2026-05-03 PM++ — Architectural refactor (사용자 원칙: presentation 이
// content 를 만지지 말 것).
//
// 이 파일은 turn-stream 의 **유일한** chatLines mutation site. formatter
// (turn-stream-formatter.ts) 가 emit 하는 TurnStreamPresentationEvent 를
// 받아 chatLines / assistantStart / draw / renderedToolRuntime 을
// mutation. 모든 chatLines 변형은 여기서만 발생 — bug 발생 시 진단 site
// 단 1곳.
//
// 이전 (단일 turn-stream-runtime.ts) 는 chatLines mutation 이 6곳에
// 분산 (renderPerRoundText / 4 onToolCall paths / 2 onToolResult paths).
// 한 path 의 변경이 다른 path 의 invariant 를 깨는 패턴 (사용자 보고
// "narration 이 표시 후 사라짐" bug) 의 구조적 원인. 본 split 후 모든
// path 의 mutation 의도가 event type 으로 명시되고 단일 switch 에서
// 처리.

import { debug } from '../debug/log.js';

/** chatLines / renderedToolRuntime 을 직접 만질 수 있는 유일한 의존성
 *  shape. 외부 (formatter) 는 이 모듈에 emit 만 함. */
export interface TurnStreamRenderedToolRuntime {
  setArgs(callId: string, args: Record<string, unknown>): void;
  getArgs(callId: string): Record<string, unknown> | undefined;
  deleteArgs(callId: string): void;
  replaceBlock(callId: string, nextLines: string[], assistantStart: number): number;
  registerFold(
    callId: string,
    collapsed: string[],
    expanded: string[] | null,
    grouping?: { operationKind?: string },
  ): void;
}

/** Discriminated union — formatter 가 의도를 type 으로 명시.
 *  applier 는 type 별 정확한 chatLines mutation 만 수행. */
export type TurnStreamPresentationEvent =
  /** Streaming 중 per-round assistant 텍스트가 갱신될 때마다.
   *  applier 는 chatLines 를 assistantStart 까지 truncate 후 lines
   *  push. assistantStart 는 advance 안 함 (다음 delta 가 같은 위치에
   *  덮어씀). */
  | { type: 'assistant.replaceBlock'; lines: string[] }
  /** clear-and-commit — narration streaming 종료 + 다음 tool round 직전.
   *  applier 는 chatLines 안 만지고 assistantStart 만 advance
   *  (chatLines.length 까지). 결과: narration 영구 보존, 다음 round
   *  부터 새 위치에서 시작. */
  | { type: 'assistant.commit' }
  /** Tool call/result 를 단일 라인으로 표현 (pty / fallback).
   *  applier 는 push + assistantStart advance + pinChatTail + draw. */
  | { type: 'tool.appendLine'; callId: string; line: string }
  /** Rendered tool call (multi-line block).
   *  applier 는 renderedToolRuntime.setArgs + replaceBlock 으로 splice +
   *  assistantStart 가 replaceBlock return 으로 advance. */
  | { type: 'tool.appendBlock'; callId: string; lines: string[]; args: Record<string, unknown>; operationKind?: string }
  /** Rendered tool result — 기존 block 을 collapsed 로 교체 + fold
   *  등록 + args 삭제. */
  | { type: 'tool.replaceBlock'; callId: string; collapsedLines: string[]; expandedLines: string[] | null; operationKind?: string };

export interface TurnStreamPresentationApplierDeps {
  chatLines: string[];
  renderedToolRuntime: TurnStreamRenderedToolRuntime;
  initialAssistantStart: number;
  draw: () => void;
  withPassiveRenderFocus?: <T>(render: () => T) => T;
  pinChatTail: () => void;
}

export interface TurnStreamPresentationApplier {
  apply(event: TurnStreamPresentationEvent): void;
  getAssistantStart(): number;
}

export function createTurnStreamPresentationApplier(
  deps: TurnStreamPresentationApplierDeps,
): TurnStreamPresentationApplier {
  let assistantStart = deps.initialAssistantStart;
  const draw = (): void => {
    if (deps.withPassiveRenderFocus) {
      deps.withPassiveRenderFocus(deps.draw);
    } else {
      deps.draw();
    }
  };

  const logEvent = (eventName: string, payload: Record<string, unknown>): void => {
    if (debug.enabled) {
      debug.log('dashboard.chat.stream', `presentation.${eventName}`, {
        assistantStart,
        chatLinesLen: deps.chatLines.length,
        ...payload,
      });
    }
  };

  return {
    getAssistantStart: () => assistantStart,
    apply(event: TurnStreamPresentationEvent): void {
      switch (event.type) {
        case 'assistant.replaceBlock': {
          const beforeLen = deps.chatLines.length;
          if (assistantStart > deps.chatLines.length) {
            debug.log('dashboard.chat.stream', 'presentation.assistant-start-clamped', {
              assistantStart,
              chatLinesLen: deps.chatLines.length,
            });
            assistantStart = deps.chatLines.length;
          }
          deps.chatLines.length = assistantStart;
          deps.chatLines.push(...event.lines);
          logEvent('assistant.replaceBlock', {
            beforeLen,
            afterLen: deps.chatLines.length,
            newLineCount: event.lines.length,
            truncated: beforeLen - assistantStart,
          });
          draw();
          return;
        }
        case 'assistant.commit': {
          const prev = assistantStart;
          if (deps.chatLines.length > assistantStart) {
            assistantStart = deps.chatLines.length;
          }
          logEvent('assistant.commit', {
            prevAssistantStart: prev,
            committedLines: assistantStart - prev,
          });
          return;
        }
        case 'tool.appendLine': {
          deps.chatLines.push(event.line);
          assistantStart = deps.chatLines.length;
          logEvent('tool.appendLine', {
            callId: event.callId,
          });
          deps.pinChatTail();
          draw();
          return;
        }
        case 'tool.appendBlock': {
          deps.renderedToolRuntime.setArgs(event.callId, event.args);
          assistantStart = deps.renderedToolRuntime.replaceBlock(
            event.callId,
            event.lines,
            assistantStart,
          );
          logEvent('tool.appendBlock', {
            callId: event.callId,
            blockLineCount: event.lines.length,
          });
          deps.pinChatTail();
          draw();
          return;
        }
        case 'tool.replaceBlock': {
          assistantStart = deps.renderedToolRuntime.replaceBlock(
            event.callId,
            event.collapsedLines,
            assistantStart,
          );
          deps.renderedToolRuntime.registerFold(
            event.callId,
            event.collapsedLines,
            event.expandedLines,
            event.operationKind ? { operationKind: event.operationKind } : undefined,
          );
          assistantStart = Math.min(assistantStart, deps.chatLines.length);
          deps.renderedToolRuntime.deleteArgs(event.callId);
          logEvent('tool.replaceBlock', {
            callId: event.callId,
            collapsedLineCount: event.collapsedLines.length,
            hasExpanded: event.expandedLines !== null,
          });
          deps.pinChatTail();
          draw();
          return;
        }
      }
    },
  };
}
