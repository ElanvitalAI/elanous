import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { measureRuntimeStaticClosure } from './lib/tui-runtime-static-closure.js';

const root = resolve(import.meta.dir, '..');
const entry = join(root, 'src/tui/entry.ts');
const baseline = join(root, 'src/tui/size-contract.ratchet.json');
const measured = measureRuntimeStaticClosure(entry);
writeFileSync(baseline, `${JSON.stringify({ runtimeStaticFiles: measured.files, runtimeStaticLines: measured.lines }, null, 2)}\n`);
console.log(`generated ${baseline}: ${measured.files} runtime-static files / ${measured.lines} lines`);
