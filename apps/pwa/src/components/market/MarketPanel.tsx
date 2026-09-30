'use client';

import { useEffect, useState } from 'react';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import type { InstalledPluginWire, MarketIndexResponse } from '@/nexus/client';
import { marketCards, type MarketCard } from './market-view';
import { installProgressFromLine, type InstallProgress } from './market-install';
import { CredentialsForm } from './CredentialsForm';

type Tab = 'browse' | 'detail' | 'installed';

export function MarketPanel() {
  const client = useOptionalNexusClient();
  const [tab, setTab] = useState<Tab>('browse');
  const [index, setIndex] = useState<MarketIndexResponse | null>(null);
  const [installed, setInstalled] = useState<InstalledPluginWire[]>([]);
  const [selected, setSelected] = useState<MarketCard | null>(null);
  const [indexError, setIndexError] = useState(false);
  const [installedError, setInstalledError] = useState(false);
  const [installedLoaded, setInstalledLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [installConsent, setInstallConsent] = useState(false);
  const [progress, setProgress] = useState<InstallProgress[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);

  async function refresh() {
    if (!client) return;
    setBusy(true); setActionError(null);
    try {
      const result = await client.refreshPluginMarket('elanous');
      if (!result.ok) throw new Error('공식 마켓을 받지 못했습니다.');
      setIndex(await client.getPluginsIndex());
      setIndexError(false);
    } catch { setActionError('공식 마켓을 받지 못했습니다.'); }
    finally { setBusy(false); }
  }

  async function install() {
    if (!client || !selected) return;
    setBusy(true); setProgress([]); setActionError(null);
    let terminal: '완료' | '실패' | null = null;
    try {
      await client.installMarketPlugin(`${selected.plugin.name}@${selected.market.name}`, selected.plugin.capabilities, line => {
        const next = installProgressFromLine(line);
        if (next) {
          if (next.step === '완료' || next.step === '실패') terminal = next.step;
          setProgress(current => [...current, next]);
        }
      });
      if (!terminal) setProgress(current => [...current, { step: '실패', reason: '설치가 끝나지 않았습니다.' }]);
    } catch {
      if (!terminal) setProgress(current => [...current, { step: '실패', reason: '설치 중 오류가 발생했습니다.' }]);
    }
    if (terminal === '완료') {
      try {
        setInstalled(await client.getInstalledPlugins());
        setInstalledLoaded(true); setInstalledError(false);
      } catch {
        setInstalledError(true);
        setActionError('설치는 완료됐지만 설치 목록을 불러오지 못했습니다.');
      }
    }
    setBusy(false);
  }

  async function remove(name: string) {
    if (!client) return;
    setBusy(true); setActionError(null);
    try {
      await client.removeMarketPlugin(name);
    } catch {
      setActionError('플러그인을 제거하지 못했습니다.');
      setBusy(false);
      return;
    }
    setRemoving(null);
    setInstalled(current => current.filter(plugin => plugin.name !== name));
    try {
      setInstalled(await client.getInstalledPlugins());
      setInstalledLoaded(true);
      setInstalledError(false);
    } catch {
      setInstalledError(true);
      setActionError('플러그인은 제거됐지만 설치 목록을 불러오지 못했습니다.');
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (!client) return;
    let active = true;
    setIndex(null);
    setInstalled([]);
    setSelected(null);
    setIndexError(false);
    setInstalledError(false);
    setInstalledLoaded(false);
    setProgress([]); setInstallConsent(false); setRemoving(null); setActionError(null);
    void client.getPluginsIndex().then(nextIndex => {
      if (active) setIndex(nextIndex);
    }).catch(() => {
      if (active) setIndexError(true);
    });
    void client.getInstalledPlugins().then(nextInstalled => {
      if (active) { setInstalled(nextInstalled); setInstalledLoaded(true); }
    }).catch(() => {
      if (active) { setInstalledError(true); setInstalledLoaded(true); }
    });
    return () => { active = false; };
  }, [client]);

  const cards = index ? marketCards(index) : [];
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-5 text-foreground" aria-label="마켓">
      <header>
        <h1 className="text-2xl font-semibold">마켓</h1>
        <p className="text-sm text-muted-foreground">확인된 플러그인을 살펴보고 설치할 수 있습니다.</p>
      </header>
      <nav aria-label="마켓 탭" className="flex flex-wrap gap-2">
        {([['browse', '찾아보기'], ['detail', '상세'], ['installed', '설치됨']] as const).map(([id, label]) =>
          <button key={id} type="button" aria-current={tab === id ? 'page' : undefined}
            className={`rounded-lg border px-4 py-2 text-sm ${tab === id ? 'border-blue-500 font-semibold' : 'border-border'}`}
            onClick={() => setTab(id)}>{label}</button>)}
      </nav>
      {!client && <p role="status">서버 연결이 설정되지 않았습니다. 설정에서 서버 주소를 입력하세요.</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {tab !== 'installed' && indexError && <p role="alert">마켓을 불러오지 못했습니다.</p>}
      {tab !== 'installed' && client && !indexError && !index && <p role="status">마켓을 불러오는 중…</p>}
      {tab === 'installed' && installedError && <p role="alert">설치 목록을 불러오지 못했습니다.</p>}
      {tab === 'installed' && client && !installedLoaded && <p role="status">설치 목록을 불러오는 중…</p>}
      {tab === 'browse' && index && (index.markets.length === 0
        ? <div className="space-y-3"><p>아직 받아 둔 마켓이 없습니다.</p><button type="button" disabled={busy || !client} className="rounded border px-3 py-2" onClick={() => void refresh()}>공식 마켓 받기</button></div>
        : cards.length === 0 ? <div className="space-y-3"><p>등록된 플러그인이 없습니다.</p><button type="button" disabled={busy || !client} className="rounded border px-3 py-2" onClick={() => void refresh()}>공식 마켓 받기</button></div>
        : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{cards.map(card =>
          <article key={`${card.market.name}/${card.plugin.name}/${card.plugin.version}`} className="rounded-xl border border-border p-4 space-y-2">
            <h2 className="font-semibold">{card.plugin.name} <span className="text-xs font-normal">v{card.plugin.version}</span></h2>
            <p className="text-sm text-muted-foreground">{card.plugin.description ?? '설명이 없습니다.'}</p>
            <p className="text-sm">{card.price} · <span title={card.market.detail}>{card.badge}</span></p>
            <button type="button" className="rounded border px-3 py-1 text-sm" onClick={() => { setSelected(card); setInstallConsent(false); setProgress([]); setTab('detail'); }}>상세 보기</button>
          </article>)}</div>)}
      {tab === 'detail' && !indexError && (selected ? <section className="space-y-4 rounded-xl border border-border p-5" aria-label="플러그인 상세">
        <h2 className="text-xl font-semibold">{selected.plugin.name} <small>v{selected.plugin.version}</small></h2>
        <p>{selected.plugin.description}</p>
        <p>{selected.price} · {selected.badge}</p>
        <section><h3 className="font-medium">권한</h3><ul>{selected.plugin.capabilities.map(cap => <li key={cap}>{cap}</li>)}</ul></section>
        <section><h3 className="font-medium">연결 정보 항목</h3>{selected.plugin.connectors.map(connector =>
          <div key={connector.id}><p>연결 정보</p><ul>{connector.userConfig.map(field =>
            <li key={field.key}>{field.label}{field.secret ? ' · 비공개 정보' : ''}</li>)}</ul></div>)}</section>
        <section><h3 className="font-medium">포함된 기능</h3><ul>{selected.plugin.graphs?.map(graph => <li key={graph}>{graph}</li>)}</ul></section>
        <p>파일 확인값: <code>{selected.plugin.sha256.slice(0, 12)}</code></p>
        {!installConsent ? <button type="button" disabled={busy || selected.market.signature !== 'ok'} className="rounded border px-3 py-1" onClick={() => setInstallConsent(true)}>설치</button>
          : <div className="space-y-2"><p>이 플러그인이 요청하는 권한을 확인하세요.</p>
            <ul>{selected.plugin.capabilities.map(cap => <li key={cap}>{cap}</li>)}</ul>
            <button type="button" disabled={busy} className="rounded border px-3 py-1" onClick={() => void install()}>동의하고 설치</button>
            <button type="button" disabled={busy} className="rounded border px-3 py-1" onClick={() => setInstallConsent(false)}>취소</button>
          </div>}
        {progress.length > 0 && <ol aria-label="설치 진행" className="space-y-1">{progress.map((item, i) =>
          <li key={i} role={item.step === '실패' ? 'alert' : undefined}>{item.step}{item.reason ? `: ${item.reason}` : ''}
            {item.credentialsRequired ? ' — 이 플러그인은 연결 정보가 필요합니다.' : ''}</li>)}</ol>}
        {client && progress.some(item => item.credentialsRequired) &&
          <CredentialsForm key={`${selected.plugin.name}-${progress.some(item => item.step === '완료' || item.step === '등록')}`} client={client} name={selected.plugin.name} />}
      </section> : <p>찾아보기에서 플러그인을 선택하세요.</p>)}
      {tab === 'installed' && installedLoaded && !installedError && (installed.length === 0 ? <p>설치된 플러그인이 없습니다.</p> :
        <ul className="space-y-2">{installed.map(plugin => <li className="rounded-lg border border-border p-3" key={`${plugin.market}/${plugin.name}/${plugin.version}`}>
          {plugin.name} · v{plugin.version} · 설치 시각: {plugin.installedAt && Number.isFinite(Date.parse(plugin.installedAt))
            ? <time dateTime={plugin.installedAt}>{new Date(plugin.installedAt).toLocaleString('ko-KR')}</time>
            : '알 수 없음'}
          {removing === plugin.name ? <span className="ml-3">제거할까요? <button type="button" disabled={busy} onClick={() => void remove(plugin.name)}>제거 확인</button> <button type="button" onClick={() => setRemoving(null)}>취소</button></span>
            : <button type="button" disabled={busy} className="ml-3 rounded border px-3 py-1" onClick={() => setRemoving(plugin.name)}>제거</button>}
          {client && <details className="mt-3"><summary className="cursor-pointer">연결 정보</summary>
            <div className="mt-2"><CredentialsForm client={client} name={plugin.name} /></div>
          </details>}
        </li>)}</ul>)}
    </main>
  );
}
