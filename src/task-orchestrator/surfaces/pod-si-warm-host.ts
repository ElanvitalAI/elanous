/** Adopt only transport-verified si-v1 bytes into the existing host collectors. */
import { gzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { collectPodLedgers } from './pod-ledger-collect.js';
import { collectPodArtifacts } from './pod-artifact-return.js';
import { runLedgerDir, runLedgerPath } from '../../self-implement/run-ledger.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { debug } from '../../debug/log.js';
import { getUserConfig } from '../../user-config.js';
import { normalizeFallbackChain } from '../../oauth/fallback-chain.js';
import { classifyPodTerminal, applyPodTerminal, podTerminalPrBody,
  type PrTerminalRecord } from '../../self-dev/draft-residue.js';
import type { SiWarmCommand, SiWarmReply, SiWarmReturnedBytes } from './pod-si-warm-protocol.js';
import { acquireSiWarmLease, type SiWarmAcquireResult } from './pod-si-warm-provider.js';
import { hostCredentials, hostGrokCredentials, podChildLlmArgs, POD_JOB_DEADLINE_SECONDS,
  type PodSpawnOptions } from './self-implement-pod.js';
import type { SelfImplementJobSpawn } from './self-implement.js';
import type { SelfImplementJobDone } from './self-implement.js';
import type { SiWarmChildAttempt } from './self-implement-pod.js';
import type { SiWarmRunnerPayload, SiWarmCredentialBundle } from './pod-si-warm-runner.js';

const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const strictBase64 = (value: unknown): Buffer => {
  if (typeof value !== 'string' || value.length > MAX_LEDGER_BYTES * 2
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error('si-v1 ledger base64 invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('si-v1 ledger base64 noncanonical');
  return bytes;
};

function chunks(kind: 'ledger' | 'artifact', id: string, bytes: Uint8Array): string[] {
  const encoded = gzipSync(bytes).toString('base64');
  const size = 8000;
  const total = Math.ceil(encoded.length / size);
  const tag = kind === 'ledger' ? 'ELANOUS_RUN_LEDGER' : 'ELANOUS_POD_ARTIFACT';
  return Array.from({ length: total }, (_, index) =>
    `${tag} ${id} ${index + 1}/${total} ${encoded.slice(index * size, (index + 1) * size)}`);
}

/** Collector failures are adoption failures, so the consumer keeps the lease fenced. */
export async function adoptSiWarmBytes(command: SiWarmCommand, _reply: SiWarmReply,
  bytes: SiWarmReturnedBytes, paths: { ledgerDir?: string; artifactDir?: string } = {}): Promise<void> {
  const ledgerRaw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.ledger));
  if (!Array.isArray(ledgerRaw) || ledgerRaw.length === 0 || ledgerRaw.length > 128)
    throw new Error('si-v1 child ledger missing');
  const ledgerLines: string[] = [];
  const names = new Set<string>();
  for (const row of ledgerRaw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'bytes,name'
      || typeof row.name !== 'string' || !row.name.endsWith('.jsonl'))
      throw new Error('si-v1 ledger envelope invalid');
    const runId = row.name.slice(0, -'.jsonl'.length);
    runLedgerPath(runId);
    if (runId !== command.runId) throw new Error('si-v1 child ledger run id mismatch');
    if (names.has(runId)) throw new Error('si-v1 duplicate ledger');
    names.add(runId);
    ledgerLines.push(...chunks('ledger', runId, strictBase64(row.bytes)));
  }
  const artifactLines = bytes.artifacts.flatMap(item =>
    chunks('artifact', Buffer.from(item.path).toString('base64url'), item.bytes));
  const incomplete: string[] = [];
  collectPodLedgers(ledgerLines.join('\n'), { dir: paths.ledgerDir ?? runLedgerDir(),
    log: (_category, event, data) => {
      if (event === 'ledger-collect-incomplete' || event === 'ledger-collect-skipped')
        incomplete.push(`${event}:${data.runId ?? 'unknown'}`);
    } });
  collectPodArtifacts(artifactLines.join('\n'), { dir: paths.artifactDir ?? join(effectiveInstanceRoot(), 'pod-artifacts'),
    job: `si-${command.executionKey.slice(0, 16)}`,
    log: (_category, event, data) => {
      if (event === 'artifact-collect-incomplete' || event === 'artifact-collect-skipped')
        incomplete.push(`${event}:${data.path ?? 'unknown'}`);
    } });
  if (incomplete.length) throw new Error(`si-v1 adoption incomplete: ${incomplete.join(',').slice(0, 300)}`);
}

