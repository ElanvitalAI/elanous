'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, History, Loader2, X } from 'lucide-react';
import { useNexusClient } from '@/nexus/hooks/use-nexus-context';

interface WorkflowHistoryPanelProps {
  name: string;
  onLoad: (yaml: string) => void;
  onClose: () => void;
}

export function WorkflowHistoryPanel({ name, onLoad, onClose }: WorkflowHistoryPanelProps) {
  const client = useNexusClient();
  const history = useQuery({
    queryKey: ['nexus', 'workflow-history', name],
    queryFn: () => client.getWorkflowHistory(name),
  });
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const requestRef = useRef(0);
  useLayoutEffect(() => {
    setLoadingId(null);
    setLoadError(false);
    setLoaded(false);
    return () => { requestRef.current++; };
  }, [name]);

  const load = async (id: string) => {
    if (loadingId !== null) return;
    const request = ++requestRef.current;
    setLoadingId(id);
    setLoadError(false);
    setLoaded(false);
    try {
      const { yaml } = await client.getWorkflowHistoryVersion(name, id);
      if (request !== requestRef.current) return;
      onLoad(yaml);
      setLoaded(true);
    } catch {
      if (request === requestRef.current) setLoadError(true);
    } finally {
      if (request === requestRef.current) setLoadingId(null);
    }
  };

  const close = () => {
    requestRef.current++;
    onClose();
  };

  return (
    <section aria-label={`${name} 이전 판`} className="flex min-h-0 flex-1 flex-col bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <History className="h-4 w-4 text-text-tertiary" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{name} · 이전 판</h2>
        <button type="button" onClick={close} aria-label="이전 판 닫기" className="rounded p-1 text-text-tertiary hover:bg-surface-elevated">
          <X className="h-4 w-4" />
        </button>
      </header>
      {loaded && <p role="status" className="border-b border-border px-3 py-2 text-xs text-success">이전 판을 초안에 불러왔습니다. 저장하려면 Save를 누르세요.</p>}
      {loadError && <p role="alert" className="border-b border-border px-3 py-2 text-xs text-error">이전 판을 불러오지 못했습니다. 다시 시도해 주세요.</p>}
      {history.isLoading ? (
        <p role="status" className="flex items-center gap-2 px-3 py-4 text-xs text-text-tertiary"><Loader2 className="h-3 w-3 animate-spin" />이전 판을 읽는 중…</p>
      ) : history.isError ? (
        <p role="alert" className="flex items-center gap-2 px-3 py-4 text-xs text-error"><AlertCircle className="h-3 w-3" />이전 판 목록을 읽지 못했습니다.</p>
      ) : !history.data?.versions.length ? (
        <p className="px-3 py-4 text-xs text-text-tertiary">아직 이전 판이 없습니다</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {history.data.versions.map((version) => (
            <li key={version.id} className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
              <time dateTime={version.createdAt} className="min-w-0 flex-1 text-text-primary">
                {new Date(version.createdAt).toLocaleString()}
              </time>
              <span className="shrink-0 text-text-tertiary">{version.size.toLocaleString()} B</span>
              <button
                type="button"
                disabled={loadingId !== null}
                onClick={() => void load(version.id)}
                className="shrink-0 rounded-md border border-border px-2 py-1 text-text-primary hover:bg-surface-elevated disabled:opacity-50"
              >
                {loadingId === version.id ? '불러오는 중…' : '불러오기'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
