'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { getReleaseNodeLog, getReleaseRuns, type OpsResult, type ReleaseRun } from '@/lib/ops-api';

export function currentNodeId(run: ReleaseRun): string | undefined {
  const current = run.path.find((id) => run.nodes.find((node) => node.nodeId === id)?.ok === null);
  return current ?? run.path.at(-1);
}

export function ReleaseRunsContent({ result, version, versions = [], selectedRunId, openedNodeId, log, onVersion, onRun, onNode }: {
  result: OpsResult<ReleaseRun[]> | null;
  version: string;
  versions?: string[];
  selectedRunId: string | null;
  openedNodeId: string | null;
  log: OpsResult<{ log: string }> | null;
  onVersion: (version: string) => void;
  onRun: (runId: string) => void;
  onNode: (nodeId: string) => void;
}): React.ReactNode {
  if (result?.kind === 'forbidden' || log?.kind === 'forbidden') return <p>운영자만 볼 수 있습니다</p>;
  const runs = result?.kind === 'ready' ? result.data : [];
  const filtered = version ? runs.filter((run) => run.version === version) : runs;
  const selected = filtered.find((run) => run.runId === selectedRunId) ?? filtered[0];
  const choices = [...new Set([...versions, ...runs.map((run) => run.version).filter((v): v is string => !!v)])];
  if (version && !choices.includes(version)) choices.push(version);
  const current = selected && currentNodeId(selected);
  return <main className="mx-auto w-full min-w-0 max-w-4xl space-y-6 overflow-x-hidden px-4 py-6 text-foreground">
    <header className="space-y-1"><p className="text-sm text-muted-foreground">운영 / 릴리스</p><h1 className="text-2xl font-semibold">릴리스</h1></header>
    <label className="block space-y-2 text-sm font-medium">판
      <input aria-label="판" list="ops-release-versions" className="block w-full max-w-xs rounded-md border bg-background p-2" value={version} onChange={(event) => onVersion(event.target.value)} placeholder="전체 판" />
      <datalist id="ops-release-versions">{choices.map((v) => <option key={v} value={v} />)}</datalist>
    </label>
    {result === null ? <p role="status">런을 불러오는 중…</p> : result.kind === 'error' ? <p role="alert">런을 불러오지 못했습니다 ({result.status})</p> : null}
    {result?.kind === 'ready' && <>
      <section className="min-w-0 space-y-2" aria-label="런 목록">
        <h2 className="font-semibold">런 목록</h2>
        {filtered.length === 0 && <p className="text-sm text-muted-foreground">이 판의 런이 없습니다.</p>}
        {filtered.map((run) => <button key={run.runId} type="button" aria-pressed={selected?.runId === run.runId} onClick={() => onRun(run.runId)}
          className="block w-full min-w-0 rounded-md border p-3 text-left hover:bg-muted aria-pressed:border-primary">
          <span className="block truncate font-medium">{run.version ?? '판 미상'} · {run.status}</span>
          <time className="block break-all text-sm text-muted-foreground" dateTime={run.startedAt}>{run.startedAt}</time>
        </button>)}
      </section>
      {selected && <section className="min-w-0 space-y-2" aria-label="노드 진행">
        <h2 className="font-semibold">노드 진행</h2>
        {selected.path.map((id, index) => {
          const node = selected.nodes.find((entry) => entry.nodeId === id);
          const open = openedNodeId === id;
          return <div key={`${id}-${index}`} className="min-w-0 rounded-md border">
            <button type="button" aria-expanded={open} onClick={() => onNode(id)} className="flex w-full min-w-0 items-start gap-2 p-3 text-left hover:bg-muted">
              <span aria-label={node?.ok === true ? '성공' : node?.ok === false ? '실패' : '진행 대기'}>{node?.ok === true ? '✅' : node?.ok === false ? '❌' : '⏳'}</span>
              <span className="min-w-0 flex-1"><span className="block break-all font-medium">{id} {id === current && <strong className="text-sm text-primary">지금 위치</strong>}</span>
                {node?.summary && <span className="block break-all text-sm text-muted-foreground">{node.summary}</span>}</span>
            </button>
            {open && <div className="min-w-0 border-t p-3">{log?.kind === 'ready'
              ? <pre className="max-w-full overflow-x-auto whitespace-pre font-mono text-xs" aria-label="노드 로그">{log.data.log}</pre>
              : <p role="status" className="text-sm">{log?.kind === 'error' ? `로그를 불러오지 못했습니다 (${log.status})` : '로그를 불러오는 중…'}</p>}</div>}
          </div>;
        })}
      </section>}
    </>}
  </main>;
}

