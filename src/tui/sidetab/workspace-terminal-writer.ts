import type { WorkspacePtyTarget } from '../../sidetab-core/workspace-input.js';
import { requestRemotePtyControl } from '../../pty-shell/pty-control-ipc.js';
import { listPtyManifestRows } from '../../pty-shell/pty-manifest.js';

type Action = 'takeover' | 'input-text' | 'release';
type ControlResult = { readonly status: string };

export class WorkspaceTerminalOutcomeUnknownError extends Error {
  readonly code = 'WORKSPACE_TERMINAL_OUTCOME_UNKNOWN';
  constructor() { super('workspace PTY outcome unknown after takeover; inspect before retry'); }
}

export interface WorkspaceTerminalWriterPorts {
  current(ptyId: string): { readonly ownerPid: number; readonly startedAt: number; readonly alive: boolean } | undefined;
  control(ptyId: string, action: Action, payload?: { chars: string }): Promise<ControlResult>;
}

/** Human takeover for one exact local PTY lifetime; no direct preview.write fallback. */
export function createWorkspaceTerminalWriter(ports: WorkspaceTerminalWriterPorts = {
  current: (ptyId) => listPtyManifestRows().find((row) => row.id === ptyId),
  control: (ptyId, action, payload) => requestRemotePtyControl(ptyId, action, payload, { timeoutMs: 1_500, actor: 'human' }),
}) {
  const sameLifetime = (target: WorkspacePtyTarget): boolean => {
    const row = ports.current(target.ptyId);
    return !!row?.alive && row.ownerPid === target.ownerPid && row.startedAt === target.ptyStartedAt;
  };
  return {
    async send(target: WorkspacePtyTarget, text: string): Promise<boolean> {
      if (target.remoteHost || !target.ptyId || !Number.isSafeInteger(target.ownerPid)
        || target.ownerPid <= 0 || !Number.isSafeInteger(target.ptyStartedAt)
        || target.ptyStartedAt <= 0 || !text.trim() || text.includes('\0')
        || !sameLifetime(target)) return false;
      const takeover = await ports.control(target.ptyId, 'takeover');
      if (takeover.status !== 'success') return false;
      try {
        if (!sameLifetime(target)) return false;
        try {
          const input = await ports.control(target.ptyId, 'input-text', { chars: text + '\r' });
          if (input.status !== 'success') throw new WorkspaceTerminalOutcomeUnknownError();
          return true;
        } catch {
          // A failed acknowledgement does not prove the PTY received no bytes.
          throw new WorkspaceTerminalOutcomeUnknownError();
        }
      } finally {
        try {
          const release = await ports.control(target.ptyId, 'release');
          if (release.status !== 'success') throw new WorkspaceTerminalOutcomeUnknownError();
        } catch {
          throw new WorkspaceTerminalOutcomeUnknownError();
        }
      }
    },
  };
}
