import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDirectoryScope } from '../test-utils/temp-dir-cleanup.js';

export type TempCleanupScenario = {
  outcome: 'pass' | 'throw-after-create';
  prefixes?: string[];
};

export type TempCleanupSimulation = {
  outcome: TempCleanupScenario['outcome'];
  trackedDirectories: number;
  remainingOwnedDirectories: string[];
  unownedDirectoryPreserved: boolean;
  fixtureContents: string[];
};

export type TempCleanupIntegrationRun = {
  exitCode: number | null;
  taskOwnedLeftovers: string[];
  unownedDirectoryPreserved: boolean;
  suiteSummary: string;
};

/** Run the real leaking suite in a child Bun process and make residue a failing result. */
export function runTaskCleanupIntegration(options: { disableCleanup?: boolean } = {}): TempCleanupIntegrationRun {
  const isolatedTmp = mkdtempSync(join(tmpdir(), 'tmp-dir-leak-integration-'));
  const unownedDirectory = join(isolatedTmp, 'unowned-sentinel');
  mkdirSync(unownedDirectory);
  try {
    const child = spawnSync(process.execPath, ['test', '--reporter=dot', 'src/task-agent/card-evidence.test.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TMPDIR: isolatedTmp,
        ...(options.disableCleanup ? { ELANOUS_TEST_DISABLE_TEMP_DIR_CLEANUP: '1' } : {}),
      },
      encoding: 'utf8',
      timeout: 60000,
    });
    const prefixes = ['task-card-evidence-', 'task-card-ledger-', 'task-wiring-ledger-'];
    const taskOwnedLeftovers = readdirSync(isolatedTmp).filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
    const unownedDirectoryPreserved = existsSync(unownedDirectory);
    const suiteSummary = [child.stdout ?? '', child.stderr ?? ''].join('\n').split('\n')
      .filter((line) => /\d+ pass|\d+ fail|Ran \d+ tests/.test(line)).join(' | ');
    return {
      exitCode: child.status === 0 && taskOwnedLeftovers.length === 0 && unownedDirectoryPreserved ? 0 : 1,
      taskOwnedLeftovers,
      unownedDirectoryPreserved,
      suiteSummary,
    };
  } finally {
    rmSync(isolatedTmp, { recursive: true, force: true });
  }
}

/**
 * Exercise the same tracked-temp-root lifecycle used by task-agent test suites.
 * The independent directory models unrelated host state and must survive cleanup.
 */
export function simulateTempCleanup(scenario: TempCleanupScenario): TempCleanupSimulation {
  const prefixes = scenario.prefixes ?? ['task-hand-', 'ta-live-', 'task-card-evidence-'];
  const unownedDirectory = mkdtempSync(join(tmpdir(), 'unowned-temp-fixture-'));
  const ownedDirectories: string[] = [];
  let trackedDirectories = 0;
  let fixtureContents: string[] = [];
  const scope = createTempDirectoryScope();

  try {
    try {
      for (const prefix of prefixes) {
        const directory = scope.mkdtempSync(join(tmpdir(), prefix));
        ownedDirectories.push(directory);
        mkdirSync(join(directory, 'nested'), { recursive: true });
        writeFileSync(join(directory, 'nested', 'artifact.txt'), prefix);
      }
      fixtureContents = ownedDirectories.map((directory) => readFileSync(join(directory, 'nested', 'artifact.txt'), 'utf8'));

      if (scenario.outcome === 'throw-after-create') {
        throw new Error('simulated test failure after temporary artifacts were created');
      }
    } catch (error) {
      if (scenario.outcome !== 'throw-after-create') throw error;
    } finally {
      trackedDirectories = scope.cleanup().tracked;
    }

    const remainingOwnedDirectories = ownedDirectories.filter(existsSync);
    const unownedDirectoryPreserved = existsSync(unownedDirectory);
    return { outcome: scenario.outcome, trackedDirectories, remainingOwnedDirectories, unownedDirectoryPreserved, fixtureContents };
  } finally {
    rmSync(unownedDirectory, { recursive: true, force: true });
  }
}
