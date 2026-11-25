// els 공간 모델 — workspace ⊃ tab ⊃ pane (DESIGN-ELS 공간 위계).
// 1단은 pane = pty 하나. 원격 연합·⇄ 표식은 2단.

export type PaneKind = 'pty' | 'agent' | 'harness-child' | 'graph-view' | 'remote';
export type PaneState = 'working' | 'idle' | 'blocked' | 'done' | 'exited';
export type RestorePolicy = 'none' | 'cwd' | 'command' | 'resume';

// ELS-POD-TAB (출처: seat-state/OP/orders/WORKER-MIGRATION-PHASE1-1119.md 40행): the physical side of a pane —
// WHERE it runs. A pod is an execution place under a host (the host's own els reaches it through kubectl), never
// a workspace or a host of its own.
export type PaneRuntime = 'process' | 'pod';
export interface PanePlace {
  /** The host whose els placed the pane; a pod's credentials stay on exactly this host. */
  readonly host: string;
  readonly runtime: PaneRuntime;
}

/** ELS-POD-TAB (order 45행): one soft memo of a pod pane's control inbox — accepted by `els do`, never PTY-injected. */
export interface PaneMemo {
  /** Verified sender identity of the `els do` (`from`), at most 64 chars. */
  readonly from: string;
  /** Server clock (ms since epoch) when the memo was accepted into the inbox — never client-trusted. */
  readonly at: number;
  readonly text: string;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly rootCwd: string;
  readonly purpose: string;
  readonly host: string;
  /** Explicit coordinator assignment; absent on ordinary and legacy workspaces. */
  readonly role?: 'coordinator';
  /** Seat coordinating this workspace, separate from the legacy host-wide workspace role. */
  readonly coordinatorSeat?: string;
}

export interface Tab {
  readonly id: string;
  readonly workspaceId: string;
  readonly label: string;
  readonly focusPaneId: string;
}

/** 설계 문서의 «Tab 객체»를 Pane 으로 이름만 바꾼 것. 1단 kind 는 pty. */
export interface Pane {
  readonly id: string;
  readonly tabId: string;
  readonly kind: PaneKind;
  readonly title: string;
  readonly cwd: string;
  /** A validated OSC 7 was observed during this pane's PTY lifetime. */
  readonly cwdOsc7?: true;
  /** Unvalidated OSC candidates checkpointed at graceful shutdown, oldest first. */
  readonly cwdOscPending?: readonly string[];
  readonly command: readonly string[];
  readonly state: PaneState;
  readonly restore: RestorePolicy;
  /** 살아있는 동안의 PTY id. 재기동 뒤에는 비운다 — 화면은 복원 불가. */
  readonly ptyId: string;
  /** 마지막 스크롤백. 재기동 뒤 읽기 전용. */
  readonly scrollback: string;
  /** Millisecond wall clock when the PTY exited; legacy exited rows receive this on server start. */
  readonly exitedAt?: number;
  /** DEMO-PANE-EXIT-VISIBLE: the child's exit code (null = signal or the holder never reported). */
  readonly exitCode?: number | null;
  /** DEMO-PANE-EXIT-VISIBLE: why the pane ended, one line («exit 3» · «holder connection lost …»). */
  readonly exitReason?: string;
  /** DEMO-PANE-EXIT-VISIBLE: the last non-empty lines of the final screen (≤ 5) — usually the error. */
  readonly exitTail?: readonly string[];
  /** Verified creator seat; absent on legacy or unverified panes. */
  readonly ownerSeat?: string;
  /** Seat launched by `els seat`, distinct from the verified creator's authority. */
  readonly seatIdentity?: string;
  /** DEMO-FANOUT-LIVE-OP-SEAT: the pane whose agent opened this one through the tool door (ElsControl new) — a worker child
   *  of that pane, never a seat of its own. Server-set from the verified caller pane, never from request data. */
  readonly parentPane?: string;
  /** ELS-POD-TAB: the physical place; absent = the stage-1 default, a process on its own host. */
  readonly place?: PanePlace;
  /** ELS-POD-TAB: a pod pane's control inbox — soft memos, newest last, bounded (POD_INBOX_MAX); persisted in the
   * journal (survives a restart) and surfaced by `ls`; never rendered into the pod's own stream. */
  readonly inbox?: readonly PaneMemo[];
}

export interface CoordinatorAudit {
  readonly at: string;
  readonly op: 'coordinator' | 'coordinator-unset';
  readonly result: string;
  readonly peerPid?: number;
}

export interface LastFocus { readonly workspaceId: string; readonly tabId?: string; readonly paneId?: string }

export interface SpaceJournal {
  /** Last local pane selected by an authenticated owner view; stale references are allowed. */
  readonly lastFocus?: LastFocus;
  /** Authoritative coordinator audit; committed in the same journal replacement as the assignment. */
  readonly coordinatorAudit?: CoordinatorAudit[];
  /** HQ seat is independent of workspace coordinator assignments. */
  readonly hqCoordinatorSeat?: string;
  /** Reserved for a future federated authority; not used for local arbitration. */
  readonly hqAuthorityLocation?: string;
  readonly version: 1;
  readonly workspaces: Workspace[];
  readonly tabs: Tab[];
  readonly panes: Pane[];
}

export function emptyJournal(): SpaceJournal {
  return { version: 1, workspaces: [], tabs: [], panes: [] };
}

export function paneAddress(ws: Workspace, tab: Tab, pane: Pane): string {
  return `${ws.id}/${tab.id}/${pane.id}`;
}
