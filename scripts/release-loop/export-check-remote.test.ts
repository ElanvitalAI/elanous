import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, fstatSync, mkdtempSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteScript, type PayloadFile } from '../../src/self-implement/gate-remote.js';
import { exportCheckRemoteArgv, readExportRedactionsPayload, runExportCheckRemote, type ExportCheckRemoteInvoker, type ExportRedactionsFileIo } from './export-check-remote.js';

const COMMIT = 'a'.repeat(40);
const REDACTIONS = 'private-test-value\tpublic-placeholder\n';
const readRedactions = () => REDACTIONS;
const PASS = JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: `public export and PWA build ${COMMIT.slice(0, 12)}`, step: 'build', tail: '' });

test('remote export-check passes the parent home user to remote leak detection', () => {
  expect(exportCheckRemoteArgv(COMMIT, '0.3.6', 'TESTONLY')).toEqual([
    'env', 'ELANOUS_LEAK_HOME_USER=TESTONLY', 'bun', 'scripts/release-loop/export-check-node.ts', '--local',
    '--commit', COMMIT, '--version', '0.3.6',
  ]);
});

test('remote export-check runs the pinned local node with PWA dependencies and returns its result', () => {
  let seen: Parameters<ExportCheckRemoteInvoker>[0] | undefined;
  const invoke: ExportCheckRemoteInvoker = (options) => {
    seen = options;
    return { kind: 'ran', rc: 0, stdout: Buffer.from(`${PASS}\n`), stderr: Buffer.alloc(0), commit: COMMIT, host: 'aws1', ms: 42 };
  };
  const graphContext = JSON.stringify({ input: { version: '0.3.6', previousVersion: '0.3.5' }, outputs: { 'version-release': { commit: COMMIT } } });
  const result = runExportCheckRemote({ repo: '/repo', host: 'aws1', mirror: '/mirror/agent.git', commit: COMMIT, version: '0.3.6', graphContext }, invoke, undefined, readRedactions);
  expect(seen).toMatchObject({
    repo: '/repo', host: 'aws1', mirror: '/mirror/agent.git', commit: COMMIT,
    argv: exportCheckRemoteArgv(COMMIT, '0.3.6'), installPwa: true, timeoutMs: 45 * 60_000,
    payloadFiles: [
      { env: 'ELANOUS_GRAPH_CONTEXT', content: graphContext },
      { env: 'ELANOUS_EXPORT_REDACTIONS', content: REDACTIONS },
    ],
  });
  if (!seen || !Array.isArray(seen.argv) || !Array.isArray(seen.payloadFiles)) throw new Error('remote invocation options were not captured');
  expect(seen.argv.join(' ')).not.toContain(REDACTIONS);
  const payloadFiles: PayloadFile[] = seen.payloadFiles;
  const shell = remoteScript({ mirror: '/mirror/agent.git', commit: COMMIT, fetchShas: [COMMIT], argv: seen.argv, installPwa: true, payloadFiles });
  expect(shell).toContain('umask 077');
  expect(shell).toContain('ELANOUS_EXPORT_REDACTIONS="$W/payload-1"');
  expect(shell).toContain(`cat > "$W/payload-1" <<'__GATE_REMOTE_PAYLOAD_1__'`);
  expect(shell).toContain(REDACTIONS);
  expect(result).toMatchObject({ outcome: 'ok', verdict: 'pass', executor: 'host', host: 'aws1', remote: true, step: 'build' });
});

test('remote export-check refuses dispatch when the private redaction table is absent', () => {
  let calls = 0;
  const invoke: ExportCheckRemoteInvoker = () => { calls++; throw new Error('must not dispatch'); };
  expect(runExportCheckRemote({ repo: '/repo', host: 'aws1', commit: COMMIT, version: '0.3.6' }, invoke, undefined, () => null)).toMatchObject({
    outcome: 'error', verdict: 'fail', step: 'export', summary: 'private export redaction table unavailable; remote export-check refused',
  });
  expect(calls).toBe(0);
});

