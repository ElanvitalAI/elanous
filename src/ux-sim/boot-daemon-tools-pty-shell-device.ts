// ux-sim device — boot daemon-tools PtyShellStart stage (L2: env injection).
//
// TUI-NO-SELF-NEST (#27) needs evidence that travels the REAL call path, not
// a source-string check: the stage below injects a TUI PTY context
// (ELANOUS_PARENT_PTY_ID / ELANOUS_NEST_DEPTH — the same material
// src/pty-shell/registry.ts stamps into a child's identity) and then calls
// the production dispatcher `dispatchPtyShellTool` in
// src/boot/daemon-tools/pty-shell.ts, which is where PtyShellStart is
// actually served. The stage records command · rc · output tail so the run
// transcript can go straight into a PR body.
//
// The stage never wants a live nested TUI: when a scenario is expected to be
// refused, the dispatcher answers with `{ output: guidance }` and no PTY is
// created. If a scenario slips through, the stage kills the spawned PTY
// before reporting so the run leaves nothing behind.

import { dispatchPtyShellTool } from '../boot/daemon-tools/pty-shell.js';
import {
  decideTuiSelfNest,
  TUI_SELF_NEST_REJECT_MARKER,
  type TuiSelfNestDecision,
} from '../agent/terminal-surface.js';

export interface PtyShellStageInput {
  /** argv of the spawn request — e.g. ['eln'] or ['/usr/bin/eln', 'chat']. */
  argv: string[];
  /** Injected "inside a TUI" material. null ⇒ no TUI context. */
  parentPtyId?: string | null;
  /** Injected nest depth (ELANOUS_NEST_DEPTH). */
  nestDepth?: number;
  /** Extra PtyShellStart args (workdir, env, …) merged into the call. */
  extraArgs?: Record<string, unknown>;
}

export interface PtyShellStageResult {
  /** The argv as it crossed the production dispatcher. */
  command: string;
  /** 0 = the stage produced the outcome the scenario asked for. */
  rc: number;
  /** True when the production path refused the spawn with guidance. */
  rejected: boolean;
  /** Full output returned by the production dispatcher. */
  output: string;
  /** Last 3 lines of output — what the PR body quotes. */
  outputTail: string;
  /** A PTY that was created despite the scenario (leak guard). */
  spawnedPid: string | null;
}

const ENV_KEYS = ['ELANOUS_PARENT_PTY_ID', 'ELANOUS_NEST_DEPTH', 'ELANOUS_PTY_ID'] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function tailOf(output: string, lines = 3): string {
  return output.split('\n').filter((l) => l.length > 0).slice(-lines).join('\n');
}

/** Apply the scenario's TUI context to this process, exactly as a TUI-owned
 *  seat shell would have it, then run the production PtyShellStart path. */
export async function runPtyShellStartStage(input: PtyShellStageInput): Promise<PtyShellStageResult> {
  const saved = snapshotEnv();
  const parentPtyId = input.parentPtyId ?? null;
  const nestDepth = input.nestDepth ?? 0;
  try {
    if (parentPtyId) {
      process.env.ELANOUS_PARENT_PTY_ID = parentPtyId;
      // pty-identity's getCurrentPtyId() reads its own pty id; mirror it so
      // the stage exercises both halves of readTuiNestEnv's source chain.
      process.env.ELANOUS_PTY_ID = parentPtyId;
    } else {
      delete process.env.ELANOUS_PARENT_PTY_ID;
      delete process.env.ELANOUS_PTY_ID;
    }
    if (nestDepth > 0) process.env.ELANOUS_NEST_DEPTH = String(nestDepth);
    else delete process.env.ELANOUS_NEST_DEPTH;

    const [cmd, ...args] = input.argv;
    const result = await dispatchPtyShellTool('PtyShellStart', {
      ...(input.extraArgs ?? {}),
      cmd: cmd ?? '',
      args,
    });

    const shaped = (result ?? {}) as { output?: unknown; process_id?: unknown; id?: unknown };
    const output = typeof shaped.output === 'string' ? shaped.output : JSON.stringify(result ?? null);
    const rejected = output.includes(TUI_SELF_NEST_REJECT_MARKER);
    const rawPid = shaped.process_id ?? shaped.id;
    const spawnedPid = rejected || rawPid === undefined ? null : String(rawPid);
    if (spawnedPid) {
      try { await dispatchPtyShellTool('PtyShellKill', { process_id: spawnedPid }); } catch { /* leak guard */ }
    }
    return {
      command: input.argv.join(' '),
      rc: rejected ? 0 : 1,
      rejected,
      output,
      outputTail: tailOf(output),
      spawnedPid,
    };
  } finally {
    restoreEnv(saved);
  }
}

/** Classifier-only view of the same scenario — used for the allow-list rows
 *  (commands that must keep running) without spawning anything. */
export function inspectPtyShellStartStage(input: PtyShellStageInput): TuiSelfNestDecision {
  const saved = snapshotEnv();
  try {
    if (input.parentPtyId) {
      process.env.ELANOUS_PARENT_PTY_ID = input.parentPtyId;
      process.env.ELANOUS_PTY_ID = input.parentPtyId;
    } else {
      delete process.env.ELANOUS_PARENT_PTY_ID;
      delete process.env.ELANOUS_PTY_ID;
    }
    if ((input.nestDepth ?? 0) > 0) process.env.ELANOUS_NEST_DEPTH = String(input.nestDepth);
    else delete process.env.ELANOUS_NEST_DEPTH;
    const [cmd, ...args] = input.argv;
    return decideTuiSelfNest([cmd ?? '', ...args]);
  } finally {
    restoreEnv(saved);
  }
}
