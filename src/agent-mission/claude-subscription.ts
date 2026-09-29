import { spawnSync } from 'node:child_process';
import { claudeBackend, resolveBackendSpawn } from './driver.js';

const AUTH_STATUS_TIMEOUT_MS = 5_000;

type CliResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  error?: Error & { code?: string };
};

type RunCli = (command: string, args: string[], options: {
  env: Record<string, string>;
  encoding: 'utf8';
  timeout: number;
}) => CliResult;

export type ClaudeSubscriptionStatus = {
  ok: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  reason: 'subscription' | 'api-key' | 'logged-out' | 'timeout' | 'auth-status-failed';
};

/** Check the official CLI without exposing credentials or passing any billing env to it. */
export function checkClaudeSubscription({ env, runCli = spawnSync }: {
  env: Record<string, string | undefined>;
  runCli?: RunCli;
}): ClaudeSubscriptionStatus {
  const scrubbed = resolveBackendSpawn(claudeBackend, env).env;
  let result: CliResult;
  try {
    result = runCli('claude', ['auth', 'status', '--json'], {
      env: scrubbed, encoding: 'utf8', timeout: AUTH_STATUS_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, authMethod: null, apiProvider: null,
      reason: (error as { code?: string })?.code === 'ETIMEDOUT' ? 'timeout' : 'auth-status-failed' };
  }
  if (result.error?.code === 'ETIMEDOUT') {
    return { ok: false, authMethod: null, apiProvider: null, reason: 'timeout' };
  }
  if (result.error) return { ok: false, authMethod: null, apiProvider: null, reason: 'auth-status-failed' };
  let status: unknown;
  try { status = JSON.parse(String(result.stdout ?? '')); }
  catch { return { ok: false, authMethod: null, apiProvider: null, reason: 'auth-status-failed' }; }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return { ok: false, authMethod: null, apiProvider: null, reason: 'auth-status-failed' };
  }
  const auth = status as Record<string, unknown>;
  const authMethod = typeof auth.authMethod === 'string' ? auth.authMethod : null;
  const apiProvider = typeof auth.apiProvider === 'string' ? auth.apiProvider : null;
  if (auth.loggedIn !== true) return { ok: false, authMethod, apiProvider, reason: 'logged-out' };
  if (result.status !== 0) return { ok: false, authMethod, apiProvider, reason: 'auth-status-failed' };
  const ok = authMethod === 'claude.ai' && apiProvider === 'firstParty';
  return { ok, authMethod, apiProvider, reason: ok ? 'subscription' : 'api-key' };
}
