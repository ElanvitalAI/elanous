/** Pinned pr land's heavy gate. A pass belongs to exactly one PR head and main tip. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { getUserConfig } from '../user-config.js';
import { debug, redactSecretText } from '../debug/log.js';
import { gateRemoteHostCap, realGateRemoteRunner, resolveGateRemoteSettings, runOnRemote, type GateRemoteRunner, type RemoteRunOutcome } from '../self-implement/gate-remote.js';

const SHA = /^[0-9a-f]{40}$/i;
// This is the stable fallback order when settings.host is unavailable; an explicitly configured allowlisted host
// always leads, and the remaining allowlisted hosts retain their relative order.
export const PR_LAND_HEAVY_HOSTS = ['node-b', 'node-c', 'host-e-wsl'] as const;
export const PR_LAND_HEAVY_HOST = PR_LAND_HEAVY_HOSTS[0];
export type PrLandHeavyHost = typeof PR_LAND_HEAVY_HOSTS[number];
const allowedHost = (host: string): host is PrLandHeavyHost => PR_LAND_HEAVY_HOSTS.some((candidate) => candidate === host);

export interface HeavyRemoteEvidence {
  schema: 2;
  pr: number;
  head: string;
  main: string;
  host: PrLandHeavyHost;
  passedAt: string;
  elapsedMs: number;
  rootPlan: RootPlanSummary | null;
  interferenceMeasured: boolean;
}

export interface RootPlanSummary {
  mode: 'affected' | 'full';
  roots: number | null;
  promoted: boolean;
  reason: string | null;
}

export interface HeavyRemoteInput {
  pr: number;
  head: string;
  main: string;
  repo: string;
  evidenceDir?: string;
}

export interface HeavyRemoteResult {
  ok: boolean;
  /** Host reported by a completed remote run; absent when no host executed the gate. */
  host?: string;
  /** Last host requested, including an unsuccessful or busy attempt. */
  attemptedHost?: PrLandHeavyHost;
  source: 'cached' | 'remote' | 'unmeasured';
  reason?: string;
  elapsedMs: number;
  evidencePath: string;
  /** Redacted stdout/stderr from a failed remote gate; never a reusable pass. */
  failureLogPath?: string;
  rootPlan?: RootPlanSummary | null;
  interferenceMeasured?: boolean;
}

export interface HeavyRemoteDeps {
  runner?: GateRemoteRunner;
  runRemote?: (input: Parameters<typeof runOnRemote>[0], runner: GateRemoteRunner) => RemoteRunOutcome;
  settings?: ReturnType<typeof resolveGateRemoteSettings>;
  now?: () => number;
  /** Test seam — same cadence as self gate (`dispatchHeavyCheck`): sleep at most 15s while a host stays busy. */
  sleep?: (ms: number) => void;
  observe?: (event: string, data: Record<string, unknown>) => void;
}

function evidencePath(input: HeavyRemoteInput): string {
  return join(input.evidenceDir ?? join(effectiveInstanceRoot(), 'pr-land-heavy-results'), `${input.pr}.json`);
}

function validRootPlan(value: unknown): value is RootPlanSummary | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<RootPlanSummary>;
  return (plan.mode === 'affected' || plan.mode === 'full')
    && (plan.roots === null || (Number.isSafeInteger(plan.roots) && plan.roots >= 0))
    && typeof plan.promoted === 'boolean'
    && (plan.reason === null || typeof plan.reason === 'string');
}

function matchingEvidence(path: string, input: HeavyRemoteInput): HeavyRemoteEvidence | null {
  if (!existsSync(path)) return null;
  try {
    const data: HeavyRemoteEvidence = JSON.parse(readFileSync(path, 'utf8'));
    return data.schema === 2 && data.pr === input.pr && data.head === input.head
      && data.main === input.main && allowedHost(data.host) && Number.isFinite(data.elapsedMs)
      && typeof data.interferenceMeasured === 'boolean' && validRootPlan(data.rootPlan) ? data : null;
  } catch { return null; }
}

function rootPlanFromOutput(output: Buffer): RootPlanSummary | null {
  const line = output.toString('utf8').split(/\r?\n/).reverse().find((item: string) => item.startsWith('[tsc-gate] root-plan '));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice('[tsc-gate] root-plan '.length)) as RootPlanSummary;
    if ((parsed.mode !== 'affected' && parsed.mode !== 'full') || (parsed.roots !== null && (!Number.isSafeInteger(parsed.roots) || parsed.roots < 0))
      || typeof parsed.promoted !== 'boolean' || (parsed.reason !== null && typeof parsed.reason !== 'string')) return null;
    return parsed;
  } catch { return null; }
}

