/** Source tags for events that cross simulation, replay, and real boundaries.
 * Missing or malformed tags are deliberately represented as unknown, never real. */
export type ProvenanceUniverse = 'prod' | 'test' | 'sim';
export type ProvenanceSource = 'real' | 'sim' | 'replay' | 'injected' | 'shadow' | 'synthetic-probe' | 'unknown';

export interface Provenance {
  readonly universe: ProvenanceUniverse;
  readonly source: ProvenanceSource;
  readonly device?: string;
  readonly scenario?: string;
  readonly lease?: string;
  readonly clock?: 'real' | 'sim';
}

const SOURCES = new Set<ProvenanceSource>(['real', 'sim', 'replay', 'injected', 'shadow', 'synthetic-probe', 'unknown']);

export function runtimeUniverse(env: NodeJS.ProcessEnv = process.env): ProvenanceUniverse {
  // The LLM selection boundary uses these simulator markers too. A sim run
  // must stay sim even if an inherited environment claims prod.
  if (env.ELANOUS_UNIVERSE === 'sim' || env.ELANOUS_SIM_UNIVERSE === '1' || env.ELANOUS_UX_SIM_RUN_ID) return 'sim';
  if (env.ELANOUS_UNIVERSE === 'test' || env.NODE_ENV === 'test') return 'test';
  return 'prod';
}

export function unknownProvenance(universe: ProvenanceUniverse = runtimeUniverse()): Provenance {
  return Object.freeze({ universe, source: 'unknown' });
}

export function validateProvenance(value: unknown): value is Provenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (!['prod', 'test', 'sim'].includes(String(p.universe)) || !SOURCES.has(p.source as ProvenanceSource)) return false;
  for (const field of ['device', 'scenario', 'lease'] as const) {
    if (p[field] !== undefined && (typeof p[field] !== 'string' || !(p[field] as string).trim()
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029·=]/.test(p[field] as string))) return false;
  }
  if (p.clock !== undefined && p.clock !== 'real' && p.clock !== 'sim') return false;
  if (p.source !== 'real' && p.source !== 'unknown' && !p.device) return false;
  return true;
}

/** Lower-trust causes dominate. A derived event can never promote a sim/unknown
 * cause to real; empty or malformed cause lists fail closed to unknown. */
export function inheritProvenance(causes: readonly unknown[]): Provenance {
  if (causes.length === 0 || causes.some(cause => !validateProvenance(cause))) return unknownProvenance();
  const values = (causes as readonly Provenance[]).map((p) =>
    p.universe !== 'prod' && p.source === 'real' ? { ...p, source: 'unknown' as const } : p);
  const nonReal = values.filter((p) => !countsAsReal(p));
  if (nonReal.length === 0) return Object.freeze({ ...values[0]! });
  const rank: Record<ProvenanceSource, number> = {
    unknown: 0,
    sim: 1,
    replay: 2,
    injected: 2,
    shadow: 2,
    'synthetic-probe': 2,
    real: 3,
  };
  const stableKey = (p: Provenance) => JSON.stringify([
    p.universe, p.source, p.device ?? '', p.scenario ?? '', p.lease ?? '', p.clock ?? '',
  ]);
  nonReal.sort((a, b) => rank[a.source] - rank[b.source] || stableKey(a).localeCompare(stableKey(b)));
  return Object.freeze({ ...nonReal[0]! });
}

/** Attach provenance without mutating the caller's event. Existing tags are kept
 * unless an explicit replacement is requested by the producer. */
export function withProvenance<T extends Record<string, unknown>>(value: T, provenance?: Provenance): T & { provenance: Provenance } {
  if (provenance !== undefined && !validateProvenance(provenance)) throw new Error('invalid provenance');
  const hasExisting = Object.hasOwn(value, 'provenance');
  const existing = hasExisting ? value.provenance : undefined;
  // A malformed tag is evidence of an unknown origin, even when a caller
  // supplies a new tag. Do not let replacement turn that row into prod/real.
  const selected = hasExisting && !validateProvenance(existing)
    ? unknownProvenance()
    : provenance ?? (validateProvenance(existing) ? existing : unknownProvenance());
  if (provenance && validateProvenance(existing) && JSON.stringify(existing) !== JSON.stringify(provenance)) {
    throw new Error('provenance is immutable once assigned');
  }
  if (!validateProvenance(selected)) throw new Error('invalid provenance');
  const safe = runtimeUniverse() === 'sim' && selected.universe === 'prod' && selected.source === 'real'
    ? unknownProvenance('sim')
    : selected;
  return { ...value, provenance: Object.freeze({ ...safe }) } as T & { provenance: Provenance };
}

/** Only production real-boundary events qualify for real-world metrics/alerts. */
export function countsAsReal(value: unknown): boolean {
  return validateProvenance(value) && value.universe === 'prod' && value.source === 'real' && value.clock !== 'sim';
}

/** Append a compact, machine-readable tag to free-form checklist evidence. */
export function provenanceEvidenceLine(value: unknown): string {
  const p = validateProvenance(value) ? value : unknownProvenance();
  return `provenance: ${p.universe}/${p.source}${p.device ? ` · device=${p.device}` : ''}${p.scenario ? ` · scenario=${p.scenario}` : ''}${p.lease ? ` · lease=${p.lease}` : ''}${p.clock ? ` · clock=${p.clock}` : ''}`;
}

/** Parse only the canonical evidence representation; never trust free-form tags. */
export function parseProvenanceEvidenceLine(line: string): Provenance | null {
  const match = /^provenance: (prod|test|sim)\/(real|sim|replay|injected|shadow|synthetic-probe|unknown)(?: · device=([^·=\r\n]+))?(?: · scenario=([^·=\r\n]+))?(?: · lease=([^·=\r\n]+))?(?: · clock=(real|sim))?$/.exec(line);
  if (!match) return null;
  const value: Provenance = {
    universe: match[1] as ProvenanceUniverse,
    source: match[2] as ProvenanceSource,
    ...(match[3] !== undefined ? { device: match[3] } : {}),
    ...(match[4] !== undefined ? { scenario: match[4] } : {}),
    ...(match[5] !== undefined ? { lease: match[5] } : {}),
    ...(match[6] !== undefined ? { clock: match[6] as 'real' | 'sim' } : {}),
  };
  return validateProvenance(value) && provenanceEvidenceLine(value) === line ? value : null;
}
