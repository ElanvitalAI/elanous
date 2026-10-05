'use client';

import { useState } from 'react';
import type { Project } from '@/lib/projects-api';

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

export function ChatProjectSwitcher({ projects, selection, onChange, onCreate }: {
  projects: Project[];
  selection: ProjectSelection;
  onChange: (selection: ProjectSelection) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState(false);

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
        if (!trimmed) return;
        void onCreate(trimmed).then(() => { setCreating(false); setName(''); setError(false); }).catch(() => setError(true));
      }} className="flex gap-2">
        <input aria-label="프로젝트 이름" autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-sm" />
        <button type="submit" className="rounded-lg border border-border px-2 text-sm">만들기</button>
        {error && <span role="alert">프로젝트를 만들지 못했습니다</span>}
      </form>}
    </div>
  );
}
