'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { getReleaseNodeLog, getReleaseRuns, type OpsResult, type ReleaseRun } from '@/lib/ops-api';
import { latestReleaseRun, ReleaseStrip } from './ReleaseStrip';
import { currentNodeId, ReleaseFlow, ReleaseNodeDetail } from './ReleaseFlow';

export { currentNodeId };
// 원장 상태값 실측: done · failed · running — 'done' 이 빠져 있으면 끝난 런을 10초마다 계속 다시 읽는다.
const FINISHED_RUN = ['done', 'completed', 'failed', 'cancelled', 'aborted', 'success', 'succeeded', 'error'];
const runClock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function ReleaseRunsContent({ result, version, versions = [], selectedRunId, openedNodeId, log, onVersion, onRun, onNode, releaseStrip }: {
  result: OpsResult<ReleaseRun[]> | null;
  releaseStrip?: React.ReactNode;
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
  const selected = filtered.find((run) => run.runId === selectedRunId) ?? latestReleaseRun({ kind: 'ready', data: filtered }, Date.now()) ?? filtered[0];
  const choices = [...new Set([...versions, ...runs.map((run) => run.version).filter((v): v is string => !!v)])];
  if (version && !choices.includes(version)) choices.push(version);
  return <main className="mx-auto w-full min-w-0 max-w-4xl space-y-6 overflow-x-hidden px-4 py-6 text-foreground">
    {releaseStrip}
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
          <time aria-label="시작 시각 (KST)" className="block break-all text-sm text-muted-foreground" dateTime={run.startedAt}>{Number.isFinite(Date.parse(run.startedAt)) ? `${runClock.format(new Date(run.startedAt))} KST` : '시각 미기록'}</time>
        </button>)}
      </section>
      {selected && <section className="min-w-0 space-y-3" aria-label="노드 진행">
        <h2 className="font-semibold">노드 흐름 <span className="text-sm font-normal text-muted-foreground">· {selected.version ?? '판 미상'} · {selected.status}</span></h2>
        <ReleaseFlow run={selected} openedNodeId={openedNodeId} onNode={onNode} />
        {openedNodeId && selected.path.includes(openedNodeId)
          ? <ReleaseNodeDetail run={selected} nodeId={openedNodeId} log={log} />
          : <p className="text-sm text-muted-foreground">노드를 누르면 요약 전문과 로그 꼬리가 열립니다.</p>}
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
    const runId = new URLSearchParams(window.location?.search ?? '').get('run');
    if (runId) setSelectedRunId(runId);
  }, []);
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
          const requestedRunId = new URLSearchParams(window.location?.search ?? '').get('run');
          newestVersion.current = next.data.find((run) => run.runId === requestedRunId)?.version ?? latestReleaseRun(next, Date.now())?.version ?? next.data[0]?.version ?? null;
          setLatestVersion(newestVersion.current);
        }
      }
    });
    return () => { active = false; };
  }, [client, version]);

  const running = !denied && (result?.kind === 'ready' || result?.kind === 'error') && latestRuns.current.some((run) =>
    !FINISHED_RUN.includes(run.status.toLowerCase()));
  useEffect(() => {
    if (!running) return;
    let active = true;
    let busy = false;
    const refresh = async () => {
      if (busy || document.hidden || !active || permissionDenied.current
        || !latestRuns.current.some((run) => !FINISHED_RUN.includes(run.status.toLowerCase()))) return;
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
  const versionRuns = result?.kind === 'ready' ? result.data.filter((run) => !activeVersion || run.version === activeVersion) : [];
  const selected = versionRuns.find((run) => run.runId === selectedRunId)
    ?? latestReleaseRun({ kind: 'ready', data: versionRuns }, Date.now()) ?? versionRuns[0];
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
  const selectStripRun = (run: ReleaseRun) => {
    if (run.version !== activeVersion) { setVersion(run.version ?? ''); setLatestVersion(null); }
    selectRun(run.runId);
  };
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
    log={visibleLog} onVersion={selectVersion} onRun={selectRun} onNode={selectNode}
    releaseStrip={<ReleaseStrip result={result} selectedRun={selected ?? null} onSelect={selectStripRun} />} />;
}
