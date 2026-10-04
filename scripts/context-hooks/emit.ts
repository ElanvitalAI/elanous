// Bounded Claude Code hook extractor: only seat folders (marked by `.claude/seat`) emit, and only fixed metadata.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const SEATS = new Set(['OP', 'TC', 'MK', 'UX']);
const MAX_LEVELS = 6;

// Walks up from the session cwd to the git root (or MAX_LEVELS); no or invalid marker → null.
function findSeat(start: string): string | null {
  let dir = start;
  for (let level = 0; level <= MAX_LEVELS; level++) {
    const marker = join(dir, '.claude', 'seat');
    if (existsSync(marker)) {
      const seat = readFileSync(marker, 'utf8').trim();
      return SEATS.has(seat) ? seat : null;
    }
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const event = process.argv[2];
if (event !== 'stop' && event !== 'post-tool-use') process.exit(0);
try {
  const payload = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
  const session = payload.session_id;
  if (typeof session !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session)) process.exit(0);
  const cwd = typeof payload.cwd === 'string' && isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  const seat = findSeat(cwd);
  if (seat === null) process.exit(0);
  if (event === 'stop') {
    spawnSync('elanous', ['context', 'emit', 'task-done', '--seat', seat, '--text', 'Claude Code session stopped', '--ref', session],
      { stdio: 'ignore', timeout: 3000 });
    process.exit(0);
  }
  const tool = payload.tool_name;
  if (typeof tool !== 'string' || !/^[a-z][a-z0-9_.:-]{0,63}$/i.test(tool)) process.exit(0);
  const knownTools = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'LS', 'Task', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite', 'AskUserQuestion']);
  const summary = `Claude Code tool ${knownTools.has(tool) ? tool : 'other'} completed`;
  const source = `elanous://context/claude-code/${session}`;
  spawnSync('elanous', ['context', 'emit', '--kind', 'done', '--summary', summary, '--source', source], { stdio: 'ignore', timeout: 3000 });
} catch { /* never interrupt the seat session */ }
