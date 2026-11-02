import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResourceLedgerContent } from './ResourceLedgerView';
import type { OpsResult, ResourceLedger } from '@/lib/ops-api';

function render(errors: string[]): string {
  const data: ResourceLedger = { observedAt: '2026-11-02T00:00:00.000Z', readStatus: 'ok', matrix: [], leases: [], findings: [],
    measurements: [{ host: 'gcp2', observedAt: '2026-11-02T00:00:00.000Z', pods: [], processes: [], errors }] };
  const result: OpsResult<ResourceLedger> = { kind: 'ready', data };
  return renderToStaticMarkup(<ResourceLedgerContent result={result} refreshedAt={null} />);
}

test('empty resource measurements separate collection failure from an observed zero count', () => {
  const failed = render(['kubectl: pod-list-unavailable', 'ps: permission denied']);
  expect(failed).toContain('Pod 관측 미측정');
  expect(failed).toContain('프로세스 관측 미측정');
  expect(failed).not.toContain('관측 Pod 없음');
  expect(failed).not.toContain('관측 프로세스 없음');

  const measuredEmpty = render([]);
  expect(measuredEmpty).toContain('관측 Pod 없음');
  expect(measuredEmpty).toContain('관측 프로세스 없음');
});
