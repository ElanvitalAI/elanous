import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createTempGitRemote, type TempGitRemote } from './temp-git-remote.js';

export interface TempGitRepoCommit {
  readonly message: string;
  readonly files?: Readonly<Record<string, string>>;
}

export interface CreateTempGitRepoOptions {
  /** Files committed on top of the shared empty template. */
  readonly files?: Readonly<Record<string, string>>;
  /** Additional commits, applied in order. */
  readonly commits?: readonly TempGitRepoCommit[];
  /** Local branch name for the resulting checkout. Defaults to main. */
  readonly branch?: string;
}

export interface TempGitRepo {
  readonly root: string;
  readonly repo: string;
  readonly remote: string;
  readonly gitEnv: TempGitRemote['gitEnv'];
  git(cwd: string, args: readonly string[]): string;
  cleanup(): void;
}

let template: TempGitRemote | undefined;

function sharedTemplate(): TempGitRemote {
  if (template) return template;
  template = createTempGitRemote();
  template.git(template.checkout, ['rm', 'README.md']);
  template.git(template.checkout, ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', 'empty fixture']);
  template.git(template.checkout, ['push', 'origin', 'main']);
  process.once('exit', () => template?.cleanup());
  return template;
}

function writeFiles(repo: string, files: Readonly<Record<string, string>>): void {
  for (const [path, contents] of Object.entries(files)) {
    const target = resolve(repo, path);
    const rel = relative(repo, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(path) === path) {
      throw new Error(`fixture file path must stay relative to repository: ${path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

/** Copy one process-wide, committed Git template into a disposable independent checkout. */
export function createTempGitRepo(options: CreateTempGitRepoOptions = {}): TempGitRepo {
  const base = sharedTemplate();
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-git-repo-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const git = base.git;
  const commitFixture = (args: readonly string[]): string => git(repo, [
    '-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', ...args,
  ]);
  try {
    cpSync(base.checkout, repo, { recursive: true });
    cpSync(base.remote, remote, { recursive: true });
    git(repo, ['remote', 'set-url', 'origin', remote]);
    const branch = options.branch ?? 'main';
    if (!branch.trim() || branch.startsWith('-')) throw new Error(`invalid fixture branch: ${branch}`);
    if (branch !== 'main') git(repo, ['branch', '-M', branch]);
    const initialFiles = options.files ?? {};
    if (Object.keys(initialFiles).length > 0) {
      writeFiles(repo, initialFiles);
      git(repo, ['add', '-A']);
      commitFixture(['-m', 'fixture files']);
    }
    for (const [index, commit] of (options.commits ?? []).entries()) {
      if (!commit.message.trim()) throw new Error(`fixture commit ${index + 1} needs a message`);
      writeFiles(repo, commit.files ?? {});
      git(repo, ['add', '-A']);
      commitFixture(['--allow-empty', '-m', commit.message]);
    }
    let cleaned = false;
    return {
      root, repo, remote, gitEnv: base.gitEnv, git,
      cleanup(): void {
        if (cleaned) return;
        cleaned = true;
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
