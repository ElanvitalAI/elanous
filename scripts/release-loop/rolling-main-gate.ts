#!/usr/bin/env bun
/** Rolling main gate tick. One invocation measures the oldest unmeasured first-parent landing bundle. */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { ensureGateHostReservationDirectory, inspectReleaseGateHost, readGateHostResourcesForHost, reserveReleaseGateHosts } from '../../src/release-loop/gate-host-reservation.js';
import { debug } from '../../src/debug/log.js';
import { firstParentCommitsBetween, planGateBisect } from './gate-bisect.js';
import { runGateBisectSidecar } from './gate-bisect-sidecar.js';
import { parsePodPool } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import { getUserConfig } from '../../src/user-config.js';
import { acquireLockAsync } from '../../src/storage/file-lock.js';

const SHA = /^[0-9a-f]{40}$/i;
export const ROLLING_MAIN_HOSTS = ['gcp1', 'aws1'] as const;

export function nextRollingMainLanding(cutToRoot: readonly string[], lastProcessedCommit: string, mainTip: string): string | null {
  if (lastProcessedCommit === mainTip) return null;
  const range = firstParentCommitsBetween(cutToRoot, lastProcessedCommit, mainTip);
  if (!range.ok) throw new Error(`rolling main landing cursor unavailable: ${range.reason}`);
  return range.commits[0] ?? null;
}

export interface RollingMainReceipt {
  readonly valid: true;
  readonly commit: string;
  readonly receiptPath: string;
  readonly sha256: string;
}

export interface RollingMainRun {
  readonly commit: string;
  readonly host: string;
  readonly status: 'green' | 'red' | 'unreusable';
  readonly verdict: 'pass' | 'fail' | 'unmeasured';
  readonly introduced: readonly string[];
  readonly receipt?: RollingMainReceipt;
  readonly sidecarPath?: string;
  readonly at: string;
}

export interface RollingMainState {
  readonly schema: 1;
  readonly version: string;
  readonly lastAttemptCommit: string | null;
  /** Advances only when both the full gate and reusable receipt validate. */
  readonly latestGreenCommit: string | null;
  readonly latestGreenReceipt: RollingMainReceipt | null;
  readonly runs: readonly RollingMainRun[];
}

export type RollingMainGateOutput = {
  outcome?: string;
  verdict?: string;
  commit?: string;
  introduced?: string[];
  baselineReceipt?: { valid?: boolean; commit?: string; reason?: string };
};

export interface RollingMainGateDeps {
  readonly hostStatus: (host: string) => 'idle' | 'busy' | 'unmeasured';
  readonly runFullGate: (input: { commit: string; baselineCommit: string; version: string; previousVersion: string; host: string }) =>
    Promise<{ output: RollingMainGateOutput; receiptPath?: string }>;
  readonly runBisectSidecar: (input: { baseCommit: string; cutCommit: string; version: string; introduced: readonly string[]; host: string }) =>
    Promise<{ path: string }>;
  readonly assertExclusive?: () => void;
  readonly now?: () => Date;
};

const validReceipt = (output: RollingMainGateOutput, commit: string, receiptPath?: string): RollingMainReceipt | null => {
  if (output.outcome !== 'ok' || output.commit !== commit || !receiptPath || !existsSync(receiptPath)) return null;
  let persisted: RollingMainGateOutput;
  try { persisted = JSON.parse(readFileSync(receiptPath, 'utf8')) as RollingMainGateOutput; }
  catch { return null; }
  // This receipt proves this full rolling run. The gate's separate reusable cut receipt
  // can be invalid for a host sweep because it requires Pod and graph-pin evidence.
  if (persisted.outcome !== 'ok' || persisted.commit !== commit) return null;
  const digest = createHash('sha256').update(readFileSync(receiptPath)).digest('hex');
  return { valid: true, commit, receiptPath, sha256: digest };
};

