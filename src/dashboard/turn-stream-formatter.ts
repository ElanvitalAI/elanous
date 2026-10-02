// ── Turn-stream formatter ─────────────────────────────────────────
//
// 2026-05-03 PM++ — Architectural refactor (사용자 원칙: presentation 이
// content 를 만지지 말 것).
//
// 이 파일은 turn-stream 의 **순수 transformation layer**. streamLLMWithTools
// 의 onText / onToolCall / onToolResult 콜백을 받아 perRoundText 누적,
// formatResponse 변환, tool render 결정 후 TurnStreamPresentationEvent
// 를 emit. **chatLines / draw / renderedToolRuntime 등 stateful 의존성을
// 받지 않음** — 모두 applier 가 소유.
//
// 이전 (단일 turn-stream-runtime.ts) 는 formatter 책무 (perRoundText
// 누적 + format) + applier 책무 (chatLines mutation) 가 섞여 있었음.
// 본 split 후 formatter 는 pure-ish (perRoundText 와 toolArgsByCallId
// state 만 보유), 모든 외부 mutation 은 emit event 로 위임.

import { debug } from '../debug/log.js';
import { renderToolBlock } from '../chat/tool-render/block.js';
import type { ToolRenderModel } from '../chat/tool-render/types.js';
import { toolOperationKind, type FoldMode } from '../log-entry.js';
import { stripAnsi } from '../tui.js';
import type { TurnStreamPresentationEvent } from './turn-stream-presentation-applier.js';

/** Drop leading/trailing blank (whitespace-only, ANSI-stripped) rows
 *  from a rendered assistant block. Codex-family models frequently
 *  wrap inter-tool narration in `\n\n`, and `formatResponse` preserves
 *  those as empty rows. Committed once per tool round, they pile up
 *  into the wide vertical gaps between tool calls the user reported.
 *  This trims the DISPLAY block only — the raw turn text (history /
 *  auto-copy / metrics) is accumulated separately upstream, so no
 *  content is lost. Interior blank lines (paragraph breaks) are kept. */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && stripAnsi(lines[start]!).trim() === '') start++;
  while (end > start && stripAnsi(lines[end - 1]!).trim() === '') end--;
  return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

function serializeToolValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function genericResultVariants(
  call: TurnStreamCall,
  brainIcon: string,
  muted: (text: string) => string,
  blockMaxLines: number,
): {
  collapsed: string[];
  expanded: string[];
} {
  const resultText = serializeToolValue(call.result);
  const model: ToolRenderModel = {
    kind: call.name,
    status: 'success',
    summary: `result (${resultText.length} chars)`,
    bodyLines: [
      'Arguments:',
      ...serializeToolValue(call.args).split('\n'),
      'Result:',
      ...resultText.split('\n'),
    ],
  };
  return {
    collapsed: [muted(`${brainIcon} tool: ${call.name} — result (${resultText.length} chars)`)],
    expanded: renderToolBlock(model, blockMaxLines),
  };
}

function genericBlockMaxLines(toolRendering: unknown): number {
  if (
    toolRendering
    && typeof toolRendering === 'object'
    && 'blockMaxLines' in toolRendering
    && typeof toolRendering.blockMaxLines === 'number'
    && Number.isFinite(toolRendering.blockMaxLines)
    && toolRendering.blockMaxLines > 0
  ) {
    return toolRendering.blockMaxLines;
  }
  return 20;
}

function genericFoldMode(toolRendering: unknown): FoldMode | undefined {
  if (
    toolRendering
    && typeof toolRendering === 'object'
    && 'foldMode' in toolRendering
    && (toolRendering.foldMode === 'line'
      || toolRendering.foldMode === 'task-unit'
      || toolRendering.foldMode === 'kind-unit')
  ) {
    return toolRendering.foldMode;
  }
  return undefined;
}

/** Merge an explicit fold mode into the collapsed tool-render config.
 *  Omitted mode returns `toolRendering` unchanged so the renderer keeps
 *  its `'line'` default. */
