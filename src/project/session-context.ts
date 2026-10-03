import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getProject } from './project-store.js';
import { loadSession } from '../session/index.js';

/** Resolve the assigned project's folder for a persisted conversation, never from client-supplied paths. */
export function resolveSessionProjectContext(sessionId: string | undefined): { cwd: string; instructions?: string } | null {
  if (!sessionId) return null;
  const projectId = loadSession(sessionId)?.meta.projectId;
  if (!projectId) return null;
  const folder = getProject(projectId)?.primaryFolder;
  if (!folder) return null;
  try {
    if (!statSync(folder).isDirectory()) return null;
  } catch { return null; }
  const file = join(folder, 'AGENTS.md');
  try {
    const instructions = readFileSync(file, 'utf8');
    return { cwd: folder, ...(instructions.trim() ? { instructions: `Project instructions (${file}):\n${instructions}` } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { cwd: folder };
  }
}
