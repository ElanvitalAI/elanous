// NEXUS · GET /v1/worktrees — active worktree visualization
// (BACKLOG #5 / Archon-port followups · 2026-05-08)
//
// Aggregates two existing data sources:
//   1. `git worktree list --porcelain` from the active repo —
//      authoritative ground truth (every worktree git knows about).
//   2. `~/.elanous/worktrees/<sessionId>.json` — per-elanous-session
//      records of which elanous process entered which worktree, so we
//      can label each git worktree with its owning session AND
//      detect orphans (worktree exists, owner pid dead).
//
// Wire shape:
//   {
//     repoRoot: string | null,        // null when not inside a git repo
//     worktrees: [
//       {
//         path, branch, sha,
//         isMain, isLocked, isDetached,
//         session: { sessionId, enteredAt, previousCwd, alive } | null,
//         orphan: boolean              // true when session expected but pid dead
//       }
//     ],
//     orphanedSessions: [              // session JSONs whose worktree no longer exists
//       { sessionId, worktreePath, branch, enteredAt, alive }
//     ]
//   }
//
// Read-only · no auth (mirrors `/v1/platforms` / `/v1/providers`
// per existing same-origin enforcement layer).

import { isAbsolute } from 'node:path';
import { getUserConfig } from '../../user-config.js';
import { type GitRunner } from '../../git-fs/retry.js';
import { runGitCommand } from '../../git-fs/runner.js';
import { jsonResponse } from './http-server.js';
import {
  clearWorktreeSession,
  isPidAlive,
  listWorktrees,
  listWorktreeSessions,
  removeWorktree,
  type WorktreeEntry,
  type WorktreeSession,
} from '../../git-fs/worktree.js';

export interface WorktreeView {
  path: string;
  branch: string | null;
  sha: string;
  isMain: boolean;
  isLocked: boolean;
  isDetached: boolean;
  session: {
    sessionId: string;
    enteredAt: number;
    previousCwd: string;
    alive: boolean;
  } | null;
  /** Worktree exists on disk + a session JSON references it, but the
   *  owner pid is dead. ExitWorktree never ran (crash / SIGKILL). */
  orphan: boolean;
}

export interface OrphanedSessionView {
  sessionId: string;
  worktreePath: string;
  branch: string;
  enteredAt: number;
  alive: boolean;
}

export interface WorktreesResponse {
  repoRoot: string | null;
  worktrees: WorktreeView[];
  orphanedSessions: OrphanedSessionView[];
}

interface DetectRepoRootOpts {
  cwd?: string;
  /** Test seam — bypasses the spawn. */
  detectFn?: (cwd: string) => string | null;
  /** ⭐ Test seam for the **result handling** of the git seam (리뷰 must-fix · 2026-08-03).
   *  ⛔ `detectFn` 은 스폰을 통째로 우회하므로 *"실패 status 인데 stdout 이 비어 있지 않다"* 나
   *  *"성공인데 반환을 버린다"* 같은 회귀를 **못 문다**. 관문 러너를 주입해 그 분기를 직접 잰다. */
  runner?: GitRunner;
}

/** Resolve the active repo root via `git rev-parse --show-toplevel`.
 *  Returns null when the cwd isn't inside a git repo (the endpoint
 *  short-circuits to empty in that case — useful for dogfood NEXUS
 *  spun up outside a checkout). */
export function detectRepoRoot(opts: DetectRepoRootOpts = {}): string | null {
  if (opts.detectFn) return opts.detectFn(opts.cwd ?? process.cwd());
  const cwd = opts.cwd ?? process.cwd();
  const res = runGitCommand(cwd, ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 5_000,
  }, opts.runner);
  if (res.status !== 0) return null;
  const out = res.stdout.trim();
  return out.length > 0 ? out : null;
}

/** 워크트리 탭이 보는 저장소 — Design 탭과 같은 해석(🅕 09-28 트리아지 P2):
 *  `harness.defaultRepo`(절대 경로)가 있으면 그 저장소, 없으면 데몬 cwd.
 *  ⛔ 데몬은 launchd 로 뜨면 cwd 가 저장소 밖이라 «git 밖»으로 오판했다. 상대 경로 설정은 모호하니 null. */
export function resolveWorktreesRepoRoot(deps: {
  defaultRepo?: () => string | undefined;
  detect?: (cwd?: string) => string | null;
} = {}): string | null {
  const detect = deps.detect ?? ((cwd?: string) => detectRepoRoot(cwd === undefined ? {} : { cwd }));
  const configured = (deps.defaultRepo ?? (() => getUserConfig().harness?.defaultRepo))();
  if (configured !== undefined) return isAbsolute(configured) ? detect(configured) : null;
  return detect();
}

