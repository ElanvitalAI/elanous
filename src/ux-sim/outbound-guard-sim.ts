export type OutboundGuardSource =
  | 'real'
  | 'sim'
  | 'replay'
  | 'injected'
  | 'shadow'
  | 'synthetic-probe';

export type OutboundGuardUniverse = 'prod' | 'test' | 'sim';

export interface OutboundGuardProvenance {
  readonly universe?: OutboundGuardUniverse;
  readonly source?: OutboundGuardSource;
  readonly device?: string;
  readonly scenario?: string;
  readonly causedBy?: readonly (OutboundGuardProvenance | undefined)[];
}

export interface OutboundGuardAction {
  readonly kind: string;
  readonly id: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface OutboundGuardObservation {
  readonly type: 'sim.leak-blocked';
  readonly actionKind: string;
  readonly actionId: string;
  readonly source: OutboundGuardSource | 'unknown';
  readonly universe: OutboundGuardUniverse | 'unknown';
  readonly reason: 'source-not-real' | 'provenance-incomplete';
  readonly device?: string;
  readonly scenario?: string;
}

export type OutboundGuardDecision =
  | { readonly allowed: true; readonly actionId: string }
  | { readonly allowed: false; readonly actionId: string; readonly reason: OutboundGuardObservation['reason'] };

function isUniverse(value: unknown): value is OutboundGuardUniverse {
  return value === 'prod' || value === 'test' || value === 'sim';
}

interface ProvenanceFailure {
  readonly reason: OutboundGuardObservation['reason'];
  readonly source: OutboundGuardObservation['source'];
  readonly universe: OutboundGuardObservation['universe'];
  readonly device?: string;
  readonly scenario?: string;
}

function provenanceFailure(
  provenance: OutboundGuardProvenance | undefined,
  seen = new Set<OutboundGuardProvenance>(),
): ProvenanceFailure | undefined {
  if (!provenance || seen.has(provenance)) {
    return { reason: 'provenance-incomplete', source: provenance?.source ?? 'unknown', universe: 'unknown' };
  }
  seen.add(provenance);
  const source = provenance.source;
  const universe = provenance.universe;
  if (source !== 'real') {
    return {
      reason: 'source-not-real',
      source: source ?? 'unknown',
      universe: isUniverse(universe) ? universe : 'unknown',
      ...(provenance.device ? { device: provenance.device } : {}),
      ...(provenance.scenario ? { scenario: provenance.scenario } : {}),
    };
  }
  if (!isUniverse(universe) || (provenance.causedBy !== undefined && !Array.isArray(provenance.causedBy))) {
    return { reason: 'provenance-incomplete', source: 'real', universe: isUniverse(universe) ? universe : 'unknown' };
  }
  for (const cause of provenance.causedBy ?? []) {
    const causeFailure = provenanceFailure(cause, seen);
    if (causeFailure) return causeFailure;
  }
  seen.delete(provenance);
  return undefined;
}

/**
 * Deterministic I2 contract device. The sink is always supplied by the caller,
 * so simulation can prove routing without opening a real external boundary.
 */
export function createOutboundGuardSim() {
  const observations: OutboundGuardObservation[] = [];

  function attempt(
    provenance: OutboundGuardProvenance | undefined,
    action: OutboundGuardAction,
    sink: (action: OutboundGuardAction) => void,
  ): OutboundGuardDecision {
    const failure = provenanceFailure(provenance);
    if (failure) {
      observations.push({
        type: 'sim.leak-blocked',
        actionKind: action.kind,
        actionId: action.id,
        ...failure,
      });
      return { allowed: false, actionId: action.id, reason: failure.reason };
    }

    sink(action);
    return { allowed: true, actionId: action.id };
  }

  return {
    attempt,
    observations(): OutboundGuardObservation[] {
      return observations.map(observation => ({ ...observation }));
    },
  };
}
