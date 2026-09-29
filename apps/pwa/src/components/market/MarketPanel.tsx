'use client';

import { useEffect, useState } from 'react';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import type { InstalledPluginWire, MarketIndexResponse } from '@/nexus/client';
import { marketCards, type MarketCard } from './market-view';

type Tab = 'browse' | 'detail' | 'installed';

export function MarketPanel() {
  const client = useOptionalNexusClient();
  const [tab, setTab] = useState<Tab>('browse');
  const [index, setIndex] = useState<MarketIndexResponse | null>(null);
  const [installed, setInstalled] = useState<InstalledPluginWire[]>([]);
  const [selected, setSelected] = useState<MarketCard | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [installedLoaded, setInstalledLoaded] = useState(false);

  useEffect(() => {
    if (!client) return;
    let active = true;
    setIndex(null);
    setInstalled([]);
    setSelected(null);
    setIndexError(null);
    setInstalledError(null);
    setInstalledLoaded(false);
    void client.getPluginsIndex().then(nextIndex => {
      if (active) setIndex(nextIndex);
    }).catch((reason: unknown) => {
      if (active) setIndexError(reason instanceof Error ? reason.message : String(reason));
    });
    void client.getInstalledPlugins().then(nextInstalled => {
      if (active) { setInstalled(nextInstalled); setInstalledLoaded(true); }
    }).catch((reason: unknown) => {
      if (active) { setInstalledError(reason instanceof Error ? reason.message : String(reason)); setInstalledLoaded(true); }
    });
    return () => { active = false; };
  }, [client]);

  const cards = index ? marketCards(index) : [];
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-5 text-foreground" aria-label="마켓">
      <header>
        <h1 className="text-2xl font-semibold">마켓</h1>
        <p className="text-sm text-muted-foreground">데몬이 확인한 플러그인 인덱스를 살펴봅니다.</p>
      </header>
      <nav aria-label="마켓 탭" className="flex flex-wrap gap-2">
        {([['browse', '찾아보기'], ['detail', '상세'], ['installed', '설치됨']] as const).map(([id, label]) =>
          <button key={id} type="button" aria-current={tab === id ? 'page' : undefined}
            className={`rounded-lg border px-4 py-2 text-sm ${tab === id ? 'border-blue-500 font-semibold' : 'border-border'}`}
            onClick={() => setTab(id)}>{label}</button>)}
      </nav>
      {!client && <p role="status">Daemon 연결이 설정되지 않았습니다. Settings 에서 Base URL 을 입력하세요.</p>}
      {tab !== 'installed' && indexError && <p role="alert">마켓을 불러오지 못했습니다: {indexError}</p>}
      {tab !== 'installed' && client && !indexError && !index && <p role="status">마켓을 불러오는 중…</p>}
      {tab === 'installed' && installedError && <p role="alert">설치 목록을 불러오지 못했습니다: {installedError}</p>}
      {tab === 'installed' && client && !installedLoaded && <p role="status">설치 목록을 불러오는 중…</p>}
      {tab === 'browse' && index && (index.markets.length === 0
        ? <p>아직 받아 둔 마켓이 없습니다. 플러그인 설치 방법은 <a className="underline" href="https://docs.elanous.ai">문서</a>를 보세요.</p>
        : cards.length === 0 ? <p>등록된 플러그인이 없습니다.</p>
        : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{cards.map(card =>
          <article key={`${card.market.name}/${card.plugin.name}/${card.plugin.version}`} className="rounded-xl border border-border p-4 space-y-2">
            <h2 className="font-semibold">{card.plugin.name} <span className="text-xs font-normal">v{card.plugin.version}</span></h2>
            <p className="text-sm text-muted-foreground">{card.plugin.description ?? '설명이 없습니다.'}</p>
            <p className="text-sm">{card.price} · <span title={card.market.detail}>{card.badge}</span></p>
            <button type="button" className="rounded border px-3 py-1 text-sm" onClick={() => { setSelected(card); setTab('detail'); }}>상세 보기</button>
          </article>)}</div>)}
      {tab === 'detail' && !indexError && (selected ? <section className="space-y-4 rounded-xl border border-border p-5" aria-label="플러그인 상세">
        <h2 className="text-xl font-semibold">{selected.plugin.name} <small>v{selected.plugin.version}</small></h2>
        <p>{selected.plugin.description}</p>
        <p>{selected.price} · {selected.badge}</p>
        <section><h3 className="font-medium">권한</h3><ul>{selected.plugin.capabilities.map(cap => <li key={cap}>{cap}</li>)}</ul></section>
        <section><h3 className="font-medium">커넥터와 자격 칸</h3>{selected.plugin.connectors.map(connector =>
          <div key={connector.id}><p>{connector.id} · {connector.kind}</p><ul>{connector.userConfig.map(field =>
            <li key={field.key}>{field.label} ({field.key}){field.secret ? ' · 비밀' : ''}</li>)}</ul></div>)}</section>
        <section><h3 className="font-medium">그래프</h3><ul>{selected.plugin.graphs?.map(graph => <li key={graph}>{graph}</li>)}</ul></section>
        <p>sha256: <code>{selected.plugin.sha256.slice(0, 12)}</code></p>
        <button type="button" disabled className="rounded border px-3 py-1 opacity-50">설치 · 곧</button>
      </section> : <p>찾아보기에서 플러그인을 선택하세요.</p>)}
      {tab === 'installed' && installedLoaded && !installedError && (installed.length === 0 ? <p>설치된 플러그인이 없습니다.</p> :
        <ul className="space-y-2">{installed.map(plugin => <li className="rounded-lg border border-border p-3" key={`${plugin.market}/${plugin.name}/${plugin.version}`}>
          {plugin.name} · v{plugin.version} · 설치 시각: {plugin.installedAt && Number.isFinite(Date.parse(plugin.installedAt))
            ? <time dateTime={plugin.installedAt}>{new Date(plugin.installedAt).toLocaleString('ko-KR')}</time>
            : '알 수 없음'}
        </li>)}</ul>)}
    </main>
  );
}
