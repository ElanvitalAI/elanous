import { mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  createProject,
  getRun,
  listFiles,
  openDesignConfig,
  readFile,
  startRun,
  type OpenDesignClientDeps,
  type OpenDesignConnection,
} from './open-design-client.js';

export const DESIGN_PREVIEW_POLL_MS = 10_000;
export const DESIGN_PREVIEW_TIMEOUT_MS = 15 * 60_000;

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export interface DesignPreviewInput {
  repoRoot: string;
  brief: string;
  systems: string[];
  agentId?: string;
  pollMs?: number;
  timeoutMs?: number;
}

export interface DesignPreviewResult {
  system: string;
  ok: boolean;
  path?: string;
  runId?: string;
  status: string;
  reason?: string;
}

export interface DesignPreviewDeps extends OpenDesignClientDeps {
  connection?: OpenDesignConnection | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  mkdir?: (path: string) => void;
  writeFile?: (path: string, contents: string) => void;
  clock?: () => string;
}

function safeIdPart(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'x';
}

export function designPreviewProjectId(repoRoot: string, system: string, stamp: string): string {
  return `elanous-${safeIdPart(basename(repoRoot))}-${safeIdPart(system)}-${safeIdPart(stamp)}`;
}

function firstHtml(names: readonly string[]): string | undefined {
  return names.find((name) => name.toLowerCase().endsWith('.html'));
}

async function previewOne(
  input: DesignPreviewInput,
  system: string,
  connection: OpenDesignConnection,
  deps: DesignPreviewDeps,
): Promise<DesignPreviewResult> {
  const stamp = (deps.clock ?? (() => new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)))();
  const id = designPreviewProjectId(input.repoRoot, system, stamp);
  const created = await createProject({ id, name: `${basename(input.repoRoot)} ${system}`, designSystemId: system }, connection, deps);
  if (!created.ok) return { system, ok: false, status: 'error', reason: created.reason };

  const started = await startRun({
    projectId: created.project.id,
    message: input.brief,
    agentId: input.agentId ?? 'codex',
  }, connection, deps);
  if (!started.ok) return { system, ok: false, status: 'error', reason: started.reason };

  const pollMs = input.pollMs ?? DESIGN_PREVIEW_POLL_MS;
  const timeoutMs = input.timeoutMs ?? DESIGN_PREVIEW_TIMEOUT_MS;
  const startedAt = (deps.now ?? Date.now)();
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let status = 'queued';
  let runError: string | null = null;
  for (;;) {
    const run = await getRun(started.runId, connection, deps);
    if (!run.ok) return { system, ok: false, runId: started.runId, status: 'error', reason: run.reason };
    status = run.run.status ?? status;
    runError = typeof run.run.error === 'string' && run.run.error.trim() ? run.run.error.trim().slice(0, 200) : null;
    if (TERMINAL.has(status)) break;
    if ((deps.now ?? Date.now)() - startedAt >= timeoutMs) {
      return { system, ok: false, runId: started.runId, status: 'timeout', reason: 'timeout' };
    }
    await sleep(pollMs);
  }
  if (status !== 'succeeded') {
    // OpenDesign says WHY (e.g. the engine could not authenticate) — carry that sentence, not just the status.
    return { system, ok: false, runId: started.runId, status, reason: runError ? `${status}: ${runError}` : status };
  }

  const listed = await listFiles(created.project.id, connection, deps);
  if (!listed.ok) return { system, ok: false, runId: started.runId, status, reason: listed.reason };
  const html = firstHtml(listed.files.map((file) => file.name));
  if (!html) return { system, ok: false, runId: started.runId, status, reason: 'no html file' };
  const file = await readFile(created.project.id, html, connection, deps);
  if (!file.ok) return { system, ok: false, runId: started.runId, status, reason: file.reason };

  const dir = `${input.repoRoot.replace(/\/+$/, '')}/design/previews`;
  const path = `${dir}/${system}.html`;
  try {
    deps.mkdir?.(dir);
    (deps.writeFile ?? (() => { throw new Error('writeFile missing'); }))(path, file.text);
  } catch {
    return { system, ok: false, runId: started.runId, status, reason: 'cannot write preview' };
  }
  return { system, ok: true, path, runId: started.runId, status };
}

/** 시스템마다 프로젝트를 만들고 런을 병렬로 기다린다. 한 시스템의 실패는 다른 저장을 막지 않는다. */
export async function makeDesignPreviews(
  input: DesignPreviewInput,
  deps: DesignPreviewDeps = {},
): Promise<DesignPreviewResult[]> {
  const connection = deps.connection === undefined ? openDesignConfig(deps) : deps.connection;
  if (!connection) {
    return input.systems.map((system) => ({
      system,
      ok: false,
      status: 'unconfigured',
      reason: 'OpenDesign 이 설정되지 않았다 — design.openDesign.url · tokenFile',
    }));
  }
  const bound: DesignPreviewDeps = {
    ...deps,
    mkdir: deps.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true })),
    writeFile: deps.writeFile ?? ((path: string, contents: string) => writeFileSync(path, contents, 'utf8')),
  };
  return Promise.all(input.systems.map((system) => previewOne(input, system, connection, bound)));
}
