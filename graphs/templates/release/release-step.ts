/** A plugin-owned recipe adapter. The loader supplies the bound instance ledger path per run. */
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const step = process.argv[2];
const instancePath = process.env.ELANOUS_RELEASE_INSTANCE_FILE;
if (!step || !['cut', 'gate', 'triage', 'publish', 'npm-publish', 'verify'].includes(step) || !instancePath) {
  process.stderr.write('release step or instance ledger missing\n');
  process.exit(2);
}
try {
  const firstLine = readFileSync(instancePath, 'utf8').split('\n')[0];
  const binding = JSON.parse(firstLine ?? '') as { event?: string; runId?: string; inputs?: { commands?: Record<string, unknown> } };
  if (binding.event !== 'graph.instance-bound') throw new Error('instance binding missing');
  const command = binding.inputs?.commands?.[step];
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || !part.trim())) {
    throw new Error(`command not bound: ${step}`);
  }
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', shell: false });
  appendFileSync(instancePath, `${JSON.stringify({ event: 'graph.recipe-executed', runId: binding.runId, step,
    exitCode: result.status, error: result.error?.message ?? null, at: new Date().toISOString() })}\n`);
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
