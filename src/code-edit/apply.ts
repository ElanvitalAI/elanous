// Apply — Phase CE2.
//
// The actual fs.writeFile side of the Edit pipeline. Orchestrates:
//   1. Read-before-Edit invariant check against the store.
//   2. Disk read + content-hash comparison (detects external edits
//      between Read and Edit so we refuse to clobber changes).
//   3. applyEditsInMemory to produce the new content.
//   4. computePatch for the renderer.
//   5. fs.writeFile + re-record the new content in the Read store so
//      the LLM can chain multiple Edits on the same file.
//
// On any step's failure, returns an EditError the caller hands
// straight to the LLM. The error messages include enough context
// (match count, preview, path) for the model to self-correct and
// retry without re-reading the file.

import { promises as fsp } from 'fs';
import {
  applyEditsInMemory,
  computePatch,
  countPatchChanges,
} from './diff-compute.js';
import { hashContent, ReadFileStateStore } from './read-state.js';
import {
  assessEdit,
  assessWrite,
  getCodeEditApprover,
  getPolicy,
} from './safety.js';
import { getTurnDiffTracker } from './turn-diff-tracker.js';
import { captureIfFirstMutationOfTurn } from '../undo-turn/index.js';
import { getSessionCwd, getSessionBoundary } from '../session/working-dir.js';
import { harnessMainTreeReject, canonicalizeForBoundary, isWithinBoundary } from '../harness/harness-write-boundary.js';
import { debug } from '../debug/log.js';
import { isAbsolute, resolve } from 'node:path';
import {
  EditErrorCode,
  type EditError,
  type EditOutcome,
  type EditRequest,
  type EditResult,
  type SafetyDecision,
  type WriteRequest,
} from './types.js';
import { assertPlanGate } from '../plan-mode/write-gate.js';

/** Act on a SafetyDecision. Returns an EditError when the edit must
 *  NOT proceed (rejected by policy, rejected by user, or no approver
 *  wired). Returns null when apply should continue — covers both
 *  auto-approve and user-approved. */
async function runPolicyGate(
  decision: SafetyDecision,
  spec: {
    kind: 'edit' | 'write';
    file_path: string;
    changeSummary: string;
    preview?: {
      structuredPatch: EditResult['structuredPatch'];
      originalContent: string;
      newContent: string;
      linesAdded: number;
      linesRemoved: number;
    };
  },
): Promise<EditError | null> {
  if (decision.kind === 'reject') {
    return {
      ok: false,
      code: EditErrorCode.PolicyRejected,
      message: `policy rejected: ${decision.reason}`,
      meta: { file_path: spec.file_path, reason: decision.reason },
    };
  }
  if (decision.kind === 'auto-approve') return null;

  // ask-user
  const approver = getCodeEditApprover();
  if (!approver) {
    return {
      ok: false,
      code: EditErrorCode.ApproverMissing,
      message: `policy requires approval but no approver is wired. Use /code-edit policy unsupervised if running headless.`,
      meta: { file_path: spec.file_path, reason: decision.reason },
    };
  }

  const approved = await approver({
    kind: spec.kind,
    file_path: spec.file_path,
    changeSummary: spec.changeSummary,
    reason: decision.reason,
    preview: spec.preview,
  }).catch(() => false);

  if (!approved) {
    return {
      ok: false,
      code: EditErrorCode.UserRejected,
      message: `user declined the ${spec.kind} approval`,
      meta: { file_path: spec.file_path },
    };
  }
  return null;
}

/** Resolve a tool-supplied file path the same way the approval gate
 *  (safety.ts) and the shell/verification tools do — against the SESSION
 *  working dir, NOT `process.cwd()`. Node's fs APIs anchor relative paths
 *  on `process.cwd()`, which diverges from `getSessionCwd()` the moment
 *  the agent enters a worktree / moves the working dir (`setSessionCwd`
 *  never calls `process.chdir`). Without this, a relative Write is
 *  approved (safety.ts resolves on getSessionCwd) and reports success,
 *  but the bytes land in the boot dir — invisible to the model's
 *  `git status` in the worktree — causing write→verify→missing→rewrite
 *  loops until the model happens to emit an absolute path. */
function resolveInSession(p: string): string {
  return isAbsolute(p) ? p : resolve(getSessionCwd(), p);
}

