// ── PtyHostFactory (NT-C1b-3) ──
//
// Hands a long-lived TerminalHost (PreviewTerminal) to the
// dispatcher every time a mode='vw' / 'modal' command lands.
// Key guarantees:
//   • Hosts are keyed by VW label (default 'runner') so sequential
//     commands in the same label re-use the same PTY + scrollback.
//   • Each host spawns a real shell on first use; subsequent calls
//     return the same live instance.
//   • Dead hosts (PTY exited) are evicted automatically so the next
//     request re-spawns cleanly.
//
// The actual "put this PTY into a VW pane" wiring lives in NT-C1b-4
// (terminal-slot-content hook). This phase intentionally keeps the
// factory orthogonal so we can validate PTY lifetime + re-use
// semantics without VW coupling first.

import { requirePosixShell } from '../platform/default-shell.js';
import { PreviewTerminal } from '../preview/terminal.js';
import { shellChildEnv } from './child-env.js';
import type { ShellRequest } from './types.js';
import type { TerminalHost } from './pty-engine.js';
import { detectShellKind, makeOsc133RcFile } from './osc133-rc.js';

export interface RunnerHostFactoryOpts {
  /** Session cwd resolver — factory calls this when the request
   *  doesn't pin a cwd. Wiring uses the dashboard's getSessionCwd(). */
  getSessionCwd: () => string;
  /** Default shell / shellArgs when the request doesn't override.
   *  Dashboard passes $SHELL (fallback /bin/bash). */
  defaultShell?: string;
  defaultShellArgs?: readonly string[];
  /** Initial terminal size. Dashboard passes termSize() so panes
   *  inherit the current screen dims before VW placement kicks in. */
  initialSize?: () => { cols: number; rows: number };
  /** Test hook: inject fake PreviewTerminal factory. */
  terminalFactory?: (label: string, spec: {
    cols: number; rows: number; cwd: string; shell?: string;
    shellArgs?: readonly string[]; env?: Record<string, string>;
  }) => TerminalHost & { start?: () => void };
  /** Fires the first time a host is spawned under the given label.
   *  Caller typically uses this to plant the PreviewTerminal in a VW
   *  pane (NT-C1b-4 wiring). */
  onSpawn?: (label: string, host: TerminalHost) => void;
  onEvict?: (label: string) => void;
  /** SP-E — fires when PreviewTerminal / terminalFactory throws inside
   *  spawnHost. The factory still returns null (graceful degrade to
   *  the file engine); this hook lets the host surface a chat-log
   *  warning so the user knows why their VW didn't appear. */
  onSpawnError?: (label: string, err: unknown) => void;
}

export interface RunnerHostFactory {
  /** The function the ShellRunner dispatch calls. Returns a
   *  TerminalHost or null if the factory couldn't prepare one
   *  (e.g. shell binary missing — dispatcher falls back to the
   *  file engine). */
  factory: (req: ShellRequest) => TerminalHost | null;
  /** Force-drop a runner host by label (test + /term kill slash). */
  evict: (label: string) => boolean;
  /** Enumerate known runner hosts — for diagnostics. */
  list: () => Array<{ label: string; alive: boolean }>;
  /** Drop every cached host. */
  disposeAll: () => void;
}

const DEFAULT_LABEL = 'runner';

export function createRunnerHostFactory(opts: RunnerHostFactoryOpts): RunnerHostFactory {
  const hosts = new Map<string, TerminalHost>();

  const resolveLabel = (req: ShellRequest): string =>
    req.vw?.windowLabel ?? DEFAULT_LABEL;

  // Label → cleanup thunks for OSC 133 rc temp files. Indexed by label
  // so evict() / disposeAll() can release tmp dirs cleanly.
  const rcCleanups = new Map<string, () => void>();

  const spawnHost = (label: string, req: ShellRequest): TerminalHost | null => {
    const cwd = req.cwd ?? opts.getSessionCwd();
    const size = opts.initialSize?.() ?? { cols: 100, rows: 30 };
    let shell: string;
    try { shell = opts.defaultShell ?? requirePosixShell('/bin/bash'); }
    catch (err) {
      try { opts.onSpawnError?.(label, err); } catch { /* isolate */ }
      return null;
    }
    const shellArgs: string[] = [...(opts.defaultShellArgs ?? [])];
    const env = shellChildEnv(process.env, req.env);

    // NT-C1b-5 — inject OSC 133 rc for bash/zsh so PtyCaptureEngine
    // can pin command-end boundaries without prompt heuristics. Other
    // shells (fish, pwsh, sh…) run unchanged; the engine falls back
    // to quiet-idle + exit-code detection there.
    const shellKind = detectShellKind(shell);
    const rc = shellKind ? makeOsc133RcFile(shellKind) : null;
    if (rc) {
      shellArgs.push(...rc.spawnArgs);
      Object.assign(env, rc.env);
    }

    const spec = {
      cols: size.cols,
      rows: size.rows,
      cwd,
      shell,
      shellArgs,
      env,
    };

    try {
      if (opts.terminalFactory) {
        const host = opts.terminalFactory(label, spec);
        host.start?.();
        if (rc) rcCleanups.set(label, rc.cleanup);
        return host;
      }
      const pty = new PreviewTerminal({ ...spec, isolatedEnv: true });
      pty.start();
      if (rc) rcCleanups.set(label, rc.cleanup);
      return pty;
    } catch (err) {
      // Spawn failed — release the rc immediately so we don't leak
      // a tmp dir waiting for a cleanup that'll never come.
      if (rc) try { rc.cleanup(); } catch { /* ignore */ }
      try { opts.onSpawnError?.(label, err); } catch { /* isolate */ }
      return null;
    }
  };

  const factory = (req: ShellRequest): TerminalHost | null => {
    const label = resolveLabel(req);
    // Evict dead hosts lazily.
    const existing = hosts.get(label);
    if (existing && !existing.isAlive) {
      hosts.delete(label);
      try { opts.onEvict?.(label); } catch { /* ignore */ }
    }
    if (hosts.has(label)) return hosts.get(label)!;
    const host = spawnHost(label, req);
    if (!host) return null;
    hosts.set(label, host);
    try { opts.onSpawn?.(label, host); } catch { /* ignore */ }
    return host;
  };

  const evict = (label: string): boolean => {
    const host = hosts.get(label);
    if (!host) return false;
    try {
      (host as unknown as { stop?: () => void }).stop?.();
    } catch { /* ignore */ }
    hosts.delete(label);
    const rc = rcCleanups.get(label);
    if (rc) {
      try { rc(); } catch { /* ignore */ }
      rcCleanups.delete(label);
    }
    try { opts.onEvict?.(label); } catch { /* ignore */ }
    return true;
  };

  const list = () =>
    [...hosts.entries()].map(([label, host]) => ({ label, alive: host.isAlive }));

  const disposeAll = () => {
    for (const label of [...hosts.keys()]) evict(label);
  };

  return { factory, evict, list, disposeAll };
}
