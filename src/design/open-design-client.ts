import { readFileSync } from 'node:fs';

import { debug } from '../debug/log.js';
import { getUserConfig, type UserConfig } from '../user-config.js';

export const OPEN_DESIGN_TIMEOUT_MS = 30_000;

export interface OpenDesignConnection {
  url: string;
  token: string;
}

export interface OpenDesignFailure {
  ok: false;
  status: number;
  reason: string;
}

export interface OpenDesignProject {
  id: string;
  name: string;
  designSystemId: string;
  conversationId?: string;
}

export interface OpenDesignRun {
  runId: string;
  status?: string;
  designSystemId?: string;
  agentId?: string;
  [key: string]: unknown;
}

export interface OpenDesignFileEntry {
  name: string;
  size?: number;
  [key: string]: unknown;
}

export interface OpenDesignClientDeps {
  fetch?: typeof fetch;
  now?: () => number;
  readFile?: (path: string) => string;
  config?: Pick<UserConfig, 'design'>;
  timeoutMs?: number;
}

export type OpenDesignResult<T> = ({ ok: true } & T) | OpenDesignFailure;

const REASON_LIMIT = 200;

/** 주소가 없으면 null — OpenDesign 은 꺼진 것이다. 토큰 값은 반환 객체에만 있고 로그·오류에 싣지 않는다. */
export function openDesignConfig(deps: OpenDesignClientDeps = {}): OpenDesignConnection | null {
  const design = (deps.config ?? getUserConfig()).design?.openDesign;
  const url = design?.url?.trim();
  if (!url) return null;
  const tokenFile = design?.tokenFile?.trim();
  if (!tokenFile) return null;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  let token: string;
  try {
    const line = readFile(tokenFile).split(/\r?\n/).find((row) => row.trim().length > 0);
    token = line?.trim() ?? '';
  } catch {
    return null;
  }
  if (!token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

function clipReason(body: string, token: string): string {
  const flat = body.replaceAll(token, '[redacted]').replace(/\s+/g, ' ').trim();
  return flat.length <= REASON_LIMIT ? flat : flat.slice(0, REASON_LIMIT);
}

async function requestJson(
  connection: OpenDesignConnection,
  method: string,
  path: string,
  body: unknown | undefined,
  deps: OpenDesignClientDeps,
): Promise<OpenDesignResult<{ body: unknown }>> {
  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? OPEN_DESIGN_TIMEOUT_MS;
  const started = (deps.now ?? Date.now)();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  try {
    const response = await fetchImpl(`${connection.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    status = response.status;
    const text = await response.text();
    const ms = (deps.now ?? Date.now)() - started;
    debug.log('design.open-design', method.toLowerCase(), { path, status, ms });
    if (!response.ok) {
      return { ok: false, status, reason: clipReason(text, connection.token) || response.statusText || 'request failed' };
    }
    if (!text.trim()) return { ok: true, body: {} };
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, status, reason: 'response was not json' };
    }
  } catch (error) {
    const ms = (deps.now ?? Date.now)() - started;
    const aborted = error instanceof Error && error.name === 'AbortError';
    status = aborted ? 0 : status;
    debug.log('design.open-design', aborted ? 'timeout' : 'error', { path, status, ms });
    return { ok: false, status, reason: aborted ? 'timeout' : 'request failed' };
  } finally {
    clearTimeout(timer);
  }
}

export async function createProject(
  input: { id: string; name: string; designSystemId: string },
  connection: OpenDesignConnection,
  deps: OpenDesignClientDeps = {},
): Promise<OpenDesignResult<{ project: OpenDesignProject; conversationId?: string }>> {
  const result = await requestJson(connection, 'POST', '/api/projects', {
    id: input.id,
    name: input.name,
    designSystemId: input.designSystemId,
    skipDiscoveryBrief: true,
  }, deps);
  if (!result.ok) return result;
  const root = result.body as { project?: OpenDesignProject; conversationId?: string };
  const project = root.project;
  if (!project || typeof project.id !== 'string') {
    return { ok: false, status: 200, reason: 'project missing' };
  }
  return {
    ok: true,
    project: {
      id: project.id,
      name: project.name,
      designSystemId: project.designSystemId,
      ...(typeof root.conversationId === 'string' ? { conversationId: root.conversationId } : {}),
    },
    ...(typeof root.conversationId === 'string' ? { conversationId: root.conversationId } : {}),
  };
}

export async function startRun(
  input: { projectId: string; message: string; agentId: string },
  connection: OpenDesignConnection,
  deps: OpenDesignClientDeps = {},
): Promise<OpenDesignResult<{ runId: string }>> {
  const result = await requestJson(connection, 'POST', '/api/runs', {
    projectId: input.projectId,
    message: input.message,
    agentId: input.agentId,
  }, deps);
  if (!result.ok) return result;
  const runId = (result.body as { runId?: unknown }).runId;
  if (typeof runId !== 'string' || !runId) return { ok: false, status: 200, reason: 'runId missing' };
  return { ok: true, runId };
}

export async function getRun(
  runId: string,
  connection: OpenDesignConnection,
  deps: OpenDesignClientDeps = {},
): Promise<OpenDesignResult<{ run: OpenDesignRun }>> {
  const result = await requestJson(connection, 'GET', `/api/runs/${encodeURIComponent(runId)}`, undefined, deps);
  if (!result.ok) return result;
  const body = result.body as Record<string, unknown>;
  const status = typeof body.status === 'string' ? body.status : undefined;
  return {
    ok: true,
    run: {
      ...body,
      runId: typeof body.runId === 'string' ? body.runId : runId,
      ...(status ? { status } : {}),
      ...(typeof body.designSystemId === 'string' ? { designSystemId: body.designSystemId } : {}),
      ...(typeof body.agentId === 'string' ? { agentId: body.agentId } : {}),
    },
  };
}

export async function listFiles(
  projectId: string,
  connection: OpenDesignConnection,
  deps: OpenDesignClientDeps = {},
): Promise<OpenDesignResult<{ files: OpenDesignFileEntry[] }>> {
  const result = await requestJson(connection, 'GET', `/api/projects/${encodeURIComponent(projectId)}/files`, undefined, deps);
  if (!result.ok) return result;
  const files = (result.body as { files?: unknown }).files;
  if (!Array.isArray(files)) return { ok: false, status: 200, reason: 'files missing' };
  return {
    ok: true,
    files: files.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const file = entry as OpenDesignFileEntry;
      return typeof file.name === 'string' ? [file] : [];
    }),
  };
}

export async function readFile(
  projectId: string,
  name: string,
  connection: OpenDesignConnection,
  deps: OpenDesignClientDeps = {},
): Promise<OpenDesignResult<{ text: string; contentType?: string }>> {
  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? OPEN_DESIGN_TIMEOUT_MS;
  const path = `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(name)}`;
  const started = (deps.now ?? Date.now)();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  try {
    const response = await fetchImpl(`${connection.url}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${connection.token}`,
        Accept: 'text/html, text/plain, */*',
      },
      signal: controller.signal,
    });
    status = response.status;
    const text = await response.text();
    const ms = (deps.now ?? Date.now)() - started;
    debug.log('design.open-design', 'get', { path, status, ms });
    if (!response.ok) {
      return { ok: false, status, reason: clipReason(text, connection.token) || response.statusText || 'request failed' };
    }
    return { ok: true, text, ...(response.headers.get('content-type') ? { contentType: response.headers.get('content-type') ?? undefined } : {}) };
  } catch (error) {
    const ms = (deps.now ?? Date.now)() - started;
    const aborted = error instanceof Error && error.name === 'AbortError';
    debug.log('design.open-design', aborted ? 'timeout' : 'error', { path, status, ms });
    return { ok: false, status, reason: aborted ? 'timeout' : 'request failed' };
  } finally {
    clearTimeout(timer);
  }
}
