/**
 * 보드 일반형 — 프로젝트 › 목표 › 이정표 › 과제 (RFC-loop-agent-map §A4b①).
 *
 * «판(0.2.x)·칸» 체크리스트는 이 보드의 한 사례(내부 팩)다. 어댑터 둘은 «읽기»만 한다:
 * - `cardsBoard(statePath)` — task-agent-actions.json 의 과제 카드(project.id · goal · milestone)를 트리로.
 * - `releasePackBoard(version)` — 릴리스 체크리스트를 project=elanous · milestone=판 · task=칸 으로 사상. 원장은 쓰지 않는다.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { listChecklist, type ChecklistStatus } from '../release-loop/checklist.js';
import { readTaskAgentState, type CompletionKind, type TaskCard } from './task-hand.js';

export type BoardLevel = 'project' | 'goal' | 'milestone' | 'task';
export type BoardStatus = 'open' | 'done' | 'blocked';

export interface BoardNode {
  level: BoardLevel;
  id: string;
  title: string;
  status: BoardStatus;
  /** 과제 노드만 — 카드의 종결 종류(비면 code-pr 로 읽는다 · 칸은 싣지 않는다). */
  completion?: CompletionKind;
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
  if (card.status === 'launch-failed' || card.status === 'failed') return 'blocked';
  return card.greenProposal ? 'done' : 'open';
}

/** 과제 카드 → 프로젝트 트리. 프로젝트 없는 카드는 «무소속»(`unassigned: true` · id '') 아래 — 어떤 프로젝트 id 로도 걸러지지 않는다. */
export function cardsBoard(statePath: string): BoardNode[] {
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
      parent: milestone.id,
    });
  }
  for (const project of projects) aggregate(project);
  return projects;
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
