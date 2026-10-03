import { readFileSync } from 'node:fs';
import { loadGraphTemplatesFrom, defaultGraphsDir } from '../src/self-implement/graph-templates.js';

// Public metrics for release/public/tech/tech1.json. Log metrics read the installed `elanous`
// (operational universe) over --since/--until; `--all` adds every registered instance incl. test.
const key = process.argv[2];
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const PAGE = 100000;

type Row = { id?: number; category: string; event: string; data?: unknown };

function logRows(args: string[]): { rows: Row[]; limitReached: boolean } {
  const proc = Bun.spawnSync(['elanous', 'logs', ...args, '--json', '--json-data'], { stdout: 'pipe', stderr: 'pipe', maxBuffer: 2 ** 31 } as Parameters<typeof Bun.spawnSync>[1]);
  if (proc.exitCode !== 0) throw new Error(`elanous logs failed: ${new TextDecoder().decode(proc.stderr).slice(0, 300)}`);
  const rows: Row[] = [];
  let limitReached = false;
  for (const line of new TextDecoder().decode(proc.stdout).split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line) as Row & { _meta?: { type?: string; limitReached?: boolean } };
    if (row._meta) { if (row._meta.type === 'log-query-limit' && row._meta.limitReached) limitReached = true; continue; }
    rows.push(row);
  }
  return { rows, limitReached };
}

function window(): string[] {
  const since = flag('--since');
  const until = flag('--until');
  if (!since || !until) throw new Error('--since <ISO> --until <ISO> required');
  return ['--since', since, '--until', until];
}

/** One page across all instances; refuses a truncated page instead of reporting a short count. */
function unionCount(categories: string, events?: string): Map<string, number> {
  const args = [...window(), '--all', '--include-test', '--limit', String(PAGE), '--category', categories, ...(events ? ['--event', events] : [])];
  const { rows, limitReached } = logRows(args);
  if (limitReached) throw new Error(`truncated at ${PAGE} rows — narrow --event`);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(`${row.category} ${row.event}`, (counts.get(`${row.category} ${row.event}`) ?? 0) + 1);
  return counts;
}

const at = (counts: Map<string, number>, k: string): number => counts.get(k) ?? 0;

if (key === 'graph.templates') {
  const result = loadGraphTemplatesFrom(defaultGraphsDir());
  console.log(Object.keys(result.templates).length);
} else if (key === 'loop-agents.loops') {
  const proc = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'loop', 'list', '--json'], { stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error('loop catalog unavailable');
  console.log(JSON.parse(new TextDecoder().decode(proc.stdout)).length);
} else if (key === 'harness.author-tags') {
  const tags = [...readFileSync('src/self-implement/goal-author.ts', 'utf8').matchAll(/tag: '([a-z-]+)'/g)].map(match => match[1]);
  console.log(new Set(tags).size);
} else if (key === 'observability.events') {
  // Operational instance only; pages with --before so the 100k page cap does not cut the count.
  let before: number | undefined;
  let total = 0;
  for (;;) {
    const { rows } = logRows([...window(), '--limit', String(PAGE), ...(before === undefined ? [] : ['--before', String(before)])]);
    total += rows.length;
    if (rows.length < PAGE) break;
    before = Math.min(...rows.map((row) => row.id ?? Number.POSITIVE_INFINITY));
  }
  console.log(total);
} else if (key === 'stages.author') {
  const c = unionCount('harness.author', 'goal-id-assigned');
  console.log(JSON.stringify({ auto: at(c, 'harness.author goal-id-assigned') }));
} else if (key === 'stages.clarify') {
  const c = unionCount('hitl.execution,harness.author.clarify', 'auto-recommended,assumed,asked,self-answered,unresolved');
  console.log(JSON.stringify({
    auto: at(c, 'hitl.execution auto-recommended') + at(c, 'hitl.execution assumed') + at(c, 'harness.author.clarify self-answered'),
    human: at(c, 'hitl.execution asked'),
    unknown: at(c, 'harness.author.clarify unresolved'),
  }));
} else if (key === 'stages.ledger') {
  const { rows, limitReached } = logRows([...window(), '--all', '--include-test', '--limit', String(PAGE), '--category', 'self-implement.pod', '--event', 'ledger-live-appended']);
  if (limitReached) throw new Error(`truncated at ${PAGE} rows`);
  const runs = new Set(rows.map((row) => (row.data as { runId?: string } | undefined)?.runId).filter(Boolean));
  console.log(JSON.stringify({ auto: runs.size, appends: rows.length }));
} else if (key === 'stages.heal') {
  const c = unionCount('self-dev.rework,self-dev.hitl', 'repeat-count,escalation');
  console.log(JSON.stringify({ auto: at(c, 'self-dev.rework repeat-count'), human: at(c, 'self-dev.hitl escalation') }));
} else if (key === 'pty.missions') {
  // External coding agents driven through an inner PTY (agent-mission) — distinct missions with any row in the window.
  const { rows, limitReached } = logRows([...window(), '--all', '--include-test', '--limit', String(PAGE), '--category', 'agent-mission']);
  if (limitReached) throw new Error(`truncated at ${PAGE} rows`);
  console.log(new Set(rows.map((row) => (row.data as { missionId?: string } | undefined)?.missionId).filter(Boolean)).size);
} else {
  throw new Error(`Unknown public metric: ${key ?? '(missing)'}`);
}