test('local redaction payload must be a private non-empty regular table', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-check-redactions-'));
  try {
    const source = join(root, 'redactions.tsv');
    expect(readExportRedactionsPayload(source)).toBeNull();
    writeFileSync(source, '# comment only\n', { mode: 0o600 });
    chmodSync(source, 0o600);
    expect(readExportRedactionsPayload(source)).toBeNull();
    writeFileSync(source, REDACTIONS, { mode: 0o644 });
    chmodSync(source, 0o644);
    expect(readExportRedactionsPayload(source)).toBeNull();
    writeFileSync(source, REDACTIONS, { mode: 0o600 });
    chmodSync(source, 0o600);
    expect(readExportRedactionsPayload(source)).toBe(REDACTIONS);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects a writerless FIFO promptly instead of blocking', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-check-redactions-nonregular-'));
  try {
    const fifo = join(root, 'redactions.fifo');
    execFileSync('mkfifo', [fifo]);
    const moduleUrl = new URL('./export-check-remote.ts', import.meta.url).href;
    const childSource = `import { readExportRedactionsPayload } from ${JSON.stringify(moduleUrl)}; if (readExportRedactionsPayload(${JSON.stringify(fifo)}) !== null) process.exitCode = 2;`;
    const child = spawnSync(process.execPath, ['-e', childSource], { encoding: 'utf8', timeout: 2_000 });
    expect(child.error?.message ?? '').not.toMatch(/ETIMEDOUT/);
    expect(child.status).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects invalid UTF-8 instead of forwarding replacement characters', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-check-redactions-utf8-'));
  try {
    const source = join(root, 'redactions.tsv');
    writeFileSync(source, Buffer.from([0xff, 0x09, 0x78, 0x0a]), { mode: 0o600 });
    chmodSync(source, 0o600);
    expect(readExportRedactionsPayload(source)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('uses the already-open file when its pathname is atomically replaced', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-check-redactions-swap-'));
  try {
    const source = join(root, 'redactions.tsv');
    const replacement = join(root, 'replacement.tsv');
    writeFileSync(source, REDACTIONS, { mode: 0o600 });
    writeFileSync(replacement, 'replacement-value\tpublic-name\n', { mode: 0o600 });
    const io: ExportRedactionsFileIo = {
      open(path, flags) {
        const fd = openSync(path, flags);
        renameSync(replacement, path);
        return fd;
      },
      stat: fstatSync,
      read: readSync,
      close: closeSync,
    };
    expect(readExportRedactionsPayload(source, io)).toBe(REDACTIONS);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects a private redaction file modified while it is being read', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-check-redactions-change-'));
  try {
    const source = join(root, 'redactions.tsv');
    writeFileSync(source, REDACTIONS, { mode: 0o600 });
    let changed = false;
    const io: ExportRedactionsFileIo = {
      open: openSync,
      stat: fstatSync,
      read(fd, buffer, offset, length, position) {
        if (!changed) {
          changed = true;
          writeFileSync(source, 'short\tvalue\n', { mode: 0o600 });
        }
        return readSync(fd, buffer, offset, length, position);
      },
      close: closeSync,
    };
    expect(readExportRedactionsPayload(source, io)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('remote export-check refuses gate hosts and invalid commit before dispatch', () => {
  let calls = 0;
  const invoke: ExportCheckRemoteInvoker = () => { calls++; throw new Error('must not dispatch'); };
  expect(runExportCheckRemote({ repo: '/repo', host: 'node-b', commit: COMMIT, version: '0.3.6' }, invoke).outcome).toBe('error');
  expect(runExportCheckRemote({ repo: '/repo', host: 'aws1', commit: 'short', version: '0.3.6' }, invoke).outcome).toBe('error');
  expect(calls).toBe(0);
});

test('remote infrastructure failure is reported without local fallback', () => {
  const invoke: ExportCheckRemoteInvoker = () => ({ kind: 'infra', reason: 'ssh-unavailable', stage: 'ssh', rc: 255, stderr: 'connection refused' });
  expect(runExportCheckRemote({ repo: '/repo', host: 'gcp2', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions)).toMatchObject({
    outcome: 'error', verdict: 'fail', executor: 'host', host: 'gcp2', remote: true, summary: 'remote export-check ssh-unavailable', tail: 'connection refused',
  });
});

test('remote node exit code and result must agree', () => {
  const invoke: ExportCheckRemoteInvoker = (options) => ({
    kind: 'ran', rc: 1, stdout: Buffer.from(`${PASS}\n`), stderr: Buffer.alloc(0), commit: options.commit, host: 'aws1', ms: 42,
  });
  expect(runExportCheckRemote({ repo: '/repo', host: 'aws1', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions)).toMatchObject({
    outcome: 'error', verdict: 'fail', summary: 'remote export-check result inconsistent with exit code (rc=1, outcome=ok, verdict=pass)',
  });
});
