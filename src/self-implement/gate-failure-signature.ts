import { createHash } from 'node:crypto';
import type { SelfImplementGateResult } from './orchestrator.js';

export interface GateFailureReceipt {
  signature: `sha256:${string}`;
  tests: string[];
}

/** Only measured, introduced, non-timeout test failures are stable enough to stop a repeated repair. */
export function gateFailureReceipt(gate: SelfImplementGateResult | undefined): GateFailureReceipt | null {
  if (!gate || gate.passed || gate.testStepExecuted !== true || !gate.baselineFailures
    || !gate.reflectGateFacts || gate.reflectGateFacts.unknown !== 0
    || (gate.reflectGateFacts.timedOut ?? 0) > 0 || (gate.reflectGateFacts.rerunNotRun ?? 0) > 0
    || (gate.reflectGateFacts.mayVaryNonTimeout ?? 0) > 0) return null;
  const introduced = gate.baselineFailures.filter((failure) => failure.attribution === 'introduced');
  if (!introduced.length || introduced.length !== gate.reflectGateFacts.introduced) return null;
  const normalized: Array<{ file: string; name: string; kind: string }> = [];
  for (const failure of introduced) {
    const file = failure.file?.replace(/\\/g, '/').trim();
    const name = failure.name.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!file || file.startsWith('/') || /^[A-Za-z]:\//.test(file) || file.split('/').includes('..')
      || !name || /[\r\n]/.test(name)
      || failure.timeoutRegression || /\btimed out\b|\btimeout\b/i.test(failure.diagnostic ?? '')) return null;
    const diagnostic = failure.diagnostic ?? '';
    const kind = /module not found|cannot find module|ERR_MODULE_NOT_FOUND/i.test(diagnostic) ? 'module-load'
      : /expect\(|AssertionError|Expected:/i.test(diagnostic) ? 'assertion'
      : /\berror:/i.test(diagnostic) ? 'runtime-error' : 'test-failure';
    normalized.push({ file, name, kind });
  }
  normalized.sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const unique = [...new Map(normalized.map((entry) => [JSON.stringify(entry), entry])).values()];
  if (unique.length !== introduced.length) return null;
  const signature = `sha256:${createHash('sha256').update(JSON.stringify(unique)).digest('hex')}` as const;
  return { signature, tests: unique.map(({ file, name, kind }) => `${file} > ${name} (${kind})`) };
}

/** The worker reads these exact lines from harness stdout and persists the receipt. */
export function gateFailureReceiptLines(receipt: GateFailureReceipt): string[] {
  return [`GATE_FAILURE_SIGNATURE=${receipt.signature}`, `GATE_FAILURE_TESTS=${JSON.stringify(receipt.tests)}`];
}
