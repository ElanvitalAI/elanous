// ── SEAT-WORK-PULL — 깨우기 문구가 아니라 일 당기기 (OP #139787 · 0.3.35 P0) ──
//
// 칸 요구 원문: «자리가 IDLE 이고 맡은 일이 없으면 런타임이 로스터 큐(현재 판 · owner=자리 → 주인 없음 →
// 같은 스페이스 순 · 우선순위)에서 다음 칸을 골라 그 칸 본문·판정식과 함께 턴을 연다 · «일감 0» 은
// 큐가 비었을 때만(근거 = 큐 조회 결과) · 두 자리가 같은 칸을 잡지 않게 claim 원자 처리».
//
// 원자 claim 은 msg-wake 의 claimWake 원형(msg-wake.ts:706 — SQLite 단일 upsert 가 쓰기 잠금 아래
// 판정)을 그대로 따른다: INSERT … ON CONFLICT DO NOTHING 의 changes 로 두 동시 pull 의 승자를 한 번에
// 정한다. claim 은 창(debounce)이 아니라 칸 소유 이동이므로 창 조건 없이 첫 주인만 남는다.

import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { effectiveInstanceRoot } from '../instance/resolve.js';

export type WorkCellPriority = 'P0' | 'P1' | 'P2';

/** 로스터 큐의 칸 — 현재 판 원문(checklist-bulletin)의 칸 구조에서 온다. space 는 선택 정렬용 소속(선택). */
export interface WorkCell {
  id: string;
  title: string;
  status: string;
  owner: string | null;
  priority: WorkCellPriority;
  space?: string | null;
}

export interface WorkPullDeps {
  stateRoot?: string;
}

export interface WorkClaim {
  db: string;
  cellId: string;
  seat: string;
  token: string;
}

export type WorkPullResult =
  | { kind: 'claimed'; claim: WorkClaim; cell: WorkCell; turnOpensWith: string }
  | { kind: 'no-work'; evidence: string };

const PRIORITY_RANK: Record<WorkCellPriority, number> = { P0: 0, P1: 1, P2: 2 };
const DONE_STATUS = new Set(['green', 'done', 'complete']);
const BLOCKED_STATUS = new Set(['red', 'blocked']);

export function workClaimDbPath(deps: WorkPullDeps = {}): string {
  return join(deps.stateRoot ?? effectiveInstanceRoot(), 'msg', 'work-claims.db');
}

function openWorkDb(db: string): Database {
  mkdirSync(dirname(db), { recursive: true });
  const conn = new Database(db);
  try {
    conn.exec('PRAGMA busy_timeout = 2000');
    conn.exec('CREATE TABLE IF NOT EXISTS work_cell_claims (cell_id TEXT PRIMARY KEY, seat TEXT NOT NULL, at INTEGER NOT NULL, token TEXT NOT NULL)');
    return conn;
  } catch (error) {
    conn.close();
    throw error;
  }
}

/** 원자 칸 claim — 두 동시 pull 이 같은 칸을 못 잡게: INSERT … ON CONFLICT DO NOTHING 이 승자를 판정한다. */
export function claimCell(db: string, cellId: string, seat: string, now: number): WorkClaim | null {
  const token = `${now} ${process.pid} ${randomUUID()}`;
  const conn = openWorkDb(db);
  try {
    const changed = conn
      .query('INSERT INTO work_cell_claims (cell_id, seat, at, token) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(cell_id) DO NOTHING')
      .run(cellId, seat, now, token).changes;
    return changed === 1 ? { db, cellId, seat, token } : null;
  } finally {
    conn.close();
  }
}

function claimedCellIds(db: string): Set<string> {
  const conn = openWorkDb(db);
  try {
    return new Set(conn.query('SELECT cell_id FROM work_cell_claims').values().map((row) => String(row[0])));
  } finally {
    conn.close();
  }
}

/** 큐 후보: 현재 판에서 아직 끝나지 않은(완료·막힘 제외) 내 칸·주인 없음 칸. 타 자리 소유는 남의 일이다. */
function isCandidate(c: WorkCell, seat: string): boolean {
  if (DONE_STATUS.has(c.status) || BLOCKED_STATUS.has(c.status)) return false;
  return c.owner === seat || c.owner == null || c.owner === '';
}

export interface PullOptions {
  db: string;
  now: number;
  /** 당기는 자리의 스페이스 소속 — «같은 스페이스 순» 정렬 키(null 이면 스페이스 정렬이 비활성). */
  spaceOfSeat?: string | null;
}

/**
 * 다음 칸을 당긴다: 정렬(owner=자리 → 주인 없음 · 그 안에서 같은 스페이스 → 우선순위) → 원자 claim →
 * 턴 개시 페이로드(칸 본문 포함). 큐가 비었거나 후보 전부 이미 claim 이면 «일감 0» + 큐 조회 근거 줄.
 */
export function pullNextCellFor(seat: string, cells: WorkCell[], opts: PullOptions): WorkPullResult {
  const total = cells.length;
  const done = cells.filter((c) => DONE_STATUS.has(c.status)).length;
  const blocked = cells.filter((c) => BLOCKED_STATUS.has(c.status)).length;
  const foreign = cells.filter(
    (c) => !isCandidate(c, seat) && !DONE_STATUS.has(c.status) && !BLOCKED_STATUS.has(c.status),
  ).length;

  const mine = cells.filter((c) => c.owner === seat && !DONE_STATUS.has(c.status) && !BLOCKED_STATUS.has(c.status));
  const unowned = cells.filter((c) => (c.owner == null || c.owner === '') && !DONE_STATUS.has(c.status) && !BLOCKED_STATUS.has(c.status));
  const waiting = mine.length + unowned.length;

  const claimed = claimedCellIds(opts.db);
  const rank = (list: WorkCell[]): WorkCell[] =>
    list
      .filter((c) => !claimed.has(c.id))
      .sort((a, b) => {
        const sa = a.space != null && a.space === opts.spaceOfSeat ? 0 : 1;
        const sb = b.space != null && b.space === opts.spaceOfSeat ? 0 : 1;
        return (
          sa - sb ||
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        );
      });

  const ordered = [...rank(mine), ...rank(unowned)];
  if (ordered.length === 0) {
    return {
      kind: 'no-work',
      evidence: `일감 0 — 큐 조회 결과: 현재 판 ${total}칸 · 대상(내 칸·주인 없음) ${waiting}칸 중 미claim 0칸 · 완료 ${done} · 막힘 ${blocked} · 타 자리 소유 ${foreign}`,
    };
  }

  for (const cell of ordered) {
    const claim = claimCell(opts.db, cell.id, seat, opts.now);
    if (claim) {
      return {
        kind: 'claimed',
        claim,
        cell,
        turnOpensWith: `[SEAT-WORK-PULL · 칸 당기기] ${cell.id}(${cell.priority}${cell.owner === seat ? ' · 내 칸' : ' · 주인 없음'}) — ${cell.title}`,
      };
    }
  }
  return {
    kind: 'no-work',
    evidence: `일감 0 — 큐 조회 결과: 대상 ${waiting}칸 전부 다른 자리가 이미 claim(원자 claim 경합 · 현재 판 ${total}칸)`,
  };
}