/** ★ walker 미션 boundary 거부(2026-07-21·walker_phase_main_tree_pollution 봉쇄) — 쓰기 절대경로가
 *  격리 경계(worktree) 밖이면 사유 문자열, 안이면 null(허용). boundary 비활성이면 항상 null(무회귀).
 *  write/edit 진입점에서만 호출(read/verify 는 main 트리 참조가 정상이라 미적용). 관측 3박자. */
function boundaryReject(absPath: string): string | null {
  // ★ 심링크 우회 봉쇄(#4 should-fix) — 판정 前 존재-조상 realpath 로 canonical 화. worktree 내부 심링크가
  //   정본을 가리켜도 canonical 로 펼쳐져 lexical prefix 판정이 안 뚫린다(①②공통 초크포인트).
  const canon = canonicalizeForBoundary(absPath);
  const boundary = getSessionBoundary();
  // ① 활성 boundary(worktree) 밖 거부. ⚠️ boundary **양쪽 모두** canonicalize 후 비교(리뷰 must-fix) —
  //   심링크 경로로 설정된 정상 boundary 안 쓰기를 canon(대상)만 펼치면 밖으로 오판하는 회귀 방지.
  if (boundary !== null) {
    const canonB = canonicalizeForBoundary(boundary);
    if (!isWithinBoundary(canon, canonB)) {
      try { debug.log('code-edit.boundary', 'reject', { path: absPath, canon, boundary: canonB }); } catch { /* fail-soft */ }
      return `쓰기 경계 밖 절대경로 거부(walker 격리·경계=${canonB}): ${absPath}. worktree 상대경로 또는 경계 내부 경로로 쓰세요.`;
    }
    return null; // 경계 안 — 허용
  }
  // ② 방어심화(#4·2026-07-25) — boundary 가 (미활성/해제)여도 하니스 공간이면 격리 경계 밖 write 거부.
  //   boundary 를 지우는 setSessionCwd 회귀(EnterWorktree 등)에도 격리 불변을 보장(harness-write-boundary §c).
  const harnessReject = harnessMainTreeReject(canon);
  if (harnessReject) return harnessReject;
  return null;
}

