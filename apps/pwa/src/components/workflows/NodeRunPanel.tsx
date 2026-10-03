'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MissingUpstreamError, type WorkflowRunEvent } from '@/nexus/client';
import { useNexusClient } from '@/nexus/hooks/use-nexus-context';
import { useWorkflowRunModes } from '@/nexus/hooks/use-workflow-run-modes';
import { useWorkflowRun, useWorkflowRuns } from '@/nexus/hooks/use-workflows';
import { nexusKeys } from '@/nexus/hooks/query-keys';
import { useDeleteWorkflowPin, usePutWorkflowPin, useWorkflowPins } from '@/nexus/hooks/use-workflow-pins';
import { formatOutput, latestNodeResult } from './node-run-result';

export function NodeRunPanel({ workflowName, nodeId, events, readOnly }: {
  workflowName: string;
  nodeId: string;
  events: ReadonlyArray<WorkflowRunEvent>;
  readOnly: boolean;
}) {
  const result = latestNodeResult(events, nodeId);
  const pins = useWorkflowPins(workflowName);
  const putPin = usePutWorkflowPin();
  const deletePin = useDeleteWorkflowPin();
  const [showFull, setShowFull] = useState(false);
  const pin = pins.data?.pins[nodeId];
  const output = result?.output;
  const formatted = output !== undefined ? formatOutput(output) : null;
  const fullText = showFull && formatted?.truncated ? formatOutputFull(output) : formatted?.text;
  const pending = putPin.isPending || deletePin.isPending;
  const pinError = putPin.error ?? deletePin.error;
  const client = useNexusClient();
  const qc = useQueryClient();
  const supported = useWorkflowRunModes();
  const runs = useWorkflowRuns({ enabled: !readOnly && supported });
  // «Retry from» needs a run that has upstream outputs: skip single-node test runs (mode 'only') — newest first, up to 5
  // (W4b live: the newest run was the test run just made, and the server answered «source run missing upstream outputs»).
  const candidates = useMemo(() => (runs.data?.runs ?? [])
    .filter((run) => run.workflowName === workflowName)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 5)
    .map((run) => run.runId), [runs.data?.runs, workflowName]);
  const [sourceIndex, setSourceIndex] = useState(0);
  useEffect(() => { setSourceIndex(0); }, [candidates[0]]);
  const lastRunId = candidates[sourceIndex] ?? null;
  const lastRun = useWorkflowRun(!readOnly && supported ? lastRunId : null);
  useEffect(() => {
    if (lastRun.data?.mode === 'only' && sourceIndex + 1 < candidates.length) setSourceIndex(sourceIndex + 1);
  }, [lastRun.data?.mode, sourceIndex, candidates.length]);
  const sourceUsable = lastRun.data !== undefined && lastRun.data.mode !== 'only';
  const lastFailed = sourceUsable && lastRun.data?.events && latestNodeResult(lastRun.data.events, nodeId)?.ok === false;
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);

  const startNodeRun = async (kind: 'test' | 'retry') => {
    if (readOnly || !supported || running || (kind === 'retry' && (!lastRunId || !lastFailed))) return;
    setRunning(true);
    setRunMessage(null);
    try {
      const response = await client.runWorkflow(workflowName, '', kind === 'test'
        // The server (#23131) rejects onlyNode ⊕ fromRunId («invalid run selection») — it fills upstream itself.
        ? { onlyNode: nodeId }
        : { fromNode: nodeId, fromRunId: lastRunId! });
      // The server names the mode it actually ran (#23131): only · from · full. Anything but the requested one is a full run.
      if (response.mode !== (kind === 'test' ? 'only' : 'from')) setRunMessage('서버가 전체 실행으로 처리했습니다');
      await qc.invalidateQueries({ queryKey: nexusKeys.workflowRuns() });
    } catch (error) {
      if (error instanceof MissingUpstreamError) {
        setRunMessage(`먼저 고정하거나 한 번 전체 실행이 필요한 노드: ${error.nodes.join(', ')}`);
      } else {
        setRunMessage(`실행 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <section aria-label={`${nodeId} 마지막 실행 결과`} className="max-h-64 overflow-y-auto border-t border-border bg-surface px-3 py-2 text-xs">
      <h3 className="font-semibold">마지막 실행 결과 · {nodeId}</h3>
      {result ? (
        <div className="mt-2 space-y-2">
          <p className={result.ok ? 'text-success' : 'text-error'}>
            {result.ok ? '성공' : '실패'}{result.durationMs !== undefined ? ` · ${(result.durationMs / 1000).toFixed(2)}초` : ''}
          </p>
          {!result.ok && result.error && <p role="alert" className="break-words text-error">{result.error}</p>}
          {formatted && (
            <details className="rounded border border-border bg-surface-elevated px-2 py-1">
              <summary className="cursor-pointer">출력</summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{fullText}</pre>
              {formatted.truncated && (
                <button type="button" onClick={() => setShowFull((v) => !v)} className="mt-1 text-accent underline">
                  {showFull ? '접기' : '전체 보기'}
                </button>
              )}
            </details>
          )}
        </div>
      ) : <p className="mt-2 text-text-tertiary">아직 실행 기록이 없습니다</p>}
      {!readOnly && (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-border pt-2">
          <button type="button" disabled={!supported || running} onClick={() => void startNodeRun('test')}
            className="rounded border border-border px-2 py-1 disabled:opacity-50">이 노드만 시험</button>
          <button type="button" disabled={!supported || running || !lastRunId || !lastFailed} onClick={() => void startNodeRun('retry')}
            className="rounded border border-border px-2 py-1 disabled:opacity-50">실패 노드부터 다시</button>
          {!supported && <p className="w-full text-text-tertiary">서버가 아직 이 기능을 지원하지 않습니다</p>}
          {runMessage && <p role="alert" className="w-full text-error">{runMessage}</p>}
        </div>
      )}
      <div className="mt-2 border-t border-border pt-2">
        {pins.isError && <p role="alert" className="text-error">고정 상태를 읽지 못했습니다.</p>}
        {pin && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">고정됨</span>}
        {!readOnly && !pins.isError && !pins.isPending && (
          pin ? (
            <button type="button" disabled={pending} onClick={async () => { putPin.reset(); try { await deletePin.mutateAsync({ name: workflowName, nodeId }); } catch { /* mutation error renders below */ } }}
              className="ml-2 rounded border border-border px-2 py-1 disabled:opacity-50">고정 풀기</button>
          ) : output !== undefined ? (
            <div>
              <button type="button" disabled={pending} onClick={async () => { deletePin.reset(); try { await putPin.mutateAsync({ name: workflowName, nodeId, value: output }); } catch { /* mutation error renders below */ } }}
                className="rounded border border-border px-2 py-1 disabled:opacity-50">이 출력 고정</button>
              <p className="mt-1 text-text-tertiary">다음 실행부터 이 노드는 실제로 돌지 않고 이 값을 씁니다.</p>
            </div>
          ) : null
        )}
        {!readOnly && pinError && <p role="alert" className="mt-1 text-error">고정 변경 실패: {pinError.message}</p>}
      </div>
    </section>
  );
}

function formatOutputFull(output: unknown): string {
  if (typeof output === 'string') {
    try { return JSON.stringify(JSON.parse(output), null, 2); } catch { return output; }
  }
  try { return JSON.stringify(output, null, 2) ?? String(output); } catch { return String(output); }
}
