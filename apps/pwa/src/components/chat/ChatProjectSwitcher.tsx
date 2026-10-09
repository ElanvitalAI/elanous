'use client';

import { useRef, useState } from 'react';
import type { Project, ProjectsApi } from '@/lib/projects-api';

export type ProjectSelection = 'all' | 'none' | string;
export const PROJECT_SELECTION_KEY = 'elanous.chat.projectSelection';
export const PROJECT_PENDING_CHANGED = 'elanous-chat-pending-projects-changed';
export const PROJECTS_CHANGED = 'elanous-chat-projects-changed';

export function notifyProjectsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PROJECTS_CHANGED));
}
const PENDING_PROJECTS_KEY = 'elanous.chat.pendingProjects';

export function readPendingProjects(): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PENDING_PROJECTS_KEY) ?? '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      return Object.fromEntries(Object.entries(stored).filter(([id, projectId]) => id && typeof projectId === 'string' && projectId));
    }
  } catch { /* Storage can be unavailable or malformed. */ }
  return {};
}

export function writePendingProjects(pending: Record<string, string>): boolean {
  try { localStorage.setItem(PENDING_PROJECTS_KEY, JSON.stringify(pending)); } catch { return false; }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PROJECT_PENDING_CHANGED));
  return true;
}

export function ChatProjectSwitcher({ projects, selection, onChange, onCreate, api }: {
  projects: Project[];
  selection: ProjectSelection;
  onChange: (selection: ProjectSelection) => void;
  onCreate: (name: string, primaryFolder?: string) => Promise<void>;
  api?: ProjectsApi;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState(false);
  const [folder, setFolder] = useState('');
  const [browser, setBrowser] = useState<Awaited<ReturnType<ProjectsApi['folders']>> | null>(null);
  const [folderError, setFolderError] = useState(false);
  const [folderLoading, setFolderLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const folderRequest = useRef(0);
  const submittingRef = useRef(false);
  const browse = async (path?: string) => {
    if (!api) return;
    const request = ++folderRequest.current;
    setFolderLoading(true);
    setFolderError(false);
    setBrowser(null);
    try {
      const next = await api.folders(path);
      if (request === folderRequest.current) setBrowser(next);
    } catch { if (request === folderRequest.current) setFolderError(true); }
    finally { if (request === folderRequest.current) setFolderLoading(false); }
  };

  // No projects yet: no switcher (nothing to switch), but the only way to make the first project must stay reachable.
  return (
    <div className="space-y-2">
      {projects.length === 0 && !creating && <button type="button" onClick={() => setCreating(true)}
        className="text-sm text-muted-foreground hover:text-foreground">＋ 프로젝트 만들기</button>}
      {projects.length > 0 && <select aria-label="프로젝트 바꾸기" value={selection} onChange={(event) => {
        if (event.target.value === 'create') { setCreating(true); return; }
        onChange(event.target.value);
      }} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
        <option value="all">모든 대화</option>
        <option value="none">받은 대화(프로젝트 없음)</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        <option value="create">＋ 프로젝트 만들기</option>
      </select>}
      {creating && <form onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || submittingRef.current || folderLoading) return;
        submittingRef.current = true;
        setSubmitting(true);
        void onCreate(trimmed, folder || undefined).then(() => { folderRequest.current++; setCreating(false); setName(''); setFolder(''); setBrowser(null); setError(false); }).catch(() => setError(true))
          .finally(() => { submittingRef.current = false; setSubmitting(false); });
      }} className="flex flex-wrap gap-2">
        <input aria-label="프로젝트 이름" autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-sm" />
        <button type="submit" disabled={folderLoading || submitting} className="rounded-lg border border-border px-2 text-sm">만들기</button>
        {api && <button type="button" aria-label="원격 폴더 고르기" disabled={submitting || folderLoading} onClick={() => void browse()} className="rounded-lg border border-border px-2 text-sm">폴더</button>}
        {error && <span role="alert">프로젝트를 만들지 못했습니다</span>}
      </form>}
      {creating && browser && <div role="group" aria-label="원격 폴더 목록" className="max-h-48 overflow-y-auto rounded-lg border border-border p-2 text-sm">
        <p className="break-all">{browser.path}</p>
        {browser.parent && <button type="button" aria-label="상위 폴더" onClick={() => void browse(browser.parent ?? undefined)} className="block w-full py-1 text-left">..</button>}
        {browser.folders.map(item => <button key={item.path} type="button" onClick={() => void browse(item.path)} className="block w-full truncate py-1 text-left">{item.name}/</button>)}
        <button type="button" disabled={folderLoading || submitting} onClick={() => { folderRequest.current++; setFolderLoading(false); setFolder(browser.path); setBrowser(null); }} className="rounded border border-border px-2 py-1">이 폴더 선택</button>
      </div>}
      {creating && folder && <p className="break-all text-xs">선택한 폴더: {folder}</p>}
      {creating && folderLoading && <p role="status">폴더 불러오는 중…</p>}
      {creating && folderError && <p role="alert">폴더를 불러오지 못했습니다</p>}
    </div>
  );
}
