import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { loadMirroredRunRecord, mirrorDir, mirrorRunRecord } from './run-record-mirror.js';
import { loadSelfDevRun, saveSelfDevRun, type SelfDevRunState } from './run-store.js';

describe('run record machine-ledger mirror', () => {
  let root: string;
  let primary: string;
  let mirror: string;
  const state = (updatedAt: number): SelfDevRunState => ({
    runId: 'run-mirror-test', createdAt: 1, updatedAt,
    results: [{ taskId: 'task-1', feature: 'fixture', status: 'done' }],
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'run-record-mirror-'));
    primary = join(root, 'launch-tree', '.elanous-test', 'self-dev-runs');
    setElanousConfigDir(join(root, 'machine-ledger'));
    mirror = mirrorDir();
  });
  afterEach(() => {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  });

  test('writes the same JSON atomically in the separate ledger with 0600 permissions', () => {
    saveSelfDevRun(state(100), primary);
    const name = 'run-mirror-test.json';
    expect(mirror).toBe(join(root, 'machine-ledger', 'self-dev-runs'));
    expect(readFileSync(join(mirror, name), 'utf8')).toBe(readFileSync(join(primary, name), 'utf8'));
    expect(statSync(join(mirror, name)).mode & 0o777).toBe(0o600);
    expect(readdirSync(mirror)).toEqual([name]);
  });

  test('does not write a second copy when the primary is already the ledger', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      saveSelfDevRun(state(100), mirror);
      const path = join(mirror, 'run-mirror-test.json');
      const before = statSync(path).mtimeMs;
      mirrorRunRecord(state(999), join(mirror, '.'));
      expect(statSync(path).mtimeMs).toBe(before);
      expect(JSON.parse(readFileSync(path, 'utf8')).updatedAt).toBe(100);
      expect(readdirSync(mirror).filter((name) => name.endsWith('.json'))).toEqual(['run-mirror-test.json']);
      expect(readdirSync(mirror).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(log).not.toHaveBeenCalledWith('self-dev.run-store', 'mirror-failed', expect.anything());
    } finally { log.mockRestore(); }
  });

  test('missing primary falls back to the mirrored record and reports the source', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      saveSelfDevRun(state(100), primary);
      unlinkSync(join(primary, 'run-mirror-test.json'));
      expect(loadSelfDevRun('run-mirror-test', primary)).toEqual(state(100));
      expect(log).toHaveBeenCalledWith('self-dev.run-store', 'read-from-mirror', { runId: 'run-mirror-test' });
    } finally { log.mockRestore(); }
  });

  test('a failed mirror write is logged but the primary save still succeeds', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(root, 'machine-ledger'));
      writeFileSync(mirror, 'not a directory');
      saveSelfDevRun(state(100), primary);
      expect(loadSelfDevRun('run-mirror-test', primary)).toEqual(state(100));
      expect(log).toHaveBeenCalledWith('self-dev.run-store', 'mirror-failed', {
        runId: 'run-mirror-test', reason: expect.any(String),
      });
    } finally { log.mockRestore(); }
  });

  test('repeated saves replace the one mirror file with the latest checkpoint', () => {
    saveSelfDevRun(state(100), primary);
    saveSelfDevRun(state(200), primary);
    expect(loadMirroredRunRecord('run-mirror-test')).toEqual(state(200));
    expect(readdirSync(mirror)).toEqual(['run-mirror-test.json']);
  });

  test('a damaged mirror without required timestamps cannot revive an absent primary', () => {
    mkdirSync(mirror, { recursive: true });
    const path = join(mirror, 'run-mirror-test.json');
    for (const damaged of [
      { runId: 'run-mirror-test', updatedAt: 100, results: [] },
      { runId: 'run-mirror-test', createdAt: 1, results: [] },
      { runId: 'run-mirror-test', createdAt: 'yesterday', updatedAt: 100, results: [] },
      { runId: 'run-mirror-test', createdAt: 1, updatedAt: null, results: [] },
    ]) {
      writeFileSync(path, JSON.stringify(damaged));
      expect(loadMirroredRunRecord('run-mirror-test')).toBeNull();
      expect(loadSelfDevRun('run-mirror-test', primary)).toBeNull();
    }
  });

  test('a valid primary takes precedence over a stale mirror without reporting fallback', () => {
    saveSelfDevRun(state(100), primary);
    writeFileSync(join(mirror, 'run-mirror-test.json'), JSON.stringify(state(999)));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(loadSelfDevRun('run-mirror-test', primary)).toEqual(state(100));
      expect(log).not.toHaveBeenCalledWith('self-dev.run-store', 'read-from-mirror', expect.anything());
    } finally { log.mockRestore(); }
  });
});
