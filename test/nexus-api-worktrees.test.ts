// BACKLOG #5 — verify GET /v1/worktrees aggregation.
// Tests the pure builder + the handler shape; the spawn-git path
// is exercised by `git-worktree-runtimes.test.ts` already.

import { describe, expect, it, test } from 'bun:test';
import { resolveWorktreesRepoRoot,
  detectRepoRoot,
  buildWorktreesView,
  disposeWorktree,
  handleWorktrees,
  handleWorktreeDispose,
  type DisposeWorktreeDeps,
} from '../src/nexus/api/worktrees.js';
import type {
  WorktreeEntry,
  WorktreeSession,
} from '../src/git-fs/worktree.js';

function alivePidsOnly(alive: number[]): (pid: number) => boolean {
  const set = new Set(alive);
  return (pid: number) => set.has(pid);
}

const REPO = '/tmp/repo-fake';

const MAIN_WT: WorktreeEntry = {
  path: '/tmp/repo-fake',
  branch: 'main',
  sha: 'abc123',
  isLocked: false,
  isDetached: false,
  isMain: true,
};

const SECONDARY_WT: WorktreeEntry = {
  path: '/tmp/repo-fake.worktrees/feat-x',
  branch: 'feat-x',
  sha: 'def456',
  isLocked: false,
  isDetached: false,
  isMain: false,
};

const DETACHED_WT: WorktreeEntry = {
  path: '/tmp/repo-fake.worktrees/detached-9',
  branch: null,
  sha: '999',
  isLocked: false,
  isDetached: true,
  isMain: false,
};

const ALIVE_SESSION: WorktreeSession = {
  sessionId: '12345', // pid
  worktreePath: SECONDARY_WT.path,
  branch: 'feat-x',
  previousCwd: '/tmp/repo-fake',
  previousRepoRoot: REPO,
  enteredAt: 1_700_000_000_000,
};

const DEAD_SESSION: WorktreeSession = {
  sessionId: '99999', // dead pid
  worktreePath: DETACHED_WT.path,
  branch: 'detached-9',
  previousCwd: '/tmp/repo-fake',
  previousRepoRoot: REPO,
  enteredAt: 1_700_000_001_000,
};

const ORPHANED_SESSION: WorktreeSession = {
  sessionId: '88888', // dead pid
  worktreePath: '/tmp/repo-fake.worktrees/long-gone',
  branch: 'gone',
  previousCwd: '/tmp/repo-fake',
  previousRepoRoot: REPO,
  enteredAt: 1_700_000_002_000,
};

describe('buildWorktreesView — empty cases', () => {
  it('returns empty arrays + null repoRoot when nothing wired', () => {
    const v = buildWorktreesView([], [], null, alivePidsOnly([]));
    expect(v.repoRoot).toBeNull();
    expect(v.worktrees).toEqual([]);
    expect(v.orphanedSessions).toEqual([]);
  });

  it('returns worktrees but no sessions when no elanous sessions wired', () => {
    const v = buildWorktreesView([MAIN_WT, SECONDARY_WT], [], REPO, alivePidsOnly([]));
    expect(v.repoRoot).toBe(REPO);
    expect(v.worktrees.length).toBe(2);
    expect(v.worktrees.every((w) => w.session === null)).toBe(true);
    expect(v.worktrees.every((w) => w.orphan === false)).toBe(true);
  });
});

