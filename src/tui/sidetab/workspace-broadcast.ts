import type { SidetabRow } from '../../sidetab-core/model.js';
import type { WorkspacePtyTarget } from '../../sidetab-core/workspace-input.js';

export interface WorkspaceBroadcastPorts {
  rows(): readonly SidetabRow[];
  /** Must enforce takeover and the same concrete PTY identity before writing. */
  sendTerminal(target: WorkspacePtyTarget, text: string): Promise<boolean>;
}

export interface WorkspaceBroadcastResult {
  readonly sent: number;
  readonly total: number;
  /** An exception may mean the last PTY received bytes before its release failed. */
  readonly outcome: 'complete' | 'rejected' | 'unknown';
}

/** Validate the whole explicit set before the first PTY write. Delivery is sequential, not atomic. */
export function createWorkspaceBroadcast(ports: WorkspaceBroadcastPorts) {
  return {
    async send(spaceId: string, targets: readonly WorkspacePtyTarget[], text: string): Promise<WorkspaceBroadcastResult> {
      if (!spaceId.trim() || !text.trim() || targets.length === 0) throw new Error('workspace broadcast needs a space, targets, and input');
      const rows = ports.rows();
      const seen = new Set<string>();
      for (const target of targets) {
        if (target.spaceId !== spaceId || seen.has(target.rowId)) throw new Error('workspace broadcast target set is invalid');
        seen.add(target.rowId);
        const live = rows.find((row) => row.id === target.rowId && row.spaceId === spaceId
          && row.ptyId === target.ptyId && row.remoteHost === target.remoteHost
          && row.ownerPid === target.ownerPid && row.ptyStartedAt === target.ptyStartedAt
          && row.badge !== 'exited' && !row.currentProcess);
        if (!live) throw new Error('workspace broadcast target changed; select it again');
      }
      let sent = 0;
      for (const target of targets) {
        // Earlier PTYs may already have received this input. Preserve that
        // count even when a later takeover writer rejects with an exception.
        try {
          if (!await ports.sendTerminal(target, text)) return { sent, total: targets.length, outcome: 'rejected' };
        } catch {
          return { sent, total: targets.length, outcome: 'unknown' };
        }
        sent++;
      }
      return { sent, total: targets.length, outcome: 'complete' };
    },
  };
}