type ChildInput = Parameters<SelfImplementJobSpawn>[0];

/** Reuse only the source and auth form the fixed worker currently supports. */
export function siWarmEligible(input: ChildInput, options: PodSpawnOptions): boolean {
  // Merge-ready children need the cold path's full host ACP/regate/land sequence.
  // Until that sequence is shared, admit only draft-producing children.
  return input.autoMerge === false && !input.after && !options.repairCommitOnly && !options.source
    && (!options.provider || options.provider === 'openai-codex')
    && (!options.accountBroker || !!options.rotationAccounts?.length)
    && !options.extraArgs?.length && !options.passEnv?.length
    && !options.skillEnv && !options.armEnv && !options.groundingUrl;
}

/** A warm draft has the same host-owned terminal record as a cold Job. */
export async function postprocessSiWarmChild(input: ChildInput, result: SelfImplementJobDone,
  attempt: SiWarmChildAttempt, options: PodSpawnOptions,
  record: (terminal: PrTerminalRecord) => Promise<void> = async terminal => {
    await applyPodTerminal(terminal, { ledgerRunId: attempt.command.runId,
      ledgerDir: runLedgerDir() });
  }): Promise<SelfImplementJobDone> {
  const disposition = result.disposition;
  if (!disposition) throw new Error('si-v1 host terminal disposition missing');
  const terminal = classifyPodTerminal({ childRunId: disposition.childRunId ?? attempt.command.runId,
    state: result.exitCode === 0 ? 'complete' : 'failed', disposition,
    env: process.env, prBody: options.draftResidue ? undefined : podTerminalPrBody(disposition),
    goalText: input.feature, at: new Date().toISOString() });
  if (options.draftResidue) await options.draftResidue(terminal,
    { ledgerRunId: attempt.command.runId, ledgerDir: runLedgerDir() });
  else await record(terminal);
  return result;
}

export function siWarmPayload(input: ChildInput, options: PodSpawnOptions, runId: string,
  env: NodeJS.ProcessEnv = process.env): SiWarmRunnerPayload {
  const requestedGoal = env.ELANOUS_POD_GOAL_DOC;
  const authorOnPod = env.ELANOUS_POD_AUTHOR_ON_POD === '1' && !requestedGoal;
  let goalDocument: string | undefined;
  if (requestedGoal) {
    if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(requestedGoal)
      || requestedGoal.split('/').includes('..')) throw new Error('si-v1 goal path invalid');
    const root = realpathSync(process.cwd());
    const path = realpathSync(join(root, requestedGoal));
    if (!path.startsWith(`${root}/`)) throw new Error('si-v1 goal path escaped repo');
    goalDocument = readFileSync(path, 'utf8');
  }
  const selfArgs = [
    ...(input.base ? ['--base', input.base] : []),
    ...(input.autoMerge ? ['--merge-by-host'] : []),
    ...(input.autoReview ? ['--auto-review'] : []),
    ...(input.openPr || (!input.autoMerge && !options.repairCommitOnly) ? ['--open-pr'] : []),
    ...(input.draft === false ? ['--no-draft'] : []),
    ...(options.hostSupervised ? ['--no-supervise'] : []),
    ...(options.extraArgs ?? []),
    ...podChildLlmArgs(options),
  ];
  const delegated = !!requestedGoal || authorOnPod;
  const args = delegated ? [
    ...(input.base ? ['--base', input.base] : []),
    ...(input.autoMerge ? ['--merge-by-host'] : input.openPr ? ['--no-auto-merge'] : []),
    ...(options.hostSupervised ? ['--no-supervise'] : []),
    ...podChildLlmArgs(options),
  ] : selfArgs;
  return { mode: requestedGoal ? 'ask' : authorOnPod ? 'say' : 'self', feature: input.feature,
    args, ...(goalDocument === undefined ? {} : { goalDocument }),
    env: { ELANOUS_RUN_ID: runId,
      ...(env.ELANOUS_DISPATCH_RECORDED === '1' ? { ELANOUS_DISPATCH_RECORDED: '1' } : {}),
      ...(env.ELANOUS_HARNESS_SEAT ? { ELANOUS_HARNESS_SEAT: env.ELANOUS_HARNESS_SEAT } : {}) } };
}