/** Pure aggregation — combine listWorktrees + listWorktreeSessions
 *  into the wire response. Extracted for unit testing without
 *  spawning git or scanning the FS. */
export function buildWorktreesView(
  worktrees: WorktreeEntry[],
  sessions: WorktreeSession[],
  repoRoot: string | null,
  isAlive: (pid: number) => boolean = isPidAlive,
): WorktreesResponse {
  // Index sessions by their worktree path so the per-worktree lookup
  // is O(1) and we can detect orphans (sessions whose worktreePath
  // doesn't appear in the listWorktrees result).
  const sessionByPath = new Map<string, WorktreeSession>();
  for (const s of sessions) sessionByPath.set(s.worktreePath, s);

  const worktreeViews: WorktreeView[] = worktrees.map((w) => {
    const s = sessionByPath.get(w.path);
    let session: WorktreeView['session'] = null;
    let orphan = false;
    if (s) {
      const pid = Number.parseInt(s.sessionId, 10);
      const alive = Number.isFinite(pid) && pid > 0 ? isAlive(pid) : false;
      session = {
        sessionId: s.sessionId,
        enteredAt: s.enteredAt,
        previousCwd: s.previousCwd,
        alive,
      };
      orphan = !alive;
    }
    return {
      path: w.path,
      branch: w.branch,
      sha: w.sha,
      isMain: w.isMain,
      isLocked: w.isLocked,
      isDetached: w.isDetached,
      session,
      orphan,
    };
  });

  // Sessions whose worktreePath no longer exists in `worktrees` — the
  // worktree dir was removed (e.g., `git worktree remove`) but the
  // session JSON wasn't cleaned (the running pid never reached
  // ExitWorktree before the dir vanished).
  const knownPaths = new Set(worktrees.map((w) => w.path));
  const orphanedSessions: OrphanedSessionView[] = sessions
    .filter((s) => !knownPaths.has(s.worktreePath))
    .map((s) => {
      const pid = Number.parseInt(s.sessionId, 10);
      const alive = Number.isFinite(pid) && pid > 0 ? isAlive(pid) : false;
      return {
        sessionId: s.sessionId,
        worktreePath: s.worktreePath,
        branch: s.branch,
        enteredAt: s.enteredAt,
        alive,
      };
    });

  return {
    repoRoot,
    worktrees: worktreeViews,
    orphanedSessions,
  };
}

/** GET /v1/worktrees — see top-of-file wire shape. Detects the active
 *  repo via `git rev-parse --show-toplevel` from process.cwd(); when
 *  not in a git checkout, returns `{repoRoot: null, worktrees: [],
 *  orphanedSessions: []}`. */
export function handleWorktrees(): Response {
  const repoRoot = resolveWorktreesRepoRoot();
  const worktrees = repoRoot ? listWorktrees(repoRoot) : [];
  const sessions = listWorktreeSessions();
  const body = buildWorktreesView(worktrees, sessions, repoRoot);
  return jsonResponse(body, 200);
}

// ── POST /v1/worktrees/dispose ──────────────────────────────────────
//
// HANDOFF §4.2 follow-up — GUI cleanup for orphan worktrees + live
// worktrees. The user picks an entry in the PWA `/worktrees` view and
// clicks Dispose; the PWA POSTs here; we run `git worktree remove`
// (or just delete the orphan session JSON) and return what we did.
//
// Design choice: POST + body (not DELETE + URL-encoded path). Worktree
// paths are absolute filesystem paths with `/` characters — encoding
// them into a URL segment (`%2F` everywhere) is brittle and noisy.
// POST with a body matches the workflow approval pattern
// (`POST /v1/workflows/runs/<id>/approve`).
//
// Wire shape:
//   POST /v1/worktrees/dispose
//   body: { path: string, force?: boolean }
//   200: { ok: true, action: 'git-worktree-remove' | 'orphan-session-cleanup',
//          cleanedSession?: string }
//   400: { ok: false, error: 'path required' | 'cannot dispose main worktree' }
//   404: { ok: false, error: 'path not found' }
//   409: { ok: false, error: 'git-worktree-failed', detail: string }
//
// Path is validated against the discovered worktree set + the orphan
// session set BEFORE any filesystem mutation. That makes the endpoint
// safe against arbitrary-path injection — a client can't trick it
// into running `git worktree remove /etc` because /etc isn't in
// either set.

export interface DisposeWorktreeRequest {
  path: string;
  force?: boolean;
}

