/** Prepare a sealed, scoped pull-read entry for OP review; never writes the input file. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseSeatAllowList } from '../src/security/shell-argv-policy.js';

const ID = 'gh-api-pull-scoped';
const ROW = `allow ${ID} gh api repos/<segment>/<segment>/pulls/<number>`;

export function addScopedPull(text: string): string {
  const parsed = parseSeatAllowList(text);
  if (!parsed.ok) throw new Error(`invalid input: ${parsed.error}`);
  if (parsed.list.tombstones.has(ID)) throw new Error(`revoked id: ${ID}`);
  if (parsed.list.shapes.some(shape => shape.id === ID)) throw new Error(`existing id: ${ID}`);
  if (!Number.isSafeInteger(parsed.list.version) || parsed.list.version >= Number.MAX_SAFE_INTEGER) throw new Error('unsafe version');
  const lines = text.split('\n').map(line => /^version\s/.test(line.trim()) ? `version ${parsed.list.version + 1}` : line);
  const lockIndex = lines.findIndex(line => /^lock\s/.test(line.trim()));
  lines.splice(lockIndex, 1, ROW);
  const canonical = lines.map(line => line.trim()).filter(line => line && !line.startsWith('#')).join('\n');
  lines.splice(lockIndex + 1, 0, `lock ${createHash('sha256').update(canonical, 'utf8').digest('hex')}`);
  const result = lines.join('\n');
  const check = parseSeatAllowList(result);
  if (!check.ok) throw new Error(`invalid output: ${check.error}`);
  return result;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: bun scripts/approval-allow-add-pull.ts INPUT > NEW_FILE');
    process.stdout.write(addScopedPull(readFileSync(process.argv[2]!, 'utf8')));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