export function rollingMainReceiptIntact(receipt: RollingMainReceipt | null): boolean {
  if (!receipt || !existsSync(receipt.receiptPath)) return false;
  try {
    const raw = readFileSync(receipt.receiptPath);
    const persisted = JSON.parse(raw.toString('utf8')) as RollingMainGateOutput;
    return persisted.outcome === 'ok' && persisted.commit === receipt.commit
      && createHash('sha256').update(raw).digest('hex') === receipt.sha256;
  } catch { return false; }
}

export function snapshotRollingMainReceipt(output: RollingMainGateOutput, sourcePath: string, receiptPath: string): RollingMainReceipt | null {
  if (output.outcome !== 'ok' || !output.commit || !existsSync(sourcePath)) return null;
  try {
    const raw = readFileSync(sourcePath);
    const persisted = JSON.parse(raw.toString('utf8')) as RollingMainGateOutput;
    if (persisted.outcome !== 'ok' || persisted.commit !== output.commit) return null;
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, raw, { flag: 'wx', mode: 0o600 });
    return { valid: true, commit: output.commit, receiptPath, sha256: createHash('sha256').update(raw).digest('hex') };
  } catch { return null; }
}

export function initialRollingMainState(version: string): RollingMainState {
  if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(version)) throw new Error('invalid rolling main release version');
  return { schema: 1, version, lastAttemptCommit: null, latestGreenCommit: null, latestGreenReceipt: null, runs: [] };
}

export function parseRollingMainState(raw: string, version: string): RollingMainState {
  const parsed = JSON.parse(raw) as Partial<RollingMainState>;
  const rawRuns: unknown = parsed.runs;
  const has = (key: keyof RollingMainState) => Object.prototype.hasOwnProperty.call(parsed, key);
  if (parsed.schema !== 1 || parsed.version !== version || !has('lastAttemptCommit') || !has('latestGreenCommit')
      || !has('latestGreenReceipt') || !has('runs') || !Array.isArray(rawRuns)
      || (parsed.lastAttemptCommit !== null && !SHA.test(parsed.lastAttemptCommit ?? ''))
      || (parsed.latestGreenCommit !== null && !SHA.test(parsed.latestGreenCommit ?? '')))
    throw new Error('rolling main state is invalid or belongs to another release version');
  const receipt = parsed.latestGreenReceipt;
  if (receipt !== null && (!receipt || receipt.valid !== true || !SHA.test(receipt.commit) || receipt.commit !== parsed.latestGreenCommit
      || typeof receipt.receiptPath !== 'string' || !receipt.receiptPath || !/^[0-9a-f]{64}$/.test(receipt.sha256)))
    throw new Error('rolling main reusable receipt identity is invalid');
  if ((parsed.latestGreenCommit ?? null) !== null && !receipt) throw new Error('rolling main green commit has no reusable receipt');
  for (const candidate of rawRuns as unknown[]) {
    const run = candidate as Record<string, unknown> | null;
    if (!run || typeof run !== 'object' || typeof run.commit !== 'string' || !SHA.test(run.commit)
        || typeof run.host !== 'string' || !run.host.trim()
        || typeof run.status !== 'string' || !['green', 'red', 'unreusable'].includes(run.status)
        || typeof run.verdict !== 'string' || !['pass', 'fail', 'unmeasured'].includes(run.verdict)
        || !Array.isArray(run.introduced) || !run.introduced.every((item: unknown) => typeof item === 'string')
        || typeof run.at !== 'string' || Number.isNaN(Date.parse(run.at))
        || (run.receipt !== undefined && (!run.receipt || typeof run.receipt !== 'object'
          || (run.receipt as Record<string, unknown>).valid !== true
          || (run.receipt as Record<string, unknown>).commit !== run.commit
          || typeof (run.receipt as Record<string, unknown>).receiptPath !== 'string'
          || typeof (run.receipt as Record<string, unknown>).sha256 !== 'string'
          || !/^[0-9a-f]{64}$/.test((run.receipt as Record<string, string>).sha256)))
        || (run.sidecarPath !== undefined && typeof run.sidecarPath !== 'string'))
      throw new Error('rolling main state contains an invalid run record');
    const expectedVerdict = run.status === 'green' ? 'pass' : run.status === 'red' ? 'fail' : 'unmeasured';
    if (run.verdict !== expectedVerdict || (run.status === 'green') !== (run.receipt !== undefined))
      throw new Error('rolling main state run status, verdict, and receipt disagree');
  }
  return { schema: 1, version, lastAttemptCommit: parsed.lastAttemptCommit!,
    latestGreenCommit: parsed.latestGreenCommit!, latestGreenReceipt: receipt,
    runs: rawRuns as RollingMainRun[] };
}

