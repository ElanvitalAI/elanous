import type { DaemonClient } from './daemon-client';

export interface Project {
  id: string;
  name: string;
  primaryFolder?: string;
  createdAt: string;
}

export class ProjectsApi {
  constructor(private readonly client: DaemonClient) {}

  list(): Promise<{ projects: Project[] }> {
    return this.client.fetchJson('/v1/projects');
  }

  folders(path?: string): Promise<{ path: string; parent: string | null; folders: Array<{ name: string; path: string }> }> {
    return this.client.fetchJson(`/v1/projects/folders${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`);
  }

  create(name: string, primaryFolder?: string): Promise<{ project: Project }> {
    return this.client.fetchJson('/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, ...(primaryFolder !== undefined ? { primaryFolder } : {}) }),
    });
  }

  assign(sessionId: string, projectId: string | null): Promise<{ ok: boolean }> {
    return this.client.fetchJson(`/v1/sessions/store/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
  }
}
