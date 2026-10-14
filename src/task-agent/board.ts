/**
 * 보드 일반형 — 프로젝트 › 목표 › 이정표 › 과제 (RFC-loop-agent-map §A4b①).
 *
 * «판(0.2.x)·칸» 체크리스트는 이 보드의 한 사례(내부 팩)다. 어댑터 둘은 «읽기»만 한다:
 * - `cardsBoard(statePath)` — task-agent-actions.json 의 과제 카드(project.id · goal · milestone)를 트리로.
 * - `releasePackBoard(version)` — 릴리스 체크리스트를 project=elanous · milestone=판 · task=칸 으로 사상. 원장은 쓰지 않는다.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { listChecklist, type ChecklistStatus } from '../release-loop/checklist.js';
import { buildRunProgressRows, queryRunningRuns, type RunningRunsResult, type RunProgressRow } from '../self-implement/running-runs.js';
import {
  boundPrTerminal, cardPrNumber, CLOSED_BY_HAND_EVENT, HAND_MOVE_HISTORY_EVENT, LIVE_MOVE_HISTORY_EVENT, LIVE_MOVE_RESULT_EVENT, readTaskAgentState,
  type CompletionKind, type TaskCard,
} from './task-hand.js';

export type BoardLevel = 'project' | 'goal' | 'milestone' | 'task';
export type BoardStatus = 'open' | 'done' | 'blocked';

/** 카드 원장(task-agent-actions.json)에 적힌 사실만 — 없는 칸은 null(지어내지 않는다). */
export interface BoardTaskLedger {
  runId: string | null;
  pr: number | null;
  /** 카드 상태(handed · launched · launch-failed · failed). */
  lastStatus: TaskCard['status'];
  /** 관측 기록(live-move · hand-move)을 뺀 history 의 마지막 줄. */
  lastEvent: { at: string; event: string; detail: string | null } | null;
  /** 카드가 failed · launch-failed 일 때 마지막 줄의 사유(예: `failed/needs-owner — exit 1 · pod-failure`). 그 밖에는 null. */
  exitReason: string | null;
  /** Terminal PR observation, only when it still matches this card's binding. */
  prTerminal?: NonNullable<TaskCard['prTerminal']>;
  /** Checklist judgement after merge; partial means this slice ended while the cell remains open. */
  postLand?: NonNullable<TaskCard['postLand']>;
}

/** `GET /api/task-agent/board` 응답 — progress 는 진전 관측(`queryRunningRuns`)을 싣는다; 관측을 못 얻으면 null(0을 «없다»로 쓰지 않는다). */
export interface TaskAgentBoardResponse { board: BoardNode[]; progress: TaskAgentBoardProgress | null }

/** 진전 관측 칸 — 행은 기존 `RunProgressRow` 형식 그대로(새 행 형식을 만들지 않는다). 과제 노드와는 `ledger.runId` ↔ `rows[].runId` 로만 짝짓는다(ledger 에 새 칸은 없다). */
export interface TaskAgentBoardProgress {
  readonly rows: readonly RunProgressRow[];
  /** 관측이 부분(running 수가 `{ count: null, lowerBound }` 꼴이거나 읽지 못한 원장 unreadable 이 있으면)이면 true · 아니면 false. */
  readonly partial: boolean;
  /** 부분 관측일 때의 최소 running 수 · 완전 관측이면 null. */
  readonly lowerBound: number | null;
}

export interface BoardNode {
  level: BoardLevel;
  id: string;
  title: string;
  status: BoardStatus;
  /** 과제 노드만 — 카드의 종결 종류(비면 code-pr 로 읽는다 · 칸은 싣지 않는다). */
  completion?: CompletionKind;
  /** 과제 노드만 · `cardsBoard(…, { ledger: true })` 일 때만 — 카드 원장에서 읽은 런·PR·마지막 상태·종료 이유. */
  ledger?: BoardTaskLedger;
  /** 부모 노드 id(프로젝트는 없다). */
  parent?: string;
  /** 프로젝트 노드만 — 프로젝트 없는 카드의 자리(id 는 빈 문자열이라 실제 프로젝트 id 와 겹치지 않는다). */
  unassigned?: true;
  children?: BoardNode[];
}

/** 프로젝트가 없는 카드가 모이는 자리의 id — 빈 문자열(실제 프로젝트 id 는 비지 않는다 · `handTask` 가 빈 id 를 거부). */
export const UNASSIGNED_PROJECT = '';
/** 내부 팩(릴리스 체크리스트)의 프로젝트 id. */
export const INTERNAL_PACK_PROJECT = 'elanous';

function branch(level: BoardLevel, id: string, title: string, parent?: string): BoardNode {
  // 무소속 프로젝트의 id 는 '' — 빈 문자열도 부모 id 로 보존한다.
  return { level, id, title, status: 'open', ...(parent !== undefined ? { parent } : {}), children: [] };
}

