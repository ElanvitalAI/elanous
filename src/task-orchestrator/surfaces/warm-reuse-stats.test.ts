import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerLogsCommands } from '../../cli/logs-cli.js';
import { runLogsWarmReuseStats } from '../../cli/logs-warm-reuse-stats.js';
import { debug } from '../../debug/log.js';
import { LogStore, StoreSink } from '../../mss/logging/log-store.js';
import { runWarmSiReuseSimulation } from '../../ux-sim/warm-si-reuse-sim.js';
import { readWarmReuseStats, summarizeWarmReuseStats } from './warm-reuse-stats.js';

test('POD-REUSE-OBSERVE reads SI reuse and quarantine outcomes from simulated production logs', async () => {
  const root = mkdtempSync(join(tmpdir(), `warm-reuse-stats-${randomUUID()}-`));
  mkdirSync(join(root, 'logs'), { recursive: true });
  const store = new LogStore(join(root, 'logs', 'logs.db'), { instance: 'test:warm-reuse-stats' });
  const sink = new StoreSink(store, 'ux-sim:warm-reuse-stats', { installExitHandlers: false });
  const unregister = debug.registerSink(sink);
  const previousDiagEnabled = debug.isDiagEnabled();
  debug.setDiagEnabled(true);
  try {
    const clean = await runWarmSiReuseSimulation({ runId: `observe-clean-${randomUUID()}` });
    const residue = await runWarmSiReuseSimulation({ runId: `observe-residue-${randomUUID()}`, processResidue: 1 });
    expect(clean.cleanupOutcomes).toEqual(['returned', 'returned']);
    expect(residue.cleanupOutcomes).toEqual(['quarantined']);
    sink.flush();

    const expected = { observedLeases: 3, returned: 2, quarantined: 1,
      unresolved: 0, cleanupFailureLeases: 1, quarantineFailureLeases: 0,
      unidentifiableEvents: 0, quarantineReasons: { 'child-processes-remain': 1 } };
    expect(readWarmReuseStats(store)).toEqual(expected);
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = runLogsWarmReuseStats({ instance: 'test:warm-reuse-stats', json: true }, {
      exists: path => path === store.path,
      openReadOnly: path => LogStore.openReadOnly(path),
      resolveTargets: () => ({ targets: [{ name: 'test:warm-reuse-stats', dbPath: store.path }] }),
      write: line => output.push(line), writeError: line => errors.push(line),
    });
    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0]!)).toMatchObject({ type: 'pod-reuse-stats', complete: true,
      results: [{ target: 'test:warm-reuse-stats', stats: expected }] });
  } finally {
    debug.setDiagEnabled(previousDiagEnabled);
    unregister();
    sink.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('POD-REUSE-OBSERVE is discoverable as an eln logs subcommand', () => {
  const root = new Command();
  registerLogsCommands(root);
  const logs = root.commands.find(command => command.name() === 'logs');
  expect(logs?.commands.some(command => command.name() === 'warm-reuse-stats')).toBe(true);
});

test('POD-REUSE-OBSERVE de-duplicates identical sink rows and fails closed on conflicting outcomes', () => {
  const lease = { workerId: 'worker-1', podUid: 'pod-1', leaseId: 'lease-1', generation: 1 };
  const returned = JSON.stringify({ ...lease, outcome: 'returned' });
  const quarantined = JSON.stringify({ ...lease, outcome: 'quarantined', reason: 'simulated-residue' });
  expect(summarizeWarmReuseStats([
    { event: 'return-decision', data: returned },
    { event: 'return-decision', data: returned },
  ])).toMatchObject({ observedLeases: 1, returned: 1, quarantined: 0, unresolved: 0 });
  expect(summarizeWarmReuseStats([
    { event: 'return-decision', data: returned },
    { event: 'return-decision', data: quarantined },
    { event: 'clean-failed', data: 'not-json' },
  ])).toMatchObject({ observedLeases: 1, returned: 0, quarantined: 0,
    unresolved: 1, unidentifiableEvents: 1, quarantineReasons: {} });
});
