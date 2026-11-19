// Bun-native PTY backend — node-pty replacement for the Bun runtime.
//
// WHY: node-pty is a napi native addon. Under Bun its bindings load but
// the PTY data pipe never delivers — `pty.onData(cb)` fires zero bytes
// (not even the terminal echo), so every PTY consumer silently captures
// empty output. Both upstreams closed this WONTFIX:
//   • oven-sh/bun#7362 ("node-pty unable to be run from bun" — not planned)
//   • microsoft/node-pty#632 ("Bun support" — out-of-scope)
// Our daemon ships `#!/usr/bin/env bun`, so on the production runtime the
// entire PTY stack (PtyShell*, nexus webterm, TUI PreviewTerminal) was
// dark. Verified locally: node captures `cat` echo, Bun captures "".
//
// FIX: Bun v1.3.5 (2025-12) added a native PTY — `Bun.spawn(argv,
// { terminal: {...} })` backed by POSIX openpty / Windows ConPTY. This
// module wraps it in the subset of node-pty's `IPty` that our three
// spawn sites use (pid · onData · onExit · write · kill · resize), so
// each site can pick the backend with a one-line guard:
//
//   const p = bunNativePtyAvailable()
//     ? bunSpawnPty(file, args, opts)
//     : pty.spawn(file, args, opts);
//
// Verified end-to-end under Bun v1.3.12: interactive REPL (stateful
// multi-turn), terminal echo, and exit propagation all work.

import { constants as osConstants } from 'node:os';

