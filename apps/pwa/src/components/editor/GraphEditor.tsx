'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { NexusApiError, type GraphKindEntry, type NexusClient } from '@/nexus/client';
import { WorkflowsPanel } from '@/components/workflows/WorkflowsPanel';
import { RunGraphView } from '@/components/workflows/RunGraphView';
import { CORE_GRAPH_KINDS, CORE_WORKFLOW_KINDS } from '@/lib/run-graph-yaml-edit';
import { graphEditorHref, resolveGraphEditorMode, type GraphEditorMode } from './graph-editor-mode';
import { GraphCanvasEditor } from './GraphCanvasEditor';
import { GraphRunControl } from './GraphRunControl';
import type { NodeRunStatus } from '@/components/workflows/run-status-helpers';
import { fromYaml, type CanvasGraph } from './graph-canvas-model';
import { GraphWizardChat, GraphWizardEntry } from './GraphWizardChat';
import type { WizardClient } from './graph-wizard';
import { useWizardCanvas } from './use-wizard-canvas';

/** The run-graph tab's working canvas: a new empty graph, or a «mine» graph opened for editing.
 *  `wizardPrompt` — GRAPH-WIZARD: the line typed on the «말로 만들기» entry, sent as the chat's first turn. */
type CanvasSession = { key: number; graph?: CanvasGraph; saved: boolean; wizardPrompt?: string };

/** A client without the wizard (a stub) answers like an older daemon. */
function wizardClientOf(client: NexusClient): WizardClient {
  const ask = client.graphWizard;
  return ask ? { graphWizard: (body, opts) => ask(body, opts) } : { graphWizard: async () => { throw new NexusApiError(404, '/v1/graphs/wizard', null); } };
}

/** `?mode=harness&wizard=<prompt>` — the workflow tab's entry hands its prompt to the canvas. */
export function graphWizardHref(prompt: string): string {
  return `${graphEditorHref('harness')}&wizard=${encodeURIComponent(prompt)}`;
}

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
  const queries = useQueryClient();
  const [canvas, setCanvas] = useState<CanvasSession | null>(null);
  const [runStatus, setRunStatus] = useState<Record<string, NodeRunStatus> | undefined>(undefined);
  const wizard = useWizardCanvas();
  /** The canvas is in «wizard mode» once a chat turn has landed on it (or it opened with a prompt). */
  const [wizardDriven, setWizardDriven] = useState(false);
  const openCanvas = useCallback((session: Omit<CanvasSession, 'key'>) => {
    wizard.reset();
    setWizardDriven(Boolean(session.wizardPrompt));
    setCanvas({ key: Date.now(), ...session });
  }, [wizard.reset]);
  // `?wizard=<prompt>` opens the canvas once per prompt — a client re-render must not wipe the work.
  const wizardParam = params.get('wizard');
  const handledWizardParam = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== 'harness' || !wizardParam || !client || handledWizardParam.current === wizardParam) return;
    handledWizardParam.current = wizardParam;
    openCanvas({ saved: false, wizardPrompt: wizardParam });
  }, [mode, wizardParam, client, openCanvas]);
  const onRunStatus = useCallback((status: Record<string, NodeRunStatus> | undefined) => setRunStatus(status), []);
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
        {client && !(mode === 'harness' && canvas) && <GraphEditorPalette palette={palette} fallback={fallback} />}
        {client && !(mode === 'harness' && canvas) && (
          <GraphWizardEntry onStart={(prompt) => {
            if (mode === 'harness') openCanvas({ saved: false, wizardPrompt: prompt });
            else window.location.assign(graphWizardHref(prompt));
          }} />
        )}
        {mode === 'workflow' ? <WorkflowsPanel palette={palette} /> : client && canvas ? (
          <>
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
              <button type="button" onClick={() => { setCanvas(null); setRunStatus(undefined); }} className="rounded px-2 py-1 text-muted-foreground hover:bg-muted">← 그래프 목록</button>
              {fallback && <span role="status" className="text-amber-500">어휘 목록을 불러오지 못해 코어 팔레트를 씁니다.</span>}
            </div>
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col max-lg:overflow-y-auto">
                <GraphCanvasEditor key={canvas.key} palette={palette} client={client} wizardMode={wizardDriven}
                  {...(canvas.graph ? { initialGraph: canvas.graph, initialSaved: canvas.saved } : {})}
                  {...(runStatus ? { nodeStatus: runStatus } : {})}
                  {...(wizard.replace ? { replace: wizard.replace } : {})}
                  {...(wizard.highlight ? { highlight: wizard.highlight } : {})}
                  nodeLabels={wizard.labels}
                  {...(wizard.steps ? { wizardSteps: wizard.steps } : {})}
                  onChange={wizard.onChange}
                  renderActions={(context) => <GraphRunControl context={context} client={client} onStatus={onRunStatus} />}
                  onSaved={() => { void queries.invalidateQueries({ queryKey: ['run-graphs'] }); }} />
              </div>
              <GraphWizardChat key={canvas.key} client={wizardClientOf(client)} current={wizard.current} laid={wizard.laid}
                onApply={(graph, added, autoLayout, labels, steps) => { setWizardDriven(true); wizard.apply(graph, added, autoLayout, labels, steps); }} onRestore={wizard.restore}
                {...(canvas.wizardPrompt ? { initialPrompt: canvas.wizardPrompt } : {})} />
            </div>
          </>
        ) : client ? (
          <RunGraphView palette={palette}
            onNewGraph={() => openCanvas({ saved: false })}
            onOpenInCanvas={(_id, yaml) => openCanvas({ graph: fromYaml(yaml), saved: true })} />
        ) :
          <p className="p-4 text-sm text-text-tertiary">Daemon 연결이 설정되지 않았습니다. Settings 에서 Base URL 을 입력하세요.</p>}
      </div>
    </div>
  );
}
