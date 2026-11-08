#!/usr/bin/env bun

import { CHAT_DEFAULTS } from '../src/user-config/chat.js';
import { renderToolResultVariants } from '../src/chat/tool-render/index.js';
import { resolveToolBlockLineBudget } from '../src/chat/tool-render/block.js';
import type { ToolRenderName } from '../src/chat/tool-render/types.js';
import { FOLD_LIMITS, renderLogEntry } from '../src/log-entry.js';

type DisplayLineMeasurement = {
  path: 'chat-tool-render' | 'skill-runtime';
  toolName: string;
  inputLines: number;
  collapsedLines: number;
  truncated: boolean;
  winningConstant: string | null;
};

// ⛔⭐⭐⭐ 종전엔 여기에 `CHAT_DEFAULTS.toolOutput.previewLines` 가 들어 있었다 — **다른 노브다**
//    (2026-08-02 실측). 둘은 서로 다른 층을 정한다:
//      chat.toolOutput.previewLines      … **영속 임계**(줄 수). 넘으면 파일로 빠지고
//                                            화면엔 앞 previewLines 줄 + 참조 한 줄만 남는다.
//      chat.rendering.tool.blockMaxLines … **렌더 상한**. 남은 몸통을 몇 줄까지 그릴지.
//    ⚠️ 코드 기본값이 **둘 다 8** 이고 운영 config 도 **둘 다 20** 이라, 바꿔 넣어도
//       산출이 같아 **결함이 안 보였다**. 한쪽만 바꾸는 순간 이 스크립트가 거짓말을 한다.
/** ⭐ 어느 상수를 읽는지를 **주입 가능한 자리**로 뽑는다 — 두 기본값이 같으면 값 비교로는
 *  회귀를 못 잡으므로, 테스트가 서로 다른 값을 넣어 **읽는 필드**를 확인할 수 있어야 한다
 *  (무인 리뷰 must-fix · 2026-08-02). */
export function resolveMeasureRenderConfig(defaults: {
  rendering: { tool: { blockMaxLines: number } };
}): { displayMode: 'inline-to-block'; blockMaxLines: number } {
  return {
    displayMode: 'inline-to-block',
    blockMaxLines: defaults.rendering.tool.blockMaxLines,
  };
}

const chatRenderConfig = resolveMeasureRenderConfig(CHAT_DEFAULTS);

function outputOfLines(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => `result line ${index + 1}`).join('\n');
}

export function chatWinningConstant(toolName: ToolRenderName, truncated: boolean): string | null {
  // `null` is legitimate only when the input fits the renderer budget: no fold
  // happened, so there is no winning truncation constant to attribute.
  if (!truncated) return null;
  const budget = resolveToolBlockLineBudget(
    { kind: toolName, status: 'success', summary: '', bodyLines: [] },
    chatRenderConfig.blockMaxLines,   // ⭐ 출처를 단일화 — resolver 와 라벨이 다시 어긋나지 않게
  );
  return budget.source === 'listing'
    ? `LISTING_TOOL_MAX_LINES (${budget.maxLines})`
    : `CHAT_DEFAULTS.rendering.tool.blockMaxLines (${budget.maxLines})`;
}

export function measureChatToolDisplay(toolName: ToolRenderName, inputLines: number): DisplayLineMeasurement {
  const variants = renderToolResultVariants({
    id: `measure-${toolName}-${inputLines}`,
    name: toolName,
    args: toolName === 'Glob' ? { pattern: '**/*', path: '.' } : { command: 'printf measure' },
    result: { output: outputOfLines(inputLines) },
  }, chatRenderConfig);
  if (!variants) throw new Error(`Unsupported tool for display measurement: ${toolName}`);
  // `expandHint` is optional: a count-only fold hint still means the renderer
  // truncated the body, even when rich-mode wording is absent.
  const truncated = variants.collapsed.some((line) => line.includes('more line') && line.includes('folded'));
  return {
    path: 'chat-tool-render',
    toolName,
    inputLines,
    collapsedLines: variants.collapsed.length,
    truncated,
    winningConstant: chatWinningConstant(toolName, truncated),
  };
}

export function measureSkillRuntimeDisplay(inputLines: number): DisplayLineMeasurement {
  const collapsed = renderLogEntry({ kind: 'tool-body', text: outputOfLines(inputLines) });
  // Skill-runtime uses the same optional rich suffix; count-only fold hints
  // remain evidence that FOLD_LIMITS.TOOL_BODY truncated the body.
  const truncated = collapsed.some((line) => line.includes('more line') && line.includes('folded'));
  return {
    path: 'skill-runtime',
    toolName: 'tool-body',
    inputLines,
    collapsedLines: collapsed.length,
    truncated,
    winningConstant: truncated ? `FOLD_LIMITS.TOOL_BODY (${FOLD_LIMITS.TOOL_BODY})` : null,
  };
}

function formatMeasurement(measurement: DisplayLineMeasurement): string {
  return [
    measurement.path,
    measurement.toolName,
    `input=${measurement.inputLines}`,
    `collapsed=${measurement.collapsedLines}`,
    `truncated=${measurement.truncated}`,
    `winner=${measurement.winningConstant ?? 'none (input fits)'}`,
  ].join(' | ');
}

function main(): void {
  console.log('# Tool display-line measurements');
  console.log('# collapsedLines is the existing renderer-returned array length; chat rows include the tool header.');
  for (const inputLines of [3, 20, 80]) {
    console.log(formatMeasurement(measureChatToolDisplay('Bash', inputLines)));
    console.log(formatMeasurement(measureChatToolDisplay('Glob', inputLines)));
    console.log(formatMeasurement(measureSkillRuntimeDisplay(inputLines)));
  }
}

if (import.meta.main) main();
