import type { HandleStatus } from '../../../status/chip.js';
import type { resolveTerminalMoveDestination } from '../../../terminal-matrix/mobility.js';
import type { TerminalModalRouter } from '../../../terminal/terminal-modal-router.js';

export interface DashboardPersistedSessionEntry {
  id: string;
  title: string;
  command?: string | null;
  kind: string;
}

export interface DashboardTerminalListEntry {
  idSuffix: string;
  title: string;
  chip: string;
  agentBrand: string | null;
  attentionLevel: number;
  attentionLabel: string;
}

export interface DashboardShellHandleListEntry {
  idSuffix: string;
  chip: string;
  mode: string;
  label: string | null;
}

export interface DashboardTermSlashRuntimeDeps {
  accent: (text: string) => string;
  muted: (text: string) => string;
  warning: (text: string) => string;
  error: (text: string) => string;
  text: (text: string) => string;
}

export interface TermSlashRuntime {
  helpLines(): string[];
  experimentalHelpLines(): string[];
  terminalSessionsEmptyLine(): string;
  terminalSessionLine(entry: DashboardTerminalListEntry): string;
  shellRunnerSectionDividerLine(): string;
  shellRunnerFooterLine(): string;
  shellHandleLine(entry: DashboardShellHandleListEntry): string;
  detachEmptyLine(): string;
  detachedLine(title: string): string;
  attachUsageLine(): string;
  attachMissingLine(target: string): string;
  killEmptyLine(): string;
  killedLine(title: string): string;
  snapshotUsageLine(): string;
  snapshotUnknownIdLine(target: string): string;
  snapshotHeaderLine(id: string, state: string, title: string, mode: 'snapshot' | 'tail'): string;
  moveUsageLine(): string;
  moveMissingLine(target: string): string;
  moveMissingWindowTargetLine(): string;
  moveUnknownPlacementLine(destRaw: string): string;
  movedLine(terminalId: string, destLabel: string): string;
  moveFailedLine(message: string): string;
  matrixEmptyLine(): string;
  noPersistedSessionsLine(): string;
  resumeHelpLines(
    persisted: readonly DashboardPersistedSessionEntry[],
    options?: { maxItems?: number },
  ): string[];
  persistedSessionMissingLine(target: string): string;
  recharacterUsageLine(): string;
  terminalMissingLine(target: string): string;
  unknownCharacterLine(target: string): string;
  recharacterResultLine(terminalId: string, kind: string, reexeced: boolean): string;
  unknownSubcommandLine(sub: string): string;
  fullscreenMissingLine(): string;
  readonlyUsageLine(): string;
  readonlyResultLine(terminalId: string, next: boolean): string;
  vwBarMissingLine(target: string): string;
  vwBarResultLine(windowId: number, next: boolean): string;
  vwSyncUsageLine(): string;
  vwSyncResultLine(group: string, delivered: number, skipped: number, errored: number): string;
  channelTailResultLine(subId: number, channel: string, terminalId: string, replay: boolean): string;
  unknownChannelOpLine(op: string): string;
  pipeUsageLine(): string;
  pipeResultLine(pipeId: number, terminalId: string, channel: string, lineMode: boolean): string;
  pipeFailedLine(message: string): string;
  unpipeUsageLine(): string;
  activePipeMissingLine(pipeId: number): string;
  unpipeResultLine(pipeId: number, terminalId: string, channel: string): string;
  pipesEmptyLine(): string;
  groupUsageLine(op: 'join' | 'leave'): string;
  groupsEmptyLine(): string;
  groupHeaderLine(group: string, memberCount: number): string;
  groupMemberLine(id: string, title: string, readOnly: boolean): string;
  groupResultLine(terminalId: string, op: 'join' | 'leave', group: string): string;
  groupSendUsageLine(): string;
  groupSendResultLine(group: string, delivered: number, skipped: number, errored: number): string;
  unknownGroupOpLine(op: string): string;
  channelEmptyLine(): string;
  channelHeaderLine(): string;
  channelListLine(channel: string, subscriberCount: number, publishedCount: number, last: string): string;
  channelPubUsageLine(): string;
  channelPubResultLine(channel: string, subscribers: number): string;
  channelSnapshotUsageLine(): string;
  channelSnapshotEmptyLine(channel: string): string;
  channelSnapshotHeaderLine(channel: string, count: number): string;
  channelSnapshotEntryLine(from: string, preview: string): string;
  channelTailUsageLine(): string;
  pipesHeaderLine(): string;
  pipesEntryLine(id: number, terminalId: string, channel: string, lineMode: boolean): string;
}


/** `/term` 호스트 묶음(옛 DashboardSlashContext.termSlash 의 인라인 타입 · 그대로 옮김). */
export interface TermSlashHost {
  /** Line formatters (existing factory output type re-used). */
  slashRuntime: TermSlashRuntime;
  openNewTerminal(command?: string): void;

  /** Terminal modal ownership stays in the host that owns the display loop. */
  modalRouter: Pick<TerminalModalRouter, 'current' | 'set'>;