export function inspectRollingMainHost(host: string, root = effectiveInstanceRoot()): 'idle' | 'busy' | 'unmeasured' {
  const reservation = inspectReleaseGateHost(root, host);
  if (reservation.status !== 'free') return reservation.status === 'reserved' ? 'busy' : 'unmeasured';
  const resources = readGateHostResourcesForHost(host);
  return resources.status === 'measured' ? (resources.empty ? 'idle' : 'busy') : 'unmeasured';
}

export async function runRollingMainGate(input: { state: RollingMainState; repo: string; commit: string; previousVersion: string;
  baselineCommit: string; statePath: string; deps: RollingMainGateDeps }): Promise<{ state: RollingMainState; status: 'skipped' | 'green' | 'red' | 'unreusable'; host?: string }> {
  const { state, commit, previousVersion, baselineCommit, statePath, deps } = input;
  if (!SHA.test(commit) || !SHA.test(baselineCommit) || !state.version) throw new Error('rolling main gate requires measured commit identities');
  if (state.latestGreenCommit && (!state.latestGreenReceipt || state.latestGreenReceipt.commit !== state.latestGreenCommit
      || !rollingMainReceiptIntact(state.latestGreenReceipt))) throw new Error('rolling main green receipt is missing or changed; state preserved and gate stopped');
  if (commit === state.lastAttemptCommit) return { state, status: 'skipped' };
  const host = ROLLING_MAIN_HOSTS.find((candidate) => deps.hostStatus(candidate) === 'idle');
  if (!host) return { state, status: 'skipped' };

  const runId = `rolling-main-${commit.slice(0, 12)}-${randomUUID()}`;
  const measuredBaselineCommit = state.latestGreenCommit ?? baselineCommit;
  const assertGreenReceipt = () => {
    if (state.latestGreenCommit && (!state.latestGreenReceipt || state.latestGreenReceipt.commit !== state.latestGreenCommit
        || !rollingMainReceiptIntact(state.latestGreenReceipt))) throw new Error('rolling main green receipt changed during gate; state preserved and gate stopped');
  };
  debug.log('release-loop.rolling-main', 'gate-start', { runId, commit, host, baselineCommit: measuredBaselineCommit, version: state.version });
  const measured = await deps.runFullGate({ commit, baselineCommit: measuredBaselineCommit, version: state.version, previousVersion, host });
  assertGreenReceipt();
  if (measured.output.commit !== commit) throw new Error('rolling main gate returned a different commit');
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const receipt = measured.output.outcome === 'ok' ? validReceipt(measured.output, commit, measured.receiptPath) : null;
  const status: RollingMainRun['status'] = measured.output.outcome === 'ok' ? (receipt ? 'green' : 'unreusable')
    : measured.output.outcome === 'regression' ? 'red' : 'unreusable';
  let sidecarPath: string | undefined;
  if (status === 'red' && state.latestGreenCommit && rollingMainReceiptIntact(state.latestGreenReceipt)
      && (measured.output.introduced?.length ?? 0) > 0) {
    const sidecar = await deps.runBisectSidecar({ baseCommit: measuredBaselineCommit, cutCommit: commit,
      version: state.version, introduced: measured.output.introduced!, host });
    assertGreenReceipt();
    sidecarPath = sidecar.path;
    debug.log('release-loop.rolling-main', 'bisect-queued', { runId, commit, host, sidecarPath });
  }
  const run: RollingMainRun = { commit, host, status, verdict: status === 'green' ? 'pass' : status === 'red' ? 'fail' : 'unmeasured',
    introduced: measured.output.introduced ?? [], ...(receipt ? { receipt } : {}), ...(sidecarPath ? { sidecarPath } : {}), at: now };
  const next: RollingMainState = { ...state, lastAttemptCommit: status === 'unreusable' ? state.lastAttemptCommit : commit,
    ...(receipt ? { latestGreenCommit: commit, latestGreenReceipt: receipt } : {}), runs: [...state.runs, run] };
  assertGreenReceipt();
  deps.assertExclusive?.();
  writeRollingMainState(statePath, next);
  debug.log('release-loop.rolling-main', status === 'green' ? 'gate-green' : status === 'red' ? 'gate-red' : 'receipt-unreusable',
    { runId, commit, host, introduced: run.introduced.length, ...(receipt ? { receipt: receipt.receiptPath } : {}) });
  return { state: next, status, host };
}

