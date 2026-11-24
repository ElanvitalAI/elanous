import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDocsIndex, defaultDocsSystemRoots, renderDocsIndexJsonl } from '../src/knowledge/docs-system-map.js';

const entries = buildDocsIndex({ roots: defaultDocsSystemRoots() });
const output = resolve(process.argv[2] ?? 'docs-index.jsonl');
mkdirSync(resolve(output, '..'), { recursive: true });
writeFileSync(output, `${renderDocsIndexJsonl(entries)}\n`);
console.log(`docs-index: ${entries.length} documents → ${output}`);
