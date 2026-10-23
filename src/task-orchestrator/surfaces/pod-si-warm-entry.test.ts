import { expect, test } from 'bun:test';
import { podSpawnWithSiWarm } from './pod-si-warm-entry.js';

test('the production warm entry is opt-in and preserves cold fallback on no-entry', async () => {
  for (const enabled of [false, true]) {
    let coldCalls = 0;
    const spawn = await podSpawnWithSiWarm({
      kubectl: () => { coldCalls++; throw new Error('cold transport reached'); },
    }, { ELANOUS_SI_WARM_REUSE: enabled ? '1' : '0' });
    try { await spawn({ feature: 'fixture', spaceId: `entry-${enabled}`, autoMerge: false }).done; }
    catch { /* The injected cold transport intentionally fails. */ }
    expect(coldCalls).toBeGreaterThan(0);
  }
});
