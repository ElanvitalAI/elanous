// Release path = what publishing reads directly: the release scripts and graph, plus the manifest, release notes and cut schedule
// in `src/release-loop/`. The checklist store (`checklist.ts`, `feature-store.ts`) is shared ops ledger code — the gate catches its regressions (OP 10-03).
export const RELEASE_PATH_PREFIXES = ['scripts/release-loop/', 'graphs/release/', 'src/release-loop/manifest', 'src/release-loop/release-note', 'src/release-loop/release-schedule'] as const;
export const RELEASE_PATH_LABEL = 'elanous:release-path';

/** Flatten every GitHub PR file page, including the source of a rename. */
export function releasePrFilePaths(pages: unknown): string[] {
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every((page: unknown) => Array.isArray(page) && page.every((file: unknown) =>
    !!file && typeof file === 'object' && 'filename' in file && typeof file.filename === 'string'
      && (!('previous_filename' in file) || typeof file.previous_filename === 'string')
      && (!('status' in file) || file.status !== 'renamed' || ('previous_filename' in file && typeof file.previous_filename === 'string'))))) {
    throw new Error('gh api PR files returned an invalid file list');
  }
  return pages.flatMap((page: Array<{ filename: string; previous_filename?: string }>) =>
    page.flatMap((file) => file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]));
}

/** git diff --name-status -z emits status then one path (or two for rename/copy). */
export function releaseGitDiffPaths(output: string): string[] {
  const tokens = output.split('\0');
  if (tokens.pop() !== '') throw new Error('invalid NUL-delimited git diff');
  const paths: string[] = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!status || !/^[ACDMRTUXB][0-9]*$/.test(status)) throw new Error('invalid git diff status');
    const count = /^[RC]/.test(status) ? 2 : 1;
    for (let n = 0; n < count; n++) {
      const path = tokens[i++];
      if (!path) throw new Error('missing git diff path');
      paths.push(path);
    }
  }
  return paths;
}

/** Evaluate the paths from the opened PR, not the requested goal or local working tree. */
export function releasePathHold(paths: readonly string[]): string | undefined {
  return paths.find((path) => RELEASE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

/** Fixed opening of the hold comment — also how a PR held by several merge surfaces (or polls) is recognised, so it is posted once. */
export const RELEASE_PATH_HOLD_MARKER = 'OP approval required: automatic merge held because this PR changes ';

export function releasePathHoldComment(path: string): string {
  return `${RELEASE_PATH_HOLD_MARKER}${path}.`;
}

/** True when the PR's issue-comment pages (gh api --paginate --slurp) already carry a hold comment. */
export function releasePathHoldAlreadyPosted(pages: unknown): boolean {
  if (!Array.isArray(pages)) throw new Error('gh api PR comments returned an invalid list');
  return pages.some((page: unknown) => Array.isArray(page) && page.some((comment: unknown) =>
    !!comment && typeof comment === 'object' && 'body' in comment && typeof comment.body === 'string' && comment.body.startsWith(RELEASE_PATH_HOLD_MARKER)));
}

/** Unknown comment history must not drop the hold comment: when it cannot be read, post (a duplicate beats a silent hold). */
export function releasePathHoldShouldPost(readPages: () => unknown): boolean {
  try { return !releasePathHoldAlreadyPosted(readPages()); } catch { return true; }
}

export function releasePathHoldCommentsArgs(pr: string | number): string[] {
  return ['api', '--paginate', '--slurp', '--method', 'GET', '-f', 'per_page=100', `repos/{owner}/{repo}/issues/${pr}/comments`];
}
