import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import { debug } from '../debug/log.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';

export interface Project {
  id: string;
  name: string;
  primaryFolder?: string;
  createdAt: string;
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validId(id: unknown): id is string {
  return typeof id === 'string' && PROJECT_ID.test(id);
}

function validateProject(value: unknown): Project {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid project record');
  const item = value as Record<string, unknown>;
  if (!validId(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80
    || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
    || (item.primaryFolder !== undefined && (typeof item.primaryFolder !== 'string' || !isAbsolute(item.primaryFolder)))) {
    throw new Error('invalid project record');
  }
  return value as Project;
}

export class ProjectStore {
  readonly dir: string;

  constructor(configRoot = getElanousConfigDir()) {
    this.dir = join(configRoot, 'projects');
  }

  create(input: { name: string; primaryFolder?: string }): Project {
    const item = validateProject({ id: randomUUID(), name: input.name, createdAt: new Date().toISOString(),
      ...(input.primaryFolder !== undefined ? { primaryFolder: input.primaryFolder } : {}) });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, `${item.id}.yaml`);
    const temp = join(this.dir, `.${item.id}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, stringify(item), { flag: 'wx', mode: 0o600 });
      // Link publishes a complete file without replacing an existing project.
      linkSync(temp, target);
    } finally {
      try { unlinkSync(temp); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return item;
  }

  get(id: string): Project | null {
    if (!validId(id)) return null;
    let text: string;
    try { text = readFileSync(join(this.dir, `${id}.yaml`), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const item = validateProject(parse(text) as unknown);
    if (item.id !== id) throw new Error('project id does not match filename');
    return item;
  }

  list(): Project[] {
    let files: string[];
    try { files = readdirSync(this.dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return files.filter(file => PROJECT_ID.test(file.slice(0, -5)) && file.endsWith('.yaml'))
      .flatMap(file => { const item = this.get(file.slice(0, -5)); return item ? [item] : []; })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  suggestForFolder(folder: string): Project | null {
    if (!isAbsolute(folder)) throw new Error('folder must be absolute');
    // Compare real paths: macOS reports cwd as /private/var/… for a folder stored as /var/… (symlinked roots).
    const real = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
    const cwd = real(folder);
    let best: Project | null = null;
    let bestLength = -1;
    for (const item of this.list()) {
      if (!item.primaryFolder) continue;
      const base = real(item.primaryFolder);
      const rel = relative(base, cwd);
      if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) continue;
      if (base.length > bestLength) { best = item; bestLength = base.length; }
    }
    debug.log('project.suggestion', 'checked', { matched: best !== null });
    return best;
  }
}

export function createProject(input: { name: string; primaryFolder?: string }): Project {
  return new ProjectStore().create(input);
}

export function listProjects(): Project[] {
  return new ProjectStore().list();
}

export function getProject(id: string): Project | null {
  return new ProjectStore().get(id);
}

export function suggestProjectForFolder(folder: string): Project | null {
  return new ProjectStore().suggestForFolder(folder);
}
