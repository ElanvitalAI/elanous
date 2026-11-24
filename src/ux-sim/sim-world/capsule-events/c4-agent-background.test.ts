import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simWorldScenarios } from './c4-agent-background.js';

test('seed 7: real Next TUI serves urgent mail during a background Agent and later consumes its result', async () => {
  const universeRoot = mkdtempSync(join(tmpdir(), 'c4-agent-sim-'));
  const events: Array<{ name: string; value: unknown }> = [];
  try {
    const scenario = simWorldScenarios[0]!;
    const outcome = await scenario.run({ world: 'capsule-events', scenarioId: scenario.id, seed: 7,
      engine: 'legacy', universeRoot, random: () => 0.7,
      recorder: { event: (name: string, value: unknown) => { events.push({ name, value }); } },
      device: () => { throw new Error('no device needed'); },
    } as never);
    expect(outcome).toEqual({ ok: true });
    expect(events.some(row => row.name === 'c4-agent-mail')).toBe(true);
  } finally {
    rmSync(universeRoot, { recursive: true, force: true });
  }
}, 300_000); // 완료 깨움 대기 AGENT_HOLD_MS + 25s + idle ripen 120s(#39609) — #39881 C1 줄포리.
