// SIM-RETRY-PER-BUILD ⊕ SIM-SCENES-OWN-DIFF — the per-build retry key · the collector's own-diff scene filter · the two sim
// world scenes (5 seeds · legacy + graph). Expectations are literals (rule 11).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simWorldScenarios as scenes } from '../ux-sim/sim-world/supervisors/sim-retry-own-scenes.js';
import type { SimWorldScenarioContext } from '../ux-sim/sim-world/types.js';
import { selfRunKey } from '../kit/requirement-judge/sim-run.js';
import { collectPrFacts } from './collector.js';

const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `sim-retry-${tag}-`));

describe('self-run retry key per build', () => {
  test('build sha12 in the key · no build = the old key', () => {
    expect(selfRunKey('sim-run', 'LAND10-FINISHER-WAIT', 'a5a6444abaa0123456789')).toBe('sim-run:LAND10-FINISHER-WAIT@a5a6444abaa0');
    expect(selfRunKey('e4', 'C', null)).toBe('e4:C');
    expect(selfRunKey('e4', 'C')).toBe('e4:C');
  });
});

describe('collector: body scenes ∩ PR-own change', () => {
  const H = 'ab'.repeat(20);
  const body = '칸: C\n\n| 장면 | 기대 |\n|---|---|\n| JB-CRIT-EMPTY | 초록 |\n\n옆 PR: JB-DECLARED 영수 없음';
  const deps = (ownChange?: (pr: number, head: string) => string | null) => ({
    merged: new Map([[7, 'f'.repeat(40)]]), landedHead: () => H, cacheDir: tmp('cache'),
    prMeta: () => ({ head: H, files: ['x.ts'], title: 't', body, headRef: 'b' }), receipt: () => null, security: () => [],
    ...(ownChange ? { ownChange } : {}),
  });
  test('only the scenes the own change names · unreadable own change keeps the body · no port keeps the body', () => {
    let calls = 0;
    const d = deps(() => { calls++; return '+  - { id: JB-CRIT-EMPTY, module: x.ts }'; });
    expect(collectPrFacts([7], d).get(7)!.scenes).toEqual(['JB-CRIT-EMPTY']);
    expect(collectPrFacts([7], d).get(7)!.scenes).toEqual(['JB-CRIT-EMPTY']); // cached on the meta row
    expect(calls).toBe(1);
    expect(collectPrFacts([7], deps(() => null)).get(7)!.scenes).toEqual(['JB-CRIT-EMPTY', 'JB-DECLARED']);
    expect(collectPrFacts([7], deps()).get(7)!.scenes).toEqual(['JB-CRIT-EMPTY', 'JB-DECLARED']);
    expect(collectPrFacts([7], deps(() => '+export const KEY = 1;')).get(7)!.scenes).toBeUndefined();
  });
});

describe('sim world — supervisors SIM-RETRY-PER-BUILD · SIM-SCENES-OWN-DIFF (5 seeds · legacy + graph)', () => {
  const ids = ['SUP-EXEC-BUTLER-RETRY-BUILD', 'JB-SIM-SCENES-OWN-DIFF'];
  const ctxOf = (id: string, engine: 'legacy' | 'graph', events: Array<{ kind: string; data: unknown }>): SimWorldScenarioContext => ({
    world: 'supervisors', scenarioId: id, seed: 1, engine, universeRoot: tmp(`${id}-${engine}`),
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    random: () => 0.5, device: () => { throw new Error('no device'); },
  }) as unknown as SimWorldScenarioContext;
  test('scenes registered', () => { expect(scenes.map(s => s.id)).toEqual(ids); });
  for (const id of ids) for (const engine of ['legacy', 'graph'] as const) {
    test(`${id} · ${engine}`, async () => {
      const events: Array<{ kind: string; data: unknown }> = [];
      expect(await scenes.find(s => s.id === id)!.run(ctxOf(id, engine, events))).toEqual({ ok: true });
      expect(events.filter(e => e.kind === 'sim-retry:scene').length).toBe(1);
      expect(events.filter(e => e.kind.startsWith('sim-retry:') && e.kind !== 'sim-retry:scene').length).toBe(5);
    }, 60_000);
  }
});
