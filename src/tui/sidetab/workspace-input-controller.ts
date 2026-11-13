import type { SidetabRow } from '../../sidetab-core/model.js';
import {
  bindWorkspacePty, createWorkspaceInputState,
  prepareWorkspaceInput, selectWorkspaceInput, setWorkspaceInputDraft,
  type CompleteTerminalObservation, type WorkspaceInputMode, type WorkspaceInputState,
  type WorkspacePtyTarget,
} from '../../sidetab-core/workspace-input.js';

export interface WorkspaceInputPorts {
  rows(): readonly SidetabRow[];
  /** Return undefined unless the entire available transcript was captured and redacted. */
  observe(target: WorkspacePtyTarget): Promise<CompleteTerminalObservation | undefined>;
  /** The takeover boundary decides whether terminal bytes can be written. */
  sendTerminal(target: WorkspacePtyTarget, text: string): Promise<boolean>;
  /** Separate conversation session. This port must not write to a PTY. */
  sendSidechat(input: {
    spaceId: string;
    target: WorkspacePtyTarget;
    text: string;
    observation: CompleteTerminalObservation;
    sessionId?: string;
  }): Promise<{ sessionId: string; reply?: string }>;
}

export interface WorkspaceSidechatMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** Keeps workspace drafts and targets independent while the TUI switches tabs. */
export function createWorkspaceInputController(ports: WorkspaceInputPorts) {
  let state: WorkspaceInputState = createWorkspaceInputState();
  let submitting = false;
  const conversations = new Map<string, readonly WorkspaceSidechatMessage[]>();
  return {
    state: () => state,
    conversation: (spaceId: string) => conversations.get(spaceId) ?? [],
    select(row: SidetabRow) { state = selectWorkspaceInput(state, row); },
    bind(row: SidetabRow) { state = bindWorkspacePty(state, row); },
    edit(mode: WorkspaceInputMode, text: string) { state = setWorkspaceInputDraft(state, mode, text); },
    async submit(mode: WorkspaceInputMode): Promise<boolean> {
      if (submitting) throw new Error('workspace input is already submitting');
      submitting = true;
      try {
        const active = state.activeSpaceId;
        const target = active ? state.entries[active]?.target : undefined;
        if (!target) throw new Error('workspace PTY target is not bound');
        // Capture can await a remote PTY. prepareWorkspaceInput rechecks the
        // selected workspace, binding revision, liveness, and activity after it.
        const observation = mode === 'sidechat' ? await ports.observe(target) : undefined;
        const intent = prepareWorkspaceInput(state, mode, ports.rows(), observation);
        if (intent.kind === 'terminal') return await ports.sendTerminal(intent.target, intent.text);
        const result = await ports.sendSidechat({
          spaceId: intent.target.spaceId, target: intent.target, text: intent.text,
          observation: intent.observation, ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
        });
        // A delayed reply belongs to its original workspace even after the
        // user switches tabs. A rebind invalidates the old reply instead.
        const current = state.entries[intent.target.spaceId];
        if (current?.target?.bindingRevision === intent.target.bindingRevision) {
          state = { ...state, entries: { ...state.entries,
            [intent.target.spaceId]: { ...current, sidechatSessionId: result.sessionId },
          } };
          const messages = conversations.get(intent.target.spaceId) ?? [];
          conversations.set(intent.target.spaceId, [...messages,
            { role: 'user', text: intent.text },
            { role: 'assistant', text: result.reply ?? '' },
          ]);
        }
        return true;
      } finally { submitting = false; }
    },
  };
}
