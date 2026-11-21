/**
 * Shell isolation triage (WORKER-UNIFY §6-4 SHELL-ISOLATION-TRIAGE; WORKER-CONTRACT §5 `isolation`).
 * Pure decider: no I/O, no process state read. It classifies a shell request into one of the three
 * contract isolation branches and filters the child environment through the default-deny allowlist
 * in `child-env.ts` (the single allowlist; this module adds no second list).
 */
import { shellChildEnv } from './child-env.js';

export type ShellIsolation = 'inline-isolated' | 'isolated-session' | 'session';

export const SHELL_ISOLATIONS: readonly ShellIsolation[] = ['inline-isolated', 'isolated-session', 'session'];

export interface ShellIsolationRequest {
  mode?: 'inline' | 'bg';
  sandbox?: 'off' | 'auto' | 'strict';
  network?: 'inherit' | 'off';
  /** Explicit branch asked for by the caller; anything outside the three branches is refused. */
  isolation?: unknown;
  /** Explicit non-secret env overrides. */
  env?: Record<string, string>;
}

export type ShellIsolationTriage =
  | { allowed: true; isolation: ShellIsolation; reason: string; env: Record<string, string>; strippedEnvKeys: string[] }
  | { allowed: false; isolation: null; reason: string; env: Record<string, string>; strippedEnvKeys: string[] };

function inferBranch(req: ShellIsolationRequest): { isolation: ShellIsolation; reason: string } {
  if (req.mode === 'bg') return { isolation: 'isolated-session', reason: 'bg mode runs detached from the caller session' };
  if (req.sandbox === 'strict' || req.network === 'off') {
    return { isolation: 'inline-isolated', reason: 'strict sandbox or network off isolates inside the same process' };
  }
  return { isolation: 'session', reason: 'inline run in the caller session' };
}

export function triageShellIsolation(req: ShellIsolationRequest, parentEnv: NodeJS.ProcessEnv): ShellIsolationTriage {
  const env = shellChildEnv(parentEnv, req.env ?? {});
  const kept = new Set(Object.keys(env));
  const strippedEnvKeys = [...new Set([...Object.keys(parentEnv), ...Object.keys(req.env ?? {})])].filter(k => !kept.has(k)).sort();
  if (req.isolation !== undefined) {
    if (typeof req.isolation !== 'string' || !(SHELL_ISOLATIONS as readonly string[]).includes(req.isolation)) {
      return { allowed: false, isolation: null, reason: 'unknown isolation branch (default deny)', env: {}, strippedEnvKeys };
    }
    return { allowed: true, isolation: req.isolation as ShellIsolation, reason: 'explicit branch', env, strippedEnvKeys };
  }
  return { allowed: true, ...inferBranch(req), env, strippedEnvKeys };
}
