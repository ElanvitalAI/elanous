import { bootDashboardAcpSession } from './acp-boot.js';
import { runDashboardChatMainPlainTurn } from './input/chat-main-plain-turn-runtime.js';
import { createDashboardTurnAutoheal } from './input/turn-autoheal.js';
import type { Tui400Runtime } from '../ux-sim/tui-400-runtime-contract.js';

/** Uses the same production functions as the classic dashboard turn. */
export const dashboardTui400Runtime: Tui400Runtime = {
  boot: (deps) => bootDashboardAcpSession(deps as Parameters<typeof bootDashboardAcpSession>[0]),
  runPlainTurn: (deps) => runDashboardChatMainPlainTurn(deps as Parameters<typeof runDashboardChatMainPlainTurn>[0]),
  createAutoheal: (deps) => createDashboardTurnAutoheal(deps as Parameters<typeof createDashboardTurnAutoheal>[0]),
};