function collapsedToolRenderConfig(
  toolRendering: unknown,
  foldMode?: FoldMode,
): unknown {
  const resolved = foldMode ?? genericFoldMode(toolRendering);
  if (resolved === undefined) return toolRendering;
  if (genericFoldMode(toolRendering) === resolved) return toolRendering;
  if (toolRendering && typeof toolRendering === 'object') {
    return { ...(toolRendering as Record<string, unknown>), foldMode: resolved };
  }
  return { foldMode: resolved };
}

export interface TurnStreamCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
}

export interface TurnStreamFormatterDeps {
  /** Sole side-effect channel — formatter 는 이 함수만으로 외부와
   *  소통. applier 가 받아 chatLines mutation. */
  emit(event: TurnStreamPresentationEvent): void;
  thinking: {
    update(label: string): void;
    updateMetrics(metrics: { outputTokens: number }): void;
  };
  termCols: () => number;
  // chat.rendering.wrap 는 boolean 이 아니라 wrap 옵션 오브젝트로 이관됨.
  wrapOpts: { urlAware?: boolean };
  formatResponse: (full: string, width: number, wrapOpts?: { urlAware?: boolean }) => string[];
  text: (line: string) => string;
  muted: (text: string) => string;
  ptyCallLine: (name: string, args: Record<string, unknown>) => string | null;
  ptyResultLine: (name: string, result: unknown) => string | null;
  // method 문법(bivariant) — 구체 renderToolCallEvent(call: ToolRenderCall …) /
  // renderToolResultVariants(call: ToolRenderResult …) 를 수용. TurnStreamCall 은
  // ToolRenderCall 의 superset·ToolRenderResult 는 TurnStreamCall 의 subset 이라
  // 호출은 안전(변이만 정합).
  renderToolCallEvent(call: TurnStreamCall, rendering: unknown): string[] | null;
  renderToolResultVariants(call: TurnStreamCall, rendering: unknown): {
    collapsed: string[];
    expanded: string[] | null;
    operationKind?: string;
  } | null;
  toolRendering: unknown;
  /** Fold strategy forwarded into collapsed tool-render config.
   *  Omitted = renderer default `'line'` (current behavior). */
  foldMode?: FoldMode;
  brainIcon: string;
}

export interface TurnStreamFormatter {
  onText(chunk: string, accumulated: string): void;
  onToolCall(call: TurnStreamCall): void;
  onToolResult(call: TurnStreamCall): void;
}

