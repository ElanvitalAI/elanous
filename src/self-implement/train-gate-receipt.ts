import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';
import {
  computeReceiptKey,
  gateEnvFingerprint,
  gateLockfileHash,
  GATE_RECEIPT_SCHEMA,
  loadGateReceipts,
  saveGateReceipt,
  type GateReceipt,
  type GateReceiptIdentity,
} from './gate-receipt-registry.js';

export interface TrainGateReceiptInput {
  repo: string;
  commit: string;
  baseSha: string;
  changedFiles: readonly string[];
  deletedFiles?: readonly string[];
  scenarioTests?: readonly string[];
}

export interface PassedSelfGateReceiptInput extends TrainGateReceiptInput {
  /** Exact artifact emitted by `self gate --artifact-dir`; its pass and typecheck binding are revalidated here. */
  summaryPath: string;
}

type Execute = (script: string, cwd: string) => { status: number | null; stdout: string; stderr: string };

const SHA40 = /^[0-9a-f]{40}$/i;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

function registryPath(repo: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8', timeout: 10_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  const commonDir = (result.stdout ?? '').trim();
  return result.status === 0 && commonDir ? join(commonDir, 'elanous-host-regate', 'gate-receipts.json') : undefined;
}

function identityFor(input: TrainGateReceiptInput, checks?: readonly string[]): GateReceiptIdentity | undefined {
  if (!SHA40.test(input.commit) || !SHA40.test(input.baseSha)) return undefined;
  const bun = spawnSync('bun', ['--version'], { cwd: input.repo, encoding: 'utf8', timeout: 10_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  const bunVersion = (bun.stdout ?? '').trim();
  if (bun.status !== 0 || !bunVersion) return undefined;
  return {
    headCommit: input.commit,
    baseCommit: input.baseSha,
    bunVersion,
    lockfileHash: gateLockfileHash(input.repo),
    radiusFiles: [...new Set(input.changedFiles)].sort(),
    checks: checks ? [...checks] : [
      'train:changed-file-typecheck',
      ...(input.scenarioTests?.length || input.changedFiles.some((file) => TEST_FILE.test(file) && !input.deletedFiles?.includes(file)) ? ['train:deterministic-tests'] : []),
      ...(input.scenarioTests ?? []).map((file) => `train:scenario-test:${file}`),
      'train:pwa-build',
    ],
    envFingerprint: gateEnvFingerprint(process.env),
  };
}

/** Record only after revalidating the exact self-gate summary, then independently measure changed-only interference. */
export async function recordPassedSelfGateReceipt(
  input: PassedSelfGateReceiptInput,
  detect: (files: readonly string[]) => Promise<{ status: 'no-interference' | 'interference' | 'unmeasurable' }> = async (files) => {
    const { detectTestInterference } = await import('../../scripts/detect-test-interference.js');
    return detectTestInterference(files);
  },
): Promise<GateReceipt | undefined> {
  let summary: Record<string, unknown>;
  try { summary = JSON.parse(readFileSync(input.summaryPath, 'utf8')) as Record<string, unknown>; }
  catch { return undefined; }
  const typecheck = summary.typecheck as Record<string, unknown> | undefined;
  const cohort = Array.isArray(summary.cohort) ? summary.cohort.filter((file): file is string => typeof file === 'string') : [];
  const changedTestFiles = [...new Set(input.changedFiles.filter((file) => TEST_FILE.test(file)
    && !input.deletedFiles?.includes(file)))].sort();
  if (summary.head40 !== input.commit || summary.base40 !== input.baseSha || summary.exitCode !== 0
    || !['passed', 'pass'].includes(String(summary.verdict)) || summary.introduced !== 0
    || summary.unknown !== 0 || summary.unrunImporters !== 0
    || typecheck?.status !== 'passed' || typecheck.base40 !== input.baseSha
    || typecheck.head40 !== input.commit || typecheck.exitCode !== 0 || typecheck.newErrors !== 0
    || changedTestFiles.some((file) => !cohort.includes(file))) return undefined;
  const testFiles = [...new Set(input.changedFiles.filter((file) => TEST_FILE.test(file)
    && !input.deletedFiles?.includes(file)))].sort();
  if (!testFiles.length) return undefined;
  const interference = await detect(testFiles);
  if (interference.status !== 'no-interference') return undefined;
  const identity = identityFor(input, ['test-interference:changed-only']);
  const path = process.env.ELANOUS_GATE_RECEIPT_REGISTRY_PATH || registryPath(input.repo);
  if (!identity || !path) return undefined;
  const receipt = passedEvidenceReceipt(identity, input.changedFiles);
  try { saveGateReceipt(path, receipt); }
  catch { return undefined; }
  return receipt;
}

function scriptFor(input: TrainGateReceiptInput, files: readonly string[]): string {
  const tests = [...new Set([
    ...files.filter((file) => TEST_FILE.test(file) && !input.deletedFiles?.includes(file)),
    ...(input.scenarioTests ?? []),
  ])];
  return [
    `TSC_BASE_REF=${quote(input.baseSha)} bun scripts/ci-typecheck-changed.ts --local`,
    ...(tests.length ? [`bun run test:deterministic ${tests.map(quote).join(' ')}`] : []),
    `bun scripts/ci-pwa-build-gate.ts --changed-files ${files.map(quote).join(' ')}`,
  ].join(' && ');
}

function passedEvidenceReceipt(identity: GateReceiptIdentity, files: readonly string[]): GateReceipt {
  const receiptIdentity: GateReceiptIdentity = { ...identity, radiusFiles: [...new Set(files)].sort() };
  return {
    ...receiptIdentity,
    schema: GATE_RECEIPT_SCHEMA,
    key: computeReceiptKey(receiptIdentity, 'passed'),
    verdict: 'passed',
    savedAt: new Date().toISOString(),
  };
}

export function runTrainGateWithReceipts(input: TrainGateReceiptInput, execute: Execute = (script, cwd) => {
  const result = spawnSync('sh', ['-c', script], { cwd, encoding: 'utf8', timeout: 120 * 60_000, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}): { status: number | null; stdout: string; stderr: string } {
  const context = identityFor(input);
  const path = process.env.ELANOUS_GATE_RECEIPT_REGISTRY_PATH || registryPath(input.repo);
  if (!context || !path) return execute(scriptFor(input, input.changedFiles), input.repo);

  const changedFiles = [...new Set(input.changedFiles)].sort();
  const result = execute(scriptFor(input, changedFiles), input.repo);
  if (result.status === 0 && changedFiles.length) {
    try { saveGateReceipt(path, passedEvidenceReceipt(context, changedFiles)); }
    catch { /* A receipt is an optimization; a passed gate remains passed if persistence fails. */ }
  }
  return result;
}

if (import.meta.main) {
  const raw = process.argv[2];
  try {
    if (!raw) throw new Error('train gate receipt input is required');
    const input = JSON.parse(raw) as TrainGateReceiptInput & Partial<PassedSelfGateReceiptInput>;
    if (input.summaryPath) {
      const receipt = await recordPassedSelfGateReceipt(input as PassedSelfGateReceiptInput);
      const registryFile = process.env.ELANOUS_GATE_RECEIPT_REGISTRY_PATH;
      if (registryFile) {
        const registry = loadGateReceipts(registryFile);
        process.stdout.write(`${String.fromCharCode(10)}__GATE_RECEIPTS__${Buffer.from(JSON.stringify(registry)).toString('base64')}${String.fromCharCode(10)}`);
      }
      if (!receipt) process.exitCode = 1;
    } else {
      const result = runTrainGateWithReceipts({ ...input, repo: process.cwd() });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      const registryFile = process.env.ELANOUS_GATE_RECEIPT_REGISTRY_PATH;
      if (registryFile) {
        const registry = loadGateReceipts(registryFile);
        process.stdout.write(`${String.fromCharCode(10)}__GATE_RECEIPTS__${Buffer.from(JSON.stringify(registry)).toString('base64')}${String.fromCharCode(10)}`);
      }
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
