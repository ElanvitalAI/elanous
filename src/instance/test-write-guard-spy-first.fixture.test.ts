// Runner for test-write-guard-spy-first.fixture.ts — a child that spies execFileSync
// before importing outbound-alert must get TestOpsWriteRefusedError and zero curl calls.
import { expect, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a child that spies execFileSync before importing outbound-alert is refused with zero curl calls', () => {
  const state = mkdtempSync(join(tmpdir(), 'spy-first-runner-'));
  try {
    const r = childProcess.spawnSync(process.execPath, [join(import.meta.dir, 'test-write-guard-spy-first.fixture.ts')], {
      env: { ...process.env, NODE_ENV: 'test', ELANOUS_STATE_DIR: state, ELANOUS_CONFIG_DIR: state },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!)).toEqual({ refused: 'TestOpsWriteRefusedError', curlCalls: 0 });
  } finally { rmSync(state, { recursive: true, force: true }); }
}, 90_000);