function child(parent: BoardNode, level: BoardLevel, id: string, title = id): BoardNode {
  let node = parent.children!.find((candidate) => candidate.level === level && candidate.id === id);
  if (!node) {
    node = branch(level, id, title, parent.id);
    parent.children!.push(node);
  }
  return node;
}

/** 자식이 있는 노드의 상태 = 막힘 하나라도 → blocked · 전부 done → done · 그 밖 open. */
function aggregate(node: BoardNode): void {
  if (!node.children?.length) return;
  for (const next of node.children) aggregate(next);
  node.status = node.children.some((next) => next.status === 'blocked') ? 'blocked'
    : node.children.every((next) => next.status === 'done') ? 'done' : 'open';
}

function cardStatus(card: TaskCard): BoardStatus {
  const terminal = boundPrTerminal(card);
  if (terminal) return terminal.state === 'MERGED' ? 'done' : 'blocked';
  if (card.status === 'launch-failed' || card.status === 'failed') return 'blocked';
  return card.greenProposal ? 'done' : 'open';
}

function cardLedger(card: TaskCard): BoardTaskLedger {
  const terminal = boundPrTerminal(card);
  const last = (card.history ?? [])
    .filter((item) => item.event !== LIVE_MOVE_HISTORY_EVENT && item.event !== LIVE_MOVE_RESULT_EVENT && item.event !== HAND_MOVE_HISTORY_EVENT)
    .at(-1);
  const ended = card.status === 'failed' || card.status === 'launch-failed';
  // ⚠️ 종료 이유 = «관측 줄을 뺀 마지막 줄»의 detail 만 본다 — 그 줄이 detail 없는 run-bound·pr-bound 면 null(지어내지 않음 · 앞줄을 거슬러 찾지 않는다).
  //   관측 줄 거르기는 task-hand.ts(wait 사유)와 같은 셋이다 — 공용 헬퍼로 묶는 것은 다음 조각(UX 수확 리뷰 should-fix).
  const reason = last ? (last.event === CLOSED_BY_HAND_EVENT ? last.reason ?? last.detail : last.detail) : undefined;
  return {
    runId: card.runId ?? null,
    pr: cardPrNumber(card) ?? null,
    lastStatus: card.status,
    lastEvent: last ? { at: last.at, event: last.event, detail: last.detail ?? null } : null,
    exitReason: ended ? reason ?? null : null,
    ...(terminal ? { prTerminal: terminal } : {}),
    ...(terminal && terminal.state === 'MERGED' && card.postLand?.pr === terminal.pr && card.postLand.head === terminal.head
      ? { postLand: card.postLand } : {}),
  };
}

/**
 * 과제 카드 → 프로젝트 트리. 프로젝트 없는 카드는 «무소속»(`unassigned: true` · id '') 아래 — 어떤 프로젝트 id 로도 걸러지지 않는다.
 * `ledger: true` 면 과제 노드마다 카드 원장 사실(`ledger`)을 붙인다 — 기본(CLI)은 그대로다.
 */
export function cardsBoard(statePath: string, options: { ledger?: boolean } = {}): BoardNode[] {
  const projects: BoardNode[] = [];
  const cards = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath).tasks ?? {};
  for (const card of Object.values(cards)) {
    const projectId = card.project?.id?.trim() || UNASSIGNED_PROJECT;
    const unassigned = projectId === UNASSIGNED_PROJECT;
    let project = projects.find((node) => node.id === projectId && (node.unassigned === true) === unassigned);
    if (!project) {
      project = unassigned ? { ...branch('project', UNASSIGNED_PROJECT, '무소속'), unassigned: true } : branch('project', projectId, projectId);
      projects.push(project);
    }
    const goal = card.goal ? child(project, 'goal', card.goal) : project;
    const milestone = card.milestone ? child(goal, 'milestone', card.milestone) : goal;
    milestone.children!.push({
      level: 'task', id: card.id, title: card.text, status: cardStatus(card),
      ...(card.completion ? { completion: card.completion } : {}),
      ...(options.ledger ? { ledger: cardLedger(card) } : {}),
      parent: milestone.id,
    });
  }
  for (const project of projects) aggregate(project);
  return projects;
}

/** `taskAgentBoard` 주입 자리 — 시험은 관측을 갈아끼워 결정성을 얻는다. */
export interface TaskAgentBoardDeps {
  /** 진전 관측. 기본 = `queryRunningRuns({ caller: 'task-agent.board' })`. 던지면 progress=null — 보드는 그대로 돌려준다. */
  readonly runningRuns?: () => RunningRunsResult;
  /** 경과 계산의 기준 시각(`buildRunProgressRows` 의 nowMs) · 기본 = Date.now(). */
  readonly nowMs?: number;
  /** 진전 관측을 돌릴지 — 기본 false(progress=null · «요청 안 함»). ⛔ 운영 원장에서 queryRunningRuns 는 동기 수 초(10-12 실측 4.3초)라
   *  데몬 이벤트 루프를 멈춘다 → 라우트는 `?progress=1` 일 때만 켠다(UX 수확 리뷰 should-fix). runningRuns 를 주입하면 이 값과 무관하게 돈다. */
  readonly withProgress?: boolean;
}

