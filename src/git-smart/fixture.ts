/**
 * Real temp git repos for SMART-MERGE tests and the `smart-merge` sim world: a bare `origin`, a land-side clone (what the
 * land graph runs in) and an author clone (what hands push from). Squash-landing is a real `merge --squash` on main.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitAt, type GitRun } from '../git-fs/smart-run.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];

export class GitWorld {
  readonly root = mkdtempSync(join(tmpdir(), 'git-smart-world-'));
  readonly origin = join(this.root, 'origin.git');
  readonly land = join(this.root, 'land');
  readonly author = join(this.root, 'author');
  readonly lockDir = join(this.root, 'locks');
  private landGit: GitRun; private authorGit: GitRun;

  constructor(files: Record<string, string> = { 'README.md': 'hello\n' }) {
    mkdirSync(this.origin);
    this.must(gitAt(this.origin), [...ID, 'init', '-q', '--bare', '-b', 'main']);
    this.must(gitAt(this.root), [...ID, 'clone', '-q', this.origin, this.author]);
    this.authorGit = gitAt(this.author);
    this.a([...ID, 'checkout', '-q', '-b', 'main']);
    this.write(files);
    this.commit('init');
    this.a(['push', '-q', 'origin', 'main']);
    this.must(gitAt(this.root), [...ID, 'clone', '-q', this.origin, this.land]);
    this.landGit = gitAt(this.land);
    // hosts without a global identity (pregate hosts): every clone carries its own
    for (const g of [this.authorGit, this.landGit]) { this.must(g, ['config', 'user.name', 't']); this.must(g, ['config', 'user.email', 't@t']); this.must(g, ['config', 'commit.gpgsign', 'false']); }
  }

  private must(g: GitRun, args: string[]): string {
    const r = g(args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
    return r.stdout.trim();
  }
  /** git in the author clone (throws on failure). */
  a(args: string[]): string { return this.must(this.authorGit, args); }
  /** git in the land clone (throws on failure). */
  l(args: string[]): string { return this.must(this.landGit, args); }
  get landRun(): GitRun { return this.landGit; }
  get authorRun(): GitRun { return this.authorGit; }

  write(files: Record<string, string>): void {
    for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(this.author, p)), { recursive: true }); writeFileSync(join(this.author, p), c); }
  }
  commit(msg: string): string { this.a(['add', '-A']); this.a([...ID, 'commit', '-q', '--allow-empty', '-m', msg]); return this.a(['rev-parse', 'HEAD']); }
  checkout(branch: string, from?: string): void { this.a(from ? ['checkout', '-q', '-B', branch, from] : ['checkout', '-q', branch]); }
  /** Commit files on `branch` (created from `from` when given) and push it. Returns the new head. */
  onBranch(branch: string, files: Record<string, string>, msg = `edit ${branch}`, from?: string): string {
    this.checkout(branch, from);
    this.write(files);
    const h = this.commit(msg);
    this.a(['push', '-q', '-f', 'origin', branch]);
    return h;
  }
  /** Squash-land `branch` into main on origin (like GitHub squash merge). Returns the new main head. */
  squashLand(branch: string, msg = `squash ${branch}`): string {
    this.a(['fetch', '-q', 'origin']);
    this.checkout('main'); this.a(['reset', '-q', '--hard', 'origin/main']);
    this.a([...ID, 'merge', '-q', '--squash', `origin/${branch}`]);
    const h = this.commit(msg);
    this.a(['push', '-q', 'origin', 'main']);
    return h;
  }
  /** Commit straight to main on origin. */
  onMain(files: Record<string, string>, msg = 'main moves'): string {
    this.a(['fetch', '-q', 'origin']);
    this.checkout('main'); this.a(['reset', '-q', '--hard', 'origin/main']);
    this.write(files); const h = this.commit(msg); this.a(['push', '-q', 'origin', 'main']); return h;
  }
  /** Merge origin/main into `branch` by hand (author) and push. */
  mergeMainInto(branch: string): string {
    this.a(['fetch', '-q', 'origin']); this.checkout(branch); this.a(['reset', '-q', '--hard', `origin/${branch}`]);
    this.a([...ID, 'merge', '-q', '--no-edit', 'origin/main']); this.a(['push', '-q', 'origin', branch]);
    return this.a(['rev-parse', 'HEAD']);
  }
  remoteHead(branch: string): string { return this.must(gitAt(this.origin), ['rev-parse', `refs/heads/${branch}`]); }
  /** File content at a commit on origin. */
  show(ref: string, path: string): string { return this.must(gitAt(this.origin), ['show', `${ref}:${path}`]); }
  /** Files changed between two origin refs. */
  changed(a: string, b: string): string[] { return this.must(gitAt(this.origin), ['diff', '--name-only', a, b]).split('\n').filter(Boolean); }
  dispose(): void { rmSync(this.root, { recursive: true, force: true }); }
}
