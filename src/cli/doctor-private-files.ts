import { chmodSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';

export interface PrivateFilesDeps {
  exists?: (path: string) => boolean;
  readdir?: (path: string) => string[];
  lstat?: (path: string) => { mode: number; isDirectory?: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean };
  chmod?: (path: string, mode: number) => void;
}

export interface PrivateFilesScan {
  /** Directory to repair, including when only its own mode is loose. */
  configDir: string;
  /** null means the directory does not exist. */
  dirMode: number | null;
  loose: { path: string; mode: number }[];
}

export interface PrivateFilesFix {
  dir: { path: string; before: number; after: number } | null;
  files: { path: string; before: number; after: number }[];
}

const PRIVATE_NAME = /^(?:(?:config|secrets|auth|llm-fallback)\.json.*|.*\.bak.*)$/;

/** Inspect only immediate regular files, by name and lstat mode; never read their contents or follow links. */
export function scanPrivateFiles(configDir: string, deps: PrivateFilesDeps = {}): PrivateFilesScan {
  const exists = deps.exists ?? existsSync;
  if (!exists(configDir)) return { configDir, dirMode: null, loose: [] };
  const lstat = deps.lstat ?? lstatSync;
  const directory = lstat(configDir);
  if (directory.isSymbolicLink() || directory.isFile() || (directory.isDirectory && !directory.isDirectory())) throw new Error('config directory is not a directory');
  const loose: PrivateFilesScan['loose'] = [];
  for (const name of (deps.readdir ?? readdirSync)(configDir).sort()) {
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || !PRIVATE_NAME.test(name)) continue;
    const path = join(configDir, name);
    const stat = lstat(path);
    if (stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o044)) loose.push({ path, mode: stat.mode & 0o7777 });
  }
  return { configDir, dirMode: directory.mode & 0o7777, loose };
}

/** Reinspect just before chmod so stale scan modes cannot restore old owner bits. */
export function fixPrivateFiles(scan: PrivateFilesScan, deps: PrivateFilesDeps = {}): PrivateFilesFix {
  const lstat = deps.lstat ?? lstatSync;
  const chmod = deps.chmod ?? chmodSync;
  const dirStat = lstat(scan.configDir);
  if (dirStat.isSymbolicLink() || dirStat.isFile() || (dirStat.isDirectory && !dirStat.isDirectory())) throw new Error('config directory is not a directory');
  const dirBefore = dirStat.mode & 0o7777;
  const dir = dirBefore === 0o700 ? null : { path: scan.configDir, before: dirBefore, after: 0o700 };
  if (dir) chmod(dir.path, dir.after);
  const files: PrivateFilesFix['files'] = [];
  for (const entry of scan.loose) {
    const stat = lstat(entry.path);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const before = stat.mode & 0o7777;
    const after = before & ~0o077;
    if (after === before) continue;
    chmod(entry.path, after);
    files.push({ path: entry.path, before, after });
  }
  const result = { dir, files };
  debug.log('doctor.private-files', 'fixed', result);
  return result;
}