/** Write every UTF-8 byte, honoring partial writes and bounding backpressure. */
export async function writeTerminalFully(terminal: { readonly closed: boolean; write(data: Uint8Array): number }, data: string): Promise<void> {
  const bytes = Buffer.from(data, 'utf8');
  const deadline = Date.now() + 3000;
  let offset = 0;
  while (offset < bytes.length) {
    if (terminal.closed || Date.now() >= deadline) throw new Error(`PTY write incomplete: ${offset}/${bytes.length} bytes`);
    const written = terminal.write(bytes.subarray(offset));
    if (!Number.isInteger(written) || written < 0 || written > bytes.length - offset) throw new Error(`PTY write returned ${written}`);
    offset += written;
    if (offset < bytes.length) await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

/** Subset of node-pty's `IPty` that elanous's PTY spawn sites consume. */
export interface MinimalPty {
  readonly pid: number;
  write(data: string): void;
  writeAll?(data: string): Promise<void>;
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  /** ⭐ `exitCode` is `number | null` — null means "the child exited but we
   *  could not learn the code". ⛔ Never treat null as 0; use the fact that
   *  this callback fired at all as the liveness answer. */
  onExit(cb: (e: { exitCode: number | null; signal?: number }) => void): { dispose(): void };
}

export interface BunSpawnPtyOpts {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

function bunRef(): { spawn?: unknown; version?: string } | undefined {
  return (globalThis as { Bun?: { spawn?: unknown; version?: string } }).Bun;
}

/** True when running under Bun ≥ 1.3.5, where `Bun.spawn`'s `terminal`
 *  option (native PTY) exists. Below 1.3.5 there is no native PTY and we
 *  fall back to node-pty (which is itself broken under Bun, but the guard
 *  keeps the branch honest — such Bun versions predate our floor). */
export function bunNativePtyAvailable(): boolean {
  const B = bunRef();
  if (!B || typeof B.spawn !== 'function' || typeof B.version !== 'string') return false;
  const [maj = 0, min = 0, pat = 0] = B.version.split('.').map((n) => parseInt(n, 10) || 0);
  // ≥ 1.3.5
  if (maj !== 1) return maj > 1;
  if (min !== 3) return min > 3;
  return pat >= 5;
}

/** Spawn a process under Bun's native PTY, returning a node-pty-shaped
 *  `MinimalPty`. Callers must gate on `bunNativePtyAvailable()` first. */
export function bunSpawnPty(file: string, args: string[], opts: BunSpawnPtyOpts = {}): MinimalPty {
  const B = bunRef();
  if (!B || typeof B.spawn !== 'function') {
    throw new Error('bunSpawnPty called without Bun.spawn — gate on bunNativePtyAvailable()');
  }
  const dataListeners = new Set<(d: string) => void>();
  const exitListeners = new Set<(e: { exitCode: number | null; signal?: number }) => void>();
  // Streaming decode so a multibyte UTF-8 sequence split across two PTY
  // chunks isn't mangled (node-pty already hands us decoded strings).
  const decoder = new TextDecoder();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spawn = B.spawn as (argv: string[], o: any) => any;
  const proc = spawn([file, ...args], {
    terminal: {
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      name: opts.name ?? 'xterm-256color',
      data(_t: unknown, chunk: Uint8Array) {
        const s = decoder.decode(chunk, { stream: true });
        if (s.length === 0) return;
        for (const cb of dataListeners) cb(s);
      },
    },
    cwd: opts.cwd,
    env: opts.env,
  });

  let exitFired = false;
  /** Last observed child exit code. `null` until the child actually exits —
   *  ⛔ never default it to 0: a swallowed code makes "died with 7" read as
   *  "finished cleanly", and every layer above (drive, harness, agents)
   *  loses the only first-hand answer to *why the child ended*.
   *  ⭐ It also stays `null` when the child HAS exited but we genuinely could
   *  not learn the code — "죽었지만 모름" is a third state, and collapsing it
   *  into 0 is the exact lie this module exists to stop. Liveness therefore
   *  must NOT be read off this field; `exitFired` is the liveness answer. */
  let observedExitCode: number | null = null;
  /** Signal number that killed the child, if any. Stored so a listener that
   *  subscribes AFTER the exit gets the same `{exitCode, signal}` pair as one
   *  that subscribed before — the observation contract cannot depend on when
   *  you happened to call `onExit`. */
  let observedSignal: number | undefined = undefined;
  const resolveExitCode = (settled?: unknown): number | null => {
    // `proc.exited` RESOLVES TO the exit code — prefer it, because
    // `proc.exitCode` can still be null on the turn the promise settles.
    if (typeof settled === 'number') return settled;
    if (typeof proc.exitCode === 'number') return proc.exitCode;
    return null;
  };
  const fireExit = (settled?: unknown): void => {
    if (exitFired) return;
    exitFired = true;
    const rawCode = resolveExitCode(settled);
    const sigName: string | null = proc.signalCode ?? null;
    observedSignal = sigName ? signalNameToNumber(sigName) : undefined;
    // A signal kill has no numeric exit code; report the conventional
    // 128+signal rather than 0 so callers can still tell death from success.
    // ⛔ If BOTH are unknown, report null — not 0. A rare unmapped signal or a
    //    racing `proc.exited` must not be laundered into "exited cleanly".
    observedExitCode = rawCode ?? (observedSignal !== undefined ? 128 + observedSignal : null);
    for (const cb of exitListeners) cb({ exitCode: observedExitCode, signal: observedSignal });
  };
  // `proc.exited` resolves on both clean exit and signal kill.
  Promise.resolve(proc.exited).then(fireExit, fireExit);

  return {
    get pid(): number {
      return proc.pid;
    },
    write(data: string): void {
      try {
        proc.terminal.write(data);
      } catch {
        /* terminal closed — writes after exit are no-ops, like node-pty */
      }
    },
    async writeAll(data: string): Promise<void> { await writeTerminalFully(proc.terminal, data); },
    kill(signal?: string): void {
      try {
        proc.kill(signal as never);
      } catch {
        /* already dead */
      }
    },
    resize(cols: number, rows: number): void {
      try {
        proc.terminal.resize(cols, rows);
      } catch {
        /* terminal closed */
      }
    },
    onData(cb: (data: string) => void): { dispose(): void } {
      dataListeners.add(cb);
      return {
        dispose(): void {
          dataListeners.delete(cb);
        },
      };
    },
    onExit(cb: (e: { exitCode: number | null; signal?: number }) => void): { dispose(): void } {
      exitListeners.add(cb);
      // ⭐ Replay the SAME pair a pre-exit subscriber saw — code AND signal.
      //    Dropping `signal` here made `{exitCode:137, signal:9}` degrade to
      //    `{exitCode:137}` purely by subscription timing (review 2R must-fix).
      if (exitFired) cb({ exitCode: observedExitCode, signal: observedSignal });
      return {
        dispose(): void {
          exitListeners.delete(cb);
        },
      };
    },
  };
}

// Signal-name → number. node-pty reports a numeric signal; Bun reports the
// name via `signalCode`.
// ⭐ Source the mapping from the platform (`os.constants.signals`) instead of
//    a hand-written list. The previous list held five entries, so a child
//    killed by SIGSEGV/SIGABRT/SIGBUS — precisely the deaths worth seeing —
//    produced `signal: undefined`, and the caller then had nothing but a
//    fabricated exit code to look at (review 2R must-fix).
const SIGNAL_TO_NUM: Record<string, number> = osConstants.signals as unknown as Record<string, number>;

/** Signal name → number, or undefined if the platform does not know the name. */
function signalNameToNumber(name: string): number | undefined {
  const n = SIGNAL_TO_NUM[name];
  return typeof n === 'number' ? n : undefined;
}
