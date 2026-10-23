export interface DashboardChatMainSlashCommand {
  cmdLower: string;
  args: string[];
}

export function resolveDashboardChatMainSlashCommand(
  commandText: string,
): DashboardChatMainSlashCommand {
  const [cmd, ...rawArgs] = commandText.slice(1).split(/\s+/);
  let cmdLower = cmd?.toLowerCase() ?? '';
  let args: string[] = rawArgs.filter(Boolean);

  // A terminal command is shell text: splitting and joining its words would
  // collapse whitespace inside quotes (for example `sh -c 'echo a  b'`).
  if ((cmdLower === 'term' || cmdLower === 'terminal') && args[0]?.toLowerCase() === 'new') {
    const command = /^\S+\s+\S+(?:\s+([\s\S]*))?$/.exec(commandText.slice(1))?.[1];
    args = command === undefined ? ['new'] : ['new', command];
  }

  // Top-level alias: `/resume <id>` → `/session load <id>`.
  // Reuses the existing /session subcommand handler so the resume
  // flow stays in one place. A bare `/resume` is NOT rewritten: it must reach
  // the `resume` handler that opens the session picker — rewriting it gave
  // «usage: /session load <id-prefix>» and no picker (TUI-RESUME-PICKER · backlog #16).
  if (cmdLower === 'resume' && args.length > 0) {
    cmdLower = 'session';
    args = ['load', ...rawArgs.filter(Boolean)];
  }

  return {
    cmdLower,
    args,
  };
}
