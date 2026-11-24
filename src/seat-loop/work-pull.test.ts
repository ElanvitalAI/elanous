import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimCell, pullNextCellFor, type WorkCell } from './work-pull.js';

const NOW = 1_700_000_000_000;

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'work-pull-')), 'work-claims.db');
}

function cell(id: string, overrides: Partial<WorkCell> = {}): WorkCell {
  return { id, title: `칸 ${id} 본문·판정식`, status: 'yellow', owner: null, priority: 'P2', ...overrides };
}

interface Claimed {
  cell: WorkCell;
  turnOpensWith: string;
}

function mustClaim(seat: string, queue: WorkCell[], db: string, spaceOfSeat?: string | null): Claimed {
  const r = pullNextCellFor(seat, queue, { db, now: NOW, spaceOfSeat });
  if (r.kind !== 'claimed') throw new Error(`expected claim for ${seat}, got: ${JSON.stringify(r)}`);
  return r;
}

describe('SEAT-WORK-PULL — 선택 순서(owner=자리 → 주인 없음 → 같은 스페이스 → 우선순위)', () => {
  test('소유 우선: 낮은 우선순위 내 칸이 높은 우선순위 주인 없음 칸보다 먼저', () => {
    const db = tmpDb();
    const queue = [
      cell('u-same-p0', { priority: 'P0', space: 's1' }),
      cell('mine-low', { owner: 'HAND-A', priority: 'P2', space: 's9' }),
    ];
    const first = mustClaim('HAND-A', queue, db, 's1');
    expect(first.cell.id).toBe('mine-low');
  });

  test('주인 없음 그룹: 같은 스페이스 P1 이 다른 스페이스 P0 보다 먼저 · 그 다음 우선순위', () => {
    const db = tmpDb();
    const queue = [
      cell('u-other-p0', { priority: 'P0', space: 's2' }),
      cell('u-same-p1', { priority: 'P1', space: 's1' }),
      cell('u-same-p0', { priority: 'P0', space: 's1' }),
    ];
    expect(mustClaim('HAND-A', queue, db, 's1').cell.id).toBe('u-same-p0');
    expect(mustClaim('HAND-A', queue, db, 's1').cell.id).toBe('u-same-p1');
    expect(mustClaim('HAND-A', queue, db, 's1').cell.id).toBe('u-other-p0');
  });

  test('타 자리 소유 칸은 큐 후보가 아니다', () => {
    const db = tmpDb();
    const queue = [
      cell('foreign-p0', { owner: 'HAND-Z', priority: 'P0', space: 's1' }),
      cell('mine-p2', { owner: 'HAND-A', priority: 'P2', space: 's1' }),
    ];
    expect(mustClaim('HAND-A', queue, db, 's1').cell.id).toBe('mine-p2');
  });
});

describe('SEAT-WORK-PULL — 원자 claim(두 자리가 같은 칸을 잡지 않게)', () => {
  test('같은 칸 이중 claim 거부', () => {
    const db = tmpDb();
    expect(claimCell(db, 'c1', 'HAND-A', NOW)).not.toBeNull();
    expect(claimCell(db, 'c1', 'HAND-B', NOW + 1)).toBeNull();
  });

  test('IDLE 자리 3 · 큐 5칸 → 서로 다른 칸 3개 claim·턴 개시 페이로드에 칸 본문', () => {
    const db = tmpDb();
    const queue = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => cell(id, { priority: 'P0', space: 's1' }));
    const ids: string[] = [];
    for (const seat of ['HAND-A', 'HAND-B', 'HAND-C']) {
      const r = mustClaim(seat, queue, db, 's1');
      expect(r.turnOpensWith).toContain(r.cell.id);
      expect(r.turnOpensWith).toContain('칸');
      ids.push(r.cell.id);
    }
    expect(new Set(ids).size).toBe(3);
  });

  test('경합 뒤 재당기기: claim 된 칸은 다음 pull 에서 제외', () => {
    const db = tmpDb();
    const queue = [cell('c1', { priority: 'P0' }), cell('c2', { priority: 'P1' })];
    expect(mustClaim('HAND-A', queue, db).cell.id).toBe('c1');
    expect(mustClaim('HAND-B', queue, db).cell.id).toBe('c2');
  });
});

describe('SEAT-WORK-PULL — «일감 0» 은 큐가 비었을 때만(근거 = 큐 조회 결과)', () => {
  test('전부 완료·타 자리 소유 → 일감 0 + 큐 조회 근거 줄', () => {
    const db = tmpDb();
    const queue = [
      cell('done-1', { status: 'green' }),
      cell('foreign-1', { owner: 'HAND-Z', priority: 'P0' }),
    ];
    const r = pullNextCellFor('HAND-A', queue, { db, now: NOW });
    if (r.kind !== 'no-work') throw new Error(`expected no-work, got: ${JSON.stringify(r)}`);
    expect(r.evidence).toContain('일감 0');
    expect(r.evidence).toContain('큐 조회 결과');
    expect(r.evidence).toContain('2칸');
  });

  test('큐 원문 0칸 → 일감 0 근거 줄', () => {
    const r = pullNextCellFor('HAND-A', [], { db: tmpDb(), now: NOW });
    if (r.kind !== 'no-work') throw new Error(`expected no-work, got: ${JSON.stringify(r)}`);
    expect(r.evidence).toContain('0칸');
  });
});
