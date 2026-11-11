import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateStructuredDesign } from '../../graph-runner/architecture-output/structured-design.js';
import { buildTieredDesigns } from './tiered-design.js';

const fixture = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../plugins/gcp-architect-expand/demo/fixtures/advanced-requirement.json'), 'utf8'));

test('one classified requirement yields three distinct, costed offline designs', () => {
  const first = buildTieredDesigns(fixture);
  const second = buildTieredDesigns(fixture);
  expect(first).toEqual(second);
  expect(first.realGcpCalls).toBe(0);
  expect(first.plans.map(plan => plan.tier)).toEqual(['small', 'medium', 'large']);
  expect(first.plans.map(plan => plan.monthlySimUsd)).toEqual([...first.plans.map(plan => plan.monthlySimUsd)].sort((a, b) => a - b));
  expect(new Set(first.plans.map(plan => JSON.stringify(plan.design.nodes))).size).toBe(3);
  for (const plan of first.plans) {
    expect(plan.costStatus).toBe('synthetic-only');
    expect(plan.design.simulation).toMatchObject({ costStatus: 'synthetic-only', realGcpCalls: 0 });
    expect((plan.design.costs as Array<{ formula: string }>).every(row => row.formula.includes('sim'))).toBe(true);
    const nodes = plan.design.nodes as Array<{ id: string; zone: string; service: string }>;
    const flows = plan.design.flows as Array<{ from: string; to: string }>;
    expect(['app:events', 'events:worker', 'worker:delivery', 'delivery:users'].every(edge =>
      flows.some(flow => `${flow.from}:${flow.to}` === edge))).toBe(true);
    expect(nodes.filter(node => node.zone === 'vpc').every(node => node.service === 'GKE Standard')).toBe(true);
    const variables = (plan.design.simulation as { costVariables: Record<string, number> }).costVariables;
    expect(variables.simMonthHours).toBe(730); // Source: the simulator's documented synthetic billing-month constant.
    expect(variables.monthlyNotifications).toBe(fixture.traffic.monthlyNotifications);
  }
});

test('missing or nonfinite traffic and classification fail closed', () => {
  for (const invalid of [
    { ...fixture, traffic: { ...fixture.traffic, monthlyRequests: 0 } },
    { ...fixture, traffic: { ...fixture.traffic, logGib: Number.NaN } },
    { ...fixture, traffic: { ...fixture.traffic, targetLatencySeconds: 0 } },
    { ...fixture, dataClass: 'unknown' },
    { ...fixture, requirements: [] },
  ]) expect(() => buildTieredDesigns(invalid)).toThrow('explicit finite traffic assumptions');
});

test('rendered VPC boundary excludes managed project services', () => {
  for (const plan of buildTieredDesigns(fixture).plans) {
    const diagram = JSON.parse(generateStructuredDesign(plan.design).diagram) as {
      elements: Array<{ id: string; x: number; y: number; width: number; height: number }> };
    const boundary = diagram.elements.find(item => item.id === 'vpc-boundary')!;
    const externalRects = (plan.design.nodes as Array<{ id: string; zone: string }>).filter(node => node.zone === 'external')
      .map(node => diagram.elements.find(item => item.id === `node-${node.id}`)!);
    for (const [index, left] of externalRects.entries()) for (const right of externalRects.slice(index + 1))
      expect(left.x + left.width <= right.x || right.x + right.width <= left.x
        || left.y + left.height <= right.y || right.y + right.height <= left.y).toBe(true);
    for (const node of plan.design.nodes as Array<{ id: string; zone: string }>) {
      const shape = diagram.elements.find(item => item.id === `node-${node.id}`)!;
      const inside = shape.x >= boundary.x && shape.y >= boundary.y
        && shape.x + shape.width <= boundary.x + boundary.width
        && shape.y + shape.height <= boundary.y + boundary.height;
      expect(inside).toBe(node.zone === 'vpc');
    }
  }
});

test('higher CPU or memory demand at fixed concurrency increases synthetic capacity', () => {
  const baseline = buildTieredDesigns(fixture).plans;
  for (const trafficChange of [{ cpuSecondsPerRequest: 0.3 }, { memoryGibSecondsPerRequest: 0.6 }]) { // Source: synthetic stress probes exceed the fixture's per-request demand.
    const changed = buildTieredDesigns({ ...fixture, traffic: { ...fixture.traffic, ...trafficChange } }).plans;
    for (const index of [0, 1, 2]) { // Source: the three explicit capacity tiers.
      const before = (baseline[index]!.design.simulation as { costVariables: Record<string, number> }).costVariables;
      const after = (changed[index]!.design.simulation as { costVariables: Record<string, number> }).costVariables;
      expect(after.demandedVcpu >= before.demandedVcpu).toBe(true);
      expect(after.demandedGib >= before.demandedGib).toBe(true);
      const capacityKey = index === 2 ? 'gkeNodes' : index === 1 ? 'mediumInstances' : 'smallInstances';
      expect(after[capacityKey] > before[capacityKey]).toBe(true); // Source: stress probes increase CPU or memory demand at fixed concurrency.
    }
  }
});

test('overlong prose is rejected before fixed-format PDF generation', () => {
  expect(() => buildTieredDesigns({ ...fixture, summary: 'x'.repeat(201) })) // Source: one character beyond the documented 200-character summary budget.
    .toThrow('fixed-format PDF budget');
});