export async function applyEdit(
  req: EditRequest,
  readStore: ReadFileStateStore,
): Promise<EditOutcome> {
  // Validate shape — cheap guards so the tool layer can pass raw
  // LLM args through without its own validator.
  if (typeof req.file_path !== 'string' || req.file_path.length === 0) {
    return { ok: false, code: EditErrorCode.ValidationError, message: 'file_path must be a non-empty string' };
  }
  if (!Array.isArray(req.edits) || req.edits.length === 0) {
    return { ok: false, code: EditErrorCode.ValidationError, message: 'edits must be a non-empty array' };
  }
  for (let i = 0; i < req.edits.length; i++) {
    const e = req.edits[i]!;
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') {
      return {
        ok: false,
        code: EditErrorCode.ValidationError,
        message: `edit ${i}: old_string and new_string must be strings`,
        meta: { editIndex: i },
      };
    }
  }

  const absPath = resolveInSession(req.file_path);
  const editBoundaryReject = boundaryReject(absPath);
  if (editBoundaryReject) return { ok: false, code: EditErrorCode.PolicyRejected, message: editBoundaryReject, meta: { file_path: req.file_path } };

  // WF3 — plan mode gate runs BEFORE Read-invariant so plan-file
  // edits are allowed even on files that weren't Read (the plan file
  // is created by EnterPlanMode, not by the model).
  const planBlock = assertPlanGate(req.file_path);
  if (planBlock) {
    return {
      ok: false,
      code: EditErrorCode.PolicyRejected,
      message: planBlock.message,
      meta: { file_path: req.file_path, planMode: true },
    };
  }

  const entry = readStore.verifyBeforeEdit(req.file_path);
  if (!entry) {
    return {
      ok: false,
      code: EditErrorCode.NotReadFirst,
      message: `Read ${req.file_path} before editing it.`,
      meta: { file_path: req.file_path },
    };
  }
  if (entry.partialView) {
    return {
      ok: false,
      code: EditErrorCode.NotReadFirst,
      message: `${req.file_path} was Read with offset/limit. Re-Read the full file before editing.`,
      meta: { file_path: req.file_path },
    };
  }

  let original: string;
  try {
    original = await fsp.readFile(absPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT/i.test(msg)) {
      return { ok: false, code: EditErrorCode.FileNotFound, message: `file not found: ${req.file_path}`, meta: { file_path: req.file_path } };
    }
    return { ok: false, code: EditErrorCode.IoFailed, message: `read failed: ${msg}`, meta: { file_path: req.file_path } };
  }

  if (entry.contentHash && hashContent(original) !== entry.contentHash) {
    return {
      ok: false,
      code: EditErrorCode.ModifiedSinceRead,
      message: `${req.file_path} changed on disk since Read — re-Read before editing.`,
      meta: { file_path: req.file_path },
    };
  }

  const memResult = applyEditsInMemory(original, req.edits);
  if ('ok' in memResult) return memResult;   // EditError has `ok: false`; ApplyEditsResult has no `ok` key
  const { newContent } = memResult;

  if (newContent === original) {
    return { ok: false, code: EditErrorCode.NoChange, message: 'edits produced no change' };
  }

  // CE4 — policy gate. Compute the diff first so the approval prompt
  // can show an accurate summary.
  const hunks = computePatch(req.file_path, original, newContent);
  const { added, removed } = countPatchChanges(hunks);

  const decision = assessEdit(req, getPolicy());
  const gate = await runPolicyGate(decision, {
    kind: 'edit',
    file_path: req.file_path,
    changeSummary: `${added} lines added, ${removed} removed`,
    preview: {
      structuredPatch: hunks,
      originalContent: original,
      newContent,
      linesAdded: added,
      linesRemoved: removed,
    },
  });
  if (gate !== null) return gate;

  // CE5 — snapshot the pre-edit content for the turn-end summary. The
  // tracker's guard only records the first touch per path, so chained
  // edits still diff against the true start-of-turn baseline.
  getTurnDiffTracker().onBeforeEdit(req.file_path, original);
  // UT2 — ghost-commit the whole working tree on the first mutation
  // of each turn. Subsequent writes in the same turn are no-ops. The
  // snapshot is scoped to the session working directory's repo, NOT
  // the edited file's parent dir — so all files in the same repo
  // that a multi-file Edit touches are covered by one snapshot.
  try { captureIfFirstMutationOfTurn(getSessionCwd()); } catch { /* noop */ }

  try {
    await fsp.writeFile(absPath, newContent, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      code: EditErrorCode.IoFailed,
      message: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      meta: { file_path: req.file_path },
    };
  }

  // Re-record so a follow-up Edit on the same file (common in LLM
  // batches that split "update function" into two passes) sees the
  // fresh content + fresh hash.
  readStore.recordRead(req.file_path, { content: newContent });

  const result: EditResult = {
    ok: true,
    file_path: req.file_path,
    structuredPatch: hunks,
    originalContent: original,
    newContent,
    edits: req.edits,
    linesAdded: added,
    linesRemoved: removed,
  };
  return result;
}

/** Write / create a file. Unlike Edit, Write does not require a prior
 *  Read — but if the file already exists, we treat it as a full
 *  rewrite and still require Read-first so accidental overwrites are
 *  caught. Missing file path → creation. */
