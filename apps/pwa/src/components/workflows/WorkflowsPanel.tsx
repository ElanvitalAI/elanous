// Archon-port T2A (2026-05-08) — PWA /workflows top-level panel.
//
// Single-page editor with a 3-pane layout:
//   left   : workflow list (project/global/builtin grouped)
//   center : raw YAML textarea (no CodeMirror dep — keeps the bundle
//            light; live validation via debounced API call gives
//            inline feedback that's good enough for MVP)
//   right  : run panel (arguments input + Run button + last run
//            event log + outputs)
//
// Phase 2 (T2B, deferred) will replace the textarea with a ReactFlow
// visual builder. The list + run panel survive that move.

'use client';

import { newWorkflowNameProblem, withWorkflowName, workflowSaveErrorText } from './workflow-save';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GitBranch,
  Play,
  Save,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Loader2,
  FileCode2,
  GitGraph,
  History,
  Bell,
  Sparkles,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import {
  useWorkflows,
  useWorkflow,
  useSaveWorkflow,
  useDeleteWorkflow,
  useValidateWorkflow,
  useStartWorkflow,
  useWorkflowRun,
  useWorkflowRuns,
  usePendingApprovals,
  useWorkflowEvents,
} from '@/nexus/hooks/use-workflows';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import type {
  GraphKindEntry,
  WorkflowSummary,
  WorkflowRunEvent,
} from '@/nexus/client';
import { WorkflowGraph } from './WorkflowGraph';
import { WorkflowNLPrompt } from './WorkflowNLPrompt';
import { WorkflowNodeEditor } from './WorkflowNodeEditor';
import {
  definitionToYaml,
  deleteNode as defDeleteNode,
  safeParseWorkflowYaml,
} from './workflow-graph-mutations';
import { extractNodeStatuses, pickLatestRun } from './run-status-helpers';
import { detectCycle, groupIssuesByNodeId } from './validation-helpers';
import { RunsListPanel } from './RunsListPanel';
import { ApprovalModal } from './ApprovalModal';
import { LEFT_RAIL_WIDTH_PX, RIGHT_RAIL_WIDTH_PX, usePanelLayout } from './usePanelLayout';

const SOURCE_LABEL: Record<WorkflowSummary['source'], string> = {
  project: 'Project',
  global: 'Global',
  builtin: 'Built-in',
};

const NEW_WORKFLOW_TEMPLATE = `name: my-workflow
description: |
  Use when: …
  Triggers: …
  Does: …
  NOT for: …

provider: claude
model: sonnet

nodes:
  - id: first
    bash: echo hello
`;

export function WorkflowsPanel({ palette }: { palette?: GraphKindEntry[] } = {}) {
  // SSG safety (Archon-port follow-up · 2026-05-08): the static export
  // prerenders this page without a NexusProvider in scope, so any
  // `useNexusClient`-bound hook would throw and abort `next build`.
  // We gate the heavy panel behind an optional-client check; settings
  // cards (ConnectTokenCard / QuickSetupCard / WelcomeCard) use the
  // same pattern. The placeholder is also what real users without a
  // configured baseUrl see on first paint.
  const optionalClient = useOptionalNexusClient();
  if (!optionalClient) return <WorkflowsUnconfigured />;
  return <WorkflowsPanelInner palette={palette} />;
}

function WorkflowsUnconfigured() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <GitBranch className="h-8 w-8 text-text-tertiary" />
      <h2 className="text-base font-semibold">Workflows</h2>
      <p className="max-w-md text-sm text-text-tertiary">
        Daemon 연결이 설정되지 않았습니다. Settings 에서 Base URL 을
        입력하면 워크플로우 목록이 표시됩니다.
      </p>
      <a
        href="/app/settings/"
        className="rounded-md border border-border px-3 py-1 text-sm text-text-primary hover:bg-surface-elevated"
      >
        Settings
      </a>
    </div>
  );
}

