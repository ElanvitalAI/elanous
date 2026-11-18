// HERDR-C1-AGENT-BADGE (seat-state/UX/HERDR-REPLACE-AUDIT-1117.md §C1-①): an agent row in the sidetab says what the
// agent is doing — working, idle, blocked (a person must answer), waiting or done — the way herdr's pane list shows
// agent_status. The state is the same one `elanous pty state` reports: the screen classifier (herdr rules) folded with
// the turn the PTY wrote for itself. Nothing here writes to the PTY.
import { classifyFrameState, reconcileFrameStateWithTurn, type FrameState } from '../../capture/frame-state-detect.js';
import type { PtyManifestRow } from '../../pty-shell/pty-manifest.js';
import { ptyTurnViewOfRow } from '../../pty-shell/tui-run-state.js';
import type { SidetabAgentState, SidetabRow } from '../../sidetab-core/model.js';

/** Row kinds that are agent conversations (coding agents and their CLIs). */
export const AGENT_SIDETAB_KINDS: readonly string[] = ['agent', 'coding-agent', 'codex', 'claude', 'claude-code', 'grok', 'hermes'];

export const isAgentSidetabRow = (row: Pick<SidetabRow, 'kind'>): boolean => AGENT_SIDETAB_KINDS.includes(row.kind);

/** The `pty state` verdict for one manifest row; `unknown` when the screen gives no signal and no turn was written. */
export function agentPtyState(row: Pick<PtyManifestRow, 'alive' | 'turnState' | 'turnAt' | 'snapshot' | 'frame'>): FrameState {
  const screen = classifyFrameState(row.snapshot || row.frame || '').state;
  return reconcileFrameStateWithTurn(screen, ptyTurnViewOfRow(row).turn).state;
}

/**
 * Agent rows carry `agentState` from their manifest row; other rows are returned unchanged. A row whose process is
 * gone (exited) or stale keeps its process badge: a screen left behind says nothing about what the agent does now.
 */
export function withAgentStates<T extends SidetabRow>(rows: readonly T[], manifest: ReadonlyMap<string, PtyManifestRow>): T[] {
  return rows.map((row) => {
    const source = manifest.get(row.ptyId ?? row.id);
    if (!source || !isAgentSidetabRow(row) || row.badge === 'exited' || row.badge === 'stale') return row;
    const state = agentPtyState(source);
    return state === 'unknown' ? row : { ...row, agentState: state satisfies SidetabAgentState };
  });
}
