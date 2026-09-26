// ── Turn-stream runtime — thin wrapper combining formatter + applier ──
//
// 2026-05-03 PM++ — Architectural refactor (사용자 원칙: presentation 이
// content 를 만지지 말 것).
//
// 이 파일은 이전 구조 (formatter + applier 가 한 함수에 섞임 — chatLines
// mutation 이 6곳에 분산되어 동류 bug 의 원인) 의 BACKWARD-COMPAT shell.
// 외부 API (`createDashboardTurnStreamRuntime`, `DashboardTurnStreamRuntime`,
// `DashboardTurnStreamRenderedToolRuntime`, `DashboardTurnStreamCall`) 는
// 그대로 유지 — 호출자 (chat-main-plain-turn-runtime, dashboard/index.ts,
// 기존 테스트) 변경 0건. 내부적으로 formatter (이벤트 emit) + applier
// (chatLines mutation) 로 split.
//
// 새 코드는 turn-stream-formatter.ts 와 turn-stream-presentation-applier.ts
// 직접 사용 권장 (개별 단위 테스트 가능, 의존성 명확). 본 wrapper 는
// legacy entry point.

import type { FoldMode } from '../log-entry.js';
import {
  createTurnStreamFormatter,
  type TurnStreamCall,
} from './turn-stream-formatter.js';
import {
  createTurnStreamPresentationApplier,
  type TurnStreamRenderedToolRuntime,
} from './turn-stream-presentation-applier.js';

export type DashboardTurnStreamCall = TurnStreamCall;

export type DashboardTurnStreamRenderedToolRuntime = TurnStreamRenderedToolRuntime;

export interface DashboardTurnStreamRuntimeDeps {
  initialAssistantStart: number;
  chatLines: string[];
  thinking: {
    update(label: string): void;
    updateMetrics(metrics: { outputTokens: number }): void;
  };
  draw: () => void;
  withPassiveRenderFocus?: <T>(render: () => T) => T;
  pinChatTail: () => void;
  termCols: () => number;
  // chat.rendering.wrap 는 boolean 이 아니라 wrap 옵션 오브젝트로 이관됨.
  wrapOpts: { urlAware?: boolean };
  formatResponse: (full: string, width: number, wrapOpts?: { urlAware?: boolean }) => string[];
  text: (line: string) => string;
  muted: (text: string) => string;
  ptyCallLine: (name: string, args: Record<string, unknown>) => string | null;
  ptyResultLine: (name: string, result: unknown) => string | null;
  // method 문법(bivariant) — 구체 tool-render 함수(ToolRenderCall/ToolRenderResult)를 수용.
  renderToolCallEvent(call: DashboardTurnStreamCall, rendering: unknown): string[] | null;
  renderToolResultVariants(call: DashboardTurnStreamCall, rendering: unknown): {
    collapsed: string[];
    expanded: string[] | null;
  } | null;
  toolRendering: unknown;
  /** Optional. Forwarded into createTurnStreamFormatter collapsed config.
   *  Omitted = existing `'line'` behavior. */
  foldMode?: FoldMode;
  renderedToolRuntime: DashboardTurnStreamRenderedToolRuntime;
  brainIcon: string;
}

export interface DashboardTurnStreamRuntime {
  getAssistantStart(): number;
  onText(chunk: string, accumulated: string): void;
  onToolCall(call: DashboardTurnStreamCall): void;
  onToolResult(call: DashboardTurnStreamCall): void;
}

export function createDashboardTurnStreamRuntime(
  deps: DashboardTurnStreamRuntimeDeps,
): DashboardTurnStreamRuntime {
  // Single chatLines mutation site.
  const applier = createTurnStreamPresentationApplier({
    chatLines: deps.chatLines,
    renderedToolRuntime: deps.renderedToolRuntime,
    initialAssistantStart: deps.initialAssistantStart,
    draw: deps.draw,
    ...(deps.withPassiveRenderFocus ? { withPassiveRenderFocus: deps.withPassiveRenderFocus } : {}),
    pinChatTail: deps.pinChatTail,
  });
  // Pure-ish formatter — emits events to applier, no chatLines access.
  const formatter = createTurnStreamFormatter({
    emit: (event) => applier.apply(event),
    thinking: deps.thinking,
    termCols: deps.termCols,
    wrapOpts: deps.wrapOpts,
    formatResponse: deps.formatResponse,
    text: deps.text,
    muted: deps.muted,
    ptyCallLine: deps.ptyCallLine,
    ptyResultLine: deps.ptyResultLine,
    renderToolCallEvent: deps.renderToolCallEvent,
    renderToolResultVariants: deps.renderToolResultVariants,
    toolRendering: deps.toolRendering,
    ...(deps.foldMode !== undefined ? { foldMode: deps.foldMode } : {}),
    brainIcon: deps.brainIcon,
  });
  return {
    getAssistantStart: applier.getAssistantStart,
    onText: formatter.onText,
    onToolCall: formatter.onToolCall,
    onToolResult: formatter.onToolResult,
  };
}