describe('buildWorktreesView — owner session attribution', () => {
  it('attaches owner session when worktree has a matching JSON', () => {
    const v = buildWorktreesView(
      [MAIN_WT, SECONDARY_WT],
      [ALIVE_SESSION],
      REPO,
      alivePidsOnly([12345]),
    );
    const sec = v.worktrees.find((w) => w.path === SECONDARY_WT.path)!;
    expect(sec.session).not.toBeNull();
    expect(sec.session!.sessionId).toBe('12345');
    expect(sec.session!.alive).toBe(true);
    expect(sec.orphan).toBe(false);
  });

  it('marks worktree as orphan when its owner pid is dead', () => {
    const v = buildWorktreesView(
      [MAIN_WT, DETACHED_WT],
      [DEAD_SESSION],
      REPO,
      alivePidsOnly([]), // no live pids
    );
    const det = v.worktrees.find((w) => w.path === DETACHED_WT.path)!;
    expect(det.session).not.toBeNull();
    expect(det.session!.alive).toBe(false);
    expect(det.orphan).toBe(true);
  });

  it('preserves isMain / isLocked / isDetached flags from the entry', () => {
    const v = buildWorktreesView(
      [MAIN_WT, DETACHED_WT],
      [],
      REPO,
      alivePidsOnly([]),
    );
    expect(v.worktrees[0]!.isMain).toBe(true);
    expect(v.worktrees[1]!.isMain).toBe(false);
    expect(v.worktrees[1]!.isDetached).toBe(true);
  });
});

describe('buildWorktreesView — orphaned sessions (worktree gone)', () => {
  it('lists sessions whose worktreePath no longer exists in git', () => {
    const v = buildWorktreesView(
      [MAIN_WT, SECONDARY_WT],
      [ALIVE_SESSION, ORPHANED_SESSION],
      REPO,
      alivePidsOnly([12345]),
    );
    expect(v.orphanedSessions.length).toBe(1);
    expect(v.orphanedSessions[0]!.sessionId).toBe('88888');
    expect(v.orphanedSessions[0]!.alive).toBe(false);
  });

  it('orphanedSessions does NOT include sessions still referenced by a worktree', () => {
    const v = buildWorktreesView(
      [MAIN_WT, SECONDARY_WT],
      [ALIVE_SESSION],
      REPO,
      alivePidsOnly([12345]),
    );
    expect(v.orphanedSessions).toEqual([]);
  });

  it('handles multiple orphaned sessions', () => {
    const second: WorktreeSession = { ...ORPHANED_SESSION, sessionId: '77777', worktreePath: '/tmp/x.worktrees/another-gone' };
    const v = buildWorktreesView(
      [MAIN_WT],
      [ORPHANED_SESSION, second],
      REPO,
      alivePidsOnly([]),
    );
    expect(v.orphanedSessions.length).toBe(2);
    expect(v.orphanedSessions.map((s) => s.sessionId).sort()).toEqual(['77777', '88888']);
  });
});

describe('handleWorktrees — wire shape', () => {
  it('returns 200 + JSON with the right top-level shape', async () => {
    const resp = handleWorktrees();
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('application/json');
    const body = (await resp.json()) as {
      repoRoot: string | null;
      worktrees: unknown[];
      orphanedSessions: unknown[];
    };
    expect('repoRoot' in body).toBe(true);
    expect(Array.isArray(body.worktrees)).toBe(true);
    expect(Array.isArray(body.orphanedSessions)).toBe(true);
  });
});

// ── Dispose ─────────────────────────────────────────────────────────

/** Stub deps that record every external touch — so we can assert
 *  exactly which sequence of side-effects each dispose path took. */
function makeDisposeDeps(state: {
  worktrees: WorktreeEntry[];
  sessions: WorktreeSession[];
  removeError?: Error;
  clearError?: Error;
  repoRoot?: string | null;
}): DisposeWorktreeDeps & {
  removeCalls: { repoRoot: string; path: string; force: boolean }[];
  clearCalls: string[];
} {
  const removeCalls: { repoRoot: string; path: string; force: boolean }[] = [];
  const clearCalls: string[] = [];
  return {
    detectRepoRoot: () => state.repoRoot === undefined ? REPO : state.repoRoot,
    listWorktrees: () => state.worktrees,
    listWorktreeSessions: () => state.sessions,
    removeWorktree: (repoRoot, path, force) => {
      removeCalls.push({ repoRoot, path, force });
      if (state.removeError) throw state.removeError;
    },
    clearWorktreeSession: (sessionId) => {
      clearCalls.push(sessionId);
      if (state.clearError) throw state.clearError;
    },
    removeCalls,
    clearCalls,
  };
}

