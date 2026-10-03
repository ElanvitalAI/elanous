import { spawnSync } from 'node:child_process';

const event = process.argv[2];
if (event !== 'stop' && event !== 'post-tool-use') process.exit(0);

try {
  const payload = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
  // A locator is useful only when it is a session ID, not arbitrary hook input.
  const session = payload.session_id;
  if (typeof session !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session)) process.exit(0);
  const tool = payload.tool_name;
  if (event === 'post-tool-use' && (typeof tool !== 'string' || !/^[a-z][a-z0-9_.:-]{0,63}$/i.test(tool))) process.exit(0);
  // Only known tool identifiers can appear in the generated summary. Never copy hook free text.
  const knownTools = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'LS',
    'Task', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite', 'AskUserQuestion']);
  const summary = event === 'stop' ? 'Claude Code session stopped'
    : `Claude Code tool ${knownTools.has(tool as string) ? tool : 'other'} completed`;
  const source = `elanous://context/claude-code/${session}`;
  spawnSync('elanous', ['context', 'emit', '--kind', 'done', '--summary', summary, '--source', source], {
    stdio: 'ignore', timeout: 3000,
  });
} catch {
  // Hooks must not interrupt the seat session on malformed input or unavailable CLI.
}
