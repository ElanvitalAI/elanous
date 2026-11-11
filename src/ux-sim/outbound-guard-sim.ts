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
    const source = provenance?.source;
    const universe = provenance?.universe;
    if (source !== 'real' || !isUniverse(universe)) {
      const reason = source === 'real' ? 'provenance-incomplete' : 'source-not-real';
      observations.push({
        type: 'sim.leak-blocked',
        actionKind: action.kind,
        actionId: action.id,
        source: source ?? 'unknown',
        universe: isUniverse(universe) ? universe : 'unknown',
        reason,
        ...(provenance?.device ? { device: provenance.device } : {}),
        ...(provenance?.scenario ? { scenario: provenance.scenario } : {}),
      });
      return { allowed: false, actionId: action.id, reason };
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
