#!/usr/bin/env bun
/** Extra landing gates on the pinned head/main integration tree. */
import { spawnSync } from 'node:child_process';
import { runLandGlobalChecksGate } from './land-global-checks.js';
import { runTestInterferenceGate } from './ci-test-interference-gate.js';

export interface PrLandExtraGateDeps {
  changedFiles?: (base: string, cwd: string) => string[];
  runGlobal?: (files: readonly string[], cwd: string) => boolean;
  runInterference?: (files: readonly string[], cwd: string, log: (message: string) => void) => Promise<number>;
}

function changedFiles(base: string, cwd: string): string[] {
  if (!/^[a-f0-9]{40}$/i.test(base)) throw new Error('invalid pinned base');
  const diff = spawnSync('git', ['diff', '--name-only', '-z', `${base}...HEAD`], { cwd, encoding: 'buffer' });
  if (diff.error || diff.status !== 0 || !Buffer.isBuffer(diff.stdout)) {
    throw new Error(`changed files unmeasured: ${diff.error?.message ?? diff.stderr?.toString('utf8') ?? diff.status}`);
  }
  return diff.stdout.toString('utf8').split('\0').filter(Boolean);
}

export async function runPrLandExtraRemoteGates(base: string, cwd = process.cwd(), deps: PrLandExtraGateDeps = {}): Promise<number> {
  if (!/^[a-f0-9]{40}$/i.test(base)) throw new Error('invalid pinned base');
  const files = (deps.changedFiles ?? changedFiles)(base, cwd);
  const globalOk = (deps.runGlobal ?? ((paths, root) => runLandGlobalChecksGate({ changedFiles: paths, cwd: root, log: console.log, error: console.error })))(files, cwd);
  if (!globalOk) return 1;
  let interferenceMeasured = true;
  const interferenceLog = (message: string): void => {
    console.log(message);
    if (message.includes('[test-interference-gate] 경고: 측정 불가')) interferenceMeasured = false;
  };
  try {
    const rc = await (deps.runInterference ?? ((paths, root, log) => runTestInterferenceGate({ args: ['--changed-files', ...paths], cwd: root, log })))(files, cwd, interferenceLog);
    if (rc !== 0) interferenceMeasured = false;
  } catch (error) {
    interferenceMeasured = false;
    console.warn(`[test-interference-gate] 경고: 측정 불가 — ${error instanceof Error ? error.message : String(error)}; 간섭 없음으로 처리하지 않음.`);
  }
  console.log(`[pr-land-extra-gates] pass global=measured interference=${interferenceMeasured ? 'measured' : 'unmeasured'} files=${files.length}`);
  return 0;
}

if (import.meta.main) {
  try { process.exitCode = await runPrLandExtraRemoteGates(process.argv[2] ?? ''); }
  catch (error) {
    console.error(`[pr-land-extra-gates] unmeasured: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
