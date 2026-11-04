interface DoctorInstallReport {
  report?: { ok?: unknown };
  gitInstall?: { ran?: unknown; ok?: unknown; permissionDenied?: unknown };
}

/** True only when doctor is otherwise healthy and its git install failed specifically at sudo authorization. */
export function isUnprivilegedGitRepairOnlyFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as DoctorInstallReport;
  return result.report?.ok === true
    && result.gitInstall?.ran === true
    && result.gitInstall?.ok === false
    && result.gitInstall?.permissionDenied === true;
}

if (import.meta.main) {
  const reportPath = process.argv.at(-1);
  if (process.argv.length < 3 || !reportPath) process.exit(2);
  try {
    const report = JSON.parse(await Bun.file(reportPath).text()) as unknown;
    process.exit(isUnprivilegedGitRepairOnlyFailure(report) ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
