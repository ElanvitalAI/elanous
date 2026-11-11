import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectHostReadiness, readHostReadiness } from './host-readiness.js';
import { readResourceLedger, recordHostReadinessHeartbeat, type HostReadinessHeartbeat } from './resource-ledger.js';

// Source: BRIEF-LOCAL-FIRST-PLACEMENT-1111.md, rubric v1; samples span the four host grades and stale heartbeat boundary.
const heartbeat = (host: string, at: string, overrides: Partial<HostReadinessHeartbeat> = {}): HostReadinessHeartbeat => ({
  host,
  at,
  sshAvailable: true,
  maintenance: false,
  gateProtected: false,
  tools: { bun: true, repoGit: true },
  sample: { loadPercent: 10, load15Percent: 20, memoryAvailablePercent: 50, rootDiskUsedPercent: 60, tmpDiskUsedPercent: 60 },
  ...overrides,
});

function withLegacyLedgerPath<T>(path: string, run: () => T): T {
  const original = process.env.ELANOUS_HOST_READINESS_LEDGER;
  process.env.ELANOUS_HOST_READINESS_LEDGER = path;
  try { return run(); }
  finally {
    if (original === undefined) delete process.env.ELANOUS_HOST_READINESS_LEDGER;
    else process.env.ELANOUS_HOST_READINESS_LEDGER = original;
  }
}

test('projects simulated Nexus host heartbeats into rubric grades and marks 24h+ as stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-host-heartbeat-'));
  const path = join(dir, 'events.jsonl');
  const now = new Date('2026-11-11T12:00:00.000Z');
  try {
    recordHostReadinessHeartbeat(heartbeat('mshq', now.toISOString()), path);
    recordHostReadinessHeartbeat(heartbeat('minim5', now.toISOString(), { sample: {
      loadPercent: 55, load15Percent: 65, memoryAvailablePercent: 22, rootDiskUsedPercent: 86, tmpDiskUsedPercent: 88,
    } }), path);
    recordHostReadinessHeartbeat(heartbeat('node-c', now.toISOString(), { sample: {
      loadPercent: 72, load15Percent: 81, memoryAvailablePercent: 10, rootDiskUsedPercent: 92, tmpDiskUsedPercent: 92,
    } }), path);
    recordHostReadinessHeartbeat(heartbeat('aws1', now.toISOString(), { gateProtected: true, sample: undefined }), path);
    recordHostReadinessHeartbeat(heartbeat('cloud', '2026-11-10T11:59:59.999Z'), path);

    expect(projectHostReadiness(readResourceLedger(path), now).map(({ host, grade, symbol, stale }) => ({ host, grade, symbol, stale }))).toEqual([
      { host: 'mshq', grade: 'green', symbol: '🟢', stale: false },
      { host: 'minim5', grade: 'yellow', symbol: '🟡', stale: false },
      { host: 'node-c', grade: 'red', symbol: '🔴', stale: false },
      { host: 'aws1', grade: 'black', symbol: '⚫', stale: false },
      { host: 'cloud', grade: 'black', symbol: '⚫', stale: true },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('latest heartbeat wins per host and records observed tool availability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-host-heartbeat-latest-'));
  const path = join(dir, 'events.jsonl');
  try {
    recordHostReadinessHeartbeat(heartbeat('mshq', '2026-11-11T11:00:00.000Z'), path);
    recordHostReadinessHeartbeat(heartbeat('mshq', '2026-11-11T11:05:00.000Z', { tools: { bun: false, repoGit: true } }), path);
    expect(projectHostReadiness(readResourceLedger(path), new Date('2026-11-11T11:06:00.000Z'))).toMatchObject([
      { host: 'mshq', at: '2026-11-11T11:05:00.000Z', grade: 'green', tools: { bun: false, repoGit: true } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an older heartbeat arriving late cannot replace newer blocked readiness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-host-readiness-order-'));
  const path = join(dir, 'events.jsonl');
  try {
    recordHostReadinessHeartbeat(heartbeat('mshq', '2026-11-11T11:10:00.000Z', { gateProtected: true, sample: undefined }), path);
    recordHostReadinessHeartbeat(heartbeat('mshq', '2026-11-11T11:05:00.000Z'), path);
    expect(projectHostReadiness(readResourceLedger(path), new Date('2026-11-11T11:11:00.000Z'))).toMatchObject([
      { host: 'mshq', at: '2026-11-11T11:10:00.000Z', grade: 'black', verdict: 'UNMEASURED', reason: 'gate-protected' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readHostReadiness reads simulated heartbeats from the Nexus resource ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-host-readiness-reader-'));
  const path = join(dir, 'events.jsonl');
  try {
    recordHostReadinessHeartbeat(heartbeat('mshq', new Date().toISOString()), path);
    expect(withLegacyLedgerPath(join(dir, 'missing-legacy.tsv'), () => readHostReadiness(path))).toMatchObject([
      { host: 'mshq', grade: 'green', symbol: '🟢', verdict: 'READY' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy TSV remains visible until a newer resource-ledger heartbeat replaces it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-host-readiness-legacy-'));
  const path = join(dir, 'events.jsonl');
  const legacy = join(dir, 'host-readiness.tsv');
  try {
    const now = new Date();
    const legacyAt = new Date(now.getTime() - 60_000).toISOString();
    const heartbeatAt = new Date(now.getTime() - 30_000).toISOString();
    writeFileSync(legacy, [
      'host\titem\tstatus\trepaired\tat\tdetail',
      `node-c\tverdict\tBLOCKED\tno\t${heartbeatAt}\tspace,pods`,
      `mshq\tverdict\tUNMEASURED\tno\t${legacyAt}\treason=probe-unavailable`,
      `gcp2\tverdict\tBLOCKED\tno\t${legacyAt}\tspace`,
    ].join('\n'));
    recordHostReadinessHeartbeat(heartbeat('node-c', heartbeatAt), path);
    recordHostReadinessHeartbeat(heartbeat('gcp2', heartbeatAt), path);
    expect(withLegacyLedgerPath(legacy, () => readHostReadiness(path))).toMatchObject([
      { host: 'node-c', at: heartbeatAt, verdict: 'BLOCKED', failed: ['space', 'pods'] },
      { host: 'mshq', at: legacyAt, verdict: 'UNMEASURED', reason: 'probe-unavailable' },
      { host: 'gcp2', at: heartbeatAt, grade: 'green', verdict: 'READY' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
