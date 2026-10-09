'use client';

import { useEffect, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { getSessionsService } from '@/lib/sessions-service';
import { useSessions } from '@/lib/use-sessions';
import { ProjectsApi, type Project } from '@/lib/projects-api';
import { PROJECT_PENDING_CHANGED, PROJECTS_CHANGED, notifyProjectsChanged, readPendingProjects, writePendingProjects } from './ChatProjectSwitcher';

/** Project membership of the open conversation (not the sidebar's list filter). */
export function ChatCurrentProject({ compact = false }: { compact?: boolean }) {
  const { client, sessionId } = useDaemon();
  const sessions = useSessions();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState(false);
  const [projectsRevision, setProjectsRevision] = useState(0);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingSessions, setSavingSessions] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [sessionLoaded, setSessionLoaded] = useState<string | null>(null);
  const refreshedRef = useRef<string | null>(null);
  const assigningRef = useRef<string | null>(null);
  const failedPendingRef = useRef<string | null>(null);
  const savingRef = useRef<Set<string>>(new Set());
  const saving = Boolean(sessionId && savingSessions.includes(sessionId));
  const storedProjectRef = useRef<string | null>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [browser, setBrowser] = useState<Awaited<ReturnType<ProjectsApi['folders']>> | null>(null);
  const [folderError, setFolderError] = useState(false);
  const [folderLoading, setFolderLoading] = useState(false);
  const folderRequest = useRef(0);
  const creatingProjectRef = useRef(false);
  const browse = async (path?: string) => {
    const request = ++folderRequest.current;
    setFolderError(false);
    setFolderLoading(true);
    setBrowser(null);
    try {
      const next = await new ProjectsApi(client).folders(path);
      if (request === folderRequest.current) setBrowser(next);
    } catch { if (request === folderRequest.current) setFolderError(true); }
    finally { if (request === folderRequest.current) setFolderLoading(false); }
  };

  useEffect(() => {
    let alive = true;
    let request = 0;
    setProjects([]);
    setProjectsError(false);
    const refresh = () => {
      const current = ++request;
      setProjectsLoading(true);
      void new ProjectsApi(client).list().then(({ projects: next }) => {
        if (alive && current === request) { setProjects(next ?? []); setProjectsError(false); }
      }).catch(() => { if (alive && current === request) setProjectsError(true); })
        .finally(() => { if (alive && current === request) setProjectsLoading(false); });
    };
    refresh();
    window.addEventListener(PROJECTS_CHANGED, refresh);
    return () => { alive = false; window.removeEventListener(PROJECTS_CHANGED, refresh); };
  }, [client, projectsRevision]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSessionLoaded(null);
    setExists(false);
    storedProjectRef.current = null;
    setProjectId(null);
    if (!sessionId) { setLoading(false); return; }
    void client.fetchJson<{ meta?: { projectId?: string } }>(
      `/v1/sessions/store/${encodeURIComponent(sessionId)}?ifExists=1`,
    ).then((body) => {
      if (!alive) return;
      setExists(Boolean(body.meta));
      storedProjectRef.current = body.meta?.projectId ?? null;
      if (!savingRef.current.has(sessionId)) {
        setProjectId(body.meta ? body.meta.projectId ?? null : readPendingProjects()[sessionId] ?? null);
      }
      setSessionLoaded(sessionId);
      setLoading(false);
    }).catch(() => { if (alive) { setSessionLoaded(null); setError('프로젝트를 확인하지 못했습니다'); setLoading(false); } });
    return () => { alive = false; };
  }, [client, sessionId, revision]);

  useEffect(() => {
    folderRequest.current++;
    setBrowser(null);
    setFolder('');
    setFolderError(false);
    setFolderLoading(false);
    setError('');
    setCreating(false);
    refreshedRef.current = null;
    failedPendingRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const refresh = () => {
      const pending = readPendingProjects()[sessionId];
      if (pending) failedPendingRef.current = null;
      if (savingRef.current.has(sessionId)) return;
      if (sessionLoaded === sessionId && exists && pending !== storedProjectRef.current) {
        setRevision((value) => value + 1);
      } else if (sessionLoaded === sessionId) {
        setProjectId(pending ?? null);
      }
    };
    window.addEventListener(PROJECT_PENDING_CHANGED, refresh);
    return () => window.removeEventListener(PROJECT_PENDING_CHANGED, refresh);
  }, [sessionId, sessionLoaded, exists]);

  useEffect(() => {
    if (!sessionId || sessionLoaded !== sessionId || exists || saving ||
        refreshedRef.current === sessionId || !sessions.some((item) => item.id === sessionId)) return;
    refreshedRef.current = sessionId;
    setSessionLoaded(null);
    setRevision((value) => value + 1);
  }, [sessionId, sessionLoaded, exists, saving, sessions]);

  // A standalone or workspace chat may save before its sidebar mounts.
  // Apply a pending choice when the session first appears on disk.
  useEffect(() => {
    if (!sessionId || !exists || loading || saving) return;
    const pending = readPendingProjects()[sessionId];
    if (!pending || savingRef.current.has(sessionId) || assigningRef.current === sessionId || failedPendingRef.current === `${sessionId}:${pending}`) return;
    assigningRef.current = sessionId;
    void new ProjectsApi(client).assign(sessionId, pending).then(() => {
      if (sessionRef.current === sessionId) storedProjectRef.current = pending;
      const next = readPendingProjects();
      if (next[sessionId] === pending) {
        delete next[sessionId];
        writePendingProjects(next);
        if (sessionRef.current === sessionId && !savingRef.current.has(sessionId)) setProjectId(pending);
      }
      void getSessionsService(client).forceRefresh();
    }).catch(() => {
      failedPendingRef.current = `${sessionId}:${pending}`;
      const next = readPendingProjects();
      if (next[sessionId] === pending) {
        delete next[sessionId];
        writePendingProjects(next);
      }
      if (sessionRef.current === sessionId) {
        setProjectId(storedProjectRef.current);
        setError('프로젝트를 바꾸지 못했습니다');
      }
    }).finally(() => { assigningRef.current = null; });
  }, [client, sessionId, exists, loading, saving, revision]);

  const change = async (nextId: string | null, newlyCreated = false) => {
    if (!sessionId || sessionLoaded !== sessionId || loading || (projectsError && !newlyCreated) || savingRef.current.has(sessionId) || assigningRef.current === sessionId) return false;
    savingRef.current.add(sessionId);
    setSavingSessions((previous) => [...previous, sessionId]);
    setError('');
    try {
      if (exists) {
        await new ProjectsApi(client).assign(sessionId, nextId);
        if (sessionRef.current === sessionId) storedProjectRef.current = nextId;
        void getSessionsService(client).forceRefresh();
        const next = readPendingProjects();
        if (next[sessionId]) { delete next[sessionId]; writePendingProjects(next); }
      } else {
        const next = readPendingProjects();
        if (nextId) next[sessionId] = nextId;
        else delete next[sessionId];
        if (!writePendingProjects(next)) throw new Error('pending project storage unavailable');
      }
      if (sessionRef.current === sessionId) setProjectId(nextId);
      return true;
    } catch { if (sessionRef.current === sessionId) setError('프로젝트를 바꾸지 못했습니다'); return false; }
    finally {
      savingRef.current.delete(sessionId);
      setSavingSessions((previous) => previous.filter((id) => id !== sessionId));
    }
  };

  const projectLabel = projectId ? projects.find((project) => project.id === projectId)?.name ?? '알 수 없는 프로젝트' : '프로젝트 없음';

  return (
    <div className={compact ? 'relative flex min-w-0 items-center gap-1.5 text-xs' : 'flex min-w-0 flex-wrap items-center gap-1.5 text-xs'}>
      <label htmlFor="chat-current-project" className={compact ? 'sr-only' : 'shrink-0 text-muted-foreground'}>프로젝트</label>
      <select id="chat-current-project" aria-label="현재 대화 프로젝트" title={sessionId && sessionLoaded === sessionId && !loading ? `현재 프로젝트: ${projectLabel}` : '프로젝트 확인 중…'} value={sessionId && sessionLoaded === sessionId && !loading ? projectId ?? '' : 'loading'}
        disabled={!sessionId || sessionLoaded !== sessionId || loading || projectsLoading || saving || assigningRef.current === sessionId || projectsError}
        onChange={(event) => {
          if (event.target.value === 'create') { if (!projectsLoading && !projectsError) setCreating(true); return; }
          void change(event.target.value || null);
        }}
        className={`${compact ? 'w-20 max-w-[24vw]' : 'max-w-36'} min-w-0 truncate rounded-md border border-border bg-background px-2 py-1 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring`}>
        {(!sessionId || sessionLoaded !== sessionId || loading) && <option value="loading">프로젝트 확인 중…</option>}
        <option value="">프로젝트 없음</option>
        {projectId && !projects.some((project) => project.id === projectId) && <option value={projectId}>알 수 없는 프로젝트</option>}
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        {compact && <option value="create">＋ 프로젝트 만들기</option>}
      </select>
      {!compact && <button type="button" aria-label="프로젝트 만들기" title="프로젝트 만들기" disabled={!sessionId || sessionLoaded !== sessionId || loading || projectsLoading || saving || projectsError} onClick={() => setCreating((open) => !open)} className="shrink-0 rounded px-1 hover:bg-muted">＋</button>}
      {creating && <form onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || !sessionId || sessionLoaded !== sessionId || loading || projectsLoading || projectsError || saving || creatingProjectRef.current || folderLoading) return;
        creatingProjectRef.current = true;
        setCreatingProject(true);
        setError('');
        void new ProjectsApi(client).create(trimmed, folder || undefined).then(async ({ project }) => {
          setProjects((previous) => [...previous, project]);
          const assigned = await change(project.id, true);
          notifyProjectsChanged();
          if (assigned) { folderRequest.current++; setCreating(false); setName(''); setFolder(''); setBrowser(null); }
        }).catch(() => setError('프로젝트를 만들지 못했습니다'))
          .finally(() => { creatingProjectRef.current = false; setCreatingProject(false); });
      }} className={compact ? 'absolute right-0 top-full z-50 mt-1 flex flex-wrap items-center gap-1 rounded-lg border border-border bg-popover p-2 shadow-lg' : 'flex min-w-0 flex-wrap items-center gap-1'}>
        <input aria-label="새 프로젝트 이름" autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} className="w-24 rounded border border-border bg-background px-1 py-1" />
        <button type="submit" disabled={saving || creatingProject || folderLoading || !sessionId || sessionLoaded !== sessionId || projectsLoading || projectsError} className="rounded border border-border px-1">만들기</button>
        <button type="button" aria-label="원격 폴더 고르기" disabled={creatingProject || folderLoading} onClick={() => void browse()} className="rounded border border-border px-1">폴더</button>
      </form>}
      {creating && browser && <div role="group" aria-label="원격 폴더 목록" className={compact ? 'absolute right-0 top-full z-50 mt-12 max-h-48 w-64 max-w-[90vw] overflow-y-auto rounded border border-border bg-popover p-2 shadow-lg' : 'max-h-48 w-64 max-w-[90vw] overflow-y-auto rounded border border-border bg-popover p-2 shadow-lg'}>
        <p className="break-all">{browser.path}</p>
        {browser.parent && <button type="button" aria-label="상위 폴더" onClick={() => void browse(browser.parent ?? undefined)} className="block w-full text-left">..</button>}
        {browser.folders.map(item => <button key={item.path} type="button" onClick={() => void browse(item.path)} className="block w-full truncate text-left">{item.name}/</button>)}
        <button type="button" disabled={folderLoading || creatingProject} onClick={() => { folderRequest.current++; setFolderLoading(false); setFolder(browser.path); setBrowser(null); }} className="rounded border border-border px-1">이 폴더 선택</button>
      </div>}
      {creating && folder && <span className="break-all text-xs">선택한 폴더: {folder}</span>}
      {creating && folderLoading && <span role="status">폴더 불러오는 중…</span>}
      {creating && folderError && <span role="alert">폴더를 불러오지 못했습니다</span>}
      {((sessionId && sessionLoaded !== sessionId && !loading) || projectsError) && <button type="button" aria-label="프로젝트 다시 확인" onClick={() => { setError(''); setRevision((value) => value + 1); if (projectsError) setProjectsRevision((value) => value + 1); }} className="rounded border border-border px-1">다시 시도</button>}
      {(error || projectsError) && <span role="alert" className="text-destructive">{error || '프로젝트 목록을 불러오지 못했습니다'}</span>}
    </div>
  );
}
