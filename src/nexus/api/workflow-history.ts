import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalWorkflowDir, getProjectWorkflowDir } from '../../workflow-runtime/discovery.js';

export interface WorkflowHistoryOpts {
  scope?: 'project' | 'global';
  cwd?: string;
}

export interface WorkflowHistoryVersion {
  id: string;
  createdAt: string;
  size: number;
}

const MAX_VERSIONS = 20;
const VERSION_ID = /^(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function safeName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    throw new Error('invalid workflow name');
  }
}

function safeVersionId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid workflow history version id');
}

function workflowDir(opts: WorkflowHistoryOpts): string {
  return opts.scope === 'global'
    ? getGlobalWorkflowDir()
    : getProjectWorkflowDir(opts.cwd ?? process.cwd());
}

function historyDir(name: string, opts: WorkflowHistoryOpts): string {
  safeName(name);
  return join(workflowDir(opts), '.history', name);
}

/** Capture the current YAML before its caller overwrites it; a missing file has no history. */
export function snapshotBeforeSave(name: string, opts: WorkflowHistoryOpts = {}): WorkflowHistoryVersion | null {
  const dir = historyDir(name, opts);
  const source = join(workflowDir(opts), `${name}.yaml`);
  if (!existsSync(source)) return null;
  const content = readFileSync(source);
  const previous = listWorkflowHistory(name, opts)[0];
  if (previous && readFileSync(join(dir, `${previous.id}.yaml`)).equals(content)) return null;

  mkdirSync(dir, { recursive: true });
  const timestamp = Math.max(Date.now(), previous ? Number(previous.id.slice(0, 13)) + 1 : 0);
  const id = `${String(timestamp).padStart(13, '0')}-${randomUUID()}`;
  const version: WorkflowHistoryVersion = {
    id,
    createdAt: new Date(Number(id.slice(0, 13))).toISOString(),
    size: content.byteLength,
  };
  writeFileSync(join(dir, `${id}.yaml`), content, { flag: 'wx' });
  for (const old of listWorkflowHistory(name, opts).slice(MAX_VERSIONS)) {
    unlinkSync(join(dir, `${old.id}.yaml`));
  }
  return version;
}

/** Enumerate only this workflow's snapshots, newest first. */
export function listWorkflowHistory(name: string, opts: WorkflowHistoryOpts = {}): WorkflowHistoryVersion[] {
  const dir = historyDir(name, opts);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(file => file.endsWith('.yaml') && VERSION_ID.test(file.slice(0, -5)))
    .map(file => {
      const id = file.slice(0, -5);
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      return stat.isFile() ? { id, createdAt: new Date(Number(id.slice(0, 13))).toISOString(), size: stat.size } : null;
    })
    .filter((version): version is WorkflowHistoryVersion => version !== null)
    .sort((a, b) => b.id.localeCompare(a.id));
}

/** A missing (well-formed) version returns null rather than an empty YAML draft. */
export function getWorkflowHistoryVersion(name: string, id: string, opts: WorkflowHistoryOpts = {}): string | null {
  const dir = historyDir(name, opts);
  safeVersionId(id);
  const file = join(dir, `${id}.yaml`);
  if (!VERSION_ID.test(id) || !existsSync(file)) return null;
  return readFileSync(file, 'utf-8');
}