describe('disposeWorktree — happy paths', () => {
  it('removes a secondary worktree + clears its session JSON', () => {
    const deps = makeDisposeDeps({
      worktrees: [MAIN_WT, SECONDARY_WT],
      sessions: [ALIVE_SESSION],
    });
    const r = disposeWorktree({ path: SECONDARY_WT.path }, deps);
    expect(r.ok).toBe(true);
    expect(r.action).toBe('git-worktree-remove');
    expect(r.cleanedSession).toBe('12345');
    expect(deps.removeCalls).toEqual([
      { repoRoot: REPO, path: SECONDARY_WT.path, force: false },
    ]);
    expect(deps.clearCalls).toEqual(['12345']);
  });

  it('removes a worktree without a session JSON (cleanedSession undefined)', () => {
    const deps = makeDisposeDeps({
      worktrees: [MAIN_WT, SECONDARY_WT],
      sessions: [], // no session attached
    });
    const r = disposeWorktree({ path: SECONDARY_WT.path }, deps);
    expect(r.ok).toBe(true);
    expect(r.action).toBe('git-worktree-remove');
    expect(r.cleanedSession).toBeUndefined();
    expect(deps.clearCalls).toEqual([]);
  });

  it('forwards force=true to removeWorktree', () => {
    const deps = makeDisposeDeps({
      worktrees: [MAIN_WT, SECONDARY_WT],
      sessions: [],
    });
    disposeWorktree({ path: SECONDARY_WT.path, force: true }, deps);
    expect(deps.removeCalls[0]!.force).toBe(true);
  });

  it('clears the session JSON for a fully-orphaned session (worktree dir gone)', () => {
    const deps = makeDisposeDeps({
      worktrees: [MAIN_WT], // orphan path no longer in worktree set
      sessions: [ORPHANED_SESSION],
    });
    const r = disposeWorktree({ path: ORPHANED_SESSION.worktreePath }, deps);
    expect(r.ok).toBe(true);
    expect(r.action).toBe('orphan-session-cleanup');
    expect(r.cleanedSession).toBe('88888');
    expect(deps.removeCalls).toEqual([]); // no git mutation
    expect(deps.clearCalls).toEqual(['88888']);
  });
});

