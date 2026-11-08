import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GATE_COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

export function baselineCommit(root: string, version: string): string {
  const path = join(root, 'release', version, 'release.json');
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const commit = manifest && typeof manifest === 'object' && 'sourceCommit' in manifest ? manifest.sourceCommit : undefined;
  if (typeof commit !== 'string' || !GATE_COMMIT_SHA.test(commit)) throw new Error(`missing sourceCommit in ${path}`);
  return commit;
}