  /** Terminal session registry (the modal-pty side). */
  sessionRegistry: {
    list(): readonly {
      id: string;
      title: string;
      state: HandleStatus;
      cwd: string;
      exitCode: number | null;
      agentBrand?: string | null;
      attentionLevel: number;
      modal?: unknown;
    }[];
    foreground(): { id: string; title: string } | null;
    detach(id: string): void;
    attach(id: string, opts: { termCols: number; termRows: number }):
      { id: string; title: string; modal?: unknown } | null;
    kill(id: string): void;
    get(id: string): { id: string; title: string; modal?: unknown } | null;
    spawn(
      spec: {
        title: string;
        cwd: string;
        command?: string | undefined;
        termName: string;
        kind: string;
        agentBrand?: string | undefined;
      },
      opts: { termCols: number; termRows: number },
    ): { id: string; title: string; modal?: unknown };
  };

  /** Terminal matrix — the multi-terminal coordination layer. */
  terminalMatrix: {
    get(needle: string): {
      id: string;
      legacySessionId?: string | null;
      title: string;
      readOnly: boolean;
      exitCode: number | null;
      broadcastGroups: Set<string>;
      character: { kind: string };
      transport: { kind: string };
      placement: { kind: string; windowId?: string | number; slotId?: string };
      pty: { write(data: string): void };
    } | null;
    list(opts?: { includeExited?: boolean }): readonly {
      id: string;
      legacySessionId?: string | null;
      title: string;
      readOnly: boolean;
      exitCode: number | null;
      broadcastGroups: Set<string>;
      character: { kind: string };
      transport: { kind: string };
      placement: { kind: string; windowId?: string | number; slotId?: string };
      pty: { write(data: string): void };
    }[];
    move(id: string, dest: ReturnType<typeof resolveTerminalMoveDestination>): void;
    joinGroup(id: string, group: string): void;
    leaveGroup(id: string, group: string): void;
    setReadOnly(id: string, value: boolean): void;
    recharacterAndReexec(
      id: string,
      character: { kind: 'shell' | 'claude-code' | 'codex' | 'custom'; name?: string },
    ): { reexeced: boolean };
    pipeToChannel(id: string, channel: string, opts: { lineMode: boolean }): { id: number };
    listPipes(): readonly {
      id: number;
      terminalId: string;
      channel: string;
      lineMode: boolean;
      unsubscribe(): void;
    }[];
  };

  /** Virtual-windows registry · subset used by /term vw-bar / move. */
  vwRegistry: {
    current(): { id: number; isSyncInputBarActive(): boolean; setSyncInputBar(v: boolean): void } | null;
    get(id: number): { id: number; isSyncInputBarActive(): boolean; setSyncInputBar(v: boolean): void } | null;
  };

  /** Broadcast bus — used by /term group + /term vw-sync. */
  broadcastBus: {
    groups(): readonly string[];
    members(group: string): readonly { id: string; title: string; readOnly: boolean }[];
    broadcastBytes(group: string, text: string): {
      delivered: readonly unknown[];
      skippedExited: readonly unknown[];
      skippedReadOnly: readonly unknown[];
      errored: readonly unknown[];
    };
  };

  /** Channel bus — used by /term channel + /term pipe + /term unpipe. */
  channelBus: {
    channels(): readonly string[];
    statsFor(channel: string): {
      subscriberCount: number;
      publishedCount: number;
      lastPublishAt: number | null;
    };
    publish(channel: string, msg: { from: string; payload: string | Buffer }): number;
    snapshot(channel: string, limit: number): readonly { from: string; payload: string | Buffer }[];
    subscribe(
      channel: string,
      cb: (msg: { from: string; payload: string | Buffer }) => void,
      opts: { label: string; replay: boolean },
    ): { id: number };
  };

  /** Open the /term switch session-picker modal · wraps createSessionPickerModal +
   *  attachSurfaceToWorkspace + display.pushModal + agentSearchModal/Handle
   *  mutation. The handler's only responsibility is calling this once. */
  openSessionPicker(): void;

  /** Wraps the inline `openSession` closure (terminalModalRouter.set +
   *  detach-on-close + draw). Called after a successful session attach
   *  / spawn / resume. */
  openSession(session: { id: string; title: string; modal?: unknown }): void;

  /** Set working focus to 'preview' (for /term move <id> preview). */
  setWorkingFocusPreview(): void;

  /** Compute next vw-slot id for a terminal · used by resolveTerminalMoveDestination. */
  nextTerminalVwSlotId(terminalId: string): string;
}


/** `/term` 이 ctx 에서 쓰는 것만(DashboardSlashContext 의 부분집합 · 구조 타입). */
export interface TermSlashContext {
  chatLines: string[];
  setChatScrollOffset(value: number): void;
  accent(text: string): string;
  error(text: string): string;
  warning(text: string): string;
  draw(): void;
  termSlash: TermSlashHost;
}

/** 핸들러 머리에서 ctx.termSlash 를 한 번 읽어 둔 것(옛 핸들러의 지역 상수 여섯 그대로). */

export interface TermSlashLocals {
  slashRuntime: TermSlashHost['slashRuntime'];
  sessionRegistry: TermSlashHost['sessionRegistry'];
  terminalMatrix: TermSlashHost['terminalMatrix'];
  vwRegistry: TermSlashHost['vwRegistry'];
  broadcastBus: TermSlashHost['broadcastBus'];
  channelBus: TermSlashHost['channelBus'];
}
export type TermSubHandler = (
  sub: string,
  args: string[],
  ctx: TermSlashContext,
  locals: TermSlashLocals,
) => Promise<void>;
