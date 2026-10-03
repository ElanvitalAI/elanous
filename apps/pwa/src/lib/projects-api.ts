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

  create(name: string): Promise<{ project: Project }> {
    return this.client.fetchJson('/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
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
