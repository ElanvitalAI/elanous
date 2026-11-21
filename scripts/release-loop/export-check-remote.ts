import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { userInfo } from 'node:os';
import { lastResult } from './node-verdict.js';
import { GATE_REMOTE_DEFAULTS, runOnRemote, type GateRemoteRunner, type PayloadFile, type RemoteRunOptions, type RemoteRunOutcome } from '../../src/self-implement/gate-remote.js';
import { privateRedactionsPath } from '../public-export.js';
import { readHostLedger } from '../../src/nexus/host-registry/store.js';
import type { HostLedger, HostRecord } from '../../src/nexus/host-registry/index.js';
import type { ExportCheckResult } from './export-check-node.js';

/** RELEASE-EXPORT-CHECK-REMOTE-LIVE (0.3.32 P0): the code default remote host is node-b. */
export const EXPORT_CHECK_REMOTE_HOSTS = ['node-b', 'aws1', 'gcp2'] as const;
export const EXPORT_CHECK_REMOTE_TIMEOUT_MS = 45 * 60_000;
/** A registered heartbeat older than this many ms counts as stale for host selection. */
export const EXPORT_CHECK_HEARTBEAT_FRESH_MS = 5 * 60_000;

export interface ExportCheckRemoteOptions {
  repo: string;
  host: string;
  commit: string;
  version: string;
  graphContext?: string;
  mirror?: string;
  timeoutMs?: number;
}

export type ExportCheckRemoteInvoker = (options: RemoteRunOptions, runner?: GateRemoteRunner) => RemoteRunOutcome;
export type ExportRedactionsReader = () => string | null;

/** RELEASE-EXPORT-CHECK-REMOTE-LIVE: registry-ledger host selection knobs (injectable for tests). */
export interface ExportCheckHostSelectionDeps {
  /** Fail-soft registry ledger read; undefined means the requested host is not in the ledger. */
  readLedger?: () => HostLedger | undefined;
  now?: () => number;
  /** Structured selection record — one JSON event per host-selected / host-failover-refused decision. */
  log?: (event: string, data: Record<string, unknown>) => void;
}
const MAX_EXPORT_REDACTIONS_BYTES = 1_048_576;

export interface ExportRedactionsFileIo {
  open(path: string, flags: number): number;
  stat(fd: number): ReturnType<typeof fstatSync>;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

const REDACTIONS_FILE_IO: ExportRedactionsFileIo = {
  open: openSync,
  stat: fstatSync,
  read: readSync,
  close: closeSync,
};

function hasRedactionEntries(payload: string): boolean {
  return payload.split(/\r?\n/).some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return false;
    const [from, to] = raw.split('\t');
    return !!from?.trim() && to !== undefined;
  });
}

/** Read only a private, non-empty HQ table; its bytes travel only in gate-remote's mode-0600 SSH payload. */
export function readExportRedactionsPayload(path = privateRedactionsPath(), io: ExportRedactionsFileIo = REDACTIONS_FILE_IO): string | null {
  let fd: number | undefined;
  try {
    fd = io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    const before = io.stat(fd);
    const size = Number(before.size);
    if (!before.isFile() || (Number(before.mode) & 0o077) !== 0 || size === 0 || size > MAX_EXPORT_REDACTIONS_BYTES) return null;
    const bytes = Buffer.alloc(size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = io.read(fd, bytes, length, bytes.length - length, length);
      if (read === 0) break;
      length += read;
    }
    const after = io.stat(fd);
    if (length !== size
      || !after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) return null;
    const payload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    if (payload.includes('\0') || !hasRedactionEntries(payload)) return null;
    return payload;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { io.close(fd); } catch { /* already closed or invalid */ }
    }
  }
}

export function exportCheckRemoteArgv(commit: string, version: string, homeUser = process.env.USER || userInfo().username): string[] {
  return ['env', `ELANOUS_LEAK_HOME_USER=${homeUser}`, 'bun', 'scripts/release-loop/export-check-node.ts', '--local', '--commit', commit, '--version', version];
}

/** #39376 ②: key·value binding — a substitute must be an allowlist KEY whose ledger record binds to the same key
 *  (record.host === key). The record's own `host` value field never names a dispatch target: a renamed or mismatched
 *  record is skipped, not transmitted to. */
function freshestLiveRegisteredHost(ledger: HostLedger, now: number, exclude?: string): { key: string; record: HostRecord } | undefined {
  let freshest: { key: string; record: HostRecord } | undefined;
  for (const key of EXPORT_CHECK_REMOTE_HOSTS) {
    if (key === exclude) continue;
    const record = ledger.hosts[key];
    if (!record || record.host !== key) continue;
    if (now - record.lastHeartbeatMs > EXPORT_CHECK_HEARTBEAT_FRESH_MS) continue;
    if (!freshest || record.lastHeartbeatMs > freshest.record.lastHeartbeatMs) freshest = { key, record };
  }
  return freshest;
}

