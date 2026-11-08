'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { AppSimLiveView, type AppSimReceipt } from '@/components/apps/AppSimLiveView';
import { useNexusClient } from '@/nexus/hooks/use-nexus-context';

type AppEnvironment = {
  status: 'not-created' | 'ready' | 'running' | 'passed' | 'failed' | 'live' | 'paused';
  href?: string;
  version?: string;
  receipt?: string;
};

type AppTile = {
  slug: string;
  name: string;
  description: string;
  simulation: AppEnvironment;
  production: AppEnvironment;
};

type AppListResponse = { apps: AppTile[] };
type AppCreateResponse = { app?: AppTile };

const simulationLabels: Record<AppEnvironment['status'], string> = {
  'not-created': '세계 준비 전', ready: '준비됨', running: '실행 중', passed: '통과', failed: '확인 필요', live: '정식 운영', paused: '일시정지',
};
const productionLabels: Record<AppEnvironment['status'], string> = {
  'not-created': '영수증 뒤 올리기', ready: '배포 준비', running: '배포 중', passed: '영수증 통과', failed: '확인 필요', live: '정식 운영', paused: '일시정지',
};

export default function AppsPage() {
  const { client } = useDaemon();
  const [apps, setApps] = useState<AppTile[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadedClientGeneration, setLoadedClientGeneration] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [selectedApp, setSelectedApp] = useState<AppTile | null>(null);
  const requestVersion = useRef(0);
  const clientGeneration = useRef(0);
  const actionVersion = useRef(0);
  const actionLocked = useRef(false);
  const clientRef = useRef(client);

  useLayoutEffect(() => {
    if (clientRef.current !== client) {
      clientRef.current = client;
    clientGeneration.current += 1;
      requestVersion.current += 1;
      actionVersion.current += 1;
      actionLocked.current = false;
      setSelectedApp(null);
    }
  }, [client]);

  const loadApps = useCallback(async () => {
    const version = ++requestVersion.current;
    const generation = clientGeneration.current;
    setStatus('loading');
    setError('');
    try {
      const { apps: rows } = await clientRef.current.fetchJson<AppListResponse>('/v1/apps');
      if (version !== requestVersion.current || generation !== clientGeneration.current) return { state: 'stale' } as const;
      setApps(rows); setStatus('ready'); setLoadedClientGeneration(generation);
      return { state: 'loaded', apps: rows } as const;
    } catch {
      if (version !== requestVersion.current || generation !== clientGeneration.current) return { state: 'stale' } as const;
      setError('앱 목록을 불러오지 못했습니다'); setStatus('error'); setLoadedClientGeneration(generation);
      return { state: 'failed' } as const;
    }
  }, []);

  useEffect(() => {
    setBusySlug(null);
    void loadApps();
    return () => { requestVersion.current += 1; };
  }, [client, loadApps]);

  const viewStatus = loadedClientGeneration === clientGeneration.current ? status : 'loading';

  if (selectedApp) {
    const receipt: AppSimReceipt[] = selectedApp.simulation.receipt ? [{
      id: selectedApp.simulation.receipt,
      outcome: selectedApp.simulation.status === 'passed' ? 'passed'
        : selectedApp.simulation.status === 'failed' ? 'failed' : 'unknown',
      summary: `마지막 시뮬레이션 · ${simulationLabels[selectedApp.simulation.status]}`,
    }] : [];
    return <AppSimulationDetails app={selectedApp} receipts={receipt} onBack={() => setSelectedApp(null)} />;
  }

  async function createApp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = name.trim();
    const cleanSlug = slug.trim().toLowerCase();
    const cleanDescription = description.trim();
    if (actionLocked.current || busySlug !== null || viewStatus !== 'ready' || loadedClientGeneration !== clientGeneration.current || !cleanName || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(cleanSlug)) return;
    const operationClient = clientRef.current;
    const operationGeneration = clientGeneration.current;
    const operationVersion = ++actionVersion.current;
    actionLocked.current = true;
    requestVersion.current += 1;
    setBusySlug('new');
    setError('');
    try {
      const result = await operationClient.fetchJson<AppCreateResponse>('/v1/apps', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: cleanName, slug: cleanSlug, description: cleanDescription }),
      });
      if (operationGeneration !== clientGeneration.current) return;
      if (!result.app) {
        setName(''); setSlug(''); setDescription(''); setCreating(false);
        const refresh = await loadApps();
        if (operationGeneration === clientGeneration.current) {
          if (refresh.state === 'failed') setError('앱 생성 응답이 비어 있고 목록을 갱신하지 못했습니다. 다시 불러오세요');
          else if (refresh.state === 'loaded' && !refresh.apps.some((item) => item.slug === cleanSlug)) setError('앱 생성 응답을 확인하지 못했습니다. 목록을 새로 고쳤습니다');
        }
        return;
      }
      const app = result.app;
      setApps((current) => [app, ...current.filter((item) => item.slug !== app.slug)]);
      setName(''); setSlug(''); setDescription(''); setCreating(false);
      const refresh = await loadApps();
      if (refresh.state === 'failed' && operationGeneration === clientGeneration.current) setError('앱은 만들었지만 목록을 갱신하지 못했습니다. 다시 불러오세요');
    } catch {
      if (operationGeneration === clientGeneration.current) {
        const refresh = await loadApps();
        if (operationGeneration === clientGeneration.current) {
          setError(refresh.state === 'failed' ? '앱 요청 결과를 확인할 수 없습니다. 다시 불러오세요' : '앱을 만들지 못했습니다');
        }
      }
    } finally {
      if (operationVersion === actionVersion.current) {
        actionLocked.current = false;
        if (operationGeneration === clientGeneration.current) setBusySlug(null);
      }
    }
  }

  async function moveToTrash(app: AppTile) {
    if (actionLocked.current || busySlug !== null || viewStatus !== 'ready' || loadedClientGeneration !== clientGeneration.current) return;
    const operationClient = clientRef.current;
    const operationGeneration = clientGeneration.current;
    const operationVersion = ++actionVersion.current;
    actionLocked.current = true;
    setBusySlug(app.slug);
    setError('');
    try {
      await operationClient.fetchJson(`/v1/apps/${encodeURIComponent(app.slug)}`, { method: 'DELETE' });
      if (operationGeneration !== clientGeneration.current) return;
      setApps((current) => current.filter((item) => item.slug !== app.slug));
    } catch {
      if (operationGeneration === clientGeneration.current) setError(`${app.name} 앱을 휴지통으로 옮기지 못했습니다`);
    } finally {
      if (operationVersion === actionVersion.current) {
        actionLocked.current = false;
        if (operationGeneration === clientGeneration.current) setBusySlug(null);
      }
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 px-5 py-10 sm:py-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">Elanous · App Studio</p>
          <h1 className="text-2xl font-semibold tracking-tight">앱 스튜디오</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">앱을 만들고, 시뮬레이션으로 확인한 뒤 정식 환경으로 이어가세요.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/design-check" className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            디자인 방향 고르기
          </Link>
          <button type="button" disabled={viewStatus !== 'ready'} onClick={() => { setCreating((value) => !value); setError(''); }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            {creating ? '닫기' : '새 앱 만들기'}
          </button>
        </div>
      </header>

      {creating && <form onSubmit={(event) => void createApp(event)} aria-label="새 앱 만들기" className="grid gap-3 rounded-xl border border-border bg-card p-5 sm:grid-cols-2">
        <label className="space-y-1 text-sm font-medium">앱 이름
          <input required value={name} onInput={(event) => setName(event.currentTarget.value)} className="w-full rounded-md border border-border bg-background px-3 py-2 font-normal" />
        </label>
        <label className="space-y-1 text-sm font-medium">앱 주소
          <input required pattern="[a-z0-9][a-z0-9-]{1,31}" value={slug} onInput={(event) => setSlug(event.currentTarget.value.toLowerCase())}
            aria-describedby="app-slug-help" className="w-full rounded-md border border-border bg-background px-3 py-2 font-normal" />
          <span id="app-slug-help" className="block text-xs text-muted-foreground">영문 소문자·숫자·하이픈 2~32자</span>
        </label>
        <label className="space-y-1 text-sm font-medium sm:col-span-2">설명
          <textarea value={description} onInput={(event) => setDescription(event.currentTarget.value)} rows={2} className="w-full rounded-md border border-border bg-background px-3 py-2 font-normal" />
        </label>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button type="submit" disabled={busySlug !== null || viewStatus !== 'ready'} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{busySlug === 'new' ? '만드는 중…' : '앱 만들기'}</button>
          <button type="button" onClick={() => setCreating(false)} className="rounded-lg border border-border px-4 py-2 text-sm">취소</button>
        </div>
      </form>}

      {error && viewStatus !== 'loading' && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {viewStatus === 'loading' && <p role="status" className="text-sm text-muted-foreground">앱을 불러오는 중…</p>}
      {viewStatus === 'error' && <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><p>연결을 확인한 뒤 다시 시도하세요.</p><button type="button" onClick={() => void loadApps()} className="underline underline-offset-4">다시 불러오기</button></div>}
      {viewStatus === 'ready' && (apps.length === 0
        ? <section className="rounded-xl border border-dashed border-border bg-card/50 px-5 py-12 text-center">
          <h2 className="text-lg font-semibold">첫 앱을 시작해 보세요</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">디자인 방향을 둘러볼 수 있습니다. 앱을 만든 뒤에는 시뮬레이션과 정식 환경을 여기서 관리합니다.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Link href="/design-check" className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted">디자인 방향 둘러보기</Link>
            <button type="button" onClick={() => setCreating(true)} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">새 앱 만들기</button>
          </div>
        </section>
        : <ul aria-label="앱 타일" className="grid gap-4 md:grid-cols-2">
          {apps.map((app) => <li key={app.slug}>
            <article className="h-full space-y-5 rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <h2 className="truncate text-lg font-semibold">{app.name}</h2>
                  <p className="text-xs text-muted-foreground">/{app.slug}</p>
                  <p className="text-sm text-muted-foreground">{app.description || '설명이 없습니다.'}</p>
                </div>
                <button type="button" disabled={busySlug !== null} onClick={() => void moveToTrash(app)} aria-label={`${app.name} 휴지통으로`}
                  className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50">휴지통</button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2" aria-label={`${app.name} 환경`}>
                <section aria-label={`${app.name} 시뮬레이션 환경`} className="space-y-2 rounded-lg border border-border p-3">
                  <h3 className="text-sm font-semibold">🧪 시뮬레이션</h3>
                  <p className="text-sm text-muted-foreground">{simulationLabels[app.simulation.status]}</p>
                  {app.simulation.receipt && <p className="text-xs text-muted-foreground">최근 영수증 · {app.simulation.receipt}</p>}
                  <button type="button" onClick={() => setSelectedApp(app)} className="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline">
                    시뮬레이션 보기
                  </button>
                  {app.simulation.href && <a href={app.simulation.href} className="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline">열기</a>}
                </section>
                <section aria-label={`${app.name} 정식 환경`} className="space-y-2 rounded-lg border border-border p-3">
                  <h3 className="text-sm font-semibold">🌐 정식</h3>
                  <p className="text-sm text-muted-foreground">{productionLabels[app.production.status]}</p>
                  {app.production.version && <p className="text-xs text-muted-foreground">판 {app.production.version}</p>}
                  {app.production.href && <a href={app.production.href} target="_blank" rel="noopener" className="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline">앱 열기</a>}
                  {!app.production.href && <button type="button" disabled className="text-sm text-muted-foreground">영수증 뒤 올리기</button>}
                </section>
              </div>
            </article>
          </li>)}
        </ul>)}
    </main>
  );
}

function AppSimulationDetails({ app, receipts, onBack }: { app: AppTile; receipts: readonly AppSimReceipt[]; onBack: () => void }) {
  const client = useNexusClient();
  return <AppSimLiveView appId={app.slug} appName={app.name} client={client} receipts={receipts} onBack={onBack} />;
}
