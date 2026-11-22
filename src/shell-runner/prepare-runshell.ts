import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { applySandbox } from '../shell-primitive/sandbox.js';
import { isLocalRead, type RunShellGatewayGrant } from '../shell-primitive/spawn-gateway.js';
import { requestRunShellApproval, RUNSHELL_PUBLIC_KEY_ENV } from '../tui-client/next-runshell-approval.js';

/** Prepare the exact argv before asking the parent; the gateway consumes the grant synchronously at spawn. */
export async function prepareRunnerRunShell(input: {
  command: string[]; cwd: string; sessionId?: string; signal?: AbortSignal;
  sandbox?: 'off' | 'auto' | 'strict'; network?: 'inherit' | 'off';
}): Promise<{ command: string[]; grant?: RunShellGatewayGrant; sandboxed: boolean; sandboxTool: 'none' | 'sandbox-exec' | 'bwrap' } | null> {
  if (input.signal?.aborted) return null;
  const cwd = resolve(input.cwd);
  const name = input.command[0];
  if (!name) return null;
  const candidates = name.includes('/') ? [resolve(cwd, name)]
    : (process.env.PATH ?? '/usr/bin:/bin').split(delimiter).map(dir => resolve(cwd, dir || '.', name));
  const executablePath = candidates.find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
  if (!executablePath) return null;
  const decision = applySandbox({ command: [executablePath, ...input.command.slice(1)], cwd, sandbox: input.sandbox, network: input.network });
  const command = decision.command;
  if (isLocalRead(command[0]!, command.slice(1), cwd)) return { command, sandboxed: decision.sandboxed, sandboxTool: decision.tool };
  const publicKeyPem = process.env[RUNSHELL_PUBLIC_KEY_ENV];
  const callerSeat = process.env.ELANOUS_TRACK;
  const sessionId = input.sessionId;
  if (!publicKeyPem || !callerSeat || !sessionId) return null;
  const bytesSha256 = createHash('sha256').update(readFileSync(executablePath)).digest('hex');
  const approval = await requestRunShellApproval(process, { argv: command, cwd, bytesSha256, callerSeat, sessionId }, input.signal);
  if (!approval || input.signal?.aborted) return null;
  return { command, sandboxed: decision.sandboxed, sandboxTool: decision.tool,
    grant: { approval, publicKeyPem, callerSeat, sessionId, executablePath, signal: input.signal } };
}
