// ELS-TAB-STATE-BADGE — 탭 배지 = 규약 사건 state (OP order WORKER-MIGRATION-PHASE1-1119 · TC #95180).
// WORKER-CONTRACT-SPEC(HAND-ELN-ELS) 사건 state 를 PaneState 에서 사상하고, 무사건 지연을 멈춤(stalled) 표시로 바꾼다.
// stop/migrate 는 컨트롤 문 경유(#38854 우회 0) — 배지 아래 탭 메뉴 액션 정의가 그 문 규칙을 정본으로 적는다.

import type { PaneState } from './space.js';

/** WORKER-CONTRACT-SPEC 규약 사건 state — 배지 정본 단어. */
export type WorkerBadgeState = 'working' | 'idle' | 'needs-approval' | 'done' | 'failed' | 'stalled' | 'exited';

/** PaneState → 규약 state 사상. blocked 는 사람 승인 대기(= needs-approval)로, exited 는 종결로 본다. */
export function mapPaneStateToBadge(state: PaneState): WorkerBadgeState {
  switch (state) {
    case 'working': return 'working';
    case 'idle': return 'idle';
    case 'blocked': return 'needs-approval';
    case 'done': return 'done';
    case 'exited': return 'exited';
  }
}

/** 멈춤 판정 기본값 — N분 무사건. 마지막 사건 시각을 모르면(undefined) 멈춤 표시를 내지 않는다. */
export const STALLED_AFTER_MS_DEFAULT = 15 * 60 * 1000;

export interface TabBadgeInput {
  readonly state: PaneState;
  /** 마지막 규약 사건 시각(ms epoch). 알 수 없으면 undefined. */
  readonly lastEventAtMs?: number;
}

export interface TabBadge {
  readonly state: WorkerBadgeState;
  /** 멈춤(무사건 지연) 표시 여부 — working 이던 배지를 stalled 로 바꾼다. */
  readonly stalled: boolean;
  /** 목록·사이드탭에 붙는 한 줄 라벨 (예: `[▶ working]`). */
  readonly label: string;
}

const BADGE_GLYPH: Record<WorkerBadgeState, string> = {
  'working': '▶',
  'idle': '·',
  'needs-approval': '?',
  'done': '✓',
  'failed': '✗',
  'stalled': '⏸',
  'exited': '×',
};

/** 배지 계산 — 순수 함수. working 중 무사건 지연이 임계를 넘으면 stalled 로 바뀐다. */
export function tabBadge(input: TabBadgeInput, nowMs: number, stalledAfterMs: number = STALLED_AFTER_MS_DEFAULT): TabBadge {
  const base = mapPaneStateToBadge(input.state);
  const stalled = base === 'working' && input.lastEventAtMs !== undefined && nowMs - input.lastEventAtMs > stalledAfterMs;
  const state: WorkerBadgeState = stalled ? 'stalled' : base;
  return { state, stalled, label: `[${BADGE_GLYPH[state]} ${state}]` };
}

/** 탭 메뉴 액션 — 컨트롤 문 경유 규칙을 자료로 정의한다. */
export type TabMenuAction = 'read' | 'attach' | 'do' | 'stop' | 'migrate';

export interface TabMenuActionSpec {
  readonly action: TabMenuAction;
  /** 이 액션을 실행하는 문 — 'door' 면 els 컨트롤 문(els do / control ops)만, 'local' 면 클라이언트 로컬 동작. */
  readonly via: 'door' | 'local';
  /** 문 명령 — via === 'door' 일 때만 의미가 있다. */
  readonly doorOp: string;
  /** stop 액션의 모드(#38854 계약: migrate|quit|force) — 문은 mode 없는 stop 을 거부한다(default deny). */
  readonly doorMode?: 'migrate' | 'quit' | 'force';
}

/** stop/migrate 는 컨트롤 문 경유(#38854 · 우회 0). read/do 도 문 경유, attach 만 로컬 화면 열기. */
export const TAB_MENU_ACTIONS: readonly TabMenuActionSpec[] = [
  { action: 'read', via: 'door', doorOp: 'read' },
  { action: 'attach', via: 'local', doorOp: '' },
  { action: 'do', via: 'door', doorOp: 'input' },
  { action: 'stop', via: 'door', doorOp: 'stop', doorMode: 'quit' },
  { action: 'migrate', via: 'door', doorOp: 'stop', doorMode: 'migrate' },
];
