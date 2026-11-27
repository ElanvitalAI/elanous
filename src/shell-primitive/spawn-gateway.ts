import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { consumeRunShellApproval, type SignedRunShellApproval } from './runshell-approval.js';
import { scriptCommandPolicy } from '../skills/tools/run-shell-script.js';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import { authorizeSignedRecipe, type SignedRecipeEnvelope } from '../skills/tools/run-shell-signed-recipe.js';
import { originalExecutable, unwrapSandboxArgv, runShellInvocationHold } from './runshell-invocation-hold.js';

// Capture the parent-provided trust anchor at process startup, never from a grant.
const trustedApprovalKey = process.env.ELANOUS_RUNSHELL_APPROVAL_PUBLIC_KEY;

/** A signed one-use grant can only be issued when the parent handed down its key and the caller has a seat identity. */
export function runShellGrantRouteAvailable(): boolean {
  return !!trustedApprovalKey && !!process.env.ELANOUS_TRACK;
}

/** CEO 11-23 ELS-ELN-SECURITY-RELAX — the grant (y/n card) is kept only for the big-irreversible hold classes in
 *  relax-hold.ts (broad deletion · data-store destruction · public exposure · secrets sent off the machine). Any other actual, unwrapped argv
 *  runs without a grant, with or without a seat identity, and is audited by the runtime. An unrecognized
 *  sandbox wrapper form stays gated. */
export function isRelaxedNonDestructive(command: string, args: readonly string[], cwd: string): boolean {
  return runShellInvocationHold(command, args, cwd) === null;
}

/** Reclassify the actual argv, including only sandbox wrappers emitted by applySandbox. */
export function isLocalRead(command: string, args: readonly string[], cwd: string): boolean {
  const argv = unwrapSandboxArgv(command, args, cwd);
  if (!argv?.[0]) return false;
  const normalized = [basename(argv[0]), ...argv.slice(1)];
  // Recipe dispatch hardens object-only git reads before they reach this seam.
  // Recognize the exact transform, never a caller-supplied classification flag.
  const gitPrefix = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'log.showSignature=false'];
  if (gitPrefix.every((part, index) => normalized[index] === part)) {
    const verb = normalized[gitPrefix.length];
    let index = gitPrefix.length + 1;
    if (verb === 'log' || verb === 'show') {
      if (normalized[index++] !== '--no-show-signature') return false;
    }
    if (verb === 'show') {
      if (normalized[index++] !== '--no-ext-diff' || normalized[index++] !== '--no-textconv') return false;
    }
    return !!verb && scriptCommandPolicy(['git', verb, ...normalized.slice(index)]) === 'read-local';
  }
  return scriptCommandPolicy(normalized) === 'read-local';
}

export interface RunShellGatewayGrant {
  approval: SignedRunShellApproval;
  publicKeyPem: string;
  callerSeat: string;
  sessionId: string;
  executablePath: string;
  signal?: AbortSignal;
}

export type SpawnFunction = typeof spawn;

/** Shared process creation seam; policy and approval remain with callers. */
export function spawnGateway(
  command: string, args: readonly string[], options: SpawnOptions, spawnFn: SpawnFunction = spawn,
  grant?: RunShellGatewayGrant,
  recipe?: SignedRecipeEnvelope,
): ChildProcess {
  if (typeof options.cwd !== 'string') throw new Error('RunShell cwd required');
  const cwd = options.cwd;
  if (options.shell) throw new Error('RunShell shell execution is not permitted');
  if (recipe) {
    const authorized = authorizeSignedRecipe(recipe);
    if (authorized.cwd !== options.cwd || authorized.argv.length !== args.length + 1
      || authorized.argv[0] !== command || args.some((arg, i) => arg !== authorized.argv[i + 1]))
      throw new Error('signed recipe invocation mismatch');
    // Never inherit arbitrary execution-affecting environment variables.
    options = { cwd: authorized.cwd, env: { HOME: homedir(), PATH: '/usr/bin:/bin', LANG: 'C' } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'] };
  }
  if (grant) {
    if (originalExecutable(command, args, cwd) !== grant.executablePath)
      throw new Error('RunShell executable path mismatch');
    if (!trustedApprovalKey || grant.publicKeyPem !== trustedApprovalKey)
      throw new Error('RunShell trusted approval key mismatch');
    consumeRunShellApproval({ ...grant, publicKeyPem: trustedApprovalKey, argv: [command, ...args], cwd });
  }
  else if (!isLocalRead(command, args, cwd) && !isRelaxedNonDestructive(command, args, cwd))
    throw new Error('RunShell approval required');
  return spawnFn(command, args, options);
}