/** 관측 결과 → progress 칸. running 수가 `{ count: null, lowerBound }` 꼴이거나 읽지 못한 원장(unreadable)이 있으면 부분 관측으로 친다. */
function runProgressFrom(result: RunningRunsResult, nowMs: number): TaskAgentBoardProgress {
  const objectCount = result.count !== undefined && typeof result.count !== 'number' ? result.count : null;
  // 판정 출처는 관측 결과의 completeness 가 1순위 — count 꼴·unreadable 은 그것이 없을 때의 보조다.
  const partial = result.completeness === 'partial' || objectCount !== null || (result.unreadable?.length ?? 0) > 0;
  return {
    rows: buildRunProgressRows(result, nowMs),
    partial,
    lowerBound: partial ? (objectCount !== null ? objectCount.lowerBound : result.counts.running + result.counts['probable-running']) : null,
  };
}

/** 읽기 전용 — 원장이 없으면 빈 보드. 원장이 손상됐으면 `TaskAgentStateError` 를 그대로 던진다(빈 보드로 속이지 않는다). progress 는 진전 관측을 싣는다 — 관측이 던지면 progress=null(0을 «없다»로 쓰지 않는다) · 보드는 그대로. */
export function taskAgentBoard(statePath: string, deps: TaskAgentBoardDeps = {}): TaskAgentBoardResponse {
  const board = cardsBoard(statePath, { ledger: true });
  if (!deps.runningRuns && !deps.withProgress) return { board, progress: null };
  const observe = deps.runningRuns ?? (() => queryRunningRuns({ caller: 'task-agent.board' }));
  let progress: TaskAgentBoardProgress | null = null;
  try {
    progress = runProgressFrom(observe(), deps.nowMs ?? Date.now());
  } catch (error) {
    debug.log('task-agent', 'board-progress-unavailable', { error: error instanceof Error ? error.message : String(error) });
  }
  return { board, progress };
}

function releaseStatus(status: ChecklistStatus): BoardStatus {
  return status === 'green' || status === 'done' ? 'done' : status === 'red' ? 'blocked' : 'open';
}

/**
 * 릴리스 체크리스트 → 내부 팩 보드(읽기 사상). 원장이 없으면 빈 보드 — 만들지 않는다.
 * root 를 명시해 넘겨 옛 JSON 가져오기(쓰기)를 건너뛴다: 이 어댑터는 원장을 바꾸지 않는다.
 */
export function releasePackBoard(version: string, root = releaseLedgerRoot()): BoardNode[] {
  if (!existsSync(join(root, 'release', 'features.sqlite'))) return [];
  const checklist = listChecklist(version, root);
  const project = branch('project', INTERNAL_PACK_PROJECT, 'elanous (내부 팩)');
  const milestone = child(project, 'milestone', checklist.version, `판 ${checklist.version}`);
  for (const item of checklist.items) {
    milestone.children!.push({ level: 'task', id: item.id, title: item.title, status: releaseStatus(item.status), parent: milestone.id });
  }
  aggregate(project);
  return [project];
}

function cloneNode(node: BoardNode): BoardNode {
  return { ...node, ...(node.children ? { children: node.children.map(cloneNode) } : {}) };
}

/** 같은 수준·id 의 프로젝트·목표·이정표는 한 노드로 합친다(과제는 그대로 잇는다 — 다른 원천의 과제를 숨기지 않는다). */
function mergeInto(target: BoardNode[], incoming: readonly BoardNode[]): void {
  for (const node of incoming) {
    const existing = node.level === 'task' ? undefined
      : target.find((candidate) => candidate.level === node.level && candidate.id === node.id && candidate.unassigned === node.unassigned);
    if (existing) mergeInto(existing.children ??= [], node.children ?? []);
    else target.push(cloneNode(node));
  }
}

/** 두 어댑터를 합친다 — 같은 수준·id 의 노드는 한 노드로(예: 카드의 이정표 0.2.19 ⊕ 체크리스트의 판 0.2.19) · 상태를 다시 모은다. 입력은 바꾸지 않는다. */
export function mergeBoards(...boards: readonly BoardNode[][]): BoardNode[] {
  const merged: BoardNode[] = [];
  for (const board of boards) mergeInto(merged, board);
  for (const project of merged) aggregate(project);
  return merged;
}

/** 트리 안의 과제 노드 수. */
export function countBoardTasks(nodes: readonly BoardNode[]): number {
  return nodes.reduce((count, node) => count + (node.level === 'task' ? 1 : 0) + countBoardTasks(node.children ?? []), 0);
}
