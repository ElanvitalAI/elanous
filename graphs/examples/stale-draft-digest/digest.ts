// Node bodies for the example loop. `collect` asks GitHub for open drafts; `report` reads what
// `collect` produced from the graph context (ELANOUS_GRAPH_CONTEXT: a JSON file with input and outputs).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

type Context = { input?: { days?: number }; outputs?: Record<string, { stale?: Array<{ number: number; title: string; days: number; url: string }> }> };
const context: Context = process.env.ELANOUS_GRAPH_CONTEXT
  ? JSON.parse(readFileSync(process.env.ELANOUS_GRAPH_CONTEXT, 'utf8')) : {};
const step = process.argv[2];

if (step === 'collect') {
  const days = Number(context.input?.days ?? 3);
  const gh = spawnSync('gh', ['pr', 'list', '--state', 'open', '--draft', '--limit', '200', '--json', 'number,title,createdAt,url'], { encoding: 'utf8' });
  if (gh.status !== 0) { console.log(JSON.stringify({ outcome: 'fail', reason: (gh.stderr || 'gh failed').trim().slice(0, 200) })); process.exit(0); }
  const now = Date.now();
  const stale = (JSON.parse(gh.stdout) as Array<{ number: number; title: string; createdAt: string; url: string }>)
    .map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, days: Math.floor((now - Date.parse(pr.createdAt)) / 86_400_000) }))
    .filter((pr) => pr.days >= days);
  console.log(JSON.stringify({ outcome: stale.length ? 'ok' : 'none', stale }));
} else if (step === 'report') {
  const stale = context.outputs?.collect?.stale ?? [];
  for (const pr of stale) console.log(`#${pr.number} · ${pr.days}d · ${pr.title} — ${pr.url}`);
  console.log(JSON.stringify({ outcome: 'ok', count: stale.length }));
} else {
  console.error('usage: digest.ts collect|report'); process.exit(2);
}
