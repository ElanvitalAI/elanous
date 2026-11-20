// ELS-START-PERF — one login-shell capture per els server run, handed to each pane holder.
// Every pane holder is a fresh process, so its startPty used to run `$SHELL -l -i -c printenv` itself (0.7-1.0 s of rc files
// per new tab). The server captures once (async, at boot) and pipes the result into each holder's stdin; the holder adopts it.
// What crosses: only the captured login env, in memory and over a pipe (never argv, env or disk), minus the els credentials
// (owner and pane tokens: the #39230 leak path), and only while the key — user, shell, HOME, rc-file mtimes — still matches.

import { statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { adoptCapturedEnv, capturedEnvAvailable, getCapturedEnv, invalidateCapturedEnv, loginEnvOptedOut, warmCapturedEnv } from '../shell-env-bootstrap.js';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from './server-auth.js';

const RC_FILES: Readonly<Record<string, readonly string[]>> = {
  zsh: ['.zshenv', '.zprofile', '.zshrc', '.zlogin'],
  bash: ['.bash_profile', '.bash_login', '.profile', '.bashrc'],
};

/** Who and what a capture belongs to: a different user, shell, HOME or an edited rc file is a different capture. */
export function loginEnvKey(env: NodeJS.ProcessEnv = process.env, uid: number = process.getuid?.() ?? -1): string {
  const shell = env.SHELL ?? '';
  const home = env.HOME ?? '';
  const rc = (RC_FILES[basename(shell)] ?? []).map((name) => {
    try { return `${name}:${statSync(join(home, name)).mtimeMs}`; } catch { return `${name}:-`; }
  });
  return JSON.stringify([uid, shell, home, rc]);
}

/** The text a holder receives. The els credentials are removed even when a rc file exported them. */
export function packLoginEnv(captured: Readonly<Record<string, string>>, key: string): string {
  const env: Record<string, string> = { ...captured };
  delete env[AUTH_OWNER_TOKEN_ENV];
  delete env[AUTH_PANE_TOKEN_ENV];
  return JSON.stringify({ key, env });
}

/** The env inside `text`, only when it is for this key and is a plain string record; otherwise undefined (capture it yourself). */
export function unpackLoginEnv(text: string, key: string): Record<string, string> | undefined {
  try {
    const parsed = JSON.parse(text) as { key?: unknown; env?: unknown };
    if (parsed.key !== key || typeof parsed.env !== 'object' || parsed.env === null || Array.isArray(parsed.env)) return undefined;
    const env = parsed.env as Record<string, unknown>;
    return Object.values(env).every((value) => typeof value === 'string') ? env as Record<string, string> : undefined;
  } catch { return undefined; }
}

let cache: { readonly key: string; readonly payload: string } | undefined;
let inflight: Promise<void> | undefined;

/** Capture the login env off the event loop (server boot). Joins a capture already running. */
export function warmLoginEnv(): Promise<void> {
  inflight ??= (async () => {
    const key = loginEnvKey();
    try {
      if (await warmCapturedEnv() && capturedEnvAvailable()) {
        cache = { key, payload: packLoginEnv(getCapturedEnv(), key) };
        // The capture inherits this server's own tokens from process.env; keep them out of the server's shared cache too.
        const { [AUTH_OWNER_TOKEN_ENV]: _owner, [AUTH_PANE_TOKEN_ENV]: _pane, ...scrubbed } = getCapturedEnv();
        adoptCapturedEnv(scrubbed);
      }
    }
    finally { inflight = undefined; }
  })();
  return inflight;
}

/** The payload for a spawn now, or undefined (the holder then captures for itself, as before). A stale key is re-captured. */
export async function loginEnvForSpawn(): Promise<string | undefined> {
  if (loginEnvOptedOut()) return undefined;                // the opt-out wins over any earlier capture
  const key = loginEnvKey();
  if (cache && cache.key !== key) { cache = undefined; invalidateCapturedEnv(); }
  if (!cache) await warmLoginEnv();
  return cache?.key === key ? cache.payload : undefined;
}

/** Test seam. */
export function resetLoginEnvHandoffForTesting(): void { cache = undefined; inflight = undefined; invalidateCapturedEnv(); }
