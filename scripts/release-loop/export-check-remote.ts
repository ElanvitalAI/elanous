import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { userInfo } from 'node:os';
import { lastResult } from './node-verdict.js';
import { GATE_REMOTE_DEFAULTS, runOnRemote, type GateRemoteRunner, type PayloadFile, type RemoteRunOptions, type RemoteRunOutcome } from '../../src/self-implement/gate-remote.js';
import { privateRedactionsPath } from '../public-export.js';
import type { ExportCheckResult } from './export-check-node.js';

export const EXPORT_CHECK_REMOTE_HOSTS = ['aws1', 'gcp2'] as const;
export const EXPORT_CHECK_REMOTE_TIMEOUT_MS = 45 * 60_000;

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

/** Run the normal export-check node in the existing gate remote's clean, commit-pinned checkout. */
export function runExportCheckRemote(
  input: ExportCheckRemoteOptions,
  invoke: ExportCheckRemoteInvoker = runOnRemote,
  runner?: GateRemoteRunner,
  readRedactions: ExportRedactionsReader = () => readExportRedactionsPayload(),
): ExportCheckResult & { executor?: 'host'; host?: string; remote?: true } {
  if (!(EXPORT_CHECK_REMOTE_HOSTS as readonly string[]).includes(input.host)) {
    return { outcome: 'error', verdict: 'fail', summary: `export-check remote host must be aws1 or gcp2 (got ${input.host})`, step: 'build', tail: '' };
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
  const outcome = invoke({
    repo: input.repo,
    host: input.host,
    mirror: input.mirror ?? GATE_REMOTE_DEFAULTS.mirror,
    commit: input.commit,
    argv: exportCheckRemoteArgv(input.commit, input.version),
    installPwa: true,
    payloadFiles,
    timeoutMs: input.timeoutMs ?? EXPORT_CHECK_REMOTE_TIMEOUT_MS,
  }, runner);
  if (outcome.kind === 'infra') {
    return { outcome: 'error', verdict: 'fail', summary: `remote export-check ${outcome.reason}`, step: 'build', tail: outcome.stderr?.trim().slice(-1000) ?? '', executor: 'host', host: input.host, remote: true };
  }
  if (outcome.kind === 'busy') {
    return { outcome: 'error', verdict: 'fail', summary: `remote export-check host busy (${outcome.occupied ?? 'unknown'} slots)`, step: 'build', tail: '', executor: 'host', host: input.host, remote: true };
  }
  const parsed = lastResult({ status: outcome.rc, stdout: outcome.stdout.toString('utf8'), stderr: outcome.stderr.toString('utf8') });
  if (!parsed || (parsed.outcome !== 'ok' && parsed.outcome !== 'fail' && parsed.outcome !== 'error') || (parsed.verdict !== 'pass' && parsed.verdict !== 'fail') || typeof parsed.summary !== 'string') {
    return { outcome: 'error', verdict: 'fail', summary: `remote export-check returned no valid node result (rc=${outcome.rc})`, step: 'build', tail: outcome.stderr.toString('utf8').trim().slice(-1000), executor: 'host', host: input.host, remote: true };
  }
  const consistent = (outcome.rc === 0 && parsed.outcome === 'ok' && parsed.verdict === 'pass')
    || (outcome.rc === 1 && parsed.outcome === 'fail' && parsed.verdict === 'fail')
    || (outcome.rc === 2 && parsed.outcome === 'error' && parsed.verdict === 'fail');
  if (!consistent) {
    return {
      outcome: 'error', verdict: 'fail', summary: `remote export-check result inconsistent with exit code (rc=${outcome.rc}, outcome=${parsed.outcome}, verdict=${parsed.verdict})`,
      step: parsed.step === 'export' || parsed.step === 'build' ? parsed.step : 'build',
      tail: typeof parsed.tail === 'string' ? parsed.tail : '', executor: 'host', host: input.host, remote: true,
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
