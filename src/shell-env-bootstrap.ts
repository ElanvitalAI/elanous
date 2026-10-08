// ── Shell env bootstrap (F3 · 2026-04-21) ─────────────────────────────
//
// Capture the user's **login + interactive** shell environment once at
// process startup so every PTY we spawn inherits the PATH / aliases /
// activation-script env that `.zprofile` would normally contribute.
//
// Problem this solves
// -------------------
// On macOS (especially ARM) the PATH that includes `/opt/homebrew/bin`
// is set by `.zprofile`:
//
//     eval "$(/opt/homebrew/bin/brew shellenv)"
//
// zsh only reads `.zprofile` for **login** shells. node-pty spawns the
// user's `$SHELL` with no `-l` flag, so `.zshrc` runs (interactive),
// but `.zprofile` does not (login). Result: brew/starship/atuin/fzf/
// pyenv/zoxide all log `command not found` the moment a fresh PTY
// starts.
//
// Strategy (borrowed from Zed — `crates/util/src/shell_env.rs`):
//   1. On first call, spawn `$SHELL -l -i -c 'printenv'` synchronously
//      with a short timeout.
//   2. Parse `KEY=VALUE` lines into a record.
//   3. Cache. Every subsequent PTY spawn uses this record as its env
//      base instead of `process.env`.
//
// Fallbacks (robustness)
// ----------------------
//   - Unknown/unavailable `$SHELL` → return `process.env` verbatim.
//   - Spawn exits non-zero / times out → return `process.env`.
//   - Empty output → return `process.env`.
//   - Windows / non-POSIX shell names → skip (we only gate POSIX names).
//
// Explicitly a NO-OP when:
//   - `ELANOUS_SKIP_LOGIN_ENV=1` is set (escape hatch for debugging).
//   - `process.env.TERM_PROGRAM === 'monad-agent-nested'` (don't
//     double-capture when we're spawned inside ourselves).
//
// (2026-07-26) Nothing inside `src/` sets `monad-agent-nested`, so that second
// branch only fires for an EXTERNAL executor that sets it deliberately. Retiring
// it is tracked separately (DESIGN-instance-leader-and-default-test §9-2c) and is
// deliberately NOT bundled into the PTY identity-propagation fix, whose invariant
// is "no behaviour change for existing callers".
//
// ⚠️ Runtime instance identity (`ELANOUS_STATE_DIR`, nest depth, harness space) does
// NOT survive this capture — the login shell cannot reproduce what the process set
// at runtime. It crosses the PTY boundary via `identityEnv()` layered ON TOP of the
// captured snapshot; see `agent/identity-env.ts`. Never merge `process.env`
// wholesale here — that re-breaks the `.zprofile` PATH this module exists to fix.

/// <reference path="./vendor-types.d.ts" />

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { debug } from './debug/log.js';

const TIMEOUT_MS = 3000;
// An interactive shell (`-i`) ignores SIGTERM, so the default timeout signal never ends it: the
// capture then blocks until the rc files finish. 10-08 TUI-BOOT-60: a stale pyenv rehash lock made
// every `zsh -l -i` wait 60 s, and the «3 s» capture held the TUI boot for ~65 s. SIGKILL makes the
// timeout real.
const TIMEOUT_SIGNAL = 'SIGKILL' as const;
const POSIX_SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh']);

let cached: Record<string, string> | null = null;
let captured = false;

/** Parse `KEY=VALUE\n` output from `printenv`. Tolerates values that
 *  themselves contain `=`; does not attempt to unescape newlines
 *  (bash/zsh `printenv` emits them literally, which is fine for
 *  inheritance). Empty lines skipped. */
export function parsePrintenv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;           // no key, or leading `=`
    const k = line.slice(0, eq);
    const v = line.slice(eq + 1);
    out[k] = v;
  }
  return out;
}

/** Run `$SHELL -l -i -c 'printenv'` and return the parsed env, or
 *  `null` on any failure. Pure — no caching; callers should go through
 *  `getCapturedEnv()` for the memoized path.
 *
 *  NOTE: we pass a stripped env (not the full parent env) so `.zshrc`
 *  sees what a fresh Terminal.app login would see. Zed does the same
 *  (shell_env.rs:82-95) — the only vars we let through are the ones
 *  the shell itself needs to find its rc files:
 *    - HOME, USER, LOGNAME, SHELL, TERM
 *    - LANG / LC_* — locale matters for some prompts (starship, powerlevel)
 *  Everything else is left for the login shell itself to define. */
function captureSeed(): { shell: string; seedEnv: NodeJS.ProcessEnv } | null {
  const shell = process.env.SHELL;
  if (!shell) return null;
  const base = basename(shell);
  if (!POSIX_SHELLS.has(base)) return null;

  // Minimal env so rc files can't pick up our process's leaked vars.
  const seedEnv = {} as NodeJS.ProcessEnv;
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG']) {
    const v = process.env[k];
    if (v !== undefined) seedEnv[k] = v;
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('LC_') && typeof v === 'string') seedEnv[k] = v;
  }
  return { shell, seedEnv };
}

/** printenv output → env, or null when it does not look like a real login env. */
function acceptCapture(stdout: string): Record<string, string> | null {
  if (!stdout) return null;
  const parsed = parsePrintenv(stdout);
  // Sanity: require PATH and at least 5 keys, else something is off.
  if (!parsed.PATH || Object.keys(parsed).length < 5) return null;
  return parsed;
}

