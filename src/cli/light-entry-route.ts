export type LightCliRoute = 'msg' | 'release' | 'tasks' | 'tasks-read' | 'pty' | 'logs' | 'config';

const VALUE_FLAGS = new Set(['--config-dir', '--test-state-dir']);
const HOT_ROOTS = new Set(['msg', 'pty', 'logs', 'tasks']);
const ROOT_GLOBAL_FLAGS = new Set(['--test', '--config-dir', '--test-state-dir', '--state-dir', '--remote', '-r', '--name', '--help-all', '--version', '-V']);
const LOG_SUBCOMMANDS = new Set([
  'instances', 'level', 'timeline', 'durations', 'model-input', 'degenerate', 'fields', 'unclosed', 'abandoned-draft-prs',
]);
const LOG_VALUE_FLAGS = new Set([
  '--level', '--surface', '--space', '--category', '--exact-category', '--axis', '--event', '--grep',
  '--rework-recurrence-disagreement', '--since', '--until', '--before', '--session', '--limit', '--threshold', '--instance',
]);
const LOG_BOOLEAN_FLAGS = new Set([
  '-h', '--help', '-f', '--follow', '--list-categories', '--list-events', '--explain', '--top-failures', '--json', '--json-data', '--test', '--all', '--include-test',
]);

function isRootGlobalFlag(arg: string): boolean {
  return [...ROOT_GLOBAL_FLAGS].some(flag => arg === flag || arg.startsWith(`${flag}=`))
    || (arg.startsWith('-') && !arg.startsWith('--') && (arg.startsWith('-r') && arg.length > 2 || arg.slice(1).includes('V')));
}

function isSupportedLogsShape(args: readonly string[]): boolean {
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index]!;
    if (token.startsWith('-')) {
      const equals = token.indexOf('=');
      const flag = equals < 0 ? token : token.slice(0, equals);
      if (LOG_BOOLEAN_FLAGS.has(flag)) continue;
      if (!LOG_VALUE_FLAGS.has(flag)) return false;
      if (equals < 0) index += 1;
      continue;
    }
    return LOG_SUBCOMMANDS.has(token);
  }
  return true;
}

/** Select lightweight operational paths whose CLI modules can stand alone. */
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

  // These four operational roots are the hot router. Keep all root flags and
  // every leading-option form on the full entry so its isolation/bootstrap
  // parser remains the sole owner of those semantics.
  if (HOT_ROOTS.has(command[0] ?? '') && (args[0] !== command[0] || args.some(isRootGlobalFlag))) return undefined;

  if (command[0] === 'msg' && ['list', 'post', 'ack', 'watch'].includes(command[1] ?? '')) return 'msg';
  // --reveal has an audit-log contract owned by the full CLI.
  if (command[0] === 'config' && command[1] === 'get' && !args.some(arg => arg === '--reveal' || arg.startsWith('--reveal='))) return 'config';
  if (command[0] === 'release' && command[1] === 'checklist'
    && (command[2] === 'status' || command[2] === 'list')) return 'release';
  // CLI-ENTRY-LAZY — list·show 는 그 둘만 등록한다(tasks-read-cli.ts · board·shadow·mission 클러스터 0).
  if (command[0] === 'tasks' && (command[1] === 'list' || command[1] === 'show')) return 'tasks-read';
  // 하위 목록 도움말은 전체 등록부가 그린다 — 무거운 모듈은 그 등록부 안에서 실행 때만 싣는다.
  if (command[0] === 'tasks' && ((command[1] === 'hand' && args.includes('--help'))
    || (command.length === 1 && args.length === 2 && (args[1] === '--help' || args[1] === '-h')))) return 'tasks';
  if (command[0] === 'pty' && ['list', 'snapshot', 'text', 'state'].includes(command[1] ?? '')) return 'pty';
  if (command[0] === 'logs' && isSupportedLogsShape(args)) return 'logs';
  return undefined;
}
