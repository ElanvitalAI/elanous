import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeSsh } from './fake-ssh.js';
import { withSimClock } from './fake-clock.js';
import { runHqMoveSimulation, type HqMoveFault } from './hq-move-sim.js';

async function run(fault: HqMoveFault = 'none') {
  const root = mkdtempSync(join(tmpdir(), 'hq-move-sim-'));
  try {
    return await withSimClock(new Date('2026-11-09T06:00:00+09:00'), async (clock) => {
      const ssh = createFakeSsh({ hosts: {
        'mbp': { activeSessions: 0, maxStartups: 10 },
        'node-b': { activeSessions: 0, maxStartups: 10 },
      }, clock });
      const runPython = (source: string, home: string, env: Record<string, string>) => {
        const result = spawnSync('python3', ['-'], { input: source, encoding: 'utf8', cwd: home,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env } });
        return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') };
      };
      return runHqMoveSimulation(join(root, 'world'), fault, { ssh, clock, runPython });
    });
  }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('the production transfer, lease, fence, promotion copy, and resource-ledger pool paths converge from mbp to Studio', async () => {
  const result = await run();
  expect(result.pass, JSON.stringify(result)).toBe(true);
  expect(result.observations).toEqual(expect.arrayContaining([
    { event: 'transfer', verdict: 'complete' },
    { event: 'state-copy', verdict: 'verified:ledger=2,worktree=1,mail=1' },
    { event: 'lease', verdict: 'MacStudioB1@8' },
    { event: 'source-fence', verdict: 'retired' },
    { event: 'target-fence', verdict: 'allowed' },
    { event: 'pool-reallocation', verdict: 'node-b' },
  ]));
});

test('target loss refuses before changing the old lease holder', async () => {
  const result = await run('target-unavailable');
  expect(result.pass).toBe(true);
  expect(result.observations.find(row => row.event === 'lease')?.verdict).toBe('MacBookProM5@7');
});

test('partial promotion copy exposes that the new lease owner still allows service traffic', async () => {
  const result = await run('partial-copy');
  expect(result.pass).toBe(false);
  expect(result.observations.find(row => row.event === 'transfer')?.verdict).toContain('promotion ③ copy to promotion universe');
  expect(result.observations.find(row => row.event === 'state-copy')?.verdict).toContain('failed:ledger=0,worktree=0,mail=0;');
  expect(result.observations.find(row => row.event === 'target-fence')?.verdict).toBe('allowed');
  expect(result.observations.find(row => row.event === 'promotion-safety')?.verdict).toBe('failure:new-owner-still-allowed-after-copy-failure');
});

test('old host loss and stale pool registration remain visible as separate failure outcomes', async () => {
  const oldHostLoss = await run('old-host-loss');
  expect(oldHostLoss.pass, JSON.stringify(oldHostLoss)).toBe(true);
  const stale = await run('stale-pool');
  expect(stale.pass).toBe(true);
  expect(stale.observations.find(row => row.event === 'pool-reallocation')?.verdict).toBe('mbp');
});
