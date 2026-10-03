'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { targetIsEditable } from '@/lib/showroom-keyboard-shortcuts';
import { ArchitectureScene } from './ArchitectureScene';
import { LiveTraceScene } from './LiveTraceScene';
import { GraphEditorScene } from './GraphEditorScene';
import { LoopAgentsScene } from './LoopAgentsScene';
import { PtyDecisionScene } from './PtyDecisionScene';
import { EMPTY_DECISIONS, reduceDecisions } from './pty-decisions';
import { subscribePtyDecisions } from '@/lib/inside-events';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { toPublicText } from './public-text';

const SCENES = ['문서 아키텍처', '라이브 트레이스', '루프 에이전트', '그래프 편집기', '마법사 → 마켓', 'PTY 인텔리전스'] as const;
const LAST_SCENE = SCENES.length;
/** ⑤ (wizard → market) is hidden in demo mode until WIZ1 lands; arrows step over it. */
const DEMO_HIDDEN_SCENE = 5;
const DEMO_KEY = 'elanous.inside.demo';

function insideScene(value: string | null): number {
  return value !== null && /^[1-9]$/.test(value) && Number(value) <= LAST_SCENE ? Number(value) : 1;
}

export function InsidePage() {
  const search = useSearchParams();
  return <InsidePageContent search={search} />;
}

