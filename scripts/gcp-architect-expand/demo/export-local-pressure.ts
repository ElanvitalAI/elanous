/** Serialize the existing host/queue reading for the Solar → GCP demo handoff. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readLocalPressure } from '../../../src/ux-sim/gcp-architect-expand/local-signals.js';
import { validateProposalPressure } from './pressure-input.js';

const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (!output) throw new Error('usage: bun export-local-pressure.ts --output FILE');
const signal = readLocalPressure();
validateProposalPressure(signal, { requireShortage: false }); // unknown fails; no shortage is still useful evidence
const path = resolve(output);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(signal, null, 2) + '\n');
console.log(JSON.stringify({ output: path, observedAt: signal.observedAt, source: 'existing-self-dev-and-harness-queue' }));
