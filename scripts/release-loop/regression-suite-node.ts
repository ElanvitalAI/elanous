#!/usr/bin/env bun
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../../src/nexus/paths.js';
import { runSimWorldSuiteCase, runWorldRegressionSuite, type SuiteCase, type SuiteReceipt } from '../../src/ux-sim/world-regression-suite.js';
import { emitNodeResult, errorResult } from './node-verdict.js';

export async function runReleaseRegressionSuites(root: string, run: (item: SuiteCase) => Promise<SuiteReceipt> = runSimWorldSuiteCase) {
  const folder = resolve(root);
  if (!existsSync(folder)) return { outcome: 'ok' as const, verdict: 'pass' as const,
    summary: 'regression suites: 0 configured', suites: 0, scenarios: 0, differences: [] };
  const names = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name).sort();
  const differences: unknown[] = [];
  let scenarios = 0;
  for (const name of names) {
    const result = await runWorldRegressionSuite({ folder: join(folder, name), target: 'sim', run });
    scenarios += result.scenarios;
    differences.push(...result.differences.map((difference) => ({ suite: name, ...difference })));
  }
  return { outcome: differences.length === 0 ? 'ok' as const : 'fail' as const,
    verdict: differences.length === 0 ? 'pass' as const : 'fail' as const,
    summary: differences.length === 0 ? `regression suites: ${names.length} suite(s), ${scenarios} scenario(s), no differences`
      : `regression suites: ${differences.length} difference(s) across ${scenarios} scenario(s)`,
    suites: names.length, scenarios, differences };
}

if (import.meta.main) {
  const prior = getTestStateRoot();
  const isolated = mkdtempSync(join(tmpdir(), 'elanous-release-sim-suite-'));
  try {
    setTestStateRoot(isolated);
    const result = await runReleaseRegressionSuites(resolve('scenarios/regression'));
    emitNodeResult(result);
    process.exitCode = result.outcome === 'ok' ? 0 : 1;
  } catch (error) {
    emitNodeResult(errorResult(error));
    process.exitCode = 2;
  } finally {
    setTestStateRoot(prior ?? null);
    rmSync(isolated, { recursive: true, force: true });
  }
}
