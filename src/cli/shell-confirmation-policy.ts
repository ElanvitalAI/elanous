/** Conservative shell guard shared by interactive TUI surfaces. */
export function isPotentiallyDestructiveShellCommand(command: string): boolean {
  const text = command.trim();
  if (!text) return false;
  if (/[\r\n;&|<>`$()]/.test(text)) return true;
  if (/[\\'\"]/.test(text)) return true;
  const args = text.split(/\s+/);
  const commandName = args[0];
  const operands = args.slice(1);
  const safeOperand = (value: string) => /^[A-Za-z0-9_./:+-]+$/.test(value) && !value.startsWith('-');

  if (commandName === 'pwd') return operands.length === 0 || (operands.length === 1 && ['-L', '-P'].includes(operands[0]!)) ? false : true;
  if (commandName === 'ls') {
    return !operands.every(value => value.startsWith('-')
      ? value.length > 1 && [...value.slice(1)].every(flag => 'aAlh1dFtrS'.includes(flag))
      : safeOperand(value));
  }
  if (commandName === 'ps') return !(['ps aux', 'ps -aux', 'ps -ef'].includes(text));
  if (commandName === 'df') {
    return !operands.every(value => value.startsWith('-') ? ['-h', '-H', '-k', '-P', '-T'].includes(value) : safeOperand(value));
  }
  if (commandName === 'du') {
    return !operands.every(value => value.startsWith('-')
      ? ['-h', '-s', '--human-readable', '--summarize'].includes(value) || /^-[hs]+$/.test(value) || /^-d[0-9]+$/.test(value) || /^--max-depth=[0-9]+$/.test(value)
      : safeOperand(value));
  }
  if (commandName === 'uname') return !(['uname', 'uname -a', 'uname -s', 'uname -n', 'uname -r', 'uname -m', 'uname -v', 'uname -p', 'uname -o'].includes(text));
  if (commandName === 'which') return operands.length === 0 || !operands.every(value => /^[A-Za-z0-9_.+-]+$/.test(value));
  if (commandName !== 'git') return true;

  const subcommand = operands[0];
  const gitArgs = operands.slice(1);
  if (subcommand === 'status') {
    return !gitArgs.every(value => ['--short', '-s', '--branch', '-b', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--untracked-files=no'].includes(value));
  }
  if (subcommand === 'branch') {
    if (gitArgs.length === 0 || (gitArgs.length === 1 && gitArgs[0] === '--show-current')) return false;
    return !(gitArgs[0] === '--list' && gitArgs.slice(1).every(safeOperand));
  }
  if (subcommand === 'rev-parse') {
    return !(['--show-toplevel', '--show-prefix', '--show-cdup', '--git-dir', '--is-inside-work-tree', '--is-bare-repository'].includes(gitArgs[0] ?? '')
      && gitArgs.length === 1);
  }
  return true;
}
