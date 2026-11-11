import { describe, expect, test } from 'bun:test';
import { createFakeCloudBillingWorld } from './fake-cloud-billing-world.js';
import { createOutboundGuardSim, type OutboundGuardAction, type OutboundGuardProvenance } from './outbound-guard-sim.js';

// Source: the fake billing fixture admits its deterministic image-bake record.
const MONTHLY_BUDGET_KRW = 1_000;
// Source: the image-bake charge is a fixture used to prove the billing event reaches the guard.
const IMAGE_BAKE_COST_KRW = 100;
// Source: a successful fake image bake writes one local billing ledger row.
const ONE_LEDGER_EVENT = 1;
// Source: only the explicit real-source scenario reaches the injected fake sink.
const ONE_FAKE_SINK_CALL = 1;
// Source: blocked non-real provenance variants must make no calls to the fake sink.
const NO_FAKE_SINK_CALLS = 0;
// Source: this table covers every non-real provenance source named by the hybrid RFC, plus absent and incomplete tags.
const NON_REAL_PROVENANCES: Array<OutboundGuardProvenance | undefined> = [
  { universe: 'sim', source: 'sim', device: 'fake-cloud-billing-world', scenario: 'image-bake' },
  { universe: 'test', source: 'replay', device: 'fake-cloud-billing-world', scenario: 'replayed-image-bake' },
  { universe: 'test', source: 'injected', device: 'fake-cloud-billing-world', scenario: 'injected-image-bake' },
  { universe: 'prod', source: 'shadow', device: 'fake-cloud-billing-world', scenario: 'shadow-image-bake' },
  { universe: 'prod', source: 'synthetic-probe', device: 'fake-cloud-billing-world', scenario: 'probe-image-bake' },
  undefined,
  { source: 'real' },
];

function billingAction(): OutboundGuardAction {
  const billing = createFakeCloudBillingWorld({ monthlyBudgetKrw: MONTHLY_BUDGET_KRW });
  const baked = billing.bakeImage({
    imageId: 'outbound-guard-image',
    cutSha: 'cut-outbound-guard',
    roleTags: ['train-worker'],
    requiredAssets: ['agent'],
    bakedAssets: ['agent'],
    bakeCostKrw: IMAGE_BAKE_COST_KRW,
  });
  expect(baked.accepted).toBe(true);
  const [charge] = billing.snapshot().ledger;
  expect(charge).toBeDefined();
  if (!charge) throw new Error('fake billing charge missing');
  expect(billing.snapshot().ledger).toHaveLength(ONE_LEDGER_EVENT);
  return {
    kind: 'cloud-billing-charge',
    id: charge.id,
    payload: { costKind: charge.kind, amountKrw: charge.amountKrw },
  };
}

describe('outbound-guard-sim', () => {
  test('simulated fake-cloud billing is blocked and emits sim.leak-blocked', () => {
    const guard = createOutboundGuardSim();
    const sinkCalls: OutboundGuardAction[] = [];
    const action = billingAction();

    const decision = guard.attempt(
      { universe: 'sim', source: 'sim', device: 'fake-cloud-billing-world', scenario: 'image-bake' },
      action,
      outbound => sinkCalls.push(outbound),
    );

    expect(decision).toEqual({ allowed: false, actionId: action.id, reason: 'source-not-real' });
    expect(sinkCalls).toHaveLength(NO_FAKE_SINK_CALLS);
    expect(guard.observations()).toEqual([{
      type: 'sim.leak-blocked',
      actionKind: 'cloud-billing-charge',
      actionId: action.id,
      source: 'sim',
      universe: 'sim',
      reason: 'source-not-real',
      device: 'fake-cloud-billing-world',
      scenario: 'image-bake',
    }]);
  });

  test('real-source action reaches only the injected fake sink', () => {
    const guard = createOutboundGuardSim();
    const sinkCalls: OutboundGuardAction[] = [];
    const action = billingAction();

    const decision = guard.attempt(
      { universe: 'test', source: 'real' },
      action,
      outbound => sinkCalls.push(outbound),
    );

    expect(decision).toEqual({ allowed: true, actionId: action.id });
    expect(sinkCalls).toEqual([action]);
    expect(sinkCalls).toHaveLength(ONE_FAKE_SINK_CALL);
    expect(guard.observations()).toEqual([]);
  });

  test('real provenance with a missing or invalid universe fails closed', () => {
    const guard = createOutboundGuardSim();
    const sinkCalls: OutboundGuardAction[] = [];
    const action = billingAction();
    const invalidUniverse = { source: 'real', universe: 'production' } as unknown as OutboundGuardProvenance;
    const incomplete: OutboundGuardProvenance[] = [
      { source: 'real' },
      invalidUniverse,
    ];

    for (const provenance of incomplete) {
      expect(guard.attempt(provenance, action, outbound => sinkCalls.push(outbound))).toEqual({
        allowed: false,
        actionId: action.id,
        reason: 'provenance-incomplete',
      });
    }

    expect(sinkCalls).toHaveLength(NO_FAKE_SINK_CALLS);
    expect(guard.observations().map(observation => observation.universe)).toEqual(['unknown', 'unknown']);
  });

  test('replay, injected, shadow, synthetic, missing and incomplete provenance fail closed', () => {
    const guard = createOutboundGuardSim();
    const sinkCalls: OutboundGuardAction[] = [];
    const action = billingAction();

    for (const provenance of NON_REAL_PROVENANCES) {
      expect(guard.attempt(provenance, action, outbound => sinkCalls.push(outbound)).allowed).toBe(false);
    }

    expect(sinkCalls).toHaveLength(NO_FAKE_SINK_CALLS);
    expect(guard.observations().map(observation => observation.source)).toEqual([
      'sim', 'replay', 'injected', 'shadow', 'synthetic-probe', 'unknown', 'real',
    ]);
    expect(guard.observations().map(observation => observation.type)).toEqual(
      NON_REAL_PROVENANCES.map(() => 'sim.leak-blocked'),
    );
    expect(guard.observations().reverse().find(() => true)?.reason).toBe('provenance-incomplete');
  });
});
