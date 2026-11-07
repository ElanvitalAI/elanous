import type { NormalizedAttachment } from '../../acp/content-blocks.js';
import { classifyInterimReply, formatInterimFoldLine } from '../../tui/chat/goal-interim.js';
import {
  displayBackendName,
  type AcpBackendId,
  type AcpChatHandlers,
} from '../chat/acp-chat.js';

export interface DashboardChatMainAcpDispatchDeps {
  dashboardAcpChat: {
    send: (
      backend: AcpBackendId,
      message: string,
      handlers: AcpChatHandlers,
      attachments?: NormalizedAttachment[],
    ) => Promise<void>;
  };
  backend: AcpBackendId;
  message: string;
  attachments: NormalizedAttachment[];
  debugEnabled: boolean;
  chatLines: string[];
  setChatScrollToTail: () => void;
  redraw: () => void;
  formatAssistantLines: (text: string) => string[];
  formatUserLine: (display: string, message: string) => string;
  formatMutedLine: (line: string) => string;
  formatToolLine: (tool: string) => string;
  formatDebugLine: (display: string, reason: string, chars: number) => string;
  formatErrorLine: (display: string, message: string) => string;
  formatAssistantPrefix: (display: string) => string;
}

export function dispatchDashboardChatMainAcpSend(
  deps: DashboardChatMainAcpDispatchDeps,
): void {
  const display = displayBackendName(deps.backend);
  deps.chatLines.push(deps.formatUserLine(display, deps.message));
  deps.setChatScrollToTail();

  let accumulated = '';
  let firstChunk = true;
  let assistantTextActive = false;
  let assistantBodyStart = -1;
  let assistantBodyEnd = -1;
  const interimBodyRanges: Array<{ start: number; end: number }> = [];
  let assistantBodyText = '';
  let assistantRunUsesPrefix = false;

  void deps.dashboardAcpChat.send(deps.backend, deps.message, {
    pushLine: (line) => {
      deps.chatLines.push(deps.formatMutedLine(line));
      deps.setChatScrollToTail();
      assistantTextActive = false;
    },
    appendChunk: (delta) => {
      if (!assistantTextActive) {
        assistantRunUsesPrefix = firstChunk;
        if (firstChunk) firstChunk = false;
        assistantBodyText = '';
        assistantBodyStart = -1;
        assistantBodyEnd = -1;
        assistantTextActive = true;
      }
      assistantBodyText += delta;
      accumulated += delta;
      const rendered = deps.formatAssistantLines(assistantBodyText);
      if (assistantBodyStart < 0) assistantBodyStart = deps.chatLines.length;
      deps.chatLines.splice(assistantBodyStart, Math.max(0, assistantBodyEnd - assistantBodyStart));
      rendered.forEach((line, index) => {
        if (index === 0 && assistantRunUsesPrefix) {
          deps.chatLines.push(`${deps.formatAssistantPrefix(display)} ${line}`);
        } else {
          deps.chatLines.push(`  ${line}`);
        }
      });
      assistantBodyEnd = assistantBodyStart + rendered.length;
      if (interimBodyRanges.at(-1)?.start === assistantBodyStart) interimBodyRanges[interimBodyRanges.length - 1]!.end = assistantBodyEnd;
      else interimBodyRanges.push({ start: assistantBodyStart, end: assistantBodyEnd });
      deps.setChatScrollToTail();
    },
    replaceText: (fullText) => {
      const insertionIndex = interimBodyRanges.length > 0
        ? Math.min(...interimBodyRanges.map((range) => range.start))
        : deps.chatLines.length;
      for (const { start, end } of [...interimBodyRanges].reverse()) {
        deps.chatLines.splice(start, end - start);
      }
      interimBodyRanges.length = 0;
      accumulated = fullText;
      firstChunk = false;
      assistantTextActive = true;
      assistantRunUsesPrefix = true;
      assistantBodyText = fullText;
      assistantBodyStart = insertionIndex;
      const rendered = deps.formatAssistantLines(fullText);
      rendered.forEach((line, index) => {
        deps.chatLines.splice(insertionIndex + index, 0,
          index === 0 ? `${deps.formatAssistantPrefix(display)} ${line}` : `  ${line}`);
      });
      assistantBodyEnd = insertionIndex + rendered.length;
      interimBodyRanges.push({ start: insertionIndex, end: assistantBodyEnd });
      deps.setChatScrollToTail();
    },
    foldGoalInterim: (text) => {
      const verdict = classifyInterimReply(text.split('\n'));
      if (verdict.interim && interimBodyRanges.length > 0) {
        const first = interimBodyRanges[0]!.start;
        for (const { start, end } of [...interimBodyRanges].reverse()) deps.chatLines.splice(start, end - start);
        deps.chatLines.splice(first, 0, `  ${formatInterimFoldLine(verdict.summary)}`);
        deps.setChatScrollToTail();
      }
      interimBodyRanges.length = 0;
      assistantTextActive = false;
      assistantBodyStart = -1;
      assistantBodyEnd = -1;
    },
    pushToolCall: (tool) => {
      deps.chatLines.push(deps.formatToolLine(tool));
      deps.setChatScrollToTail();
      assistantTextActive = false;
    },
    onDone: (reason) => {
      if (deps.debugEnabled) {
        deps.chatLines.push(deps.formatDebugLine(display, reason, accumulated.length));
      }
      deps.setChatScrollToTail();
      deps.redraw();
    },
    onError: (err) => {
      deps.chatLines.push(deps.formatErrorLine(display, err.message));
      deps.setChatScrollToTail();
      deps.redraw();
    },
    redraw: deps.redraw,
  }, deps.attachments);
}