export function createTurnStreamFormatter(
  deps: TurnStreamFormatterDeps,
): TurnStreamFormatter {
  // Per-tool-round 누적기. cross-turn 에서 이전 round 의 텍스트를
  // 가져오지 않음. clear-and-commit (onText('', '')) 또는 tool call
  // 발생 시 reset.
  let perRoundText = '';
  let committedChars = 0;
  const closeRound = (): void => {
    committedChars += perRoundText.length;
    perRoundText = '';
  };
  // formatter 의 local view of tool args (pre-refactor 의 renderedToolRuntime.
  // setArgs/getArgs/deleteArgs 와 동등). result 시점에 args 를 다시 알기
  // 위해 보유. applier 는 별도로 own renderedToolRuntime 에 setArgs/
  // deleteArgs 를 호출 — formatter 는 자기 view 로만.
  const toolArgsByCallId = new Map<string, Record<string, unknown>>();
  const nonGenericCallIds = new Set<string>();
  let toolCallCount = 0;

  const emitAssistantBlock = (): void => {
    deps.thinking.update('Streaming');
    deps.thinking.updateMetrics({ outputTokens: Math.ceil((committedChars + perRoundText.length) / 4) });
    const formatted = trimBlankEdges(
      deps.formatResponse(perRoundText, deps.termCols() - 6, deps.wrapOpts),
    );
    if (debug.enabled) {
      // 구조 정보만 — content (perRoundText prefix 등) 는 production
      // 로그에 노출 안 함.
      debug.log('dashboard.chat.stream', 'formatter.assistant.replaceBlock', {
        perRoundLen: perRoundText.length,
        formattedLineCount: formatted.length,
      });
    }
    deps.emit({
      type: 'assistant.replaceBlock',
      lines: formatted.map(deps.text),
    });
  };

  return {
    onText(chunk: string, accumulated: string): void {
      // 3-path semantic — see TurnStreamPresentationEvent comments.
      if (chunk === '' && accumulated === '') {
        // Path 1 — clear-and-commit. narration 영구 보존, applier 가
        // assistantStart advance.
        if (debug.enabled) {
          debug.log('dashboard.chat.stream', 'formatter.commitOnClear', {
            perRoundLen: perRoundText.length,
          });
        }
        closeRound();
        deps.emit({ type: 'assistant.commit' });
        return;
      }
      if (chunk === '') {
        // Path 2 — authoritative replacement (W5-E/F/G force-synthesis).
        perRoundText = accumulated;
      } else {
        // Path 3 — streaming delta. accumulated 무시 (cross-turn fullText).
        perRoundText += chunk;
      }
      if (debug.enabled) {
        debug.log('dashboard.chat.stream', 'formatter.onText', {
          chunkLen: chunk.length,
          accumulatedLen: accumulated.length,
          perRoundLen: perRoundText.length,
          mode: chunk === '' ? 'replace' : 'append',
        });
      }
      emitAssistantBlock();
    },
    onToolCall(call: TurnStreamCall): void {
      toolCallCount += 1;
      deps.thinking.update(`Streaming ${call.name} (${toolCallCount} ${toolCallCount === 1 ? 'tool' : 'tools'})`);
      const ptyLine = deps.ptyCallLine(call.name, call.args);
      if (ptyLine) {
        nonGenericCallIds.add(call.id);
        deps.emit({ type: 'tool.appendLine', callId: call.id, line: ptyLine });
        closeRound();
        return;
      }
      const rendered = deps.renderToolCallEvent(call, deps.toolRendering);
      if (rendered) {
        nonGenericCallIds.add(call.id);
        toolArgsByCallId.set(call.id, call.args);
        deps.emit({
          type: 'tool.appendBlock',
          callId: call.id,
          lines: rendered,
          args: call.args,
          ...(deps.foldMode === 'kind-unit'
            ? { operationKind: toolOperationKind(call.name, call.args) }
            : {}),
        });
        closeRound();
        return;
      }
      // Generic fallback — retain an unrecognised call as a replaceable block so
      // its result follows the same folded path as renderer-supported tools.
      toolArgsByCallId.set(call.id, call.args);
      deps.emit({
        type: 'tool.appendBlock',
        callId: call.id,
        lines: [deps.muted(`${deps.brainIcon} tool: ${call.name} — running`)],
        args: call.args,
        ...(deps.foldMode === 'kind-unit'
          ? { operationKind: toolOperationKind(call.name, call.args) }
          : {}),
      });
      debug.log('dashboard.chat.generic-tool', 'formatter.genericCall', { toolName: call.name });
      closeRound();
    },
    onToolResult(call: TurnStreamCall): void {
      const ptySummary = deps.ptyResultLine(call.name, call.result);
      if (ptySummary) {
        nonGenericCallIds.delete(call.id);
        deps.emit({ type: 'tool.appendLine', callId: call.id, line: ptySummary });
        closeRound();
        return;
      }
      const args = toolArgsByCallId.get(call.id) ?? {};
      const rendered = deps.renderToolResultVariants(
        { id: call.id, name: call.name, args, result: call.result },
        collapsedToolRenderConfig(deps.toolRendering, deps.foldMode),
      );
      if (!rendered && nonGenericCallIds.delete(call.id)) {
        closeRound();
        return;
      }
      const variants = rendered ?? genericResultVariants(
        { id: call.id, name: call.name, args, result: call.result },
        deps.brainIcon,
        deps.muted,
        genericBlockMaxLines(deps.toolRendering),
      );
      if (!rendered) {
        debug.log('dashboard.chat.generic-tool', 'formatter.genericResult', { toolName: call.name });
      }
      deps.emit({
        type: 'tool.replaceBlock',
        callId: call.id,
        collapsedLines: variants.collapsed,
        expandedLines: variants.expanded,
        ...(deps.foldMode === 'kind-unit'
          ? { operationKind: ('operationKind' in variants ? variants.operationKind : undefined) ?? toolOperationKind(call.name, args) }
          : {}),
      });
      toolArgsByCallId.delete(call.id);
      nonGenericCallIds.delete(call.id);
      closeRound();
    },
  };
}