function extraGatesFromOutput(output: Buffer): { interferenceMeasured: boolean } | null {
  const line = output.toString('utf8').split(/\r?\n/).reverse().find((item) => item.startsWith('[pr-land-extra-gates] pass '));
  const match = /^\[pr-land-extra-gates\] pass global=measured interference=(measured|unmeasured) files=\d+$/.exec(line ?? '');
  return match ? { interferenceMeasured: match[1] === 'measured' } : null;
}

/** Only gate verdict lines reach the landing error. Keep it one line and bounded even for a large remote log. */
function failedGateSummary(stdout: Buffer, stderr: Buffer): string | undefined {
  const boundLine = (line: string): string => {
    const safe = redactSecretText(line).replace(/[\x00-\x1f\x7f]+/g, ' ');
    if (safe.length <= 220) return safe;
    // Give both streams space: either one can carry the actionable cause.
    const outAt = safe.indexOf(' · stdout: ');
    const errAt = safe.indexOf(' · stderr: ');
    if (safe.startsWith('shard diagnostic:') && errAt !== -1) {
      const stdoutLabel = ' · stdout: ';
      const stderrLabel = ' · stderr: ';
      const prefixEnd = outAt !== -1 && outAt < errAt ? outAt : errAt;
      const rawPrefix = safe.slice(0, prefixEnd);
      const prefix = rawPrefix.length > 100 ? `${rawPrefix.slice(0, 99)}…` : rawPrefix;
      const rawStderr = safe.slice(errAt + stderrLabel.length);
      const rawStdout = outAt !== -1 && outAt < errAt ? safe.slice(outAt + stdoutLabel.length, errAt) : '';
      const hasStdout = rawStdout.length > 0;
      const available = 220 - prefix.length - stderrLabel.length - (hasStdout ? stdoutLabel.length : 0);
      const stdoutBudget = hasStdout ? Math.floor(available / 2) : 0;
      const stderrBudget = available - stdoutBudget;
      const clip = (value: string, budget: number): string => {
        if (value.length <= budget) return value;
        const head = Math.floor((budget - 1) / 2);
        return `${value.slice(0, head)}…${value.slice(-(budget - 1 - head))}`;
      };
      return `${prefix}${hasStdout ? `${stdoutLabel}${clip(rawStdout, stdoutBudget)}` : ''}${stderrLabel}${clip(rawStderr, stderrBudget)}`;
    }
    return `${safe.slice(0, 110)}…${safe.slice(-109)}`;
  };
  const output = `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`;
  const lines = output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:shards: unmeasured|shard attempt:|shard diagnostic:|\[gate-baseline\]|✗ |error:|fatal:)/.test(line));
  const verdict = [...lines].reverse().find((line) => line.startsWith('shards: unmeasured'))
    ?? [...lines].reverse().find((line) => line.startsWith('[gate-baseline]'));
  const unmeasuredIds = new Set(verdict?.startsWith('shards: unmeasured')
    ? [...verdict.matchAll(/\bshard-\d+\b/g)].map((match) => match[0]) : []);
  // The last attempt overall may have recovered while an earlier, different shard remains unmeasured.
  const failedAttempt = [...lines].reverse().find((line) => {
    const id = /^shard attempt: (shard-\d+) #/.exec(line)?.[1];
    return id && unmeasuredIds.has(id);
  });
  const attemptKey = /^shard attempt: (\S+ #\d+)\b/.exec(failedAttempt ?? '')?.[1];
  const diagnostic = attemptKey
    ? lines.filter((line) => line.startsWith(`shard diagnostic: ${attemptKey} `))
    : [];
  // Generic stderr can be arbitrarily long; it must never displace the selected shard's two sides.
  const limit = 5;
  const selected = failedAttempt
    ? [failedAttempt, ...diagnostic.slice(-2), verdict, [...lines].reverse().find((line) => /^(?:✗ |error:|fatal:)/.test(line))].filter((line): line is string => !!line)
    : lines.filter((line) => !line.startsWith('shard attempt:') && !line.startsWith('shard diagnostic:')).slice(-limit);
  const actionable = !!failedAttempt || selected.some((line) => /^(?:shards: unmeasured|\[gate-baseline\]|✗ |error:|fatal:)/.test(line));
  const tail = [
      ...stderr.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-2).map((line) => `stderr: ${line}`),
      ...stdout.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-2).map((line) => `stdout: ${line}`),
    ];
  const context = limit > tail.length ? selected.slice(-(limit - tail.length)) : [];
  const cause = actionable ? selected : [...context, ...tail];
  const bounded = cause.slice(0, 5).map(boundLine);
  return bounded.length ? bounded.join(' | ') : undefined;
}

