export type LightCliRoute = 'msg' | 'release' | 'tasks' | 'pty' | 'logs' | 'config';

const VALUE_FLAGS = new Set(['--config-dir', '--test-state-dir']);

/** Select only read-heavy command paths whose CLI module can stand alone. */
export function selectLightCliRoute(args: readonly string[]): LightCliRoute | undefined {
  const command: string[] = [];
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) {
    const flag = args[index]!;
    index += 1;
    if ([...VALUE_FLAGS].some(value => flag.startsWith(`${value}=`))) continue;
    if (VALUE_FLAGS.has(flag)) {
      if (index >= args.length || args[index]!.startsWith('-')) return undefined;
      index += 1;
      continue;
    }
    // Only flags removed by the pre-import isolation helpers can safely
    // precede a light route. Other root flags keep their original parser.
    if (flag !== '--test' && !flag.startsWith('--test=')) return undefined;
  }
  for (const token of args.slice(index)) {
    if (token.startsWith('-')) break;
    command.push(token);
  }

  if (command[0] === 'msg' && (command[1] === 'list' || command[1] === 'ack' || command[1] === 'watch')) return 'msg';
  // --reveal has an audit-log contract owned by the full CLI.
  if (command[0] === 'config' && command[1] === 'get' && !args.some(arg => arg === '--reveal' || arg.startsWith('--reveal='))) return 'config';
  if (command[0] === 'release' && command[1] === 'checklist' && command[2] === 'status') return 'release';
  if (command[0] === 'tasks' && command[1] === 'show') return 'tasks';
  if (command[0] === 'pty' && (command[1] === 'list' || command[1] === 'state')) return 'pty';
  if (command[0] === 'logs') return 'logs';
  return undefined;
}