/** Carry the same normalized child fallback config as a fresh Pod Job. */
export function siWarmFallbackFiles(raw: unknown, grok: { grokAuth?: string; grokApiKey?: string } | null):
  Record<string, string> {
  // The fixed warm runner only carries Codex accounts and optional Grok credentials.
  const available = normalizeFallbackChain(raw).chain.filter(step =>
    step === 'codex-rotate' || (step === 'grok' && !!(grok?.grokAuth || grok?.grokApiKey)));
  // A configured chain with no carryable provider cannot enter the warm worker.
  // Its caller catches this before acquiring a lease and uses the cold Job path.
  if (available.length === 0) throw new Error('no carryable warm fallback provider');
  return {
    'llm-fallback-config.json': JSON.stringify({ llm: { fallbackChain: available } }),
    ...(grok?.grokAuth ? { 'grok-auth.json': grok.grokAuth } : {}),
    ...(grok?.grokApiKey ? { 'grok-api-key': grok.grokApiKey } : {}),
  };
}

export function siWarmExecutionKey(input: ChildInput, runId: string): string {
  return createHash('sha256').update(JSON.stringify({ runId, spaceId: input.spaceId,
    feature: input.feature, base: input.base, autoMerge: input.autoMerge,
    autoReview: input.autoReview, openPr: input.openPr, draft: input.draft })).digest('hex');
}

/** Host-owned private input builder. A preparation failure happens before any Pod exec or lease. */
export async function acquireSiWarmChild(input: ChildInput, options: PodSpawnOptions): Promise<SiWarmAcquireResult> {
  if (!siWarmEligible(input, options)) return { status: 'no-entry', reason: 'invalid-input' };
  let prepared: Parameters<typeof acquireSiWarmLease>[0];
  try {
    const sourceSha = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${input.base ?? 'origin/HEAD'}^{commit}`],
      { cwd: process.cwd(), encoding: 'utf8' }).trim();
    if (!/^[a-f0-9]{40}$/.test(sourceSha)) return { status: 'no-entry', reason: 'invalid-input' };
    const runId = `run-${randomUUID()}`;
    const attemptId = `attempt-${randomUUID()}`;
    const executionKey = siWarmExecutionKey(input, runId);
    const plannedAccount = options.accountBroker?.() ?? options.account ?? 'team';
    const rotation = options.rotationAccounts;
    if (options.accountBroker && (!rotation?.includes(plannedAccount)
      || new Set(rotation).size !== rotation.length))
      return { status: 'no-entry', reason: 'invalid-input' };
    const accounts = options.accountBroker
      ? [plannedAccount, ...rotation!.filter(name => name !== plannedAccount)] : undefined;
    const credentials = (options.credentials ?? hostCredentials)(plannedAccount);
    const deadlineMs = (options.deadlineSeconds ?? POD_JOB_DEADLINE_SECONDS) * 1000;
    const config = (options.fallbackConfig ?? getUserConfig)();
    const fallback = normalizeFallbackChain(config.llm.fallbackChain).chain;
    let grok: { grokAuth?: string; grokApiKey?: string } | null = null;
    if (fallback.includes('grok')) {
      try { grok = hostGrokCredentials({ minValidityMs: deadlineMs,
        apiKeyOptIn: options.grokApiKeyOptIn === true }); }
      catch { /* A missing or short-lived credential removes only this fallback step. */ }
    }
    const extraAccounts = accounts?.map((name, index) => index === 0
      ? credentials : (options.credentials ?? hostCredentials)(name));
    const bundle: SiWarmCredentialBundle = { files: {
      ...(accounts ? Object.fromEntries(extraAccounts!.map((credential, index) =>
        [`codex-${index}.json`, JSON.stringify({ elanousAuth: credential.elanousAuth,
          codexAuth: credential.codexAuth })]))
        : { 'elanous-auth.json': credentials.elanousAuth,
          'codex-auth.json': credentials.codexAuth }),
      'gh-token': credentials.ghToken,
      ...siWarmFallbackFiles(config.llm.fallbackChain, grok) },
    ...(accounts ? { accounts } : {}) };
    const payload = Buffer.from(JSON.stringify(siWarmPayload(input, options, runId)));
    const credentialBundle = Buffer.from(JSON.stringify(bundle));
    const deadlineAt = Date.now() + deadlineMs;
    prepared = { runId, attemptId, executionKey, sourceSha, deadlineAt,
      payload, credentialBundle, adopt: adoptSiWarmBytes };
  } catch (error) {
    // Credential errors may contain private paths or tokens; log the class, not its raw text.
    debug.log('pod.reuse', 'si-input-preparation-failed', {
      reason: error instanceof Error ? error.name : 'unknown', spaceId: input.spaceId,
    }, { level: 'warn' });
    return { status: 'no-entry', reason: 'invalid-input' };
  }
  return acquireSiWarmLease(prepared);
}
