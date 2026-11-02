import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResourceLedgerContent } from './ResourceLedgerView';
import type { OpsResult, ResourceGuardianSnapshot, ResourceLedger } from '@/lib/ops-api';

function render(errors: string[]): string {
  const data: ResourceLedger = { observedAt: '2026-11-02T00:00:00.000Z', readStatus: 'ok', matrix: [], leases: [], recentReclaims: [], findings: [],
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
  expect(measuredEmpty).toContain('원장에 기록된 종료·회수 사건이 없습니다.');
});


test('resource ledger view shows recorded lease reclaim reason and actor', () => {
  const data: ResourceLedger = { observedAt: '2026-11-02T00:00:00.000Z', readStatus: 'ok', matrix: [], leases: [],
    recentReclaims: [{ id: 'fp_reaped01', fp: 'fp_reaped01', host: 'gcp1', lane: 'ta', at: '2026-11-02T00:01:00.000Z',
      kind: 'lease-reaped', reason: 'expired-and-absent', stoppedBy: 'guardian-reconcile' }], findings: [],
    measurements: [{ host: 'gcp1', observedAt: '2026-11-02T00:00:00.000Z', pods: [], processes: [], errors: [] }] };
  const result: OpsResult<ResourceLedger> = { kind: 'ready', data };
  const html = renderToStaticMarkup(<ResourceLedgerContent result={result} refreshedAt={null} />);
  expect(html).toContain('최근 임대 종료·회수 · 1');
  expect(html).toContain('만료 회수');
  expect(html).toContain('expired-and-absent');
  expect(html).toContain('guardian-reconcile');
});


test('old Nexus API responses distinguish unsupported reclaim history from an empty ledger', () => {
  const data: ResourceLedger = { observedAt: '2026-11-02T00:00:00.000Z', readStatus: 'ok', matrix: [], leases: [], findings: [],
    measurements: [{ host: 'gcp1', observedAt: '2026-11-02T00:00:00.000Z', pods: [], processes: [], errors: [] }] };
  const result: OpsResult<ResourceLedger> = { kind: 'ready', data };
  const html = renderToStaticMarkup(<ResourceLedgerContent result={result} refreshedAt={null} />);
  expect(html).toContain('최근 임대 종료·회수 · 미지원');
  expect(html).toContain('현재 Nexus API가 임대 종료·회수 이력을 제공하지 않습니다.');
  expect(html).not.toContain('원장에 기록된 종료·회수 사건이 없습니다.');
});

test('resource ledger view renders the guardian reconciliation state and report-only finding', () => {
  const guardian: ResourceGuardianSnapshot = { state: 'stale', stale: true, observedAt: '2026-11-02T00:00:00.000Z',
    staleReason: 'mock collection failure', lastFailureAt: '2026-11-02T00:01:00.000Z',
    findings: [{ kind: 'orphan', host: 'aws2', id: 'fp_orphan01', detail: 'active train fingerprint has no lease', action: 'report-only' }],
    cleanup: { reaped: 0, skipped: 1, errors: 0 }, releaseReservation: { status: 'reserved', reason: 'active run' } };
  const html = renderToStaticMarkup(<ResourceLedgerContent result={null} guardianResult={{ kind: 'ready', data: guardian }} refreshedAt={null} />);
  expect(html).toContain('수호자 판단');
  expect(html).toContain('오래됨');
  expect(html).toContain('fp_orphan01');
  expect(html).toContain('건너뜀 1');
  expect(html).toContain('실패 ');
  expect(html).toContain('node-b release 예약: reserved · active run');
  expect(html).toContain('이 화면은 정리 작업을 실행하지 않습니다');

  const failed: ResourceGuardianSnapshot = { state: 'failed', stale: true, observedAt: null, staleReason: 'mock first tick failed',
    lastFailureAt: '2026-11-02T00:01:00.000Z', findings: [], cleanup: { reaped: 0, skipped: 0, errors: 0 } };
  const failedHtml = renderToStaticMarkup(<ResourceLedgerContent result={null} guardianResult={{ kind: 'ready', data: failed }} refreshedAt={null} />);
  expect(failedHtml).toContain('첫 대조 실패');
  expect(failedHtml).toContain('mock first tick failed');
});
