import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';

export type RevertGuardResult = { reverted: string[]; protected: string[]; staleDeleted?: string[]; outsideDeleted?: string[]; warning?: string };

function isTargetPath(file: string, targets: readonly string[]): boolean {
  return targets.some((target) => {
    const path = target.replace(/^\.\//, '').replace(/\/+$/, '');
    return path !== '' && (file === path || file.startsWith(`${path}/`));
  });
}

/** Compare the worktree's exact bytes with blobs from recent HEAD ancestry, before add -A. */
export function dropStaleReverts(cwd: string, targets: readonly string[], runId: string, depth = 50, base?: string): RevertGuardResult {
  const result: RevertGuardResult = { reverted: [], protected: [] };
  const git = (...args: string[]): Buffer => execFileSync('git', args, { cwd, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 240);
  try {
    const limit = Number.isSafeInteger(depth) && depth > 0 ? depth : 50;
    const commits = git('rev-list', `--max-count=${limit + 1}`, 'HEAD').toString('utf8').trim().split('\n');
    const changed = git('diff', '--name-only', '--diff-filter=M', '-z', 'HEAD', '--').toString('utf8').split('\0').filter(Boolean);
    const staged = git('diff', '--cached', '--name-only', '--diff-filter=M', '-z', 'HEAD', '--').toString('utf8').split('\0').filter(Boolean);
    const deleted = new Set([
      ...git('diff', '--name-only', '--diff-filter=D', '-z', 'HEAD', '--').toString('utf8').split('\0').filter(Boolean),
      ...git('diff', '--cached', '--name-only', '--diff-filter=D', '-z', 'HEAD', '--').toString('utf8').split('\0').filter(Boolean),
    ]);
    for (const file of deleted) {
      if (isTargetPath(file, targets)) continue;
      try {
        // add -A stages the worktree: even a dangling symlink replaces the staged deletion.
        try {
          lstatSync(join(cwd, file));
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        // ls-tree returning an empty entry means absent; a failed lookup must not look like absence.
        const headEntry = git('ls-tree', 'HEAD', '--', file).toString('utf8').trim();
        if (!/^\d+ blob [0-9a-f]+\t/.test(headEntry)) continue;
        const baseEntry = base ? git('ls-tree', base, '--', file).toString('utf8').trim() : null;
        if (baseEntry === '' && base) {
          git('checkout', 'HEAD', '--', file);
          (result.staleDeleted ??= []).push(file);
          result.reverted.push(file);
          debug.log('self-implement.revert-guard', 'reverted-stale-delete', { runId, files: [file] });
        } else {
          (result.outsideDeleted ??= []).push(file);
          debug.log('self-implement.revert-guard', 'outside-delete', { runId, files: [file] }, { level: 'warn' });
        }
      } catch (error) {
        result.warning = `git inspection/checkout failed for ${file}: ${reason(error)}`;
        debug.log('self-implement.revert-guard', 'fail-open', { runId, reason: result.warning }, { level: 'warn' });
      }
    }
    for (const file of new Set([...changed, ...staged])) {
      try {
        if (!lstatSync(join(cwd, file)).isFile()) continue;
        const current = readFileSync(join(cwd, file));
        const rawOid = execFileSync('git', ['hash-object', '--stdin'], { cwd, input: current, timeout: 20_000 }).toString('utf8').trim();
        const headEntry = git('ls-tree', 'HEAD', '--', file).toString('utf8').trim();
        const head = /^\d+ blob ([0-9a-f]+)\t/.exec(headEntry)?.[1];
        if (!head) continue;
        const sameBytes = (oid: string): boolean => oid === rawOid || git('cat-file', 'blob', oid).equals(current);
        if (sameBytes(head)) continue;
        let matchedCommit: string | undefined;
        const inspectedOids = new Set<string>();
        for (const commit of commits.slice(1)) {
          // A path may not have existed in an ancestor; that is not a failed inspection.
          const blob = git('ls-tree', commit, '--', file).toString('utf8').trim();
          const oid = /^\d+ blob ([0-9a-f]+)\t/.exec(blob)?.[1];
          if (oid && !inspectedOids.has(oid)) {
            if (sameBytes(oid)) { matchedCommit = commit; break; }
            inspectedOids.add(oid);
          }
        }
        if (!matchedCommit) continue;
        if (isTargetPath(file, targets)) {
          result.protected.push(file);
          debug.log('self-implement.revert-guard', 'protected-target', { runId, files: [file], matchedCommit }, { level: 'warn' });
        } else {
          git('checkout', 'HEAD', '--', file);
          result.reverted.push(file);
          debug.log('self-implement.revert-guard', 'reverted-stale', { runId, files: [file], matchedCommit });
        }
      } catch (error) {
        result.warning = `git inspection/checkout failed for ${file}: ${reason(error)}`;
        debug.log('self-implement.revert-guard', 'fail-open', { runId, reason: result.warning }, { level: 'warn' });
      }
    }
  } catch (error) {
    result.warning = `git inspection failed: ${reason(error)}`;
    debug.log('self-implement.revert-guard', 'fail-open', { runId, reason: result.warning }, { level: 'warn' });
  }
  return result;
}
