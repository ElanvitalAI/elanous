import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupCandidates, removeBackupIfSuperseded, removeScreenIfUnchanged, runDataDietGc, runDataDietGcCli, screenCandidates, type DataDietRoots } from './data-diet-14d-gc.js';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const OLD = Date.parse('2026-10-01T12:00:00.000Z');

function fixture(): { root: string; roots: DataDietRoots; put: (group: keyof DataDietRoots, rel: string, content?: string, mtime?: number) => string; clean: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'data-diet-gc-test-'));
  const roots: DataDietRoots = {
    state: join(root, 'state'),
    sessions: join(root, 'state', 'sessions'),
    runLedger: join(root, 'state', 'run-ledger'),
    screens: join(root, 'state', 'harness-screens'),
    backups: join(root, 'state', 'backups'),
    evidence: join(root, 'hq', 'seat-state', 'OP', 'evidence'),
  };
  for (const path of Object.values(roots)) mkdirSync(path, { recursive: true });
  const put = (group: keyof DataDietRoots, rel: string, content = 'data', mtime = OLD): string => {
    const path = join(roots[group], rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    utimesSync(path, mtime / 1000, mtime / 1000);
    return path;
  };
  return { root, roots, put, clean: () => rmSync(root, { recursive: true, force: true }) };
}

function mockAws(options: {
  failUpload?: boolean; mismatchChecksum?: boolean; mismatchLength?: boolean;
  mismatchStorage?: boolean; mismatchEncryption?: boolean; onUpload?: (bodyPath: string) => void;
} = {}): (args: readonly string[], expectJson: boolean) => string | void {
  let bodyPath = '';
  let checksum = '';
  return (args, expectJson) => {
    if (args[0] !== 's3api') throw new Error(`unexpected AWS command: ${args[0]}`);
    if (args[1] === 'put-object') {
      bodyPath = args[args.indexOf('--body') + 1]!;
      checksum = args[args.indexOf('--checksum-sha256') + 1]!;
      options.onUpload?.(bodyPath);
      if (options.failUpload) throw new Error('simulated S3 upload failure');
      return;
    }
    if (args[1] === 'head-object' && expectJson) {
      return JSON.stringify({
        ContentLength: statSync(bodyPath).size + (options.mismatchLength ? 1 : 0),
        StorageClass: options.mismatchStorage ? 'STANDARD' : 'DEEP_ARCHIVE',
        ServerSideEncryption: options.mismatchEncryption ? 'aws:kms' : 'AES256',
        ChecksumSHA256: options.mismatchChecksum ? 'wrong-checksum' : checksum,
      });
    }
    throw new Error(`unexpected AWS operation: ${args[1]}`);
  };
}

async function mockArchive(root: string, relPaths: readonly string[], out: string): Promise<void> {
  writeFileSync(out, relPaths.map((rel) => `${rel}\n${readFileSync(join(root, rel), 'utf8')}`).join('\n'));
}

test('default plan is read-only and keeps active session, fresh data, and each backup family latest', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.roots.sessions, 'index.json'), JSON.stringify([
      { id: 'old-session', updatedAt: '2026-10-01T12:00:00.000Z' },
      { id: 'active-session', updatedAt: '2026-10-01T12:00:00.000Z' },
      { id: 'fresh-session', updatedAt: '2026-11-01T12:00:00.000Z' },
    ]));
    const oldSession = f.put('sessions', 'old-session.jsonl', '{"role":"user"}\n');
    f.put('sessions', 'active-session.jsonl', 'active');
    f.put('sessions', 'fresh-session.jsonl', 'fresh', Date.parse('2026-11-01T12:00:00Z'));
    f.put('backups', 'provider-a/old.json', 'old');
    const latest = f.put('backups', 'provider-a/latest.json', 'latest', Date.parse('2026-10-30T12:00:00Z'));
    f.put('backups', 'flat.json', 'unknown-family');

    const result = await runDataDietGc({ now: NOW, roots: f.roots, activeSessionId: 'active-session' });
    expect(result.mode).toBe('dry-run');
    expect(result.candidates).toMatchObject({ sessions: 1, backups: 1 });
    expect(readFileSync(oldSession, 'utf8')).toContain('user');
    expect(readFileSync(latest, 'utf8')).toBe('latest');
    expect(result.held.sessions).toBeGreaterThanOrEqual(2);
    expect(result.held.backups).toBeGreaterThanOrEqual(2);
  } finally { f.clean(); }
});