export function runPrintenvCapture(): Record<string, string> | null {
  const seed = captureSeed();
  if (!seed) return null;
  const { shell, seedEnv } = seed;

  let res: ReturnType<typeof spawnSync>;
  try {
    res = spawnSync(shell, ['-l', '-i', '-c', 'printenv'], {
      env: seedEnv,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      killSignal: TIMEOUT_SIGNAL,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Don't inherit our stdio — rc files that run `clear` or issue
      // OSC sequences would corrupt our TUI output otherwise.
    });
  } catch {
    return null;
  }
  // ETIMEDOUT with status 0 = the shell outlived the timeout; never trust a late capture.
  if (res.error) return null;
  if (res.status !== 0 && res.status !== null) return null;
  if (res.signal) return null;
  return acceptCapture(typeof res.stdout === 'string' ? res.stdout : '');
}

/** Fill the login-env cache off the event loop (daemon boot). The first web-terminal spawn otherwise ran the
 *  `-l -i` printenv with spawnSync and froze the whole daemon for ~3 s (10-02 TERM1). A no-op once captured;
 *  a failed warm leaves the cache empty so `getCapturedEnv()` still tries (and falls back) as before. */
export async function warmCapturedEnv(spawn: typeof Bun.spawn = Bun.spawn): Promise<boolean> {
  if (captured) return cached !== null;
  if (process.env.ELANOUS_SKIP_LOGIN_ENV === '1' || process.env.TERM_PROGRAM === 'monad-agent-nested') return false;
  const seed = captureSeed();
  if (!seed) return false;
  const start = Date.now();
  try {
    const proc = spawn([seed.shell, '-l', '-i', '-c', 'printenv'], { env: seed.seedEnv as Record<string, string>, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    // A grandchild (e.g. a pyenv rehash) can keep the stdout pipe open after the shell is killed,
    // so the timeout settles the race itself instead of waiting for EOF.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => { proc.kill(TIMEOUT_SIGNAL); resolve(null); }, TIMEOUT_MS);
    });
    const finished = Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
    const result = await Promise.race([finished, timedOut]);
    clearTimeout(timer);
    const parsed = result && result[1] === 0 ? acceptCapture(result[0]) : null;
    if (captured) return cached !== null; // a synchronous capture won the race
    if (!parsed) return false;
    cached = parsed;
    captured = true;
    debug.log('shell.envbootstrap.capture', 'warmed', { ok: true, ms: Date.now() - start, keyCount: Object.keys(parsed).length });
    return true;
  } catch {
    return false;
  }
}

/** Return the captured login env, running the capture on first call.
 *  Always returns a non-null record — on failure falls back to
 *  `process.env` so callers can treat the result as drop-in. */
export function getCapturedEnv(): Record<string, string> {
  if (captured && cached) return cached;
  if (captured && !cached) return process.env as Record<string, string>;

  if (process.env.ELANOUS_SKIP_LOGIN_ENV === '1'
      || process.env.TERM_PROGRAM === 'monad-agent-nested') {
    captured = true;
    cached = null;
    debug.log('shell.envbootstrap.capture', 'skipped', {
      ok: false, reason: 'opt-out', shell: process.env.SHELL ?? null,
    });
    return process.env as Record<string, string>;
  }

  const start = Date.now();
  const parsed = runPrintenvCapture();
  const ms = Date.now() - start;
  captured = true;
  if (parsed) {
    cached = parsed;
    debug.log('shell.envbootstrap.capture', 'ok', {
      ok: true, ms, shell: process.env.SHELL ?? null,
      pathLen: parsed.PATH?.length ?? 0,
      keyCount: Object.keys(parsed).length,
    });
    return parsed;
  }
  cached = null;
  debug.log('shell.envbootstrap.capture', 'fallback', {
    ok: false, ms, shell: process.env.SHELL ?? null,
    reason: 'spawn-failed-or-empty',
  });
  return process.env as Record<string, string>;
}

/** Whether the value `getCapturedEnv()` returns came from a REAL login-shell
 *  capture (vs. the `process.env` fallback). Isolation regression tests must
 *  assert this is true — on a fallback the identity survives anyway, so the
 *  test would pass for the wrong reason (see `agent/identity-env.ts` header). */
export function capturedEnvAvailable(): boolean {
  return captured && cached !== null;
}

/** Append login-shell PATH entries to the target without replacing its existing environment. */
export function mergeCapturedPath(target: NodeJS.ProcessEnv = process.env, opts: { capture?: boolean } = {}): number {
  // capture: 아직 캡처 전이면 여기서 한 번 캡처한다(호출부가 getCapturedEnv 를 직접 부르지 않게 — identity-env 래칫).
  const capturedPath = opts.capture || capturedEnvAvailable() ? getCapturedEnv().PATH : undefined;
  const seen = new Set((target.PATH ?? '').split(':'));
  const missing: string[] = [];
  for (const entry of capturedPath?.split(':') ?? []) {
    if (!entry || seen.has(entry)) continue;
    missing.push(entry);
    seen.add(entry);
  }
  if (missing.length) target.PATH = target.PATH ? `${target.PATH}:${missing.join(':')}` : missing.join(':');
  const added = missing.length;
  debug.log('shell.envbootstrap.capture', 'path-merged', { added });
  return added;
}

/** Reset cache — test seam. */
export function resetCapturedEnvForTesting(): void {
  cached = null;
  captured = false;
}

/** Inject a synthetic env — test seam. */
export function setCapturedEnvForTesting(env: Record<string, string> | null): void {
  cached = env;
  captured = true;
}
