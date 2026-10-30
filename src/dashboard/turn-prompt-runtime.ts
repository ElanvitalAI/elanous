import {
  buildPromptInjection,
  classifyUserIntents,
  renderPromptInjectionForUser,
  type PromptBankStore,
} from '../prompt-bank/index.js';
import {
  resolveSessionTurnProfileWithHistory,
  type SessionTurnProfile,
} from '../session-runtime/index.js';
import type { InputSourceRef } from '../input/input-source-kind.js';
import type { ChatModeState } from '../session-runtime/posture.js';
import type { PromptRuntimeState } from '../prompt-bank/types.js';

export interface DashboardTurnPromptBankConfig {
  enabled: boolean;
  dashboardTurns: boolean;
  budgetTokens: number;
  limit: number;
  record: boolean;
}

export interface DashboardTurnPromptRuntimeDeps {
  promptBankConfig: DashboardTurnPromptBankConfig;
  chatModeState: ChatModeState;
  buildPromptRuntimeState: (intents: string[]) => PromptRuntimeState;
  getPromptBankStore: () => PromptBankStore;
  inspectActiveProvider: () => { model: string };
  getActivePluginName: () => string | undefined;
}

export interface DashboardTurnPromptRuntimeResult {
  promptBankContext: string;
  turnProfile: SessionTurnProfile;
}

export function buildDashboardTurnPromptRuntime(
  userText: string,
  turnId: string,
  deps: DashboardTurnPromptRuntimeDeps,
  inputSource?: InputSourceRef | null,
  priorUserTexts: readonly string[] = [],
): DashboardTurnPromptRuntimeResult {
  const turnIntents = ['chat', ...classifyUserIntents(userText)];
  const promptBankInjection = deps.promptBankConfig.enabled && deps.promptBankConfig.dashboardTurns
    ? buildPromptInjection({
        store: deps.getPromptBankStore(),
        state: deps.buildPromptRuntimeState(turnIntents),
        options: {
          model: deps.inspectActiveProvider().model,
          activePlugin: deps.getActivePluginName(),
          budgetTokens: deps.promptBankConfig.budgetTokens,
          limit: deps.promptBankConfig.limit,
          record: deps.promptBankConfig.record,
          turnId,
          metadata: { source: 'dashboard.chat' },
        },
      })
    : null;
  const promptBankContext = promptBankInjection
    ? renderPromptInjectionForUser(promptBankInjection, {
        includeAuditLine: true,
        slots: ['context', 'tool-hint', 'user-prefix'],
      })
    : '';
  const turnProfile = resolveSessionTurnProfileWithHistory({
    userText,
    priorUserTexts,
    chatModeState: deps.chatModeState,
    inputSource,
  });
  return {
    promptBankContext,
    turnProfile,
  };
}
