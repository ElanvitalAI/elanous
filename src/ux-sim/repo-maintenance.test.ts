import { expect, test } from 'bun:test';
import { maintenanceSetupPrecedesWork, simRepoMaintenance } from './repo-maintenance.js';

test('REPO-GIT-MAINTENANCE sim runs production maintenance and protects live refs', () => {
  const result = simRepoMaintenance();
  expect(result.pass).toBe(true);
  expect(result.dryRunCandidates).toContain('refs/train-manager/pr/expired');
  expect(result.appliedDeletions).toEqual(['refs/train-manager/pr/expired']);
  expect(result.preservedRefs).toEqual([
    'refs/remotes/origin/main', 'refs/remotes/origin/open-pr', 'refs/heads/live-run', 'refs/train-manager/pr/queued',
  ]);
  expect(result.packs).toEqual([4_471, 4]);
  expect(result.staleUpdateRefRejected).toBe(true);
  expect(result.staleRefPreserved).toBe(true);
  expect(result.expiredRefAbsentAfterApply).toBe(true);
  expect(result.maintenanceDisabledBeforeMeasurement).toBe(true);
  expect(simRepoMaintenance({ updateRefNoop: true }).pass).toBe(false);
  const setupFirst = [
    'count-objects -v',
    'config --local --replace-all gc.auto 0',
    'config --local --replace-all maintenance.auto false',
    'count-objects -v',
    'pack-refs --all',
  ];
  expect(maintenanceSetupPrecedesWork(setupFirst)).toBe(true);
  expect(maintenanceSetupPrecedesWork([
    setupFirst[0]!, setupFirst[3]!, setupFirst[4]!, setupFirst[1]!, setupFirst[2]!,
  ])).toBe(false);
  expect(result.commandOrder).toContain('config --local --replace-all gc.auto 0');
  expect(result.commandOrder).toContain('config --local --replace-all maintenance.auto false');
  expect(result.commandOrder.some((command) => command.includes(' fetch --dry-run'))).toBe(true);
  expect(result.commandOrder).toContain('pack-refs --all');
  expect(result.commandOrder).toContain('repack --geometric=2 -d --write-midx --keep-unreachable');
  expect(result.commandOrder).toContain('commit-graph write --reachable');
  expect(result.commandOrder).toContain('worktree prune');
  const packRefs = result.commandOrder.indexOf('pack-refs --all');
  const repack = result.commandOrder.indexOf('repack --geometric=2 -d --write-midx --keep-unreachable');
  expect(packRefs).toBeLessThan(repack);
  expect(result.commandOrder.indexOf('commit-graph write --reachable')).toBeGreaterThan(repack);
  expect(result.commandOrder.indexOf('worktree prune')).toBeGreaterThan(result.commandOrder.indexOf('commit-graph write --reachable'));
  expect(result.fakeBoundary).toContain('origin-fetch-dry-run');
  expect(result.fakeBoundary).toContain('atomic-ref-update');
});
