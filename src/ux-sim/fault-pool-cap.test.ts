import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { poolCapSweep, renderPoolCap, simPoolCap } from './fault-pool-cap.js';

describe('simPoolCap — 결함 주입 «풀 상한 없음»', () => {
  test('an uncapped spec admits two and then stops with limitedBy=pool-cap (not the generic capacity)', () => {
    expect(simPoolCap({ spec: 'pool-node-b@node-b', running: { 'pool-node-b': 0 } }).recommendation).toMatchObject({ recommended: 2, limitedBy: 'capacity' });
    const full = simPoolCap({ spec: 'pool-node-b@node-b', running: { 'pool-node-b': 2 } });
    expect(full.members[0]).toMatchObject({ capacity: 2, capacityDefaulted: true });
    expect(full.recommendation).toMatchObject({ recommended: 0, limitedBy: 'pool-cap' });
  });

  test('control: a declared cap that is full says capacity, and admits while it has room', () => {
    expect(simPoolCap({ spec: 'pool-node-b@node-b:20', running: { 'pool-node-b': 2 } }).recommendation).toMatchObject({ recommended: 18, limitedBy: 'capacity' });
    expect(simPoolCap({ spec: 'pool-node-b@node-b:20', running: { 'pool-node-b': 20 } }).recommendation).toMatchObject({ recommended: 0, limitedBy: 'capacity' });
  });

  test('a mixed pool names pool-cap when the uncapped member is the full one', () => {
    const obs = simPoolCap({ spec: 'pool-node-b@node-b:20,pool-node-c@node-c', running: { 'pool-node-b': 20, 'pool-node-c': 2 } });
    expect(obs.members.map((m) => m.capacityDefaulted)).toEqual([false, true]);
    expect(obs.recommendation).toMatchObject({ recommended: 0, limitedBy: 'pool-cap' });
    expect(simPoolCap({ spec: 'pool-node-b@node-b:20,pool-node-c@node-c', running: { 'pool-node-b': 20, 'pool-node-c': 0 } }).recommendation.recommended).toBe(2);
  });

  test('a member without a Running count is refused, never read as zero', () => {
    expect(() => simPoolCap({ spec: 'pool-node-b@node-b:20,pool-node-c@node-c', running: { 'pool-node-b': 20 } })).toThrow('pool-node-c');
  });

  test('the sweep renders one line per scenario with the default-cap marker', () => {
    const lines = renderPoolCap(poolCapSweep());
    expect(lines).toHaveLength(1 + poolCapSweep().length);
    expect(lines.some((l) => l.includes('2/2(기본)') && l.includes('limitedBy=pool-cap'))).toBe(true);
  });

  test('CLI wiring: `ux-sim --fault pool-cap` prints the sweep, an unknown fault exits 2', () => {
    const script = join(import.meta.dir, '..', '..', 'scripts', 'ux-sim.ts');
    const ok = spawnSync(process.execPath, [script, '--fault', 'pool-cap'], { encoding: 'utf8', timeout: 90_000 });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('limitedBy=pool-cap');
    const bad = spawnSync(process.execPath, [script, '--fault', 'no-such-fault'], { encoding: 'utf8', timeout: 90_000 });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('pool-cap');
  }, 120_000);
});
