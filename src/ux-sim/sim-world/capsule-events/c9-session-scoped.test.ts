import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simWorldScenarios } from './c9-session-scoped.js';

test('C9: two concurrent seat sessions each drain only their own capsule completion; an idle seat sees a supplement', async () => {
  const universeRoot = mkdtempSync(join(tmpdir(), 'c9-session-scoped-'));
  const events: Array<{ name: string; value: unknown }> = [];
  try {
    const scenario = simWorldScenarios[0]!;
    expect(scenario.id).toBe('C9-SESSION-SCOPED');
    const outcome = await scenario.run({ world: 'capsule-events', scenarioId: scenario.id, seed: 7,
      engine: 'legacy', universeRoot, random: () => 0.7,
      recorder: { event: (name: string, value: unknown) => { events.push({ name, value }); } },
      device: () => { throw new Error('no device needed'); },
    } as never);
    expect(outcome).toEqual({ ok: true });
    expect(events).toEqual([{ name: 'c9-session-scoped', value: {
      a: ['c9 capsule of seat A'], b: ['c9 capsule of seat B'],
      notices: ['agent c9 supplement · ok · 2s'], knocks: 0,
    } }]);
  } finally {
    rmSync(universeRoot, { recursive: true, force: true });
  }
}, 30_000);
