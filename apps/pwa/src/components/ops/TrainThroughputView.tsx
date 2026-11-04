'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { getTrainThroughput, type OpsResult, type TrainThroughput } from '@/lib/ops-api';

function todayKst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function TrainThroughputContent({ result, date, onRefresh, loading = false }: {
  result: OpsResult<TrainThroughput> | null; date: string; onRefresh?: () => void; loading?: boolean;
}): React.ReactNode {
  return <section className="rounded-lg border p-4" aria-label="열차 처리량">
    <header className="flex items-center justify-between gap-3"><h2 className="font-semibold">열차 처리량 · {date}</h2>
      {onRefresh && <button type="button" className="rounded border px-3 py-2 text-sm" onClick={onRefresh} disabled={loading}>{loading ? '조회 중…' : '새로고침'}</button>}
    </header>
    {result === null && <p role="status" className="mt-2 text-sm">열차 로그를 읽는 중입니다…</p>}
    {result?.kind === 'forbidden' && <p role="alert" className="mt-2 text-sm">운영자 권한이 필요합니다.</p>}
    {result?.kind === 'error' && <p role="alert" className="mt-2 text-sm">열차 처리량을 읽지 못했습니다. (HTTP {result.status || '연결 오류'})</p>}
    {result?.kind === 'ready' && <>
      {result.data.sourceIncomplete && <p role="alert" className="mt-2 text-sm">일부 로그/요약 파일을 읽지 못해 표시 수치가 불완전합니다.</p>}
      {Object.keys(result.data.hosts).length === 0
        ? <p className="mt-2 text-sm text-muted-foreground">해당 날짜의 배정 이벤트가 없습니다.</p>
        : <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[850px] text-left text-sm">
          <thead><tr>{['호스트', '배정', 'PR', '완료', '성공', '거부', '실행 실패', '측정 불가', '착지', '배정→완료 평균', '거부 사유'].map(label => <th key={label} className="border-b px-2 py-2">{label}</th>)}</tr></thead>
          <tbody>{Object.entries(result.data.hosts).sort(([a], [b]) => a.localeCompare(b)).map(([host, row]) =>
            <tr key={host} className="border-b"><th className="px-2 py-2">{host}</th><td className="px-2 py-2">{row.assigned}</td><td className="px-2 py-2">{row.assignedPrs}</td>
              <td className="px-2 py-2">{row.completed}</td><td className="px-2 py-2">{row.succeeded}</td><td className="px-2 py-2">{row.rejected}</td><td className="px-2 py-2">{row.failed}</td>
              <td className="px-2 py-2">{row.unmeasured}</td><td className="px-2 py-2">{row.landed ?? '미측정'}</td>
              <td className="px-2 py-2">{row.averageWaitSeconds === null ? '미측정' : `${row.averageWaitSeconds}초`}</td>
              <td className="px-2 py-2">{Object.entries(row.rejectedByReason).filter(([, count]) => count).map(([reason, count]) => `${reason} ${count}`).join(' · ') || '—'}</td></tr>)}</tbody>
        </table></div>}
      {Object.keys(result.data.hours).length > 0 && <div className="mt-4 overflow-x-auto"><h3 className="mb-2 text-sm font-medium">시간별</h3><table className="w-full text-left text-sm">
        <thead><tr>{['시각(KST)', '배정', '완료', '성공', '거부', '착지', '배정→완료 평균'].map(label => <th key={label} className="border-b px-2 py-2">{label}</th>)}</tr></thead>
        <tbody>{Object.entries(result.data.hours).sort(([a], [b]) => a.localeCompare(b)).map(([hour, row]) => <tr key={hour} className="border-b">
          <td className="px-2 py-2">{hour}</td><td className="px-2 py-2">{row.assigned}</td><td className="px-2 py-2">{row.completed}</td>
          <td className="px-2 py-2">{row.succeeded}</td><td className="px-2 py-2">{row.rejected}</td><td className="px-2 py-2">{row.landed ?? '미측정'}</td>
          <td className="px-2 py-2">{row.averageWaitSeconds === null ? '미측정' : `${row.averageWaitSeconds}초`}</td></tr>)}</tbody></table></div>}
      <p className="mt-2 text-xs text-muted-foreground">시간별 배정은 배정 로그 시각, 완료·성공·거부·대기 평균은 배치 종료 로그 시각에 집계합니다. 착지는 요약 원장 이벤트만 셉니다. 착지 증거가 없으면 미측정으로 표시합니다.</p>
    </>}
  </section>;
}

export function TrainThroughputView(): React.ReactNode {
  const { client } = useDaemon();
  const date = todayKst();
  const [result, setResult] = useState<OpsResult<TrainThroughput> | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setResult(await getTrainThroughput(client, date)); }
    finally { setLoading(false); }
  }, [client, date]);
  useEffect(() => { void refresh(); }, [refresh]);
  return <TrainThroughputContent result={result} date={date} onRefresh={() => void refresh()} loading={loading} />;
}
