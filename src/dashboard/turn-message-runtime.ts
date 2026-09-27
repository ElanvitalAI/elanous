import { C } from '../tui.js';
import { buildMessagesWithContext } from '../llm.js';
import { expandPromptReferences } from '../prompt/references.js';
import type { ContextRegistry } from '../context.js';
import type { ChatMessage } from '../chat/index.js';

export interface DashboardTurnBlockAttachLike {
  banner(): string | null;
  consume(userMessage: string): string;
}

export interface DashboardTurnMessageRuntimeDeps {
  userText: string;
  promptBankContext: string;
  contextText: string;
  contextRegistry: ContextRegistry;
  terminalRegistry: unknown;
  blockAttach: DashboardTurnBlockAttachLike;
  pushChatLine: (line: string) => void;
}

export interface DashboardTurnMessageRuntimeResult {
  expandedQuestion: string;
  questionWithBlock: string;
  questionBody: string;
  turn: ReturnType<typeof buildMessagesWithContext>;
  userMsg: ChatMessage;
}

export function buildDashboardTurnMessage(
  deps: DashboardTurnMessageRuntimeDeps,
): DashboardTurnMessageRuntimeResult {
  const expandedQuestion = expandPromptReferences(deps.userText, {
    terminalRegistry: deps.terminalRegistry as never,
  });
  const attachedBanner = deps.blockAttach.banner();
  if (attachedBanner) deps.pushChatLine(C.muted(`  ${attachedBanner}`));
  const questionWithBlock = deps.blockAttach.consume(expandedQuestion);
  const questionBody = [
    deps.promptBankContext,
    `Context:\n${deps.contextText}\n\nQuestion: ${questionWithBlock}`,
  ].filter(Boolean).join('\n\n');
  const turn = buildMessagesWithContext(questionBody, deps.contextRegistry);
  const userMsg = turn[turn.length - 1]! as ChatMessage;
  return {
    expandedQuestion,
    questionWithBlock,
    questionBody,
    turn,
    userMsg,
  };
}
