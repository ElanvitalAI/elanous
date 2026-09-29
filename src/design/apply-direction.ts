import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { listAllDesignDirections, listDesignDirections, parseDeclaredDirection, writeDeclaredDirection, writeDeclaredSystemDirection } from './design-directions.js';
import { libraryDir } from './design-library.js';
import { defaultDesignSystemsDir, listDesignSystems, type DesignSystem } from './design-systems.js';

export interface ApplyDesignDirectionDeps {
  readFile: (path: string, encoding: 'utf8') => string;
  writeFile: (path: string, contents: string, options?: { exclusive?: boolean; onCreated?: () => void }) => void;
  readdir: (path: string) => readonly string[];
  mkdir: (path: string) => void;
  removeFile: (path: string) => void;
  removeDir: (path: string) => void;
  renameFile: (from: string, to: string) => void;
  documentTarget: (path: string) => { path: string; mode?: number };
  setFileMode: (path: string, mode: number) => void;
}

export interface ApplyDesignDirectionOptions {
  systemsDir?: string;
  librarySystemsDir?: string;
  deps?: Partial<ApplyDesignDirectionDeps>;
}

export type ApplyDesignDirectionResult =
  | { ok: true; documentPath: string; direction: string }
  | { ok: false; reason: 'cannot-read' | 'cannot-write' | 'unknown-direction' | 'conflicting-system-file'; documentPath: string; path?: string; availableDirections?: string[] };

const liveDeps: ApplyDesignDirectionDeps = {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, contents, options) => {
    if (!options?.exclusive) {
      writeFileSync(path, contents, 'utf8');
      return;
    }
    const fd = openSync(path, 'wx');
    try {
      options.onCreated?.();
      writeFileSync(fd, contents, 'utf8');
    } finally { closeSync(fd); }
  },
  readdir: (path) => readdirSync(path),
  mkdir: (path) => mkdirSync(path),
  removeFile: (path) => unlinkSync(path),
  removeDir: (path) => rmdirSync(path),
  renameFile: (from, to) => renameSync(from, to),
  documentTarget: (path) => {
    const real = realpathSync(path);
    return { path: real, mode: statSync(real).mode & 0o7777 };
  },
  setFileMode: (path, mode) => chmodSync(path, mode),
};

const filesystemKeys = ['readFile', 'writeFile', 'readdir', 'mkdir', 'removeFile', 'removeDir', 'renameFile'] as const;

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Select a theme or install a bundled web system into the repository owning documentPath.
 * System files are conflict-checked before writing; newly created files/dirs are rolled back
 * if the staged DESIGN.md replacement cannot be committed. */
