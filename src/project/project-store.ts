import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
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
  relations?: Array<{ type: 'dependsOn' | 'derivedFrom' | 'partOf' | 'deploysTo'; target: string }>;
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELATION_TYPES = new Set(['dependsOn', 'derivedFrom', 'partOf', 'deploysTo']);

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
  if (item.relations !== undefined) {
    if (!Array.isArray(item.relations)) throw new Error('invalid project record');
    const seen = new Set<string>();
    for (const rel of item.relations) {
      if (!rel || typeof rel !== 'object' || Array.isArray(rel)) throw new Error('invalid project record');
      const edge = rel as Record<string, unknown>;
      if (!RELATION_TYPES.has(edge.type as string) || !validId(edge.target) || edge.target === item.id) {
        throw new Error('invalid project record');
      }
      const key = `${edge.type}\0${edge.target}`;
      if (seen.has(key)) throw new Error('invalid project record');
      seen.add(key);
    }
  }
  return value as Project;
}

export function relationsOf(project: Project): Array<{ type: 'dependsOn' | 'derivedFrom' | 'partOf' | 'deploysTo'; target: string }> {
  return project.relations ?? [];
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

// TENANT-BOUNDARY (0.2.41 · nfr:security): 고객 프로젝트 원장이 설치 밖으로 나가는
// 출구는 이 익명 내보내기 하나다 — 식별 필드(이름·경로)는 익명 토큰으로 치환되고
// id(이미 불투명한 uuid)·createdAt·relations 만 남는다.
export interface AnonymousProject {
  id: string;
  name: string;
  createdAt: string;
  primaryFolder?: string;
  relations?: Project['relations'];
}

const ANONYMOUS_EXPORT_DOMAIN = 'elanous-tenant-boundary';

function anonymousExportSecret(): Buffer {
  const configDir = getElanousConfigDir();
  const path = join(configDir, 'tenant-boundary-secret');
  try {
    const existing = readFileSync(path);
    if (existing.length === 32) return existing;
  } catch { /* first use */ }
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32);
  try { writeFileSync(path, secret, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readFileSync(path);
    if (existing.length === 32) return existing;
    throw new Error('invalid tenant boundary secret');
  }
  return secret;
}

export function anonymousToken(prefix: 'project' | 'folder', value: string): string {
  return `${prefix}-${createHmac('sha256', anonymousExportSecret()).update(`${ANONYMOUS_EXPORT_DOMAIN}\u0000${prefix}\u0000${value}`).digest('hex').slice(0, 16)}`;
}

export function anonymousExport(project: Project): AnonymousProject {
  const exported: AnonymousProject = {
    id: project.id,
    name: anonymousToken('project', project.name),
    createdAt: project.createdAt,
  };
  if (project.primaryFolder !== undefined) exported.primaryFolder = anonymousToken('folder', project.primaryFolder);
  if (project.relations !== undefined) exported.relations = project.relations;
  return exported;
}
