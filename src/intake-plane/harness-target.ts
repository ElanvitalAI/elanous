export type DaemonHarnessTarget =
  | { ok: true; repo: string; source: 'config' | 'cwd' }
  | { ok: false; reason: string };

/** Read-only target selection. An explicitly configured path must never fall back to the daemon cwd. */
export function resolveDaemonHarnessTarget({ configured, cwd, isGitRepo, allowNonGit = false }: {
  configured?: string;
  cwd: string;
  isGitRepo: (path: string) => boolean;
  allowNonGit?: boolean;
}): DaemonHarnessTarget {
  if (configured !== undefined) {
    if (allowNonGit || isGitRepo(configured)) return { ok: true, repo: configured, source: 'config' };
  } else if (allowNonGit || isGitRepo(cwd)) {
    return { ok: true, repo: cwd, source: 'cwd' };
  }
  return {
    ok: false,
    reason: `하니스 대상 저장소가 없습니다 — \`elanous config set harness.defaultRepo <저장소 경로>\` 로 정하세요 (지금 폴더: ${cwd} 는 git 저장소가 아닙니다)`,
  };
}