/** The self-gate baseline prints one failure per line after its count header. Keep only distinct test paths here. */
function failedGateFiles(stdout: Buffer, stderr: Buffer): string | undefined {
  const files = { introduced: new Set<string>(), preexisting: new Set<string>() };
  for (const line of `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`.split(/\r?\n/)) {
    const match = /^- (introduced|preexisting):\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s+>|\s|$)/.exec(line.trim());
    if (match) files[match[1] as keyof typeof files].add(match[2]!);
  }
  const parts = (['introduced', 'preexisting'] as const).filter((kind) => files[kind].size > 0)
    .map((kind) => { const names = [...files[kind]].sort(); return `${kind}-files=${names.slice(0, 5).map((name) => redactSecretText(name).slice(0, 160)).join(',')}${names.length > 5 ? `,+${names.length - 5}` : ''}`; });
  return parts.length ? parts.join(' · ') : undefined;
}

/** Remote scratch is deleted on exit. Preserve a bounded, redacted copy before returning a refusal. */
function writeFailedGateLog(path: string, stdout: Buffer, stderr: Buffer): string | undefined {
  // One latest refusal log per PR; repeated attempts replace it atomically instead of accumulating files.
  const logPath = `${path}.failure.log`;
  const tempPath = `${logPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const maxBytes = 2 * 1024 * 1024;
  const render = (label: string, bytes: Buffer): string => {
    const safe = Buffer.from(redactSecretText(bytes.toString('utf8')), 'utf8');
    const clipped = safe.length > maxBytes
      ? `${safe.subarray(0, maxBytes / 2).toString('utf8')}\n[remote log middle truncated]\n${safe.subarray(-maxBytes / 2).toString('utf8')}` : safe.toString('utf8');
    return `=== ${label} (${bytes.length} bytes${safe.length > maxBytes ? ', middle truncated' : ''}) ===\n${clipped}\n`;
  };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tempPath, render('stdout', stdout) + render('stderr', stderr), { mode: 0o600, flag: 'wx' });
    renameSync(tempPath, logPath);
    return logPath;
  } catch { rmSync(tempPath, { force: true }); return undefined; }
}

/** No local gate fallback: host refusal, an unmeasured run, and a failed gate all block landing. */
export function ensurePrLandHeavyRemote(input: HeavyRemoteInput, deps: HeavyRemoteDeps = {}): HeavyRemoteResult {
  const path = evidencePath(input);
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0 || !SHA.test(input.head) || !SHA.test(input.main)) {
    return { ok: false, source: 'unmeasured', reason: 'invalid-pr-head-or-main', elapsedMs: 0, evidencePath: path };
  }
  // A cached success is still a landing claim; accept only a measured host in the landing allowlist.
  const settings = deps.settings ?? resolveGateRemoteSettings(getUserConfig().gateRemote);
  if (!allowedHost(settings.host)) {
    return { ok: false, source: 'unmeasured', reason: `gate-host-mismatch (${settings.host})`, elapsedMs: 0, evidencePath: path };
  }
  const cached = matchingEvidence(path, input);
  if (cached) return { ok: true, host: cached.host, source: 'cached', elapsedMs: 0, evidencePath: path, rootPlan: cached.rootPlan, interferenceMeasured: cached.interferenceMeasured };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => { if (ms > 0) Bun.sleepSync(ms); });
  const started = now();
  const deadline = started + settings.slotWaitSeconds * 1000;
  let outcome: RemoteRunOutcome = { kind: 'busy' };
  let selectedHost: PrLandHeavyHost = PR_LAND_HEAVY_HOSTS[0];
  const hosts: readonly PrLandHeavyHost[] = [settings.host, ...PR_LAND_HEAVY_HOSTS.filter((host) => host !== settings.host)];
  wait: for (;;) {
    for (const host of hosts) {
      selectedHost = host;
      try {
        outcome = (deps.runRemote ?? runOnRemote)({
          repo: input.repo, host, mirror: settings.mirror, commit: input.head,
          refs: [input.main], hostCap: gateRemoteHostCap(settings, host), installPwa: true, stableCheckout: true,
          // Test the tree GitHub will merge: scratch-checkout the reviewed head, merge the pinned main tip there,
          // then run typecheck and self gate (changed tests and PWA reach/build) at that exact pair.
          // The detached integration commit stays on the selected host and never changes the PR branch.
          argv: (sha) => ['sh', '-c',
          'git -c user.name=elanous-gate -c user.email=gate@localhost -c commit.gpgsign=false merge --no-ff --no-edit "$1" && TSC_BASE_REF="$1" bun run scripts/ci-typecheck-changed.ts --local && bun bin/elanous.mjs self gate --changed --base "$1" --local --shards 4 && bun scripts/pr-land-extra-remote-gates.ts "$1"',
          'sh', sha(input.main)],
        }, deps.runner ?? realGateRemoteRunner);
      } catch (error) {
        outcome = { kind: 'infra', reason: `exception: ${error instanceof Error ? error.message : String(error)}` };
      }
      // A completed run or infrastructure failure is a verdict. Only a full host slot asks for another host.
      if (outcome.kind !== 'busy') break wait;
    }
    // Every allowlisted host was busy. Wait the same slotWaitSeconds window as self gate, then retry.
    debug.log('pr.land', 'host-busy', { host: selectedHost, occupied: outcome.occupied ?? null, slotWaitSeconds: settings.slotWaitSeconds });
    const left = deadline - now();
    if (left <= 0) break;
    sleep(Math.min(15_000, left));
    if (now() >= deadline) break;
  }
  const elapsedMs = Math.max(0, now() - started);
  const observe = deps.observe ?? ((event: string, data: Record<string, unknown>) => debug.log('pr.land', event, data));
  const actualHost = outcome.kind === 'ran' ? outcome.host : undefined;
  const base = { pr: input.pr, head: input.head, main: input.main, host: actualHost ?? null, attemptedHost: selectedHost, elapsedMs };
  // The outcome must identify the selected allowlisted host; the configured host alone is not evidence.
  if (outcome.kind !== 'ran' || outcome.commit !== input.head || outcome.rc !== 0 || outcome.host !== selectedHost) {
    const summary = outcome.kind === 'ran' && outcome.rc !== 0 ? failedGateSummary(outcome.stdout, outcome.stderr) : undefined;
    // A different host cannot attest to this gate, so do not promote its file list into the refusal.
    const files = outcome.kind === 'ran' && outcome.rc !== 0 && outcome.host === selectedHost && outcome.commit === input.head
      ? failedGateFiles(outcome.stdout, outcome.stderr) : undefined;
    const failureLogPath = outcome.kind === 'ran' ? writeFailedGateLog(path, outcome.stdout, outcome.stderr) : undefined;
    const reason = outcome.kind === 'ran'
      ? outcome.host !== selectedHost
        ? `gate-host-mismatch (${outcome.host})${failureLogPath ? ` · remote-log: ${failureLogPath}` : ''}`
        : `gate-rc-${outcome.rc}${outcome.commit !== input.head ? '-head-mismatch' : ''}${files ? ` · ${files}` : ''}${summary ? ` · remote: ${summary}` : ''}${failureLogPath ? ` · remote-log: ${failureLogPath}` : ' · remote-log: unavailable'}`
      : outcome.kind === 'busy' ? 'gate-host-busy' : outcome.reason;
    observe('heavy-remote', { ...base, outcome: outcome.kind === 'ran' ? 'fail' : 'unmeasured', reason, failureLogPath: failureLogPath ?? null });
    return { ok: false, ...(actualHost ? { host: actualHost } : {}), attemptedHost: selectedHost, source: 'unmeasured', reason, elapsedMs, evidencePath: path, ...(failureLogPath ? { failureLogPath } : {}) };
  }
  const extraGates = extraGatesFromOutput(outcome.stdout);
  if (!extraGates) {
    const failureLogPath = writeFailedGateLog(path, outcome.stdout, outcome.stderr);
    const reason = `extra-global-unmeasured${failureLogPath ? ` · remote-log: ${failureLogPath}` : ' · remote-log: unavailable'}`;
    observe('heavy-remote', { ...base, outcome: 'unmeasured', reason, failureLogPath: failureLogPath ?? null });
    return { ok: false, host: selectedHost, attemptedHost: selectedHost, source: 'unmeasured', reason, elapsedMs, evidencePath: path, ...(failureLogPath ? { failureLogPath } : {}) };
  }
  const evidence: HeavyRemoteEvidence = {
    schema: 2, pr: input.pr, head: input.head, main: input.main, host: selectedHost,
    passedAt: new Date().toISOString(), elapsedMs: outcome.ms, rootPlan: rootPlanFromOutput(outcome.stdout),
    interferenceMeasured: extraGates.interferenceMeasured,
  };
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(evidence)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    const failureLogPath = writeFailedGateLog(path, outcome.stdout, outcome.stderr);
    const reason = `evidence-write-failed: ${error instanceof Error ? error.message : String(error)}${failureLogPath ? ` · remote-log: ${failureLogPath}` : ' · remote-log: unavailable'}`;
    observe('heavy-remote', { ...base, outcome: 'unmeasured', reason, failureLogPath: failureLogPath ?? null });
    return { ok: false, host: selectedHost, attemptedHost: selectedHost, source: 'unmeasured', reason, elapsedMs, evidencePath: path, ...(failureLogPath ? { failureLogPath } : {}) };
  }
  observe('heavy-remote', { ...base, outcome: 'pass', evidencePath: path, rootPlan: evidence.rootPlan, interferenceMeasured: evidence.interferenceMeasured });
  return { ok: true, host: selectedHost, source: 'remote', elapsedMs, evidencePath: path, rootPlan: evidence.rootPlan, interferenceMeasured: evidence.interferenceMeasured };
}
