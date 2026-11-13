import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ticketDesignFromArchitectureJson } from '../../../../scripts/gcp-architect-expand/demo/design-result.js';

const fixture = JSON.parse(readFileSync(join(import.meta.dir, '../../../../plugins/gcp-architect-expand/demo/fixtures/ticketing-design.json'), 'utf8'));

test('general architect JSON and graph-run output retain their source trace', () => {
  const structured = fixture.designResult;
  const wrapped = { source: { sessionId: 'test-session' }, runId: 'test-graph-run', ticketDesign: structured };
  const design = ticketDesignFromArchitectureJson(wrapped);
  expect(design).toMatchObject({ title: structured.title, sourceKind: 'structured-architecture-design-json',
    sourceSessionId: 'test-session', sourceGraphRunId: 'test-graph-run' });
  expect(design.assumptions).toHaveLength(10);
  const graph = { runId: 'test-graph-run', nodes: [{ nodeId: 'design', output: JSON.stringify({ result: { ticketDesign: structured } }) }] };
  expect(ticketDesignFromArchitectureJson(graph).title).toBe(structured.title);
});

test('Solar structured design without offload fields receives visible unconfirmed assumptions', () => {
  const minimal = { source: { sessionId: 'test-solar-source' }, runId: 'test-solar-graph',
    design: { title: '공연 티켓팅 시스템', summary: '좌석 원장과 결제 경로를 설계한다',
      requirements: ['좌석 중복 확정 방지', '결제 상태 복구', '공정한 대기열'],
      components: ['구매 API', '좌석 재고', '결제 서비스'] } };
  const design = ticketDesignFromArchitectureJson(minimal);
  expect(design.offloadKind).toBe('batch');
  expect(design.containsPii).toBe(false);
  expect(design.retryable).toBe(true);
  expect(design.dataClass).toBe('internal');
  expect(design.assumptions.map(item => item.field)).toContain('containsPii');
  expect(design.assumptions.every(item => item.source === 'gcp-adapter-default' && item.requiresConfirmation)).toBe(true);
  expect(design.sourceSessionId).toBe('test-solar-source');
  expect(design.sourceGraphRunId).toBe('test-solar-graph');
});

test('general architect schema v1 maps requirement statements and local diagram nodes', () => {
  const source = { schemaVersion: 1, title: 'Concert ticketing architecture',
    summary: '공정한 대기열, 좌석 원장과 결제 복구 설계',
    requirements: [
      { id: 'R1', statement: '공정한 대기열' },
      { id: 'R2', statement: '좌석 중복 예약 방지' },
      { id: 'R3', statement: '결제 실패 복구' },
    ],
    nodes: [
      { id: 'fans', label: 'Fans', layer: 'users', zone: 'external' },
      { id: 'booking', label: 'Booking API', layer: 'application', zone: 'vpc' },
      { id: 'ledger', label: 'Seat ledger', layer: 'data', zone: 'vpc' },
      { id: 'observe', label: 'Telemetry', layer: 'observability', zone: 'vpc' },
    ] };
  const design = ticketDesignFromArchitectureJson(source);
  expect(design.requirements).toEqual(['공정한 대기열', '좌석 중복 예약 방지', '결제 실패 복구']);
  expect(design.localComponents).toEqual(['Booking API', 'Seat ledger', 'Telemetry']);
  expect(design.assumptions).toHaveLength(10);
});

test('explicit unsafe or ambiguous design values and prose-only Graph output fail closed', () => {
  expect(() => ticketDesignFromArchitectureJson({ ticketDesign: fixture.designResult, inputSha256: 'output-only', estimate: {} }))
    .toThrow('GCP proposal output cannot be used as Scene 4 design input');
  expect(() => ticketDesignFromArchitectureJson({ nodes: [{ nodeId: 'design', output: 'prose only' }] }))
    .toThrow('not structured JSON');
  for (const patch of [{ containsPii: true }, { containsPii: 'false' }, { retryable: 'true' },
    { checkpointable: 1 }, { dataClass: 'confidential' }, { usage: { vcpuHours: 0, gibHours: 8 } }]) {
    expect(() => ticketDesignFromArchitectureJson({ ticketDesign: { ...fixture.designResult, ...patch } })).toThrow('explicit design value conflicts');
  }
});
