// A real, local Git transport fixture for tests that need an origin/main.
// No GitHub API, network server, or pack protocol is simulated here.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempGitRemote {
  readonly root: string;
  readonly remote: string;
  readonly seed: string;
  readonly checkout: string;
  /** Pass this to child processes that run Git against the fixture. */
  readonly gitEnv: Omit<NodeJS.ProcessEnv, 'NODE_ENV'>;
  git(cwd: string, args: readonly string[]): string;
  advanceMain(count: number): void;
  removeOrigin(): void;
  cleanup(): void;
}

export function createTempGitRemote(): TempGitRemote {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-git-remote-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const checkout = join(root, 'checkout');
  const globalConfig = join(root, 'gitconfig');
  writeFileSync(globalConfig, '');
  const gitEnv: Omit<NodeJS.ProcessEnv, 'NODE_ENV'> = {};
  // Undefined entries remove inherited Git state from both direct Git calls
  // and the invoking CLI child, without replacing its isolated HOME/state.
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) gitEnv[key] = undefined;
  Object.assign(gitEnv, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_ALLOW_PROTOCOL: 'file',
  });
  const git = (cwd: string, args: readonly string[]): string => {
    const result = spawnSync('git', [...args], { cwd, env: { ...process.env, ...gitEnv }, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
    }
    return result.stdout.trim();
  };
  let cleaned = false;
  let nextCommitIndex = 0;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    rmSync(root, { recursive: true, force: true });
  };
  try {
    // Set the bare HEAD explicitly: a host's init.defaultBranch may be master.
    git(root, ['init', '--bare', '-b', 'main', remote]);
    git(root, ['init', '-b', 'main', seed]);
    git(seed, ['config', 'user.email', 'test@example.com']);
    git(seed, ['config', 'user.name', 'Test User']);
    writeFileSync(join(seed, 'README.md'), 'base\n');
    git(seed, ['add', 'README.md']);
    git(seed, ['commit', '-m', 'base']);
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', '-u', 'origin', 'main']);
    git(root, ['clone', remote, checkout]);
    return {
      root, remote, seed, checkout, gitEnv, git, cleanup,
      advanceMain(count: number): void {
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('advanceMain count must be a nonnegative integer');
        for (let index = 0; index < count; index += 1) {
          const commitIndex = nextCommitIndex++;
          writeFileSync(join(seed, 'README.md'), `commit ${commitIndex}\n`);
          git(seed, ['add', 'README.md']);
          git(seed, ['commit', '-m', `ahead ${commitIndex}`]);
        }
        if (count > 0) git(seed, ['push', 'origin', 'main']);
        git(checkout, ['fetch', 'origin']);
      },
      removeOrigin(): void { git(checkout, ['remote', 'remove', 'origin']); },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
