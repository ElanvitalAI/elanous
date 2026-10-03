'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import type { GraphKindEntry } from '@/nexus/client';
import { WorkflowsPanel } from '@/components/workflows/WorkflowsPanel';
import { RunGraphView } from '@/components/workflows/RunGraphView';
import { CORE_GRAPH_KINDS, CORE_WORKFLOW_KINDS } from '@/lib/run-graph-yaml-edit';
import { graphEditorHref, resolveGraphEditorMode, type GraphEditorMode } from './graph-editor-mode';

function PaletteContents({ palette, fallback }: { palette: GraphKindEntry[]; fallback: boolean }) {
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <strong>노드 팔레트</strong>
      {palette.map((entry) => (
        <span key={`${entry.plugin ?? 'core'}:${entry.kind}`} title={entry.description}
          className="rounded border border-border px-2 py-0.5">
          {entry.kind} {entry.plugin && <small className="rounded bg-accent/15 px-1 text-accent">{entry.plugin}</small>}
        </span>
      ))}
    </div>
    {fallback && <p role="status" className="mt-1 text-warning">어휘 목록을 불러오지 못해 코어 팔레트를 표시합니다.</p>}
  </>;
}

export function GraphEditorPalette({ palette, fallback }: { palette: GraphKindEntry[]; fallback: boolean }) {
  return <>
    <details className="border-b border-border px-3 py-2 text-xs min-[640px]:hidden" aria-label="노드 팔레트">
      <summary className="cursor-pointer">노드 더하기 ({palette.length})</summary>
      <div className="mt-2"><PaletteContents palette={palette} fallback={fallback} /></div>
    </details>
    <div className="hidden border-b border-border px-3 py-2 text-xs min-[640px]:block" aria-label="노드 팔레트">
      <PaletteContents palette={palette} fallback={fallback} />
    </div>
  </>;
}

export function GraphEditor() {
  const params = useSearchParams();
  const mode = resolveGraphEditorMode(params.get('mode'));
  const client = useOptionalNexusClient();
  const kinds = useQuery({
    queryKey: ['graph-kinds', mode],
    queryFn: () => client!.getGraphKinds(mode),
    enabled: client !== null,
    retry: false,
  });
  const palette = useMemo(() => kinds.data?.kinds.length ? kinds.data.kinds :
    (mode === 'harness' ? CORE_GRAPH_KINDS : CORE_WORKFLOW_KINDS).map((kind) => ({
      graph: mode, kind, plugin: null, description: '', schema: {}, core: true,
    })), [kinds.data, mode]);
  const fallback = kinds.isError || (kinds.isSuccess && !kinds.data.kinds.length);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h1 className="text-sm font-semibold">편집기</h1>
        <nav aria-label="그래프 편집 모드" className="flex gap-1">
          {(['workflow', 'harness'] as const).map((entry: GraphEditorMode) => (
            <a key={entry} href={graphEditorHref(entry)}
              aria-current={mode === entry ? 'page' : undefined}
              className={`rounded px-3 py-1 text-xs ${mode === entry ? 'bg-accent/15 text-text-primary' : 'text-text-tertiary hover:bg-surface-elevated'}`}>
              {entry === 'workflow' ? '워크플로' : '실행 그래프'}
            </a>
          ))}
        </nav>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {client && <GraphEditorPalette palette={palette} fallback={fallback} />}
        {mode === 'workflow' ? <WorkflowsPanel palette={palette} /> : client ? <RunGraphView palette={palette} /> :
          <p className="p-4 text-sm text-text-tertiary">Daemon 연결이 설정되지 않았습니다. Settings 에서 Base URL 을 입력하세요.</p>}
      </div>
    </div>
  );
}
