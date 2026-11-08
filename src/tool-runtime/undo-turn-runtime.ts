import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── UndoTurn runtime (UT3) ──
//
// LLM-facing tool that restores the most recent ghost-commit
// snapshot, or a specified one. Dashboard-only + permission-safety
// (matches SetWorkingDir / EnterWorktree) — the user must approve
// before a restore overwrites their working tree.
//
// Destructive by design: a restore can wipe uncommitted changes.
// That's the whole point — the user asked to undo the turn.


import {
  findSnapshotById,
  peekSnapshot,
  dropFromSnapshot,
  restoreSnapshot,
  listSnapshots,
  type Snapshot,
} from '../undo-turn/index.js';
import type { ToolRuntime } from './types.js';

function buildSpec(): LLMToolSpec {
  return {
    name: 'UndoTurn',
    description:
      'Restore the working tree to a ghost-commit snapshot taken at the start of a recent turn. ' +
      'Without `snapshotId`, restores the most recent snapshot (single step undo). With ' +
      '`snapshotId`, restores the identified one AND drops every later snapshot (so repeated ' +
      'undo doesn\'t resurrect states that were themselves undone). Destructive — overwrites the ' +
      'current working tree from git; the user\'s index (git add) is preserved, new untracked ' +
      'files added since the snapshot are deleted.',
    parameters: {
      type: 'object',
      properties: {
        snapshotId: {
          type: 'string',
          description:
            'Short id (8-hex) or full/prefix commit SHA from a previous listSnapshots call. ' +
            'Omit to restore the most recent snapshot.',
        },
      },
      additionalProperties: false,
    },
  };
}

export interface UndoTurnResult {
  output: string;
  restoredId: string;
  restoredSha: string;
  untrackedRemoved: number;
  snapshotsDropped: number;
}

function targetSnapshot(reqId?: string): Snapshot | null {
  if (reqId && reqId.trim()) return findSnapshotById(reqId.trim());
  return peekSnapshot();
}

export const undoTurnRuntime: ToolRuntime<Record<string, unknown>, UndoTurnResult> = {
  id: 'undo_turn',
  spec: buildSpec(),
  async run(req): Promise<UndoTurnResult> {
    const list = listSnapshots();
    if (list.length === 0) throw new Error('UndoTurn: no snapshots available');
    const reqId = typeof req.snapshotId === 'string' ? req.snapshotId : undefined;
    const target = targetSnapshot(reqId);
    if (!target) {
      throw new Error(
        reqId
          ? `UndoTurn: no snapshot matches "${reqId}" — call ListSnapshots first`
          : 'UndoTurn: no snapshots available',
      );
    }
    const result = restoreSnapshot(target);
    if (!result.ok) {
      throw new Error(`UndoTurn: ${result.error ?? 'restore failed'}`);
    }
    // Drop the restored snapshot + everything after so the next
    // /undo steps one further back, not to an already-undone state.
    const dropped = dropFromSnapshot(target.id);
    return {
      output: `✓ undone — ${result.summary} (dropped ${dropped} snapshot${dropped === 1 ? '' : 's'} from history)`,
      restoredId: target.id,
      restoredSha: target.sha,
      untrackedRemoved: result.untrackedRemoved,
      snapshotsDropped: dropped,
    };
  },
};