test('old screens with a live or unreadable claim are retained', async () => {
  const f = fixture();
  try {
    f.put('screens', 'stale.screen', 'old');
    f.put('screens', 'live.screen', 'old');
    f.put('screens', 'live.claim', JSON.stringify({ pid: process.pid, at: OLD, owner: 'active' }));
    f.put('screens', 'unknown.screen', 'old');
    f.put('screens', 'unknown.claim', '{bad json');
    f.put('screens', 'no-pid.screen', 'old');
    f.put('screens', 'no-pid.claim', JSON.stringify({ at: OLD }));
    const result = await runDataDietGc({ now: NOW, roots: f.roots, activeSessionId: null });
    expect(result.candidates.screens).toBe(1);
    expect(result.held.screens).toBeGreaterThanOrEqual(6);
  } finally { f.clean(); }
});

test('backup family is rechecked before deletion when the planned newest copy disappears', () => {
  const f = fixture();
  try {
    f.put('backups', 'family/old.json', 'old', OLD);
    const middle = f.put('backups', 'family/middle.json', 'middle', Date.parse('2026-10-20T12:00:00Z'));
    const newest = f.put('backups', 'family/newest.json', 'newest', Date.parse('2026-10-30T12:00:00Z'));
    const cutoff = NOW - 14 * 24 * 60 * 60 * 1000;
    const plan = backupCandidates(f.roots.backups, cutoff);
    const plannedMiddle = plan.candidates.find((candidate) => candidate.path === middle)!;
    rmSync(newest);
    expect(removeBackupIfSuperseded(plannedMiddle, f.roots.backups, cutoff)).toBe(false);
    expect(existsSync(middle)).toBe(true);
  } finally { f.clean(); }
});

test('a claim created after planning is rechecked immediately before screen deletion', () => {
  const f = fixture();
  try {
    const screen = f.put('screens', 'late.screen', 'old');
    const plan = screenCandidates(f.roots.screens, NOW - 14 * 24 * 60 * 60 * 1000, new Set());
    expect(plan.candidates).toHaveLength(1);
    f.put('screens', 'late.claim', JSON.stringify({ pid: process.pid, at: OLD, owner: 'became-active' }));
    expect(removeScreenIfUnchanged(plan.candidates[0]!, NOW - 14 * 24 * 60 * 60 * 1000, new Set())).toBe(false);
    expect(existsSync(screen)).toBe(true);
  } finally { f.clean(); }
});

