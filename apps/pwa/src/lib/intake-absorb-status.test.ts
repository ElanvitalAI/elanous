import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { INTAKE_STATUSES } from '../../../../src/intake-plane/items';
import type { AbsorbStatus } from './intake-front-door-api';
import { ABSORB_SETTLED_STATUSES, summarizeAbsorbStatus } from './intake-absorb-status';

const statusOf = (status: string, outputs?: AbsorbStatus['outputs']): AbsorbStatus => ({ id: 'id-1', status, outputs });

describe('summarizeAbsorbStatus', () => {
  test.each([
    ['new', '대기 중', false],
    ['queued', '대기 중', false],
    ['absorbed', '흡수됨', true],
    ['routed', '다른 갈래로 넘김', true],
    ['checked', '확인됨', true],
    ['discarded', '버림', true],
    ['deferred', '미룸', false],
    ['future-status', 'future-status', false],
    ['toString', 'toString', false],
  ] as const)('%s → %s (settled=%s)', (status, label, settled) => {
    expect(summarizeAbsorbStatus(statusOf(status))).toEqual({ label, settled, noteRef: null });
  });

  test('첫 note ref 를 반환하고 다른 출력은 건너뛴다', () => {
    expect(summarizeAbsorbStatus(statusOf('absorbed', [
      { kind: 'goal', ref: 'goal-1' },
      { kind: 'note', ref: 'notes/first.md' },
      { kind: 'note', ref: 'notes/second.md' },
    ]))).toEqual({ label: '흡수됨', settled: true, noteRef: 'notes/first.md' });
  });

  test('null 조회는 찾을 수 없음이며 재조회 대상이다', () => {
    expect(summarizeAbsorbStatus(null)).toEqual({ label: '찾을 수 없음', settled: false, noteRef: null });
  });

  test('끝난 상태 목록은 서버 SETTLED 와 일치한다', () => {
    const source = readFileSync(resolve(import.meta.dir, '../../../../src/intake-plane/items.ts'), 'utf8');
    const settled = source.match(/const SETTLED[^\n]*new Set\(\[([^\]]+)\]\)/)?.[1];
    expect(settled).toBeDefined();
    const serverStatuses = [...settled!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(serverStatuses.sort()).toEqual([...ABSORB_SETTLED_STATUSES].sort());
    expect(serverStatuses.every((status) => INTAKE_STATUSES.includes(status as typeof INTAKE_STATUSES[number]))).toBe(true);
  });
});
