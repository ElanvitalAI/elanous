// els 공간 모델 — workspace ⊃ tab ⊃ pane (DESIGN-ELS 공간 위계).
// 1단은 pane = pty 하나. 원격 연합·⇄ 표식은 2단.

export type PaneKind = 'pty' | 'agent' | 'harness-child' | 'graph-view' | 'remote';
export type PaneState = 'working' | 'idle' | 'blocked' | 'done' | 'exited';
export type RestorePolicy = 'none' | 'cwd' | 'command' | 'resume';

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly rootCwd: string;
  readonly purpose: string;
  readonly host: string;
  /** Explicit coordinator assignment; absent on ordinary and legacy workspaces. */
  readonly role?: 'coordinator';
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
  /** Verified creator seat; absent on legacy or unverified panes. */
  readonly ownerSeat?: string;
}

export interface CoordinatorAudit {
  readonly at: string;
  readonly op: 'coordinator' | 'coordinator-unset';
  readonly result: string;
  readonly peerPid?: number;
}

export interface SpaceJournal {
  /** Authoritative coordinator audit; committed in the same journal replacement as the assignment. */
  readonly coordinatorAudit?: CoordinatorAudit[];
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
