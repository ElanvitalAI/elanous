import { readFileSync } from 'node:fs';
import { compressConclusions, type ConclusionBatch } from '../src/knowledge/conclusion-compress.js';

/** bun scripts/knowledge-compress.ts <batch.json> (UTC day, version, explicitly verified conclusions and full originals). */
if (import.meta.main) {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error('usage: bun scripts/knowledge-compress.ts <batch.json>');
  const batch = JSON.parse(readFileSync(path, 'utf8')) as ConclusionBatch;
  const receipt = compressConclusions(batch);
  console.log(JSON.stringify(receipt));
}
