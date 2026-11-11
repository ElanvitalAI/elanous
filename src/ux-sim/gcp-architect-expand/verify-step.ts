import { verifyArchitectureOutput } from './output-contract.js';

export function runVerifyStep(): void {
const directory = process.env.GCP_ARCHITECT_OUTPUT_DIR;
const check = directory ? verifyArchitectureOutput(directory) : { ok: false, errors: ['GCP_ARCHITECT_OUTPUT_DIR is required'] };
console.log(JSON.stringify({ outcome: check.ok ? 'ok' : 'fail', ...check }));
}
if (import.meta.main) runVerifyStep();
