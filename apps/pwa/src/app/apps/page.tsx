'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { AppSimLiveView, type AppSimLiveEvent, type AppSimReceipt } from '@/components/apps/AppSimLiveView';
import { useNexusClient } from '@/nexus/hooks/use-nexus-context';

type AppTile = {
  slug: string;
  name: string;
  description?: string;
  simulation?: { status?: string; receipt?: string; href?: string; events?: AppSimLiveEvent[]; receipts?: AppSimReceipt[] };
  production?: { status?: string; version?: string; href?: string };
  lifecycle?: { status?: string; latestReceiptId?: string | null } | null;
};

const simulationLabel = (app: AppTile): string => {
  const status = app.simulation?.status;
  if (status === 'unavailable') return '시뮬레이션 저장소 사용 불가';
  if (status === 'passed' || status === 'failed' || status === 'running' || status === 'ready') {
    return ({ passed: '통과', failed: '확인 필요', running: '실행 중', ready: '준비됨' } as const)[status];
  }
  return app.lifecycle?.latestReceiptId || app.simulation?.receipt ? '시뮬레이션 기록 있음' : '준비 전';
};

export default function AppsPage() {
  const { client } = useDaemon();
  const [apps, setApps] = useState<AppTile[]>([]);
  const [selected, setSelected] = useState<AppTile | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading');

  useEffect(() => {
    let current = true;
    setState('loading');
    void client.fetchJson<{ apps: AppTile[] }>('/v1/apps').then(({ apps: rows }) => {
      if (!current) return;
      setApps(rows);
      setState('ready');
    }).catch(() => {
      if (!current) return;
      setApps([]);
      setState('offline');
    });
    return () => { current = false; };
  }, [client]);

  if (selected) {
    return <AppSimulationDetails app={selected} onBack={() => setSelected(null)} onSimulationUpdated={(simulation) => {
      const updated = { ...selected, simulation };
      setApps((current) => current.map((app) => app.slug === selected.slug ? updated : app));
      setSelected((current) => current?.slug === selected.slug ? updated : current);
    }} />;
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-5 py-10 sm:py-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">Elanous · App Studio</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">앱 스튜디오</h1>
          <p className="mt-2 text-sm text-muted-foreground">앱별 시뮬레이션 흐름과 실제 운영 상태를 확인합니다.</p>
        </div>
        <Link href="/design-check" className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted">
          디자인 방향 고르기
        </Link>
      </header>

      {state === 'loading' && <p role="status" className="text-sm text-muted-foreground">앱을 불러오는 중…</p>}
      {state === 'offline' && <section role="status" className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
        <h2 className="font-semibold text-foreground">데몬에 연결되지 않았습니다</h2>
        <p className="mt-1">데몬을 연결하면 앱과 시뮬레이션 상태를 볼 수 있습니다. 연결 설정을 확인한 뒤 다시 방문하세요.</p>
      </section>}
      {state === 'ready' && apps.length === 0 && <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">표시할 앱이 없습니다.</p>}
      {state === 'ready' && apps.length > 0 && <ul aria-label="앱 타일" className="grid gap-4 md:grid-cols-2">
        {apps.map((app) => {
          const receiptId = app.simulation?.receipt ?? app.lifecycle?.latestReceiptId;
          return <li key={app.slug}>
            <article className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
              <div><h2 className="text-lg font-semibold">{app.name}</h2><p className="text-sm text-muted-foreground">{app.description || `/${app.slug}`}</p></div>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="font-medium">시뮬레이션</dt><dd className="text-muted-foreground">{simulationLabel(app)}</dd></div>
                <div><dt className="font-medium">실제 운영</dt><dd className="text-muted-foreground">{app.production?.status === 'live' || app.lifecycle?.status === 'live' ? '정식 운영' : '준비 전'}</dd></div>
              </dl>
              {receiptId && <p className="break-all text-xs text-muted-foreground">영수증 ID · {receiptId}</p>}
              <button type="button" onClick={() => setSelected(app)} className="text-sm font-medium text-primary underline-offset-4 hover:underline">시뮬레이션 보기</button>
            </article>
          </li>;
        })}
      </ul>}
    </main>
  );
}

function AppSimulationDetails({ app, onBack, onSimulationUpdated }: {
  app: AppTile;
  onBack: () => void;
  onSimulationUpdated: (simulation: NonNullable<AppTile['simulation']>) => void;
}) {
  const { client: daemonClient } = useDaemon();
  const client = useNexusClient();
  const [simulation, setSimulation] = useState(app.simulation);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(false);
  const runSimulation = async () => {
    setRunning(true);
    setRunError(false);
    try {
      const result = await daemonClient.fetchJson<{ simulation: NonNullable<AppTile['simulation']> }>(
        `/v1/apps/${encodeURIComponent(app.slug)}/simulations/run`, { method: 'POST' });
      setSimulation(result.simulation);
      onSimulationUpdated(result.simulation);
    } catch {
      setRunError(true);
    } finally { setRunning(false); }
  };
  const receiptId = simulation?.receipt ?? app.lifecycle?.latestReceiptId;
  const receipts: AppSimReceipt[] = simulation?.receipts?.length ? simulation.receipts : receiptId ? [{
    id: receiptId,
    outcome: simulationLabel(app) === '통과' ? 'passed' : 'unknown',
    summary: `${app.name} 시뮬레이션`,
  }] : [];
  return <>
    <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-6 pt-6">
      <button type="button" onClick={runSimulation} disabled={running}
        className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium disabled:opacity-60">
        {running ? '시뮬레이션 실행 중…' : '시뮬레이션 실행'}
      </button>
      {runError && <p role="alert" className="text-sm text-destructive">시뮬레이션 결과를 저장하지 못했습니다. 데몬 연결을 확인하고 다시 실행하세요.</p>}
    </div>
    <AppSimLiveView appId={app.slug} appName={app.name} client={client} receipts={receipts}
      initialEvents={simulation?.events ?? []} onBack={onBack} />
  </>;
}
