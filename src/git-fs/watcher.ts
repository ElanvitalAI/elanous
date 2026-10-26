// ── git-fs watcher ──
//
// fs.watchFile() polls the small set of entries whose replacement indicates
// the branch or the current commit moved:
//
//   <gitDir>/HEAD                    branch switch / detach
//   <commonGitDir>/packed-refs       git gc packs loose refs
//   <commonGitDir>/refs/heads/<br>   a new commit lands on the
//                                    current branch
//
// We rewire the per-branch watcher whenever HEAD flips, because
// the watched ref file path changes with the active branch.
//
// Intentionally NOT watching untracked files — that would require
// watching the whole working tree. The dirty probe is throttled
// separately.

import { unwatchFile, watchFile, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { GitHeadInfo } from './types.js';
import type { LocatedGit } from './locate.js';

type Listener = () => void;

export class GitFileWatcher {
  private readonly listeners = new Set<Listener>();
  private headWatcher: { stop: () => void } | null = null;
  private refWatcher: { stop: () => void } | null = null;
  private packedRefsWatcher: { stop: () => void } | null = null;
  private currentBranch: string | null = null;
  private disposed = false;

  constructor(
    private readonly located: LocatedGit,
    private readonly initialHead: GitHeadInfo | null,
  ) {
    this.currentBranch = initialHead?.branch ?? null;
    this.installHeadWatcher();
    this.installRefWatcher();
    this.installPackedRefsWatcher();
  }

  /** Call `fn` whenever HEAD or the current branch's ref file
   *  changes. Returns an unsubscribe function. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Update the watched branch when the caller re-reads HEAD and
   *  finds the branch moved (e.g., after a `git switch`). The
   *  watcher re-binds the ref-file watch to the new branch. */
  retargetForHead(head: GitHeadInfo | null): void {
    const next = head?.branch ?? null;
    if (next === this.currentBranch) return;
    this.currentBranch = next;
    if (this.refWatcher) { this.refWatcher.stop(); this.refWatcher = null; }
    this.installRefWatcher();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    if (this.headWatcher) { try { this.headWatcher.stop(); } catch {} }
    if (this.refWatcher) { try { this.refWatcher.stop(); } catch {} }
    if (this.packedRefsWatcher) { try { this.packedRefsWatcher.stop(); } catch {} }
    this.headWatcher = null;
    this.refWatcher = null;
    this.packedRefsWatcher = null;
  }

  private fire(): void {
    if (this.disposed) return;
    for (const fn of this.listeners) {
      try { fn(); } catch { /* never let a listener crash the watcher */ }
    }
  }

  private watchPath(path: string): { stop: () => void } {
    const onChange = (current: Stats, previous: Stats) => {
      if (current.mtimeMs !== previous.mtimeMs || current.ino !== previous.ino || current.size !== previous.size) {
        this.fire();
      }
    };
    watchFile(path, { interval: 250, persistent: false }, onChange);
    return { stop: () => unwatchFile(path, onChange) };
  }

  private installHeadWatcher(): void {
    try {
      // Git replaces HEAD atomically via HEAD.lock + rename. fs.watch can stay
      // attached to the old inode or miss the event on loaded hosts; stat
      // polling follows the path and observes the replacement.
      this.headWatcher = this.watchPath(join(this.located.gitDir, 'HEAD'));
    } catch {
      // HEAD may not exist during `git init` transient state; swallow.
    }
  }

  private installRefWatcher(): void {
    if (!this.currentBranch) return;
    const path = join(this.located.commonGitDir, 'refs', 'heads', ...this.currentBranch.split('/'));
    // Loose refs are atomically replaced on commit. Polling the path survives
    // replacement and also detects a ref that is created after subscription.
    this.refWatcher = this.watchPath(path);
  }

  private installPackedRefsWatcher(): void {
    this.packedRefsWatcher = this.watchPath(join(this.located.commonGitDir, 'packed-refs'));
  }
}
