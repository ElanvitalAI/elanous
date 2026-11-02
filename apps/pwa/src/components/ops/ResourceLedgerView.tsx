'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { getResourceGuardian, getResourceLedger, type OpsResult, type ResourceGuardianSnapshot, type ResourceLedger } from '@/lib/ops-api';

const quantity = (value: number | null, suffix = '') => value === null ? '미측정' : `${value.toLocaleString()}${suffix}`;
const bytes = (value: number | null) => value === null ? '미측정' : `${(value / 1024 / 1024).toFixed(0)} MiB`;

export function ResourceLedgerContent({ result, guardianResult = null, refreshedAt, onRefresh, loading = false }: {
  result: OpsResult<ResourceLedger> | null; guardianResult?: OpsResult<ResourceGuardianSnapshot> | null;
  refreshedAt: string | null; onRefresh?: () => void; loading?: boolean;
}): React.ReactNode {
  return <main className="mx-auto max-w-7xl space-y-6 p-6">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">자원 원장</h1><p className="mt-1 text-sm text-muted-foreground">호스트별 차선 임대와 kubectl·ps 실측 대조</p></div>
      <div className="flex items-center gap-3"><span className="text-sm text-muted-foreground">{refreshedAt ? `갱신 ${new Date(refreshedAt).toLocaleString()}` : '조회 전'}</span>
        {onRefresh && <button className="rounded border px-3 py-2 text-sm" onClick={onRefresh} disabled={loading}>{loading ? '조회 중…' : '새로고침'}</button>}</div>
    </header>
    <section className="rounded-lg border p-4" aria-label="수호자 자원 판단">
      <h2 className="mb-2 font-semibold">수호자 판단</h2>
      {guardianResult === null && <p role="status" className="text-sm text-muted-foreground">마지막 대조 결과를 불러오는 중입니다…</p>}
      {guardianResult?.kind === 'forbidden' && <p role="alert" className="text-sm">운영자 권한이 필요합니다.</p>}
      {guardianResult?.kind === 'error' && <p role="alert" className="text-sm">수호자 판단을 읽지 못했습니다. (HTTP {guardianResult.status || '연결 오류'})</p>}
      {guardianResult?.kind === 'ready' && <>
        <p className="text-sm">상태: {guardianResult.data.state === 'ready' ? '최신' : guardianResult.data.state === 'stale' ? '오래됨' : guardianResult.data.state === 'failed' ? '첫 대조 실패' : '첫 대조 대기'}
          {guardianResult.data.observedAt ? ` · 관측 ${new Date(guardianResult.data.observedAt).toLocaleString()}` : ''}
          {guardianResult.data.staleReason ? ` · ${guardianResult.data.staleReason}` : ''}
          {guardianResult.data.lastFailureAt ? ` · 실패 ${new Date(guardianResult.data.lastFailureAt).toLocaleString()}` : ''}</p>
        <p className="mt-1 text-sm">대조 사건 {guardianResult.data.findings.length} · 회수 {guardianResult.data.cleanup.reaped} · 건너뜀 {guardianResult.data.cleanup.skipped} · 오류 {guardianResult.data.cleanup.errors}</p>
        {guardianResult.data.releaseReservation && <p className="mt-1 text-sm">node-b release 예약: {guardianResult.data.releaseReservation.status} · {guardianResult.data.releaseReservation.reason}</p>}
        {guardianResult.data.findings.length > 0 && <ul className="mt-2 space-y-1 text-sm">{guardianResult.data.findings.map((finding, i) =>
          <li key={`${finding.id}:${i}`}><strong>{finding.kind}</strong> · {finding.host} · {finding.id} · {finding.detail}</li>)}</ul>}
        <p className="mt-2 text-xs text-muted-foreground">수호자 판단은 보고 전용 요약이며, 이 화면은 정리 작업을 실행하지 않습니다.</p>
      </>}
    </section>
    {result === null && <p role="status" className="rounded border p-4">원장을 불러오는 중입니다…</p>}
    {result?.kind === 'forbidden' && <p role="alert" className="rounded border p-4">운영자 권한이 필요합니다.</p>}
    {result?.kind === 'error' && <p role="alert" className="rounded border p-4">원장을 읽지 못했습니다. (HTTP {result.status || '연결 오류'})</p>}
    {result?.kind === 'ready' && <>
      <section className="overflow-x-auto rounded-lg border" aria-label="호스트별 자원 행렬"><table className="w-full min-w-[1050px] text-left text-sm">
        <thead className="bg-muted/50"><tr>{['호스트', '차선', '용량', '임대', '임대 CPU / 메모리', 'Pod 요청 CPU / 메모리', 'Pod 수', '프로세스 FP / 미귀속', '임대−Pod'].map(label => <th key={label} className="px-3 py-3">{label}</th>)}</tr></thead>
        <tbody>{result.data.matrix.map((row, index) => <tr key={`${row.host}:${row.lane}:${index}`} className="border-t">
          <td className="px-3 py-3 font-medium">{row.host}</td><td className="px-3 py-3">{row.lane}</td><td className="px-3 py-3">{quantity(row.capacity)}</td>
          <td className="px-3 py-3">{row.leases}</td><td className="px-3 py-3">{row.leasedCpu} / {bytes(row.leasedMemoryBytes)}</td>
          <td className="px-3 py-3">{quantity(row.observedPodCpuRequests)} / {bytes(row.observedPodMemoryRequestsBytes)}</td>
          <td className="px-3 py-3">{quantity(row.measuredPods)}{row.unknownPods ? ` (미귀속 ${row.unknownPods})` : ''}</td>
          <td className="px-3 py-3">{quantity(row.measuredProcesses)} / {quantity(row.unknownProcesses)}</td><td className="px-3 py-3">{quantity(row.deltaLeasesVsPods)}</td>
        </tr>)}{result.data.matrix.length === 0 && <tr><td colSpan={9} className="p-5 text-center text-muted-foreground">표시할 자원 행이 없습니다.</td></tr>}</tbody>
      </table></section>
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border p-4"><h2 className="mb-3 font-semibold">대조 사건 · {result.data.findings.length}</h2>
          {result.data.findings.length ? <ul className="space-y-2 text-sm">{result.data.findings.map((finding, i) => <li key={`${finding.id}:${i}`} className="border-t pt-2"><strong>{finding.kind}</strong> · {finding.host} · {finding.id}<p className="text-muted-foreground">{finding.detail}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">보고된 차이가 없습니다.</p>}
        </div>
        <div className="rounded-lg border p-4"><h2 className="mb-3 font-semibold">실측 상태</h2>
          <ul className="space-y-3 text-sm">{result.data.measurements.map(row => {
            const podsUnmeasured = row.errors.some(error => error.startsWith('kubectl'));
            const processesUnmeasured = row.errors.some(error => error.startsWith('ps:'));
            return <li key={row.host} className="border-t pt-2"><strong>{row.host}</strong> · 관측 {new Date(row.observedAt).toLocaleString()}
            <div className="mt-2 grid gap-3 md:grid-cols-2"><div><h3 className="font-medium">Pods · {row.pods.length}</h3>
              {row.pods.length ? <ul className="mt-1 space-y-1">{row.pods.map(pod => <li key={pod.id} className="text-muted-foreground">{pod.id} · {pod.phase} · {pod.fp ?? '지문 없음'}{pod.lane ? ` · ${pod.lane}` : ''}{pod.mission ? ` · ${pod.mission}` : ''}</li>)}</ul> : <p className="text-muted-foreground">{podsUnmeasured ? 'Pod 관측 미측정' : '관측 Pod 없음'}</p>}
            </div><div><h3 className="font-medium">관리 프로세스 · {row.processes.length}</h3>
              {row.processes.length ? <ul className="mt-1 space-y-1">{row.processes.map(process => <li key={process.id} className="text-muted-foreground">{process.id} · {process.fp ?? '지문 없음'}{process.lane ? ` · ${process.lane}` : ''}{process.mission ? ` · ${process.mission}` : ''}</li>)}</ul> : <p className="text-muted-foreground">{processesUnmeasured ? '프로세스 관측 미측정' : '관측 프로세스 없음'}</p>}
            </div></div>
            {row.errors.length > 0 && <p className="mt-2 text-amber-700">{row.errors.join(' · ')}</p>}</li>;
          })}</ul>
        </div>
      </section>
      <section className="rounded-lg border p-4"><h2 className="mb-3 font-semibold">활성 임대 · {result.data.leases.length}</h2>
        <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead><tr>{['지문', '호스트 · 차선', '칸 / 골 / PR', 'CPU / 메모리 / Pod', '심장박동'].map(x => <th key={x} className="border-b px-2 py-2">{x}</th>)}</tr></thead>
          <tbody>{result.data.leases.map(lease => <tr key={lease.id} className="border-b"><td className="px-2 py-2">{lease.fp}</td><td className="px-2 py-2">{lease.host} · {lease.lane}</td>
            <td className="px-2 py-2">{lease.mission.cell ?? '—'} / {lease.mission.goalId ?? '—'} / {lease.mission.pr ? `#${lease.mission.pr}` : '—'}</td>
            <td className="px-2 py-2">{quantity(lease.resources.cpu ?? null)} / {bytes(lease.resources.memoryBytes ?? null)} / {quantity(lease.resources.pods ?? null)}</td><td className="px-2 py-2">{new Date(lease.heartbeatAt).toLocaleString()}</td></tr>)}
            {result.data.leases.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">활성 임대가 없습니다.</td></tr>}</tbody></table></div>
      </section>
      <section className="rounded-lg border p-4" aria-label="최근 임대 종료 및 회수"><h2 className="mb-3 font-semibold">최근 임대 종료·회수 · {result.data.recentReclaims === undefined ? '미지원' : result.data.recentReclaims.length}</h2>
        {result.data.recentReclaims === undefined
          ? <p className="text-sm text-muted-foreground">현재 Nexus API가 임대 종료·회수 이력을 제공하지 않습니다.</p>
          : result.data.recentReclaims.length ? <ul className="space-y-2 text-sm">{result.data.recentReclaims.map(row => <li key={row.id + row.at} className="border-t pt-2">
            <strong>{row.kind === 'lease-reaped' ? '만료 회수' : '임대 종료'}</strong> · {row.host} · {row.lane} · {row.fp} · {new Date(row.at).toLocaleString()}
            <p className="text-muted-foreground">사유: {row.reason} · 처리: {row.stoppedBy}</p></li>)}</ul>
          : <p className="text-sm text-muted-foreground">원장에 기록된 종료·회수 사건이 없습니다.</p>}
      </section>
      <p className="text-xs text-muted-foreground">관측 시각: {new Date(result.data.observedAt).toLocaleString()} · 이 화면은 조회만 수행합니다.</p>
    </>}
  </main>;
}

export function ResourceLedgerView(): React.ReactNode {
  const { client } = useDaemon();
  const [result, setResult] = useState<OpsResult<ResourceLedger> | null>(null);
  const [guardianResult, setGuardianResult] = useState<OpsResult<ResourceGuardianSnapshot> | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    const ledgerRequest = getResourceLedger(client).then(next => {
      setResult(next);
      if (next.kind === 'ready') setRefreshedAt(new Date().toISOString());
    });
    const guardianRequest = getResourceGuardian(client).then(setGuardianResult);
    await Promise.all([ledgerRequest, guardianRequest]);
    setLoading(false);
  }, [client]);
  useEffect(() => { void refresh(); }, [refresh]);
  return <ResourceLedgerContent result={result} guardianResult={guardianResult} refreshedAt={refreshedAt} onRefresh={() => void refresh()} loading={loading} />;
}