/** #39376 ②: the one transmission gate — re-validates the dispatch host against the allowlist immediately before
 *  invoke so the selection above and the transmission below can never diverge. */
function transmissionHost(host: string): { host: string } | { refused: string } {
  return (EXPORT_CHECK_REMOTE_HOSTS as readonly string[]).includes(host)
    ? { host }
    : { refused: `export-check remote dispatch host ${host} is not on the allowlist (node-b, aws1, gcp2) — fail-closed` };
}

/** Resolve the dispatch host from the requested host and the registry ledger; records the decision in the selection log. */
function resolveDispatchHost(requested: string, deps: ExportCheckHostSelectionDeps): { host: string; substituted: boolean; failClosed?: string } {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? (() => {});
  const ledger = deps.readLedger ? safeReadLedger(deps.readLedger) : readHostLedger();
  const requestedRecord = ledger?.hosts[requested];
  // #39376 ②: only a record bound to its allowlist key (record.host === key) can vouch for the requested host's liveness.
  const requestedLive = !!requestedRecord && requestedRecord.host === requested && now - requestedRecord.lastHeartbeatMs <= EXPORT_CHECK_HEARTBEAT_FRESH_MS;
  if (requestedLive) {
    log('host-selected', { node: 'export-check', to: requested, origin: 'requested', reason: 'registered heartbeat fresh' });
    return { host: requested, substituted: false };
  }
  if (requestedRecord) {
    const substitute = ledger ? freshestLiveRegisteredHost(ledger, now) : undefined;
    if (substitute) {
      log('host-selected', { node: 'export-check', from: requested, to: substitute.key, origin: 'substituted', reason: `requested host ${requested} heartbeat stale` });
      return { host: substitute.key, substituted: true };
    }
    log('host-failover-refused', { node: 'export-check', from: requested, reason: 'no live registered host in the registry ledger' });
    return { host: requested, substituted: false, failClosed: `remote export-check host ${requested} heartbeat stale and no live registered host — fail-closed` };
  }
  log('host-selected', { node: 'export-check', to: requested, origin: 'requested', reason: 'not in registry ledger; dispatch probes the host' });
  return { host: requested, substituted: false };
}

function safeReadLedger(readLedger: () => HostLedger | undefined): HostLedger | undefined {
  try { return readLedger(); } catch { return undefined; }
}

