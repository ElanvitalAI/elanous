'use client';

import { useState } from 'react';
import graphView from '../../../../../plugins/graph-instance-view/fixtures/graph.view.json';
import harnessView from '../../../../../plugins/graph-instance-view/fixtures/harness.view.json';
import releaseView from '../../../../../plugins/graph-instance-view/fixtures/release.view.json';
import resourceView from '../../../../../plugins/graph-instance-view/fixtures/resource.view.json';
import { GraphInstanceRichView, type GraphInstanceView } from './GraphInstanceRichView';

// Source: R-SURFACE's shared JSON v1 fixtures. This screen is a test-world replay.
const VIEWS = {
  graph: graphView as GraphInstanceView,
  harness: harnessView as GraphInstanceView,
  release: releaseView as GraphInstanceView,
  resource: resourceView as GraphInstanceView,
};

const LABELS = { graph: '일반 그래프', harness: '하니스', release: '발행 그래프', resource: '자원 현황' } as const;

export function GraphInstanceSimulationScreen() {
  const [source, setSource] = useState<keyof typeof VIEWS>('graph');
  return <main className="mx-auto w-full max-w-7xl space-y-4 p-4">
    <div>
      <p className="text-xs font-medium text-primary">테스트 우주 · 같은 JSON v1 재생</p>
      <h1 className="text-xl font-semibold">그래프 인스턴스</h1>
    </div>
    <div role="group" aria-label="인스턴스 출처" className="flex flex-wrap gap-2">
      {(Object.keys(VIEWS) as Array<keyof typeof VIEWS>).map(key =>
        <button key={key} type="button" aria-pressed={source === key} onClick={() => setSource(key)}
          className={`rounded border px-3 py-1.5 text-sm ${source === key ? 'border-primary bg-primary/10' : 'border-border'}`}>{LABELS[key]}</button>)}
    </div>
    <GraphInstanceRichView view={VIEWS[source]} />
  </main>;
}
