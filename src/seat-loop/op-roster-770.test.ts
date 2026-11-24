import { describe, expect, test } from 'bun:test';
import { createRosterWorld, syntheticRoster } from './op-roster-770.js';

describe('synthetic 770-cell roster', () => {
  test('matches the stated distribution and pages', async () => {
    const cells = syntheticRoster();
    expect(cells.length).toBe(770);
    expect(['P0', 'P1', 'P2'].map(p => cells.filter(c => c.priority === p).length)).toEqual([384, 267, 119]);
    expect(cells.filter(c => c.owner === null).length).toBe(40);
    const world = createRosterWorld();
    const page = await world.dispatch('RosterRead', { page: 8 }) as { items: unknown[] };
    expect(page.items.length).toBe(70);
  });

  test('privately scores the verified result without giving away the answer', async () => {
    const world = createRosterWorld();
    const ids = Array.from({ length: 60 }, (_, n) => `C${String(n + 51).padStart(4, '0')}`);
    await world.dispatch('RosterDecide', { ids: ['C0001', ...ids.slice(1)] });
    expect(await world.dispatch('RosterApply', {})).toEqual({ applied: 60, receipt: 'sim:roster:apply' });
    await world.dispatch('RosterVerify', {});
    expect(world.score()).toBe(false);
    await world.dispatch('RosterDecide', { ids });
    await world.dispatch('RosterApply', {});
    expect(world.score()).toBe(false);
    await world.dispatch('RosterVerify', {});
    expect(world.score()).toBe(true);
    expect(world.snapshot().declaredReport).toBeNull();
    await world.dispatch('RosterHandoff', {});
    expect(world.snapshot().humanHandoffs).toBe(1);
  });
});