/** Run the normal export-check node in the existing gate remote's clean, commit-pinned checkout. */
export function runExportCheckRemote(
  input: ExportCheckRemoteOptions,
  invoke: ExportCheckRemoteInvoker = runOnRemote,
  runner?: GateRemoteRunner,
  readRedactions: ExportRedactionsReader = () => readExportRedactionsPayload(),
  hostDeps: ExportCheckHostSelectionDeps = {},
): ExportCheckResult & { executor?: 'host'; host?: string; remote?: true } {
  if (!(EXPORT_CHECK_REMOTE_HOSTS as readonly string[]).includes(input.host)) {
    return { outcome: 'error', verdict: 'fail', summary: `export-check remote host must be node-b, aws1 or gcp2 (got ${input.host})`, step: 'build', tail: '' };
  }
  if (!/^[0-9a-f]{40}$/i.test(input.commit)) {
    return { outcome: 'error', verdict: 'fail', summary: 'export-check remote requires a full 40-hex commit', step: 'export', tail: '' };
  }
  const redactions = readRedactions();
  if (redactions === null) {
    return { outcome: 'error', verdict: 'fail', summary: 'private export redaction table unavailable; remote export-check refused', step: 'export', tail: '' };
  }
  const payloadFiles: PayloadFile[] = [
    ...(input.graphContext ? [{ env: 'ELANOUS_GRAPH_CONTEXT', content: input.graphContext } satisfies PayloadFile] : []),
    { env: 'ELANOUS_EXPORT_REDACTIONS', content: redactions },
  ];
  let dispatchHost = resolveDispatchHost(input.host, hostDeps);
  if (dispatchHost.failClosed) {
    return { outcome: 'error', verdict: 'fail', summary: dispatchHost.failClosed, step: 'build', tail: '' };
  }
  // #39376 ②: re-validate against the allowlist immediately before the transmission.
  const transmission = transmissionHost(dispatchHost.host);
  if ('refused' in transmission) {
    return { outcome: 'error', verdict: 'fail', summary: transmission.refused, step: 'build', tail: '' };
  }
  let outcome = invoke({
    repo: input.repo,
    host: transmission.host,
    mirror: input.mirror ?? GATE_REMOTE_DEFAULTS.mirror,
    commit: input.commit,
    argv: exportCheckRemoteArgv(input.commit, input.version),
    installPwa: true,
    payloadFiles,
    timeoutMs: input.timeoutMs ?? EXPORT_CHECK_REMOTE_TIMEOUT_MS,
  }, runner);
  // RELEASE-EXPORT-CHECK-REMOTE-LIVE + #39376 ①: an unresponsive requested host fails over once to a live registered
  // host — node-b unavailability surfacing at the git push step (stage=push) is as unresponsive as an ssh-stage failure.
  if (outcome.kind === 'infra' && (outcome.stage === 'ssh' || outcome.stage === 'push')) {
    const ledger = hostDeps.readLedger ? safeReadLedger(hostDeps.readLedger) : readHostLedger();
    const now = (hostDeps.now ?? Date.now)();
    const substitute = ledger ? freshestLiveRegisteredHost(ledger, now, transmission.host) : undefined;
    if (substitute) {
      const log = hostDeps.log ?? (() => {});
      // #39376 ②: re-validate the substitute key against the allowlist immediately before its transmission.
      const reroute = transmissionHost(substitute.key);
      if ('refused' in reroute) {
        log('host-failover-refused', { node: 'export-check', from: transmission.host, to: substitute.key, reason: reroute.refused });
      } else {
        log('host-selected', { node: 'export-check', from: transmission.host, to: reroute.host, origin: 'substituted', reason: `remote infra: ${outcome.reason}` });
        const rerouteOutcome = invoke({
          repo: input.repo,
          host: reroute.host,
          mirror: input.mirror ?? GATE_REMOTE_DEFAULTS.mirror,
          commit: input.commit,
          argv: exportCheckRemoteArgv(input.commit, input.version),
          installPwa: true,
          payloadFiles,
          timeoutMs: input.timeoutMs ?? EXPORT_CHECK_REMOTE_TIMEOUT_MS,
        }, runner);
        if (rerouteOutcome.kind !== 'infra' || (rerouteOutcome.stage !== 'ssh' && rerouteOutcome.stage !== 'push')) outcome = rerouteOutcome;
        dispatchHost = { host: reroute.host, substituted: true };
      }
    } else {
      const log = hostDeps.log ?? (() => {});
      log('host-failover-refused', { node: 'export-check', from: transmission.host, reason: 'no live registered host in the registry ledger' });
    }
  }
  const selectedHost = outcome.kind === 'infra' || outcome.kind === 'busy' ? input.host : dispatchHost.host;
  if (outcome.kind === 'infra') {
    return { outcome: 'error', verdict: 'fail', summary: `remote export-check ${outcome.reason}`, step: 'build', tail: outcome.stderr?.trim().slice(-1000) ?? '', executor: 'host', host: selectedHost, remote: true };
  }
  if (outcome.kind === 'busy') {
    return { outcome: 'error', verdict: 'fail', summary: `remote export-check host busy (${outcome.occupied ?? 'unknown'} slots)`, step: 'build', tail: '', executor: 'host', host: selectedHost, remote: true };
  }
  const parsed = lastResult({ status: outcome.rc, stdout: outcome.stdout.toString('utf8'), stderr: outcome.stderr.toString('utf8') });
  if (!parsed || (parsed.outcome !== 'ok' && parsed.outcome !== 'fail' && parsed.outcome !== 'error') || (parsed.verdict !== 'pass' && parsed.verdict !== 'fail') || typeof parsed.summary !== 'string') {
    return { outcome: 'error', verdict: 'fail', summary: `remote export-check returned no valid node result (rc=${outcome.rc})`, step: 'build', tail: outcome.stderr.toString('utf8').trim().slice(-1000), executor: 'host', host: selectedHost, remote: true };
  }
  const consistent = (outcome.rc === 0 && parsed.outcome === 'ok' && parsed.verdict === 'pass')
    || (outcome.rc === 1 && parsed.outcome === 'fail' && parsed.verdict === 'fail')
    || (outcome.rc === 2 && parsed.outcome === 'error' && parsed.verdict === 'fail');
  if (!consistent) {
    return {
      outcome: 'error', verdict: 'fail', summary: `remote export-check result inconsistent with exit code (rc=${outcome.rc}, outcome=${parsed.outcome}, verdict=${parsed.verdict})`,
      step: parsed.step === 'export' || parsed.step === 'build' ? parsed.step : 'build',
      tail: typeof parsed.tail === 'string' ? parsed.tail : '', executor: 'host', host: selectedHost, remote: true,
    };
  }
  return {
    outcome: parsed.outcome,
    verdict: parsed.verdict,
    summary: parsed.summary,
    ...(parsed.step === 'export' || parsed.step === 'build' ? { step: parsed.step } : { step: 'build' as const }),
    ...(typeof parsed.tail === 'string' ? { tail: parsed.tail } : { tail: outcome.stderr.toString('utf8').trim().slice(-1000) }),
    executor: 'host', host: outcome.host, remote: true,
  };
}
