import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `.rules/50-engineering/classic-tui-retired.md` 래칫 시험 — classic TUI(src/dashboard) 는 은퇴:
 * 신규 기능 금지 · 삭제만(OP #91765). base 는 origin/main 과의 merge-base, 실제 git diff 를 계산한다.
 * 기대값은 전부 독립 리터럴이다(제품 상수 import 금지).
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_PREFIX = 'src/dashboard/';
// R-CTR4 — 공유 8개(classic 밖 참조가 있어 classic 은퇴와 별개). classic 밖 경로는 개별 명시.
// ① 2단계(2026-11-21): turn-outcome-shadow 정본 src/commitment/turn-outcome-shadow.ts 이동 — 목록 경로 갱신(dashboard 경로는 얇은 재수출 shim).
const SHARED_PRESERVE_COUNT = 8;
const SHARED_PRESERVE = [
  'src/tui.ts',
  'src/dashboard/plugin-route-adapter.ts',
  'src/dashboard/input/commitment-ledger.ts',
  'src/dashboard/seat-boot-preamble.ts',
  'src/dashboard/seat-local-instructions.ts',
  'src/commitment/turn-outcome-shadow.ts',
  'src/dashboard/input/seat-task-decompose.ts',
  'src/capture/tui-self-report.ts',
];

function mergeBase(): string {
  return execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: REPO, encoding: 'utf8' }).trim();
}

/** base..HEAD 의 [추가줄, 삭제줄, 경로, 신규여부]. binary 는 0으로 취급, rename 은 분리해 본다. */
function diffRows(base: string): Array<{ added: number; deleted: number; path: string; isNew: boolean }> {
  const isNewByPath = new Map<string, boolean>();
  const nameStatus = execFileSync('git', ['diff', '--name-status', '--no-renames', base, 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const [st, ...rest] = line.split('\t');
    if (st && rest.length > 0) isNewByPath.set(rest[rest.length - 1], st.charAt(0) === 'A');
  }
  const out = execFileSync('git', ['diff', '--numstat', '--no-renames', base, 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((line) => {
    const [a, d, p] = line.split('\t');
    return { added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d), path: p, isNew: isNewByPath.get(p) === true };
  });
}

/** R-CTR3 — 공용 모듈 이전을 위한 import 한 줄 교체(추가 1/삭제 1)만 제외 대상으로 인정한다. */
function importSwapCount(row: { added: number; deleted: number; path: string }): number {
  return row.path.startsWith(DASHBOARD_PREFIX) && row.path.endsWith('.ts') && row.added === 1 && row.deleted === 1 ? 1 : 0;
}

describe('classic TUI 은퇴 래칫 — src/dashboard 는 신규 0 · 삭제만', () => {
  const base = mergeBase();
  const dashboard = diffRows(base).filter((row) => row.path.startsWith(DASHBOARD_PREFIX));
  const counted = dashboard.filter((row) => importSwapCount(row) === 0);

  test('R-CTR1 — 신규 src/dashboard 파일은 0개다', () => {
    expect(dashboard.filter((row) => row.isNew).length).toBe(0);
  });

  test('R-CTR2 — src/dashboard 추가 줄 합계 ≤ 삭제 줄 합계(import 교체 제외)', () => {
    const added = counted.reduce((sum, row) => sum + row.added, 0);
    const deleted = counted.reduce((sum, row) => sum + row.deleted, 0);
    expect(added <= deleted).toBe(true);
  });

  test('R-CTR3 — 허용 목록은 확장자 .ts 의 추가 1/삭제 1 교체만 인정한다', () => {
    expect(importSwapCount({ added: 1, deleted: 1, path: 'src/dashboard/a.ts' })).toBe(1);
    expect(importSwapCount({ added: 1, deleted: 1, path: 'src/dashboard/a.tsx' })).toBe(0);
    expect(importSwapCount({ added: 2, deleted: 1, path: 'src/dashboard/a.ts' })).toBe(0);
    expect(importSwapCount({ added: 1, deleted: 1, path: 'src/tui/a.ts' })).toBe(0);
  });

  test('R-CTR4 — 공유 8개는 그대로 있다(삭제 금지)', () => {
    for (const path of SHARED_PRESERVE) {
      let exists = true;
      try {
        execFileSync('git', ['cat-file', '-e', `HEAD:${path}`], { cwd: REPO, stdio: ['ignore', 'ignore', 'ignore'] });
      } catch {
        exists = false;
      }
      if (!exists) throw new Error(`R-CTR4 — 공유 파일이 HEAD 에 없다: ${path}`);
    }
    expect(SHARED_PRESERVE.length).toBe(SHARED_PRESERVE_COUNT);
  });
});
