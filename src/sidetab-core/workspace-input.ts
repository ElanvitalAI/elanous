import type { SidetabRow } from './model.js';

export type WorkspaceInputMode = 'terminal' | 'sidechat';

export interface WorkspacePtyTarget {
  readonly rowId: string;
  readonly spaceId: string;
  readonly ptyId: string;
  readonly remoteHost?: string;
  readonly ownerPid: number;
  readonly ptyStartedAt: number;
  /** Advances whenever the operator binds a PTY, including the same PTY again. */
  readonly bindingRevision: number;
}

export interface WorkspaceInputEntry {
  readonly terminalDraft: string;
  readonly sidechatDraft: string;
  readonly target?: WorkspacePtyTarget;
  readonly sidechatSessionId?: string;
}

export interface WorkspaceInputState {
  readonly activeSpaceId?: string;
  readonly entries: Readonly<Record<string, WorkspaceInputEntry>>;
}

export interface CompleteTerminalObservation {
  readonly target: WorkspacePtyTarget;
  /** Current terminal screen, including rows outside the sidetab crop. */
  readonly screen: string;
  /** Full available terminal transcript from the PTY recorder, not the viewport. */
  readonly transcript: string;
  readonly observedAt: string;
  /** Activity marker read with the screen and transcript from the PTY manifest. */
  readonly activityAt: number;
  /** Set only by the capture adapter after redaction and full transcript collection. */
  readonly coverage: 'full';
}

export type WorkspaceInputIntent =
  | { readonly kind: 'terminal'; readonly target: WorkspacePtyTarget; readonly text: string; readonly requiresTakeover: true }
  | { readonly kind: 'sidechat'; readonly target: WorkspacePtyTarget; readonly text: string; readonly observation: CompleteTerminalObservation; readonly sessionId?: string };

export function createWorkspaceInputState(): WorkspaceInputState {
  return { entries: {} };
}

function requireWorkspace(row: SidetabRow): string {
  if (row.kind !== 'workspace' || !row.spaceId?.trim()) throw new Error('select a workspace row with a spaceId');
  return row.spaceId;
}

function entry(state: WorkspaceInputState, spaceId: string): WorkspaceInputEntry {
  return Object.hasOwn(state.entries, spaceId) ? state.entries[spaceId]! : { terminalDraft: '', sidechatDraft: '' };
}

function update(state: WorkspaceInputState, spaceId: string, value: WorkspaceInputEntry): WorkspaceInputState {
  return { ...state, entries: { ...state.entries, [spaceId]: value } };
}

export function selectWorkspaceInput(state: WorkspaceInputState, workspace: SidetabRow): WorkspaceInputState {
  const spaceId = requireWorkspace(workspace);
  return { ...update(state, spaceId, entry(state, spaceId)), activeSpaceId: spaceId };
}

export function setWorkspaceInputDraft(state: WorkspaceInputState, mode: WorkspaceInputMode, text: string): WorkspaceInputState {
  const spaceId = state.activeSpaceId;
  if (!spaceId) throw new Error('select a workspace before editing its input');
  const current = entry(state, spaceId);
  return update(state, spaceId, mode === 'terminal'
    ? { ...current, terminalDraft: text }
    : { ...current, sidechatDraft: text });
}

/** Bind a concrete child PTY. A workspace header itself is never a write target. */
export function bindWorkspacePty(state: WorkspaceInputState, row: SidetabRow): WorkspaceInputState {
  const spaceId = state.activeSpaceId;
  if (!spaceId || row.spaceId !== spaceId || !row.ptyId || row.badge === 'exited' || row.currentProcess ||
      !Number.isSafeInteger(row.ownerPid) || (row.ownerPid ?? 0) <= 0 ||
      !Number.isSafeInteger(row.ptyStartedAt) || (row.ptyStartedAt ?? 0) <= 0) {
    throw new Error('select a live PTY belonging to the active workspace');
  }
  const target: WorkspacePtyTarget = {
    rowId: row.id, spaceId, ptyId: row.ptyId,
    ownerPid: row.ownerPid!, ptyStartedAt: row.ptyStartedAt!,
    bindingRevision: (entry(state, spaceId).target?.bindingRevision ?? 0) + 1,
    ...(row.remoteHost ? { remoteHost: row.remoteHost } : {}),
  };
  return update(state, spaceId, { ...entry(state, spaceId), target });
}

export function bindWorkspaceSidechatSession(state: WorkspaceInputState, sessionId: string): WorkspaceInputState {
  const spaceId = state.activeSpaceId;
  if (!spaceId || !sessionId.trim()) throw new Error('select a workspace and a sidechat session');
  return update(state, spaceId, { ...entry(state, spaceId), sidechatSessionId: sessionId });
}

function sameTarget(a: WorkspacePtyTarget, b: WorkspacePtyTarget): boolean {
  return a.rowId === b.rowId && a.spaceId === b.spaceId && a.ptyId === b.ptyId
    && a.remoteHost === b.remoteHost && a.ownerPid === b.ownerPid && a.ptyStartedAt === b.ptyStartedAt
    && a.bindingRevision === b.bindingRevision;
}

/** Resolve against fresh rows at submit time. No fallback to the parent composer or another PTY. */
export function prepareWorkspaceInput(
  state: WorkspaceInputState,
  mode: WorkspaceInputMode,
  freshRows: readonly SidetabRow[],
  observation?: CompleteTerminalObservation,
  now = Date.now(),
): WorkspaceInputIntent {
  const spaceId = state.activeSpaceId;
  const current = spaceId ? entry(state, spaceId) : undefined;
  if (!spaceId || !current?.target) throw new Error('workspace PTY target is not bound');
  const target = current.target;
  const live = freshRows.find(row => row.id === target.rowId && row.spaceId === spaceId && row.ptyId === target.ptyId
    && row.remoteHost === target.remoteHost && row.ownerPid === target.ownerPid
    && row.ptyStartedAt === target.ptyStartedAt && row.badge !== 'exited' && !row.currentProcess);
  if (!live) throw new Error('workspace PTY target changed; select it again');
  const text = mode === 'terminal' ? current.terminalDraft : current.sidechatDraft;
  if (!text.trim()) throw new Error('workspace input is empty');
  if (mode === 'terminal') return { kind: 'terminal', target, text, requiresTakeover: true };
  // Source: #36765 Terra review — a current PTY identity alone does not make an old capture current.
  const maxObservationAgeMs = 30_000;
  const observedAt = observation ? Date.parse(observation.observedAt) : NaN;
  if (!observation || observation.coverage !== 'full' || !sameTarget(observation.target, target)
    || !observation.screen || !observation.transcript || !Number.isFinite(observedAt)
    || observedAt > now || now - observedAt > maxObservationAgeMs
    || live.lastActivityAt === undefined || observation.activityAt !== live.lastActivityAt) {
    throw new Error('sidechat requires a full current observation of the bound PTY');
  }
  return { kind: 'sidechat', target, text, observation,
    ...(current.sidechatSessionId ? { sessionId: current.sidechatSessionId } : {}) };
}
