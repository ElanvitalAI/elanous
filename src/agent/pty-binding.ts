// H5 Phase 1 Step D · PTY binding primitive.
//
// Thin seam between agent adapters (`src/agent/adapters/**`) and the
// existing PTY registry (`src/pty-shell/registry.ts`). Adapters call
// `bindAgentToVW(...)` instead of `startPty(...)` directly so:
//
//   1. The bus evolves independently of the pty-shell API.
//   2. Tests can substitute a synthetic PTY without adapter-specific
//      mocks (pty-shell already has `setPtyAdapterForTesting`, but
//      this layer normalises the adapter-facing shape).
//   3. VW pane intent (`paneId`) travels with the handle so the
//      slash-command caller (Step E) knows where to mount.
//
// This file deliberately stays independent of the display layer —
// mounting a PTY into a VW pane is a display concern and belongs to
// the consumer of the returned BoundAgent (slash wiring, VW tool,
// etc.). Keeping the boundary clean lets AXON and IDX evolve
// independently.

import { startPty, type PtyHandle, type StartOpts } from '../pty-shell/registry.js';

export interface BindAgentOpts {
  /** Binary to spawn (resolved on PATH or absolute). */
  readonly binary: string;
  /** Args for the binary. Default empty. */
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** terminfo name; see pty-shell ALLOWED_TERM_NAMES. */
  readonly term?: string;
  readonly cols?: number;
  readonly rows?: number;
  /** VW pane the caller intends to mount into. Not mounted here —
   *  the consumer (slash wiring · Step E) owns the VW side. Stored
   *  on the returned BoundAgent so downstream has it without an
   *  extra parameter. */
  readonly paneId?: string;
  /** Forwarded to pty-shell: whether to auto-kill on skill-runner
   *  return. Agent sessions are typically long-lived — default true
   *  (detach) so the session survives the triggering skill. */
  readonly detach?: boolean;
}

export interface BoundAgent {
  /** pty-shell handle owning the subprocess · write/kill/snapshot. */
  readonly ptyHandle: PtyHandle;
  /** Advisory · paneId the caller requested. */
  readonly paneId?: string;
}

/** Spawn a PTY subprocess for an embodied agent session.
 *
 *  This is the single entrypoint agent adapters use. We do not spawn
 *  into a VW pane — mounting is the caller's responsibility.
 *
 *  Throws if pty-shell's node-pty binding isn't available (propagated
 *  from `startPty`). Callers should surface this as a clear "install
 *  node-pty" error. */
export function bindAgentToVW(opts: BindAgentOpts): BoundAgent {
  const startOpts: StartOpts = {
    cmd: opts.binary,
    args: opts.args ? [...opts.args] : undefined,
    workdir: opts.cwd,
    env: opts.env,
    term: opts.term,
    cols: opts.cols,
    rows: opts.rows,
    // Agent sessions are typically intentionally long-lived — default
    // detach=true so the session survives the slash command that
    // spawned it. Callers can override.
    detach: opts.detach ?? true,
  };
  const ptyHandle = startPty(startOpts);
  return {
    ptyHandle,
    paneId: opts.paneId,
  };
}
