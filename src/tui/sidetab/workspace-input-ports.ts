import type { SidetabRow } from '../../sidetab-core/model.js';
import type { WorkspacePtyTarget } from '../../sidetab-core/workspace-input.js';
import type { SidetabAttachmentController } from './attach.js';
import { createWorkspaceSidechatRuntime } from './sidechat-session.js';
import { createWorkspaceTerminalWriter } from './workspace-terminal-writer.js';
import type { WorkspaceInputPorts } from './workspace-input-controller.js';

/** The entry supplies its live rows and takeover writer; chat stays in a separate session. */
export function createWorkspaceInputPorts(deps: {
  rows(): readonly SidetabRow[];
  attachments: Pick<SidetabAttachmentController, 'observeSidechat'>;
  sendTerminal?(target: WorkspacePtyTarget, text: string): Promise<boolean>;
  sidechat?: Pick<ReturnType<typeof createWorkspaceSidechatRuntime>, 'send'>;
}): WorkspaceInputPorts {
  const sidechat = deps.sidechat ?? createWorkspaceSidechatRuntime();
  const terminal = deps.sendTerminal ?? createWorkspaceTerminalWriter().send;
  return {
    rows: deps.rows,
    observe: async (target) => deps.attachments.observeSidechat(target),
    sendTerminal: terminal,
    sendSidechat: (input) => sidechat.send(input),
  };
}