export interface DisposeWorktreeResponse {
  ok: boolean;
  /** Which path the dispose ended up taking — null on error. */
  action: 'git-worktree-remove' | 'orphan-session-cleanup' | null;
  /** When a session JSON was cleaned up (either as part of removing
   *  the worktree, or as the sole action for an orphan), the
   *  sessionId of that JSON. */
  cleanedSession?: string;
  error?: string;
  /** Free-form detail when `error` is set — e.g., the stderr from a
   *  failed `git worktree remove`. */
  detail?: string;
}

/** Dependency-injectable surface — every external touch goes through
 *  here so the unit test can drive the full decision tree without
 *  spawning git or scanning the FS. */
export interface DisposeWorktreeDeps {
  detectRepoRoot?: () => string | null;
  listWorktrees?: (repoRoot: string) => WorktreeEntry[];
  listWorktreeSessions?: () => WorktreeSession[];
  removeWorktree?: (repoRoot: string, wtPath: string, force: boolean) => void;
  clearWorktreeSession?: (sessionId: string) => void;
}

/** Pure dispatcher. Returns the response body — the HTTP handler
 *  picks the status code from `response.ok`/`response.error`. */
export function disposeWorktree(
  req: DisposeWorktreeRequest,
  deps: DisposeWorktreeDeps = {},
): DisposeWorktreeResponse {
  // 목록과 «같은» 저장소로 검증한다 — 다르면 목록에 보인 경로를 지울 수 없거나, 안 보인 경로를 검증에 쓴다.
  const detect = deps.detectRepoRoot ?? (() => resolveWorktreesRepoRoot());
  const lstWt = deps.listWorktrees ?? listWorktrees;
  const lstSe = deps.listWorktreeSessions ?? listWorktreeSessions;
  const rmWt = deps.removeWorktree ?? removeWorktree;
  const clrSe = deps.clearWorktreeSession ?? clearWorktreeSession;

  if (typeof req.path !== 'string' || req.path.trim().length === 0) {
    return { ok: false, action: null, error: 'path required' };
  }
  const targetPath = req.path;
  const force = req.force === true;

  const repoRoot = detect();
  if (!repoRoot) {
    return { ok: false, action: null, error: 'no repo root' };
  }

  const worktrees = lstWt(repoRoot);
  const sessions = lstSe();

  const matchedWorktree = worktrees.find((w) => w.path === targetPath);
  if (matchedWorktree) {
    if (matchedWorktree.isMain) {
      return {
        ok: false,
        action: null,
        error: 'cannot dispose main worktree',
      };
    }
    try {
      rmWt(repoRoot, targetPath, force);
    } catch (err) {
      return {
        ok: false,
        action: null,
        error: 'git-worktree-failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    // Best-effort session JSON cleanup — git remove succeeded so we
    // own the path now. If a session matched, clear it; if the clear
    // itself fails, surface the success of the worktree removal but
    // note the unclean session in the response.
    const matchedSession = sessions.find((s) => s.worktreePath === targetPath);
    if (matchedSession) {
      try {
        clrSe(matchedSession.sessionId);
      } catch {
        // Don't fail the whole dispose on session cleanup failure —
        // the worktree is gone, that's the user's primary intent.
        return {
          ok: true,
          action: 'git-worktree-remove',
          cleanedSession: matchedSession.sessionId,
          error: 'session-cleanup-failed',
        };
      }
      return {
        ok: true,
        action: 'git-worktree-remove',
        cleanedSession: matchedSession.sessionId,
      };
    }
    return { ok: true, action: 'git-worktree-remove' };
  }

  // No matching worktree — try orphan session.
  const orphanSession = sessions.find((s) => s.worktreePath === targetPath);
  if (orphanSession) {
    try {
      clrSe(orphanSession.sessionId);
    } catch (err) {
      return {
        ok: false,
        action: null,
        error: 'session-cleanup-failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      ok: true,
      action: 'orphan-session-cleanup',
      cleanedSession: orphanSession.sessionId,
    };
  }

  return { ok: false, action: null, error: 'path not found' };
}

async function readJsonBody(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return null; }
}

/** POST /v1/worktrees/dispose handler. */
export async function handleWorktreeDispose(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    return jsonResponse({ ok: false, action: null, error: 'invalid body' }, 400);
  }
  const path = (body as { path?: unknown }).path;
  const force = (body as { force?: unknown }).force === true;

  const result = disposeWorktree({
    path: typeof path === 'string' ? path : '',
    force,
  });

  let status = 200;
  if (!result.ok) {
    if (result.error === 'path required' || result.error === 'cannot dispose main worktree') {
      status = 400;
    } else if (result.error === 'path not found') {
      status = 404;
    } else if (result.error === 'no repo root') {
      status = 500;
    } else {
      // git-worktree-failed / session-cleanup-failed — caller's git
      // state isn't ready (dirty worktree, locked, etc.).
      status = 409;
    }
  }
  return jsonResponse(result, status);
}
