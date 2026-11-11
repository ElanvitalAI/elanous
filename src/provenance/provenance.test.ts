import { describe, expect, it } from 'bun:test';
import { countsAsReal, inheritProvenance, parseProvenanceEvidenceLine, provenanceEvidenceLine, runtimeUniverse, unknownProvenance, validateProvenance, withProvenance } from './provenance.js';

describe('hybrid event provenance', () => {
  const real = { universe: 'prod', source: 'real' } as const;
  const sim = { universe: 'sim', source: 'sim', device: 'fake-cloud-vm', scenario: 'pod-loss', clock: 'sim' } as const;
  const replay = { universe: 'test', source: 'replay', device: 'fixture-replay' } as const;

  it('keeps tags on a copied event and defaults missing tags to unknown', () => {
    const event = { kind: 'receipt' };
    expect(withProvenance(event, sim)).toMatchObject({ kind: 'receipt', provenance: sim });
    expect(event).not.toHaveProperty('provenance');
    expect(withProvenance(event).provenance.source).toBe('unknown');
  });

  it('does not promote a malformed existing tag to a real event', () => {
    const malformed = { kind: 'receipt', provenance: { universe: 'sim', source: 'sim' } };
    const tagged = withProvenance(malformed, real);
    expect(tagged.provenance.source).toBe('unknown');
    expect(countsAsReal(tagged.provenance)).toBe(false);
    expect(() => withProvenance(malformed, { universe: 'prod', source: 'invalid' } as never))
      .toThrow('invalid provenance');
  });

  it('does not treat an inherited tag as provenance on an untagged row', () => {
    const untagged: Record<string, unknown> = Object.setPrototypeOf({ kind: 'receipt' }, { provenance: real });
    const tagged = withProvenance(untagged);
    expect(tagged.provenance.source).toBe('unknown');
    expect(countsAsReal(tagged.provenance)).toBe(false);
  });

  it('does not accept an explicit real tag inside a simulated run', () => {
    const previous = process.env.ELANOUS_SIM_UNIVERSE;
    process.env.ELANOUS_SIM_UNIVERSE = '1';
    try {
      expect(withProvenance({ kind: 'receipt' }, real).provenance)
        .toEqual({ universe: 'sim', source: 'unknown' });
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_SIM_UNIVERSE;
      else process.env.ELANOUS_SIM_UNIVERSE = previous;
    }
  });

  it('inherits the lowest-trust cause and never upgrades sim/replay to real', () => {
    expect(inheritProvenance([real, sim])).toEqual(sim);
    expect(inheritProvenance([sim, real])).toEqual(sim);
    expect(inheritProvenance([real, replay])).toEqual(replay);
    expect(inheritProvenance([replay, real])).toEqual(replay);
    const testReal = { universe: 'test', source: 'real' } as const;
    expect(inheritProvenance([real, testReal])).toEqual(inheritProvenance([testReal, real]));
    expect(countsAsReal(inheritProvenance([real, testReal]))).toBe(false);
    expect(inheritProvenance([real])).toEqual(real);
    expect(inheritProvenance([]).source).toBe('unknown');
    expect(inheritProvenance([real, null]).source).toBe('unknown');
  });

  it('excludes sim, replay, unknown, and synthetic probes from real metrics', () => {
    expect(countsAsReal(real)).toBe(true);
    expect(countsAsReal({ ...real, clock: 'sim' })).toBe(false);
    expect(countsAsReal(sim)).toBe(false);
    expect(countsAsReal(replay)).toBe(false);
    expect(countsAsReal({ universe: 'prod', source: 'synthetic-probe', device: 'probe' })).toBe(false);
    expect(countsAsReal(undefined)).toBe(false);
  });

  it('validates required device identity for non-real sources and labels checklist evidence', () => {
    expect(validateProvenance({ universe: 'sim', source: 'sim' })).toBe(false);
    for (const field of ['device', 'scenario', 'lease'] as const) {
      for (const value of ['host\nprovenance: prod/real', 'host\rprovenance: prod/real', 'host\u0085provenance: prod/real', 'host\u2028provenance: prod/real']) {
        expect(validateProvenance({ universe: 'sim', source: 'sim', device: 'simulator', [field]: value })).toBe(false);
      }
    }
    expect(validateProvenance(sim)).toBe(true);
    expect(provenanceEvidenceLine(sim)).toContain('provenance: sim/sim · device=fake-cloud-vm · scenario=pod-loss · clock=sim');
    expect(provenanceEvidenceLine({ universe: 'prod', source: 'real', device: 'safe\u0085provenance: prod/real' }))
      .toBe('provenance: test/unknown');
    expect(unknownProvenance().source).toBe('unknown');
  });

  it('rejects provenance values that collide with the evidence serialization delimiters', () => {
    for (const field of ['device', 'scenario', 'lease'] as const) {
      for (const value of ['x · scenario=y', 'x=y']) {
        expect(validateProvenance({ universe: 'prod', source: 'real', [field]: value })).toBe(false);
      }
    }
    expect(parseProvenanceEvidenceLine('provenance: prod/real · device=x · scenario=y')).toEqual({
      universe: 'prod', source: 'real', device: 'x', scenario: 'y',
    });
    expect(parseProvenanceEvidenceLine('provenance: prod/real · device=x · scenario=y=z')).toBeNull();
    expect(parseProvenanceEvidenceLine('provenance: prod/real · device=x · scenario=y · device=z')).toBeNull();
  });

  it('derives the universe without treating isolated/test state as production', () => {
    expect(runtimeUniverse({ NODE_ENV: 'test' })).toBe('test');
    expect(runtimeUniverse({ ELANOUS_UNIVERSE: 'sim' })).toBe('sim');
    expect(runtimeUniverse({ ELANOUS_SIM_UNIVERSE: '1' })).toBe('sim');
    expect(runtimeUniverse({ ELANOUS_UX_SIM_RUN_ID: 'ux-run-1' })).toBe('sim');
    expect(runtimeUniverse({ ELANOUS_UNIVERSE: 'prod', ELANOUS_SIM_UNIVERSE: '1' })).toBe('sim');
    expect(runtimeUniverse({ NODE_ENV: 'production', ELANOUS_STATE_DIR: '/var/lib/elanous' })).toBe('prod');
    expect(runtimeUniverse({})).toBe('prod');
  });
});