test('terminal failed ledgers are archived candidates; completed are deletable and unfinished are held', async () => {
  const f = fixture();
  try {
    const writeLedger = (id: string, status: string | null) => {
      const rows = status
        ? [{ timestamp: '2026-10-01T12:00:00.000Z', runId: id, event: 'run-status', data: { runStatus: status } }]
        : [{ timestamp: '2026-10-01T12:00:00.000Z', runId: id, event: 'start', data: {} }];
      f.put('runLedger', `${id}.jsonl`, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    };
    writeLedger('run-completed', 'completed');
    writeLedger('run-failed', 'failed');
    writeLedger('run-active', null);
    const result = await runDataDietGc({ now: NOW, roots: f.roots, activeSessionId: null });
    expect(result.candidates.runLedger).toBe(2);
    expect(result.held.runLedger).toBeGreaterThanOrEqual(1);
  } finally { f.clean(); }
});

test('all eligible evidence is archived before its source can be removed', async () => {
  const f = fixture();
  try {
    const incident = f.put('evidence', 'autopsy/run-1/report.json', '{"private":"evidence"}');
    f.put('evidence', 'incident-report.json', '{"private":"named incident"}');
    f.put('evidence', 'reports/unknown.json', '{"private":"unclassified"}');
    const ordinary = f.put('evidence', 'notes/old.txt', 'old');
    const result = await runDataDietGc({ now: NOW, roots: f.roots, activeSessionId: null });
    expect(result.candidates).toMatchObject({ evidenceArchive: 4, evidenceDelete: 0 });
    expect(readFileSync(incident, 'utf8')).toContain('evidence');
    expect(readFileSync(ordinary, 'utf8')).toBe('old');
  } finally { f.clean(); }
});

test('CLI dry-run writes no journal; apply preserves sources on upload or head-object verification failure', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.roots.sessions, 'index.json'), JSON.stringify([
      { id: 'old-session', updatedAt: '2026-10-01T12:00:00.000Z' },
    ]));
    const source = f.put('sessions', 'old-session.jsonl', 'private conversation');
    const receiptPath = join(f.root, 'state', 'data-diet-14d-gc.jsonl');
    await runDataDietGcCli(['--dry-run'], { now: NOW, roots: f.roots, activeSessionId: null, receiptPath, writeLine: () => {} });
    expect(existsSync(receiptPath)).toBe(false);
    expect(existsSync(source)).toBe(true);

    for (const mock of [
      mockAws({ failUpload: true }),
      mockAws({ mismatchChecksum: true }),
      mockAws({ mismatchLength: true }),
      mockAws({ mismatchStorage: true }),
      mockAws({ mismatchEncryption: true }),
    ]) {
      let threw = false;
      try {
        await runDataDietGcCli(['--apply'], {
          now: NOW, roots: f.roots, activeSessionId: null, receiptPath, writeLine: () => {}, awsCommand: mock,
          archiveWriter: mockArchive,
        });
      } catch { threw = true; }
      expect(threw).toBe(true);
      expect(existsSync(source)).toBe(true);
      expect(existsSync(receiptPath)).toBe(false);
    }
  } finally { f.clean(); }
});

test('CLI apply removes an old session only after the archive verifier succeeds and records its receipt', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.roots.sessions, 'index.json'), JSON.stringify([
      { id: 'old-session', updatedAt: '2026-10-01T12:00:00.000Z' },
    ]));
    const source = f.put('sessions', 'old-session.jsonl', 'private conversation');
    const receiptPath = join(f.root, 'state', 'data-diet-14d-gc.jsonl');
    let verified = false;
    const result = await runDataDietGcCli(['--apply'], {
      now: NOW, roots: f.roots, activeSessionId: null, receiptPath, writeLine: () => {},
      archiveWriter: mockArchive, awsCommand: mockAws({ onUpload: () => { verified = true; } }),
    });
    expect(verified).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(result.archives).toHaveLength(1);
    expect(result.archives[0]!.scope).toBe('sessions');
    expect(result.archives[0]!.sha256).toHaveLength(64);
    expect(readFileSync(receiptPath, 'utf8')).toContain(result.archives[0]!.sha256);
  } finally { f.clean(); }
});

test('incident evidence is staged and changed source is retained after its archive is verified', async () => {
  const f = fixture();
  try {
    const source = f.put('evidence', 'autopsy/run-1/report.json', '{"version":1}');
    let archivedSource = '';
    const result = await runDataDietGc({
      now: NOW, roots: f.roots, activeSessionId: null, apply: true,
      archiveWriter: mockArchive, awsCommand: mockAws({ onUpload: (bodyPath) => {
        archivedSource = readFileSync(bodyPath, 'utf8');
        writeFileSync(source, '{"version":2}');
      } }),
    });
    expect(archivedSource).toContain('{"version":1}');
    expect(existsSync(source)).toBe(true);
    expect(readFileSync(source, 'utf8')).toContain('version":2');
    expect(result.removed.evidence).toBeUndefined();
  } finally { f.clean(); }
});
