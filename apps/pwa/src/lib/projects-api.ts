import type { DaemonClient } from './daemon-client';

export interface Project {
  id: string;
  name: string;
  primaryFolder?: string;
  createdAt: string;
}

export interface ProjectAutopsyFailure {
  runId: string;
  nodeId: string;
  summary: string;
  kind: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  verdict?: string;
}

export interface ProjectAutopsyCause {
  kind: string;
  count: number;
  runs: string[];
}

export interface ProjectAutopsy {
  project: { id: string; name: string; primaryFolder?: string };
  attribution: { status: 'measured' | 'partial' | 'unavailable'; reason?: 'ledger-project-id-missing' };
  coverage: { failuresTruncated: boolean; proposalsTruncated: boolean; causeCounts: 'returned-failures' };
  failures: ProjectAutopsyFailure[];
  causes: ProjectAutopsyCause[];
  proposals: Array<{ runId: string; message: string; requestedAt: number }>;
  pendingApprovals: number;
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

  fetchProjectAutopsy(projectId: string): Promise<ProjectAutopsy> {
    return this.client.fetchJson(`/v1/projects/${encodeURIComponent(projectId)}/autopsy`);
  }
}
