// els CLI argument rules (pure, tested without a process): defaults for `new`, and the «options go before --» hint.

import { basename } from 'node:path';

export interface NewArgs {
  readonly ws?: string | undefined;
  readonly cwd?: string | undefined;
  readonly title?: string | undefined;
  readonly command: readonly string[];
  /** `--raw`: the command is exactly what follows `--` (no «option after --» check). */
  readonly raw?: boolean | undefined;
}

const OPTION_WORDS = ['--ws', '--cwd', '--title'];

/**
 * If an els option sits right after the command name (`els new -- sh --cwd /x`), it was meant for els: say where it
 * belongs. Only the word after the command is looked at, and `--raw` turns the check off, so a real command that takes
 * the same flag (`els new --raw -- bun --cwd /x run dev`) still runs.
 */
export function misplacedOptionHint(args: NewArgs): string | undefined {
  if (args.raw) return undefined;
  const given: Record<string, string | undefined> = { '--ws': args.ws, '--cwd': args.cwd, '--title': args.title };
  const word = args.command[1];
  if (word === undefined) return undefined;
  const flag = OPTION_WORDS.find((option) => word === option || word.startsWith(`${option}=`));
  return flag && given[flag] === undefined
    ? `els new: ${flag} must come before -- (everything after -- is the command to run): els new ${flag} <value> -- ${args.command[0]} …  (the command really takes ${flag}? add --raw)`
    : undefined;
}

/** No command → the user's shell · no --cwd → the current folder · no --ws → the folder's name. */
export function withNewDefaults(args: NewArgs, env: Record<string, string | undefined>, pwd: string): { ws: string; cwd: string; command: string[]; title?: string } {
  const cwd = args.cwd?.trim() || pwd;
  const command = args.command.length > 0 ? [...args.command] : [env.SHELL?.trim() || '/bin/sh'];
  const ws = args.ws?.trim() || basename(cwd) || 'els';
  return { ws, cwd, command, ...(args.title ? { title: args.title } : {}) };
}