export function writeRollingMainState(path: string, state: RollingMainState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
  try { writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { if (existsSync(temp)) rmSync(temp, { force: true }); }
}

function readMainTip(repo: string): string {
  const fetch = spawnSync('git', ['fetch', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
  if (fetch.status !== 0) throw new Error(`could not refresh origin/main: ${(fetch.stderr || fetch.error)?.toString().trim()}`);
  const tip = spawnSync('git', ['rev-parse', 'origin/main'], { cwd: repo, encoding: 'utf8' });
  const commit = tip.status === 0 ? tip.stdout.trim() : '';
  if (!SHA.test(commit)) throw new Error('origin/main tip is unreadable');
  return commit;
}

function readFirstParentChain(repo: string, mainTip: string): string[] {
  const history = spawnSync('git', ['rev-list', '--first-parent', mainTip], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  if (history.status !== 0) throw new Error(`origin/main first-parent history is unreadable: ${(history.stderr || history.error)?.toString().trim()}`);
  return history.stdout.trim().split(/\r?\n/).filter(Boolean);
}

async function runRollingBisectSidecar(input: { repo: string; root: string; version: string; previousVersion: string;
  baseCommit: string; cutCommit: string; introduced: readonly string[]; host: string }): Promise<{ path: string }> {
  const history = spawnSync('git', ['rev-list', '--first-parent', '--parents', input.cutCommit], { cwd: input.repo, encoding: 'utf8', timeout: 15_000 });
  if (history.status !== 0) throw new Error(`bisect first-parent history unavailable: ${(history.stderr || history.error)?.toString().trim()}`);
  const chain = history.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/)[0]!);
  const range = firstParentCommitsBetween(chain, input.baseCommit, input.cutCommit);
  if (!range.ok) throw new Error(`bisect range unavailable: ${range.reason}`);
  const planned = planGateBisect({ version: input.version, baseCommit: input.baseCommit, cutCommit: input.cutCommit,
    firstParentCommits: range.commits, introducedIds: input.introduced, basePass: true, cutFail: true, host: input.host });
  if (!planned.ok) throw new Error(`bisect plan unavailable: ${planned.reason}`);
  const config = getUserConfig() as { release?: { loop?: { gatePodPool?: string } }; harness?: { podPool?: string } };
  const pool = config.release?.loop?.gatePodPool ?? config.harness?.podPool;
  if (typeof pool !== 'string' || !pool.trim()) throw new Error('bisect sidecar cannot measure without the configured release Pod pool');
  const alternatePool = parsePodPool(pool).filter((member) => (member.sshHost ?? '').toLowerCase() !== input.host.toLowerCase())
    .map((member) => `${member.context}${member.sshHost ? `@${member.sshHost}` : ''}:${member.capacity}`).join(',');
  if (!alternatePool) throw new Error(`bisect sidecar has no Pod pool outside gate host ${input.host}`);
  const runId = `rolling-main-${input.cutCommit.slice(0, 12)}-${randomUUID()}`;
  const path = join(input.root, 'release', input.version, `gate-bisect-${input.cutCommit}-${runId}.json`);
  await runGateBisectSidecar({ plan: planned.plan, repo: input.repo, ledger: input.root, path, runId,
    alternatePool, pod: { pool, imagePin: 'cut-commit', pinnedRunId: runId } });
  return { path };
}

function gateOwnerMail(recordPath: string, commit: string): void {
  try {
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { findings?: Array<{ file: string; firstFailingCommit: string;
      pullRequest?: number | null; owner?: string | null }>; operationalFindings?: Array<{ file: string; firstFailingCommit: string }> };
    // The sidecar exposes owner cards only after shadow and operational attribution agree.
    const findings: Array<{ file: string; firstFailingCommit: string; pullRequest?: number | null; owner?: string | null }> = record.findings ?? [];
    for (const finding of findings) {
      const subject = spawnSync('git', ['show', '-s', '--format=%s', finding.firstFailingCommit], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
      const pr = finding.pullRequest ?? (subject.status === 0 ? Number(/#(\d{4,})\b/.exec(subject.stdout)?.[1]) || null : null);
      const ownerResult = pr ? spawnSync('gh', ['pr', 'view', String(pr), '--json', 'assignees,author', '--jq', '.assignees[0].login // .author.login'],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 }) : null;
      const owner = finding.owner ?? (ownerResult?.status === 0 ? ownerResult.stdout.trim() || null : null);
      const recipient = owner && /^[A-Za-z0-9_-]+$/.test(owner) ? owner : 'OP';
      const body = `GATE-ROLLING-MAIN ${commit.slice(0, 12)} introduced ${finding.file}; first failing ${finding.firstFailingCommit}; PR ${pr ? `#${pr}` : 'unresolved'}; owner ${owner ?? 'unresolved'}. Evidence: ${recordPath}`;
      const posted = spawnSync('eln', ['msg', 'post', '--from', 'GATE-G', '--to', recipient, '--kind', 'report', '--body', body],
        { encoding: 'utf8', timeout: 15_000 });
      if (posted.status !== 0 && recipient !== 'OP') spawnSync('eln', ['msg', 'post', '--from', 'GATE-G', '--to', 'OP', '--kind', 'report', '--body', body],
        { encoding: 'utf8', timeout: 15_000 });
    }
  } catch (error) { debug.log('release-loop.rolling-main', 'owner-mail-unmeasured', { commit, recordPath, error: String(error) }); }
}

export function rollingMainGateRuntimePath(repo: string): string {
  return join(repo, 'scripts/release-loop/gate-runtime.ts');
}

function runFullGate(repo: string, stateRoot: string, version: string, previousVersion: string, baselineCommit: string, host: string, commit: string): RollingMainGateOutput {
  const child = spawnSync('bun', [rollingMainGateRuntimePath(repo), '--commit', commit, '--version', version,
    '--baseline-version', previousVersion, '--baseline-commit', baselineCommit, '--remote', host, '--executor', 'host', '--full', '--json'],
  { cwd: repo, encoding: 'utf8', timeout: 4 * 60 * 60_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ELANOUS_STATE_DIR: stateRoot } });
  const lines = (child.stdout ?? '').trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const output = JSON.parse(line) as RollingMainGateOutput;
      if (output && typeof output === 'object' && typeof output.commit === 'string') return output;
    } catch { /* stdout contains progress before the final JSON verdict. */ }
  }
  throw new Error(`full gate returned no JSON verdict (rc=${child.status}): ${(child.stderr || child.error)?.toString().trim().slice(-2000)}`);
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (!['--repo', '--version', '--previous-version', '--baseline-commit'].includes(key) || !argv[i + 1]) throw new Error(`invalid or incomplete argument ${key}`);
    values.set(key, argv[++i]!);
  }
  const repo = resolve(values.get('--repo') ?? process.cwd());
  const version = values.get('--version');
  const previousVersion = values.get('--previous-version');
  const baselineCommit = values.get('--baseline-commit');
  if (!version || !previousVersion || !baselineCommit) throw new Error('usage: rolling-main-gate.ts --version <release> --previous-version <release> --baseline-commit <sha> [--repo <path>]');
  const root = effectiveInstanceRoot();
  ensureGateHostReservationDirectory(root);
  const statePath = join(root, 'release', version, 'rolling-main-gate.json');
  const lock = await acquireLockAsync(`${statePath}.lock`, { staleMs: 10 * 60_000, maxTries: 72_000,
    onWait: () => debug.log('release-loop.rolling-main', 'waiting-for-active-run', { statePath }) });
  try {
    let state = existsSync(statePath) ? parseRollingMainState(readFileSync(statePath, 'utf8'), version) : initialRollingMainState(version);
    if (state.latestGreenReceipt && !rollingMainReceiptIntact(state.latestGreenReceipt)) {
      debug.log('release-loop.rolling-main', 'green-receipt-invalid-stop', { commit: state.latestGreenCommit });
      throw new Error('rolling main green receipt is missing or changed; state preserved and gate stopped');
    }
    const mainTip = readMainTip(repo);
    const cursor = state.lastAttemptCommit ?? baselineCommit;
    const commit = nextRollingMainLanding(readFirstParentChain(repo, mainTip), cursor, mainTip);
    if (!commit) {
      console.log(JSON.stringify({ mainTip, state, status: 'skipped', reason: 'no-unmeasured-main-landing' }));
      return;
    }
    const result = await runRollingMainGate({ state, repo, commit, previousVersion, baselineCommit, statePath,
      deps: { hostStatus: (host) => inspectRollingMainHost(host, root), assertExclusive: () => {
        if (!lock.stillHeld()) throw new Error('rolling main state lock was lost');
      },
        runFullGate: async (gate) => {
          const gateStateRoot = join(root, 'release', version, 'rolling-main-state', gate.commit, randomUUID());
          const releaseHost = reserveReleaseGateHosts(root, `rolling-main-${gate.commit}-${randomUUID()}`, [gate.host], { purpose: 'rolling-main-gate' });
          try {
            const output = runFullGate(repo, gateStateRoot, version, previousVersion, gate.baselineCommit, gate.host, gate.commit);
            const verdictPath = join(gateStateRoot, 'release', version, 'gate-verdict.json');
            if (!existsSync(verdictPath)) return { output };
            try {
              const persisted = JSON.parse(readFileSync(verdictPath, 'utf8')) as RollingMainGateOutput;
              if (persisted.outcome === 'ok' && persisted.commit === gate.commit) {
                const receiptPath = join(gateStateRoot, 'receipts', `${randomUUID()}.json`);
                const receipt = snapshotRollingMainReceipt(output, verdictPath, receiptPath);
                if (!receipt) return { output };
                return { output, receiptPath };
              }
            } catch { /* invalid or stale ledger is not a reusable receipt */ }
            return { output };
          } finally { releaseHost(); }
        },
        runBisectSidecar: async (failure) => {
          const sidecar = await runRollingBisectSidecar({ repo, root, previousVersion, ...failure });
          gateOwnerMail(sidecar.path, failure.cutCommit);
          return sidecar;
        },
      } });
    console.log(JSON.stringify({ commit, ...result }));
  } finally { lock.release(); }
}

if (import.meta.main) {
  try { await main(); }
  catch (error) { debug.log('release-loop.rolling-main', 'failed', { error: String(error) }); process.exitCode = 1; }
}