/** Scenes ②③④⑥ need a daemon / React Flow; tests pass stand-ins. */
export function InsidePageContent({ search, liveTrace = <LiveTraceScene />, editorScene = <GraphEditorScene />, loopScene = <LoopAgentsScene />, ptyScene = <LivePtyDecisionScene /> }: { search: URLSearchParams; liveTrace?: ReactNode; editorScene?: ReactNode; loopScene?: ReactNode; ptyScene?: ReactNode }) {
  const [scene, setScene] = useState(() => {
    const selected = insideScene(search.get('scene'));
    return search.get('demo') === '1' && selected === DEMO_HIDDEN_SCENE ? 1 : selected;
  });
  const [demo, setDemo] = useState(() => search.get('demo') === '1');
  const stageRef = useRef<HTMLElement>(null);
  const sceneRef = useRef(scene);
  const demoRef = useRef(demo);
  sceneRef.current = scene;
  demoRef.current = demo;

  const updateAddress = useCallback((changes: Record<string, string>) => {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(changes)) url.searchParams.set(key, value);
    window.history.replaceState(window.history.state, '', url.toString());
  }, []);

  const selectScene = useCallback((next: number) => {
    if (next < 1 || next > LAST_SCENE || (demoRef.current && next === DEMO_HIDDEN_SCENE)) return;
    sceneRef.current = next;
    setScene(next);
    updateAddress({ scene: String(next) });
  }, [updateAddress]);

  const toggleDemo = useCallback(() => {
    const next = !demoRef.current;
    demoRef.current = next;
    setDemo(next);
    if (next && sceneRef.current === DEMO_HIDDEN_SCENE) selectScene(1);
    updateAddress({ demo: next ? '1' : '0' });
    try { window.localStorage.setItem(DEMO_KEY, next ? '1' : '0'); } catch { /* address remains authoritative */ }
  }, [selectScene, updateAddress]);

  useEffect(() => {
    const fromAddress = search.get('demo');
    let next = fromAddress === '1';
    if (fromAddress === null) {
      try { next = window.localStorage.getItem(DEMO_KEY) === '1'; } catch { /* address-only mode */ }
    } else {
      // `?demo=1` / `?demo=0` is remembered on this device, so a later bare `/inside` keeps it (review must-fix · INSIDE1a).
      try { window.localStorage.setItem(DEMO_KEY, next ? '1' : '0'); } catch { /* address remains authoritative */ }
    }
    demoRef.current = next;
    setDemo(next);
    const selected = insideScene(search.get('scene'));
    sceneRef.current = next && selected === DEMO_HIDDEN_SCENE ? 1 : selected;
    setScene(sceneRef.current);
    if (next && selected === DEMO_HIDDEN_SCENE) updateAddress({ scene: '1' });
  }, [search, updateAddress]);

  useEffect(() => {
    window.dispatchEvent(new window.Event('elanous:inside-demo'));
  }, [demo]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || targetIsEditable(event.target as HTMLElement)) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : -1;
        let next = sceneRef.current + step;
        if (demoRef.current && next === DEMO_HIDDEN_SCENE) next += step;
        selectScene(Math.min(LAST_SCENE, Math.max(1, next)));
      } else if (event.key.toLowerCase() === 'd') {
        toggleDemo();
      } else if (event.key.toLowerCase() === 'f') {
        if (typeof stageRef.current?.requestFullscreen === 'function') {
          void stageRef.current.requestFullscreen().catch(() => {});
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectScene, toggleDemo]);

  return (
    <main ref={stageRef} data-inside-page style={{ width: '100%', minHeight: '100vh', minWidth: 0, padding: 20, boxSizing: 'border-box', background: '#0c1828', color: '#f1f5fa', fontSize: 18 }}>
      <style>{`@media (min-width: 1440px) {
        [data-inside-page] h1 { font-size: 40px !important; }
        [data-inside-page] nav button { font-size: 22px !important; }
        [data-inside-page] [data-inside-scene="1"] [data-architecture-scene],
        [data-inside-page] [data-inside-scene="2"] section,
        [data-inside-page] [data-inside-scene="2"] header,
        [data-inside-page] [data-inside-scene="2"] button,
        [data-inside-page] [data-inside-scene="2"] .text-sm { font-size: 22px !important; }
      }`}</style>
      <header style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <h1 style={{ fontSize: 28, margin: 0 }}>엘라누스 안쪽</h1>
        {demo && <span aria-label="시연 모드" style={{ fontSize: 18 }}>시연</span>}
      </header>
      <nav aria-label="장면 선택" style={{ display: 'flex', minHeight: 48, overflowX: 'auto', gap: 8, margin: '18px 0', whiteSpace: 'nowrap' }}>
        {SCENES.map((name, index) => (!demo || index !== DEMO_HIDDEN_SCENE - 1) && (
          <button key={name} type="button" aria-current={scene === index + 1 ? 'page' : undefined} onClick={() => selectScene(index + 1)}
            style={{ flexShrink: 0, minHeight: 48, padding: '8px 16px', fontSize: 18, borderRadius: 8, border: '1px solid #7188a5', color: '#fff', background: scene === index + 1 ? '#22558b' : '#203147' }}>
            {toPublicText(`${index + 1} ${name}`)}
          </button>
        ))}
      </nav>
      {SCENES.map((name, index) => (
        <section key={name} data-inside-scene={index + 1} hidden={scene !== index + 1} aria-label={toPublicText(`${index + 1} ${name}`)} style={{ minWidth: 0 }}>
          {index === 0 ? <ArchitectureScene /> : index === 1 ? liveTrace : index === 2 ? loopScene : index === 3 ? editorScene : index === 5 ? ptyScene : <p>{toPublicText('방문자가 한 줄로 요청하면 조사 → 커넥터·스킬·그래프 생성 → 시험 → 마켓 게시까지 이어지는 장면 — 마법사 연결 뒤 이 자리에서 실행됩니다')}</p>}
        </section>
      ))}
    </main>
  );
}

function LivePtyDecisionScene() {
  const { client } = useDaemon();
  const [source, setSource] = useState(() => ({ client, decisions: EMPTY_DECISIONS }));
  useEffect(() => {
    let active = true;
    setSource({ client, decisions: EMPTY_DECISIONS });
    const unsubscribe = subscribePtyDecisions(client, event => {
      if (active) setSource(previous => ({
        client,
        decisions: reduceDecisions(previous.client === client ? previous.decisions : EMPTY_DECISIONS, event),
      }));
    });
    return () => { active = false; unsubscribe(); };
  }, [client]);
  return <PtyDecisionScene client={client} decisions={source.client === client ? source.decisions : EMPTY_DECISIONS} />;
}
