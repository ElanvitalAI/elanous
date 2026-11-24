// ELS-GIT-AWARENESS-HERDR (OP #139752) — 판정식 ②③: `els ls` shows the git label on every pane line, `els worktree
// list` groups panes by their git worktree root, and `els worktree remove` refuses a worktree that still has a live
// pane inside. Synthetic rows are the test universe (정식 증거 per FAST-PATH-CARD).
import { describe, expect, test } from 'bun:test';
import { gitBadge, paneListLines, worktreeGroups, worktreeListLines, worktreeRemoveGuard } from '../cli/els-cli.js';

const gitRow = { branch: 'main', ahead: 0, behind: 0, dirty: false, root: '/r' };

describe('gitBadge (판정식 ① 표시)', () => {
  test('branch only, ahead, behind, dirty and their combinations', () => {
    expect(gitBadge(undefined)).toBe('');
    expect(gitBadge({ branch: 'main', ahead: 0, behind: 0, dirty: false, root: null })).toBe('[main]');
    expect(gitBadge({ branch: 'feat', ahead: 1, behind: 0, dirty: false, root: null })).toBe('[feat↑1]');
    expect(gitBadge({ branch: 'feat', ahead: 0, behind: 2, dirty: false, root: null })).toBe('[feat↓2]');
    expect(gitBadge({ branch: 'feat', ahead: 1, behind: 1, dirty: true, root: null })).toBe('[feat↑1↓1*]');
  });
});

describe('paneListLines with git labels', () => {
  test('a pane in a repo shows its label; a pane outside any repo shows none', () => {
    const lines = paneListLines(JSON.stringify({ panes: [
      { address: 'ws/tab/p1', title: 't1', state: 'idle', cwd: '/r/sub', badgeLabel: 'B', git: { ...gitRow, dirty: true } },
      { address: 'ws/tab/p2', title: 't2', state: 'idle', cwd: '/x' },
    ] }), 0);
    expect(lines[0]).toContain('[main*]');
    expect(lines[1]).not.toContain('[main');
  });
});

describe('worktreeGroups · worktreeListLines (판정식 ② — panes grouped by git worktree root)', () => {
  test('panes of one worktree share a group; non-repo panes come last', () => {
    const list = JSON.stringify({ panes: [
      { address: 'ws/tab/p1', title: 'a', state: 'idle', cwd: '/r/sub', git: gitRow },
      { address: 'ws/tab/p2', title: 'b', state: 'idle', cwd: '/x' },
      { address: 'ws/tab/p3', title: 'c', state: 'idle', cwd: '/r/other', git: gitRow },
    ] });
    expect(worktreeGroups(list).map((group) => [group.root, group.panes.map((pane) => pane.title)]))
      .toEqual([['/r', ['a', 'c']], [null, ['b']]]);
  });

  test('els worktree list renders one header per worktree with the panes under it', () => {
    const lines = worktreeListLines(JSON.stringify({ panes: [
      { address: 'ws/tab/p1', title: 'a', state: 'idle', cwd: '/r/sub', git: gitRow },
      { address: 'ws/tab/p2', title: 'b', state: 'idle', cwd: '/x' },
    ] }));
    expect(lines[0]).toContain('/r');
    expect(lines[1]).toContain('ws/tab/p1');
    expect(lines.some((line) => line.includes('ws/tab/p2'))).toBe(true);
  });
});

describe('worktreeRemoveGuard (판정식 ③ — remove refuses a worktree with a live pane inside)', () => {
  test("refuses naming the pane's cwd, then allows once the pane is gone", () => {
    const blocked = worktreeRemoveGuard(['/r/sub', '/x'], '/r');
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain('/r/sub');
    expect(worktreeRemoveGuard(['/x'], '/r').ok).toBe(true);
  });
});
