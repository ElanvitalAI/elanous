// ── ShellRunner dispatch (NT-C1) ──
//
// Public entry point for the 4-mode shell execution pipeline.
// Callers hand in a ShellRequest; we choose the right engine
// (File vs Pty), spawn a ShellHandle, register it with the
// ShellRegistry, and return the handle. The request's `mode`
// determines which engine is chosen:
//
//   mode='inline' | 'bg'        → FileCaptureEngine (always available)
//   mode='modal' | 'vw'         → PtyCaptureEngine (requires a
//                                 ptyHostFactory from the host)
//   mode='auto' | undefined     → DEFAULT_SHELL_MODE (='vw') when a
//                                 factory is available; else 'inline'
//                                 fallback (keeps inline-only hosts
//                                 functional without VW wiring).
//
// Why a factory rather than a single TerminalHost?
// The PTY engine needs a *new* host per runner VW — we can't
// share a single host across modal and vw runs that want different
// backing terminals. The factory is a function the dashboard boot
// provides (once the terminal matrix + VW registry are live).
//
// This file intentionally does NOT touch the existing
// RunShell/Bash/TerminalModalSpawn tool registrations. Those stay
// unchanged in this phase; a later phase (NT-C1b) re-routes them
// through here.

import type { CaptureEngine, RunCtx, ShellHandle, ShellMode, ShellRequest } from './types.js';
import { DEFAULT_SHELL_MODE } from './types.js';
import { createFileCaptureEngine } from './file-engine.js';
import { createPtyCaptureEngine } from './pty-engine.js';
import type { TerminalHost } from './pty-engine.js';
import type { ShellRegistry } from './registry.js';

export interface ShellRunnerDeps {
  /** The ShellRegistry to auto-register handles into. */
  registry: ShellRegistry;
  /** FileCaptureEngine instance. Injected so tests can swap it. If
   *  null/undefined at dispatch time we lazily build one. */
  fileEngine?: CaptureEngine;
  /** Factory: given a request, return the PTY host for the chosen
   *  runner VW / modal. Returns null when no suitable host exists
   *  and the caller isn't allowed to create one (e.g. VW subsystem
   *  down). When the factory returns null we fall back to the file
   *  engine with a warning. */
  ptyHostFactory?: (req: ShellRequest) => TerminalHost | null;
  /** Called after a handle is registered, so the caller can attach
   *  the right surface (inline / bg / modal / vw). Kept opt-in so
   *  this layer doesn't require the full surface stack to be wired. */
  attachSurface?: (handle: ShellHandle, req: ShellRequest) => void;
  now?: () => number;
}

export interface RunShellOpts {
  /** RunCtx forwarded to the engine. When omitted, a minimal
   *  default is synthesized (cwd = req.cwd or process.cwd()). */
  ctx?: RunCtx;
}

let singleton: ShellRunnerDeps | null = null;

/** Install the runtime-wide shell-runner deps. Called once during
 *  dashboard boot after the registry + VW factory are ready. */
export function setShellRunnerDeps(deps: ShellRunnerDeps): void {
  singleton = deps;
}

export function getShellRunnerDeps(): ShellRunnerDeps | null {
  return singleton;
}

export function resetShellRunnerDeps(): void {
  singleton = null;
}

/** Dispatch a ShellRequest. Resolves the effective mode, chooses
 *  the engine, registers the handle, invokes attachSurface. */
export function runShell(
  req: ShellRequest,
  deps: ShellRunnerDeps,
  opts: RunShellOpts = {},
): ShellHandle {
  const effectiveMode = resolveMode(req.mode, deps);
  if ((req.mode === 'vw' || req.mode === 'modal') && !deps.ptyHostFactory) {
    throw new Error(`RunShell(mode:"${req.mode}") requires an attachable PTY surface`);
  }
  const engine = pickEngine(effectiveMode, req, deps);
  const ctx: RunCtx = opts.ctx ?? {
    getCwd: () => req.cwd ?? process.cwd(),
  };
  const normalizedReq: ShellRequest = { ...req, mode: effectiveMode };
  const handle = engine.run(normalizedReq, ctx);
  deps.registry.register(handle);
  try { deps.attachSurface?.(handle, normalizedReq); } catch { /* isolate */ }
  return handle;
}

/** Resolve `auto` + missing mode into a concrete mode. */
export function resolveMode(
  mode: ShellMode | undefined,
  deps: ShellRunnerDeps,
): Exclude<ShellMode, 'auto'> {
  if (mode && mode !== 'auto') return mode;
  // 'vw' is the declared default, but only when a factory exists;
  // hosts that only have the file engine (tests, minimal CLI paths)
  // transparently fall back to inline.
  if (deps.ptyHostFactory) return DEFAULT_SHELL_MODE === 'auto' ? 'vw' : DEFAULT_SHELL_MODE;
  return 'inline';
}

function pickEngine(
  mode: Exclude<ShellMode, 'auto'>,
  req: ShellRequest,
  deps: ShellRunnerDeps,
): CaptureEngine {
  if (mode === 'inline' || mode === 'bg') {
    return deps.fileEngine ?? createFileCaptureEngine();
  }
  // PTY modes — vw, modal.
  const host = deps.ptyHostFactory?.(req);
  if (!host) {
    // No factory available — degrade gracefully to the file engine
    // with inline semantics. Caller log is the responsibility of
    // the dashboard wiring (which has surface-level toast access).
    return deps.fileEngine ?? createFileCaptureEngine();
  }
  return createPtyCaptureEngine({ host, now: deps.now });
}
