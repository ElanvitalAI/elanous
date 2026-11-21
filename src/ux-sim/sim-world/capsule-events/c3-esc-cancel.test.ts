import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simWorldScenarios } from './c3-esc-cancel.js';

test('seed 7: real Next TUI Esc leaves the long Bash capsule alive', async () => {
  const universeRoot = mkdtempSync(join(tmpdir(), 'c3-esc-sim-'));
  const events: Array<{ name: string; value: unknown }> = [];
  try {
    const scenario = simWorldScenarios[0]!;
    const outcome = await scenario.run({ world: 'capsule-events', scenarioId: scenario.id, seed: 7,
      engine: 'legacy', universeRoot, random: () => 0.7,
      recorder: { event: (name: string, value: unknown) => { events.push({ name, value }); } },
      device: () => { throw new Error('no device needed'); },
    } as never);
    expect(outcome).toEqual({ ok: true });
    expect(events.some(row => row.name === 'c3-esc')).toBe(true);
  } finally {
    rmSync(universeRoot, { recursive: true, force: true });
  }
}, 180_000);
