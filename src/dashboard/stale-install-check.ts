import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { readInstallMetadataCommit } from '../version/code-revision.js';

export type StaleInstallResult = {
  state: 'same' | 'changed' | 'unknown' | 'not-installed';
  bootCommit: string | undefined;
  installedCommit: string | undefined;
};

export const STALE_INSTALL_CHECK_INTERVAL_MS = 60_000;

/** Identify the immutable installed version containing this module, never the session cwd. */
export function versionedDashboardInstallDir(
  codeRoot: string,
  installRoot = join(homedir(), '.local', 'share', 'elanous'),
): string | undefined {
  try {
    const packageRoot = realpathSync(codeRoot);
    if (basename(packageRoot) !== 'elanous' || basename(dirname(packageRoot)) !== 'node_modules') return undefined;
    const versionDir = dirname(dirname(packageRoot));
    if (dirname(versionDir) !== resolve(installRoot, 'versions')) return undefined;
    return versionDir;
  } catch {
    return undefined;
  }
}

export function createStaleInstallCheck(input: {
  bootCommit: string | undefined;
  readInstalledCommit: () => string | undefined;
  now: () => number;
  codeRoot?: string;
  installRoot?: string;
}) {
  const installed = input.codeRoot === undefined
    || versionedDashboardInstallDir(input.codeRoot, input.installRoot) !== undefined;
  const notifiedCommits = new Set<string>();
  let lastReadAt = -Infinity;
  let lastResult: StaleInstallResult | undefined;
  const check = (): StaleInstallResult => {
    if (!installed) return { state: 'not-installed', bootCommit: input.bootCommit, installedCommit: undefined };
    const time = input.now();
    if (lastResult && time - lastReadAt < STALE_INSTALL_CHECK_INTERVAL_MS) return lastResult;
    lastReadAt = time;
    let installedCommit: string | undefined;
    try { installedCommit = input.readInstalledCommit(); } catch { /* unreadable metadata */ }
    const result: StaleInstallResult = {
      state: !input.bootCommit || !installedCommit
        ? 'unknown'
        : input.bootCommit === installedCommit ? 'same' : 'changed',
      bootCommit: input.bootCommit,
      installedCommit,
    };
    lastResult = result;
    return result;
  };
  return {
    check,
    shouldNotify(result: StaleInstallResult): boolean {
      if (result.state !== 'changed' || !result.installedCommit || notifiedCommits.has(result.installedCommit)) return false;
      notifiedCommits.add(result.installedCommit);
      return true;
    },
  };
}

/** Only the current pointer is polled; boot metadata is read once from the immutable version. */
export function readDashboardBootCommit(versionDir: string): string | undefined {
  return readInstallMetadataCommit(join(versionDir, 'install.json'));
}

export function readCurrentInstalledCommit(installRoot = join(homedir(), '.local', 'share', 'elanous')): string | undefined {
  return readInstallMetadataCommit(join(installRoot, 'current', 'install.json'));
}
