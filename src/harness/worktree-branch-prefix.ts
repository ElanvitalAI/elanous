import { createHash } from 'node:crypto';

/** Prefix for disposable worktree branches created by self-implement and inspected by harness clean.
 * A successfully merged run cleans up its own worktree.
 * Clean disposable branches with `elanous harness clean`.
 */
export const WORKTREE_BRANCH_PREFIX = 'self-impl/';

/** feature 문구 → 안전한 브랜치 슬러그. 비ASCII(한국어 등)만이면 fallback. */
/** 브랜치 슬러그. ⛔ 읽기용 앞부분은 `[^a-z0-9]` 를 전부 버리므로 **한국어 골은 본문이 통째로
 *  사라지고** 뒤따르는 ASCII 보일러플레이트(`grounded: N unverified code candidates …`)만 남는다.
 *  N 이 작은 정수라 서로 다른 골이 **같은 슬러그 = 같은 브랜치 = 같은 워크트리**가 되고, 실제로 두 런이
 *  한 나무를 동시에 고쳤다(`RUN-S1` · 하루 세 번). ⇒ feature 전문의 짧은 다이제스트를 붙여 유일화한다.
 *  goalId 가 없을 때에는 feature 다이제스트가 유일화한다. goalId 가 있으면 그 식별자 다이제스트가
 *  유일화하므로, feature 문구가 달라도 같은 골은 같은 브랜치 다이제스트를 쓴다. */
export function slugifyFeature(feature: string): string {
  const s = feature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const readable = (s.length > 0 ? s : 'feature').replace(/-+$/g, '');
  return `${readable}-${createHash('sha256').update(feature).digest('hex').slice(0, 8)}`;
}

/** 하니스가 만드는 `self-impl/<슬러그>-<8자리 16진수>` 브랜치 이름.
 *  goalId 가 있으면 읽는 자(`branchGoalId`, `/(?:^|-)goalid-([^/-]+)-/`)와 호환되는
 *  `goalid-<id>-` 구간을 슬러그 앞에 싣는다. 없으면 기존과 바이트 단위로 같다. */
export function plannedSelfImplBranch(feature: string, goalId?: string, runId?: string): string {
  const slug = slugifyFeature(feature);
  const id = goalId?.trim() ?? '';
  const runSuffix = runId === undefined ? '' : `-r${runId.replace(/^run-/i, '').replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`;
  if (!id) return `${WORKTREE_BRANCH_PREFIX}${slug}${runSuffix}`;
  const readable = slug.replace(/-[0-9a-f]{8}$/, '');
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${WORKTREE_BRANCH_PREFIX}goalid-${id}-${readable}-${digest}${runSuffix}`;
}