describe('disposeWorktree — refuses unsafe paths', () => {
  it('refuses to dispose the main worktree (400)', () => {
    const deps = makeDisposeDeps({
      worktrees: [MAIN_WT, SECONDARY_WT],
      sessions: [],
    });
    const r = disposeWorktree({ path: MAIN_WT.path }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cannot dispose main worktree');
    expect(deps.removeCalls).toEqual([]);
  });

  it('rejects an arbitrary path not in either set (404)', () => {
    const deps = makeDisposeDeps({
      worktrees: [MAIN_WT, SECONDARY_WT],
      sessions: [],
    });
    const r = disposeWorktree({ path: '/etc' }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('path not found');
    expect(deps.removeCalls).toEqual([]);
    expect(deps.clearCalls).toEqual([]);
  });

  it('rejects empty path string (400)', () => {
    const deps = makeDisposeDeps({
      worktrees: [MAIN_WT, SECONDARY_WT],
      sessions: [],
    });
    const r = disposeWorktree({ path: '   ' }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('path required');
  });

  it('returns no-repo-root error when detectRepoRoot is null', () => {
    const deps = makeDisposeDeps({
      worktrees: [],
      sessions: [],
      repoRoot: null,
    });
    const r = disposeWorktree({ path: '/any' }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no repo root');
  });
});

describe('disposeWorktree — error surface', () => {
  it('git-worktree-remove failure → 409 with detail', () => {
    const deps = makeDisposeDeps({
      worktrees: [MAIN_WT, SECONDARY_WT],
      sessions: [],
      removeError: new Error('working tree dirty'),
    });
    const r = disposeWorktree({ path: SECONDARY_WT.path }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('git-worktree-failed');
    expect(r.detail).toContain('working tree dirty');
  });

  it('session-cleanup failure AFTER successful worktree removal still returns ok=true', () => {
    const deps = makeDisposeDeps({
      worktrees: [MAIN_WT, SECONDARY_WT],
      sessions: [ALIVE_SESSION],
      clearError: new Error('permission denied'),
    });
    const r = disposeWorktree({ path: SECONDARY_WT.path }, deps);
    // The worktree IS gone — that's the user's primary intent. The
    // dangling session JSON is a secondary cleanup the next sweep
    // can pick up. We surface the failure but mark ok=true so the UI
    // can show "removed (session cleanup failed)" instead of "failed".
    expect(r.ok).toBe(true);
    expect(r.action).toBe('git-worktree-remove');
    expect(r.error).toBe('session-cleanup-failed');
  });

  it('session-cleanup failure on orphan (no worktree to remove) → 409', () => {
    const deps = makeDisposeDeps({
      worktrees: [MAIN_WT],
      sessions: [ORPHANED_SESSION],
      clearError: new Error('permission denied'),
    });
    const r = disposeWorktree({ path: ORPHANED_SESSION.worktreePath }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('session-cleanup-failed');
    expect(r.detail).toContain('permission denied');
  });
});

describe('handleWorktreeDispose — HTTP status codes', () => {
  async function postBody(body: unknown): Promise<Response> {
    const req = new Request('http://x/v1/worktrees/dispose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return handleWorktreeDispose(req);
  }

  it('400 on invalid body', async () => {
    const r = await postBody({});
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe('path required');
  });

  it('400 on non-string path', async () => {
    const r = await postBody({ path: 42 });
    expect(r.status).toBe(400);
  });

  it('404 on path not found', async () => {
    // Without dependency injection the handler hits the real
    // detectRepoRoot — in the test runner cwd we DO have a repo,
    // so the path will be looked up in the real worktree set and
    // not found.
    const r = await postBody({ path: '/tmp/definitely-not-a-worktree' });
    expect([404, 500]).toContain(r.status);
  });
});

describe('detectRepoRoot — 관문 결과 처리 (리뷰 must-fix · 2026-08-03)', () => {
  // ⛔⭐⭐⭐ `detectFn` 은 스폰을 통째로 우회하므로 아래 회귀를 **못 문다**.
  //    관문 러너를 주입해 `runGitCommand` 의 반환을 어떻게 읽는지 직접 잰다.
  //    이 셋이 없으면 *"성공 결과를 항상 null 로 버리는"* 회귀가 통과한다.
  test('성공이면 trim 한 stdout 을 그대로 돌려준다 (버리지 않는다)', () => {
    const root = detectRepoRoot({ cwd: '/x', runner: () => ({ status: 0, stdout: '/repo/root\n', stderr: '' }) });
    expect(root).toBe('/repo/root');
  });

  test('실패면 stdout 이 비어 있지 않아도 null 이다 (실패를 경로로 소비하지 않는다)', () => {
    const root = detectRepoRoot({ cwd: '/x', runner: () => ({ status: 128, stdout: '/looks/like/a/path\n', stderr: 'fatal: not a git repository' }) });
    expect(root).toBeNull();
  });

  test('성공인데 stdout 이 공백뿐이면 null 이다 (빈 문자열을 경로로 쓰지 않는다)', () => {
    const root = detectRepoRoot({ cwd: '/x', runner: () => ({ status: 0, stdout: '   \n', stderr: '' }) });
    expect(root).toBeNull();
  });
});

describe('resolveWorktreesRepoRoot — Design 탭과 같은 해석(트리아지 P2 «git 밖» 오판)', () => {
  test('configured absolute harness.defaultRepo wins over the daemon cwd', () => {
    const seen: Array<string | undefined> = [];
    const root = resolveWorktreesRepoRoot({ defaultRepo: () => '/repo', detect: (cwd) => { seen.push(cwd); return cwd ? '/repo' : null; } });
    expect(root).toBe('/repo');
    expect(seen).toEqual(['/repo']);
  });
  test('no config falls back to the daemon cwd; relative config is ambiguous → null', () => {
    expect(resolveWorktreesRepoRoot({ defaultRepo: () => undefined, detect: (cwd) => (cwd ? null : '/cwd-repo') })).toBe('/cwd-repo');
    expect(resolveWorktreesRepoRoot({ defaultRepo: () => './repo', detect: () => '/anything' })).toBeNull();
  });
});
