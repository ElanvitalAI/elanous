import { execFileSync } from 'node:child_process';
import { getUserConfig, type UserConfig } from '../user-config.js';

const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface RepositoryNameOptions {
  /** Explicit --repo value. */
  repo?: string;
  config?: Pick<UserConfig, 'harness'>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  executeGh?: (args: string[]) => string;
  /** Test seam. Default asks git whether cwd is a work tree. */
  insideGitWorkTree?: (cwd: string) => boolean;
}

/** Resolve the GitHub owner/name without asking gh outside a git checkout. */
export function resolveRepositoryName(options: RepositoryNameOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const valid = (source: string, candidate: string | undefined): string | undefined => {
    if (!candidate?.trim()) return undefined;
    const name = candidate.trim();
    if (!REPOSITORY_NAME.test(name) || name.includes('..')) {
      throw new Error(`invalid ${source} (expected owner/name): ${candidate}`);
    }
    return name;
  };
  const flag = valid('--repo', options.repo);
  if (flag) return flag;
  const configured = valid('harness.repo', (options.config ?? getUserConfig()).harness?.repo);
  if (configured) return configured;
  const inherited = valid('GH_REPO', env.GH_REPO);
  if (inherited) return inherited;
  const insideGit = options.insideGitWorkTree ?? ((dir) => {
    try {
      return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: dir, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() === 'true';
    } catch { return false; }
  });
  if (insideGit(cwd)) {
    try {
      const name = (options.executeGh ?? ((args) => execFileSync('gh', args, {
        cwd, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], env,
      })))(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
      if (REPOSITORY_NAME.test(name) && !name.includes('..')) return name;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const line = message.split(/\r?\n/).map((row) => row.trim()).find((row) => row && !/^at\s/.test(row));
      throw new Error(line || '저장소 이름 없음 — --repo 또는 harness.repo 설정');
    }
  }
  throw new Error('저장소 이름 없음 — --repo 또는 harness.repo 설정');
}
