/** Model-agnostic Solar handoff consumer. No provider/model override or GCP connector. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { proposalFromScene4Bytes } from '../../../src/ux-sim/gcp-architect-expand/proposal-from-scene4.js';

const option = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const inputPath = option('--ticket-design');
const pressurePath = option('--pressure');
const outputPath = option('--output');
if (!inputPath || !pressurePath || !outputPath) throw new Error('usage: bun propose.ts --ticket-design FILE --pressure FILE --output FILE');
const raw = readFileSync(inputPath);
const proposal = proposalFromScene4Bytes(raw, JSON.parse(readFileSync(pressurePath, 'utf8')) as unknown);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(proposal, null, 2) + '\n');
console.log(JSON.stringify({ output: resolve(outputPath), proposalId: proposal.id, sourceKind: proposal.ticketDesign.sourceKind }));
