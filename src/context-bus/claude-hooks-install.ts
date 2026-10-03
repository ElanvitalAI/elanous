import { resolve } from 'node:path';

/** Render a Claude Code settings fragment; never touch the user's settings file. */
export function claudeHooksSettings(repoRoot: string): string {
  const command = (file: string) => `bash '${resolve(repoRoot, 'scripts/context-hooks', file).replaceAll("'", "'\\''")}'`;
  return JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: 'command', command: command('claude-stop.sh') }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: command('post-tool-use.sh') }] }],
  } }, null, 2);
}