export async function applyWrite(
  req: WriteRequest,
  readStore: ReadFileStateStore,
): Promise<EditOutcome> {
  if (typeof req.file_path !== 'string' || req.file_path.length === 0) {
    return { ok: false, code: EditErrorCode.ValidationError, message: 'file_path must be a non-empty string' };
  }
  if (typeof req.content !== 'string') {
    return { ok: false, code: EditErrorCode.ValidationError, message: 'content must be a string' };
  }

  const absPath = resolveInSession(req.file_path);
  const writeBoundaryReject = boundaryReject(absPath);
  if (writeBoundaryReject) return { ok: false, code: EditErrorCode.PolicyRejected, message: writeBoundaryReject, meta: { file_path: req.file_path } };

  // WF3 — plan mode gate. Same semantics as applyEdit: only the plan
  // file is writable during plan mode.
  const planBlock = assertPlanGate(req.file_path);
  if (planBlock) {
    return {
      ok: false,
      code: EditErrorCode.PolicyRejected,
      message: planBlock.message,
      meta: { file_path: req.file_path, planMode: true },
    };
  }

  let original: string | null = null;
  try {
    original = await fsp.readFile(absPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/ENOENT/i.test(msg)) {
      return { ok: false, code: EditErrorCode.IoFailed, message: `read failed: ${msg}`, meta: { file_path: req.file_path } };
    }
    original = null; // file doesn't exist — creation path
  }

  if (original !== null) {
    const entry = readStore.verifyBeforeEdit(req.file_path);
    if (!entry) {
      return {
        ok: false,
        code: EditErrorCode.NotReadFirst,
        message: `${req.file_path} exists — Read it first to confirm you want a full overwrite, or use Edit for partial changes.`,
        meta: { file_path: req.file_path },
      };
    }
    if (entry.contentHash && hashContent(original) !== entry.contentHash) {
      return {
        ok: false,
        code: EditErrorCode.ModifiedSinceRead,
        message: `${req.file_path} changed on disk since Read — re-Read before overwriting.`,
        meta: { file_path: req.file_path },
      };
    }
  }

  if (original === req.content) {
    return { ok: false, code: EditErrorCode.NoChange, message: 'content identical to existing file' };
  }

  const before = original ?? '';
  const hunks = computePatch(req.file_path, before, req.content);
  const { added, removed } = countPatchChanges(hunks);

  // CE4 — policy gate (parallel to applyEdit).
  const decision = assessWrite(req, getPolicy());
  const gate = await runPolicyGate(decision, {
    kind: 'write',
    file_path: req.file_path,
    changeSummary: original === null
      ? `create new file (${added} lines)`
      : `overwrite (${added} lines added, ${removed} removed)`,
    preview: {
      structuredPatch: hunks,
      originalContent: before,
      newContent: req.content,
      linesAdded: added,
      linesRemoved: removed,
    },
  });
  if (gate !== null) return gate;

  // CE5 — baseline snapshot for Write (null `original` = creation).
  getTurnDiffTracker().onBeforeEdit(req.file_path, original);
  // UT2 — per-turn ghost-commit (applyEdit has the same hook).
  try { captureIfFirstMutationOfTurn(getSessionCwd()); } catch { /* noop */ }

  try {
    await fsp.writeFile(absPath, req.content, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      code: EditErrorCode.IoFailed,
      message: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      meta: { file_path: req.file_path },
    };
  }

  readStore.recordRead(req.file_path, { content: req.content });

  return {
    ok: true,
    file_path: req.file_path,
    structuredPatch: hunks,
    originalContent: before,
    newContent: req.content,
    edits: [{ old_string: before, new_string: req.content }],
    linesAdded: added,
    linesRemoved: removed,
  };
}

/** Read from disk + record into the store. The tool layer wraps this.
 *  Optional offset (0-indexed line) and limit implement partial view
 *  — partialView:true flag flows through so later Edit is blocked. */
export async function applyRead(
  file_path: string,
  readStore: ReadFileStateStore,
  opts: { offset?: number; limit?: number } = {},
): Promise<{ ok: true; content: string; lines: number; truncated: boolean } | { ok: false; message: string; code: EditErrorCode }> {
  if (typeof file_path !== 'string' || file_path.length === 0) {
    return { ok: false, code: EditErrorCode.ValidationError, message: 'file_path must be a non-empty string' };
  }
  const absPath = resolveInSession(file_path);
  let content: string;
  try {
    content = await fsp.readFile(absPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT/i.test(msg)) {
      return { ok: false, code: EditErrorCode.FileNotFound, message: `file not found: ${file_path}` };
    }
    return { ok: false, code: EditErrorCode.IoFailed, message: `read failed: ${msg}` };
  }

  const partial = opts.offset !== undefined || opts.limit !== undefined;
  let view = content;
  let truncated = false;
  if (partial) {
    const lines = content.split('\n');
    const start = Math.max(0, opts.offset ?? 0);
    const end = opts.limit !== undefined ? Math.min(lines.length, start + opts.limit) : lines.length;
    view = lines.slice(start, end).join('\n');
    truncated = end < lines.length;
  }

  readStore.recordRead(file_path, { partialView: partial, content: partial ? undefined : content });
  return { ok: true, content: view, lines: content.split('\n').length, truncated };
}
