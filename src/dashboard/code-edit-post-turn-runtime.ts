import type { SourceDeltaTurnSnapshot } from '../code-edit/index.js';

export interface DashboardCodeEditPostTurnRuntimeDeps {
  pushChatLine: (line: string) => void;
  setChatScrollBottom: () => void;
  importCodeEdit: () => Promise<{
    getSourceDeltaManager: () => { endTurn: () => SourceDeltaTurnSnapshot | null };
    renderSourceDeltaTurnSummary: (turn: SourceDeltaTurnSnapshot | null) => string[];
    getTurnDiffTracker: () => { endTurn: () => void };
  }>;
  importUndoTurn: () => Promise<{
    endTurn: () => void;
  }>;
}

export async function runDashboardCodeEditPostTurn(
  deps: DashboardCodeEditPostTurnRuntimeDeps,
): Promise<void> {
  try {
    const { getSourceDeltaManager, renderSourceDeltaTurnSummary } = await deps.importCodeEdit();
    const turn = getSourceDeltaManager().endTurn();
    const rows = renderSourceDeltaTurnSummary(turn);
    for (const row of rows) deps.pushChatLine(row);
    if (rows.length > 0) deps.setChatScrollBottom();
  } catch {
    // non-fatal
  }

  try {
    const { getTurnDiffTracker } = await deps.importCodeEdit();
    getTurnDiffTracker().endTurn();
  } catch {
    // non-fatal
  }

  try {
    const { endTurn } = await deps.importUndoTurn();
    endTurn();
  } catch {
    // non-fatal
  }
}