export function ReleaseRunsView(): React.ReactNode {
  const { client } = useDaemon();
  const [version, setVersion] = useState<string | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [result, setResult] = useState<OpsResult<ReleaseRun[]> | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [openedNode, setOpenedNode] = useState<{ runId: string; nodeId: string } | null>(null);
  const [log, setLog] = useState<{ runId: string; nodeId: string; result: OpsResult<{ log: string }> } | null>(null);
  const [denied, setDenied] = useState(false);
  const logRequest = useRef(0);
  const permissionDenied = useRef(false);
  const newestVersion = useRef<string | null>(null);
  const latestRuns = useRef<ReleaseRun[]>([]);
  const priorClient = useRef(client);
  useEffect(() => {
    let active = true;
    if (priorClient.current !== client) {
      priorClient.current = client;
      permissionDenied.current = false;
      setDenied(false);
      setVersions([]);
      newestVersion.current = null;
      setLatestVersion(null);
    }
    if (permissionDenied.current) return () => { active = false; };
    logRequest.current++;
    setOpenedNode(null);
    setLog(null);
    setResult(null);
    latestRuns.current = [];
    if (version === null) { newestVersion.current = null; setLatestVersion(null); }
    void getReleaseRuns(client, version || undefined).then((next) => {
      if (!active || permissionDenied.current) return;
      setResult(next);
      if (next.kind === 'forbidden') { permissionDenied.current = true; setDenied(true); }
      if (next.kind === 'ready') {
        latestRuns.current = next.data;
        setVersions((previous) => [...new Set([...previous, ...next.data.map((run) => run.version).filter((v): v is string => !!v)])]);
        if (version === null && newestVersion.current === null) {
          newestVersion.current = next.data[0]?.version ?? null;
          setLatestVersion(newestVersion.current);
        }
      }
    });
    return () => { active = false; };
  }, [client, version]);

  const running = !denied && (result?.kind === 'ready' || result?.kind === 'error') && latestRuns.current.some((run) =>
    !['completed', 'failed', 'cancelled', 'aborted', 'success', 'error'].includes(run.status.toLowerCase()));
  useEffect(() => {
    if (!running) return;
    let active = true;
    let busy = false;
    const refresh = async () => {
      if (busy || document.hidden || !active || permissionDenied.current
        || !latestRuns.current.some((run) => !['completed', 'failed', 'cancelled', 'aborted', 'success', 'error'].includes(run.status.toLowerCase()))) return;
      busy = true;
      const next = await getReleaseRuns(client, version || undefined);
      busy = false;
      if (active && !permissionDenied.current) {
        setResult(next);
        if (next.kind === 'ready') latestRuns.current = next.data;
        if (next.kind === 'forbidden') { permissionDenied.current = true; setDenied(true); }
      }
    };
    const interval = window.setInterval(() => { void refresh(); }, 10_000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', visible); };
  }, [client, version, running]);

  const activeVersion = version === null ? latestVersion : version;
  const selected = result?.kind === 'ready' ? result.data.find((run) => run.runId === selectedRunId && (!activeVersion || run.version === activeVersion))
    ?? result.data.find((run) => !activeVersion || run.version === activeVersion) : undefined;
  const effectiveVersion = activeVersion ?? selected?.version ?? '';
  const selectedId = selected?.runId;
  useEffect(() => {
    logRequest.current++;
    setOpenedNode(null);
    setLog(null);
  }, [selectedId]);
  const selectVersion = useCallback((next: string) => {
    if (next === latestVersion && version === null) return;
    logRequest.current++;
    setLatestVersion(null);
    setVersion(next); setSelectedRunId(null); setOpenedNode(null); setLog(null);
  }, [version, latestVersion]);
  const selectRun = (runId: string) => { logRequest.current++; setSelectedRunId(runId); setOpenedNode(null); setLog(null); };
  const selectNode = (nodeId: string) => {
    if (!selected || result?.kind !== 'ready') return;
    const request = ++logRequest.current;
    const id = selected.runId;
    if (openedNode?.runId === id && openedNode.nodeId === nodeId) { setOpenedNode(null); setLog(null); return; }
    setOpenedNode({ runId: id, nodeId }); setLog(null);
    void getReleaseNodeLog(client, id, nodeId).then((next) => {
      if (request !== logRequest.current || permissionDenied.current) return;
      if (next.kind === 'forbidden') { permissionDenied.current = true; setDenied(true); }
      setLog({ runId: id, nodeId, result: next });
    });
  };
  if (denied) return <p>운영자만 볼 수 있습니다</p>;
  const visibleNode = openedNode && openedNode.runId === selectedId ? openedNode.nodeId : null;
  const visibleLog = log && log.runId === selectedId && log.nodeId === visibleNode ? log.result : null;
  return <ReleaseRunsContent result={result} version={effectiveVersion} versions={versions} selectedRunId={selectedRunId} openedNodeId={visibleNode}
    log={visibleLog} onVersion={selectVersion} onRun={selectRun} onNode={selectNode} />;
}
