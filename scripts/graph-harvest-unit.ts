import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runHarvestUnit, type HarvestInput } from '../src/task-agent/harvest-unit.js';

type GraphContext = { input?: HarvestInput };
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ outcome: 'done', result: { dryRun: true }, evidence: { reviewerInvoked: false } }));
  process.exit(0);
}
const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
if (!contextPath) throw new Error('ELANOUS_GRAPH_CONTEXT is required');
const graphContext = JSON.parse(readFileSync(contextPath, 'utf8')) as GraphContext;

const result = await runHarvestUnit(graphContext.input ?? {}, async ({ pr, intent }) => {
  const command = process.env.ELANOUS_BIN ?? 'eln';
  const child = spawnSync(command, [
    'self', 'review', pr, '--intent', intent, '--json', '--save', 'ta-harvest',
  ], { encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  if (child.error) throw child.error;
  return { stdout: child.stdout ?? '', stderr: child.stderr ?? '', exitCode: child.status };
});
console.log(JSON.stringify(result));
