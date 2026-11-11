import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toArchitectureInput } from '../../../src/ux-sim/gcp-architect-expand/architecture-input.js';

test('GCP proposal maps to shared architecture data without a price claim', () => {
  const proposal = JSON.parse(readFileSync(join(import.meta.dir, '../../../plugins/gcp-architect-expand/sim/sample-output/proposal.json'), 'utf8'));
  const input = toArchitectureInput(proposal);
  expect(input.source.proposalId).toBe(proposal.id);
  expect(input.deployment.region).toBe('asia-northeast3');
  expect(input.diagram.flows).toEqual([]);
  expect(input.diagram.flowStatus).toBe('unconfirmed');
  expect(input.decisions).toEqual([]);
  expect(input.cost.formula).toBe(proposal.estimate.formula);
  expect(JSON.stringify(input)).not.toContain('가짜 프로젝트');
  expect(() => toArchitectureInput({ ...proposal, estimate: { ...proposal.estimate, price: 42 } })).toThrow('unpriced');
});

test('minimal proposal does not invent purchase, PII export, or Batch flows', () => {
  const proposal = { id: 'p-minimal', region: 'asia-northeast3', architecture: 'unknown',
    ticketDesign: { title: 'Image service', summary: 'Image transformation',
      localComponents: ['Image API'], exportData: '', offloadWorkload: '', assumptions: [
        { field: 'exportData', value: 'unconfirmed', source: 'adapter', requiresConfirmation: true },
      ] },
    security: { grade: 'internal' },
    estimate: { price: 'unpriced', formula: 'usage × official SKU' } };
  const input = toArchitectureInput(proposal);
  expect(input.diagram.flows).toEqual([]);
  expect(input.decisions).toEqual([]);
  expect(input.workload.assumptions).toEqual(proposal.ticketDesign.assumptions);
  expect(input.workload.assumptionStatus).toBe('unknown');
  expect(JSON.stringify(input)).not.toMatch(/구매|좌석|결제|비식별|Batch|staging/);
});

test('explicit proposal flows and decisions are projected unchanged', () => {
  const proposal = JSON.parse(readFileSync(join(import.meta.dir, '../../../plugins/gcp-architect-expand/sim/sample-output/proposal.json'), 'utf8'));
  proposal.diagram = { flows: ['Client → API'] };
  proposal.decisions = ['Image API stays local'];
  const input = toArchitectureInput(proposal);
  expect(input.diagram.flows).toEqual(['Client → API']);
  expect(input.diagram.flowStatus).toBe('provided');
  expect(input.decisions).toEqual(['Image API stays local']);
});
