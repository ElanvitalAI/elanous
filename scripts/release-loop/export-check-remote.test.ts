import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, fstatSync, mkdtempSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteScript, type PayloadFile } from '../../src/self-implement/gate-remote.js';
import { EXPORT_CHECK_REMOTE_HOSTS, exportCheckRemoteArgv, readExportRedactionsPayload, runExportCheckRemote, type ExportCheckRemoteInvoker, type ExportRedactionsFileIo } from './export-check-remote.js';
import type { HostLedger, HostRecord } from '../../src/nexus/host-registry/index.js';

const COMMIT = 'a'.repeat(40);
const REDACTIONS = 'private-test-value\tpublic-placeholder\n';
const readRedactions = () => REDACTIONS;
const NOW = 1_700_000_000_000;
const SHA_A = 'a'.repeat(40);

/** In-memory registry ledger fixture; liveness is recomputed from lastHeartbeatMs at selection time. */
function ledgerOf(entries: Record<string, number>): HostLedger {
  const hosts: Record<string, HostRecord> = Object.create(null);
  for (const [host, lastHeartbeatMs] of Object.entries(entries)) {
    Object.defineProperty(hosts, host, { value: { host, channel: 'release', installedSha: SHA_A, lastHeartbeatMs, state: 'unknown' } satisfies HostRecord, enumerable: true, writable: true, configurable: true });
  }
  return { version: 1, hosts };
}
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
  const result = runExportCheckRemote({ repo: '/repo', host: 'aws1', mirror: '/mirror/agent.git', commit: COMMIT, version: '0.3.6', graphContext }, invoke, undefined, readRedactions, { readLedger: () => undefined });
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

test('remote export-check refuses unlisted hosts and invalid commit before dispatch', () => {
  let calls = 0;
  const invoke: ExportCheckRemoteInvoker = () => { calls++; throw new Error('must not dispatch'); };
  expect(runExportCheckRemote({ repo: '/repo', host: 'mbp1', commit: COMMIT, version: '0.3.6' }, invoke).outcome).toBe('error');
  expect(runExportCheckRemote({ repo: '/repo', host: 'aws1', commit: 'short', version: '0.3.6' }, invoke).outcome).toBe('error');
  expect(calls).toBe(0);
});

