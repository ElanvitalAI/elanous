import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { debug } from '../debug/log.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import { decideWarmReuse } from '../task-orchestrator/surfaces/pod-warm-switch.js';
import { loadWarmReuseEvidenceByConsumer, readWarmReuseEvidence } from '../task-orchestrator/surfaces/warm-reuse-evidence.js';
import { runWarmPoolReuseSwitchSimulation } from './warm-pool-reuse-switch-sim.js';

test('POD-REUSE-SWITCH-LIVE-SIM: verified leases persist measured evidence and enable the TA switch', async () => {
  const root = join(tmpdir(), `warm-pool-reuse-evidence-${randomUUID()}`);
  const evidencePath = join(root, 'warm-reuse-evidence.jsonl');
  mkdirSync(join(root, 'logs'), { recursive: true });
  const store = new LogStore(join(root, 'logs', 'logs.db'), { instance: 'test:pod-reuse-switch-live-sim' });
  const sink = new StoreSink(store, 'ux-sim:pod-reuse-switch-live-sim', { installExitHandlers: false });
  const unregister = debug.registerSink(sink);
  try {
    const head = 'f'.repeat(40);
    const consumers = ['gate-recheck', 'land', 'ta'] as const;
    const config = { gateRecheck: true, land: true, ta: true, minMatchSamples: 2 };
    for (const consumer of consumers) {
      for (const sample of [1, 2]) {
        const result = await runWarmPoolReuseSwitchSimulation({ consumer,
          runId: `run-warm-pool-evidence-${consumer}-${sample}-${randomUUID()}`, head, main: head, evidencePath });
        expect(result).toMatchObject({ comparison: { reason: 'match' }, finalized: true,
          supplied: { leaseValid: true, canaryPassed: true, consecutiveMatchSamples: sample } });
        if (sample === 1) {
          const partial = loadWarmReuseEvidenceByConsumer({ head, main: head }, evidencePath);
          expect(decideWarmReuse(consumer, config, partial).live).toBe(false);
        }
      }
      expect(readWarmReuseEvidence(evidencePath, { consumer, head, main: head })).toHaveLength(2);
    }
    const supplied = loadWarmReuseEvidenceByConsumer({ head, main: head }, evidencePath);
    expect(supplied).toMatchObject(Object.fromEntries(['gate-recheck', 'land', 'ta'].map((consumer) =>
      [consumer, { leaseValid: true, canaryPassed: true, consecutiveMatchSamples: 2 }])));
    expect(consumers.map((consumer) => decideWarmReuse(consumer, config, supplied)))
      .toEqual(consumers.map((consumer) => ({ consumer, live: true, reason: 'live' })));

    sink.flush();
    const latest = new Map<string, boolean>();
    for (const row of store.query({ exactCategories: ['pod.warm'], events: ['evidence-supplied'] })) {
      if (typeof row.data !== 'string') continue;
      const evidence = JSON.parse(row.data) as { consumer: string; measured: boolean };
      if (!latest.has(evidence.consumer)) latest.set(evidence.consumer, evidence.measured);
    }
    expect([...latest.entries()].sort(([left], [right]) => left.localeCompare(right)))
      .toEqual(['gate-recheck', 'land', 'ta'].map((consumer) => [consumer, true]));
  } finally {
    sink.flush(); unregister(); sink.close(); store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
