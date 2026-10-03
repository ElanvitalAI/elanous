import { statSync } from 'node:fs';
import { join } from 'node:path';
import { runIsolationHardcodeGate } from '../../scripts/ci-isolation-hardcode-gate.js';
import { runMockModuleRestoreGate } from '../../scripts/ci-mock-module-restore-gate.js';
import { runModelHardcodeGate } from '../../scripts/ci-model-hardcode-gate.js';
import { runDaemonPortGate } from '../../scripts/ci-daemon-port-gate.js';
import { runPublicExportLeakGate } from '../../scripts/ci-public-export-leak-gate.js';

type GateName = 'isolation-gate' | 'mock-module-restore-gate' | 'model-hardcode-gate' | 'daemon-port-gate' | 'public-export-leak';
type GateOutput = { args: string[]; cwd: string; log: (line: string) => void; error: (line: string) => void };
type GateRunner = (out: GateOutput) => number;

export function runHarnessPolicyGates(input: {
  cwd: string;
  changedFiles: readonly string[];
  gates?: Partial<Record<GateName, GateRunner>>;
}): { passed: boolean; failures: Array<{ gate: GateName; lines: string[] }>; skipped?: string } {
  try {
    if (!statSync(join(input.cwd, 'scripts')).isDirectory()) {
      return { passed: true, failures: [], skipped: 'no-scripts' };
    }
  } catch {
    return { passed: true, failures: [], skipped: 'no-scripts' };
  }

  const runners: readonly [GateName, GateRunner][] = [
    ['isolation-gate', input.gates?.['isolation-gate'] ?? runIsolationHardcodeGate],
    ['mock-module-restore-gate', input.gates?.['mock-module-restore-gate'] ?? runMockModuleRestoreGate],
    ['model-hardcode-gate', input.gates?.['model-hardcode-gate'] ?? runModelHardcodeGate],
    ['daemon-port-gate', input.gates?.['daemon-port-gate'] ?? ((out) => runDaemonPortGate({ log: out.log, error: out.error, cwd: out.cwd, args: [] }))],
    // LEAK1 — the same pre-export check as pr land; an unmeasured result is a nonzero failure, not a pass.
    ['public-export-leak', input.gates?.['public-export-leak'] ?? runPublicExportLeakGate],
  ];
  const failures: Array<{ gate: GateName; lines: string[] }> = [];
  for (const [gate, run] of runners) {
    const lines: string[] = [];
    try {
      const status = run({ cwd: input.cwd, args: ['--changed-files', ...input.changedFiles], log: (line) => lines.push(line), error: (line) => lines.push(line) });
      if (status !== 0) failures.push({ gate, lines: [...lines, `✗ ${gate}: violation detected`] });
    } catch (error) {
      failures.push({ gate, lines: [...lines, `⚠ ${gate}: 게이트가 «못 쟀다» — ${error instanceof Error ? error.message : String(error)}`] });
    }
  }
  return { passed: failures.length === 0, failures };
}
