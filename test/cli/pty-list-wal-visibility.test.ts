import { setDefaultTimeout, afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  setPtyManifestDbPathForTesting,
  upsertPtyManifest,
} from '../../src/pty-shell/pty-manifest.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const homes: string[] = [];

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'elanous-pty-list-wal-'));
  homes.push(home);
  setPtyManifestDbPathForTesting(join(home, '.elanous', 'pty', 'manifest.db'));
});

afterAll(() => {
  setPtyManifestDbPathForTesting(null);
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe('elanous pty list --all --include-test WAL visibility', () => {
  test('separate CLI process lists a fresh frame-less live registration before checkpoint', () => {
    const id = 'pty_fresh_wal_cli';
    const now = Date.now();
    upsertPtyManifest({ id, kind: 'tui', cmd: 'elanous', startedAt: now, now, ptyPid: process.pid });

    const home = homes.at(-1)!;
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'pty', 'list', '--all', '--include-test'], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: join(home, '.elanous') },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(id);
  });
});