export function applyDesignDirection(
  documentPath: string,
  directionId: string,
  options: ApplyDesignDirectionOptions = {},
): ApplyDesignDirectionResult {
  const systemsDir = options.systemsDir ?? defaultDesignSystemsDir();
  const librarySystemsDir = options.librarySystemsDir ?? libraryDir();
  const overrides = options.deps ?? {};
  const deps = { ...liveDeps, ...overrides };
  const directions = listAllDesignDirections({ systemsDir, librarySystemsDir });
  const themes = listDesignDirections();
  const themeIds = new Set(themes.map((theme) => theme.id));
  const bundled = listDesignSystems(systemsDir).filter((system) => !themeIds.has(system.id));
  const bundledIds = new Set(bundled.map((system) => system.id));
  const library = listDesignSystems(librarySystemsDir)
    .filter((system) => !themeIds.has(system.id) && !bundledIds.has(system.id));
  const systems: Array<DesignSystem & { originDir: string }> = [
    ...bundled.map((system) => ({ ...system, originDir: systemsDir })),
    ...library.map((system) => ({ ...system, originDir: librarySystemsDir })),
  ];
  let document: string;
  try {
    document = deps.readFile(documentPath, 'utf8');
  } catch {
    return { ok: false, reason: 'cannot-read', documentPath };
  }
  if (!directions.some((direction) => direction.id === directionId)) {
    return { ok: false, reason: 'unknown-direction', documentPath, availableDirections: directions.map((direction) => direction.id) };
  }

  const system = systems.find((candidate) => candidate.id === directionId);
  try {
    if (!system) {
      deps.writeFile(documentPath, writeDeclaredDirection(document, directionId));
    } else {
      // A partial virtual filesystem must not silently mutate the live filesystem.
      if (filesystemKeys.some((key) => overrides[key] !== undefined)
        && filesystemKeys.some((key) => overrides[key] === undefined)) {
        throw new Error('design-system filesystem dependencies must be supplied together');
      }
      const source = join(system.originDir, system.id);
      const destination = join(dirname(documentPath), 'design', 'system');
      const files = [
        { path: join(destination, 'DESIGN.md'), content: deps.readFile(join(source, 'DESIGN.md'), 'utf8') },
        { path: join(destination, 'tokens.css'), content: deps.readFile(join(source, 'tokens.css'), 'utf8') },
      ];
      // Switching systems: a file that is byte-for-byte the CURRENTLY declared
      // system's vendored copy was written by us and never edited, so it may be
      // replaced. Anything else is a human's file and still blocks.
      const declared = parseDeclaredDirection(document, directions).declared;
      const declaredSystem = declared && declared !== system.id ? systems.find((candidate) => candidate.id === declared) : undefined;
      const readDeclared = (name: string): string | null => {
        if (!declaredSystem) return null;
        try { return deps.readFile(join(declaredSystem.originDir, declaredSystem.id, name), 'utf8'); } catch { return null; }
      };
      const absent: typeof files = [];
      const replaced: Array<{ path: string; content: string; previous: string }> = [];
      for (const file of files) {
        let existing: string;
        try {
          existing = deps.readFile(file.path, 'utf8');
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) throw error;
          absent.push(file);
          continue;
        }
        if (existing === file.content) continue;
        if (existing === readDeclared(file.path.slice(destination.length + 1))) {
          replaced.push({ ...file, previous: existing });
          continue;
        }
        return { ok: false, reason: 'conflicting-system-file', documentPath, path: file.path };
      }
      const createdDirs: string[] = [];
      const createdFiles: string[] = [];
      const restored: typeof replaced = [];
      let temporaryDocument: string | undefined;
      let failedPath: string | undefined;
      const ensureDir = (path: string) => {
        try {
          deps.readdir(path);
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) throw error;
          deps.mkdir(path);
          createdDirs.push(path);
        }
      };
      try {
        if (absent.length) {
          ensureDir(dirname(destination));
          ensureDir(destination);
          for (const file of absent) {
            try {
              deps.writeFile(file.path, file.content, { exclusive: true, onCreated: () => { createdFiles.push(file.path); } });
            } catch (error) {
              if (hasCode(error, 'EEXIST')) failedPath = file.path;
              throw error;
            }
          }
        }
        for (const file of replaced) {
          deps.writeFile(file.path, file.content);
          restored.push(file);
        }
        const virtualIo = filesystemKeys.some((key) => overrides[key] !== undefined);
        const target = (overrides.documentTarget ?? (virtualIo ? (path: string): { path: string; mode?: number } => ({ path }) : liveDeps.documentTarget))(documentPath);
        const setMode = overrides.setFileMode ?? (virtualIo ? () => {} : liveDeps.setFileMode);
        const staged = `${target.path}.${randomUUID()}.tmp`;
        deps.writeFile(staged, writeDeclaredSystemDirection(document, directionId, system.sourceCommit), {
          exclusive: true, onCreated: () => { temporaryDocument = staged; },
        });
        if (target.mode !== undefined) setMode(staged, target.mode);
        deps.renameFile(staged, target.path);
        temporaryDocument = undefined;
      } catch (error) {
        if (temporaryDocument) {
          try { deps.removeFile(temporaryDocument); } catch (cleanupError) {
            if (!hasCode(cleanupError, 'ENOENT')) debug.log('repo-design-direction', 'rollback-failed', { path: temporaryDocument, error: String(cleanupError) }, { level: 'error' });
          }
        }
        for (const file of restored.reverse()) {
          try { deps.writeFile(file.path, file.previous); } catch (cleanupError) {
            debug.log('repo-design-direction', 'rollback-failed', { path: file.path, error: String(cleanupError) }, { level: 'error' });
          }
        }
        for (const path of createdFiles.reverse()) {
          try { deps.removeFile(path); } catch (cleanupError) {
            if (!hasCode(cleanupError, 'ENOENT')) debug.log('repo-design-direction', 'rollback-failed', { path, error: String(cleanupError) }, { level: 'error' });
          }
        }
        for (const path of createdDirs.reverse()) {
          try { deps.removeDir(path); } catch (cleanupError) {
            debug.log('repo-design-direction', 'rollback-failed', { path, error: String(cleanupError) }, { level: 'error' });
          }
        }
        if (failedPath) return { ok: false, reason: 'conflicting-system-file', documentPath, path: failedPath };
        throw error;
      }
    }
  } catch (error) {
    debug.log('repo-design-direction', 'write-failed', { documentPath, error: String(error) }, { level: 'error' });
    return { ok: false, reason: 'cannot-write', documentPath };
  }
  return { ok: true, documentPath, direction: directionId };
}
