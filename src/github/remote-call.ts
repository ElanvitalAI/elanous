import { debug } from '../debug/log.js';

/** One measured execution at a GitHub boundary. Never put an URL, arguments, token, or body here. */
export interface GithubRemoteCall {
  kind: 'rest' | 'graphql' | 'gh-command' | 'git-clone' | 'git-fetch' | 'git-push';
  caller: string;
  route: string;
  method?: string;
  host: string;
  scopeId?: string;
  runId?: string;
  retry?: number;
}

export interface GithubRemoteOutcome<T> {
  failed: boolean;
  result?: T;
  error?: unknown;
}

export interface GithubRemoteCallOptions<T> {
  /** Return an observed HTTP status only; CLI success alone is not HTTP 200. */
  status?: (outcome: GithubRemoteOutcome<T>) => number | undefined;
  now?: () => number;
  emit?: (category: string, event: string, data: Record<string, unknown>) => void;
}

/** Execute the real call and record exactly one completion, including failures. Observation cannot change the result. */
export async function runGithubRemoteCall<T>(
  call: GithubRemoteCall,
  execute: () => Promise<T>,
  options: GithubRemoteCallOptions<T> = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const safeNow = (): number | undefined => {
    try { const value = now(); return Number.isFinite(value) ? value : undefined; } catch { return undefined; }
  };
  const started = safeNow();
  let outcome: GithubRemoteOutcome<T> = { failed: false };
  try {
    const result = await execute();
    outcome = { failed: false, result };
    return result;
  } catch (error) {
    outcome = { failed: true, error };
    throw error;
  } finally {
    let status: number | undefined;
    try { status = options.status?.(outcome); } catch { /* telemetry must not alter the call */ }
    const ended = safeNow();
    const data: Record<string, unknown> = {
      kind: call.kind,
      caller: call.caller,
      route: call.route,
      method: call.method ?? 'unmeasured',
      host: call.host,
      scopeId: call.scopeId ?? 'unmeasured',
      runId: call.runId ?? '',
      retry: call.retry ?? 'unmeasured',
      status: status ?? 'unmeasured',
      ok: !outcome.failed,
      durationMs: started === undefined || ended === undefined ? 'unmeasured' : Math.max(0, ended - started),
    };
    try { (options.emit ?? debug.log.bind(debug))('github.transport', 'complete', data); } catch { /* same rule */ }
  }
}

/** Only a real GitHub remote belongs in the Git transport denominator. */
export function isGithubGitRemote(remote: string): boolean {
  let host: string | undefined;
  if (remote.includes('://')) {
    try {
      const url = new URL(remote);
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return false;
      host = url.hostname;
    } catch { return false; }
  } else {
    host = /^(?:[^@\s]+@)?([^:/\s]+):[^\s]+$/.exec(remote)?.[1];
  }
  return host === 'github.com' || host === 'ssh.github.com';
}
