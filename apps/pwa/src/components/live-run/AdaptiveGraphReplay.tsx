'use client';

import { useEffect, useState } from 'react';
import { changedNodeIds, frameAt, type AdaptiveGraphDiff, type AdaptiveGraphReplay } from '@/lib/adaptive-graph-replay';

const OP_WORD: Record<AdaptiveGraphDiff['op'], string> = { add: '추가', remove: '제거', replace: '교체' };
const STATE_WORD = { active: '현재 판', invalidated: '무효화', superseded: '대체됨' } as const;

function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
}

export function AdaptiveGraphReplayView({ replay }: { replay: AdaptiveGraphReplay }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const frame = frameAt(replay, index);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (index >= replay.frames.length - 1) { setPlaying(false); return; }
      setIndex(index + 1);
      setSelectedNode(null);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [playing, index, replay.frames.length]);
  if (!frame) return <p role="status" className="p-4 text-sm">재생할 그래프 판이 없습니다.</p>;
  const changed = changedNodeIds(frame);
  const selectFrame = (next: number) => { setIndex(next); setPlaying(false); setSelectedNode(null); };
  const showNode = (id: string) => { setSelectedNode(id); setShowGraph(true); };

  return <main data-testid="adaptive-graph-replay" data-revision={frame.revision} className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-3 p-3 text-text-primary sm:p-5">
    <header className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-text-secondary">적응형 그래프 · {replay.runId}</p>
        <h1 className="text-lg font-semibold">판이 바뀌는 이유</h1>
      </div>
      {replay.simulated && <span className="rounded-full border border-amber-500/40 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">시뮬레이션 재생</span>}
      <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-xs font-semibold">{frame.revision} · {frame.label}</span>
    </header>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" aria-label={playing ? '재생 일시정지' : '재생 시작'} onClick={() => { if (index === replay.frames.length - 1) setIndex(0); setPlaying(!playing); }} className="rounded border border-border px-3 py-1.5">{playing ? '⏸ 일시정지' : '▶ 재생'}</button>
      <button type="button" disabled={index === 0} onClick={() => selectFrame(index - 1)} className="rounded border border-border px-2 py-1.5 disabled:opacity-40">이전 판</button>
      <button type="button" disabled={index === replay.frames.length - 1} onClick={() => selectFrame(index + 1)} className="rounded border border-border px-2 py-1.5 disabled:opacity-40">다음 판</button>
      <label className="flex min-w-[130px] flex-1 items-center gap-2"><span>판 {index + 1}/{replay.frames.length}</span><input aria-label="그래프 판 위치" type="range" min="0" max={replay.frames.length - 1} value={index} onChange={(event) => selectFrame(Number(event.target.value))} className="min-w-0 flex-1" /></label>
    </div>

    <div className="flex min-h-0 flex-1 flex-col gap-3 md:grid md:grid-rows-[minmax(360px,2fr)_minmax(240px,1fr)]">
      <section aria-label="그래프 판" className={`${showGraph ? 'block' : 'hidden'} order-2 min-h-[320px] rounded-xl border border-border bg-surface p-3 md:order-none md:block md:min-h-0 md:overflow-y-auto`}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div><h2 className="font-semibold">그래프 {frame.revision}</h2><p className="text-xs text-text-secondary">노드를 누르면 바뀐 이유를 볼 수 있습니다.</p></div>
          <button type="button" onClick={() => setShowGraph(false)} className="rounded border border-border px-2 py-1 text-xs md:hidden">접기</button>
        </div>
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {frame.nodes.map((node, position) => <li key={node.id}>
            <button type="button" data-testid={`adaptive-node-${node.id}`} data-node-state={node.state} data-changed={changed.has(node.id) ? 'true' : 'false'}
              onClick={() => setSelectedNode(node.id)} className={`h-full w-full rounded-lg border p-3 text-left ${selectedNode === node.id ? 'border-primary ring-2 ring-primary/40' : changed.has(node.id) ? 'border-sky-500/60 bg-sky-500/5' : 'border-border'} ${node.state === 'active' ? '' : 'opacity-55'}`}>
              <span className="text-[11px] text-text-tertiary">{String(position + 1).padStart(2, '0')} · {STATE_WORD[node.state]}</span>
              <span className={`mt-1 block text-sm font-semibold ${node.state === 'active' ? '' : 'line-through'}`}>{node.label}</span>
              {node.why && <span className="mt-1 block text-xs text-text-secondary">왜 · {node.why}</span>}
            </button>
          </li>)}
        </ol>
      </section>

      <div className="order-1 grid min-h-0 gap-3 md:order-none md:grid-cols-[minmax(220px,1fr)_minmax(0,1.5fr)]">
        <section aria-label="판 타임라인" className="rounded-xl border border-border bg-surface p-3 md:overflow-y-auto">
          <h2 className="mb-2 text-sm font-semibold">판 타임라인</h2>
          <ol className="space-y-2">
            {replay.frames.map((item, position) => <li key={`${item.revision}:${position}`}>
              <button type="button" data-testid={`adaptive-frame-${position}`} aria-current={position === index ? 'step' : undefined} onClick={() => selectFrame(position)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs ${position === index ? 'border-primary bg-primary/10' : 'border-border'}`}>
                <span className="font-semibold">{item.revision} · {item.label}</span>
                <span className="ml-2 text-text-tertiary">{item.diff.length}개 변경</span>
              </button>
            </li>)}
          </ol>
        </section>
        <div className="space-y-3 md:overflow-y-auto">
          <section aria-label="판 변경분" className="rounded-xl border border-border bg-surface p-3">
            <h2 className="mb-2 text-sm font-semibold">{frame.revision} 변경분</h2>
            {frame.diff.length === 0 ? <p className="text-xs text-text-secondary">이 판의 구조 변경은 없습니다.</p> : <ul className="space-y-2">{frame.diff.map((change, position) => <li key={`${change.op}:${change.nodeId}:${position}`} className="rounded border border-border/70 p-2 text-xs">
              <span className="font-semibold">{OP_WORD[change.op]} · {change.from && change.to ? `${change.from} → ${change.to}` : change.nodeId}</span>
              <span className="block text-text-secondary">왜 · {change.why}</span>
            </li>)}</ul>}
          </section>
          <section aria-label="결론 카드" className="rounded-xl border border-primary/30 bg-primary/5 p-3">
            <h2 className="text-sm font-semibold">{frame.conclusion?.title ?? '결론을 만드는 중'}</h2>
            <p className="mt-1 text-sm">{frame.conclusion?.summary ?? '근거를 모으고 반대 견해를 확인하고 있습니다.'}</p>
            {frame.conclusion?.forecast && <p className="mt-2 text-xs">전망 · {frame.conclusion.forecast}</p>}
            {frame.conclusion?.recommendation && <p className="mt-1 text-xs">{frame.conclusion.recommendation}</p>}
            {frame.conclusion?.evidence && <p className="mt-2 text-xs">근거 · {frame.conclusion.evidence}</p>}
            {frame.conclusion?.counterEvidence && <p className="mt-1 text-xs">반대 근거 · {frame.conclusion.counterEvidence}</p>}
            {frame.conclusion?.sources && <div className="mt-2 flex flex-wrap gap-2">{frame.conclusion.sources.map((source) => {
              const href = safeSourceUrl(source.url);
              return href ? <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="text-xs underline">출처 · {source.label}</a> : null;
            })}</div>}
            <p className="mt-2 text-[11px] text-text-tertiary">정보 제공·판단 보조이며 투자 권유 아님 · 시뮬레이션·지연 시세</p>
          </section>
          {!!frame.bloomQuestions?.length && <section aria-label="Bloom 질문 카드" className="rounded-xl border border-border bg-surface p-3">
            <h2 className="mb-2 text-sm font-semibold">엘라누스가 스스로 만든 질문</h2>
            <ul className="space-y-2">{frame.bloomQuestions.map((question) => <li key={question.id} className="text-xs">
              <span className="font-semibold">{question.level === 4 ? '분석' : '평가'} · </span>{question.text}
              <button type="button" onClick={() => showNode(question.sourceNodeId)} className="ml-2 text-primary underline">낳은 노드 보기</button>
            </li>)}</ul>
          </section>}
          <button type="button" onClick={() => setShowGraph(!showGraph)} className="w-full rounded-lg border border-primary px-3 py-2 text-sm font-semibold text-primary md:hidden">{showGraph ? '그래프 접기' : '그래프 보기'}</button>
        </div>
      </div>
    </div>
  </main>;
}
