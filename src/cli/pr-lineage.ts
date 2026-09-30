const SELF_IMPL_PREFIX = 'self-impl/';
const LINEAGE_HASH_SUFFIX = /-[0-9a-f]{7,8}$/i;
const RUN_SUFFIX = /-r[a-z0-9]{6}$/i;
/**
 * Formal new-generation segment after `self-impl/`: dash-delimited `-goalid-<id>-`.
 * ⛔ A substring like `mygoalid-foo` is not that segment — it has no leading `-`/`^` boundary.
 */
const GOAL_ID_SEGMENT = /(?:^|-)goalid-([^/-]+)-/;

/** Lineage slug of a harness branch: `self-impl/<slug>-<7–8 hex>`, or null when the name is not that shape. */
export function branchLineageSlug(branch: string): string | null {
  if (!branch.startsWith(SELF_IMPL_PREFIX)) return null;
  const rest = branch.slice(SELF_IMPL_PREFIX.length).replace(RUN_SUFFIX, '');
  const hash = LINEAGE_HASH_SUFFIX.exec(rest);
  return hash ? rest.slice(0, rest.length - hash[0].length) : rest;
}

/**
 * Goal id carried by a new-generation harness branch (`…-goalid-<id>-…`).
 * ⛔ Legacy path-slug branches have no such marker — this does not reconstruct one.
 * ⛔ The trailing 7–8 hex hash is not the goal id.
 * ⛔ Only the dash-delimited `-goalid-<id>-` segment after `self-impl/` counts.
 */
export function branchGoalId(branch: string): string | null {
  if (!branch.startsWith(SELF_IMPL_PREFIX)) return null;
  const rest = branch.slice(SELF_IMPL_PREFIX.length);
  const match = GOAL_ID_SEGMENT.exec(rest);
  return match?.[1] ?? null;
}

export function findSiblingPrs(
  currentBranch: string,
  openPrs: readonly { number: number; headRefName: string }[],
): { number: number; headRefName: string }[] {
  const slug = branchLineageSlug(currentBranch);
  if (slug === null) return [];
  return openPrs.filter((pr) => (
    pr.headRefName !== currentBranch && branchLineageSlug(pr.headRefName) === slug
  ));
}
