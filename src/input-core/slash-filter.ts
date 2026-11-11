export interface SlashFilterCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly hidden?: boolean;
}

/** Classic picker ranking, shared with next TUI. */
export function filterSlashCommands<T extends SlashFilterCommand>(text: string, commands: readonly T[]): T[] {
  const discoverable = commands.filter((command) => !command.hidden);
  const q = text.toLowerCase();
  if (!q) return discoverable;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const descRe = new RegExp(`\\b${escaped}`, 'i');
  const scored: { cmd: T; score: number }[] = [];
  for (const cmd of discoverable) {
    const name = cmd.name.toLowerCase();
    const aliases = (cmd.aliases ?? []).map(a => a.toLowerCase());
    let score = 0;
    // Source: the classic slash picker ranking: exact prefix, alias prefix, substring, description word.
    if (name.startsWith(q)) score = 100;
    else if (aliases.some(a => a.startsWith(q))) score = 80;
    else if (name.includes(q)) score = 50;
    else if (descRe.test(cmd.description)) score = 10;
    if (score > 0) scored.push({ cmd, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.cmd.name.localeCompare(b.cmd.name);
  });
  return scored.map(s => s.cmd);
}