function WorkflowsPanelInner({ palette }: { palette?: GraphKindEntry[] }) {
  const list = useWorkflows();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draftYaml, setDraftYaml] = useState<string>('');
  const [args, setArgs] = useState<string>('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  // Keep the YAML subview available for raw edits; open the existing graph editor first.
  const [editorMode, setEditorMode] = useState<'yaml' | 'graph'>('graph');
  // §5.2 follow-up — Active Runs view replaces the editor pane
  // entirely while toggled. Picking a run row swaps it back to the
  // editor with the run loaded into the right panel.
  const [showRunsList, setShowRunsList] = useState(false);
  // ROADMAP Tier 1 W1 (2026-05-11) — natural-language workflow generator.
  const [showNLPrompt, setShowNLPrompt] = useState(false);
  // ROADMAP Tier 1 W2 (2026-05-11) — inline node editor selection.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // ROADMAP Tier 2 W5 (2026-05-11) — fitView target on issue click.
  // Bumped each time we want the graph to refocus (re-using the same
  // nodeId would short-circuit the effect; we pair it with a counter
  // to make repeat clicks fire).
  const [focusTarget, setFocusTarget] = useState<{ id: string; nonce: number } | null>(null);

  const detail = useWorkflow(selectedName ?? '', { enabled: !!selectedName && !creatingNew });
  const save = useSaveWorkflow();
  const remove = useDeleteWorkflow();
  const validateMut = useValidateWorkflow();
  const startRun = useStartWorkflow();
  // Tier 2 W4 (2026-05-11) — list of run summaries powers the last-run
  // overlay on the graph. We look up the latest run for the currently
  // selected workflow (regardless of whether the user kicked it off in
  // this session) so the per-node ✓/✗/⏸/· dots show up the moment a
  // workflow is opened.
  const runsList = useWorkflowRuns();
  const latestRunForSelected = useMemo(() => {
    if (!selectedName || !runsList.data?.runs) return null;
    return pickLatestRun(runsList.data.runs, selectedName)?.runId ?? null;
  }, [selectedName, runsList.data?.runs]);
  // When the user starts a run in-session, prefer that (it's live
  // ahead of the runsList query revalidation). Otherwise fall back to
  // the latest run on disk.
  const overlayRunId = activeRunId ?? latestRunForSelected;
  const runDetail = useWorkflowRun(overlayRunId);
  const nodeStatuses = useMemo(() => {
    if (!runDetail.data?.events) return undefined;
    return extractNodeStatuses(runDetail.data.events);
  }, [runDetail.data?.events]);
  // §5.1 — when the active run is parked on an approval node, the
  // server registers it in the pending list. Polled @1s. The poll
  // also runs when no run is active so a user can see if any
  // background runs need approval (e.g. after closing + reopening
  // /workflows). The header bell shows the global count; the modal
  // is scoped to activeRunId so users don't get popups from runs
  // they aren't focused on.
  const pending = usePendingApprovals();
  // BACKLOG #9 + §15.8(b) — unified SSE-driven push for both approval
  // lifecycle (pendingApprovals) and run lifecycle (workflowRuns +
  // workflowRun(runId)). HANDOFF §4.2 follow-up consolidated the two
  // streams into one EventSource. Polling stays on as safety net.
  useWorkflowEvents();
  const activeApproval = useMemo(
    () => (pending.data?.pending ?? []).find((p) => p.runId === activeRunId) ?? null,
    [pending.data, activeRunId],
  );
  const pendingCount = pending.data?.pending.length ?? 0;
  const [approvalDismissed, setApprovalDismissed] = useState<Set<string>>(new Set());
  // Reset dismissal tracking when the active run flips so the modal
  // re-opens automatically on the new run's pending approval.
  useEffect(() => {
    setApprovalDismissed(new Set());
  }, [activeRunId]);
  /** Re-open the modal for the active run's approval (clears the
   *  dismiss flag for that runId). */
  const reopenActiveApproval = (): void => {
    if (!activeApproval) return;
    setApprovalDismissed((prev) => {
      const next = new Set(prev);
      next.delete(activeApproval.runId);
      return next;
    });
  };
  /** Click the bell when no active approval but other runs are
   *  waiting → switch the active run to the first pending one (the
   *  user wanted to see _some_ approval). */
  const handleBellClick = (): void => {
    if (activeApproval && approvalDismissed.has(activeApproval.runId)) {
      reopenActiveApproval();
      return;
    }
    const first = pending.data?.pending[0];
    if (first && first.runId !== activeRunId) {
      setActiveRunId(first.runId);
    }
  };

  // When the active workflow detail loads, hydrate the draft.
  useEffect(() => {
    if (creatingNew) return;
    if (detail.data?.yaml !== undefined) {
      setDraftYaml(detail.data.yaml);
    }
  }, [detail.data?.yaml, creatingNew]);

  // Debounced live validation — fires 600ms after the last edit.
  // Caveat #5 follow-up (2026-05-08): in-flight requests are aborted
  // when the user keeps typing so a stale "Validating…" badge doesn't
  // outlive the typing burst that triggered it.
  const validateAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!draftYaml.trim()) return;
    const t = setTimeout(() => {
      validateAbortRef.current?.abort();
      const ctrl = new AbortController();
      validateAbortRef.current = ctrl;
      void validateMut
        .mutateAsync({ yaml: draftYaml, signal: ctrl.signal })
        .catch(() => undefined);
    }, 600);
    return () => {
      clearTimeout(t);
      validateAbortRef.current?.abort();
    };
    // We don't include validateMut in deps — the mutation hook is
    // stable and including it triggers a re-fire loop with TanStack
    // Query's referential equality.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftYaml]);

  const lists = useMemo(() => {
    const buckets: Record<WorkflowSummary['source'], WorkflowSummary[]> = {
      project: [],
      global: [],
      builtin: [],
    };
    for (const w of list.data?.workflows ?? []) {
      buckets[w.source].push(w);
    }
    return buckets;
  }, [list.data?.workflows]);

  const validation = validateMut.data?.validation;
  const issues = validation && !validation.ok ? validation.issues : [];

  // ROADMAP Tier 2 W5 — group issues by nodeId for the inline ⚠ badge
  // and detect cycles on the local draft so the user sees the offending
  // loop without waiting for server validation to flag it. Parsing
  // failure (raw YAML still being typed) → no grouping / no cycle.
  const parsedForGraph = useMemo(
    () => (draftYaml.trim() ? safeParseWorkflowYaml(draftYaml) : null),
    [draftYaml],
  );
  const nodeIssues = useMemo(() => {
    if (!parsedForGraph || issues.length === 0) return undefined;
    return groupIssuesByNodeId(issues, parsedForGraph).byNodeId;
  }, [parsedForGraph, issues]);
  const cycleNodeIds = useMemo(() => {
    if (!parsedForGraph) return undefined;
    const cyc = detectCycle(parsedForGraph);
    return cyc.size > 0 ? cyc : undefined;
  }, [parsedForGraph]);

  const handleSelect = (name: string) => {
    setSelectedName(name);
    setCreatingNew(false);
    setActiveRunId(null);
    setSelectedNodeId(null);
  };

  const handleNew = () => {
    setCreatingNew(true);
    setSelectedName(null);
    setNewName('');
    setDraftYaml(NEW_WORKFLOW_TEMPLATE);
    setActiveRunId(null);
    setSelectedNodeId(null);
  };

  const handleSave = async () => {
    setSaveError(null);
    if (creatingNew) {
      const problem = newWorkflowNameProblem(newName);
      if (problem) { setSaveError(problem); return; }
    }
    const targetName = creatingNew ? newName.trim() : selectedName;
    if (!targetName) return;
    // The daemon rejects a body whose `name:` differs from the path (422 name mismatch) —
    // a new workflow's YAML still says `my-workflow` until we write the typed name into it.
    const yaml = creatingNew ? withWorkflowName(draftYaml, targetName) : draftYaml;
    if (yaml !== draftYaml) setDraftYaml(yaml);
    try {
      await save.mutateAsync({
        name: targetName,
        body: { yaml, scope: 'project' },
      });
      setCreatingNew(false);
      setSelectedName(targetName);
    } catch (err) {
      setSaveError(workflowSaveErrorText(err));
    }
  };

  const handleRun = async () => {
    if (!selectedName) return;
    try {
      const result = await startRun.mutateAsync({ name: selectedName, args });
      setActiveRunId(result.runId);
    } catch {
      // surfaces in badge
    }
  };

  const handleDelete = async () => {
    if (!selectedName) return;
    if (detail.data?.source === 'builtin') return;
    const scope = detail.data?.source === 'global' ? 'global' : 'project';
    try {
      await remove.mutateAsync({ name: selectedName, scope });
      setSelectedName(null);
      setDraftYaml('');
    } catch {
      // surfaces in badge
    }
  };

  const isReadonly = detail.data?.source === 'builtin';
  const validationStatus: 'ok' | 'error' | 'pending' | 'idle' =
    validateMut.isPending
      ? 'pending'
      : validation
        ? validation.ok
          ? 'ok'
          : 'error'
        : 'idle';

  // Ergonomic-port Tier E1.1 (2026-05-11) — pane layout state. Replaces
  // the hard-coded grid 3/6/3 with collapsible panes + drag-resize +
  // canvas-only toggle (N shortcut). Persisted to localStorage so the
  // user's preferred layout survives a reload.
  const layout = usePanelLayout();
  const showLeft = !layout.canvasOnly;
  const showRight = !layout.canvasOnly;
  const leftWidth = layout.leftCollapsed ? LEFT_RAIL_WIDTH_PX : layout.leftWidthPx;
  const rightWidth = layout.rightCollapsed ? RIGHT_RAIL_WIDTH_PX : layout.rightWidthPx;

  // Cmd/Ctrl + \ → canvas-only toggle. Skips when typing in an input /
  // textarea so the YAML editor / arguments box stay typeable.
  // (Tier E3.2 (2026-05-11): freed `N` for "new node" inside the
  // graph editor — see useKeyboardShortcuts wiring in WorkflowGraph.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '\\') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return;
      e.preventDefault();
      layout.toggleCanvasOnly();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layout]);

  // Drag-to-resize divider. Captures pointer for the duration of the
  // drag so the cursor stays consistent and the move callback fires
  // even when the pointer briefly leaves the divider element.
  const startResize = useCallback(
    (side: 'left' | 'right', start: { clientX: number; pointerId: number; target: HTMLElement }) => {
      const initial = side === 'left' ? layout.leftWidthPx : layout.rightWidthPx;
      const setter = side === 'left' ? layout.setLeftWidth : layout.setRightWidth;
      const sign = side === 'left' ? 1 : -1;
      try {
        start.target.setPointerCapture(start.pointerId);
      } catch {
        // ignore — pointer capture is best-effort
      }
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - start.clientX;
        setter(initial + sign * dx);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        try {
          start.target.releasePointerCapture(start.pointerId);
        } catch {
          // ignore
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [layout],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-text-tertiary" />
          <h1 className="text-sm font-semibold">Workflows</h1>
          <span className="text-xs text-text-tertiary">
            {list.data?.workflows.length ?? 0} declared
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={layout.toggleLeft}
            title={layout.leftCollapsed ? 'Show workflow list' : 'Collapse workflow list'}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-tertiary hover:bg-surface-elevated"
          >
            {layout.leftCollapsed ? <PanelLeftOpen className="h-3 w-3" /> : <PanelLeftClose className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={layout.toggleCanvasOnly}
            title={layout.canvasOnly ? 'Exit canvas-only (Cmd+\\)' : 'Canvas-only mode (Cmd+\\)'}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors ${
              layout.canvasOnly
                ? 'border-accent/50 bg-accent/15 text-accent'
                : 'border-border text-text-tertiary hover:bg-surface-elevated'
            }`}
          >
            {layout.canvasOnly ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={layout.toggleRight}
            title={layout.rightCollapsed ? 'Show run panel' : 'Collapse run panel'}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-tertiary hover:bg-surface-elevated"
          >
            {layout.rightCollapsed ? <PanelRightOpen className="h-3 w-3" /> : <PanelRightClose className="h-3 w-3" />}
          </button>
          {pendingCount > 0 && (
            <button
              type="button"
              onClick={handleBellClick}
              title={
                activeApproval && approvalDismissed.has(activeApproval.runId)
                  ? 'Re-open approval modal for this run'
                  : `${pendingCount} run(s) waiting on approval — click to view`
              }
              className="relative flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning hover:bg-warning/20"
            >
              <Bell className="h-3 w-3" />
              <span>{pendingCount}</span>
              <span className="absolute -right-1 -top-1 h-2 w-2 animate-pulse rounded-full bg-warning ring-2 ring-surface" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowRunsList((s) => !s)}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors ${
              showRunsList
                ? 'border-primary/40 bg-primary/15 text-primary'
                : 'border-border text-text-tertiary hover:bg-surface-elevated'
            }`}
          >
            <History className="h-3 w-3" />
            {showRunsList ? 'Editor' : 'All runs'}
          </button>
          <button
            type="button"
            onClick={() => setShowNLPrompt((v) => !v)}
            title={showNLPrompt ? 'Hide AI prompt' : 'Describe a workflow in plain text'}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors ${
              showNLPrompt
                ? 'border-accent/50 bg-accent/15 text-accent'
                : 'border-border text-text-tertiary hover:bg-surface-elevated'
            }`}
          >
            <Sparkles className="h-3 w-3" />
            AI
          </button>
          <button
            type="button"
            onClick={handleNew}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-accent-hover transition-colors"
          >
            + New
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: list (collapsed → narrow rail with vertical chevron) */}
        {showLeft && (
          <aside
            style={{ width: leftWidth }}
            className="shrink-0 overflow-y-auto border-r border-border"
          >
            {layout.leftCollapsed ? (
              <button
                type="button"
                onClick={layout.toggleLeft}
                title="Expand workflow list"
                className="flex h-full w-full items-center justify-center text-text-tertiary hover:bg-surface-elevated"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            ) : (
              (['project', 'global', 'builtin'] as const).map(scope => (
                <WorkflowGroup
                  key={scope}
                  label={SOURCE_LABEL[scope]}
                  entries={lists[scope]}
                  selected={selectedName}
                  onSelect={handleSelect}
                />
              ))
            )}
          </aside>
        )}

        {/* Drag-resize divider between left + center */}
        {showLeft && !layout.leftCollapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize workflow list"
            onPointerDown={(e) =>
              startResize('left', { clientX: e.clientX, pointerId: e.pointerId, target: e.currentTarget })
            }
            className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/30"
          />
        )}

        {/* Center: editor OR Runs list (§5.2 toggle via header) */}
        <section className="flex flex-1 flex-col overflow-hidden min-w-0">
          {showRunsList ? (
            <RunsListPanel
              selectedRunId={activeRunId}
              onSelect={(runId, workflowName) => {
                setActiveRunId(runId);
                // Also load the run's workflow into the editor so the
                // user lands somewhere coherent when toggling back to
                // Editor view. No-op when the workflow has been
                // deleted in the meantime — the right panel still
                // shows the run by id from disk hydration.
                setSelectedName(workflowName);
                setCreatingNew(false);
                setShowRunsList(false);
              }}
            />
          ) : (
          <>
          {showNLPrompt && (
            <WorkflowNLPrompt
              currentYaml={draftYaml}
              onClose={() => setShowNLPrompt(false)}
              onGenerated={(result) => {
                if (!result.yaml) return;
                setDraftYaml(result.yaml);
                if (result.definition?.name) {
                  // Generation produced a fresh workflow → flip into
                  // creatingNew so Save → PUT writes a new file.
                  setCreatingNew(true);
                  setSelectedName(null);
                  setNewName(result.definition.name);
                  setActiveRunId(null);
                }
              }}
            />
          )}
          {creatingNew && (
            <div className="border-b border-border px-3 py-2">
              <label className="block text-[10px] uppercase tracking-wide text-text-tertiary">
                Workflow name (kebab-case)
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="my-workflow"
                className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm font-mono"
                autoFocus
              />
            </div>
          )}
          {!creatingNew && selectedName && (
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{selectedName}</span>
                {isReadonly && (
                  <span className="rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-text-tertiary">
                    read-only (built-in)
                  </span>
                )}
                <EditorModeToggle mode={editorMode} onChange={setEditorMode} />
              </div>
              <div className="flex items-center gap-2">
                <ValidationBadge status={validationStatus} />
              </div>
            </div>
          )}
          {editorMode === 'graph' && draftYaml.trim() ? (
            <div className="flex flex-1 flex-col overflow-hidden bg-surface">
              <div className={selectedNodeId ? 'flex-1 min-h-[180px] overflow-hidden' : 'flex-1 overflow-hidden'}>
                <WorkflowGraph
                  palette={palette}
                  yaml={draftYaml}
                  editable={!isReadonly}
                  onChangeYaml={setDraftYaml}
                  onNodeClick={isReadonly ? undefined : (id) => setSelectedNodeId(id)}
                  nodeStatuses={nodeStatuses}
                  nodeIssues={nodeIssues}
                  cycleNodeIds={cycleNodeIds}
                  focusNodeId={focusTarget?.id ?? null}
                  focusNonce={focusTarget?.nonce ?? 0}
                  onRun={selectedName && !creatingNew ? handleRun : undefined}
                />
              </div>
              {selectedNodeId && !isReadonly && (() => {
                const parsedDef = safeParseWorkflowYaml(draftYaml);
                if (!parsedDef) return null;
                return (
                  <WorkflowNodeEditor
                    definition={parsedDef}
                    nodeId={selectedNodeId}
                    palette={palette}
                    onChange={(nextDef) => setDraftYaml(definitionToYaml(nextDef))}
                    onClose={() => setSelectedNodeId(null)}
                    onDelete={() => {
                      setDraftYaml(definitionToYaml(defDeleteNode(parsedDef, selectedNodeId)));
                      setSelectedNodeId(null);
                    }}
                  />
                );
              })()}
            </div>
          ) : (
            <textarea
              value={draftYaml}
              onChange={(e) => setDraftYaml(e.target.value)}
              readOnly={isReadonly}
              placeholder="Select a workflow on the left or click + New to start"
              spellCheck={false}
              className="flex-1 resize-none border-0 bg-surface px-3 py-2 font-mono text-xs leading-snug focus:outline-none"
            />
          )}
          {issues.length > 0 && (
            <ul className="max-h-32 overflow-y-auto border-t border-border bg-surface-elevated px-3 py-2 text-[11px]">
              {issues.slice(0, 8).map((issue, i) => {
                // ROADMAP Tier 2 W5 — clickable issue rows. When the
                // path resolves to a specific node, clicking jumps the
                // graph to it via fitView. Otherwise (root-level) the
                // row is static.
                const nodeId = parsedForGraph
                  ? (nodeIssues && Object.entries(nodeIssues).find(([, arr]) => arr.includes(issue))?.[0])
                    ?? null
                  : null;
                const clickable = !!nodeId;
                return (
                  <li
                    key={i}
                    className={`flex items-start gap-1.5 text-error ${
                      clickable ? 'cursor-pointer hover:bg-surface' : ''
                    }`}
                    {...(clickable
                      ? {
                          onClick: () => {
                            setEditorMode('graph');
                            setFocusTarget((prev) => ({
                              id: nodeId!,
                              nonce: (prev?.nonce ?? 0) + 1,
                            }));
                          },
                          role: 'button',
                          tabIndex: 0,
                        }
                      : {})}
                    title={clickable ? `Jump to node "${nodeId}"` : undefined}
                  >
                    <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      <span className="font-mono text-text-tertiary">
                        {issue.path || '(root)'}
                      </span>{' '}
                      {issue.message}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <footer className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
            {saveError && <p role="alert" className="mr-auto text-[11px] text-error">{saveError}</p>}
            {selectedName && !isReadonly && !creatingNew && (
              <button
                type="button"
                onClick={handleDelete}
                className="flex items-center gap-1 rounded-md border border-error/40 px-2 py-1 text-[11px] text-error hover:bg-error/10"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={(!selectedName && !creatingNew) || isReadonly || save.isPending}
              className="flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground hover:bg-accent-hover disabled:opacity-50"
            >
              {save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save
            </button>
          </footer>
          </>
          )}
        </section>

        {/* Drag-resize divider between center + right */}
        {showRight && !layout.rightCollapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize run panel"
            onPointerDown={(e) =>
              startResize('right', { clientX: e.clientX, pointerId: e.pointerId, target: e.currentTarget })
            }
            className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/30"
          />
        )}

        {/* Right: run panel (collapsed → narrow rail) */}
        {showRight && (
          <aside
            style={{ width: rightWidth }}
            className="flex shrink-0 flex-col overflow-hidden border-l border-border"
          >
            {layout.rightCollapsed ? (
              <button
                type="button"
                onClick={layout.toggleRight}
                title="Expand run panel"
                className="flex h-full w-full items-center justify-center text-text-tertiary hover:bg-surface-elevated"
              >
                <PanelRightOpen className="h-4 w-4" />
              </button>
            ) : (
              <>
                <div className="border-b border-border px-3 py-2">
                  <label className="block text-[10px] uppercase tracking-wide text-text-tertiary">
                    Arguments
                  </label>
                  <input
                    type="text"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder="passed as $ARGUMENTS"
                    className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={handleRun}
                    disabled={!selectedName || creatingNew || startRun.isPending}
                    className="mt-2 flex w-full items-center justify-center gap-1 rounded-md bg-accent px-2 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-accent-hover disabled:opacity-50"
                  >
                    {startRun.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                    Run
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto px-3 py-2 text-[11px]">
                  {!activeRunId && (
                    <p className="text-text-tertiary">No active run. Press Run to start.</p>
                  )}
                  {activeRunId && runDetail.data && (
                    <RunEventList
                      runId={activeRunId}
                      events={runDetail.data.events}
                      ok={runDetail.data.ok}
                      outputs={runDetail.data.outputs}
                    />
                  )}
                </div>
              </>
            )}
          </aside>
        )}
      </div>
      {activeApproval && !approvalDismissed.has(activeApproval.runId) && (
        <ApprovalModal
          runId={activeApproval.runId}
          message={activeApproval.message}
          onDismiss={() =>
            setApprovalDismissed((prev) => {
              const next = new Set(prev);
              next.add(activeApproval.runId);
              return next;
            })
          }
        />
      )}
    </div>
  );
}

function WorkflowGroup({
  label,
  entries,
  selected,
  onSelect,
}: {
  label: string;
  entries: WorkflowSummary[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="border-b border-border">
      <h2 className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
        {label}
      </h2>
      <ul>
        {entries.map(entry => (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => onSelect(entry.name)}
              className={[
                'block w-full px-3 py-1.5 text-left text-xs transition-colors',
                selected === entry.name
                  ? 'bg-accent/15 text-text-primary'
                  : 'text-text-secondary hover:bg-surface-elevated',
              ].join(' ')}
              title={entry.path}
            >
              <div className="font-medium">{entry.name}</div>
              <div className="truncate text-[10px] text-text-tertiary">
                {entry.nodeCount} node{entry.nodeCount === 1 ? '' : 's'}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EditorModeToggle({
  mode,
  onChange,
}: {
  mode: 'yaml' | 'graph';
  onChange: (m: 'yaml' | 'graph') => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-border text-[10px]">
      <button
        type="button"
        onClick={() => onChange('yaml')}
        className={`flex items-center gap-1 px-2 py-0.5 ${
          mode === 'yaml' ? 'bg-surface-elevated text-text-primary' : 'text-text-tertiary'
        }`}
      >
        <FileCode2 className="h-3 w-3" />
        YAML
      </button>
      <button
        type="button"
        onClick={() => onChange('graph')}
        className={`flex items-center gap-1 px-2 py-0.5 ${
          mode === 'graph' ? 'bg-surface-elevated text-text-primary' : 'text-text-tertiary'
        }`}
      >
        <GitGraph className="h-3 w-3" />
        Graph
      </button>
    </div>
  );
}

function ValidationBadge({ status }: { status: 'ok' | 'error' | 'pending' | 'idle' }) {
  if (status === 'pending') {
    return (
      <span className="flex items-center gap-1 text-[10px] text-text-tertiary">
        <Loader2 className="h-3 w-3 animate-spin" />
        validating
      </span>
    );
  }
  if (status === 'ok') {
    return (
      <span className="flex items-center gap-1 text-[10px] text-success">
        <CheckCircle2 className="h-3 w-3" />
        valid
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1 text-[10px] text-error">
        <AlertCircle className="h-3 w-3" />
        invalid
      </span>
    );
  }
  return null;
}

function RunEventList({
  runId,
  events,
  ok,
  outputs,
}: {
  runId: string;
  events: WorkflowRunEvent[];
  ok: boolean | undefined;
  outputs: Record<string, unknown>;
}) {
  return (
    <div className="space-y-2 font-mono">
      <div className="text-[10px] text-text-tertiary">runId: {runId}</div>
      <ul className="space-y-1">
        {events.map((ev, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-text-tertiary" />
            <span className="break-all">
              <span className="text-text-tertiary">{ev.type}</span>
              {ev.nodeId && <span className="ml-1">{ev.nodeId}</span>}
              {ev.reason && <span className="ml-1 text-text-tertiary">— {ev.reason}</span>}
              {ev.error && <span className="ml-1 text-error">— {ev.error}</span>}
              {ev.result?.ok === false && (
                <span className="ml-1 text-error">— {ev.result.error ?? 'failed'}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {ok === true && (
        <div className="rounded-md bg-success/10 px-2 py-1 text-[10px] text-success">
          completed · {Object.keys(outputs).length} node output{Object.keys(outputs).length === 1 ? '' : 's'}
        </div>
      )}
      {ok === false && (
        <div className="rounded-md bg-error/10 px-2 py-1 text-[10px] text-error">
          failed
        </div>
      )}
      {Object.keys(outputs).length > 0 && (
        <RunOutputs outputs={outputs} />
      )}
    </div>
  );
}

/** Caveat (2026-05-08 dogfood): the previous run panel showed event
 *  types but never the actual node output bodies. For a successful
 *  quick-summary run the user could see "completed · 2 node outputs"
 *  but had no way to read what `route-to-digest` actually produced.
 *  This collapsed accordion exposes the per-node output (truncated to
 *  4 KB so a verbose LLM response doesn't blow out the layout). */
function RunOutputs({ outputs }: { outputs: Record<string, unknown> }) {
  return (
    <details className="mt-2 rounded-md border border-border bg-surface-elevated">
      <summary className="cursor-pointer select-none px-2 py-1 text-[10px] font-semibold text-text-tertiary">
        Outputs ({Object.keys(outputs).length})
      </summary>
      <ul className="space-y-1 px-2 pb-2 pt-1 font-mono text-[10px]">
        {Object.entries(outputs).map(([nodeId, value]) => (
          <li key={nodeId} className="rounded bg-surface px-2 py-1">
            <div className="text-[9px] uppercase tracking-wide text-text-tertiary">
              {nodeId}
            </div>
            <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all">
              {formatOutput(value)}
            </pre>
          </li>
        ))}
      </ul>
    </details>
  );
}

const OUTPUT_PREVIEW_LIMIT = 4_096;

function formatOutput(value: unknown): string {
  if (value === null || value === undefined) return '(no output)';
  if (typeof value === 'string') {
    return value.length > OUTPUT_PREVIEW_LIMIT
      ? `${value.slice(0, OUTPUT_PREVIEW_LIMIT)}\n…(truncated · ${value.length} chars)`
      : value;
  }
  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > OUTPUT_PREVIEW_LIMIT
      ? `${json.slice(0, OUTPUT_PREVIEW_LIMIT)}\n…(truncated · ${json.length} chars)`
      : json;
  } catch {
    return String(value);
  }
}
