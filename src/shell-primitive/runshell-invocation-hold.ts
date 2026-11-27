import { basename } from 'node:path';
import { buildMacOsProfile } from './sandbox.js';
import { relaxHold, type RelaxHold } from './relax-hold.js';

/** Locate the executable in the exact wrapper forms emitted by applySandbox. */
export function originalExecutable(command: string, args: readonly string[], cwd: string): string | undefined {
  if (command === '/usr/bin/sandbox-exec') {
    return args[0] === '-p' && typeof args[1] === 'string' ? args[2] : undefined;
  }
  if (basename(command) === 'bwrap') {
    const prefix = ['--ro-bind', '/', '/', '--bind', cwd, cwd, '--tmpfs', '/tmp',
      '--proc', '/proc', '--dev', '/dev', '--die-with-parent', '--new-session'];
    if (!prefix.every((value, i) => args[i] === value)) return undefined;
    const index = args[prefix.length] === '--unshare-net' ? prefix.length + 1 : prefix.length;
    return args[index];
  }
  return command;
}

/** The inner argv behind the exact sandbox wrappers emitted by applySandbox; null for any other wrapper form. */
export function unwrapSandboxArgv(command: string, args: readonly string[], cwd: string): readonly string[] | null {
  if (command === '/usr/bin/sandbox-exec') {
    if (args[0] !== '-p' || !args[2] || !(['off', 'inherit'] as const).some(network =>
      args[1] === buildMacOsProfile({ cwd, network }))) return null;
    return args.slice(2);
  }
  if (command === '/usr/bin/bwrap' || command === '/usr/local/bin/bwrap') {
    const executable = originalExecutable(command, args, cwd);
    if (!executable) return null;
    const index = args.indexOf('--new-session') + 1;
    return args.slice(args[index] === '--unshare-net' ? index + 1 : index);
  }
  return [command, ...args];
}

/** Classify the actual invocation; unrecognized sandbox wrappers remain unknown and gated. */
export function runShellInvocationHold(command: string, args: readonly string[], cwd: string): RelaxHold | null {
  const argv = unwrapSandboxArgv(command, args, cwd);
  return argv?.[0] ? relaxHold(argv, cwd) : { class: 'empty', reason: 'unrecognized or empty sandbox invocation' };
}