test('remote infrastructure failure is reported without local fallback', () => {
  let calls = 0;
  const invoke: ExportCheckRemoteInvoker = () => { calls++; return { kind: 'infra', reason: 'ssh-unavailable', stage: 'ssh', rc: 255, stderr: 'connection refused' }; };
  expect(runExportCheckRemote({ repo: '/repo', host: 'gcp2', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions, { readLedger: () => undefined })).toMatchObject({
    outcome: 'error', verdict: 'fail', executor: 'host', host: 'gcp2', remote: true, summary: 'remote export-check ssh-unavailable', tail: 'connection refused',
  });
  expect(calls).toBe(1);
});

test('remote node exit code and result must agree', () => {
  const invoke: ExportCheckRemoteInvoker = (options) => ({
    kind: 'ran', rc: 1, stdout: Buffer.from(`${PASS}\n`), stderr: Buffer.alloc(0), commit: options.commit, host: 'aws1', ms: 42,
  });
  expect(runExportCheckRemote({ repo: '/repo', host: 'aws1', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions, { readLedger: () => undefined })).toMatchObject({
    outcome: 'error', verdict: 'fail', summary: 'remote export-check result inconsistent with exit code (rc=1, outcome=ok, verdict=pass)',
  });
});

// ── RELEASE-EXPORT-CHECK-REMOTE-LIVE (0.3.32 P0): 코드 기본 호스트 = node-b · 원장 기준 살아 있는 등록 호스트 대체 · 선택 결과 기록 ──

test('the export-check remote allowlist is node-b, aws1, gcp2', () => {
  expect([...EXPORT_CHECK_REMOTE_HOSTS]).toEqual(['node-b', 'aws1', 'gcp2']);
});

test('remote export-check dispatches on node-b and records the requested selection in the ledger log', () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const dispatched: string[] = [];
  const invoke: ExportCheckRemoteInvoker = (options) => {
    dispatched.push(options.host);
    return { kind: 'ran', rc: 0, stdout: Buffer.from(`${PASS}\n`), stderr: Buffer.alloc(0), commit: COMMIT, host: options.host, ms: 5 };
  };
  const result = runExportCheckRemote({ repo: '/repo', host: 'node-b', mirror: '/mirror/agent.git', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions, {
    readLedger: () => ledgerOf({ 'node-b': NOW - 60_000 }),
    now: () => NOW,
    log: (event, data) => { events.push([event, data]); },
  });
  expect(dispatched).toEqual(['node-b']);
  expect(result).toMatchObject({ outcome: 'ok', verdict: 'pass', executor: 'host', host: 'node-b', remote: true, step: 'build' });
  expect(events).toEqual([['host-selected', { node: 'export-check', to: 'node-b', origin: 'requested', reason: 'registered heartbeat fresh' }]]);
});

test('a stale node-b heartbeat substitutes the freshest live registered host before dispatch', () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const dispatched: string[] = [];
  const invoke: ExportCheckRemoteInvoker = (options) => {
    dispatched.push(options.host);
    return { kind: 'ran', rc: 0, stdout: Buffer.from(`${PASS}\n`), stderr: Buffer.alloc(0), commit: COMMIT, host: options.host, ms: 5 };
  };
  const result = runExportCheckRemote({ repo: '/repo', host: 'node-b', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions, {
    readLedger: () => ledgerOf({ 'node-b': NOW - 3_600_000, gcp2: NOW - 300_000, aws1: NOW - 60_000 }),
    now: () => NOW,
    log: (event, data) => { events.push([event, data]); },
  });
  expect(dispatched).toEqual(['aws1']);
  expect(result).toMatchObject({ outcome: 'ok', verdict: 'pass', executor: 'host', host: 'aws1', remote: true, step: 'build' });
  expect(events).toEqual([
    ['host-selected', { node: 'export-check', from: 'node-b', to: 'aws1', origin: 'substituted', reason: 'requested host node-b heartbeat stale' }],
  ]);
});

test('an ssh failure on node-b fails over once to a live registered host and records the reroute', () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const dispatched: string[] = [];
  const invoke: ExportCheckRemoteInvoker = (options) => {
    dispatched.push(options.host);
    if (options.host === 'node-b') return { kind: 'infra', reason: 'ssh rc=255: Operation timed out', stage: 'ssh', rc: 255, stderr: 'ssh: connect to host node-b port 22: Operation timed out' };
    return { kind: 'ran', rc: 0, stdout: Buffer.from(`${PASS}\n`), stderr: Buffer.alloc(0), commit: COMMIT, host: options.host, ms: 7 };
  };
  const result = runExportCheckRemote({ repo: '/repo', host: 'node-b', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions, {
    readLedger: () => ledgerOf({ 'node-b': NOW - 60_000, aws1: NOW - 120_000 }),
    now: () => NOW,
    log: (event, data) => { events.push([event, data]); },
  });
  expect(dispatched).toEqual(['node-b', 'aws1']);
  expect(result).toMatchObject({ outcome: 'ok', verdict: 'pass', executor: 'host', host: 'aws1', remote: true, step: 'build' });
  expect(events).toEqual([
    ['host-selected', { node: 'export-check', to: 'node-b', origin: 'requested', reason: 'registered heartbeat fresh' }],
    ['host-selected', { node: 'export-check', from: 'node-b', to: 'aws1', origin: 'substituted', reason: 'remote infra: ssh rc=255: Operation timed out' }],
  ]);
});

test('a stale requested heartbeat with no live registered host fails closed before dispatch', () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const invoke: ExportCheckRemoteInvoker = () => { throw new Error('must not dispatch'); };
  const result = runExportCheckRemote({ repo: '/repo', host: 'node-b', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions, {
    readLedger: () => ledgerOf({ 'node-b': NOW - 3_600_000, aws1: NOW - 3_600_000 }),
    now: () => NOW,
    log: (event, data) => { events.push([event, data]); },
  });
  expect(result).toMatchObject({ outcome: 'error', verdict: 'fail', step: 'build', summary: 'remote export-check host node-b heartbeat stale and no live registered host — fail-closed' });
  expect(events).toEqual([
    ['host-failover-refused', { node: 'export-check', from: 'node-b', reason: 'no live registered host in the registry ledger' }],
  ]);
});

test('an ssh failure with no live registered host fails closed without substitution', () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const dispatched: string[] = [];
  const invoke: ExportCheckRemoteInvoker = (options) => {
    dispatched.push(options.host);
    return { kind: 'infra', reason: 'ssh rc=255: Operation timed out', stage: 'ssh', rc: 255, stderr: 'ssh: connect to host node-b port 22: Operation timed out' };
  };
  const result = runExportCheckRemote({ repo: '/repo', host: 'node-b', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions, {
    readLedger: () => undefined,
    now: () => NOW,
    log: (event, data) => { events.push([event, data]); },
  });
  expect(dispatched).toEqual(['node-b']);
  expect(result).toMatchObject({ outcome: 'error', verdict: 'fail', executor: 'host', host: 'node-b', remote: true, summary: 'remote export-check ssh rc=255: Operation timed out', tail: 'ssh: connect to host node-b port 22: Operation timed out' });
  expect(events).toEqual([
    ['host-selected', { node: 'export-check', to: 'node-b', origin: 'requested', reason: 'not in registry ledger; dispatch probes the host' }],
    ['host-failover-refused', { node: 'export-check', from: 'node-b', reason: 'no live registered host in the registry ledger' }],
  ]);
});

test('a busy host answered — no substitution', () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const dispatched: string[] = [];
  const invoke: ExportCheckRemoteInvoker = (options) => {
    dispatched.push(options.host);
    return { kind: 'busy', occupied: 2, rc: 98 };
  };
  const result = runExportCheckRemote({ repo: '/repo', host: 'node-b', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions, {
    readLedger: () => ledgerOf({ 'node-b': NOW - 60_000, aws1: NOW - 60_000 }),
    now: () => NOW,
    log: (event, data) => { events.push([event, data]); },
  });
  expect(dispatched).toEqual(['node-b']);
  expect(result).toMatchObject({ outcome: 'error', verdict: 'fail', executor: 'host', host: 'node-b', remote: true, summary: 'remote export-check host busy (2 slots)' });
  expect(events).toEqual([
    ['host-selected', { node: 'export-check', to: 'node-b', origin: 'requested', reason: 'registered heartbeat fresh' }],
  ]);
});

test('a host-side setup failure is a response, not an unresponsive host — no substitution', () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const dispatched: string[] = [];
  const invoke: ExportCheckRemoteInvoker = (options) => {
    dispatched.push(options.host);
    return { kind: 'infra', reason: 'remote-bun-install', stage: 'bun-install', rc: 97, stderr: 'bun install failed' };
  };
  const result = runExportCheckRemote({ repo: '/repo', host: 'node-b', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions, {
    readLedger: () => ledgerOf({ 'node-b': NOW - 60_000, aws1: NOW - 60_000 }),
    now: () => NOW,
    log: (event, data) => { events.push([event, data]); },
  });
  expect(dispatched).toEqual(['node-b']);
  expect(result).toMatchObject({ outcome: 'error', verdict: 'fail', executor: 'host', host: 'node-b', remote: true, summary: 'remote export-check remote-bun-install' });
  expect(events).toEqual([
    ['host-selected', { node: 'export-check', to: 'node-b', origin: 'requested', reason: 'registered heartbeat fresh' }],
  ]);
});

// ── #39376 게이트 대체 호스트 결함: push 단계 실패도 대체 호스트로 · 키·값 결속 · 전송 직전 allowlist 재검증 ──

test('a push-stage infra failure on node-b also fails over to a live registered host', () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const dispatched: Array<{ host: string; argv: string[] }> = [];
  const invoke: ExportCheckRemoteInvoker = (options) => {
    if (!Array.isArray(options.argv)) throw new Error('export-check must dispatch resolved argv');
    dispatched.push({ host: options.host, argv: options.argv });
    if (options.host === 'node-b') {
      return { kind: 'infra', stage: 'push', rc: 128, reason: 'push-failed rc=128: ssh: connect to host node-b port 22: Connection refused', stderr: 'ssh: connect to host node-b port 22: Connection refused' };
    }
    return { kind: 'ran', rc: 0, stdout: Buffer.from(`${PASS}\n`), stderr: Buffer.alloc(0), commit: COMMIT, host: options.host, ms: 9 };
  };
  const result = runExportCheckRemote({ repo: '/repo', host: 'node-b', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions, {
    readLedger: () => ledgerOf({ 'node-b': NOW - 60_000, aws1: NOW - 120_000 }),
    now: () => NOW,
    log: (event, data) => { events.push([event, data]); },
  });
  expect(dispatched.map((entry) => entry.host)).toEqual(['node-b', 'aws1']);
  expect(dispatched.every((entry) => entry.argv.join(' ').includes('export-check-node.ts'))).toBe(true);
  expect(result).toMatchObject({ outcome: 'ok', verdict: 'pass', executor: 'host', host: 'aws1', remote: true, step: 'build' });
  expect(events).toEqual([
    ['host-selected', { node: 'export-check', to: 'node-b', origin: 'requested', reason: 'registered heartbeat fresh' }],
    ['host-selected', { node: 'export-check', from: 'node-b', to: 'aws1', origin: 'substituted', reason: 'remote infra: push-failed rc=128: ssh: connect to host node-b port 22: Connection refused' }],
  ]);
});

test('a substitute ledger record whose host value does not bind to its allowlist key is never dispatched to', () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const dispatched: string[] = [];
  const invoke: ExportCheckRemoteInvoker = (options) => {
    dispatched.push(options.host);
    return { kind: 'ran', rc: 0, stdout: Buffer.from(`${PASS}\n`), stderr: Buffer.alloc(0), commit: COMMIT, host: options.host, ms: 9 };
  };
  // gcp2's record is the freshest live entry but its `host` value names a different machine — a mismatched record
  // must never be dispatched to (키·값 결속), and with no bound substitute the dispatch fails closed.
  const ledger: HostLedger = { version: 1, hosts: {
    'node-b': { host: 'node-b', channel: 'release', installedSha: SHA_A, lastHeartbeatMs: NOW - 3_600_000, state: 'unknown' },
    'gcp2': { host: 'gcp2-renamed.example', channel: 'release', installedSha: SHA_A, lastHeartbeatMs: NOW - 30_000, state: 'unknown' },
  } };
  const result = runExportCheckRemote({ repo: '/repo', host: 'node-b', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions, {
    readLedger: () => ledger,
    now: () => NOW,
    log: (event, data) => { events.push([event, data]); },
  });
  expect(dispatched).toEqual([]);
  expect(result).toMatchObject({ outcome: 'error', verdict: 'fail', step: 'build', summary: 'remote export-check host node-b heartbeat stale and no live registered host — fail-closed' });
  expect(events).toEqual([
    ['host-failover-refused', { node: 'export-check', from: 'node-b', reason: 'no live registered host in the registry ledger' }],
  ]);
});

test('substitute selection dispatches the bound allowlist key, never the record host value', () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const dispatched: string[] = [];
  const invoke: ExportCheckRemoteInvoker = (options) => {
    dispatched.push(options.host);
    return { kind: 'ran', rc: 0, stdout: Buffer.from(`${PASS}\n`), stderr: Buffer.alloc(0), commit: COMMIT, host: options.host, ms: 9 };
  };
  // gcp2 is the freshest but unbound (record value ≠ key); aws1 is freshest among bound records.
  const ledger: HostLedger = { version: 1, hosts: {
    'node-b': { host: 'node-b', channel: 'release', installedSha: SHA_A, lastHeartbeatMs: NOW - 3_600_000, state: 'unknown' },
    'gcp2': { host: 'gcp2-renamed.example', channel: 'release', installedSha: SHA_A, lastHeartbeatMs: NOW - 30_000, state: 'unknown' },
    'aws1': { host: 'aws1', channel: 'release', installedSha: SHA_A, lastHeartbeatMs: NOW - 60_000, state: 'unknown' },
  } };
  const result = runExportCheckRemote({ repo: '/repo', host: 'node-b', commit: COMMIT, version: '0.3.6' }, invoke, undefined, readRedactions, {
    readLedger: () => ledger,
    now: () => NOW,
    log: (event, data) => { events.push([event, data]); },
  });
  expect(dispatched).toEqual(['aws1']);
  expect(result).toMatchObject({ outcome: 'ok', verdict: 'pass', executor: 'host', host: 'aws1', remote: true, step: 'build' });
  expect(events).toEqual([
    ['host-selected', { node: 'export-check', from: 'node-b', to: 'aws1', origin: 'substituted', reason: 'requested host node-b heartbeat stale' }],
  ]);
});
