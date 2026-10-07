'use client';

import { useState, type ComponentType } from 'react';
import type { GraphKindEntry } from '@/nexus/client';
import { RunGraphView } from '@/components/workflows/RunGraphView';
import { WorkflowsPanel } from '@/components/workflows/WorkflowsPanel';
import { CORE_GRAPH_KINDS, CORE_WORKFLOW_KINDS } from '@/lib/run-graph-yaml-edit';

const graphPalette = CORE_GRAPH_KINDS.map((kind) => ({
  graph: 'harness' as const, kind, plugin: null, description: '', schema: {}, core: true,
}));
const workflowPalette = CORE_WORKFLOW_KINDS.map((kind) => ({
  graph: 'workflow' as const, kind, plugin: null, description: '', schema: {}, core: true,
}));

type Editor = ComponentType<{ palette?: GraphKindEntry[]; initialGraphId?: string }>;

export function GraphEditorScene({
  GraphEditor = RunGraphView,
  WorkflowEditor = WorkflowsPanel,
}: {
  GraphEditor?: Editor;
  WorkflowEditor?: Editor;
} = {}) {
  const [mode, setMode] = useState<'harness' | 'workflow'>('harness');

  return (
    <section aria-label="그래프 편집기" className="flex h-full min-h-[640px] min-w-0 flex-col">
      <div role="tablist" aria-label="그래프 편집 모드" className="flex shrink-0 gap-2 border-b border-border px-4 py-3">
        {(['harness', 'workflow'] as const).map((entry) => (
          <button key={entry} type="button" role="tab" id={`inside-editor-tab-${entry}`}
            aria-controls={`inside-editor-panel-${entry}`} aria-selected={mode === entry}
            onClick={() => setMode(entry)}
            className={`rounded-lg px-4 py-2 text-lg min-[1440px]:text-[22px] ${mode === entry ? 'bg-accent/15 text-text-primary' : 'text-text-tertiary hover:bg-surface-elevated'}`}>
            {entry === 'harness' ? '실행 그래프' : '워크플로'}
          </button>
        ))}
      </div>
      <div id="inside-editor-panel-harness" role="tabpanel" aria-labelledby="inside-editor-tab-harness"
        hidden={mode !== 'harness'} className={mode === 'harness' ? 'min-h-0 min-w-0 flex-1 overflow-x-auto' : 'hidden'}>
        <div className="flex h-full min-h-[640px] min-w-[700px] flex-col min-[700px]:min-w-0">
          <GraphEditor palette={graphPalette} initialGraphId="self-implement" />
        </div>
      </div>
      <div id="inside-editor-panel-workflow" role="tabpanel" aria-labelledby="inside-editor-tab-workflow"
        hidden={mode !== 'workflow'} className={mode === 'workflow' ? 'min-h-0 min-w-0 flex-1 overflow-x-auto' : 'hidden'}>
        <div className="flex h-full min-h-[640px] min-w-[700px] flex-col min-[700px]:min-w-0">
          <WorkflowEditor palette={workflowPalette} />
        </div>
      </div>
    </section>
  );
}
